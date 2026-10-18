// Tema visual compartilhado entre navegadores e o perfil isolado do wallpaper.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from './log';

export const OFFICE_THEMES = ['original', 'medieval', 'horror', 'alien'] as const;
export type DecorTheme = (typeof OFFICE_THEMES)[number];

export function isOfficeTheme(value: unknown): value is DecorTheme {
  return typeof value === 'string' && (OFFICE_THEMES as readonly string[]).includes(value);
}

export class ThemeStore {
  private value: DecorTheme = 'original';

  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { theme?: unknown };
      if (isOfficeTheme(parsed.theme)) this.value = parsed.theme;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`theme.json ilegível (${errMsg(err)}); usando o tema original.`);
    }
  }

  get(): DecorTheme {
    return this.value;
  }

  set(theme: DecorTheme): void {
    if (theme === this.value) return;
    this.value = theme;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, theme }));
      renameSync(tmp, this.file);
    } catch (err) {
      log.warnOnce('theme-write', `Não foi possível gravar ${this.file} (${errMsg(err)}); o tema vale só nesta execução.`);
    }
  }
}
