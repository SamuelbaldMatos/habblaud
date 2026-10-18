import type { ActivityKind } from '../../../shared/types';
import type { HeldItem, Pose } from '../art/api';
import type { DecorTheme } from './api';
import type { Character } from './sim/character';

export type ThemeEffect = 'magic' | 'dragon' | 'shadow' | 'bat' | 'hologram' | 'drone';

export interface ThemeActivityVisual {
  pose?: Pose;
  held?: HeldItem;
  effect?: ThemeEffect;
  companion?: ThemeEffect;
}

export interface ThemeVisualProfile {
  id: DecorTheme;
  work: Partial<Record<ActivityKind, ThemeActivityVisual>>;
  defaultWork: ThemeActivityVisual;
  social: Partial<Record<Pose, ThemeActivityVisual>>;
}

const reading = new Set<ActivityKind>(['edit', 'write', 'think', 'read', 'respond', 'compact', 'plan', 'skill']);
const running = new Set<ActivityKind>(['run', 'test', 'git']);
const communicating = new Set<ActivityKind>(['communicate', 'ask', 'prompt', 'delegate']);

function workMap(theme: Exclude<DecorTheme, 'original'>): ThemeVisualProfile['work'] {
  const out: ThemeVisualProfile['work'] = {};
  for (const kind of reading) {
    out[kind] = theme === 'medieval'
      ? { pose: 'read', held: 'book', effect: 'magic', companion: 'dragon' }
      : theme === 'horror'
        ? { pose: 'read', held: 'book', effect: 'shadow', companion: 'bat' }
        : { pose: 'use', held: 'laptop', effect: 'hologram', companion: 'drone' };
  }
  for (const kind of running) {
    out[kind] = theme === 'medieval'
      ? { pose: 'raise_hand', held: 'none', effect: 'magic', companion: 'dragon' }
      : theme === 'horror'
        ? { pose: 'use', held: 'papers', effect: 'shadow', companion: 'bat' }
        : { pose: 'use', held: 'laptop', effect: 'hologram', companion: 'drone' };
  }
  for (const kind of communicating) {
    out[kind] = theme === 'medieval'
      ? { pose: 'raise_hand', held: 'book', effect: 'magic' }
      : theme === 'horror'
        ? { pose: 'talk', held: 'papers', effect: 'shadow' }
        : { pose: 'talk', held: 'phone', effect: 'hologram' };
  }
  return out;
}

export const THEME_VISUAL_PROFILES: Readonly<Record<DecorTheme, ThemeVisualProfile>> = {
  original: { id: 'original', work: {}, defaultWork: {}, social: {} },
  medieval: {
    id: 'medieval',
    work: workMap('medieval'),
    defaultWork: { pose: 'read', held: 'book', effect: 'magic', companion: 'dragon' },
    social: { play: { effect: 'magic' }, cheer: { effect: 'magic' }, rps: { effect: 'magic' } },
  },
  horror: {
    id: 'horror',
    work: workMap('horror'),
    defaultWork: { pose: 'read', held: 'papers', effect: 'shadow', companion: 'bat' },
    social: { play: { effect: 'shadow' }, cheer: { effect: 'bat' }, rps: { effect: 'shadow' } },
  },
  alien: {
    id: 'alien',
    work: workMap('alien'),
    defaultWork: { pose: 'use', held: 'laptop', effect: 'hologram', companion: 'drone' },
    social: { play: { effect: 'hologram' }, cheer: { effect: 'drone' }, rps: { effect: 'hologram' } },
  },
};

export function visualForCharacter(theme: DecorTheme, ch: Character): ThemeActivityVisual | null {
  if (theme === 'original') return null;
  const profile = THEME_VISUAL_PROFILES[theme];
  if (ch.pose === 'sleep' || ch.pose === 'wait') return null;
  if (ch.mode === 'work') {
    const visual = profile.work[ch.info.activity?.kind ?? 'other'] ?? profile.defaultWork;
    // Durante o deslocamento preserva a animação original do corpo, mas o familiar/efeito
    // temático continua acompanhando o funcionário em vez de desaparecer entre as mesas.
    if (ch.pose === 'walk' || ch.pose === 'run') {
      return visual.effect || visual.companion
        ? { effect: visual.effect, companion: visual.companion }
        : null;
    }
    return visual;
  }
  if (ch.pose === 'walk' || ch.pose === 'run') return null;
  return profile.social[ch.pose] ?? null;
}
