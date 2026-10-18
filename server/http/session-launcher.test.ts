import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  type AgentModelReply,
  type AgentModelRequest,
  type AgentStreamEvent,
  type ModelContentBlock,
} from './agent-runtime';
import {
  createSessionLauncher,
  hostPathMapper,
  SESSION_DELEGATION_PREFIX,
  type SessionLauncherOptions,
} from './session-launcher';

const runtimes: AgentRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    for (const job of runtime.list()) {
      if (job.status === 'running') runtime.cancel(job.id);
    }
  }
  vi.useRealTimers();
});

function spawnStub() {
  return {
    available: vi.fn(() => true),
    submit: vi.fn((_raw: unknown): ReturnType<SessionLauncherOptions['spawn']['submit']> => ({
      spawn: { id: 'pedido-123', status: 'queued' },
    })),
  };
}

function finalReply(): AgentModelReply {
  return { content: [{ type: 'text', text: 'Concluído.' }] };
}

function toolReply(input: unknown): AgentModelReply {
  return {
    content: [{ type: 'tool_use', id: 'chamada-sessao', name: 'start_agent_session', input }],
  };
}

async function waitForEvent(
  events: AgentStreamEvent[],
  type: AgentStreamEvent['type'],
): Promise<AgentStreamEvent> {
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === type)).toBe(true);
  }, { timeout: 3000, interval: 5 });
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Evento ${type} não encontrado.`);
  return event;
}

function sessionRun(input: unknown = { prompt: 'Implemente a tarefa.', title: 'Implementação' }, enabled = true) {
  const spawn = spawnStub();
  const hostPath = vi.fn(hostPathMapper({ HABBLAUD_HOST_PATHS: '/workspace=C:/projeto' }));
  const launcher = createSessionLauncher({ spawn, hostPath });
  const events: AgentStreamEvent[] = [];
  const requests: AgentModelRequest[] = [];
  const complete = vi.fn(async (request: AgentModelRequest): Promise<AgentModelReply> => {
    requests.push(request);
    return requests.length === 1 ? toolReply(input) : finalReply();
  });
  const runtime = new AgentRuntime({
    workspaces: { outro: '/outro', atual: '/workspace/subpasta' },
    defaultWorkspace: 'outro',
    complete,
    ...(enabled ? { launcher } : {}),
  });
  runtimes.push(runtime);
  const id = runtime.start({ message: 'Delegue esta tarefa.', workspace: 'atual' }, (event) => events.push(event));
  return { spawn, hostPath, events, requests, runtime, id };
}

function returnedToolResults(requests: AgentModelRequest[]): ModelContentBlock[] {
  return requests.flatMap((request) =>
    request.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_result')
        : []));
}

describe('hostPathMapper', () => {
  it('escolhe o prefixo mais longo, independentemente da ordem', () => {
    const map = hostPathMapper({
      HABBLAUD_HOST_PATHS: '/workspace=/Users/sam/projetos;/workspace/app=/Volumes/app',
    });
    expect(map('/workspace/app/src')).toBe('/Volumes/app/src');
    expect(map('/workspace/outro')).toBe('/Users/sam/projetos/outro');
    expect(map('/workspace/app')).toBe('/Volumes/app');
  });

  it('normaliza separadores de host com drive Windows, incluindo a raiz', () => {
    const map = hostPathMapper({
      HABBLAUD_HOST_PATHS: '/projetos/I=I:/;/workspace=C:/Users/sam_1/habblaud-1.0.3',
    });
    expect(map('/projetos/I')).toBe('I:\\');
    expect(map('/projetos/I/pasta/arquivo')).toBe('I:\\pasta\\arquivo');
    expect(map('/workspace/server/http')).toBe('C:\\Users\\sam_1\\habblaud-1.0.3\\server\\http');

    const mixed = hostPathMapper({ HABBLAUD_HOST_PATHS: '/workspace=C:\\Users/sam\\projeto/' });
    expect(mixed('/workspace/src')).toBe('C:\\Users\\sam\\projeto\\src');
  });

  it('sem variável devolve a própria pasta, sem alterá-la', () => {
    const map = hostPathMapper({});
    expect(map('/Users/sam/projeto')).toBe('/Users/sam/projeto');
    expect(map('C:\\Users\\sam\\projeto')).toBe('C:\\Users\\sam\\projeto');
    expect(hostPathMapper({ HABBLAUD_HOST_PATHS: ' ' })('/workspace')).toBe('/workspace');
  });

  it('respeita limites de pasta e falha quando não existe mapeamento', () => {
    const map = hostPathMapper({ HABBLAUD_HOST_PATHS: '/workspace=/Users/sam/projeto' });
    expect(map('/workspace-extra')).toBeUndefined();
    expect(map('/outro')).toBeUndefined();
    expect(map('/workspace/../fora')).toBeUndefined();
    expect(map('/workspace/src/../test')).toBe('/Users/sam/projeto/test');
  });

  it('aceita barra final no prefixo e mapeamento da raiz', () => {
    const map = hostPathMapper({ HABBLAUD_HOST_PATHS: '/=/host;/workspace/=/projeto/' });
    expect(map('/workspace/src')).toBe('/projeto/src');
    expect(map('/outro/src')).toBe('/host/outro/src');
  });

  it('configuração inválida não libera o caminho do container', () => {
    expect(hostPathMapper({ HABBLAUD_HOST_PATHS: 'inválido;relativo=/host;/workspace=' })('/workspace')).toBeUndefined();
  });
});

describe('createSessionLauncher', () => {
  it('indisponível não traduz nem envia o pedido', () => {
    const spawn = spawnStub();
    spawn.available.mockReturnValue(false);
    const hostPath = vi.fn((path: string) => path);
    const launcher = createSessionLauncher({ spawn, hostPath });

    expect(launcher.launch('/workspace', 'Tarefa')).toEqual({
      ok: false,
      error: 'O Novo agente está desligado (HABBLAUD_PTY=1 e npm run codex:bridge no PC)',
    });
    expect(hostPath).not.toHaveBeenCalled();
    expect(spawn.submit).not.toHaveBeenCalled();
  });

  it('sucesso traduz a pasta e preserva integralmente o pedido', () => {
    const spawn = spawnStub();
    const launcher = createSessionLauncher({
      spawn,
      hostPath: hostPathMapper({ HABBLAUD_HOST_PATHS: '/workspace=C:/projeto' }),
    });
    const prompt = `${SESSION_DELEGATION_PREFIX}\nFaça a tarefa.\nNão corte esta linha.`;

    expect(launcher.launch('/workspace/src', prompt)).toEqual({
      ok: true, id: 'pedido-123', status: 'queued',
    });
    expect(spawn.submit).toHaveBeenCalledExactlyOnceWith({ folder: 'C:\\projeto\\src', prompt });
  });

  it('sem caminho no host devolve erro claro e não envia', () => {
    const spawn = spawnStub();
    const launcher = createSessionLauncher({ spawn, hostPath: () => undefined });
    const result = launcher.launch('/workspace', 'Tarefa');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Era esperado erro de mapeamento.');
    expect(result.error).toContain('/workspace');
    expect(result.error).toContain('HABBLAUD_HOST_PATHS');
    expect(spawn.submit).not.toHaveBeenCalled();
  });

  it('repassa o motivo do erro de submit', () => {
    const spawn = spawnStub();
    spawn.submit.mockReturnValue({ error: 'too-many', reason: 'Já há agentes esperando para abrir.' });
    const launcher = createSessionLauncher({ spawn, hostPath: (path) => path });

    expect(launcher.launch('/workspace', 'Tarefa')).toEqual({
      ok: false, error: 'Já há agentes esperando para abrir.',
    });
  });

  it('não declara sucesso para um pedido que já voltou como failed', () => {
    const spawn = spawnStub();
    spawn.submit.mockReturnValue({ spawn: { id: 'pedido-123', status: 'failed' } });
    const result = createSessionLauncher({ spawn, hostPath: (path) => path }).launch('/workspace', 'Tarefa');

    expect(result.ok).toBe(false);
  });

  it('converte exceção do submit em erro do launcher', () => {
    const spawn = spawnStub();
    spawn.submit.mockImplementation(() => {
      throw new Error('Falha na fila.');
    });
    expect(createSessionLauncher({ spawn, hostPath: (path) => path }).launch('/workspace', 'Tarefa')).toEqual({
      ok: false, error: 'Falha na fila.',
    });
  });
});

describe('AgentRuntime: start_agent_session', () => {
  it('exige aprovação e não consulta nem envia ao launcher antes dela', async () => {
    const run = sessionRun();
    const event = await waitForEvent(run.events, 'approval');

    expect(event.approval).toMatchObject({
      kind: 'command',
      summary: 'Abrir sessão do Claude Code em atual: Implementação',
      check: 'Implemente a tarefa.',
    });
    expect(event.approval?.id).toBeTruthy();
    expect(run.spawn.available).not.toHaveBeenCalled();
    expect(run.hostPath).not.toHaveBeenCalled();
    expect(run.spawn.submit).not.toHaveBeenCalled();
    expect(run.requests[0]?.tools?.some((tool) => tool.name === 'start_agent_session')).toBe(true);
    expect(run.requests[0]?.tools?.some((tool) => tool.name === 'propose_learning')).toBe(false);

    run.runtime.cancel(run.id);
    await waitForEvent(run.events, 'done');
  });

  it('recusa não chama submit e retorna erro da ferramenta ao modelo', async () => {
    const run = sessionRun();
    const event = await waitForEvent(run.events, 'approval');
    expect(run.runtime.approve(run.id, event.approval!.id, 'reject')).toBe(true);
    await waitForEvent(run.events, 'done');

    expect(run.spawn.submit).not.toHaveBeenCalled();
    expect(run.events.some((item) => item.activity?.startsWith('Sessão aberta no Claude Code:'))).toBe(false);
    expect(returnedToolResults(run.requests)).toContainEqual(expect.objectContaining({
      tool_use_id: 'chamada-sessao', is_error: true,
    }));
    expect(run.events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      result: expect.objectContaining({ tool: 'start_agent_session', ok: false }),
    }));
  });

  it('aprovação envia uma única vez, com linha fixa e pasta do workspace atual', async () => {
    const prompt = 'Implemente a tarefa.\nDepois rode os testes.';
    const run = sessionRun({ prompt, title: 'Implementação' });
    const event = await waitForEvent(run.events, 'approval');
    expect(run.runtime.approve(run.id, event.approval!.id, 'approve')).toBe(true);
    expect(run.runtime.approve(run.id, event.approval!.id, 'approve')).toBe(false);
    await waitForEvent(run.events, 'done');

    expect(SESSION_DELEGATION_PREFIX).toBe(
      '[Tarefa delegada pelo Jarvis do Habblaud — trabalhe até concluir; peça aprovação pelo escritório quando precisar]',
    );
    expect(run.hostPath).toHaveBeenCalledWith('/workspace/subpasta');
    expect(run.spawn.submit).toHaveBeenCalledExactlyOnceWith({
      folder: 'C:\\projeto\\subpasta',
      prompt: `${SESSION_DELEGATION_PREFIX}\n${prompt}`,
    });
    expect(run.events).toContainEqual(expect.objectContaining({
      type: 'activity', activity: 'Sessão aberta no Claude Code: Implementação',
    }));
    const result = run.events.find((item) => item.result?.tool === 'start_agent_session')?.result;
    expect(result?.ok).toBe(true);
    expect(result?.message).toContain('pedido-123');
    expect(result?.message).toContain('vai aparecer no escritório');
  });

  it('sem launcher omite a ferramenta e recusa uma chamada não anunciada', async () => {
    const run = sessionRun({ prompt: 'Tarefa' }, false);
    await waitForEvent(run.events, 'done');

    expect(run.requests[0]?.tools?.some((tool) => tool.name === 'start_agent_session')).toBe(false);
    expect(run.events.some((event) => event.type === 'approval')).toBe(false);
    expect(run.spawn.submit).not.toHaveBeenCalled();
    expect(returnedToolResults(run.requests)).toContainEqual(expect.objectContaining({ is_error: true }));
  });

  it('usa o início do prompt como título quando title está ausente', async () => {
    const prompt = `Corrigir o projeto\n${'x'.repeat(600)}`;
    const run = sessionRun({ prompt });
    const event = await waitForEvent(run.events, 'approval');

    expect(event.approval?.summary).toBe('Abrir sessão do Claude Code em atual: Corrigir o projeto');
    expect(event.approval?.check).toBe(prompt.slice(0, 500));
    run.runtime.approve(run.id, event.approval!.id, 'reject');
    await waitForEvent(run.events, 'done');
  });

  it.each([
    { prompt: '' },
    { prompt: '   ' },
    { prompt: 'x'.repeat(8001) },
    { prompt: 'Pedido\0inválido' },
    { prompt: 'Tarefa', title: 123 },
    { prompt: 'Tarefa', folder: '/outro' },
  ])('recusa argumentos inválidos sem abrir: %j', async (input) => {
    const run = sessionRun(input);
    await waitForEvent(run.events, 'done');

    expect(run.events.some((event) => event.type === 'approval')).toBe(false);
    expect(run.spawn.submit).not.toHaveBeenCalled();
    expect(returnedToolResults(run.requests)).toContainEqual(expect.objectContaining({ is_error: true }));
  });

  it('expiração retorna erro e não abre sessão', async () => {
    vi.useFakeTimers();
    const run = sessionRun();
    await vi.advanceTimersByTimeAsync(0);
    const approval = run.events.find((event) => event.type === 'approval')?.approval;
    expect(approval).toBeDefined();
    expect(run.spawn.submit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(run.events.some((event) => event.type === 'done')).toBe(true);
    expect(run.spawn.submit).not.toHaveBeenCalled();
    expect(run.runtime.approve(run.id, approval!.id, 'approve')).toBe(false);
    expect(returnedToolResults(run.requests)).toContainEqual(expect.objectContaining({ is_error: true }));
  });

  it('cancelamento imediatamente após aprovação ainda impede a abertura', async () => {
    const run = sessionRun();
    const event = await waitForEvent(run.events, 'approval');
    run.runtime.approve(run.id, event.approval!.id, 'approve');
    run.runtime.cancel(run.id);
    await waitForEvent(run.events, 'done');

    expect(run.spawn.submit).not.toHaveBeenCalled();
  });

  it('erro do submit após aprovação não emite atividade de sessão aberta', async () => {
    const run = sessionRun();
    run.spawn.submit.mockReturnValue({ error: 'invalid', reason: 'O pedido excede o limite do Novo agente.' });
    const event = await waitForEvent(run.events, 'approval');
    run.runtime.approve(run.id, event.approval!.id, 'approve');
    await waitForEvent(run.events, 'done');

    expect(run.events.some((item) => item.activity?.startsWith('Sessão aberta no Claude Code:'))).toBe(false);
    expect(run.events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      result: {
        tool: 'start_agent_session',
        ok: false,
        message: 'O pedido excede o limite do Novo agente.',
      },
    }));
  });
});
