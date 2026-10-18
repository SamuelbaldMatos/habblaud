// Testes do ThreadStore e do handler HTTP de threads.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ThreadStore, handleThreadsRoute } from './threads';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Cria uma pasta temporária única por suite. */
async function makeTmp(): Promise<string> {
  const dir = join(tmpdir(), `threads-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Documento mínimo válido para testes. */
function makeDoc(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Conversa ${id}`,
    workspace: 'proj-a',
    manager: 'orquestrador',
    updatedAt: new Date().toISOString(),
    messages: [{ id: 'msg-1', role: 'user', content: 'Olá' }],
    ...overrides,
  };
}

/** Simula req/res HTTP para o handler. */
interface FakeResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function fakeHttp(
  method: string,
  path: string,
  bodyData: unknown,
  isLocal = true,
): { req: IncomingMessage; res: ServerResponse; result: Promise<FakeResponse> } {
  const chunks: string[] = [];
  let resolveResult!: (v: FakeResponse) => void;
  const result = new Promise<FakeResponse>((r) => { resolveResult = r; });
  const capturedHeaders: Record<string, string> = {};
  let capturedStatus = 200;

  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      capturedStatus = status;
      Object.assign(capturedHeaders, headers);
    },
    write(chunk: string) { chunks.push(chunk); },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      resolveResult({ status: capturedStatus, body: chunks.join(''), headers: capturedHeaders });
    },
  } as unknown as ServerResponse;

  const bodyStr = bodyData !== undefined ? JSON.stringify(bodyData) : '';
  const bodyBuf = Buffer.from(bodyStr, 'utf8');

  // Simula IncomingMessage com eventos.
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const req = {
    method,
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
    destroy() { /* noop */ },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;

  // Emite os eventos de forma assíncrona para que o handler registre os listeners.
  setTimeout(() => {
    if (bodyStr) {
      for (const cb of listeners['data'] ?? []) cb(bodyBuf);
    }
    for (const cb of listeners['end'] ?? []) cb();
  }, 0);

  const localFn = (): boolean => isLocal;

  return { req, res, result };
}

// ─── ThreadStore ──────────────────────────────────────────────────────────────

describe('ThreadStore', () => {
  let dir: string;
  let store: ThreadStore;

  beforeEach(async () => {
    dir = await makeTmp();
    store = new ThreadStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('grava e lê uma conversa', async () => {
    const doc = makeDoc('abc-123');
    await store.save('abc-123', doc);
    const loaded = await store.get('abc-123');
    expect(loaded?.id).toBe('abc-123');
    expect(loaded?.title).toBe('Conversa abc-123');
    expect(loaded?.messages).toHaveLength(1);
  });

  it('retorna undefined para id inexistente', async () => {
    const result = await store.get('nao-existe');
    expect(result).toBeUndefined();
  });

  it('lista conversas ordenadas por updatedAt desc', async () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    await store.save('id-old', makeDoc('id-old', { updatedAt: older }));
    await store.save('id-new', makeDoc('id-new', { updatedAt: newer }));
    const list = await store.list();
    expect(list[0]?.id).toBe('id-new');
    expect(list[1]?.id).toBe('id-old');
    // Listagem retorna apenas campos resumidos
    expect(Object.keys(list[0] ?? {})).toEqual(
      expect.arrayContaining(['id', 'title', 'workspace', 'updatedAt']),
    );
    expect(list[0]).not.toHaveProperty('messages');
  });

  it('apaga uma conversa existente e retorna false para inexistente', async () => {
    await store.save('del-me', makeDoc('del-me'));
    const found = await store.delete('del-me');
    expect(found).toBe(true);
    const notFound = await store.delete('del-me');
    expect(notFound).toBe(false);
  });

  it('rejeita id inválido no save (validação só do campo; id do path sobrescreve)', async () => {
    // id do path é o que vale — o campo no corpo é sobrescrito
    const doc = makeDoc('qualquer', { id: '!inválido!' });
    await expect(store.save('id-valido', doc)).resolves.not.toThrow();
    const loaded = await store.get('id-valido');
    expect(loaded?.id).toBe('id-valido');
  });

  it('rejeita messages que não é array', async () => {
    const doc = { ...makeDoc('x'), messages: 'não é array' };
    await expect(store.save('x', doc)).rejects.toThrow('messages deve ser um array');
  });

  it('limita messages a 400 itens', async () => {
    const messages = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x' }));
    await store.save('limite', makeDoc('limite', { messages }));
    const loaded = await store.get('limite');
    expect(loaded?.messages).toHaveLength(400);
  });

  it('apaga as mais antigas ao passar de 200 conversas', async () => {
    // Grava 201 conversas com timestamps crescentes
    for (let i = 0; i < 201; i++) {
      const updatedAt = new Date(Date.now() - (201 - i) * 1000).toISOString();
      await store.save(`conv-${String(i).padStart(3, '0')}`, makeDoc(`conv-${String(i).padStart(3, '0')}`, { updatedAt }));
    }
    const list = await store.list();
    expect(list.length).toBe(200);
    // A mais antiga (conv-000) deve ter sido apagada
    expect(list.find((t) => t.id === 'conv-000')).toBeUndefined();
    // A mais nova deve estar presente
    expect(list.find((t) => t.id === 'conv-200')).toBeDefined();
  });

  it('rejeita corpo superior a 2 MB', async () => {
    // Cria um conteúdo que, serializado, ultrapasse 2 MB
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const doc = makeDoc('big', { messages: [{ id: 'm1', role: 'user', content: big }] });
    await expect(store.save('big', doc)).rejects.toThrow('2 MB');
  });
});

// ─── handleThreadsRoute ───────────────────────────────────────────────────────

describe('handleThreadsRoute', () => {
  let dir: string;
  let store: ThreadStore;

  beforeEach(async () => {
    dir = await makeTmp();
    store = new ThreadStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function handle(method: string, path: string, body?: unknown, isLocal = true): Promise<FakeResponse> {
    const { req, res, result } = fakeHttp(method, path, body, isLocal);
    const handled = handleThreadsRoute(req, res, path, { store, local: () => isLocal });
    if (!handled) {
      // Retorna 404 para indicar que o handler não reconheceu o path.
      (res as unknown as { writeHead: (s: number) => void; end: () => void }).writeHead(404);
      (res as unknown as { end: () => void }).end();
    }
    return result;
  }

  it('retorna false para paths fora do escopo', () => {
    const { req, res } = fakeHttp('GET', '/api/omniroute/jobs', undefined);
    const handled = handleThreadsRoute(req, res, '/api/omniroute/jobs', {
      store,
      local: () => true,
    });
    expect(handled).toBe(false);
  });

  it('GET /threads lista conversas', async () => {
    await store.save('t1', makeDoc('t1'));
    const r = await handle('GET', '/api/omniroute/threads');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { threads: { id: string }[] };
    expect(body.threads.some((t) => t.id === 't1')).toBe(true);
  });

  it('GET /threads/:id retorna a conversa', async () => {
    await store.save('t2', makeDoc('t2'));
    const r = await handle('GET', '/api/omniroute/threads/t2');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { id: string };
    expect(body.id).toBe('t2');
  });

  it('GET /threads/:id retorna 404 se não existir', async () => {
    const r = await handle('GET', '/api/omniroute/threads/nao-existe');
    expect(r.status).toBe(404);
  });

  it('PUT /threads/:id cria ou atualiza', async () => {
    const r = await handle('PUT', '/api/omniroute/threads/t3', makeDoc('t3'));
    expect(r.status).toBe(200);
    const loaded = await store.get('t3');
    expect(loaded?.id).toBe('t3');
  });

  it('PUT retorna 413 para corpo grande', async () => {
    // Monta corpo manualmente acima de 2 MB para o readBody rejeitar.
    const huge = { ...makeDoc('big'), messages: [{ content: 'x'.repeat(2 * 1024 * 1024 + 100) }] };

    // Sobrepomos o readBody simulando erro TOO_LARGE via destroy
    const chunks: string[] = [];
    let resolveResult!: (v: FakeResponse) => void;
    const result = new Promise<FakeResponse>((r) => { resolveResult = r; });
    const capturedHeaders: Record<string, string> = {};
    let capturedStatus = 200;

    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        capturedStatus = status;
        Object.assign(capturedHeaders, headers);
      },
      end(chunk?: string) {
        if (chunk) chunks.push(chunk);
        resolveResult({ status: capturedStatus, body: chunks.join(''), headers: capturedHeaders });
      },
    } as unknown as ServerResponse;

    const bodyStr = JSON.stringify(huge);
    const bodyBuf = Buffer.from(bodyStr, 'utf8');

    let dataListeners: ((...args: unknown[]) => void)[] = [];
    let errorListeners: ((...args: unknown[]) => void)[] = [];
    let destroyed = false;

    const req = {
      method: 'PUT',
      socket: { remoteAddress: '127.0.0.1' },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'data') dataListeners.push(cb);
        if (event === 'error') errorListeners.push(cb);
        return req;
      },
      destroy() { destroyed = true; },
    } as unknown as IncomingMessage;

    handleThreadsRoute(req, res, '/api/omniroute/threads/big', { store, local: () => true });

    // Envia o buffer em partes, cada uma de 512 KB, para forçar estouro
    setTimeout(() => {
      const chunkSize = 512 * 1024;
      let offset = 0;
      while (offset < bodyBuf.length) {
        const part = bodyBuf.slice(offset, offset + chunkSize);
        for (const cb of dataListeners) cb(part);
        if (destroyed) break;
        offset += chunkSize;
      }
      if (!destroyed) {
        for (const cb of (req as unknown as { _endListeners?: ((...args: unknown[]) => void)[] })._endListeners ?? []) cb();
      }
      // Emite erro TOO_LARGE simulando o destroy interno
      const err = Object.assign(new Error('Corpo excede o limite permitido.'), { code: 'TOO_LARGE' });
      for (const cb of errorListeners) cb(err);
    }, 0);

    const r = await result;
    expect(r.status).toBe(413);
  });

  it('DELETE /threads/:id apaga a conversa', async () => {
    await store.save('t4', makeDoc('t4'));
    const r = await handle('DELETE', '/api/omniroute/threads/t4');
    expect(r.status).toBe(200);
    const loaded = await store.get('t4');
    expect(loaded).toBeUndefined();
  });

  it('DELETE /threads/:id retorna 404 se não existir', async () => {
    const r = await handle('DELETE', '/api/omniroute/threads/fantasma');
    expect(r.status).toBe(404);
  });

  it('id inválido → 400', async () => {
    const r = await handle('GET', '/api/omniroute/threads/../../etc');
    expect(r.status).toBe(400);
  });

  it('não-local → 403', async () => {
    const r = await handle('GET', '/api/omniroute/threads', undefined, false);
    expect(r.status).toBe(403);
  });

  it('PUT com JSON inválido → 400', async () => {
    const chunks: string[] = [];
    let resolveResult!: (v: FakeResponse) => void;
    const result = new Promise<FakeResponse>((r) => { resolveResult = r; });
    let capturedStatus = 200;
    const res = {
      writeHead(s: number) { capturedStatus = s; },
      end(c?: string) { if (c) chunks.push(c); resolveResult({ status: capturedStatus, body: chunks.join(''), headers: {} }); },
    } as unknown as ServerResponse;

    const dataListeners: ((...args: unknown[]) => void)[] = [];
    const req = {
      method: 'PUT',
      socket: { remoteAddress: '127.0.0.1' },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'data') dataListeners.push(cb);
        if (event === 'end') setTimeout(() => cb(), 0);
        return req;
      },
      destroy() { /* noop */ },
    } as unknown as IncomingMessage;

    handleThreadsRoute(req, res, '/api/omniroute/threads/t5', { store, local: () => true });
    setTimeout(() => { for (const cb of dataListeners) cb(Buffer.from('{não é json', 'utf8')); }, 0);

    const r = await result;
    expect(r.status).toBe(400);
  });
});
