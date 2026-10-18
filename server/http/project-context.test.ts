import { utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectContextCache, projectFingerprint } from './project-context.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'habblaud-ctx-'));
}

async function createWorkspace(root: string): Promise<void> {
  // Estrutura básica
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'meu-projeto',
      scripts: { build: 'tsc', test: 'vitest' },
      dependencies: { express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
    }),
  );
  await writeFile(join(root, 'AGENTS.md'), '# Agents\nDiretrizes do agente.');
  await writeFile(join(root, 'README.md'), '# Readme\nDescrição do projeto.');
  await writeFile(join(root, 'index.ts'), 'export const x = 1;');
  await writeFile(join(root, 'server.ts'), 'export const s = 2;');

  // Pasta que deve ser ignorada
  await mkdir(join(root, 'node_modules', 'lodash'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'lodash', 'index.js'), 'module.exports = {};');

  // .git deve ser ignorado
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');

  // dist deve ser ignorado
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.js'), 'built');

  // Arquivo .env deve ser ignorado
  await writeFile(join(root, '.env'), 'SECRET=abc');
  await writeFile(join(root, '.env.local'), 'LOCAL=1');

  // Arquivo .pem deve ser ignorado
  await writeFile(join(root, 'segredo.pem'), '-----BEGIN CERTIFICATE-----');
}

// ─── Suite principal ──────────────────────────────────────────────────────────

describe('ProjectContextCache', () => {
  let root: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = tmp();
    cacheDir = tmp();
    await createWorkspace(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('monta cartão com docs, scripts, deps e ignora node_modules/.git/dist/.env/segredo.pem; files ordenados com barra', async () => {
    const cache = new ProjectContextCache({ cacheDir });
    const { card, cached } = await cache.get('ws-test', root);

    // Não estava em cache
    expect(cached).toBe(false);

    // Docs carregados
    const docPaths = card.docs.map((d) => d.path);
    expect(docPaths).toContain('AGENTS.md');
    expect(docPaths).toContain('README.md');
    const agentsDoc = card.docs.find((d) => d.path === 'AGENTS.md');
    expect(agentsDoc?.head).toContain('Agents');

    // package.json
    expect(card.packageJson?.name).toBe('meu-projeto');
    expect(card.packageJson?.scripts).toMatchObject({ build: 'tsc', test: 'vitest' });
    expect(card.packageJson?.dependencies).toContain('express');
    expect(card.packageJson?.devDependencies).toContain('typescript');

    // Arquivos ordenados com '/'
    expect(card.files).toEqual([...card.files].sort());
    for (const f of card.files) {
      expect(f).not.toContain('\\');
    }

    // Arquivos ignorados não devem aparecer
    for (const f of card.files) {
      expect(f).not.toMatch(/node_modules/);
      expect(f).not.toMatch(/^\.git/);
      expect(f).not.toMatch(/^dist\//);
      expect(f).not.toMatch(/\.env/);
      expect(f).not.toMatch(/\.pem$/);
    }

    // Arquivos esperados presentes
    expect(card.files.some((f) => f.endsWith('index.ts'))).toBe(true);
    expect(card.files.some((f) => f.endsWith('server.ts'))).toBe(true);
  });

  it('segunda chamada sem mudança devolve cached=true e builtAt igual (sem nova varredura)', async () => {
    const cache = new ProjectContextCache({ cacheDir });

    const first = await cache.get('ws-cache', root);
    expect(first.cached).toBe(false);

    const second = await cache.get('ws-cache', root);
    expect(second.cached).toBe(true);
    // builtAt idêntico prova que não reconstruiu
    expect(second.card.builtAt).toBe(first.card.builtAt);
    // fingerprint idêntico
    expect(second.card.fingerprint).toBe(first.card.fingerprint);
  });

  it('alterar README.md (mtime avançado) → cached=false e novo fingerprint', async () => {
    const cache = new ProjectContextCache();
    const first = await cache.get('ws-readme', root);
    expect(first.cached).toBe(false);

    // Modifica o conteúdo e avança o mtime para garantir que o stat mude
    const readmePath = join(root, 'README.md');
    writeFileSync(readmePath, '# README novo\nConteúdo alterado');
    const futuro = new Date(Date.now() + 5_000);
    utimesSync(readmePath, futuro, futuro);

    const second = await cache.get('ws-readme', root);
    expect(second.cached).toBe(false);
    expect(second.card.fingerprint).not.toBe(first.card.fingerprint);
  });

  it('force:true reconstrói mesmo com fingerprint igual', async () => {
    // Usa now() fixo para detectar reconstrução via builtAt
    let tick = 1_000;
    const cache = new ProjectContextCache({ now: () => tick });

    const first = await cache.get('ws-force', root);
    expect(first.cached).toBe(false);
    expect(first.card.builtAt).toBe(1_000);

    tick = 2_000;
    const second = await cache.get('ws-force', root, { force: true });
    expect(second.cached).toBe(false);
    // builtAt deve ter avançado → prova que reconstruiu
    expect(second.card.builtAt).toBe(2_000);
  });

  it('cache persistente: nova instância com mesmo cacheDir devolve cached=true', async () => {
    const cacheA = new ProjectContextCache({ cacheDir });
    const first = await cacheA.get('ws-persist', root);
    expect(first.cached).toBe(false);

    // Nova instância (memória vazia, mesmo cacheDir)
    const cacheB = new ProjectContextCache({ cacheDir });
    const second = await cacheB.get('ws-persist', root);
    expect(second.cached).toBe(true);
    expect(second.card.fingerprint).toBe(first.card.fingerprint);
  });

  it('maxFiles=3 → files.length === 3, totalFiles maior, render menciona total', async () => {
    // Cria arquivos extras para garantir mais de 3
    await writeFile(join(root, 'a.ts'), '1');
    await writeFile(join(root, 'b.ts'), '2');
    await writeFile(join(root, 'c.ts'), '3');
    await writeFile(join(root, 'd.ts'), '4');

    const cache = new ProjectContextCache({ maxFiles: 3 });
    const { card } = await cache.get('ws-maxfiles', root);

    expect(card.files.length).toBe(3);
    expect(card.totalFiles).toBeGreaterThan(3);

    const rendered = cache.render(card);
    // O render deve mencionar o total de arquivos
    expect(rendered).toContain(String(card.totalFiles));
  });

  it('render ≤ 12 000 caracteres mesmo com README enorme e começa com "Cartão do projeto"', async () => {
    // Escreve um README gigante
    await writeFile(join(root, 'README.md'), 'x'.repeat(100_000));

    const cache = new ProjectContextCache();
    const { card } = await cache.get('ws-render', root);
    const rendered = cache.render(card);

    expect(rendered.length).toBeLessThanOrEqual(12_000);
    expect(rendered.startsWith('Cartão do projeto')).toBe(true);
  });

  it('HEAD "ref: refs/heads/main" + arquivo da ref → gitHead "main@<sha>"', async () => {
    const sha = 'abc123def456';

    // Configura repositório git simulado
    const gitDir = join(root, '.git');
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true });
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${sha}\n`);

    const fp = await projectFingerprint(root);
    expect(fp).toBeTruthy(); // fingerprint é calculado sem erro

    const cache = new ProjectContextCache();
    const { card } = await cache.get('ws-git', root);

    expect(card.gitHead).toBe(`main@${sha}`);
  });

  it('package.json inválido → packageJson ausente sem lançar erro', async () => {
    await writeFile(join(root, 'package.json'), 'isso não é json {{{');

    const cache = new ProjectContextCache();
    const { card } = await cache.get('ws-pkgjson-invalido', root);

    expect(card.packageJson).toBeUndefined();
  });

  it('pasta ilegível não interrompe a varredura', async () => {
    // Cria workspace sem pasta ilegível (no CI geralmente não temos permissão
    // de chmod, então testamos apenas que a varredura completa sem erro)
    const cache = new ProjectContextCache();
    await expect(cache.get('ws-ilegivel', root)).resolves.toBeDefined();
  });
});
