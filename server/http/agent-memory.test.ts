import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { createAgentMemory } from './agent-memory';

describe('Cérebro bridge', () => {
  it('uses curated project notes and rejects raw sessions, other projects and unrelated agents', async () => {
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cerebro_buscar') return { busca: 'hibrida', resultados: [
        { nota: 'sessoes/secret.md' }, { nota: 'conhecimento/sessoes-compartilhadas/other.md' },
        { nota: 'conhecimento/sessoes-compartilhadas/valid.md' },
      ] };
      if (tool === 'cerebro_rotear') return { resultados: [
        { tipo: 'agente', setor: 'juridico-compliance', nome: 'Revisor contratual' },
        { tipo: 'agente', setor: 'tecnologia-software', nome: 'Arquiteto', faz: 'Arquitetura de software' },
      ] };
      if (tool === 'cerebro_ler_nota') return { conteudo: args.nota === 'conhecimento/sessoes-compartilhadas/valid.md'
        ? '---\nprojeto: "Aurora"\n---\nDecisão validada.' : '---\nprojeto: Boreal\n---\nConteúdo privado.' };
      throw new Error('Unexpected');
    });
    const memory = createAgentMemory({ cli: resolve('brain.mjs'), project: 'Aurora', call });
    const context = await memory.prepare('Código');
    expect(context).toContain('Decisão validada');
    expect(context).toContain('Arquiteto');
    expect(context).not.toMatch(/privado|secret|contratual/);
    expect(call.mock.calls.filter(([tool]) => tool === 'cerebro_ler_nota')).toHaveLength(2);
  });

  it('requires a positive persistence confirmation and fixes project and origin', async () => {
    const call = vi.fn(async () => ({ registrado: true, nota: 'conhecimento/note.md', vetor: { indexado: false } }));
    const memory = createAgentMemory({ cli: resolve('brain.mjs'), project: 'Aurora', call });
    const note = await memory.record({ id: 'one', titulo: 'Teste', resumo: 'Validado', evidencias: ['Teste passou'] });
    expect(note).toContain('vetor pendente');
    expect(call).toHaveBeenCalledWith('cerebro_registrar', expect.objectContaining({ projeto: 'Aurora', origem: 'habblaud-runtime' }));
    const failing = createAgentMemory({ cli: resolve('brain.mjs'), project: 'Aurora', call: async () => ({}) });
    await expect(failing.record({ id: 'x', titulo: 'x', resumo: 'x', evidencias: ['x'] })).rejects.toThrow('não confirmou');
  });
});
