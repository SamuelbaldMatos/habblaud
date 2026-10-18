// Armazenamento persistente de conversas do Estúdio e handler HTTP das threads.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Campos obrigatórios gravados por conversa. */
interface ThreadDoc {
  id: string;
  title: string;
  workspace: string;
  manager: string;
  updatedAt: string;
  messages: unknown[];
}

/** Projeção mínima retornada na listagem. */
interface ThreadSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;   // 2 MB por conversa
const MAX_THREADS = 200;                   // máximo de conversas no disco
const MAX_MESSAGES = 400;                  // máximo de itens em messages[]
const FILE_MODE = 0o600;                   // somente o processo pode ler

// ─── ThreadStore ──────────────────────────────────────────────────────────────

export class ThreadStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Garante que o diretório existe antes de qualquer operação. */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Caminho do arquivo de uma conversa. */
  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Valida e normaliza o documento recebido do cliente. */
  private validate(raw: unknown): ThreadDoc {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RangeError('Corpo deve ser um objeto JSON.');
    }
    const data = raw as Json;

    const id = typeof data.id === 'string' ? data.id : '';
    const title = typeof data.title === 'string' ? data.title.slice(0, 200) : 'Sem título';
    const workspace = typeof data.workspace === 'string' ? data.workspace.slice(0, 200) : '';
    const manager = typeof data.manager === 'string' ? data.manager.slice(0, 80) : '';
    const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString();

    if (!Array.isArray(data.messages)) {
      throw new RangeError('O campo messages deve ser um array.');
    }
    const messages = (data.messages as unknown[]).slice(-MAX_MESSAGES);

    return { id, title, workspace, manager, updatedAt, messages };
  }

  /** Apaga as conversas mais antigas quando o limite de MAX_THREADS é ultrapassado. */
  private async enforceLimit(): Promise<void> {
    const files = await this.listFiles();
    if (files.length <= MAX_THREADS) return;

    // Ordena por mtime ascendente (mais antigas primeiro) e remove o excesso.
    const withMtime = await Promise.all(
      files.map(async (name) => {
        const s = await stat(join(this.dir, name)).catch(() => null);
        return { name, mtime: s?.mtimeMs ?? 0 };
      }),
    );
    withMtime.sort((a, b) => a.mtime - b.mtime);
    const toDelete = withMtime.slice(0, withMtime.length - MAX_THREADS);
    await Promise.all(toDelete.map(({ name }) => rm(join(this.dir, name), { force: true })));
  }

  /** Lista todos os arquivos .json do diretório. */
  private async listFiles(): Promise<string[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir);
    return entries.filter((f) => f.endsWith('.json'));
  }

  /** Grava uma conversa em disco com escrita atômica (tmp + rename). */
  async put(id: string, doc: ThreadDoc): Promise<void> {
    await this.ensureDir();
    const content = JSON.stringify({ ...doc, id });
    if (Buffer.byteLength(content) > MAX_BODY_BYTES) {
      throw new RangeError('Documento excede o limite de 2 MB.');
    }
    const tmp = join(this.dir, `${id}.tmp`);
    const dest = this.filePath(id);
    await writeFile(tmp, content, { mode: FILE_MODE });
    await rename(tmp, dest);
    await this.enforceLimit();
  }

  /** Lê uma conversa pelo id; retorna undefined se não existir. */
  async get(id: string): Promise<ThreadDoc | undefined> {
    await this.ensureDir();
    try {
      const raw = await readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as ThreadDoc;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** Apaga uma conversa; silencioso se não existir. */
  async delete(id: string): Promise<boolean> {
    await this.ensureDir();
    try {
      await rm(this.filePath(id), { force: false });
      return true;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Lista todas as conversas como resumos, ordenadas por updatedAt desc. */
  async list(): Promise<ThreadSummary[]> {
    const files = await this.listFiles();
    const docs = await Promise.all(
      files.map(async (name) => {
        try {
          const raw = await readFile(join(this.dir, name), 'utf8');
          return JSON.parse(raw) as ThreadDoc;
        } catch {
          return null;
        }
      }),
    );
    return (docs.filter(Boolean) as ThreadDoc[])
      .map(({ id, title, workspace, updatedAt }) => ({ id, title, workspace, updatedAt }))
      .sort((a, b) => {
        const ta = new Date(a.updatedAt).getTime();
        const tb = new Date(b.updatedAt).getTime();
        return tb - ta;
      });
  }

  /** Valida e persiste o documento recebido (extrai e limita messages). */
  async save(id: string, raw: unknown): Promise<ThreadDoc> {
    const doc = this.validate(raw);
    // O id do path tem precedência sobre o do corpo.
    doc.id = id;
    await this.put(id, doc);
    return doc;
  }
}

// ─── Utilitários HTTP ────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Lê o corpo da requisição com limite de bytes. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Corpo excede o limite permitido.'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

// ─── Handler HTTP ─────────────────────────────────────────────────────────────

interface HandleOptions {
  store: ThreadStore;
  local: (req: IncomingMessage) => boolean;
}

/**
 * Rota: /api/omniroute/threads e /api/omniroute/threads/:id
 * Retorna false se o path não corresponde a nenhuma rota tratada aqui.
 */
export function handleThreadsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  opts: HandleOptions,
): boolean {
  const { store, local } = opts;

  // Verifica se o path pertence a este handler.
  const base = '/api/omniroute/threads';
  if (!path.startsWith(base)) return false;
  const rest = path.slice(base.length);        // '' | '/' | '/:id'
  if (rest !== '' && rest !== '/' && !rest.startsWith('/')) return false;

  // Extrai o id (segmento após a barra, sem query string).
  const rawId = rest.startsWith('/') ? rest.slice(1).split('?')[0] : '';
  const hasId = rawId.length > 0;

  // Somente conexões locais têm acesso.
  if (!local(req)) {
    sendError(res, 403, 'Restrito a conexões locais.');
    return true;
  }

  const method = req.method ?? 'GET';

  // GET /api/omniroute/threads — lista de conversas
  if (!hasId && method === 'GET') {
    store
      .list()
      .then((threads) => sendJson(res, 200, { threads }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Erro interno.';
        sendError(res, 500, msg);
      });
    return true;
  }

  // Rotas com :id exigem id válido.
  if (hasId && !ID_RE.test(rawId)) {
    sendError(res, 400, 'ID de conversa inválido.');
    return true;
  }

  // GET /api/omniroute/threads/:id
  if (hasId && method === 'GET') {
    store
      .get(rawId)
      .then((doc) => {
        if (!doc) { sendError(res, 404, 'Conversa não encontrada.'); return; }
        sendJson(res, 200, doc);
      })
      .catch((err: unknown) => {
        sendError(res, 500, err instanceof Error ? err.message : 'Erro interno.');
      });
    return true;
  }

  // PUT /api/omniroute/threads/:id
  if (hasId && method === 'PUT') {
    readBody(req, MAX_BODY_BYTES)
      .then((buf) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(buf.toString('utf8'));
        } catch {
          sendError(res, 400, 'JSON inválido no corpo da requisição.');
          return;
        }
        return store.save(rawId, parsed).then((doc) => {
          sendJson(res, 200, doc);
        });
      })
      .catch((err: unknown) => {
        if (isNodeError(err) && err.code === 'TOO_LARGE') {
          sendError(res, 413, 'Corpo excede o limite de 2 MB.');
          return;
        }
        if (err instanceof RangeError) {
          if (err.message.includes('2 MB')) {
            sendError(res, 413, err.message);
          } else {
            sendError(res, 400, err.message);
          }
          return;
        }
        sendError(res, 500, err instanceof Error ? err.message : 'Erro interno.');
      });
    return true;
  }

  // DELETE /api/omniroute/threads/:id
  if (hasId && method === 'DELETE') {
    store
      .delete(rawId)
      .then((found) => {
        if (!found) { sendError(res, 404, 'Conversa não encontrada.'); return; }
        sendJson(res, 200, { ok: true });
      })
      .catch((err: unknown) => {
        sendError(res, 500, err instanceof Error ? err.message : 'Erro interno.');
      });
    return true;
  }

  // Método não suportado para o path reconhecido.
  sendError(res, 405, 'Método não permitido.');
  return true;
}
