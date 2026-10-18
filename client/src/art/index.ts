// Módulo de arte (pixel art procedural) do Habblaud — implementação do contrato ArtModule (./api.ts).
//
// Tudo é desenhado em código: a geração acontece em PixelBuf (puro, testável em Node) e só no fim
// vira canvas, uma única vez por combinação de parâmetros (cache). As funções draw* chamadas a cada
// quadro (telas, quadro, janela, relógio, pisos, paredes) só fazem fillRect/drawImage de tiles prontos.
import { partsKey, type AppearanceParts } from '../../../shared/appearance';
import { hash32 } from '../../../shared/hash';
import {
  TILE,
  type Appearance,
  type ArtModule,
  type CharacterFrameRequest,
  type Doorway,
  type FloorKind,
  type FurnitureKind,
  type FurnitureSprites,
  type IconName,
  type Pose,
  type RoomTheme,
  type Sprite,
  type WallStyle,
} from './api';
import { appearanceFromSeed as appearanceFromSeedPure, appearanceKey } from './character/appearance';
import { CHAR_H, CHAR_W, POSE_DURATION, POSE_FRAMES, isSeated } from './character/render';
import { renderThemedCharacter } from './character/theme-costume';
import { shade } from './core/color';
import { PixelBuf } from './core/pixbuf';
import type { BufSprite } from './core/sprite';
import { drawBoard, drawClock, drawScreen, drawWindowView, footballLance } from './dynamic';
import { normalizeFurniture, renderFurniture } from './furniture/index';
import { renderIcon } from './icons';
import { CHUNK_PX, floorChunk } from './surfaces/floor';
import { WALL_CAP_H, WALL_FACE_H, capColor, southWallTile, wallFaceTile } from './surfaces/walls';
import { renderRug } from './surfaces/rug';
import { roomTheme as roomThemePure } from './theme';
import type { DecorTheme } from '../world/api';

export * from './api';
export { hash32 };
export { drawBoard, drawClock, drawScreen, drawWindowView, footballLance };
export { editorConflict, editorOptions, fitToOptions, type EditorOptions } from './character/appearance';

let officeTheme: DecorTheme = 'original';
export function setOfficeTheme(theme: DecorTheme): void {
  officeTheme = theme;
}

const NATURAL_FURNITURE = new Set<FurnitureKind>(['plant_small', 'plant_tall']);
const FUNCTION_COLOR_FURNITURE = new Set<FurnitureKind>([
  'coffee_machine', 'light_switch', 'toilet_stall', 'elevator', 'vending_machine',
]);
const SURFACE_FURNITURE = new Set<FurnitureKind>([
  'desk', 'desk_back', 'meeting_table', 'counter', 'counter_sink', 'coffee_machine',
  'microwave', 'cafe_table', 'coffee_table', 'pingpong_table', 'reception_desk', 'sink',
]);
const STORAGE_FURNITURE = new Set<FurnitureKind>([
  'bookshelf', 'binder_shelf', 'filing_cabinet', 'shelf_wall', 'fridge', 'vending_machine',
]);

function insideDynamicRect(s: BufSprite, x: number, y: number): boolean {
  if (!s.rects) return false;
  for (const r of Object.values(s.rects)) {
    if (r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return true;
  }
  return false;
}

/** Recolore o sprite existente sem mudar âncora, footprint, estados ou regiões interativas. */
function themeFurniture(s: BufSprite, kind: FurnitureKind): void {
  if (officeTheme === 'original' || NATURAL_FURNITURE.has(kind)) return;
  const ramps: Record<Exclude<DecorTheme, 'original'>, readonly [number, number, number][]> = {
    medieval: [[35, 24, 18], [91, 57, 31], [151, 102, 48], [222, 181, 83]],
    horror: [[8, 8, 10], [29, 26, 30], [70, 55, 58], [126, 103, 96]],
    alien: [[7, 22, 35], [20, 60, 82], [53, 132, 151], [92, 244, 218]],
  };
  const ramp = ramps[officeTheme];
  const d = s.buf.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue;
    const lum = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    const p = ramp[Math.min(3, Math.floor(lum * 4))];
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    // Luzes de estado continuam reconhecíveis; o restante recebe material temático mantendo textura.
    const mix = FUNCTION_COLOR_FURNITURE.has(kind) && max - min > 48 ? 0.38 : 0.82;
    d[i] = Math.round(d[i] * (1 - mix) + p[0] * mix);
    d[i + 1] = Math.round(d[i + 1] * (1 - mix) + p[1] * mix);
    d[i + 2] = Math.round(d[i + 2] * (1 - mix) + p[2] * mix);
  }
}

/** Detalhes por função, desenhados dentro do canvas existente e fora das regiões dinâmicas. */
function decorateThemedFurniture(s: BufSprite, kind: FurnitureKind, seed: number, front: boolean): void {
  if (officeTheme === 'original' || NATURAL_FURNITURE.has(kind)) return;
  const b = s.buf;
  const w = b.w;
  const h = b.h;
  const put = (x: number, y: number, color: string) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h || b.alpha(x, y) < 32 || insideDynamicRect(s, x, y)) return;
    b.set(x, y, color);
  };
  const row = (x0: number, x1: number, y: number, color: string, step = 1) => {
    for (let x = x0; x <= x1; x += step) put(x, y, color);
  };
  const yBase = Math.max(1, h - (front ? 2 : 4));
  const salt = hash32(`${kind}:${seed}:${front ? 1 : 0}`);

  if (officeTheme === 'medieval') {
    const gold = '#d6ad4d';
    const iron = '#71664f';
    if (SURFACE_FURNITURE.has(kind)) row(3, w - 4, yBase, '#7e4d28', 2);
    if (STORAGE_FURNITURE.has(kind)) {
      row(2, w - 3, Math.max(2, Math.floor(h * 0.35)), iron, 3);
      put(2, Math.floor(h * 0.6), gold); put(w - 3, Math.floor(h * 0.6), gold);
    }
    // Aros de bronze em telas, jogos e aparelhos: o conteúdo/estado no rect fica intocado.
    for (const r of Object.values(s.rects ?? {})) {
      if (!r) continue;
      row(r.x, r.x + r.w - 1, r.y - 1, gold, 3);
      put(r.x - 1, r.y, iron); put(r.x + r.w, r.y, iron);
    }
    if (!SURFACE_FURNITURE.has(kind) && !STORAGE_FURNITURE.has(kind)) row(3, w - 4, yBase, gold, 7);
  } else if (officeTheme === 'horror') {
    const seam = '#171419';
    const wear = '#62575a';
    // Desgaste assimétrico e rachaduras secas; nenhum sangue decorativo ou símbolo de Halloween.
    const x = 2 + (salt % Math.max(1, w - 5));
    const y = Math.max(2, Math.floor(h * 0.42));
    put(x, y, wear); put(x + 1, y + 1, seam); put(x, y + 2, seam);
    if (SURFACE_FURNITURE.has(kind)) row(3, w - 4, yBase, seam, 4);
    if (STORAGE_FURNITURE.has(kind)) {
      put(Math.floor(w / 2), y, seam);
      put(Math.floor(w / 2) + 1, y + 1, wear);
      put(Math.floor(w / 2), y + 2, seam);
    }
    for (const r of Object.values(s.rects ?? {})) {
      if (!r) continue;
      put(r.x - 1, r.y, '#77716b');
      put(r.x + r.w, r.y + r.h - 1, '#65101b');
    }
  } else {
    const cyan = '#42f5d4';
    const violet = '#bd77ff';
    const panel = '#173f58';
    // Juntas de painel e nós emissivos seguem a massa do móvel, sem alterar sua colisão.
    row(3, w - 4, yBase, panel, 2);
    for (let x = 4 + (salt % 3); x < w - 3; x += 6) put(x, yBase, cyan);
    if (STORAGE_FURNITURE.has(kind)) {
      row(3, w - 4, Math.max(2, Math.floor(h * 0.45)), panel, 2);
      put(w - 4, Math.floor(h * 0.45), violet);
    }
    for (const r of Object.values(s.rects ?? {})) {
      if (!r) continue;
      row(r.x, r.x + r.w - 1, r.y - 1, cyan, 2);
      put(r.x - 1, r.y + r.h - 1, violet);
      put(r.x + r.w, r.y, violet);
    }
  }
}

// ------------------------------------------------------------------ canvas e cache

function toCanvas(buf: PixelBuf): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, buf.w);
  c.height = Math.max(1, buf.h);
  const ctx = c.getContext('2d');
  if (ctx && buf.w > 0 && buf.h > 0) ctx.putImageData(new ImageData(buf.data, buf.w, buf.h), 0, 0);
  return c;
}

function toSprite(s: BufSprite): Sprite {
  return { canvas: toCanvas(s.buf), ax: s.ax, ay: s.ay, rects: s.rects };
}

/** Cache com limite simples (descarta tudo ao estourar — evita crescer sem fim em sessões longas). */
class Cache<T> {
  private map = new Map<string, T>();
  constructor(private readonly limit: number) {}
  get(key: string, make: () => T): T {
    let v = this.map.get(key);
    if (v === undefined) {
      if (this.map.size >= this.limit) this.map.clear();
      v = make();
      this.map.set(key, v);
    }
    return v;
  }
}

const charCache = new Cache<Sprite>(30000);
const furnCache = new Cache<FurnitureSprites>(4000);
const tileCache = new Cache<HTMLCanvasElement>(2000);
const floorCache = new Cache<HTMLCanvasElement>(1500);
const iconCache = new Cache<Sprite>(64);
const avatarCache = new Cache<HTMLCanvasElement>(2000);
const rugCache = new Cache<HTMLCanvasElement>(512);

const appearanceKeys = new WeakMap<Appearance, string>();
function keyOf(a: Appearance): string {
  let k = appearanceKeys.get(a);
  if (!k) {
    k = appearanceKey(a);
    appearanceKeys.set(a, k);
  }
  return k;
}

// ------------------------------------------------------------------ personagens

export function appearanceFromSeed(seed: number, opts: { look?: 'f' | 'm'; sub?: boolean; parts?: AppearanceParts } = {}): Appearance {
  return appearanceFromSeedPure(seed, opts);
}

export function poseFrameCount(pose: Pose): number {
  return POSE_FRAMES[pose] ?? 1;
}

export function poseFrameDuration(pose: Pose): number {
  return POSE_DURATION[pose] ?? 500;
}

export function characterSprite(req: CharacterFrameRequest): Sprite {
  const n = poseFrameCount(req.pose);
  const frame = ((Math.floor(req.frame) % n) + n) % n;
  const seated = isSeated(req.pose, req.seated);
  const key = `${officeTheme}|${keyOf(req.appearance)}|${req.dir}|${req.pose}|${frame}|${req.held ?? 'none'}|${seated ? 1 : 0}|${req.costume ?? 'none'}`;
  return charCache.get(key, () =>
    toSprite(renderThemedCharacter({ ...req, frame, seated }, officeTheme, hash32(keyOf(req.appearance)))),
  );
}

export function avatarCanvas(seed: number, opts: { look?: 'f' | 'm'; sub?: boolean; scale?: number; parts?: AppearanceParts } = {}): HTMLCanvasElement {
  const scale = Math.max(1, Math.round(opts.scale ?? 3));
  const key = `${officeTheme}|${seed}|${opts.look ?? '-'}|${opts.sub ? 1 : 0}|${scale}|${partsKey(opts.parts)}`;
  return avatarCache.get(key, () => {
    const s = renderThemedCharacter({ appearance: appearanceFromSeedPure(seed, opts), dir: 'down', pose: 'stand', frame: 0 }, officeTheme, seed);
    // Busto: cabeça + ombros (20x20 a partir do topo do cabelo).
    const crop = s.buf.crop(2, 2, CHAR_W - 4, 20);
    const out = new PixelBuf(crop.w * scale, crop.h * scale);
    for (let y = 0; y < out.h; y++) {
      for (let x = 0; x < out.w; x++) {
        const si = (Math.floor(y / scale) * crop.w + Math.floor(x / scale)) * 4;
        const di = (y * out.w + x) * 4;
        out.data[di] = crop.data[si];
        out.data[di + 1] = crop.data[si + 1];
        out.data[di + 2] = crop.data[si + 2];
        out.data[di + 3] = crop.data[si + 3];
      }
    }
    return toCanvas(out);
  });
}


// ------------------------------------------------------------------ móveis e ícones

export function furnitureSprites(kind: FurnitureKind, variant?: string, state?: number, opts: { seed?: number } = {}): FurnitureSprites {
  if (officeTheme === 'medieval') {
    if (kind === 'desk' || kind === 'desk_back') variant = 'wood';
    if (kind === 'office_chair' || kind === 'office_chair_front') variant = 'red';
  } else if (officeTheme === 'horror') {
    if (kind === 'desk' || kind === 'desk_back') variant = 'dark';
    if (kind === 'office_chair' || kind === 'office_chair_front') variant = 'black';
  } else if (officeTheme === 'alien') {
    if (kind === 'desk' || kind === 'desk_back') variant = 'white';
    if (kind === 'office_chair' || kind === 'office_chair_front') variant = 'blue';
  }
  // Chave normalizada: sementes/variantes equivalentes compartilham o mesmo canvas.
  const n = normalizeFurniture(kind, variant, state, opts.seed);
  const key = `${officeTheme}|${kind}|${n.variant ?? '-'}|${n.state}|${n.vseed}`;
  return furnCache.get(key, () => {
    const f = renderFurniture(kind, n.variant, n.state, n.vseed);
    themeFurniture(f.base, kind);
    if (f.front) themeFurniture(f.front, kind);
    decorateThemedFurniture(f.base, kind, n.vseed, false);
    if (f.front) decorateThemedFurniture(f.front, kind, n.vseed, true);
    return { base: toSprite(f.base), front: f.front ? toSprite(f.front) : undefined };
  });
}

export function iconSprite(name: IconName): Sprite {
  return iconCache.get(name, () => toSprite(renderIcon(name)));
}

export function roomTheme(seed: number): RoomTheme {
  return roomThemePure(seed, officeTheme);
}

// ------------------------------------------------------------------ pisos, tapetes e paredes

function tileHash(seed: number, tx: number, ty: number): number {
  let h = Math.imul(tx | 0, 0x9e3779b1) ^ Math.imul(ty | 0, 0x85ebca77) ^ Math.imul(seed | 0, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

export function drawFloor(
  ctx: CanvasRenderingContext2D,
  kind: FloorKind,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { seed: number; tint?: string; tint2?: string },
): void {
  // Blocos de 8x8 tiles alinhados à grade do mundo, recortados à área pedida.
  const cx0 = Math.floor(x / CHUNK_PX);
  const cy0 = Math.floor(y / CHUNK_PX);
  const cx1 = Math.ceil((x + w) / CHUNK_PX);
  const cy1 = Math.ceil((y + h) / CHUNK_PX);
  for (let cy = cy0; cy < cy1; cy++) {
    for (let cx = cx0; cx < cx1; cx++) {
      const key = `f|${kind}|${opts.seed}|${opts.tint ?? ''}|${opts.tint2 ?? ''}|${cx}|${cy}`;
      const chunk = floorCache.get(key, () => toCanvas(floorChunk(kind, cx, cy, opts)));
      const px = cx * CHUNK_PX;
      const py = cy * CHUNK_PX;
      const sx = Math.max(0, x - px);
      const sy = Math.max(0, y - py);
      const ex = Math.min(CHUNK_PX, x + w - px);
      const ey = Math.min(CHUNK_PX, y + h - py);
      if (ex <= sx || ey <= sy) continue;
      ctx.drawImage(chunk, sx, sy, ex - sx, ey - sy, px + sx, py + sy, ex - sx, ey - sy);
    }
  }
}

export function drawRug(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, seed: number): void {
  const rw = Math.max(4, Math.round(w));
  const rh = Math.max(4, Math.round(h));
  const key = `${rw}|${rh}|${color}|${seed}`;
  const c = rugCache.get(key, () => toCanvas(renderRug(rw, rh, color, seed)));
  ctx.drawImage(c, Math.round(x), Math.round(y));
}

function styleKey(s: WallStyle): string {
  return `${s.base}|${s.trim ?? ''}|${s.pattern ?? 'plain'}|${s.exterior ? 1 : 0}`;
}

/** Trechos [x0, x1) da parede que não estão em passagens. */
function solidSegments(x: number, w: number, doorways: readonly Doorway[] | undefined): [number, number][] {
  let segs: [number, number][] = [[x, x + w]];
  for (const d of doorways ?? []) {
    const next: [number, number][] = [];
    for (const [a, b] of segs) {
      const da = d.x;
      const db = d.x + d.w;
      if (db <= a || da >= b) {
        next.push([a, b]);
        continue;
      }
      if (da > a) next.push([a, da]);
      if (db < b) next.push([db, b]);
    }
    segs = next;
  }
  return segs;
}

function drawTiled(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  h: number,
  tileFor: (tx: number) => HTMLCanvasElement,
): void {
  for (let tx = Math.floor(x0 / TILE); tx * TILE < x1; tx++) {
    const px = tx * TILE;
    const sx = Math.max(0, x0 - px);
    const ex = Math.min(TILE, x1 - px);
    if (ex <= sx) continue;
    ctx.drawImage(tileFor(tx), sx, 0, ex - sx, h, px + sx, y, ex - sx, h);
  }
}

export function drawWallFace(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts: { doorways?: Doorway[] } = {}): void {
  const sk = styleKey(style);
  const tileFor = (tx: number) => {
    const variant = tileHash(7, tx, 0) % 4;
    const col = tx & 1;
    return tileCache.get(`w|${sk}|${variant}|${col}`, () => toCanvas(wallFaceTile(style, variant, col)));
  };
  const segs = solidSegments(x, w, opts.doorways);
  const jamb = shade(style.base, -0.14);
  const jambLight = shade(style.base, 0.04);
  const cap = capColor(style);
  for (const [a, b] of segs) {
    drawTiled(ctx, a, b, y, WALL_FACE_H, tileFor);
    // Batentes sombreados nas bordas que encostam numa passagem.
    if (b < x + w) {
      ctx.fillStyle = jamb;
      ctx.fillRect(b - 2, y + WALL_CAP_H, 2, WALL_FACE_H - WALL_CAP_H);
      ctx.fillStyle = shade(cap, -0.08);
      ctx.fillRect(b - 1, y, 1, WALL_CAP_H);
    }
    if (a > x) {
      ctx.fillStyle = jambLight;
      ctx.fillRect(a, y + WALL_CAP_H, 1, WALL_FACE_H - WALL_CAP_H);
      ctx.fillStyle = jamb;
      ctx.fillRect(a + 1, y + WALL_CAP_H, 1, WALL_FACE_H - WALL_CAP_H);
      ctx.fillStyle = shade(cap, 0.06);
      ctx.fillRect(a, y, 1, WALL_CAP_H);
    }
  }
}

export function drawWallTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, style: WallStyle): void {
  const cap = capColor(style);
  ctx.fillStyle = cap;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = shade(cap, 0.08);
  ctx.fillRect(x, y, w, 1);
  if (w > 2) ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = shade(cap, -0.06);
  if (h > 2) ctx.fillRect(x, y + h - 1, w, 1);
  if (w > 2) ctx.fillRect(x + w - 1, y, 1, h);
}

export function drawSouthWall(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts: { doorways?: Doorway[] } = {}): void {
  const sk = styleKey(style);
  const tileFor = (tx: number) => {
    const col = tx & 3;
    return tileCache.get(`s|${sk}|${col}`, () => toCanvas(southWallTile(style, col)));
  };
  const cap = capColor(style);
  for (const [a, b] of solidSegments(x, w, opts.doorways)) {
    drawTiled(ctx, a, b, y, TILE, tileFor);
    if (b < x + w) {
      ctx.fillStyle = shade(cap, -0.08);
      ctx.fillRect(b - 1, y, 1, TILE);
    }
    if (a > x) {
      ctx.fillStyle = shade(cap, 0.08);
      ctx.fillRect(a, y, 1, TILE);
    }
  }
}

// ------------------------------------------------------------------ telas e afins (por quadro)
// drawScreen, drawBoard, drawWindowView e drawClock vêm de ./dynamic (reexportados acima).

/** Para depuração/prévia: tamanho e âncora padrão dos personagens. */
export const CHARACTER_SHEET = { w: CHAR_W, h: CHAR_H } as const;

// Garantia em tempo de compilação de que este módulo cumpre o contrato ArtModule.
const _contract: ArtModule = {
  appearanceFromSeed,
  characterSprite,
  poseFrameCount,
  poseFrameDuration,
  furnitureSprites,
  drawFloor,
  drawRug,
  drawWallFace,
  drawWallTop,
  drawSouthWall,
  drawScreen,
  drawBoard,
  drawWindowView,
  drawClock,
  roomTheme,
  iconSprite,
  avatarCanvas,
};
void _contract;

