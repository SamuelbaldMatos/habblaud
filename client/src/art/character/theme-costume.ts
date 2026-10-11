import { hash32 } from '../../../../shared/hash';
import type { OfficeTheme } from '../../world/api';
import type { Appearance, CharacterFrameRequest } from '../api';
import type { PixelBuf } from '../core/pixbuf';
import type { BufSprite } from '../core/sprite';
import { appearanceKey } from './appearance';
import { isSeated, renderCharacter } from './render';

function themedAppearance(a: Appearance, theme: OfficeTheme): Appearance {
  if (theme === 'original') return a;
  const n = hash32(appearanceKey(a));
  if (theme === 'medieval') {
    const cloth = ['#6f2638', '#294f35', '#243f68', '#6b4825'][n % 4];
    return { ...a, top: cloth, topAccent: '#d6ad4d', bottom: '#30251f', shoes: '#241b18', topStyle: 'jacket' };
  }
  if (theme === 'horror') {
    const cloth = ['#17171a', '#242126', '#30252a'][n % 3];
    return { ...a, top: cloth, topAccent: n % 2 ? '#6f101c' : '#77716b', bottom: '#121216', shoes: '#09090b', topStyle: 'jacket' };
  }
  const suit = ['#d4e2e4', '#687d91', '#433866'][n % 3];
  return { ...a, top: suit, topAccent: n % 2 ? '#42f5d4' : '#bd77ff', bottom: '#263447', shoes: '#121d2b', topStyle: 'jacket' };
}

interface CostumeRig {
  bodyY: number;
  headY: number;
  lean: number;
}

/** Replica apenas os deslocamentos do rig que afetam roupa/cabeça; a pose-base continua intacta. */
function costumeRig(req: CharacterFrameRequest): CostumeRig {
  const f = Math.max(0, Math.floor(req.frame));
  const seated = isSeated(req.pose, req.seated);
  let bodyY = seated ? 4 : 0;
  let headExtra = 0;
  let sideLean = 0;

  switch (req.pose) {
    case 'stand':
    case 'sit':
      headExtra = f % 2;
      break;
    case 'walk':
    case 'run':
      if (f % 2 === 1) bodyY--;
      if (req.pose === 'run') sideLean = -1;
      break;
    case 'sleep':
      headExtra = f % 2 === 0 ? 2 : 3;
      break;
    case 'stretch':
      if (f % 2 === 1) bodyY--;
      break;
    case 'read':
      headExtra = f % 2;
      break;
    case 'wait':
      if (req.dir === 'down') bodyY--;
      else if (req.dir === 'up') bodyY++;
      else sideLean = 1;
      break;
    case 'cheer':
      if (f % 2 === 1) bodyY -= seated ? 1 : 2;
      break;
    case 'laugh':
      if (f % 2 === 0) bodyY--;
      sideLean = f % 2 === 0 ? 1 : -1;
      break;
    case 'game':
      sideLean = -1;
      break;
  }

  if (req.dir === 'right') sideLean *= -1;
  if (req.dir !== 'left' && req.dir !== 'right') sideLean = 0;
  return { bodyY, headY: bodyY + headExtra, lean: sideLean };
}

function bodySpan(req: CharacterFrameRequest, rig: CostumeRig): { x0: number; x1: number } {
  if (req.dir === 'left') return { x0: 8 + rig.lean, x1: 14 + rig.lean };
  if (req.dir === 'right') return { x0: 9 + rig.lean, x1: 15 + rig.lean };
  return { x0: 8, x1: 15 };
}

function drawMedieval(b: PixelBuf, req: CharacterFrameRequest, n: number, rig: CostumeRig): void {
  const { x0, x1 } = bodySpan(req, rig);
  const y = 18 + rig.bodyY;
  const gold = '#e5bd57';
  const leather = '#3c281c';
  const metal = n % 2 ? '#a78a58' : '#657184';

  // Tabardo, cinto e ombreiras acompanham exatamente a translação do tronco da pose.
  b.hline(x0, x1, y + 5, leather);
  b.set(Math.floor((x0 + x1) / 2), y + 5, gold);
  b.set(Math.ceil((x0 + x1) / 2), y + 5, gold);
  if (req.dir === 'down') {
    b.set(11, y + 1, gold); b.set(12, y + 1, gold);
    b.set(7, y, metal); b.set(16, y, metal);
  } else if (req.dir === 'up') {
    b.hline(9, 14, y, metal);
    b.set(11, y + 2, gold); b.set(12, y + 2, gold);
  } else {
    const front = req.dir === 'left' ? x0 : x1;
    b.set(front, y + 1, gold);
    b.set(req.dir === 'left' ? x1 : x0, y, metal);
  }

  const hy = rig.headY;
  if (n % 3 === 0) {
    // Coroa baixa: continua dentro da folha 24x34 mesmo no salto/alongamento.
    if (req.dir === 'left' || req.dir === 'right') {
      const x0h = req.dir === 'left' ? 7 + rig.lean : 9 + rig.lean;
      b.hline(x0h, x0h + 7, 5 + hy, '#9b6b27');
      b.set(x0h + 1, 3 + hy, gold); b.set(x0h + 4, 2 + hy, gold); b.set(x0h + 7, 3 + hy, gold);
    } else {
      b.hline(8, 15, 5 + hy, '#9b6b27');
      b.set(8, 3 + hy, gold); b.set(11, 2 + hy, gold); b.set(15, 3 + hy, gold);
    }
  } else if (n % 3 === 1) {
    // Gorro de escriba e pena, orientados para a frente do perfil.
    const x0h = req.dir === 'left' ? 7 + rig.lean : req.dir === 'right' ? 9 + rig.lean : 8;
    const x1h = x0h + 7;
    b.hline(x0h, x1h, 6 + hy, '#3c281c');
    const px = req.dir === 'left' ? x0h : x1h;
    const step = req.dir === 'left' ? -1 : 1;
    b.set(px, 5 + hy, '#d7c07b');
    b.set(px + step, 3 + hy, '#d7c07b');
    b.set(px + step * 2, 2 + hy, '#efe0a5');
  } else {
    // Capuz e fecho de capa.
    const lx = req.dir === 'right' ? 16 + rig.lean : 6 + rig.lean;
    const rx = req.dir === 'right' ? 8 + rig.lean : 17 + rig.lean;
    b.vline(lx, 8 + hy, 13 + hy, '#193323');
    b.vline(rx, 8 + hy, 13 + hy, '#193323');
    b.set(req.dir === 'left' ? x0 : req.dir === 'right' ? x1 : 11, y, gold);
  }
}

function drawHorror(b: PixelBuf, req: CharacterFrameRequest, n: number, rig: CostumeRig): void {
  const { x0, x1 } = bodySpan(req, rig);
  const y = 18 + rig.bodyY;
  const ink = '#09090b';
  const worn = '#51484b';

  // Sobretudo vitoriano gasto: gola alta, fileira de botões e costuras, sem iconografia cômica.
  b.hline(x0, x1, y, ink);
  b.hline(x0 + 1, x1 - 1, y + 5, '#141216');
  if (req.dir === 'down') {
    b.line(9, y + 1, 11, y + 4, worn);
    b.line(14, y + 1, 12, y + 4, worn);
    b.set(12, y + 1, '#8a1422'); b.set(12, y + 3, '#4c0b12');
  } else if (req.dir === 'up') {
    b.vline(12, y + 1, y + 5, '#0b0a0d');
    b.set(9 + (n % 5), y + 3, worn);
  } else {
    const seam = req.dir === 'left' ? x0 + 2 : x1 - 2;
    b.vline(seam, y + 1, y + 4, worn);
    b.set(seam + (req.dir === 'left' ? -1 : 1), y + 3, '#65101b');
  }

  const hy = rig.headY;
  if (n % 4 === 0 && req.dir !== 'up') {
    // Meia-máscara de porcelana rachada.
    if (req.dir === 'down') {
      b.hline(9, 14, 11 + hy, '#d8d2c8');
      b.hline(10, 13, 12 + hy, '#9f9991');
      b.set(12, 13 + hy, '#6f6965'); b.set(13, 14 + hy, '#6f6965');
    } else {
      const face = req.dir === 'left' ? 5 + rig.lean : 18 + rig.lean;
      const step = req.dir === 'left' ? 1 : -1;
      b.set(face, 10 + hy, '#d8d2c8');
      b.set(face + step, 11 + hy, '#9f9991');
      b.set(face + step * 2, 12 + hy, '#77716b');
    }
  } else if (n % 4 === 1) {
    // Véu estreito que acompanha a cabeça e não muda o footprint.
    const lx = req.dir === 'right' ? 17 + rig.lean : 5 + rig.lean;
    const rx = req.dir === 'right' ? 7 + rig.lean : 18 + rig.lean;
    b.vline(lx, 8 + hy, 15 + hy, '#161419');
    b.vline(rx, 8 + hy, 15 + hy, '#161419');
  } else {
    b.set(8 + rig.lean, 8 + hy, '#302b31');
    b.set(15 + rig.lean, 8 + hy, '#151318');
  }
}

function drawAlien(b: PixelBuf, req: CharacterFrameRequest, n: number, rig: CostumeRig): void {
  const { x0, x1 } = bodySpan(req, rig);
  const y = 18 + rig.bodyY;
  const glow = n % 2 ? '#42f5d4' : '#bd77ff';
  const alloy = '#8799aa';
  const dark = '#173f58';

  // Placas articuladas deixam braços e pernas do rig original totalmente livres.
  b.set(x0, y, alloy); b.set(x1, y, alloy);
  b.hline(x0 + 1, x1 - 1, y + 5, dark);
  if (req.dir === 'down') {
    b.set(11, y + 1, glow); b.set(12, y + 1, glow);
    b.set(11, y + 2, dark); b.set(12, y + 2, dark);
  } else if (req.dir === 'up') {
    b.hline(x0 + 2, x1 - 2, y + 1, glow);
    b.set(12, y + 3, alloy);
  } else {
    const core = req.dir === 'left' ? x0 + 1 : x1 - 1;
    b.set(core, y + 1, glow); b.set(core, y + 2, dark);
  }

  const hy = rig.headY;
  const hx0 = req.dir === 'left' ? 6 + rig.lean : req.dir === 'right' ? 9 + rig.lean : 7;
  const hx1 = req.dir === 'left' ? 14 + rig.lean : req.dir === 'right' ? 17 + rig.lean : 16;
  b.hline(hx0, hx1, 10 + hy, dark);
  for (let x = hx0 + 1; x < hx1; x += 2) b.set(x, 11 + hy, glow);
  b.set(12 + rig.lean, 4 + hy, alloy);
  if (n % 3 === 0) b.set(12 + rig.lean, 2 + hy, glow);
}

/** Costura e punhos respondem ao quadro do rig, mantendo legível até o gesto visto de costas. */
function drawAnimatedCostumeDetails(b: PixelBuf, req: CharacterFrameRequest, theme: OfficeTheme, rig: CostumeRig): void {
  const even = Math.floor(req.frame) % 2 === 0;
  const color = theme === 'medieval' ? '#a78a58' : theme === 'horror' ? '#62575a' : '#42f5d4';
  const dark = theme === 'medieval' ? '#3c281c' : theme === 'horror' ? '#141216' : '#173f58';
  const { x0, x1 } = bodySpan(req, rig);
  const hemY = 22 + rig.bodyY;
  b.set(x0 + 1, hemY, even ? color : dark);
  b.set(x1 - 1, hemY, even ? dark : color);

  if (req.pose !== 'type') return;
  const y = 17 + rig.bodyY;
  if (req.dir === 'up' || req.dir === 'down') {
    b.set(even ? 6 : 16, y, color);
    b.set(even ? 16 : 6, y + 1, color);
  } else {
    const front = req.dir === 'left' ? 6 + rig.lean : 17 + rig.lean;
    b.set(front, y + (even ? 0 : 1), color);
  }
}

function decorateFrame(s: BufSprite, req: CharacterFrameRequest, theme: OfficeTheme, seed: number): BufSprite {
  if (theme === 'original') return s;
  const n = hash32(String(seed));
  const rig = costumeRig(req);
  if (theme === 'medieval') drawMedieval(s.buf, req, n, rig);
  else if (theme === 'horror') drawHorror(s.buf, req, n, rig);
  else drawAlien(s.buf, req, n, rig);
  drawAnimatedCostumeDetails(s.buf, req, theme, rig);
  return s;
}

/** Um sprite completo por direção × pose × quadro × item × estado sentado. */
export function renderThemedCharacter(req: CharacterFrameRequest, theme: OfficeTheme, seed: number): BufSprite {
  const appearance = themedAppearance(req.appearance, theme);
  return decorateFrame(renderCharacter({ ...req, appearance }), req, theme, seed);
}
