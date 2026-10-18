import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMemory } from './agent-memory';
import {
  AgentRuntime,
  type AgentModel,
  type AgentModelReply,
  type AgentStreamEvent,
  stripPlaceholder,
} from './agent-runtime';

const temporaryDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-runtime-v2-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function waitForEvent(events: AgentStreamEvent[], type: AgentStreamEvent['type']): Promise<AgentStreamEvent> {
  const existing = events.find((event) => event.type === type);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timeout esperando evento ${type}`));
    }, 3000);
    const poll = setInterval(() => {
      const event = events.find((candidate) => candidate.type === type);
      if (!event) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(event);
    }, 5);
  });
}

function waitForDone(events: AgentStreamEvent[]): Promise<void> {
  return waitForEvent(events, 'done').then(() => undefined);
}

function finalReply(): AgentModelReply {
  return { content: [{ type: 'text', text: 'Concluído.' }] };
}

function toolReply(name: string, input: unknown): AgentModelReply {
  return { content: [{ type: 'tool_use', id: `chamada-${name}`, name, input }] };
}

describe('runtime multiagente: reanexação e ferramentas', () => {
  it('reanexa durante e depois da tarefa, sem repetir eventos anteriores ao cursor', async () => {
    const rootDir = workspace();
    let release: (() => void) | undefined;
    const complete: AgentModel = vi.fn(() => new Promise<AgentModelReply>((resolve) => {
      release = () => resolve(finalReply());
    }));
    const runtime = new AgentRuntime({ rootDir, complete });
    const id = runtime.start({ message: 'Primeira linha\nsegunda linha' });

    const events: AgentStreamEvent[] = [];
    const off = runtime.subscribe(id, 0, (event) => events.push(event));
    expect(off).toBeTypeOf('function');
    expect(events[0]).toMatchObject({ type: 'job', jobId: id, seq: 1 });

    const later: AgentStreamEvent[] = [];
    const after = events[events.length - 1].seq!;
    const offLater = runtime.subscribe(id, after, (event) => later.push(event));
    expect(offLater).toBeTypeOf('function');
    // O modelo é chamado um microtask depois do start.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    await waitForDone(events);

    expect(events.at(-1)?.type).toBe('done');
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((event) => event.seq! > after)).toBe(true);

    const replay: AgentStreamEvent[] = [];
    const offReplay = runtime.subscribe(id, after, (event) => replay.push(event));
    expect(offReplay).toBeTypeOf('function');
    expect(replay).toEqual(later);
    expect(replay.at(-1)?.type).toBe('done');
    expect(runtime.list()).toContainEqual(expect.objectContaining({
      id,
      status: 'done',
      title: 'Primeira linha',
    }));
    off?.();
    offLater?.();
    offReplay?.();
  });

  it('fechar a assinatura não cancela a tarefa', async () => {
    const rootDir = workspace();
    let release: (() => void) | undefined;
    const complete: AgentModel = vi.fn(() => new Promise<AgentModelReply>((resolve) => {
      release = () => resolve(finalReply());
    }));
    const runtime = new AgentRuntime({ rootDir, complete });
    const events: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'Continuar' });
    const off = runtime.subscribe(id, 0, (event) => events.push(event));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    off?.();
    release!();

    const replay: AgentStreamEvent[] = [];
    // A tarefa continua sem ouvintes; a assinatura posterior recupera o resultado.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Timeout esperando conclusão')), 3000);
      const poll = setInterval(() => {
        if (runtime.list().find((job) => job.id === id)?.status !== 'done') return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }, 5);
    });
    runtime.subscribe(id, 0, (event) => replay.push(event));
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(replay.at(-1)?.type).toBe('done');
    expect(runtime.list().find((job) => job.id === id)?.status).toBe('done');
  });

  it('usa gerente-jarvis quando o orquestrador falha com erro comum', async () => {
    const rootDir = workspace();
    const complete: AgentModel = vi.fn(async (request) => {
      if (request.combo === 'orquestrador') throw new Error('provedor indisponível');
      return finalReply();
    });
    const runtime = new AgentRuntime({ rootDir, complete });
    const events: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'Failover' }, (event) => events.push(event));

    await waitForDone(events);

    expect(vi.mocked(complete).mock.calls.map(([request]) => request.combo)).toEqual([
      'orquestrador',
      'gerente-jarvis',
    ]);
    expect(events.some((event) => event.type === 'activity'
      && event.activity?.includes('seguindo com gerente-jarvis'))).toBe(true);
    expect(runtime.list().find((job) => job.id === id)?.status).toBe('done');
  });

  it('não faz failover após AbortError', async () => {
    const rootDir = workspace();
    const complete: AgentModel = vi.fn(async () => {
      const error = new Error('interrompido');
      error.name = 'AbortError';
      throw error;
    });
    const runtime = new AgentRuntime({ rootDir, complete });
    const events: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'AbortError' }, (event) => events.push(event));

    await waitForDone(events);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.activity?.includes('seguindo com'))).toBe(false);
    expect(runtime.list().find((job) => job.id === id)?.status).toBe('error');
  });

  it('não faz failover quando a tarefa é cancelada', async () => {
    const rootDir = workspace();
    const complete: AgentModel = vi.fn((request) => new Promise<AgentModelReply>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('cancelado')), { once: true });
    }));
    const runtime = new AgentRuntime({ rootDir, complete });
    const events: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'Cancelar' }, (event) => events.push(event));

    // Cancela com a chamada ao modelo em andamento: o erro do abort não pode virar failover.
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(runtime.cancel(id)).toBe(true);
    await waitForDone(events);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.activity?.includes('seguindo com'))).toBe(false);
    expect(runtime.list().find((job) => job.id === id)?.status).toBe('cancelled');
  });

  it('cria arquivo novo e as pastas que faltam só depois da aprovação; recusa pasta protegida e mais de 4 pastas', async () => {
    const rootDir = workspace();
    const complete: AgentModel = vi.fn(async () => {
      if (vi.mocked(complete).mock.calls.length === 1) {
        return {
          content: [
            { type: 'tool_use', id: 'funda', name: 'propose_file_write', input: { path: 'a/b/c/d/e/arquivo.txt', content: 'não criar' } },
            { type: 'tool_use', id: 'protegida', name: 'propose_file_write', input: { path: 'node_modules/pacote/x.txt', content: 'não criar' } },
            { type: 'tool_use', id: 'valida', name: 'propose_file_write', input: { path: 'docs/novo/arquivo.md', content: 'conteúdo aprovado' } },
          ],
        };
      }
      return finalReply();
    });
    const runtime = new AgentRuntime({ rootDir, complete });
    const events: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'Criar arquivo' }, (event) => events.push(event));
    const approval = await waitForEvent(events, 'approval');

    expect(approval.approval).toMatchObject({ kind: 'write', path: 'docs/novo/arquivo.md', newContent: 'conteúdo aprovado' });
    expect(approval.approval?.summary).toBe('Criar o arquivo docs/novo/arquivo.md (cria a pasta docs, docs/novo)');
    // Nada é criado antes da aprovação.
    expect(existsSync(join(rootDir, 'docs'))).toBe(false);
    const failures = events.filter((e) => e.type === 'tool_result' && e.result?.ok === false);
    expect(failures).toHaveLength(2);
    expect(runtime.approve(id, approval.approval!.id, 'approve')).toBe(true);
    await waitForDone(events);

    expect(readFileSync(join(rootDir, 'docs/novo/arquivo.md'), 'utf8')).toBe('conteúdo aprovado');
    expect(existsSync(join(rootDir, 'a'))).toBe(false);
    expect(existsSync(join(rootDir, 'node_modules'))).toBe(false);
    expect(runtime.list().find((job) => job.id === id)?.status).toBe('done');
  });

  it('lista e busca arquivos do workspace sem expor pastas protegidas', async () => {
    const rootDir = workspace();
    writeFileSync(join(rootDir, 'visivel.txt'), 'marcador-publico\n');
    writeFileSync(join(rootDir, '.env'), 'marcador-publico\n');
    for (const hidden of ['node_modules', '.git']) {
      mkdirSync(join(rootDir, hidden));
      writeFileSync(join(rootDir, hidden, 'segredo.txt'), 'marcador-publico\n');
    }
    const complete: AgentModel = vi.fn(async () => {
      if (vi.mocked(complete).mock.calls.length === 1) {
        return {
          content: [
            { type: 'tool_use', id: 'lista', name: 'list_files', input: {} },
            { type: 'tool_use', id: 'busca', name: 'search_text', input: { query: 'marcador-publico' } },
          ],
        };
      }
      return finalReply();
    });
    const runtime = new AgentRuntime({ rootDir, complete });
    const events: AgentStreamEvent[] = [];
    runtime.start({ message: 'Encontrar arquivo' }, (event) => events.push(event));
    await waitForDone(events);

    const secondRequest = vi.mocked(complete).mock.calls[1]?.[0];
    expect(secondRequest).toBeDefined();
    const results = secondRequest!.messages.at(-1)?.content;
    expect(Array.isArray(results)).toBe(true);
    if (!Array.isArray(results)) throw new Error('Resultados das ferramentas ausentes.');
    const [listing, search] = results;
    expect(listing.content).toContain('visivel.txt');
    expect(search.content).toContain('visivel.txt');
    for (const result of [listing, search]) {
      expect(result.is_error).not.toBe(true);
      expect(result.content).not.toMatch(/\.env|node_modules|\.git/);
    }
  });

  it('reaproveita a memória por threadId e workspace, mas consulta outra conversa', async () => {
    const rootDir = workspace();
    const prepare = vi.fn(async (_message: string, _signal: AbortSignal) => 'referência');
    const record = vi.fn(async (_note: unknown) => 'registrado');
    const memory = { prepare, record } as unknown as AgentMemory;
    const complete: AgentModel = vi.fn(async () => finalReply());
    const runtime = new AgentRuntime({ rootDir, complete, memory });

    for (const threadId of ['mesma', 'mesma', 'outra']) {
      const events: AgentStreamEvent[] = [];
      runtime.start({ message: 'Consultar memória', threadId }, (event) => events.push(event));
      await waitForDone(events);
    }

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
  });

  it('registra uma vez a execução com escrita aprovada e não registra conversa sem escrita', async () => {
    const rootDir = workspace();
    const prepare = vi.fn(async (_message: string, _signal: AbortSignal) => '');
    const record = vi.fn(async (_note: unknown) => 'registrado');
    const memory = { prepare, record } as unknown as AgentMemory;
    const complete: AgentModel = vi.fn(async () => {
      if (vi.mocked(complete).mock.calls.length === 1) {
        return toolReply('propose_file_write', { path: 'novo.txt', content: 'novo conteúdo' });
      }
      return finalReply();
    });
    const runtime = new AgentRuntime({ rootDir, complete, memory });
    const written: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'Escrever arquivo' }, (event) => written.push(event));
    const approval = await waitForEvent(written, 'approval');
    expect(runtime.approve(id, approval.approval!.id, 'approve')).toBe(true);
    await waitForDone(written);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      titulo: expect.stringContaining('escrita'),
    }));

    const withoutWrite: AgentStreamEvent[] = [];
    runtime.start({ message: 'Somente responder' }, (event) => withoutWrite.push(event));
    await waitForDone(withoutWrite);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('rejeita workspace desconhecido e lista os ids ordenados com o padrão', () => {
    const first = workspace();
    const second = workspace();
    const complete: AgentModel = vi.fn(async () => finalReply());
    const runtime = new AgentRuntime({
      workspaces: { zeta: first, alfa: second },
      defaultWorkspace: 'zeta',
      complete,
    });

    expect(runtime.workspaceList()).toEqual({
      workspaces: [{ id: 'alfa', label: 'alfa' }, { id: 'zeta', label: 'zeta' }],
      default: 'zeta',
    });
    expect(() => runtime.start({ message: 'Teste', workspace: 'desconhecido' }))
      .toThrow('Workspace desconhecido.');
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('stripPlaceholder', () => {
  it('tira o "(empty response)" do OmniRoute e mantém o resto', () => {
    expect(stripPlaceholder('(empty response)A pasta tem 22 arquivos')).toBe('A pasta tem 22 arquivos');
    expect(stripPlaceholder('  (Empty Response)  ')).toBe('');
    expect(stripPlaceholder('Texto normal (empty response) no meio')).toBe('Texto normal (empty response) no meio');
  });
});
