// Cérebro — orquestrador mestre. Lê o índice de capacidades do vault e roteia
// tarefas para o agente/skill/processo certo. Sem dependências, padrão Giro.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(RAIZ, 'public');
const IDX = process.env.CEREBRO_INDICE || 'I:/CarecaBrain/_ferramentas/capacidades.json';
const ROTEADOR = process.env.CEREBRO_ROTEADOR || 'I:/CarecaBrain/_ferramentas/roteador.mjs';
const PORT = Number(process.env.PORT || 4500);
const HOST = process.env.CEREBRO_HOST || '127.0.0.1';

const { pontuar } = await import(pathToFileURL(ROTEADOR).href);
const { executar, estado } = await import(pathToFileURL(path.join(RAIZ, 'motor.mjs')).href);
const arq = await import(pathToFileURL(path.join(RAIZ, 'arquivos.mjs')).href);

const corpoJson = req => new Promise((ok, falha) => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 3.2e7) { req.destroy(); falha(new Error('anexo grande demais')); } });
  req.on('end', () => { try { ok(JSON.parse(b)); } catch { falha(new Error('json inválido')); } });
});

// cache do índice por mtime: regenerou no vault, o app enxerga na hora
let cache = { mtime: 0, dados: null };
function indice() {
  const st = fs.statSync(IDX);
  if (st.mtimeMs !== cache.mtime) {
    cache = { mtime: st.mtimeMs, dados: JSON.parse(fs.readFileSync(IDX, 'utf8')) };
  }
  return cache.dados;
}

const ASSUNTOS = {
  'estrategia-marketing': '📈 Estratégia & Marketing', 'conteudo-copy': '✍️ Conteúdo & Copy',
  'design-criativo': '🎨 Design & Criativo', 'comercial-crm': '🤝 Comercial & CRM',
  'atendimento-cx': '💬 Atendimento & CX', 'dados-analytics': '📊 Dados & Analytics',
  financeiro: '💰 Financeiro', 'juridico-compliance': '⚖️ Jurídico & Compliance',
  saude: '🏥 Saúde', 'logistica-operacoes': '🚚 Logística & Operações',
  'gestao-operacoes': '⚙️ Gestão & Processos', tecnologia: '💻 Tecnologia',
  'rh-gestao': '👥 RH & Pessoas', educacao: '🎓 Educação', produto: '📦 Produto',
  'produtividade-office': '🗂️ Produtividade & Office',
};

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + ((f(0) << 16) | (f(8) << 8) | f(4)).toString(16).padStart(6, '0');
}

const leve = c => ({ ...c, prompt_portatil: undefined, sequencia: undefined, termos: undefined });

const REGRAS = [
  '', 'REGRAS DE ENTREGA:',
  '- Responda em português do Brasil.',
  '- Sem travessão como pontuação: use vírgula, dois-pontos, parênteses ou ponto.',
  '- Nada de bajulação nem preâmbulo: comece pela entrega.',
  '- Marque com [VERIFICAR] toda suposição sua; nunca invente dado, norma ou número.',
  '- Se faltar informação que muda a entrega, faça UMA rodada de perguntas objetivas antes de produzir.',
].join('\n');

// Monta o prompt de sistema conforme o tipo de capacidade. É o passo que
// elimina o copiar-e-colar: o prompt do agente entra sozinho.
function sistemaDe(c) {
  if (c.tipo === 'agente' && c.prompt_portatil) return c.prompt_portatil + '\n' + REGRAS;
  if (c.tipo === 'departamento') {
    const eq = indice().capacidades.filter(x => x.tipo === 'agente' && x.setor === c.setor);
    return [
      `Você é ${c.chefia || 'o líder'} da área de ${c.nome}, comandando ${eq.length} especialistas.`,
      '', `ATRIBUIÇÃO DA ÁREA: ${c.faz}`,
      '', 'ESPECIALISTAS QUE VOCÊ PODE ASSUMIR (adote o perfil adequado à tarefa):',
      eq.map(a => `- ${a.nome}: ${a.faz}`).join('\n'),
      '', 'Diga em uma linha qual perfil está assumindo e por quê, depois entregue no padrão sênior.',
      REGRAS,
    ].join('\n');
  }
  if (c.tipo === 'processo') {
    return [
      `Você conduz o processo "${c.nome}", uma linha de serviço recorrente da consultoria.`,
      '', `OBJETIVO: ${c.faz}`,
      '', 'CADEIA DE ETAPAS (respeite a ordem):',
      (c.sequencia || []).map((e, i) => `${i + 1}. ${e}`).join('\n'),
      '', 'Diga em que etapa a demanda do usuário se encaixa, execute o que for possível agora,',
      'e aponte o que depende dele (dado, acesso, validação) para seguir.',
      REGRAS,
    ].join('\n');
  }
  // skill/fluxo/plugin: fora do Claude não há execução da skill, mas o conhecimento serve de guia
  return [
    `Você é um especialista cujo método corresponde à ferramenta "${c.nome}".`,
    '', `O QUE ELA FAZ: ${c.faz}`,
    '', `Dentro do Claude, esta capacidade é invocada por \`${c.invocar_claude || c.nome}\`.`,
    'Aqui, entregue o mesmo resultado que ela entregaria, com o mesmo rigor.',
    REGRAS,
  ].join('\n');
}
const json = (res, obj, code = 200) =>
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer((req, res) => {
  const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
  if (!allowedHosts.has(req.headers.host)) return json(res, { erro: 'host não autorizado' }, 403);
  if (req.headers.origin) {
    try { if (!allowedHosts.has(new URL(req.headers.origin).host)) return json(res, { erro: 'origem não autorizada' }, 403); }
    catch { return json(res, { erro: 'origem inválida' }, 403); }
  }
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/resumo') {
      const { totais, total, gerado, capacidades } = indice();
      const assuntos = {};
      for (const c of capacidades) if (c.assunto) assuntos[c.assunto] = (assuntos[c.assunto] || 0) + 1;
      return json(res, { totais, total, gerado, assuntos, rotulos: ASSUNTOS });
    }
    if (u.pathname === '/api/rotear') {
      const q = u.searchParams.get('q') || '';
      return json(res, { q, resultados: pontuar(indice().capacidades, q, 10).map(leve) });
    }
    if (u.pathname === '/api/cap') {
      const id = u.searchParams.get('id') || '';
      const c = indice().capacidades.find(x => x.id === id);
      return c ? json(res, c) : json(res, { erro: 'não encontrado' }, 404);
    }
    if (u.pathname === '/api/mapa') {
      const caps = indice().capacidades;
      const deps = caps.filter(c => c.tipo === 'departamento')
        .sort((a, b) => a.setor.localeCompare(b.setor));
      const mapa = deps.map((d, i) => {
        const h = Math.round((360 / deps.length) * i);
        return { ...leve(d), cor: hsl(h, 85, 68), corAgente: hsl(h, 55, 50),
          agentes: caps.filter(c => c.tipo === 'agente' && c.setor === d.setor)
            .map(a => ({ id: a.id, nome: a.nome, faz: a.faz })) };
      });
      const processos = caps.filter(c => c.tipo === 'processo').map(c => ({ ...c, termos: undefined }));
      const porAssunto = {};
      for (const c of caps.filter(x => ['skill', 'fluxo'].includes(x.tipo) && x.assunto))
        (porAssunto[c.assunto] ??= []).push(leve(c));
      return json(res, { departamentos: mapa, processos, assuntos: porAssunto, rotulos: ASSUNTOS });
    }
    if (u.pathname === '/api/motor') {
      return estado().then(m => json(res, m));
    }
    if (u.pathname === '/api/upload' && req.method === 'POST') {
      return corpoJson(req).then(b => {
        const salvos = (b.arquivos || []).slice(0, 12).map(f => {
          const s = arq.salvar({ nome: f.nome, base64: f.base64 });
          const i = arq.interpretar(s.arquivo, s.nome);
          return { ...s, tipo: i.tipo, motivo: i.motivo,
            previa: i.tipo === 'texto' ? i.texto.slice(0, 160) : '' };
        });
        json(res, { arquivos: salvos });
      }).catch(e => json(res, { erro: e.message }, 400));
    }
    if (u.pathname === '/api/marca') {
      if (req.method === 'POST') {
        return corpoJson(req).then(m => {
          if (m.logoBase64) {
            const s = arq.salvar({ nome: m.logoNome || 'logo.png', base64: m.logoBase64, pasta: arq.MARCA_DIR });
            m.logo = s.arquivo; delete m.logoBase64; delete m.logoNome;
          }
          arq.salvarMarca(m); json(res, { ok: true, marca: m });
        }).catch(e => json(res, { erro: e.message }, 400));
      }
      return json(res, arq.lerMarca());
    }
    if (u.pathname === '/api/executar' && req.method === 'POST') {
      return corpoJson(req).then(async corpo => {
        const c = indice().capacidades.find(x => x.id === corpo.id);
        if (!c) return json(res, { erro: 'capacidade não encontrada' }, 404);

        // anexos da tarefa + logo da marca entram como contexto
        const anexos = [], caminhos = [];
        for (const a of corpo.anexos || []) {
          if (!fs.existsSync(a.arquivo)) continue;
          anexos.push(arq.interpretar(a.arquivo, a.nome));
          caminhos.push(a.arquivo);
        }
        const marca = arq.lerMarca();
        if (marca.logo && fs.existsSync(marca.logo)) anexos.push(arq.interpretar(marca.logo, 'logo-da-marca'));

        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache', connection: 'keep-alive' });
        const envia = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
        envia('inicio', { nome: c.nome, tipo: c.tipo, assunto: c.assunto || '', setor: c.setor || '',
          anexos: anexos.map(a => ({ nome: a.nome, tipo: a.tipo, motivo: a.motivo })),
          marca: !!Object.keys(marca).length });
        try {
          const sistema = sistemaDe(c) + arq.blocoMarca(marca) + (corpo.instrucoes?.trim()
            ? `\n\n=== INSTRUÇÕES ESPECÍFICAS DESTA TAREFA (prevalecem) ===\n${corpo.instrucoes.trim()}` : '');
          for await (const t of executar({ sistema, tarefa: corpo.tarefa,
            motor: corpo.motor, modelo: corpo.modelo, anexos, caminhos })) envia('texto', t);
          envia('fim', {});
        } catch (e) { envia('erro', String(e.message || e)); }
        res.end();
      }).catch(e => json(res, { erro: e.message }, 400));
    }
    // estático
    let f = path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory())
      f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'content-type': (MIME[path.extname(f)] || 'text/plain') + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  } catch (e) {
    json(res, { erro: String(e.message || e) }, 500);
  }
}).listen(PORT, HOST, () =>
  console.log(`🧠 Cérebro no ar: http://${HOST}:${PORT}`));
