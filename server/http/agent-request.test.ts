// Pedido ao estúdio: plano colado longo e histórico com resposta grande do gerente não podem virar HTTP 400.
import { describe, expect, it } from 'vitest';
import { parseAgentRunRequest } from './omniroute';

describe('parseAgentRunRequest', () => {
  it('aceita pedido longo (plano colado) até 60 mil caracteres', () => {
    const message = 'Onda 0. '.repeat(5_000);
    expect(parseAgentRunRequest({ message }).message.length).toBeGreaterThan(24_000);
  });

  it('acima de 60 mil, recusa dizendo o tamanho e o limite', () => {
    expect(() => parseAgentRunRequest({ message: 'x'.repeat(60_001) })).toThrow(/60001 caracteres; o limite é 60000/);
  });

  it('histórico: ignora item vazio, corta item longo pelo início e mantém só os 10 últimos', () => {
    const longo = `${'a'.repeat(30_000)}FIM`;
    const messages = [
      ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: longo },
    ];
    const parsed = parseAgentRunRequest({ message: 'continue', messages });
    expect(parsed.messages).toHaveLength(9);
    const last = parsed.messages.at(-1)!;
    expect(last.content.startsWith('[início cortado]')).toBe(true);
    expect(last.content.endsWith('FIM')).toBe(true);
    expect(last.content.length).toBeLessThanOrEqual(24_000 + 20);
  });

  it('continua recusando papel inválido no histórico', () => {
    expect(() => parseAgentRunRequest({ message: 'oi', messages: [{ role: 'system', content: 'x' }] })).toThrow('mensagem de histórico inválida');
  });
});
