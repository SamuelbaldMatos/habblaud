// Bateria de testes do Cérebro. Roda com o servidor no ar: node teste.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.CEREBRO_URL || 'http://localhost:4500';
const IDX = 'I:/CarecaBrain/_ferramentas/capacidades.json';

let ok = 0, falha = 0;
const erros = [];
const t = (nome, cond, detalhe = '') => {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); }
  else { falha++; erros.push(nome + (detalhe ? ' — ' + detalhe : '')); console.log(`  ✗ ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
};
const secao = s => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`);
const api = async (p, o) => { const r = await fetch(BASE + p, o); return { st: r.status, j: await r.json().catch(() => null) }; };

/* ═════ 1. índice ═════ */
secao('ÍNDICE DE CAPACIDADES');
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const caps = idx.capacidades;
t('arquivo existe e parseia', !!caps?.length, `${caps?.length} capacidades`);
t('todos têm id único', new Set(caps.map(c => c.id)).size === caps.length,
  `${caps.length - new Set(caps.map(c => c.id)).size} duplicados`);
t('todos têm nome', caps.every(c => c.nome?.trim()));
t('todos têm tipo', caps.every(c => c.tipo));
t('todos têm termos de busca', caps.every(c => Array.isArray(c.termos) && c.termos.length));
const agentes = caps.filter(c => c.tipo === 'agente');
t('288 agentes', agentes.length === 288, `achei ${agentes.length}`);
t('todo agente tem prompt portátil', agentes.every(c => c.prompt_portatil?.length > 200),
  `${agentes.filter(c => !(c.prompt_portatil?.length > 200)).length} sem`);
t('prompt não contém risco de emprego', !agentes.some(c => /risco de (substitui|automa)/i.test(c.prompt_portatil)));
const procs = caps.filter(c => c.tipo === 'processo');
t('6 processos com sequência', procs.length === 6 && procs.every(p => p.sequencia?.length >= 5),
  procs.map(p => p.sequencia?.length).join(','));
const skills = caps.filter(c => c.tipo === 'skill');
t('skills sem duplicata de nome', new Set(skills.map(s => s.nome.toLowerCase())).size === skills.length,
  `${skills.length - new Set(skills.map(s => s.nome.toLowerCase())).size} repetidos`);
t('skills de domínio marcadas', skills.filter(s => s.dominio).length >= 8,
  `${skills.filter(s => s.dominio).length} com domínio`);
t('nenhuma capacidade cita cliente real',
  !caps.some(c => /dubairro|unineuro|shineray|marmobraz|brilasa|syntonia/i.test(JSON.stringify(c))));

/* ═════ 2. roteador ═════ */
secao('ROTEADOR (ranking)');
const { pontuar } = await import(pathToFileURL('I:/CarecaBrain/_ferramentas/roteador.mjs').href);
const casos = [
  ['analisar avarias do supermercado e sugerir compra', 'processo', /Winthor/i],
  ['criar descricao de cargo de enfermeiro', 'processo', /cargo/i],
  ['revisar contrato de fornecedor', 'skill', /review-contract/i],
  ['configurar funil de vendas no CRM', 'skill', /kommo/i],
  ['integrar discador e voicebot no contact center', 'skill', /nexcore/i],
  ['montar plano de cobranca de inadimplentes', 'processo', /faturamento/i],
  ['escrever roteiro de video para instagram', null, /roteiro|conteudo|copy|social/i],
  ['laudo de tomografia no PACS', 'skill', /animati|pacs/i],
  ['planilha com analise de estoque', null, /xlsx|dados|estoque|planilha/i],
  ['disparar mensagem no whatsapp para a base', 'skill', /zappfy/i],
  ['reduzir glosa de convenio', null, /saude|clinica|faturamento|glosa/i],
  ['recurso de glosa TISS', null, /saude|clinica|faturamento/i],
  ['tratar devolucao e avaria', 'processo', /devolu|avaria|logist/i],
  ['inventario de estoque na loja', null, /estoque|invent|almox/i],
];
for (const [q, tipoEsp, re] of casos) {
  const r = pontuar(caps, q, 5);
  const top = r[0];
  const achou = r.slice(0, 3).some(x => re.test(x.nome));
  t(`"${q.slice(0, 42)}…"`, achou,
    achou ? '' : `top3: ${r.slice(0, 3).map(x => x.nome).join(' | ') || '(vazio)'}`);
  if (achou && tipoEsp && top.tipo !== tipoEsp) console.log(`      (nota: 1º é ${top.tipo}, esperava ${tipoEsp})`);
}
t('busca vazia devolve nada', pontuar(caps, '', 5).length === 0);
t('busca sem sentido devolve pouco', pontuar(caps, 'xyzzy plugh', 5).length <= 2);

/* ═════ 3. API ═════ */
secao('API DO SERVIDOR');
const resumo = await api('/api/resumo');
t('GET /api/resumo', resumo.st === 200 && resumo.j?.total > 400, `total=${resumo.j?.total}`);
const rot = await api('/api/rotear?q=' + encodeURIComponent('revisar contrato'));
t('GET /api/rotear', rot.st === 200 && rot.j?.resultados?.length > 0);
t('rotear não vaza prompt', !JSON.stringify(rot.j).includes('COMO OPERAR'));
const mapa = await api('/api/mapa');
t('GET /api/mapa', mapa.st === 200 && mapa.j?.departamentos?.length === 18);
t('mapa traz agentes por setor', mapa.j.departamentos.every(d => d.agentes?.length > 0));
t('mapa traz cor por setor', mapa.j.departamentos.every(d => /^#[0-9a-f]{6}$/i.test(d.cor)));
const umAg = mapa.j.departamentos[0].agentes[0];
const cap1 = await api('/api/cap?id=' + encodeURIComponent(umAg.id));
t('GET /api/cap devolve prompt', cap1.st === 200 && cap1.j?.prompt_portatil?.length > 200);
const cap404 = await api('/api/cap?id=naoexiste');
t('GET /api/cap inexistente → 404', cap404.st === 404);
const mot = await api('/api/motor');
t('GET /api/motor', mot.st === 200 && ['api', 'cli', 'ollama'].every(k => k in mot.j));
console.log('      motores:', Object.entries(mot.j).map(([k, v]) => `${k}=${v.ok ? 'ok' : '—'}`).join(' '));

/* ═════ 4. arquivos ═════ */
secao('ANEXOS');
const arq = await import(pathToFileURL('I:/Cerebro/arquivos.mjs').href);
const tmp = 'I:/Cerebro/dados/_teste';
fs.mkdirSync(tmp, { recursive: true });
const escreve = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c); return p; };

const pTxt = escreve('a.txt', 'linha um\nlinha dois');
t('.txt lido', arq.interpretar(pTxt, 'a.txt').texto?.includes('linha dois'));
const pCsv = escreve('b.csv', 'nome,valor\nx,10');
t('.csv lido', arq.interpretar(pCsv, 'b.csv').texto?.includes('x,10'));
const pJson = escreve('c.json', '{"a":1}');
t('.json lido', arq.interpretar(pJson, 'c.json').texto?.includes('"a":1'));
const pPdf = escreve('d.pdf', '%PDF-1.4');
const rPdf = arq.interpretar(pPdf, 'd.pdf');
t('.pdf recusado com motivo claro', rPdf.tipo === 'nao-lido' && /pdf/i.test(rPdf.motivo));
const pExe = escreve('e.zzz', 'x');
t('formato desconhecido recusado', arq.interpretar(pExe, 'e.zzz').tipo === 'nao-lido');
const docx = 'C:/Users/sam_1/OneDrive/Desktop/Análise e Reestruturação do CRM.docx';
if (fs.existsSync(docx)) {
  const r = arq.interpretar(docx, 'x.docx');
  t('.docx extraído', r.tipo === 'texto' && r.texto.length > 1000, `${r.texto?.length} chars`);
} else console.log('  · .docx: sem arquivo de teste');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pPng = path.join(tmp, 'f.png'); fs.writeFileSync(pPng, png);
const rPng = arq.interpretar(pPng, 'f.png');
t('.png vira imagem base64', rPng.tipo === 'imagem' && rPng.mime === 'image/png' && rPng.base64.length > 20);
const pGrande = escreve('g.txt', 'x'.repeat(90000));
t('arquivo grande é cortado', arq.interpretar(pGrande, 'g.txt').cortado === true);
const pCorrompido = path.join(tmp, 'h.docx'); fs.writeFileSync(pCorrompido, 'nao é zip');
t('docx corrompido não derruba', arq.interpretar(pCorrompido, 'h.docx').tipo === 'nao-lido');

const up = await api('/api/upload', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ arquivos: [{ nome: 'teste-api.txt', base64: Buffer.from('conteudo de teste').toString('base64') }] }) });
t('POST /api/upload', up.st === 200 && up.j?.arquivos?.[0]?.tipo === 'texto');
t('upload salva em disco', up.j?.arquivos?.[0] && fs.existsSync(up.j.arquivos[0].arquivo));
t('upload sanitiza nome', !/[/\\]/.test(up.j?.arquivos?.[0]?.nome || 'x/y'));

/* ═════ 5. marca ═════ */
secao('MARCA');
const antes = arq.lerMarca();
const teste = { nome: 'Teste SA', publico: 'testers', tom: 'seco', cores: ['#111111'], evitar: 'nada' };
const pm = await api('/api/marca', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(teste) });
t('POST /api/marca', pm.st === 200);
const gm = await api('/api/marca');
t('GET /api/marca persiste', gm.j?.nome === 'Teste SA');
const bloco = arq.blocoMarca(gm.j);
t('bloco de marca é montado', bloco.includes('Teste SA') && bloco.includes('NÃO FAZER'));
t('marca vazia não gera bloco', arq.blocoMarca({}) === '');
await api('/api/marca', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(antes) });
t('marca original restaurada', (await api('/api/marca')).j?.nome === antes.nome);

/* ═════ 6. execução ═════ */
secao('EXECUÇÃO');
const exec404 = await fetch(BASE + '/api/executar', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'naoexiste', tarefa: 'x' }) });
t('executar com id inválido → 404', exec404.status === 404);
const execRuim = await fetch(BASE + '/api/executar', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: 'nao é json' });
t('executar com json inválido → 400', execRuim.status === 400);

const algum = caps.find(c => c.tipo === 'agente');
const r = await fetch(BASE + '/api/executar', { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: algum.id, tarefa: 'Responda apenas: OK' }) });
t('executar abre stream SSE', r.headers.get('content-type')?.includes('event-stream'));
// lê incrementalmente e para no 1º desfecho: modelo local frio pode levar minutos
const lido = await (async () => {
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = ''; const evs = new Set();
  const prazo = setTimeout(() => rd.cancel().catch(() => {}), 120000);
  try {
    while (true) {
      const { done, value } = await rd.read(); if (done) break;
      const s = dec.decode(value, { stream: true }); buf += s;
      for (const m of s.matchAll(/^event: (\w+)/gm)) evs.add(m[1]);
      if (evs.has('fim') || evs.has('erro')) break;
    }
  } catch {}
  clearTimeout(prazo); rd.cancel().catch(() => {});
  return { buf, evs };
})();
t('stream emite evento inicio', lido.evs.has('inicio'));
t('stream emite texto ou erro tratado', lido.evs.has('texto') || lido.evs.has('erro'),
  lido.evs.has('erro') ? 'veio erro tratado (motor indisponível)' : `eventos: ${[...lido.evs].join(',')}`);

/* ═════ 7. front-end estático ═════ */
secao('ARQUIVOS DO APP');
for (const f of ['/', '/app.js', '/grafo.js', '/manifest.webmanifest', '/icon.svg', '/sw.js']) {
  const rr = await fetch(BASE + f);
  t(`serve ${f}`, rr.status === 200 && (await rr.text()).length > 50);
}
const html = await (await fetch(BASE + '/')).text();
t('html carrega grafo.js antes de app.js',
  html.indexOf('/grafo.js') > 0 && html.indexOf('/grafo.js') < html.indexOf('/app.js'));
t('html sem caractere corrompido', !/[\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF]/.test(html));
t('rota desconhecida cai no index', (await fetch(BASE + '/qualquer/coisa')).status === 200);

/* ═════ 8. atalhos ═════ */
secao('ATALHOS E ÍCONE');
// a Área de Trabalho pode estar redirecionada para o OneDrive
const candidatos = [
  process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop'),
].filter(Boolean);
const desk = candidatos.find(d => fs.existsSync(path.join(d, 'Cerebro.lnk'))) || candidatos[0];
t('atalho Cerebro.lnk existe', fs.existsSync(path.join(desk, 'Cerebro.lnk')));
t('atalho de login existe', fs.existsSync(path.join(desk, 'Login Claude CLI.lnk')));
t('ícone .ico existe', fs.existsSync('I:/Cerebro/cerebro.ico') && fs.statSync('I:/Cerebro/cerebro.ico').size > 5000);
t('Cerebro.bat existe', fs.existsSync('I:/Cerebro/Cerebro.bat'));
t('Login-Claude.bat existe', fs.existsSync('I:/Cerebro/Login-Claude.bat'));

fs.rmSync(tmp, { recursive: true, force: true });

/* ═════ resumo ═════ */
console.log('\n' + '═'.repeat(62));
console.log(`  ${ok} passaram · ${falha} falharam`);
if (erros.length) { console.log('\n  FALHAS:'); erros.forEach(e => console.log('   ✗ ' + e)); }
console.log('═'.repeat(62));
process.exit(falha ? 1 : 0);
