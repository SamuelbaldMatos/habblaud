import { hash32 } from '../../../../shared/hash';
import type { OfficeTheme } from '../../world/api';
import type { Appearance, CharacterFrameRequest } from '../api';
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

function frameLift(req: CharacterFrameRequest): number {
  const f = Math.floor(req.frame);
  if (req.pose === 'walk' || req.pose === 'run') return f % 2 ? -1 : 0;
  if (req.pose === 'cheer' || req.pose === 'laugh' || req.pose === 'play') return f % 2 ? 1 : -1;
  return f % 2;
}

function decorateFrame(s: BufSprite, req: CharacterFrameRequest, theme: OfficeTheme, seed: number): BufSprite {
  if (theme === 'original') return s;
  const b = s.buf;
  const n = hash32(String(seed));
  const headLift = frameLift(req);
  const bodyLift = headLift + (isSeated(req.pose, req.seated) ? 4 : 0);
  const mirror = req.dir === 'right' ? -1 : 1;

  if (theme === 'medieval') {
    const gold = '#e5bd57';
    const metal = n % 2 ? '#9e7b43' : '#596474';
    b.rect(5, 18 + bodyLift, 3, 3, metal);
    b.rect(16, 18 + bodyLift, 3, 3, metal);
    b.set(11, 20 + bodyLift, gold);
    b.set(12, 20 + bodyLift, gold);
    b.hline(8, 15, 24 + bodyLift, '#3c281c');
    b.set(11, 24 + bodyLift, gold); b.set(12, 24 + bodyLift, gold);
    if (n % 3 === 0) {
      b.hline(8, 15, 5 + headLift, gold);
      b.set(8, 3 + headLift, gold); b.set(11, 2 + headLift, gold); b.set(15, 3 + headLift, gold);
    } else if (n % 3 === 1) {
      const x = mirror > 0 ? 18 : 5;
      b.set(x, 7 + headLift, '#d7c07b');
      b.set(x + mirror, 5 + headLift, '#d7c07b');
      b.set(x + mirror * 2, 3 + headLift, '#efe0a5');
    } else {
      b.hline(6, 17, 7 + headLift, '#294f35');
      b.set(6, 8 + headLift, '#193323'); b.set(17, 8 + headLift, '#193323');
    }
  } else if (theme === 'horror') {
    b.hline(6, 17, 18 + bodyLift, '#09090b');
    b.hline(8, 15, 24 + bodyLift, '#141216');
    b.set(11, 20 + bodyLift, '#8a1422'); b.set(12, 21 + bodyLift, '#4c0b12');
    if (n % 4 === 0) {
      if (req.dir === 'down') {
        b.hline(9, 14, 12 + headLift, '#d8d2c8');
        b.hline(10, 13, 13 + headLift, '#9f9991');
        b.set(12, 14 + headLift, '#77716b');
      } else {
        const x = req.dir === 'left' ? 5 : req.dir === 'right' ? 17 : 11;
        b.line(x, 11 + headLift, x + mirror * 3, 13 + headLift, '#d8d2c8');
      }
    } else if (n % 4 === 1) {
      b.vline(5, 8 + headLift, 17 + headLift, '#161419');
      b.vline(18, 8 + headLift, 17 + headLift, '#161419');
    }
  } else {
    const glow = n % 2 ? '#42f5d4' : '#bd77ff';
    b.hline(7, 16, 11 + headLift, glow);
    b.hline(8, 15, 12 + headLift, '#173f58');
    b.rect(5, 18 + bodyLift, 3, 3, '#8799aa');
    b.rect(16, 18 + bodyLift, 3, 3, '#8799aa');
    b.set(11, 20 + bodyLift, glow); b.set(12, 20 + bodyLift, glow);
    b.set(12, 4 + headLift, '#8799aa'); b.set(12, 2 + headLift, glow);
  }
  b.outline();
  return s;
}

/** Um sprite completo por direcao × pose × quadro × item × estado sentado. */
export function renderThemedCharacter(req: CharacterFrameRequest, theme: OfficeTheme, seed: number): BufSprite {
  const appearance = themedAppearance(req.appearance, theme);
  return decorateFrame(renderCharacter({ ...req, appearance }), req, theme, seed);
}
