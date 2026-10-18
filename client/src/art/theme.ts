// Temas de sala (puros): paletas claras e bem distintas. Sementes consecutivas (slots vizinhos)
// recebem temas diferentes; a ordem da lista alterna famílias de cor de propósito.
import type { RoomTheme } from './api';
import type { DecorTheme } from '../world/api';

const THEMES: readonly RoomTheme[] = [
  { carpet: '#c9d1dc', carpet2: '#bdc6d3', wall: { base: '#eef1f4', trim: '#9fb0c4', pattern: 'plain' }, accent: '#3f7fd8', deskVariant: 'white', chairVariant: 'blue' },
  { carpet: '#dbcfba', carpet2: '#d0c2ab', wall: { base: '#f6f0e5', trim: '#b99f7a', pattern: 'stripes' }, accent: '#ec8a3c', deskVariant: 'wood', chairVariant: 'black' },
  { carpet: '#c4cfbb', carpet2: '#b8c5af', wall: { base: '#f1f3ea', trim: '#93a487', pattern: 'wood_panel' }, accent: '#4cae6a', deskVariant: 'wood', chairVariant: 'green' },
  { carpet: '#cdc8de', carpet2: '#c2bbd5', wall: { base: '#f3f1f8', trim: '#a59cc4', pattern: 'plain' }, accent: '#8d66cf', deskVariant: 'white', chairVariant: 'gray' },
  { carpet: '#e4cdbe', carpet2: '#dbc1b0', wall: { base: '#f8f1eb', trim: '#c99a83', pattern: 'plain' }, accent: '#e2604f', deskVariant: 'wood', chairVariant: 'red' },
  { carpet: '#bfd9d2', carpet2: '#b2cfc7', wall: { base: '#eef6f4', trim: '#7fb3a6', pattern: 'stripes' }, accent: '#36b0b0', deskVariant: 'white', chairVariant: 'green' },
  { carpet: '#aab1bd', carpet2: '#9fa7b4', wall: { base: '#e8eaee', trim: '#6d7583', pattern: 'brick' }, accent: '#f2c14e', deskVariant: 'dark', chairVariant: 'black' },
  { carpet: '#e0cad2', carpet2: '#d6bdc6', wall: { base: '#f9f2f4', trim: '#c08ea0', pattern: 'stripes' }, accent: '#e47aa8', deskVariant: 'white', chairVariant: 'black' },
  { carpet: '#c0d2e7', carpet2: '#b3c7e0', wall: { base: '#eef4fa', trim: '#8aa6c8', pattern: 'wood_panel' }, accent: '#5b8fe0', deskVariant: 'wood', chairVariant: 'blue' },
  { carpet: '#d1c5b8', carpet2: '#c5b8aa', wall: { base: '#f4efe8', trim: '#8a6a52', pattern: 'wood_panel' }, accent: '#c9713f', deskVariant: 'dark', chairVariant: 'gray' },
];

const MEDIEVAL: readonly RoomTheme[] = [
  { carpet: '#78552f', carpet2: '#5f3e24', wall: { base: '#b99b68', trim: '#5b3a20', pattern: 'brick' }, accent: '#e8bd54', deskVariant: 'wood', chairVariant: 'red' },
  { carpet: '#4c6038', carpet2: '#354529', wall: { base: '#9c8761', trim: '#463322', pattern: 'wood_panel' }, accent: '#9bc46b', deskVariant: 'wood', chairVariant: 'green' },
  { carpet: '#5a4166', carpet2: '#402e49', wall: { base: '#aa926d', trim: '#4b3423', pattern: 'brick' }, accent: '#c994e8', deskVariant: 'dark', chairVariant: 'gray' },
];

const HORROR: readonly RoomTheme[] = [
  { carpet: '#332629', carpet2: '#1e191b', wall: { base: '#514b43', trim: '#1b1717', pattern: 'wood_panel' }, accent: '#9d1f2d', deskVariant: 'dark', chairVariant: 'black' },
  { carpet: '#26302b', carpet2: '#151b18', wall: { base: '#4a5046', trim: '#171b18', pattern: 'brick' }, accent: '#778f55', deskVariant: 'dark', chairVariant: 'gray' },
  { carpet: '#30283a', carpet2: '#1b1722', wall: { base: '#4b4551', trim: '#19151d', pattern: 'stripes' }, accent: '#75508c', deskVariant: 'dark', chairVariant: 'black' },
];

const ALIEN: readonly RoomTheme[] = [
  { carpet: '#173b42', carpet2: '#102b31', wall: { base: '#294e57', trim: '#0b2027', pattern: 'plain' }, accent: '#42f5d4', deskVariant: 'dark', chairVariant: 'green' },
  { carpet: '#302653', carpet2: '#211a3b', wall: { base: '#493d68', trim: '#17122b', pattern: 'plain' }, accent: '#bd77ff', deskVariant: 'dark', chairVariant: 'blue' },
  { carpet: '#263b59', carpet2: '#182a43', wall: { base: '#385570', trim: '#101d2d', pattern: 'stripes' }, accent: '#66b8ff', deskVariant: 'white', chairVariant: 'blue' },
];

export const THEME_COUNT = THEMES.length;

export function roomTheme(seed: number, officeTheme: DecorTheme = 'original'): RoomTheme {
  const themes = officeTheme === 'medieval' ? MEDIEVAL : officeTheme === 'horror' ? HORROR : officeTheme === 'alien' ? ALIEN : THEMES;
  const n = themes.length;
  const t = themes[((Math.floor(seed) % n) + n) % n];
  return { ...t, wall: { ...t.wall } };
}
