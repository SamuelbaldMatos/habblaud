import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const THEMES = ["original", "medieval", "horror", "alien"] as const;
type Theme = (typeof THEMES)[number];

const DEMO_ROOM = "Laboratório dos Temas";
const THEME_SETTLE_MS = 1_500;
const FRAME_GAP_MS = 800;
const HORROR_LUMA_RANGE_MAX = 4;
const baseUrl = new URL(process.env.HABBLAUD_URL ?? "http://127.0.0.1:4747");
const themeUrl = new URL("/api/theme", baseUrl).toString();
const outputDir = join(process.env.TEMP ?? ".", "habblaud-theme-check");
await mkdir(outputDir, { recursive: true });

interface CanvasSample {
  digest: string;
  luma: number;
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

async function readTheme(context: BrowserContext): Promise<Theme> {
  const response = await context.request.get(themeUrl, { failOnStatusCode: false });
  if (!response.ok()) {
    throw new Error(`Não foi possível ler o tema atual: HTTP ${response.status()}.`);
  }
  const body = (await response.json()) as { theme?: unknown };
  if (!isTheme(body.theme)) {
    throw new Error(`O servidor devolveu um tema inválido: ${JSON.stringify(body.theme)}.`);
  }
  return body.theme;
}

async function setTheme(context: BrowserContext, theme: Theme): Promise<void> {
  const response = await context.request.post(themeUrl, {
    data: { theme },
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(`Não foi possível aplicar o tema ${theme}: HTTP ${response.status()}.`);
  }
}

async function waitForTheme(page: Page, theme: Theme): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const app = (window as unknown as {
        habblaud?: { world?: { getOptions(): { officeTheme?: string } } };
      }).habblaud;
      return (
        app?.world?.getOptions().officeTheme === expected &&
        document.querySelector<HTMLElement>("#ui")?.dataset.officeTheme === expected
      );
    },
    theme,
    { timeout: 10_000 },
  );
  // Dá ao renderer recriado ao trocar de tema um frame completo antes da amostragem.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function stabilizeDemoRoom(page: Page): Promise<void> {
  await page.evaluate((room) => {
    const debug = (window as unknown as {
      habblaud: {
        world: {
          debug: {
            setHour(hour: number | null): void;
            fastForward(): void;
            lookAtRoom(name: string, zoom: number): void;
          };
        };
      };
    }).habblaud.world.debug;
    debug.setHour(12);
    debug.fastForward();
    debug.lookAtRoom(room, 3);
  }, DEMO_ROOM);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForFunction(
    (room) => {
      const state = (window as unknown as {
        habblaud: {
          world: {
            debug: {
              state(): {
                camera: { zoom: number };
                rooms: Array<{ name: string; occupants: number; phase: string; light: number }>;
              };
            };
          };
        };
      }).habblaud.world.debug.state();
      const demoRoom = state.rooms.find((candidate) => candidate.name === room);
      return (
        demoRoom?.occupants === 4 &&
        demoRoom.phase === "ready" &&
        demoRoom.light >= 0.99 &&
        state.camera.zoom >= 3
      );
    },
    DEMO_ROOM,
    { timeout: 5_000 },
  );
  // Exclui da janela medida qualquer interpolação de luz ou reconstrução disparada pela troca.
  await page.waitForTimeout(THEME_SETTLE_MS);
}

async function sampleCanvas(page: Page): Promise<CanvasSample> {
  return page.locator("canvas").first().evaluate(async (node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D indisponível.");
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let luma = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      luma += bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722;
    }
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return {
      digest: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16),
      luma: luma / (bytes.length / 4),
    };
  });
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let originalTheme: Theme | undefined;
let runError: unknown;

try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  originalTheme = await readTheme(context);

  const page = await context.newPage();
  const foreignRequests = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== baseUrl.origin) {
      foreignRequests.add(url.toString());
    }
  });

  await page.goto(new URL("/?wallpaper=1&hora=12", baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 });

  await page.evaluate((room) => {
    const app = (window as unknown as {
      habblaud: {
        world: {
          debug: {
            reset(): void;
            setHour(hour: number | null): void;
            spawnSession(options: {
              project: string;
              name: string;
              status: "working";
            }): string;
            fastForward(): void;
            lookAtRoom(name: string, zoom: number): void;
          };
        };
      };
    }).habblaud;
    app.world.debug.reset();
    app.world.debug.setHour(12);
    for (const name of ["Merlin", "Morgana", "Arthur", "Guinevere"]) {
      app.world.debug.spawnSession({ project: room, name, status: "working" });
    }
    app.world.debug.fastForward();
    app.world.debug.lookAtRoom(room, 3);
  }, DEMO_ROOM);

  await page.waitForFunction(
    (room) => {
      const state = (window as unknown as {
        habblaud: {
          world: {
            debug: {
              state(): {
                rooms: Array<{ name: string; occupants: number }>;
              };
            };
          };
        };
      }).habblaud.world.debug.state();
      const demoRoom = state.rooms.find((candidate) => candidate.name === room);
      return demoRoom?.occupants === 4;
    },
    DEMO_ROOM,
    { timeout: 10_000 },
  );

  for (const theme of THEMES) {
    await setTheme(context, theme);
    await waitForTheme(page, theme);
    await stabilizeDemoRoom(page);

    const first = await sampleCanvas(page);
    const firstPath = join(outputDir, `${theme}-1.png`);
    await page.screenshot({ path: firstPath });
    const lumas = [first.luma];
    let second = first;
    const sampleCount = theme === "horror" ? 8 : 1;
    for (let sample = 0; sample < sampleCount; sample++) {
      await page.waitForTimeout(FRAME_GAP_MS / sampleCount);
      second = await sampleCanvas(page);
      lumas.push(second.luma);
    }
    const secondPath = join(outputDir, `${theme}-2.png`);
    await page.screenshot({ path: secondPath });

    if (first.digest === second.digest) {
      throw new Error(`Tema ${theme} não mudou de quadro durante a verificação visual.`);
    }
    const lumaRange = Math.max(...lumas) - Math.min(...lumas);
    if (theme === "horror" && lumaRange > HORROR_LUMA_RANGE_MAX) {
      throw new Error(
        `Tema horror alterou o brilho global em ${lumaRange.toFixed(2)} (possível flash).`,
      );
    }
    console.log(
      `${theme}: ${first.digest} -> ${second.digest}; faixa de brilho ${lumaRange.toFixed(2)}; ${firstPath}; ${secondPath}`,
    );
  }

  if (foreignRequests.size > 0) {
    throw new Error(
      `Assets visuais fizeram requisições remotas:\n${[...foreignRequests].sort().join("\n")}`,
    );
  }
  console.log(`assets: nenhuma requisição fora de ${baseUrl.origin}`);
} catch (error) {
  runError = error;
} finally {
  let cleanupError: unknown;
  try {
    if (context && originalTheme) await setTheme(context, originalTheme);
  } catch (error) {
    cleanupError = error;
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], "Falhas ao restaurar o tema e fechar o navegador.")
        : error;
    }
  }

  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], "A checagem visual e a limpeza falharam.");
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
}
