import readline from 'node:readline';
import { chamar, ferramentas } from './ponte.mjs';

// MCP stdio: uma mensagem JSON-RPC por linha; stdout reservado ao protocolo.
function send(id, result, error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n'); }
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let req;
  try { if (line.length > 100000) throw new Error(); req = JSON.parse(line); }
  catch { send(null, null, { code: -32700, message: 'JSON inválido ou grande demais.' }); return; }
  if (!req || typeof req !== 'object' || Array.isArray(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string' || (req.id !== undefined && typeof req.id !== 'string' && typeof req.id !== 'number')) {
    send(null, null, { code: -32600, message: 'Requisição JSON-RPC inválida.' }); return;
  }
  if (req.id === undefined) return;
  if (req.method === 'initialize') return send(req.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cerebro-omniroute', version: '1.0.0' }, instructions: 'Cérebro é a memória consolidada dos projetos, compartilhada por VS Code, Codex, Antigravity e Claude. Antes de trabalhar use cerebro_buscar com projeto/tarefa e cerebro_rotear com contexto concreto de projeto, domínio, stack e tipo de trabalho; valide setor e atribuições dos resultados e descarte falsos positivos genéricos. O Jarvis (combo gerente-jarvis, local) é o gerente no Habblaud e na voz; nas sessões o combo orquestrador (nuvem com failover até o local) coordena; o agente aprimorador refina a demanda; executores executor-claude/executor-codex/executor-antigravity/executor-copilot executam e o usuário dá a palavra final. Para consulta de modelo via cerebro_consultar, escolha por entrega: código/debug/testes=codigo ou codigo-pesado; revisão=revisor; segurança=revisor-seguranca; pesquisa/análise=analise ou contexto-longo; texto=texto; arquitetura difícil=complexo ou maximo; tarefa simples=rapido; dado sensível=processador-privado-local. Leia notas pertinentes. Ao concluir registre conhecimento verificado via cerebro_registrar com projeto, origem, ID e evidências. OmniRoute consulta modelos; não executa ferramentas nem intercepta chats; as ferramentas são usadas pelo agente da sessão atual. Nunca envie dados sensíveis para combos de nuvem.' });
  if (req.method === 'ping') return send(req.id, {});
  if (req.method === 'tools/list') return send(req.id, { tools: ferramentas });
  if (req.method === 'tools/call') {
    try { const result = await chamar(req.params?.name, req.params?.arguments); send(req.id, { content: [{ type: 'text', text: JSON.stringify(result) }] }); }
    catch (e) { send(req.id, { isError: true, content: [{ type: 'text', text: e.message }] }); }
    return;
  }
  send(req.id, null, { code: -32601, message: 'Método não encontrado.' });
});
