// Receitas do estúdio: frontmatter simples, campos obrigatórios e a pasta real do repositório.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { loadRecipes, parseRecipe } from './recipes';

const ok = '---\nid: revisao\ntitulo: Revisão\nresumo: Revisa o projeto.\nmodo: leitura\ncombos: revisor, revisor-seguranca\n---\n1. Leia {{workspace}}.\n\nEntrega: relatório.';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('receitas', () => {
  it('lê frontmatter e corpo; combos válidos viram lista', () => {
    const r = parseRecipe(ok);
    expect(r).toMatchObject({ id: 'revisao', titulo: 'Revisão', modo: 'leitura', combos: ['revisor', 'revisor-seguranca'] });
    expect(r?.corpo).toContain('{{workspace}}');
  });

  it('recusa sem frontmatter, sem id válido ou sem corpo; modo desconhecido vira leitura', () => {
    expect(parseRecipe('# só texto')).toBeUndefined();
    expect(parseRecipe(ok.replace('id: revisao', 'id: Revisão!'))).toBeUndefined();
    expect(parseRecipe(ok.replace(/---\n1\.[\s\S]*$/, '---\n'))).toBeUndefined();
    expect(parseRecipe(ok.replace('modo: leitura', 'modo: apagar-tudo'))?.modo).toBe('leitura');
  });

  it('carrega a pasta ignorando LEIA-ME e arquivos quebrados; pasta ausente = vazia', () => {
    const tmp = tempDir();
    cleanup = tmp.cleanup;
    mkdirSync(join(tmp.dir, 'r'));
    writeFileSync(join(tmp.dir, 'r', 'a.md'), ok);
    writeFileSync(join(tmp.dir, 'r', 'b.md'), 'quebrado');
    writeFileSync(join(tmp.dir, 'r', 'LEIA-ME.md'), ok.replace('revisao', 'leia'));
    expect(loadRecipes(join(tmp.dir, 'r')).map((r) => r.id)).toEqual(['revisao']);
    expect(loadRecipes(join(tmp.dir, 'nao-existe'))).toEqual([]);
  });

  it('todas as receitas do repositório são válidas', () => {
    const dir = join(import.meta.dirname, '..', '..', 'shared', 'recipes');
    const recipes = loadRecipes(dir);
    expect(recipes.length).toBeGreaterThanOrEqual(9);
    for (const r of recipes) expect(r.corpo, r.id).toContain('Entrega');
  });
});
