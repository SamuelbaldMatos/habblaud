import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface ProjectDoc {
  path: string; // caminho relativo com '/'
  head: string; // primeiros bytes do arquivo (≤ 2 KiB, sem cortar UTF-8)
}

export interface ProjectCard {
  workspace: string;
  fingerprint: string; // sha256 hex
  builtAt: number; // epoch ms
  files: string[]; // até maxFiles caminhos relativos com '/', ordenados
  totalFiles: number; // quantos arquivos encontrados no total
  truncated: boolean; // varredura parou em algum limite
  docs: ProjectDoc[]; // trechos dos arquivos de documentação
  packageJson?: {
    name?: string;
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
  };
  gitHead?: string; // HEAD resolvido
}

export interface ProjectContextOptions {
  cacheDir?: string;
  now?: () => number;
  maxFiles?: number; // padrão 400
  maxScan?: number; // padrão 20 000
}

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Arquivos de documentação verificados, nessa ordem. */
const DOC_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'PRODUCT.md',
  'docs/architecture.md',
] as const;

/** Pastas completamente ignoradas na varredura. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
]);

/** Padrões de arquivos protegidos (testados apenas no basename). */
const PROTECTED_FILE_RE =
  /^(?:\.env.*|.*\.(?:pem|key|p12|pfx)|docker-compose\.override\.ya?ml|id_rsa.*)$/i;

/** Máximo de bytes lidos de cada doc (2 KiB). */
const DOC_MAX_BYTES = 2048;

/** Limite máximo do render do cartão (12 000 chars). */
const RENDER_MAX_CHARS = 12_000;

// ─── Impressão digital barata ─────────────────────────────────────────────────

/**
 * Calcula sha256 usando apenas stat de arquivos-chave + entradas do primeiro
 * nível + HEAD do git. Nunca varre toda a árvore.
 */
export async function projectFingerprint(rootDir: string): Promise<string> {
  const hash = createHash('sha256');

  // 1. Stat dos arquivos-chave (ausente → "-")
  const keyFiles = [
    'package.json',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'PRODUCT.md',
    'docs/architecture.md',
  ];

  for (const rel of keyFiles) {
    try {
      const s = await stat(join(rootDir, rel));
      hash.update(`${rel}:${s.mtimeMs}:${s.size}\n`);
    } catch {
      hash.update(`${rel}:-\n`);
    }
  }

  // 2. Nomes das entradas do primeiro nível (ordenados)
  try {
    const entries = await readdir(rootDir);
    entries.sort();
    hash.update(entries.join('\n') + '\n');
  } catch {
    // pasta ilegível → pula
  }

  // 3. HEAD do git
  const gitHeadStr = await resolveGitHead(rootDir);
  hash.update(`gitHead:${gitHeadStr ?? '-'}\n`);

  return hash.digest('hex');
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/** Converte separadores de SO para '/' (paths de saída). */
function toSlash(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Sanitiza o id do workspace para usar como nome de arquivo. */
function sanitizeWorkspaceId(ws: string): string {
  return ws.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Resolve o HEAD do git.
 * .git pode ser um arquivo de worktree ("gitdir: ...") — nesse caso usa só o
 * conteúdo desse arquivo (sem seguir recursivamente).
 * "ref: refs/heads/x" → "x@<sha>" quando o arquivo da ref existir.
 * Outros casos → conteúdo bruto de HEAD.
 */
async function resolveGitHead(rootDir: string): Promise<string | undefined> {
  const gitPath = join(rootDir, '.git');

  let headContent: string;
  try {
    const raw = await readFile(gitPath, 'utf8');
    // .git é arquivo (worktree): conteúdo = "gitdir: /abs/path"
    // Retorna o conteúdo bruto, sem resolver mais nada
    return raw.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EISDIR') {
      return undefined;
    }
    // .git é pasta normal
  }

  try {
    headContent = (await readFile(join(gitPath, 'HEAD'), 'utf8')).trim();
  } catch {
    return undefined;
  }

  const refMatch = headContent.match(/^ref:\s*(refs\/heads\/.+)$/);
  if (!refMatch) return headContent;

  const refName = refMatch[1]; // "refs/heads/main"
  const branchName = refName.replace('refs/heads/', '');
  try {
    const sha = (await readFile(join(gitPath, refName), 'utf8')).trim();
    return `${branchName}@${sha}`;
  } catch {
    return branchName;
  }
}

/**
 * Lê o início de um arquivo respeitando o limite de bytes sem cortar
 * caracteres UTF-8 no meio.
 */
async function readDocHead(filePath: string): Promise<string> {
  let buf: Buffer;
  try {
    const full = await readFile(filePath);
    buf = full.length <= DOC_MAX_BYTES ? full : full.subarray(0, DOC_MAX_BYTES);
  } catch {
    return '';
  }

  // Remove bytes de continuação UTF-8 do final para não cortar no meio de um
  // caractere multibyte.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  // Se o byte em `end` é início de sequência multibyte mas não há bytes
  // suficientes após ele, remove-o também.
  if (end > 0) {
    const b = buf[end - 1]!;
    if ((b & 0xe0) === 0xc0) end--; // início de 2 bytes
    else if ((b & 0xf0) === 0xe0) end--; // início de 3 bytes
    else if ((b & 0xf8) === 0xf0) end--; // início de 4 bytes
  }

  return buf.subarray(0, end).toString('utf8');
}

/**
 * Lê e processa o package.json do rootDir.
 * Retorna undefined se o arquivo não existir ou for inválido.
 */
async function readPackageJson(rootDir: string): Promise<ProjectCard['packageJson']> {
  try {
    const raw = await readFile(join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts: Record<string, string> = {};
    if (pkg['scripts'] && typeof pkg['scripts'] === 'object') {
      for (const [k, v] of Object.entries(pkg['scripts'] as Record<string, unknown>)) {
        if (typeof v === 'string') scripts[k] = v;
      }
    }
    const depNames = (obj: unknown): string[] => {
      if (!obj || typeof obj !== 'object') return [];
      return Object.keys(obj as Record<string, unknown>);
    };
    return {
      name: typeof pkg['name'] === 'string' ? pkg['name'] : undefined,
      scripts,
      dependencies: depNames(pkg['dependencies']),
      devDependencies: depNames(pkg['devDependencies']),
    };
  } catch {
    return undefined;
  }
}

// ─── Varredura de arquivos ────────────────────────────────────────────────────

interface ScanResult {
  files: string[]; // caminhos relativos com '/'
  totalFiles: number;
  truncated: boolean;
}

/**
 * Varre a árvore de forma iterativa (BFS), sem seguir symlinks, respeitando
 * os limites de profundidade e de entradas.
 */
async function scanWorkspace(
  rootDir: string,
  maxFiles: number,
  maxScan: number,
): Promise<ScanResult> {
  const allFiles: string[] = [];
  let scanned = 0;
  let truncated = false;

  // Fila: [dirAbsoluto, profundidade]
  const queue: Array<[string, number]> = [[rootDir, 0]];

  outer: while (queue.length > 0) {
    const [dir, depth] = queue.shift()!;
    if (depth > 6) continue;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // pasta ilegível → ignora
    }

    for (const entry of entries) {
      if (scanned >= maxScan) {
        truncated = true;
        break outer;
      }
      scanned++;

      const name = entry.name;

      // Ignora symlinks
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        // Ignora pastas bloqueadas e que começam com '.'
        if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
        if (depth < 6) queue.push([join(dir, name), depth + 1]);
        continue;
      }

      if (!entry.isFile()) continue;

      // Ignora arquivos protegidos
      if (PROTECTED_FILE_RE.test(name)) continue;

      const relPath = toSlash(relative(rootDir, join(dir, name)));
      allFiles.push(relPath);
    }
  }

  allFiles.sort();
  const totalFiles = allFiles.length;
  const files = allFiles.slice(0, maxFiles);

  return { files, totalFiles, truncated };
}

// ─── Montagem do cartão ───────────────────────────────────────────────────────

async function buildCard(
  workspace: string,
  rootDir: string,
  fingerprint: string,
  now: () => number,
  maxFiles: number,
  maxScan: number,
): Promise<ProjectCard> {
  // Varredura de arquivos
  const { files, totalFiles, truncated } = await scanWorkspace(rootDir, maxFiles, maxScan);

  // Docs
  const docs: ProjectDoc[] = [];
  for (const docRel of DOC_FILES) {
    const head = await readDocHead(join(rootDir, docRel));
    if (head) docs.push({ path: toSlash(docRel), head });
  }

  // package.json
  const packageJson = await readPackageJson(rootDir);

  // gitHead
  const gitHead = await resolveGitHead(rootDir);

  return {
    workspace,
    fingerprint,
    builtAt: now(),
    files,
    totalFiles,
    truncated,
    docs,
    packageJson,
    gitHead,
  };
}

// ─── Cache persistente ────────────────────────────────────────────────────────

async function loadPersisted(cacheDir: string, wsKey: string): Promise<ProjectCard | null> {
  try {
    const raw = await readFile(join(cacheDir, `${wsKey}.json`), 'utf8');
    return JSON.parse(raw) as ProjectCard;
  } catch {
    return null;
  }
}

async function savePersisted(cacheDir: string, wsKey: string, card: ProjectCard): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${wsKey}.json`), JSON.stringify(card), 'utf8');
  } catch {
    // salvar é best-effort
  }
}

// ─── Classe principal ─────────────────────────────────────────────────────────

export class ProjectContextCache {
  private readonly _opts: Required<Omit<ProjectContextOptions, 'cacheDir'>> & {
    cacheDir?: string;
  };

  /** Cache em memória: workspace → ProjectCard */
  private readonly _mem = new Map<string, ProjectCard>();

  constructor(opts?: ProjectContextOptions) {
    this._opts = {
      cacheDir: opts?.cacheDir,
      now: opts?.now ?? (() => Date.now()),
      maxFiles: opts?.maxFiles ?? 400,
      maxScan: opts?.maxScan ?? 20_000,
    };
  }

  /**
   * Devolve o cartão do workspace.
   * cached=true quando a impressão digital não mudou (nenhuma varredura feita).
   */
  async get(
    workspace: string,
    rootDir: string,
    opts?: { force?: boolean },
  ): Promise<{ card: ProjectCard; cached: boolean }> {
    const wsKey = sanitizeWorkspaceId(workspace);
    const { cacheDir, now, maxFiles, maxScan } = this._opts;

    // Calcula impressão digital (operação barata)
    const fingerprint = await projectFingerprint(rootDir);

    // Verifica cache em memória
    if (!opts?.force) {
      const memCard = this._mem.get(workspace);
      if (memCard && memCard.fingerprint === fingerprint) {
        return { card: memCard, cached: true };
      }

      // Verifica cache persistente
      if (cacheDir) {
        const persisted = await loadPersisted(cacheDir, wsKey);
        if (persisted && persisted.fingerprint === fingerprint) {
          this._mem.set(workspace, persisted);
          return { card: persisted, cached: true };
        }
      }
    }

    // Monta o cartão
    const card = await buildCard(workspace, rootDir, fingerprint, now, maxFiles, maxScan);

    // Armazena nos caches
    this._mem.set(workspace, card);
    if (cacheDir) {
      await savePersisted(cacheDir, wsKey, card);
    }

    return { card, cached: false };
  }

  /**
   * Renderiza o cartão para o system prompt.
   * Máximo de 12 000 caracteres, começando por
   * "Cartão do projeto <workspace> (cache verificado em <ISO>)".
   */
  render(card: ProjectCard): string {
    const verifiedAt = new Date(card.builtAt).toISOString();
    const lines: string[] = [
      `Cartão do projeto ${card.workspace} (cache verificado em ${verifiedAt})`,
      `Fingerprint: ${card.fingerprint}`,
      '',
    ];

    // package.json
    if (card.packageJson) {
      const pj = card.packageJson;
      if (pj.name) lines.push(`Projeto: ${pj.name}`);
      const scriptNames = Object.keys(pj.scripts);
      if (scriptNames.length > 0) lines.push(`Scripts: ${scriptNames.join(', ')}`);
      if (pj.dependencies.length > 0) lines.push(`Deps: ${pj.dependencies.join(', ')}`);
      if (pj.devDependencies.length > 0) lines.push(`DevDeps: ${pj.devDependencies.join(', ')}`);
      lines.push('');
    }

    // gitHead
    if (card.gitHead) {
      lines.push(`Git HEAD: ${card.gitHead}`);
      lines.push('');
    }

    // arquivos
    lines.push(
      `Arquivos: ${card.files.length} exibidos / ${card.totalFiles} total${card.truncated ? ' (truncado)' : ''}`,
    );
    lines.push(card.files.join('\n'));
    lines.push('');

    // docs
    for (const doc of card.docs) {
      lines.push(`--- ${doc.path} ---`);
      lines.push(doc.head);
      lines.push('');
    }

    const full = lines.join('\n');

    // Garante limite sem cortar caractere UTF-8
    if (full.length <= RENDER_MAX_CHARS) return full;

    // Corta respeitando fronteiras de caracteres (string JS já é UTF-16, mas
    // codePoints podem ser surrogate pairs — usa spread para ser seguro)
    const chars = [...full];
    if (chars.length <= RENDER_MAX_CHARS) return full;
    return chars.slice(0, RENDER_MAX_CHARS).join('');
  }
}
