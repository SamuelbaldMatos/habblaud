// Combos do OmniRoute expostos no Habblaud: fonte única para a allowlist do servidor e o seletor do cliente.
// Nomes por função (decisão de 2026-10-18); os apelidos antigos (jarvis, exec-*, seguranca, local-privado,
// direcionador) não entram em nada novo.
export const OMNIROUTE_COMBO_OPTIONS = [
  { id: 'orquestrador', label: '🧠 orquestrador · Multiagente' },
  { id: 'gerente-jarvis', label: '🤵 gerente-jarvis · Gerente local' },
  { id: 'aprimorador', label: '✨ aprimorador · Refinamento de demandas' },
  { id: 'executor-claude', label: '🟠 executor-claude · Executor Claude' },
  { id: 'executor-codex', label: '🟢 executor-codex · Executor Codex' },
  { id: 'executor-antigravity', label: '🔵 executor-antigravity · Executor Antigravity' },
  { id: 'executor-copilot', label: '⚫ executor-copilot · Executor Copilot' },
  { id: 'codigo', label: '💻 codigo · Programação' },
  { id: 'codigo-pesado', label: '🚀 codigo-pesado · Refatoração profunda' },
  { id: 'revisor', label: '🔬 revisor · Revisão de código' },
  { id: 'revisor-seguranca', label: '🛡️ revisor-seguranca · Análise de risco' },
  { id: 'complexo', label: '🏛️ complexo · Claude Opus' },
  { id: 'maximo', label: '🚀 maximo · Consulta difícil (Claude)' },
  { id: 'analise', label: '📊 analise · Dados e SQL' },
  { id: 'contexto-longo', label: '📚 contexto-longo · Contexto longo' },
  { id: 'texto', label: '💬 texto · Redação PT-BR' },
  { id: 'rapido', label: '⚡ rapido · Tarefas ágeis' },
  { id: 'processador-privado-local', label: '🔒 processador-privado-local · Ollama Local' },
] as const;

export type OmniCombo = (typeof OMNIROUTE_COMBO_OPTIONS)[number]['id'];

export const OMNIROUTE_COMBOS: readonly OmniCombo[] = OMNIROUTE_COMBO_OPTIONS.map((c) => c.id);
