import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorkspaces } from './workspaces';

const temporaryDirs: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'habblaud-workspaces-'));
  temporaryDirs.push(root);
  return root;
}

function project(root: string, name: string, marker: 'package.json' | '.git'): string {
  const dir = join(root, name);
  mkdirSync(dir);
  if (marker === '.git') mkdirSync(join(dir, marker));
  else writeFileSync(join(dir, marker), '{}');
  return dir;
}

afterEach(() => {
  for (const root of temporaryDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('discoverWorkspaces', () => {
  it('inclui o principal como habblaud e projetos com package.json ou .git', () => {
    const root = temporaryRoot();
    const main = project(root, 'Principal', 'package.json');
    const packageProject = project(root, 'Aplicativo', 'package.json');
    const gitProject = project(root, 'Biblioteca', '.git');
    mkdirSync(join(root, 'PastaComum'));

    expect(discoverWorkspaces(main, [root])).toEqual({
      habblaud: main,
      aplicativo: packageProject,
      biblioteca: gitProject,
    });
  });

  it('ignora CarecaBrain, Ollama, node_modules e pastas iniciadas por ponto', () => {
    const root = temporaryRoot();
    const visible = project(root, 'Visivel', 'package.json');
    for (const name of ['CarecaBrain', 'Ollama', 'node_modules', '.oculta']) {
      project(root, name, 'package.json');
    }

    expect(discoverWorkspaces(undefined, [root])).toEqual({ visivel: visible });
  });

  it('acrescenta -2 a ids repetidos de raízes diferentes', () => {
    const parent = temporaryRoot();
    const firstRoot = join(parent, 'primeira');
    const secondRoot = join(parent, 'segunda');
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    const first = project(firstRoot, 'Projeto', 'package.json');
    const second = project(secondRoot, 'Projeto', '.git');

    expect(discoverWorkspaces(undefined, [firstRoot, secondRoot])).toEqual({
      projeto: first,
      'projeto-2': second,
    });
  });

  it('ignora raiz inexistente sem lançar e preserva o workspace principal', () => {
    const root = temporaryRoot();
    const main = project(root, 'Principal', 'package.json');
    const missing = join(root, 'raiz-inexistente');

    expect(() => discoverWorkspaces(main, [missing])).not.toThrow();
    expect(discoverWorkspaces(main, [missing])).toEqual({ habblaud: main });
  });
});
