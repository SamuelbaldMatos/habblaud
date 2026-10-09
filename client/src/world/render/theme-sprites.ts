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
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Cada chamada retorna um quadro estatico pronto; o renderer apenas alterna os quadros. */
export function themeEffectSprite(theme: OfficeTheme, effect: ThemeEffect, frame: number): ThemeFrameSprite {
  const f = ((Math.floor(frame) % FRAME_COUNT[effect]) + FRAME_COUNT[effect]) % FRAME_COUNT[effect];
  const key = `${theme}:${effect}:${f}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [c, ctx] = canvas(32, 28);

  if (effect === 'magic') {
    const colors = ['#e5bd57', '#9bc46b', '#c994e8'];
    ctx.fillStyle = '#4a2f1b'; ctx.fillRect(10, 17, 12, 6);
    ctx.fillStyle = '#e9d39a'; ctx.fillRect(11, 16, 5, 5); ctx.fillRect(16, 16, 5, 5);
    ctx.fillStyle = colors[f % colors.length];
    for (let i = 0; i < 4; i++) {
      const p = (i * 2 + f) % 8;
      ctx.fillRect(16 + [-8, -5, 0, 6, 8, 6, 0, -5][p], 12 + [-1, -6, -8, -6, -1, 3, 5, 3][p], 2, 2);
    }
  } else if (effect === 'dragon') {
    const wing = f < 2 || (f >= 4 && f < 6) ? 3 : 7;
    ctx.fillStyle = '#17261c'; ctx.fillRect(12, 11, 9, 5); ctx.fillRect(20, 9, 5, 4);
    ctx.fillStyle = '#4c7a43'; ctx.fillRect(13, 10, 7, 5); ctx.fillRect(20, 8, 4, 4);
    ctx.fillStyle = '#8fc96d';
    ctx.beginPath(); ctx.moveTo(14, 11); ctx.lineTo(7, 11 - wing); ctx.lineTo(11, 14); ctx.fill();
    ctx.beginPath(); ctx.moveTo(18, 11); ctx.lineTo(25, 11 - wing); ctx.lineTo(21, 14); ctx.fill();
    ctx.fillRect(23, 9, 2, 1); ctx.fillRect(10 - (f % 3), 14, 5, 2);
  } else if (effect === 'shadow') {
    ctx.fillStyle = `rgba(10,7,12,${0.35 + (f % 3) * 0.16})`;
    ctx.fillRect(8 + (f % 2), 9, 16, 15); ctx.fillRect(11, 5, 10, 8);
    ctx.fillStyle = '#70101c'; ctx.fillRect(13, 10, 2, 1); ctx.fillRect(18, 10, 2, 1);
  } else if (effect === 'bat') {
    const wing = f % 3;
    ctx.fillStyle = '#09080b'; ctx.fillRect(14, 11, 5, 5);
    ctx.beginPath(); ctx.moveTo(15, 12); ctx.lineTo(5, 7 + wing * 3); ctx.lineTo(12, 17); ctx.fill();
    ctx.beginPath(); ctx.moveTo(18, 12); ctx.lineTo(28, 7 + wing * 3); ctx.lineTo(21, 17); ctx.fill();
    ctx.fillStyle = '#831423'; ctx.fillRect(15, 11, 1, 1); ctx.fillRect(18, 11, 1, 1);
  } else if (effect === 'hologram') {
    ctx.strokeStyle = '#42f5d4'; ctx.lineWidth = 1;
    ctx.strokeRect(7, 7 + (f % 2), 18, 13);
    ctx.fillStyle = 'rgba(66,245,212,0.22)'; ctx.fillRect(8, 8 + (f % 2), 16, 11);
    ctx.fillStyle = '#bd77ff'; ctx.fillRect(9, 10 + (f % 6), 14, 1);
    ctx.fillStyle = '#66b8ff'; ctx.fillRect(11 + (f % 7), 12, 2, 4);
  } else {
    const bob = f % 4 < 2 ? 0 : 1;
    ctx.fillStyle = 'rgba(66,245,212,0.25)'; ctx.fillRect(8, 20 + bob, 16, 2);
    ctx.fillStyle = '#192d42'; ctx.fillRect(9, 9 + bob, 14, 8);
    ctx.fillStyle = '#8799aa'; ctx.fillRect(11, 7 + bob, 10, 4);
    ctx.fillStyle = '#42f5d4'; ctx.fillRect(12, 11 + bob, 2, 2); ctx.fillRect(18, 11 + bob, 2, 2);
    ctx.fillStyle = '#bd77ff'; ctx.fillRect(15, 8 + bob, 2, 2);
  }

  const out = { canvas: c, ax: 16, ay: 23 };
  cache.set(key, out);
  return out;
}
