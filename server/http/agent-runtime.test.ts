import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/fixtures';
import { AgentRuntime, type AgentModel, type AgentStreamEvent, type AgentModelReply } from './agent-runtime';

function waitForEvent(events: AgentStreamEvent[], type: AgentStreamEvent['type']): Promise<AgentStreamEvent> {
  const existing = events.find((event) => event.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Timeout esperando evento ${type}`));
    }, 3000);
    const poll = () => {
      if (settled) return;
      const event = events.find((candidate) => candidate.type === type);
      if (event) {
        settled = true;
        clearTimeout(timeout);
        resolve(event);
      }
      else setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForDone(events: AgentStreamEvent[]): Promise<void> {
  return waitForEvent(events, 'done').then(() => undefined);
}

describe('runtime multiagente', () => {
  it('rejects invalid budgets and blocks before sending a request that cannot fit', async () => {
    const complete = vi.fn<AgentModel>();
    expect(() => new AgentRuntime({ rootDir: process.cwd(), complete, maxTotalTokens: NaN })).toThrow();
    const runtime = new AgentRuntime({ rootDir: process.cwd(), complete, maxTotalTokens: 1 });
    const events: AgentStreamEvent[] = [];
    runtime.start({ message: 'Teste' }, event => events.push(event));
    await waitForDone(events);
    expect(complete).not.toHaveBeenCalled();
    expect(events.some(event => event.error?.includes('incompleta'))).toBe(true);
  });

  it.each(['max_tokens', 'over-budget', 'empty', 'too-many-tools'])('never executes tools after an incomplete %s reply', async mode => {
    const block = { type: 'tool_use', id: 'one', name: 'propose_file_write', input: { path: 'unknown', content: 'bad' } };
    const reply: AgentModelReply = { content: [block] };
    if (mode === 'max_tokens') reply.stop_reason = 'max_tokens';
    if (mode === 'over-budget') reply.usage = { input_tokens: 119999, output_tokens: 2 };
    if (mode === 'empty') reply.content = [];
    if (mode === 'too-many-tools') reply.content = Array.from({ length: 9 }, (_, index) => ({ ...block, id: String(index) }));
    const complete: AgentModel = vi.fn(async () => reply);
    const events: AgentStreamEvent[] = [];
    new AgentRuntime({ rootDir: process.cwd(), complete }).start({ message: 'Teste' }, event => events.push(event));
    await waitForDone(events);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.some(event => event.type === 'approval' || event.type === 'tool_result')).toBe(false);
  });

  it('aggregates manager, specialist and cached tokens in one budget', async () => {
    let calls = 0;
    const complete: AgentModel = vi.fn(async () => ++calls === 1
      ? { content: [{ type: 'tool_use', id: 's', name: 'consult_specialist', input: { combo: 'revisor', task: 'Revisar' } }], usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 5000 } }
      : { content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 3000 } });
    const events: AgentStreamEvent[] = [];
    new AgentRuntime({ rootDir: process.cwd(), complete, maxTotalTokens: 20000 }).start({ message: 'Teste' }, event => events.push(event));
    await waitForDone(events);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(events.some(event => event.error?.includes('Orçamento'))).toBe(true);
    expect(events.some(event => event.activity?.includes('17000/20000'))).toBe(true);
  });

  it('keeps conservative usage when absent and does not record a conversation without writes', async () => {
    const record = vi.fn(async () => 'conhecimento/note.md');
    const prepare = vi.fn(async () => 'Referência validada');
    const complete: AgentModel = vi.fn(async request => {
      expect(request.system).toContain('Referência validada');
      return { content: [{ type: 'text', text: 'Resposta confidencial sintética' }] };
    });
    const events: AgentStreamEvent[] = [];
    new AgentRuntime({ rootDir: process.cwd(), complete, memory: { prepare, record } }).start({ message: 'Entrada confidencial sintética' }, event => events.push(event));
    await waitForDone(events);
    // Conversa sem escrita aprovada não vira nota no vault (antes até um "ok" virava).
    expect(record).not.toHaveBeenCalled();
    expect(events.some(event => event.activity?.includes('1 com estimativa'))).toBe(true);
  });

  it('persists substantive learning only after explicit approval', async () => {
    const record = vi.fn(async () => 'conhecimento/approved.md');
    let calls = 0;
    const complete: AgentModel = vi.fn(async () => ++calls === 1 ? { content: [{ type: 'tool_use', id: 'learn', name: 'propose_learning', input: { title: 'Decisão verificada', summary: 'Cache validado em teste', evidence: 'Teste de cache passou' } }] } : { content: [{ type: 'text', text: 'OK' }] });
    const runtime = new AgentRuntime({ rootDir: process.cwd(), complete, memory: { prepare: async () => '', record } });
    const events: AgentStreamEvent[] = [];
    const id = runtime.start({ message: 'Registre' }, event => events.push(event));
    const approval = await waitForEvent(events, 'approval');
    expect(record).not.toHaveBeenCalled();
    expect(approval.approval?.newContent).toContain('Teste de cache passou');
    runtime.approve(id, approval.approval!.id, 'approve');
    await waitForDone(events);
    // Só o aprendizado aprovado; sem escrita de arquivo não há resumo operacional.
    expect(record).toHaveBeenCalledOnce();
    expect(JSON.stringify(record.mock.calls)).toContain('Decisão verificada');
  });

  it('truncates large file results with an explicit partial marker', async () => {
    const tmp = tempDir();
    try {
      writeFileSync(join(tmp.dir, 'large.txt'), 'á'.repeat(10000));
      let calls = 0;
      const complete: AgentModel = vi.fn(async request => {
        if (++calls === 1) return { content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'large.txt' } }] };
        const last = request.messages.at(-1)!.content;
        expect(Array.isArray(last)).toBe(true);
        if (Array.isArray(last)) {
          expect(last[0].content).toContain('RESULTADO TRUNCADO');
          expect(Buffer.byteLength(last[0].content!)).toBeLessThanOrEqual(16000);
          expect(last[0].content).not.toContain('\uFFFD');
        }
        return { content: [{ type: 'text', text: 'OK' }] };
      });
      const events: AgentStreamEvent[] = [];
      new AgentRuntime({ rootDir: tmp.dir, complete }).start({ message: 'Leia' }, event => events.push(event));
      await waitForDone(events);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(complete).toHaveBeenCalledTimes(2);
    } finally { tmp.cleanup(); }
  });
  it('consulta especialistas de forma limitada e devolve texto ao gerente', async () => {
    const calls: string[] = [];
    const complete: AgentModel = vi.fn(async (request) => {
      calls.push(request.combo);
      if (request.combo === 'orquestrador' && calls.filter((combo) => combo === 'orquestrador').length === 1) {
        return { content: [{ type: 'tool_use', id: 'delegate-1', name: 'consult_specialist', input: { combo: 'revisor', task: 'Revise a alteração proposta.' } }] };
      }
      if (request.combo === 'revisor') return { content: [{ type: 'text', text: 'A análise não encontrou regressões.' }] };
      return { content: [{ type: 'text', text: 'Concluído com a revisão.' }] };
    });
    const runtime = new AgentRuntime({ rootDir: process.cwd(), complete });
    const events: AgentStreamEvent[] = [];
    runtime.start({ message: 'Revise este ajuste.' }, (event) => events.push(event));
    await waitForDone(events);

    expect(calls).toEqual(['orquestrador', 'revisor', 'orquestrador']);
    expect(events.some((event) => event.type === 'activity' && event.activity?.includes('revisor'))).toBe(true);
    expect(events.some((event) => event.type === 'text' && event.text === 'Concluído com a revisão.')).toBe(true);
  });

  it('aguarda aprovação antes da escrita e recusa em caso de cancelamento', async () => {
    const tmp = tempDir();
    try {
      const target = join(tmp.dir, 'sample.txt');
      writeFileSync(target, 'original');
      const complete: AgentModel = vi.fn(async () => ({
        content: [{ type: 'tool_use', id: 'write-1', name: 'propose_file_write', input: { path: 'sample.txt', content: 'proposto' } }],
      }));
      const runtime = new AgentRuntime({ rootDir: tmp.dir, complete });
      const events: AgentStreamEvent[] = [];
      const jobId = runtime.start({ message: 'Atualize o arquivo.' }, (event) => events.push(event));
      const request = await waitForEvent(events, 'approval');
      expect(request.approval?.kind).toBe('write');
      expect(readFileSync(target, 'utf8')).toBe('original');
      runtime.cancel(jobId);
      await waitForDone(events);
      expect(readFileSync(target, 'utf8')).toBe('original');
    } finally {
      tmp.cleanup();
    }
  });

  it('aprova uma escrita uma única vez e falha se o modelo tenta reutilizar a aprovação', async () => {
    const tmp = tempDir();
    try {
      const target = join(tmp.dir, 'sample.txt');
      writeFileSync(target, 'original');
      let calls = 0;
      const complete: AgentModel = vi.fn(async () => {
        calls++;
        return calls === 1
          ? { content: [{ type: 'tool_use', id: 'write-1', name: 'propose_file_write', input: { path: 'sample.txt', content: 'novo' } }] }
          : { content: [{ type: 'text', text: 'Arquivo atualizado.' }] };
      });
      const runtime = new AgentRuntime({ rootDir: tmp.dir, complete });
      const events: AgentStreamEvent[] = [];
      const jobId = runtime.start({ message: 'Atualize o arquivo.' }, (event) => events.push(event));
      const request = await waitForEvent(events, 'approval');
      expect(runtime.approve(jobId, request.approval!.id, 'approve')).toBe(true);
      await waitForDone(events);
      expect(readFileSync(target, 'utf8')).toBe('novo');
      expect(runtime.approve(jobId, request.approval!.id, 'approve')).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});
