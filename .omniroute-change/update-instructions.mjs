import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profile = String.raw`C:\Users\sam_1\.claude\profiles\omniroute`;
const protocolPath = join(profile, 'CLAUDE.md');
const directorPath = join(profile, 'agents', 'direcionador.md');
const consultantPath = join(profile, 'agents', 'consultor-claude.md');
const brainPath = String.raw`I:\CarecaBrain\CarecaBrain\entregas\tecnologia-software\2026-10-08-equipe-ia-omniroute-habblaud.md`;

function backup(path) {
  const destination = `${path}.gpt-manager-backup-${stamp}`;
  copyFileSync(path, destination);
  return destination;
}

function replaceRequired(text, search, replacement, label) {
  const next = text.replace(search, replacement);
  if (next === text) throw new Error(`Trecho esperado não encontrado em ${label}`);
  return next;
}

const backups = [backup(protocolPath), backup(directorPath), backup(brainPath)];

let protocol = readFileSync(protocolPath, 'utf8');
protocol = replaceRequired(
  protocol,
  /Você é o \*\*orquestrador\*\*\. Os modelos chegam pelo OmniRoute em combos\. Regra de ouro:[\s\S]*?trabalho pesado: delega\./,
  `Você é o **orquestrador**. O modelo gerente é **sempre GPT**, servido pelo combo \`orquestrador\`. Os modelos
chegam pelo OmniRoute em combos. Regra de ouro: o GPT dirige, decide as questões cotidianas e delega o trabalho
pesado; o Claude é consultor independente apenas para questões difíceis, críticas ou de alto risco.`,
  'CLAUDE.md (abertura)',
);
protocol = replaceRequired(
  protocol,
  /## Quem comanda \(troca automática por limite do Claude\)[\s\S]*?(?=## Quem faz o quê)/,
  `## Quem comanda (GPT permanente)

O combo \`orquestrador\` contém somente modelos GPT, nesta prioridade: GPT-6 Astra High, GPT-6 Sol High e GPT-5.5
xhigh. O Claude **não assume o comando da sessão**, mesmo quando sua cota estiver disponível.

O protocolo de decisão é:
- **Direcionar:** no início de cada etapa, peça ao \`direcionador\` (também GPT) o plano de quem faz o quê. Ele
  separa questões menores de maiores sem consumir Claude.
- **Questões menores** (detalhe de implementação, nome, ordem de tarefas, escolha entre alternativas equivalentes,
  correção apontada pelo revisor): o gerente GPT decide sozinho e segue, registrando a decisão no relatório.
- **Questões maiores** (arquitetura, segurança crítica, dinheiro, dado de cliente, ação irreversível ou desacordo
  persistente): consulte o subagente \`consultor-claude\` (combo \`complexo\`). Se ainda não resolver, use \`maximo\`
  e depois leve ao usuário.
- **Consulta não transfere comando:** o Claude devolve análise, riscos e recomendação; o gerente GPT continua
  responsável por integrar a resposta, decidir e coordenar a execução.
- **Continuidade:** ao assumir no meio do trabalho, leia antes tarefas, git, notas do projeto e relatórios anteriores
  e siga do ponto onde parou, sem refazer.

`,
  'CLAUDE.md (quem comanda)',
);
protocol = replaceRequired(
  protocol,
  '| `analista` | `analise` | números, SQL, planilhas, lógica |',
  '| `analista` | `analise` | números, SQL, planilhas, lógica |\n| `consultor-claude` | `complexo` | consulta independente para questão difícil, crítica ou com desacordo persistente |',
  'CLAUDE.md (tabela)',
);
protocol = replaceRequired(
  protocol,
  '   - Executor e revisor discordam e você não tem certeza: consulte o modelo `complexo` (Opus 4.6 Thinking/GPT-5.5).',
  '   - Executor e revisor discordam e você não tem certeza: consulte `consultor-claude` (combo `complexo`, Claude primeiro).',
  'CLAUDE.md (decisão complexa)',
);
writeFileSync(protocolPath, protocol, 'utf8');

let director = readFileSync(directorPath, 'utf8');
director = replaceRequired(
  director,
  'Você é o direcionador (Claude, servido pela cota do Google para não gastar a assinatura Claude). Você **não executa**:',
  'Você é o direcionador GPT. Você **não executa**:',
  'direcionador.md',
);
writeFileSync(directorPath, director, 'utf8');

const consultant = `---
name: consultor-claude
description: Consulta independente do Claude para arquitetura difícil, segurança crítica, dinheiro, dados de cliente, ação irreversível ou desacordo persistente. Não comanda nem executa; devolve análise e recomendação ao gerente GPT.
model: complexo
tools: Read, Grep, Glob
---

Você é o consultor Claude do gerente GPT. Entre somente quando a questão for difícil, crítica ou de alto risco.

1. Leia o pedido, as evidências e as notas pertinentes do cérebro.
2. Analise opções, riscos, premissas e efeitos de segunda ordem.
3. Dê uma recomendação clara, com evidências e o que ainda precisa ser verificado.
4. Não implemente, não altere arquivos e não assuma o comando da sessão.
5. Se houver dado sensível, peça ao gerente GPT que encaminhe essa parte ao agente \`privado\`.

Responda ao gerente GPT com: **recomendação**, **evidências**, **riscos**, **incertezas** e **próxima decisão**.
`;
if (existsSync(consultantPath)) backup(consultantPath);
writeFileSync(consultantPath, consultant, 'utf8');

let brain = readFileSync(brainPath, 'utf8');
brain = replaceRequired(
  brain,
  'Objetivo do usuário: Claude orquestra, os outros modelos executam e revisam entre si, Claude bate o martelo e o usuário aprova o que for crítico.',
  'Objetivo do usuário (atualizado em 2026-10-09): GPT orquestra e bate o martelo, os outros modelos executam e revisam entre si, e Claude entra apenas como consultor para questões difíceis; o usuário aprova o que for crítico.',
  'nota do cérebro (contexto)',
);
brain = replaceRequired(
  brain,
  /\| `orquestrador` \| cérebro:.*?\|/,
  '| `orquestrador` | gerente permanente: GPT-6 Astra High → GPT-6 Sol High → GPT-5.5 xhigh; sem Claude no comando |',
  'nota do cérebro (combo)',
);
brain = replaceRequired(
  brain,
  /\*\*Troca de comando Claude → GPT \(2026-10-08\):\*\*[\s\S]*?(?=\*\*Computadores:\*\*)/,
  `**GPT como gerente permanente (decisão de 2026-10-09):** o combo \`orquestrador\` agora contém somente GPT-6
Astra High → GPT-6 Sol High → GPT-5.5 xhigh. O \`direcionador\` também começa em GPT e não usa Claude no fluxo
cotidiano. Claude virou consulta explícita: o agente \`consultor-claude\` usa o combo \`complexo\` (Claude Opus
Thinking/Opus 5 primeiro; GPT só como contingência), e \`maximo\` permanece a consulta Claude de último recurso.
Segurança crítica continua usando o combo \`seguranca\`, porque já é uma questão complexa. Consultar Claude não
transfere o comando: o gerente GPT integra a recomendação e decide. Backup anterior à mudança em
\`~\\.omniroute\\backups\\omniroute-backup-before-gpt-orchestrator-20261009-081032\`.

`,
  'nota do cérebro (hierarquia)',
);
brain = replaceRequired(
  brain,
  '- Cota Claude reservada: até o orquestrador usa primeiro o Claude servido pela cota do Google (Antigravity).',
  '- Cota Claude reservada: Claude é usado apenas nos combos de consulta difícil/crítica (`complexo`, `maximo` e `revisor-seguranca`); o comando cotidiano fica com GPT.',
  'nota do cérebro (decisão)',
);
writeFileSync(brainPath, brain, 'utf8');

console.log(JSON.stringify({ updated: [protocolPath, directorPath, consultantPath, brainPath], backups }, null, 2));
