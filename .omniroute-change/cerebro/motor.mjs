// Motor de execução: abstrai qual LLM responde. Detecta o que a máquina tem
// e expõe uma única função `executar` que emite pedaços de texto (streaming).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { estadoOmni, viaOmni } from './omniroute.mjs';

const CLI_DIR = 'C:/Users/sam_1/AppData/Roaming/Claude/claude-code';

function acharCli() {
  if (process.env.CEREBRO_CLI && fs.existsSync(process.env.CEREBRO_CLI)) return process.env.CEREBRO_CLI;
  if (!fs.existsSync(CLI_DIR)) return null;
  // pega a versão mais recente instalada
  const vs = fs.readdirSync(CLI_DIR).filter(v => fs.existsSync(path.join(CLI_DIR, v, 'claude.exe')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return vs.length ? path.join(CLI_DIR, vs[0], 'claude.exe') : null;
}

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

export async function motores() {
  const cli = acharCli();
  let ollamaOk = false, modelos = [];
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(1200) });
    if (r.ok) { modelos = (await r.json()).models?.map(m => m.name) || []; ollamaOk = modelos.length > 0; }
  } catch {}
  return {
    omniroute: await estadoOmni(),
    api: { ok: !!process.env.ANTHROPIC_API_KEY, rotulo: 'Claude API',
      obs: process.env.ANTHROPIC_API_KEY ? 'chave presente' : 'defina ANTHROPIC_API_KEY' },
    cli: { ok: !!cli, rotulo: 'Claude Code CLI', caminho: cli || '',
      obs: cli ? 'requer login feito uma vez (rode "claude" no terminal)' : 'CLI não encontrado' },
    ollama: { ok: ollamaOk, rotulo: 'Ollama local', modelos,
      obs: ollamaOk ? modelos.join(', ') : 'sem modelo baixado (ex.: ollama pull qwen2.5:7b)' },
  };
}

export async function escolher(m) {
  m = m || await motores();
  if (m.omniroute?.ok) return 'omniroute';
  return null;
}

/** Motores + qual seria usado no modo automático (o app mostra este). */
export async function estado() {
  const m = await motores();
  return { ...m, escolhido: await escolher(m) };
}

/* ---------- backends ---------- */

/** Monta o conteúdo do turno do usuário: imagens viram blocos de visão, texto vira contexto. */
function conteudoUsuario(tarefa, anexos = [], comVisao = true) {
  const blocos = [];
  const textos = anexos.filter(a => a.tipo === 'texto');
  const imgs = anexos.filter(a => a.tipo === 'imagem');
  const falhas = anexos.filter(a => a.tipo === 'nao-lido');

  if (comVisao) for (const im of imgs)
    blocos.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } });

  let txt = '';
  if (textos.length) {
    txt += '=== ARQUIVOS ANEXADOS (contexto) ===\n\n' + textos.map(a =>
      `--- ${a.nome} ---\n${a.texto}${a.cortado ? '\n[…arquivo cortado por tamanho]' : ''}`).join('\n\n') + '\n\n';
  }
  if (imgs.length) {
    txt += comVisao
      ? `(${imgs.length} imagem(ns) anexada(s): ${imgs.map(i => i.nome).join(', ')}. Use como referência visual e de marca.)\n\n`
      : `(${imgs.length} imagem(ns) anexada(s), mas este motor não enxerga imagem: ${imgs.map(i => i.nome).join(', ')}.)\n\n`;
  }
  if (falhas.length) txt += falhas.map(f => `(anexo "${f.nome}" não lido: ${f.motivo})`).join('\n') + '\n\n';
  txt += '=== TAREFA ===\n' + tarefa;

  blocos.push({ type: 'text', text: txt });
  return { blocos, texto: txt };
}

async function* viaApi({ sistema, tarefa, modelo, anexos }) {
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelo || process.env.CEREBRO_MODELO || 'claude-sonnet-4-5-20250929',
      max_tokens: 8192, stream: true,
      system: sistema,
      messages: [{ role: 'user', content: conteudoUsuario(tarefa, anexos, true).blocos }],
    }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const linhas = buf.split('\n'); buf = linhas.pop();
    for (const l of linhas) {
      if (!l.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(l.slice(6));
        if (d.type === 'content_block_delta' && d.delta?.text) yield d.delta.text;
      } catch {}
    }
  }
}

async function* viaOllama({ sistema, tarefa, modelo, anexos }) {
  const mods = (await motores()).ollama.modelos;
  const mod = modelo || process.env.CEREBRO_MODELO_LOCAL || mods[0];
  const visao = /llava|vision|llama3\.2-vision|minicpm|moondream|qwen2?\.?5?-?vl/i.test(mod);
  const { texto } = conteudoUsuario(tarefa, anexos, visao);
  const msg = { role: 'user', content: texto };
  if (visao) {
    const imgs = (anexos || []).filter(a => a.tipo === 'imagem').map(a => a.base64);
    if (imgs.length) msg.images = imgs;
  }
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: mod, stream: true,
      messages: [{ role: 'system', content: sistema }, msg] }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const linhas = buf.split('\n'); buf = linhas.pop();
    for (const l of linhas) {
      if (!l.trim()) continue;
      try { const d = JSON.parse(l); if (d.message?.content) yield d.message.content; } catch {}
    }
  }
}

async function* viaCli({ sistema, tarefa, anexos, caminhos = [] }) {
  const cli = acharCli();
  if (!cli) throw new Error('CLI não encontrado');
  // o CLI lê arquivos do disco: passamos os caminhos e ele abre o que precisar
  const { texto } = conteudoUsuario(tarefa, (anexos || []).filter(a => a.tipo !== 'imagem'), false);
  const comCaminhos = caminhos.length
    ? texto + '\n\n=== ARQUIVOS NO DISCO (leia se precisar) ===\n' + caminhos.map(c => '- ' + c).join('\n')
    : texto;
  const p = spawn(cli, ['-p', comCaminhos, '--append-system-prompt', sistema], {
    cwd: 'I:/Cerebro', windowsHide: true,
    env: { ...process.env, CLAUDE_FLOW_HOOKS_ENABLED: 'false' },
  });
  const fila = []; let fim = false, erro = null;
  const olhar = s => {
    // o CLI reporta falta de login pelo stdout, como se fosse resposta
    if (/not logged in|please run \/login/i.test(s))
      erro = 'CLI do Claude sem login. Abra um terminal, rode "claude", faça o login uma vez e tente de novo.';
    else if (/has not been trusted|trust dialog/i.test(s))
      erro = 'CLI do Claude sem permissão nesta pasta. Rode "claude" uma vez em I:\\Cerebro e aceite o diálogo de confiança.';
  };
  p.stdout.on('data', d => { const s = d.toString(); olhar(s); if (!erro) fila.push(s); });
  p.stderr.on('data', d => olhar(d.toString()));
  p.on('error', e => { erro = 'não consegui iniciar o CLI: ' + e.message; fim = true; });
  p.on('close', () => { fim = true; });
  while (!fim || fila.length) {
    if (erro) throw new Error(erro);
    if (fila.length) yield fila.shift();
    else await new Promise(r => setTimeout(r, 60));
  }
  if (erro) throw new Error(erro);
}

/** Executa a tarefa com o prompt do agente como sistema. Devolve um async iterator de texto. */
export async function* executar({ sistema, tarefa, motor, modelo, anexos, caminhos }) {
  const m = motor && motor !== 'auto' ? motor : await escolher();
  if (!m) throw new Error('OmniRoute indisponível. Verifique o gateway local e o combo orquestrador.');
  if (m === 'omniroute') {
    yield* viaOmni({ sistema, tarefa, modelo: modelo || 'orquestrador', blocos: conteudoUsuario(tarefa, anexos, true).blocos });
    return;
  }
  const fn = { api: viaApi, ollama: viaOllama, cli: viaCli }[m];
  if (!fn) throw new Error('motor desconhecido: ' + m);
  yield* fn({ sistema, tarefa, modelo, anexos, caminhos });
}
