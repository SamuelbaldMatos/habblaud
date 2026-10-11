import type { OfficeTheme } from '../api';
import type { ThemeEffect } from '../themes';

export interface ThemeFrameSprite { canvas: HTMLCanvasElement; ax: number; ay: number }

const FRAME_COUNT: Readonly<Record<ThemeEffect, number>> = {
  magic: 6,
  dragon: 8,
  shadow: 6,
  bat: 6,
  hologram: 6,
  drone: 8,
};

const cache = new Map<string, ThemeFrameSprite>();

export function themeEffectFrameCount(effect: ThemeEffect): number {
  return FRAME_COUNT[effect];
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

function pixel(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function drawMagic(ctx: CanvasRenderingContext2D, f: number): void {
  const gold = '#e5bd57';
  const lime = '#9bc46b';
  const violet = '#c994e8';
  const phase = f % 6;
  const orbit = [
    [20, 5], [30, 10], [33, 20], [24, 27], [12, 24], [8, 13],
  ] as const;

  // Círculo rúnico baixo: marca a conjuração sem esconder o livro nas mãos.
  ctx.strokeStyle = 'rgba(229,189,87,0.62)';
  ctx.beginPath();
  ctx.ellipse(20, 29, 13, 3, 0, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < orbit.length; i++) {
    const [x, y] = orbit[(i + phase) % orbit.length];
    const color = i % 3 === 0 ? violet : i % 2 === 0 ? lime : gold;
    pixel(ctx, x, y, color, i === 0 ? 2 : 1, i === 0 ? 2 : 1);
  }
  for (const [x, y] of [[8, 28], [14, 31], [26, 31], [32, 28]] as const) pixel(ctx, x, y, gold);
  // Páginas luminosas vistas de cima junto aos pés.
  pixel(ctx, 15, 25, '#4a2f1b', 10, 5);
  pixel(ctx, 16, 24, '#ead59c', 4, 4);
  pixel(ctx, 20, 24, '#f4e5b6', 4, 4);
  pixel(ctx, 19, 24, '#9d682b', 1, 4);
}

function drawDragon(ctx: CanvasRenderingContext2D, f: number): void {
  const flap = [0, -3, -6, -3, 0, 2, 0, -2][f % 8];
  const bob = f === 2 || f === 6 ? -1 : 0;
  // Cauda articulada.
  ctx.fillStyle = '#27472d';
  ctx.fillRect(8 - (f % 3), 20 + bob, 9, 2);
  ctx.fillRect(5 - (f % 3), 21 + bob, 5, 1);
  pixel(ctx, 4 - (f % 3), 20 + bob, '#8fc96d');
  // Corpo, pescoço e focinho.
  pixel(ctx, 14, 14 + bob, '#17261c', 11, 7);
  pixel(ctx, 15, 13 + bob, '#4c7a43', 9, 6);
  pixel(ctx, 23, 11 + bob, '#4c7a43', 4, 6);
  pixel(ctx, 26, 12 + bob, '#6aa45c', 4, 4);
  pixel(ctx, 29, 14 + bob, '#d8b95f');
  pixel(ctx, 26, 10 + bob, '#8fc96d');
  // Asas mudam silhueta em todos os oito quadros.
  ctx.fillStyle = '#365e3a';
  ctx.beginPath();
  ctx.moveTo(17, 16 + bob);
  ctx.lineTo(8, 10 + flap + bob);
  ctx.lineTo(12, 20 + bob);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(21, 15 + bob);
  ctx.lineTo(30, 8 + flap + bob);
  ctx.lineTo(25, 20 + bob);
  ctx.fill();
  ctx.strokeStyle = '#8fc96d';
  ctx.beginPath(); ctx.moveTo(17, 16 + bob); ctx.lineTo(8, 10 + flap + bob); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(21, 15 + bob); ctx.lineTo(30, 8 + flap + bob); ctx.stroke();
}

function drawShadow(ctx: CanvasRenderingContext2D, f: number): void {
  const sway = [-2, -1, 0, 1, 2, 0][f % 6];
  // Sombra impossível: alonga-se pelo piso em vez de virar monstro cartunesco.
  ctx.fillStyle = 'rgba(6,5,8,0.34)';
  ctx.beginPath();
  ctx.moveTo(10, 30);
  ctx.lineTo(17 + sway, 12);
  ctx.lineTo(22 + sway, 11);
  ctx.lineTo(30, 30);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(20,14,22,0.52)';
  ctx.fillRect(9, 29, 22, 2);
  ctx.fillStyle = '#65101b';
  pixel(ctx, 18 + sway, 16, '#65101b');
  pixel(ctx, 22 + sway, 16, '#65101b');
  // Fios de sombra respiram lateralmente, nunca em flash de tela inteira.
  ctx.strokeStyle = 'rgba(35,25,38,0.58)';
  ctx.beginPath(); ctx.moveTo(12, 29); ctx.lineTo(5 + sway, 25); ctx.lineTo(8, 21); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(28, 29); ctx.lineTo(35 - sway, 24); ctx.lineTo(32, 20); ctx.stroke();
}

function drawBat(ctx: CanvasRenderingContext2D, f: number): void {
  const wingY = [5, 8, 11, 8, 5, 3][f % 6];
  // Familiar de silhueta seca, mais próximo de uma presença do que de um mascote.
  pixel(ctx, 18, 13, '#08070a', 5, 7);
  pixel(ctx, 19, 11, '#17131a', 3, 4);
  ctx.fillStyle = '#0b090d';
  ctx.beginPath();
  ctx.moveTo(19, 14); ctx.lineTo(5, wingY); ctx.lineTo(9, 17); ctx.lineTo(14, 15); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(22, 14); ctx.lineTo(35, wingY); ctx.lineTo(31, 17); ctx.lineTo(26, 15); ctx.fill();
  pixel(ctx, 19, 13, '#70101c');
  pixel(ctx, 22, 13, '#70101c');
  pixel(ctx, 19, 20, '#17131a');
  pixel(ctx, 22, 20, '#17131a');
}

function drawHologram(ctx: CanvasRenderingContext2D, f: number): void {
  const lift = f % 2;
  const scan = 8 + (f % 6) * 3;
  // Emissor preso ao equipamento e projeção translúcida, sem trocar a função da tela.
  pixel(ctx, 14, 29, '#173f58', 13, 3);
  pixel(ctx, 16, 28, '#42f5d4', 9, 1);
  ctx.fillStyle = 'rgba(66,245,212,0.12)';
  ctx.fillRect(9, 6 - lift, 23, 21);
  ctx.strokeStyle = 'rgba(66,245,212,0.92)';
  ctx.strokeRect(9, 6 - lift, 23, 21);
  ctx.fillStyle = 'rgba(189,119,255,0.78)';
  ctx.fillRect(10, scan - lift, 21, 1);
  pixel(ctx, 13 + (f % 5), 11 - lift, '#66b8ff', 4, 2);
  pixel(ctx, 20, 15 - lift, '#42f5d4', 7, 1);
  pixel(ctx, 14, 19 - lift, '#42f5d4', 12, 1);
  pixel(ctx, 18, 23 - lift, '#bd77ff', 8, 1);
}

function drawDrone(ctx: CanvasRenderingContext2D, f: number): void {
  const bob = f % 4 < 2 ? 0 : 1;
  const pulse = f % 2 === 0 ? '#42f5d4' : '#bd77ff';
  ctx.fillStyle = 'rgba(66,245,212,0.20)';
  ctx.beginPath();
  ctx.ellipse(20, 29 + bob, 11, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  pixel(ctx, 9, 14 + bob, '#263b50', 22, 7);
  pixel(ctx, 12, 11 + bob, '#8799aa', 16, 5);
  pixel(ctx, 15, 9 + bob, '#b9c7cf', 10, 3);
  pixel(ctx, 12, 16 + bob, '#121d2b', 16, 5);
  pixel(ctx, 14, 16 + bob, pulse, 3, 2);
  pixel(ctx, 23, 16 + bob, pulse, 3, 2);
  pixel(ctx, 19, 11 + bob, '#bd77ff', 3, 2);
  // Micropropulsores alternados dão leitura clara dos oito quadros.
  const jet = f % 2 === 0 ? 3 : 5;
  pixel(ctx, 12, 22 + bob, 'rgba(66,245,212,0.72)', 2, jet);
  pixel(ctx, 26, 22 + bob, 'rgba(66,245,212,0.72)', 2, 6 - jet + 2);
}

/** Cada chamada retorna um quadro estático pronto; o renderer apenas alterna os quadros. */
export function themeEffectSprite(theme: OfficeTheme, effect: ThemeEffect, frame: number): ThemeFrameSprite {
  const f = ((Math.floor(frame) % FRAME_COUNT[effect]) + FRAME_COUNT[effect]) % FRAME_COUNT[effect];
  const key = `${theme}:${effect}:${f}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [c, ctx] = canvas(40, 36);

  if (effect === 'magic') drawMagic(ctx, f);
  else if (effect === 'dragon') drawDragon(ctx, f);
  else if (effect === 'shadow') drawShadow(ctx, f);
  else if (effect === 'bat') drawBat(ctx, f);
  else if (effect === 'hologram') drawHologram(ctx, f);
  else drawDrone(ctx, f);

  const out = { canvas: c, ax: 20, ay: 31 };
  cache.set(key, out);
  return out;
}
