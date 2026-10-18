import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cerebro');
const user = 'C:/Users/sam_1', app = 'I:/Cerebro', vscode = user + '/AppData/Roaming/Code/User';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = app + '/backups/memoria-' + stamp;
const changes = new Map();
const protocol = fs.readFileSync(path.join(src, 'MEMORIA-COMPARTILHADA.md'), 'utf8');
function read(file, fallback = '') { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback; }
function block(file, content) {
  const begin = '<!-- cerebro-compartilhado:inicio -->', end = '<!-- cerebro-compartilhado:fim -->';
  const old = read(file);
  const section = `${begin}\n${content}\n${end}`;
  const start = old.indexOf(begin), finish = old.indexOf(end);
  if (start >= 0 && finish < start) throw new Error('Bloco incompleto em ' + file);
  // só o marcador sozinho na linha: uma menção em texto (ex.: CLAUDE.md) partia a frase ao meio
  const generated = old.search(/^<!-- cerebro-links -->[ \t]*$/m);
  changes.set(file, start >= 0 ? old.slice(0, start) + section + old.slice(finish + end.length)
    : generated >= 0 ? old.slice(0, generated).trimEnd() + '\n\n' + section + '\n\n' + old.slice(generated)
    : old.trimEnd() + '\n\n' + section + '\n');
}
function json(file, update) {
  const raw = read(file, '{}');
  const value = raw.trim() ? JSON.parse(raw) : {};
  update(value);
  changes.set(file, JSON.stringify(value, null, 2) + '\n');
}
const server = { command: 'I:/Node.JS/node.exe', args: ['I:/Cerebro/mcp.mjs'] };
const ignore = read(app + '/.gitignore');
if (!ignore.includes('/backups/')) changes.set(app + '/.gitignore', ignore.trimEnd() + '\n\n# Backups pessoais de configuração (podem conter credenciais)\n/backups/\n/.test-data/\n');
for (const file of ['omniroute.mjs', 'ponte.mjs', 'memoria.mjs', 'mcp.mjs', 'cerebro-cli.mjs', 'motor.mjs', 'server.js', 'MEMORIA-COMPARTILHADA.md', 'memoria.test.mjs']) changes.set(app + '/' + file, fs.readFileSync(path.join(src, file), 'utf8'));

json(vscode + '/mcp.json', cfg => { cfg.servers ??= {}; cfg.servers.cerebro = { type: 'stdio', ...server }; });
json(user + '/.gemini/config/mcp_config.json', cfg => { cfg.mcpServers ??= {}; cfg.mcpServers.cerebro = server; });
json(vscode + '/settings.json', cfg => {
  cfg['chat.instructionsFilesLocations'] = { ...cfg['chat.instructionsFilesLocations'], [vscode + '/instructions']: true };
  cfg['chat.agentFilesLocations'] = { ...cfg['chat.agentFilesLocations'], [vscode + '/agents']: true };
  cfg['omnicopilot.baseUrl'] = 'http://localhost:20128';
  cfg['omnicopilot.exposeToAgentsWindow'] = true;
});
const instruction = vscode + '/instructions/cerebro-compartilhado.instructions.md';
changes.set(instruction, '---\nname: "Cérebro compartilhado"\ndescription: "Memória consolidada de projetos: consultar antes, registrar aprendizado verificado depois, em toda IA."\napplyTo: "**"\n---\n\n' + protocol);
for (const name of ['coordenador', 'aprimorador', 'pesquisador', 'executor', 'revisor', 'revisor-seguranca']) {
  const file = vscode + '/agents/' + name + '.agent.md';
  if (!fs.existsSync(file)) throw new Error('Agente esperado ausente: ' + file);
  const toolNames = name === 'coordenador' ? ['cerebro/*'] : ['cerebro/cerebro_buscar', 'cerebro/cerebro_ler_nota', 'cerebro/cerebro_rotear'];
  let body = read(file).replace(/^tools:\s*\[([^\]]*)\]/m, (line, list) => `tools: [${list}${toolNames.filter(n => !list.includes(n)).map(n => ', "' + n + '"').join('')}]`);
  const marker = '<!-- memoria-agente -->';
  if (!body.includes(marker)) body += `\n${marker}\nAntes da tarefa, consulte cerebro_buscar e leia as notas do projeto. Use o contexto histórico como referência, validando se continua atual. Ao devolver o resultado, inclua aprendizados candidatos e evidências para o coordenador registrar uma única vez via cerebro_registrar. Siga I:/Cerebro/MEMORIA-COMPARTILHADA.md.\n`;
  changes.set(file, body);
}

const codexConfig = user + '/.codex/config.toml';
let toml = read(codexConfig);
const table = '[mcp_servers.cerebro]\ncommand = "I:/Node.JS/node.exe"\nargs = ["I:/Cerebro/mcp.mjs"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 210\n';
if (/^\[mcp_servers\.cerebro\]/m.test(toml)) toml = toml.replace(/^\[mcp_servers\.cerebro\][\s\S]*?(?=^\[|$(?![\s\S]))/m, table + '\n');
else toml = toml.trimEnd() + '\n\n' + table;
changes.set(codexConfig, toml);
block(user + '/.codex/AGENTS.md', protocol);
block(user + '/.claude/CLAUDE.md', protocol);
block(user + '/.copilot/copilot-instructions.md', protocol);
for (const file of [user + '/.claude.json', user + '/.claude/profiles/omniroute/.claude.json']) json(file, cfg => {
  cfg.mcpServers ??= {}; cfg.mcpServers.cerebro = { type: 'stdio', ...server };
});
json(user + '/.copilot/mcp-config.json', cfg => { cfg.mcpServers ??= {}; cfg.mcpServers.cerebro = { type: 'stdio', ...server, tools: ['*'] }; });
const desktop = user + '/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json';
if (fs.existsSync(desktop)) json(desktop, cfg => { cfg.mcpServers ??= {}; cfg.mcpServers.cerebro = server; });

const vault = 'I:/CarecaBrain/CarecaBrain';
changes.set(vault + '/conhecimento/memoria-compartilhada-ia.md', '---\ntype: processo\ntitle: "Memória compartilhada entre IAs"\ndata: 2026-10-09\n---\n\n' + protocol + '\n\n↩ [[CEREBRO]]\n');
block(vault + '/CEREBRO.md', '## Memória compartilhada de projetos\n\n- [[conhecimento/memoria-compartilhada-ia|Protocolo comum: VS Code, Codex e Claude]]\n- Aprendizados verificados: `conhecimento/sessoes-compartilhadas/`, pesquisáveis pela ferramenta `cerebro_buscar`.\n- O VS Code é a central de trabalho; os clientes compartilham a mesma base local.');

const launcher = `$ErrorActionPreference = 'Stop'\ntry {\n  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4500/api/motor' -TimeoutSec 2\n  if ($health.omniroute) { exit 0 }\n} catch {}\nStart-Process -FilePath 'I:\\Node.JS\\node.exe' -ArgumentList 'I:/Cerebro/server.js' -WorkingDirectory 'I:\\Cerebro' -WindowStyle Hidden -RedirectStandardOutput 'I:\\Cerebro\\dados\\servidor.log' -RedirectStandardError 'I:\\Cerebro\\dados\\servidor-erro.log'\n`;
changes.set(app + '/iniciar-cerebro.ps1', launcher);
const startup = user + '/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/Cerebro.vbs';
changes.set(startup, 'Set shell = CreateObject("WScript.Shell")\nshell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""I:\\Cerebro\\iniciar-cerebro.ps1""", 0, False\n');

const pending = [...changes].filter(([file, content]) => read(file) !== content);
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'preview', files: pending.map(([file]) => file), backup }, null, 2));
} else {
  fs.mkdirSync(backup, { recursive: true });
  const manifest = [];
  for (const [file, content] of pending) {
    const saved = fs.existsSync(file) ? path.join(backup, String(manifest.length).padStart(3, '0') + '-' + path.basename(file)) : null;
    if (saved) fs.copyFileSync(file, saved);
    manifest.push({ file, backup: saved });
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  console.log(JSON.stringify({ installed: manifest.map(x => x.file), backup }, null, 2));
}
