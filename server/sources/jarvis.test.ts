// Jarvis no escritório: personagem fixo na Diretoria e o estado acompanhando as tarefas do estúdio.
import { describe, expect, it, vi } from 'vitest';
import type { Office } from '../model/office';
import { JARVIS_ID, JARVIS_LOOK, JarvisSource } from './jarvis';

function fakes(existing?: { name: string }) {
  const office = { addMain: vi.fn(), addActivity: vi.fn(), setStatus: vi.fn() };
  const names = { character: vi.fn(() => existing), setCharacter: vi.fn() };
  const src = new JarvisSource({ office: office as unknown as Office, names, roomId: '/habblaud/Diretoria', now: () => 1_000 });
  return { office, names, src };
}

describe('Jarvis', () => {
  it('nasce de camisa e gravata na Diretoria, como Gerente, mesmo sem sessão', () => {
    const { office, names, src } = fakes();
    src.start();
    expect(names.setCharacter).toHaveBeenCalledWith('/habblaud/Diretoria', expect.objectContaining({ name: 'Jarvis', parts: JARVIS_LOOK }));
    expect(JARVIS_LOOK.topStyle).toBe('shirt_tie');
    expect(office.addMain).toHaveBeenCalledWith(expect.objectContaining({ id: JARVIS_ID, role: 'Gerente', status: 'idle', cwd: '/habblaud/Diretoria' }));
  });

  it('não sobrescreve um personagem que o usuário já editou', () => {
    const { names, src } = fakes({ name: 'Outro' });
    src.start();
    expect(names.setCharacter).not.toHaveBeenCalled();
  });

  it('trabalhando com tarefa, esperando com aprovação pendente, parado ao terminar', () => {
    const { office, src } = fakes();
    src.onJob({ jobId: 'a', title: 'Corrigir login', type: 'job' });
    expect(office.setStatus).toHaveBeenLastCalledWith(JARVIS_ID, 'working', undefined);
    src.onJob({ jobId: 'a', title: 'Corrigir login', type: 'approval' });
    expect(office.setStatus).toHaveBeenLastCalledWith(JARVIS_ID, 'waiting', 'aprovar ou decidir no estúdio');
    src.onJob({ jobId: 'a', title: 'Corrigir login', type: 'tool_result' });
    expect(office.setStatus).toHaveBeenLastCalledWith(JARVIS_ID, 'working', undefined);
    src.onJob({ jobId: 'a', title: 'Corrigir login', type: 'done' });
    expect(office.setStatus).toHaveBeenLastCalledWith(JARVIS_ID, 'idle', undefined);
    const texts = office.addActivity.mock.calls.map((c) => (c[1] as { text: string }).text);
    expect(texts).toContain('Corrigir login');
    expect(texts).toContain('Entregou: Corrigir login');
  });

  it('balão curto (até 46 caracteres) e o resto no detalhe', () => {
    const { office, src } = fakes();
    src.onJob({ jobId: 'b', title: 'x'.repeat(80), type: 'job' });
    const act = office.addActivity.mock.calls[0][1] as { text: string; detail: string };
    expect(act.text.length).toBeLessThanOrEqual(46);
    expect(act.detail).toContain('x'.repeat(80));
  });
});
