import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

async function sessao(calls) {
  const proc = spawn('I:/Node.JS/node.exe', ['I:/Cerebro/mcp.mjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', error = '', id = 0;
  const pending = new Map();
  proc.stdout.on('data', bytes => {
    buffer += bytes.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(response.id)?.(response); pending.delete(response.id);
    }
  });
  proc.stderr.on('data', chunk => { error += chunk; });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const rid = ++id;
      const timer = setTimeout(() => { pending.delete(rid); reject(new Error('Tempo excedido no MCP: ' + method)); }, 60000);
      pending.set(rid, response => { clearTimeout(timer); response.error ? reject(new Error(response.error.message)) : resolve(response.result); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
    });
  }
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'validacao-local', version: '1' } });
    assert.equal(init.serverInfo.name, 'cerebro-omniroute');
    const tools = await rpc('tools/list'); assert.equal(tools.tools.length, 6);
    const results = [];
    for (const [name, args] of calls) {
      const r = await rpc('tools/call', { name, arguments: args });
      assert.ok(!r.isError, r.content[0].text);
      results.push(JSON.parse(r.content[0].text));
    }
    assert.equal(error, ''); return results;
  } finally { proc.stdin.end(); proc.kill(); }
}

const projeto = 'Cérebro compartilhado';
const clients = [
  ['VS Code', 'C:/Users/sam_1/AppData/Roaming/Code/User/mcp.json', 'servers'],
  ['Antigravity', 'C:/Users/sam_1/.gemini/config/mcp_config.json', 'mcpServers'],
  ['Claude Code', 'C:/Users/sam_1/.claude.json', 'mcpServers'],
  ['Claude OmniRoute', 'C:/Users/sam_1/.claude/profiles/omniroute/.claude.json', 'mcpServers'],
  ['Copilot CLI', 'C:/Users/sam_1/.copilot/mcp-config.json', 'mcpServers'],
  ['Claude Desktop', 'C:/Users/sam_1/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json', 'mcpServers'],
];
for (const [name, file, key] of clients) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))[key].cerebro;
  assert.equal(cfg.args[0], 'I:/Cerebro/mcp.mjs', name);
}
const config = fs.readFileSync('C:/Users/sam_1/.codex/config.toml', 'utf8');
assert.equal((config.match(/^\[mcp_servers\.cerebro\]/gm) || []).length, 1);
const response = await fetch('http://127.0.0.1:4500/api/motor');
const motors = await response.json(); assert.equal(motors.escolhido, 'omniroute');
const [route] = await sessao([['cerebro_rotear', {
  tarefa: 'Construir integração de software com TypeScript, MCP, OmniRoute, VS Code, Codex, Antigravity e Claude.',
}]]);
assert.ok(route.resultados.some(r => r.setor === 'tecnologia-software' || r.id === 'skill/pessoais/engenheiro-senior'));
const [saved] = await sessao([['cerebro_registrar', {
  id: '2026-10-09-vscode-central-memoria-v3', projeto, origem: 'vscode-codex', tipo: 'aprendizado',
  titulo: 'VS Code centraliza o trabalho; Cérebro compartilha conhecimento entre IAs',
  resumo: 'Complementa as notas anteriores conhecimento/sessoes-compartilhadas/33bec8686e9b20ac784d761b4735e2e9.md e conhecimento/sessoes-compartilhadas/949e8020a3a93cfd0fc286e9b2325002.md. Corrige a evidência da v2: o script de validação está em `.omniroute-change/validar-memoria-instalada.mjs` no workspace, não em I:/Cerebro. Preserva a decisão do usuário de usar o Cérebro como memória comum e o VS Code como central. A ponte MCP e instruções de consulta/roteamento/registro estão configuradas para VS Code, Codex, Antigravity, Claude Code, Claude Desktop e Copilot CLI. Nesta execução, initialize MCP respondeu, os arquivos dos clientes foram conferidos, o motor local foi confirmado como omniroute, e cerebro_rotear para TypeScript/MCP retornou especialistas de tecnologia/software. Os resultados do roteador são candidatos; termos genéricos podem gerar falsos positivos, portanto valide domínio, tipo, setor e atribuições antes de selecionar. A política global mapeia o tipo de trabalho aos combos especializados e mantém GPT/orquestrador como gerente; modelos consultam, o agente atual executa. Verificação de código: typecheck, 11 testes da ponte e 26 testes HTTP passaram; a suíte completa ainda apresenta 26 falhas, portanto a afirmação da primeira nota de que 72 testes do app passaram não está confirmada nesta execução. Sessões novas/recarregadas precisam carregar o MCP e podem solicitar autorização; o setup não importa conversas anteriores nem captura chats invisivelmente.',
  evidencias: ['Pedido explícito do usuário nesta sessão: VS Code como central e memória consolidada entre IAs.', 'I:/Cerebro/MEMORIA-COMPARTILHADA.md e instruções globais instaladas para os clientes listados.', 'Rota local cerebro_rotear com query de TypeScript/MCP retornou tecnologia-software/engenheiro-senior; `.omniroute-change/validar-memoria-instalada.mjs` verifica essa seleção.', 'npm run typecheck: aprovado; node --test .omniroute-change/cerebro/memoria.test.mjs: 11 aprovados; npm test -- --run server/http/http.test.ts: 26 aprovados.', 'npm test -- --run: 26 falhas remanescentes em outros testes.'],
}]]);
const [found] = await sessao([['cerebro_buscar', { consulta: 'VS Code centraliza conhecimento', projeto }]]);
assert.ok(found.resultados.some(r => r.nota === saved.nota));
const [read] = await sessao([['cerebro_ler_nota', { nota: saved.nota }]]);
assert.ok(read.conteudo.includes('Os resultados do roteador são candidatos'));
console.log(JSON.stringify({ memoriaEntreProcessos: 'OK', nota: saved.nota, clientesConfigurados: [...clients.map(c => c[0]), 'Codex'], rotaSoftware: 'OK', motorApp: motors.escolhido }, null, 2));
