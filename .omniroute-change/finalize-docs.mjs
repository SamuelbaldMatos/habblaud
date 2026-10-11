import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const protocolPath = String.raw`C:\Users\sam_1\.claude\profiles\omniroute\CLAUDE.md`;
const brainPath = String.raw`I:\CarecaBrain\CarecaBrain\entregas\tecnologia-software\2026-10-08-equipe-ia-omniroute-habblaud.md`;

function update(path, replacements) {
  const backup = `${path}.gpt-manager-final-backup-${stamp}`;
  copyFileSync(path, backup);
  let text = readFileSync(path, 'utf8');
  for (const [search, replacement, label] of replacements) {
    const next = text.replace(search, replacement);
    if (next === text) throw new Error(`Trecho esperado não encontrado: ${label}`);
    text = next;
  }
  writeFileSync(path, text, 'utf8');
  return backup;
}

const protocolBackup = update(protocolPath, [
  [
    '- **Rodadas:** no máximo 2 rodadas de réplica por ponto. Persistindo o desacordo, você decide com o `complexo`;\n  se for crítico, o `maximo`; se envolver negócio, risco ou dinheiro, o usuário.',
    '- **Rodadas:** no máximo 2 rodadas de réplica por ponto. Persistindo o desacordo, consulte o\n  `consultor-claude` (`complexo`); se for crítico, peça a segunda consulta em `maximo`; o gerente GPT integra as\n  recomendações e decide. Se envolver negócio, risco ou dinheiro, leve ao usuário.',
    'protocolo de debate',
  ],
]);

const brainBackup = update(brainPath, [
  [
    '> Infraestrutura local para o Claude Code orquestrar uma equipe de especialistas que gasta primeiro a cota dos outros modelos, consulta este cérebro e aparece trabalhando no escritório do Habblaud.',
    '> Infraestrutura local para o GPT, pela interface do Claude Code conectada ao OmniRoute, orquestrar uma equipe de especialistas, consultar este cérebro e aparecer trabalhando no escritório do Habblaud.',
    'resumo da entrega',
  ],
  [
    'Contas: Claude, Codex (ChatGPT), Copilot, 2× Antigravity (Google), Kimi, Cheaper Inference. Combos, todos com\nmodelos baratos primeiro e a assinatura Claude por último:',
    'Contas: Claude, Codex (ChatGPT), Copilot, 2× Antigravity (Google), Kimi, Cheaper Inference. Os combos cotidianos priorizam custo e disponibilidade; o `orquestrador` é exclusivo de GPT, enquanto `complexo` e `maximo` priorizam Claude por serem consultas especializadas:',
    'introdução dos combos',
  ],
  [
    '| `complexo` / `maximo` | decisões difíceis: Opus 4.6 Thinking via Google, GPT-5.5 xhigh / Opus 5.5 |',
    '| `complexo` / `maximo` | consultas difíceis: Claude Opus 4.6 Thinking → Opus 5/5.5 → GPT contingencial / Claude Opus 5.5 → GPT contingencial |',
    'combos de consulta',
  ],
  [
    '2 rodadas por ponto, depois o orquestrador decide (`complexo` → `maximo` → usuário).',
    '2 rodadas por ponto, depois o gerente GPT consulta `consultor-claude` (`complexo` → `maximo`) e decide; questões críticas seguem ao usuário.',
    'debate e segurança',
  ],
]);

console.log(JSON.stringify({ updated: [protocolPath, brainPath], backups: [protocolBackup, brainBackup] }, null, 2));
