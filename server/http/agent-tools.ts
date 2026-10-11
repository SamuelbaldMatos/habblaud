import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
  if (
    parts.some((part) => !part || part === '.') ||
    parts.some((part) => ['.git', 'node_modules', '.env', '.claude', '.copilot'].includes(part.toLowerCase())) ||
    /^\.env/i.test(parts[parts.length - 1]) ||
    /^(?:docker-compose\.override\.ya?ml|.*\.(?:pem|key|p12|pfx))$/i.test(parts[parts.length - 1])
  ) {
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

export interface PreparedWrite {
  path: string;
  relativePath: string;
  oldContent: string;
  newContent: string;
  expectedHash: string;
}

export async function prepareWorkspaceWrite(rootDir: string, relativePath: unknown, content: unknown): Promise<PreparedWrite> {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || content.includes('\0')) {
    throw new AgentToolError('O conteúdo deve ser texto com no máximo 128 KiB.');
  }
  const path = await resolveWorkspaceFile(rootDir, relativePath);
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
