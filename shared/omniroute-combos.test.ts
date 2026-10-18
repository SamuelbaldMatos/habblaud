import { describe, expect, it } from 'vitest';
import { OMNIROUTE_COMBOS, OMNIROUTE_COMBO_OPTIONS as COMBOS } from './omniroute-combos';

const EXPECTED_COMBOS = [
  'orquestrador',
  'gerente-jarvis',
  'aprimorador',
  'executor-claude',
  'executor-codex',
  'executor-antigravity',
  'executor-copilot',
  'codigo',
  'codigo-pesado',
  'revisor',
  'revisor-seguranca',
  'complexo',
  'maximo',
  'analise',
  'contexto-longo',
  'texto',
  'rapido',
  'processador-privado-local',
];

describe('combos ativos do OmniChat', () => {
  it('mantém a lista aprovada sem aliases legados nem duplicatas', () => {
    expect(COMBOS.map(({ id }) => id)).toEqual(EXPECTED_COMBOS);
    expect(OMNIROUTE_COMBOS).toEqual(EXPECTED_COMBOS);
  });

  it('mantém a paridade entre as opções do cliente e a allowlist do servidor', () => {
    expect(COMBOS.map(({ id }) => id)).toEqual(OMNIROUTE_COMBOS);
    for (const { id, label } of COMBOS) expect(label).toContain(id);
  });

  it('preserva orquestrador como primeira opção das sessões comuns', () => {
    expect(COMBOS[0].id).toBe('orquestrador');
  });
});
