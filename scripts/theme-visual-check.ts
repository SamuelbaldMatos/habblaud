import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.HABBLAUD_URL ?? "http://127.0.0.1:4747";
const outputDir = join(process.env.TEMP ?? ".", "habblaud-theme-check");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${baseUrl}/?wallpaper=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 });

for (const theme of ["original", "medieval", "horror", "alien"] as const) {
  await page.request.post(`${baseUrl}/api/theme`, { data: { theme } });
  await page.waitForTimeout(2600);
  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ state: "visible" });
  const pixels = await canvas.evaluate((node) => {
    const c = node as HTMLCanvasElement;
    return Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data);
  });
  const digest = createHash("sha256").update(Uint8Array.from(pixels)).digest("hex").slice(0, 16);
  const path = join(outputDir, `${theme}.png`);
  await page.screenshot({ path });
  console.log(`${theme}: ${digest} ${path}`);
}

await page.request.post(`${baseUrl}/api/theme`, { data: { theme: "original" } });
await browser.close();
