import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class AgentToolError extends Error {}

const MAX_FILE_BYTES = 128 * 1024;
const MAX_COMMAND_OUTPUT = 256 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export const APPROVED_CHECKS = {
  typecheck: 'TypeScript typecheck',
  test: 'Vitest test suite',
  'build-client': 'Vite client build',
  'build-server': 'Server build',
} as const;

export type ApprovedCheck = keyof typeof APPROVED_CHECKS;

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Pastas que o agente nunca lê nem lista: credenciais, configurações de IA, dependências, dados de cliente do vault. */
const PROTECTED_DIRS = new Set([
  '.git', 'node_modules', '.env', '.claude', '.copilot', '.codex', '.gemini', '.omniroute', '.ssh', '.gnupg', '.aws',
  '.azure', '.kube', '.docker', '.npmrc', 'appdata',
  // Vault do Cérebro: dado de cliente fica local (nunca vai para modelo de nuvem).
  'clientes', 'sessoes', 'processos',
]);

/** Caminho (em partes) que aponta para conteúdo protegido. */
export function isProtectedPath(parts: readonly string[]): boolean {
  const last = parts[parts.length - 1] ?? '';
  return (
    parts.some((part) => PROTECTED_DIRS.has(part.toLowerCase())) ||
    /^\.env/i.test(last) ||
    /^(?:docker-compose\.override\.ya?ml|id_(?:rsa|ed25519|ecdsa)\b.*|.*\.(?:pem|key|p12|pfx|kdbx)|\.?npmrc|\.netrc|credentials(?:\.json)?|storage\.sqlite.*)$/i.test(last) ||
    (/^settings(?:\.local)?\.json$/i.test(last) && parts.some((part) => part.toLowerCase() === 'profiles'))
  );
}

export async function resolveWorkspaceFile(rootDir: string, relativePath: unknown): Promise<string> {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    isAbsolute(relativePath)
  ) {
    throw new AgentToolError('O caminho deve ser relativo e não vazio.');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '..')) throw new AgentToolError('O caminho está fora do workspace.');
  if (parts.some((part) => !part || part === '.') || isProtectedPath(parts)) {
    throw new AgentToolError('O caminho é inválido ou aponta para conteúdo local protegido.');
  }
  const root = await realpath(rootDir);
  const candidate = resolve(root, relativePath);
  if (!isWithin(root, candidate) || candidate === root) throw new AgentToolError('O caminho está fora do workspace.');

  const rel = relative(root, candidate);
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new AgentToolError('Acesso a symlinks não é permitido pelas ferramentas do agente.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AgentToolError('O arquivo solicitado não existe.');
      }
      throw error;
    }
  }

  const canonical = await realpath(candidate);
  if (!isWithin(root, canonical) || canonical !== candidate) throw new AgentToolError('O caminho canônico está fora do workspace.');
  const stat = await lstat(canonical);
  if (!stat.isFile()) throw new AgentToolError('As ferramentas do agente aceitam apenas arquivos regulares.');
  return canonical;
}

export async function readWorkspaceFile(rootDir: string, relativePath: unknown): Promise<string> {
  const path = await resolveWorkspaceFile(rootDir, relativePath);
  if ((await lstat(path)).size > MAX_FILE_BYTES) throw new AgentToolError('O arquivo excede o limite de leitura de 128 KiB.');
  const data = await readFile(path);
  if (data.byteLength > MAX_FILE_BYTES) throw new AgentToolError('O arquivo excede o limite de leitura de 128 KiB.');
  if (data.includes(0)) throw new AgentToolError('Arquivos binários não podem ser lidos pelo agente.');
  return data.toString('utf8');
}

/** Numera as linhas para o modelo citar a linha certa ("12| texto"); o arquivo em si não muda. */
export function numberLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width, ' ')}| ${line}`).join('\n');
}

/** Conteúdo copiado da leitura numerada (toda linha com "N| "): sinal de que o modelo esqueceu de tirar os números. */
export function looksLineNumbered(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.length >= 2 && lines.every((line) => /^\s*\d+\| /.test(line));
}

export interface PreparedWrite {
  path: string;
  relativePath: string;
  oldContent: string;
  newContent: string;
  expectedHash: string;
  /** Arquivo novo: a escrita usa O_EXCL (falha se alguém criar o arquivo enquanto aguardava aprovação). */
  create?: boolean;
  /** Pastas que faltam no caminho do arquivo novo (relativas, de cima para baixo); criadas só depois da aprovação. */
  newDirs?: string[];
}

/** Máximo de pastas novas que uma escrita cria de uma vez. */
const MAX_NEW_DIRS = 4;

/**
 * Caminho de um arquivo NOVO: as mesmas regras de resolveWorkspaceFile, sem symlinks no caminho e o arquivo não pode
 * existir. As pastas que faltam (até 4, dentro do workspace) voltam em `newDirs` para criar depois da aprovação.
 */
export async function resolveNewWorkspaceFile(rootDir: string, relativePath: unknown): Promise<string> {
  return (await planNewWorkspaceFile(rootDir, relativePath)).path;
}

export async function planNewWorkspaceFile(rootDir: string, relativePath: unknown): Promise<{ path: string; newDirs: string[] }> {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0') || relativePath.includes('\\') || isAbsolute(relativePath)) {
    throw new AgentToolError('O caminho deve ser relativo e não vazio.');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '..')) throw new AgentToolError('O caminho está fora do workspace.');
  if (parts.some((part) => !part || part === '.') || isProtectedPath(parts)) {
    throw new AgentToolError('O caminho é inválido ou aponta para conteúdo local protegido.');
  }
  const root = await realpath(rootDir);
  const candidate = resolve(root, relativePath);
  if (!isWithin(root, candidate) || candidate === root) throw new AgentToolError('O caminho está fora do workspace.');
  let current = root;
  let existing = root;
  const newDirs: string[] = [];
  const dirs = relative(root, candidate).split(sep).slice(0, -1);
  for (const part of dirs) {
    current = resolve(current, part);
    if (newDirs.length) {
      newDirs.push(relative(root, current).split(sep).join('/'));
      continue;
    }
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      newDirs.push(relative(root, current).split(sep).join('/'));
      continue;
    }
    if (stat.isSymbolicLink()) throw new AgentToolError('Acesso a symlinks não é permitido pelas ferramentas do agente.');
    if (!stat.isDirectory()) throw new AgentToolError('O caminho do novo arquivo passa por algo que não é pasta.');
    existing = current;
  }
  if (newDirs.length > MAX_NEW_DIRS) throw new AgentToolError(`O arquivo pediria ${newDirs.length} pastas novas; o limite é ${MAX_NEW_DIRS}.`);
  if ((await realpath(existing)) !== existing) throw new AgentToolError('O caminho canônico está fora do workspace.');
  if (!newDirs.length) {
    try {
      await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: candidate, newDirs };
      throw error;
    }
    throw new AgentToolError('O arquivo já existe.');
  }
  return { path: candidate, newDirs };
}

export async function prepareWorkspaceWrite(rootDir: string, relativePath: unknown, content: unknown): Promise<PreparedWrite> {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || content.includes('\0')) {
    throw new AgentToolError('O conteúdo deve ser texto com no máximo 128 KiB.');
  }
  let path: string;
  try {
    path = await resolveWorkspaceFile(rootDir, relativePath);
  } catch (error) {
    if (!(error instanceof AgentToolError) || error.message !== 'O arquivo solicitado não existe.') throw error;
    const plan = await planNewWorkspaceFile(rootDir, relativePath);
    return {
      path: plan.path,
      relativePath: relative(await realpath(rootDir), plan.path).split(sep).join('/'),
      oldContent: '',
      newContent: content,
      expectedHash: '',
      create: true,
      ...(plan.newDirs.length ? { newDirs: plan.newDirs } : {}),
    };
  }
  if ((await lstat(path)).size > MAX_FILE_BYTES) throw new AgentToolError('O arquivo atual excede o limite de escrita de 128 KiB.');
  const oldBytes = await readFile(path);
  if (oldBytes.byteLength > MAX_FILE_BYTES || oldBytes.includes(0)) throw new AgentToolError('O arquivo atual não é um arquivo de texto editável.');
  return {
    path,
    relativePath: relative(await realpath(rootDir), path).split(sep).join('/'),
    oldContent: oldBytes.toString('utf8'),
    newContent: content,
    expectedHash: createHash('sha256').update(oldBytes).digest('hex'),
  };
}

export async function applyWorkspaceWrite(rootDir: string, write: PreparedWrite): Promise<void> {
  if (write.create) {
    // Revalida depois da aprovação: só cria as pastas aprovadas, uma a uma, sem seguir links.
    const plan = await planNewWorkspaceFile(rootDir, write.relativePath);
    if (plan.path !== write.path || plan.newDirs.some((d) => !(write.newDirs ?? []).includes(d))) {
      throw new AgentToolError('O caminho do arquivo mudou enquanto aguardava aprovação.');
    }
    const root = await realpath(rootDir);
    for (const dir of plan.newDirs) {
      const abs = resolve(root, ...dir.split('/'));
      try {
        await mkdir(abs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const st = await lstat(abs);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new AgentToolError('A pasta criada deixou de ser uma pasta comum.');
    }
    const target = plan.path;
    const created = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
    try {
      await created.writeFile(write.newContent, 'utf8');
    } finally {
      await created.close();
    }
    return;
  }
  const path = await resolveWorkspaceFile(rootDir, write.relativePath);
  if (path !== write.path) throw new AgentToolError('O caminho do arquivo mudou enquanto aguardava aprovação.');
  const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new AgentToolError('O destino deixou de ser um arquivo regular.');
    const current = await handle.readFile();
    const hash = createHash('sha256').update(current).digest('hex');
    if (hash !== write.expectedHash) throw new AgentToolError('O arquivo mudou enquanto aguardava aprovação; gere uma proposta atualizada.');
    await handle.truncate(0);
    const content = Buffer.from(write.newContent, 'utf8');
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.write(content, offset, content.length - offset, offset);
      if (result.bytesWritten === 0) throw new AgentToolError('Não foi possível concluir a escrita do arquivo.');
      offset += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

function commandArgs(rootDir: string, check: ApprovedCheck): string[][] {
  const nodeModules = resolve(rootDir, 'node_modules');
  const node = process.execPath;
  switch (check) {
    case 'typecheck':
      return [
        [resolve(nodeModules, 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'],
        [resolve(nodeModules, 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'server/tsconfig.json'],
      ];
    case 'test':
      return [[resolve(nodeModules, 'vitest', 'vitest.mjs'), 'run']];
    case 'build-client':
      return [[resolve(nodeModules, 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.ts']];
    case 'build-server':
      return [[resolve(rootDir, 'scripts', 'build-server.mjs')]];
  }
}

function runNode(rootDir: string, args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const [script, ...scriptArgs] = args;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: '/tmp',
      TMPDIR: '/tmp',
      TEMP: '/tmp',
      TMP: '/tmp',
      CI: '1',
      LANG: 'C.UTF-8',
    };
    execFile(
      process.execPath,
      [script, ...scriptArgs],
      {
        cwd: rootDir,
        env,
        windowsHide: true,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        signal,
        maxBuffer: MAX_COMMAND_OUTPUT,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = `${stdout}${stderr ? `\n${stderr}` : ''}`.slice(0, 16_000);
        if (error) {
          reject(new AgentToolError(`A verificação falhou ou excedeu 120 s (código ${error.code ?? 'indisponível'}).\n${out}`));
          return;
        }
        resolvePromise({ code: 0, stdout: String(stdout).slice(0, 16_000), stderr: String(stderr).slice(0, 16_000) });
      },
    );
  });
}

export async function runApprovedCheck(rootDir: string, check: unknown, signal: AbortSignal): Promise<string> {
  if (typeof check !== 'string' || !Object.hasOwn(APPROVED_CHECKS, check)) {
    throw new AgentToolError('Verificação não autorizada. Escolha uma opção da lista fixa.');
  }
  const selected = check as ApprovedCheck;
  const runs = commandArgs(rootDir, selected);
  const results: string[] = [];
  for (const args of runs) {
    if (signal.aborted) throw new AgentToolError('A execução foi cancelada.');
    const result = await runNode(rootDir, args, signal);
    results.push(result.stdout, result.stderr);
  }
  return results.filter(Boolean).join('\n').slice(0, 16_000) || 'Comando concluído sem saída.';
}

export function newApprovalId(): string {
  return randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------------------------
// Leitura em lote (somente leitura, com limites): listar e buscar sem o agente adivinhar caminhos
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.cache', '.turbo']);
const LIST_LIMIT = 300;
const SEARCH_MAX_FILES = 3_000;
const SEARCH_MAX_MATCHES = 60;

/** Caminhos (com '/') dentro do workspace, em largura, sem symlinks nem conteúdo protegido. */
async function* walkWorkspace(root: string, start: string, maxDepth: number): AsyncGenerator<{ rel: string; dir: boolean }> {
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: resolve(root, start), rel: start, depth: 0 }];
  while (queue.length) {
    const { abs, rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isProtectedPath(childRel.split('/'))) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        yield { rel: childRel, dir: true };
        if (depth + 1 < maxDepth) queue.push({ abs: resolve(abs, e.name), rel: childRel, depth: depth + 1 });
      } else if (e.isFile()) {
        yield { rel: childRel, dir: false };
      }
    }
  }
}

/** Valida a pasta inicial de uma listagem/busca ('' = raiz do workspace). */
async function startDir(rootDir: string, dir: unknown): Promise<{ root: string; start: string }> {
  const root = await realpath(rootDir);
  if (dir === undefined || dir === '' || dir === '.') return { root, start: '' };
  if (typeof dir !== 'string' || dir.includes('\0') || dir.includes('\\') || isAbsolute(dir)) throw new AgentToolError('A pasta deve ser um caminho relativo.');
  const parts = dir.replace(/\/+$/, '').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..') || isProtectedPath(parts)) throw new AgentToolError('A pasta é inválida ou protegida.');
  const abs = resolve(root, ...parts);
  if (!isWithin(root, abs)) throw new AgentToolError('A pasta está fora do workspace.');
  let current = root;
  for (const p of parts) {
    current = resolve(current, p);
    const st = await lstat(current).catch(() => undefined);
    if (!st) throw new AgentToolError('A pasta não existe.');
    if (st.isSymbolicLink() || !st.isDirectory()) throw new AgentToolError('O caminho não é uma pasta comum.');
  }
  return { root, start: parts.join('/') };
}

/** Lista arquivos e pastas (pastas terminam em '/'), até 300 entradas e 4 níveis. */
export async function listWorkspaceFiles(rootDir: string, dir?: unknown): Promise<string> {
  const { root, start } = await startDir(rootDir, dir);
  const out: string[] = [];
  let more = false;
  for await (const e of walkWorkspace(root, start, 4)) {
    if (out.length >= LIST_LIMIT) {
      more = true;
      break;
    }
    out.push(e.dir ? `${e.rel}/` : e.rel);
  }
  if (!out.length) return 'Nenhum arquivo visível nesta pasta.';
  return `${out.join('\n')}${more ? `\n[LISTA TRUNCADA em ${LIST_LIMIT} entradas; liste uma subpasta para ver mais.]` : ''}`;
}

/** Busca texto literal (sem diferenciar maiúsculas), até 60 ocorrências em até 3 000 arquivos de texto. */
export async function searchWorkspaceText(rootDir: string, query: unknown, dir?: unknown): Promise<string> {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) throw new AgentToolError('A busca precisa de 2 a 200 caracteres.');
  const needle = query.toLowerCase();
  const { root, start } = await startDir(rootDir, dir);
  const hits: string[] = [];
  let files = 0;
  for await (const e of walkWorkspace(root, start, 8)) {
    if (e.dir) continue;
    if (++files > SEARCH_MAX_FILES) break;
    const abs = resolve(root, ...e.rel.split('/'));
    const st = await lstat(abs).catch(() => undefined);
    if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const data = await readFile(abs).catch(() => undefined);
    if (!data || data.includes(0)) continue;
    const lines = data.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      hits.push(`${e.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      if (hits.length >= SEARCH_MAX_MATCHES) {
        return `${hits.join('\n')}\n[BUSCA TRUNCADA em ${SEARCH_MAX_MATCHES} ocorrências; refine o termo ou a pasta.]`;
      }
    }
  }
  const note = files > SEARCH_MAX_FILES ? `\n[Parou em ${SEARCH_MAX_FILES} arquivos; restrinja a pasta.]` : '';
  return hits.length ? `${hits.join('\n')}${note}` : `Nada encontrado para "${query}".${note}`;
}

// ---------------------------------------------------------------------------------------------
// Scripts do package.json de qualquer workspace (lista fixa de nomes; sempre com aprovação)
// ---------------------------------------------------------------------------------------------

export const PACKAGE_SCRIPTS = ['test', 'typecheck', 'lint', 'build'] as const;
export type PackageScript = (typeof PACKAGE_SCRIPTS)[number];

/** Scripts da lista fixa que este workspace tem no package.json. */
export async function availablePackageScripts(rootDir: string): Promise<PackageScript[]> {
  try {
    const pkg = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    return PACKAGE_SCRIPTS.filter((s) => typeof pkg.scripts?.[s] === 'string');
  } catch {
    return [];
  }
}

function npmCli(): string | undefined {
  const bin = dirname(process.execPath);
  for (const candidate of [resolve(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), resolve(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** `npm run <script>` sem shell, com o mesmo ambiente mínimo e o limite de 120 s das verificações fixas. */
export async function runPackageScript(rootDir: string, script: unknown, signal: AbortSignal): Promise<string> {
  if (typeof script !== 'string' || !(PACKAGE_SCRIPTS as readonly string[]).includes(script)) {
    throw new AgentToolError(`Script não autorizado. Use um destes: ${PACKAGE_SCRIPTS.join(', ')}.`);
  }
  if (!(await availablePackageScripts(rootDir)).includes(script as PackageScript)) throw new AgentToolError(`O package.json deste workspace não tem o script "${script}".`);
  const cli = npmCli();
  if (!cli) throw new AgentToolError('npm não encontrado junto do Node do Habblaud.');
  const result = await runNode(rootDir, [cli, 'run', script], signal);
  return [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 16_000) || 'Script concluído sem saída.';
}
