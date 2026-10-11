import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const normalizar = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const stop = new Set('a o as os de da do das dos em um uma para por com e que no na nos nas eu meu minha projeto'.split(' '));
function texto(s, name, max) {
  if (typeof s !== 'string' || !s.trim() || s.length > max) throw new Error(`${name}: texto obrigatório, máximo ${max} caracteres.`);
  return s.trim();
}
function dentro(root, file) {
  const rel = path.relative(root, fs.realpathSync(file));
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Caminho fora do vault.');
}
function* notas(root, dir = root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* notas(root, full);
    else if (entry.isFile() && entry.name.endsWith('.md') && fs.statSync(full).size <= 200000) yield full;
  }
}

// A busca lê o vault atual em cada chamada: sem índice paralelo desatualizado.
// Nunca retorna dumps de sessão; entrega apenas trechos para a leitura dirigida.
export function buscarMemoria(root, consulta, projeto = '') {
  consulta = texto(consulta, 'consulta', 12000);
  if (typeof projeto !== 'string' || projeto.length > 200) throw new Error('Projeto inválido.');
  root = fs.realpathSync(root);
  const termos = [...new Set(normalizar(consulta).match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{1,60}/gu) || [])].filter(t => !stop.has(t)).slice(0, 30);
  if (!termos.length) return [];
  const result = [];
  for (const file of notas(root)) {
    const nota = path.relative(root, file).replaceAll('\\', '/');
    const body = fs.readFileSync(file, 'utf8');
    const normalized = normalizar(body), name = normalizar(nota);
    if (projeto) {
      const campo = /^projeto: (.+)$/m.exec(body)?.[1];
      let owner = campo;
      try { if (campo?.startsWith('"')) owner = JSON.parse(campo); } catch {}
      if (owner ? normalizar(owner) !== normalizar(projeto) : !normalizar(name + '\n' + body).includes(normalizar(projeto))) continue;
    }
    const hits = termos.filter(t => normalized.includes(t) || name.includes(t));
    if (!hits.length) continue;
    const score = hits.reduce((s, t) => s + (name.includes(t) ? 10 : 1), 0) + hits.length / termos.length;
    const linhas = body.split(/\r?\n/);
    const linha = Math.max(0, linhas.findIndex(l => hits.some(t => normalizar(l).includes(t))));
    const titulo = linhas.find(l => /^# /.test(l))?.slice(2) || path.basename(file, '.md');
    result.push({ nota, titulo, score, linha: linha + 1, trecho: linhas.slice(Math.max(0, linha - 1), linha + 5).join('\n').slice(0, 900) });
  }
  return result.sort((a, b) => b.score - a.score || a.nota.localeCompare(b.nota)).slice(0, 8);
}

export function registrarMemoria(root, args) {
  const id = texto(args.id, 'id', 200), titulo = texto(args.titulo, 'titulo', 160);
  const resumo = texto(args.resumo, 'resumo', 12000), origem = texto(args.origem, 'origem', 100);
  const projeto = texto(args.projeto, 'projeto', 200), tipo = args.tipo || 'aprendizado';
  if (!['decisao', 'aprendizado', 'entrega'].includes(tipo)) throw new Error('Tipo inválido.');
  if (!Array.isArray(args.evidencias) || !args.evidencias.length || args.evidencias.length > 15) throw new Error('Informe de 1 a 15 evidências verificáveis.');
  const evidencias = args.evidencias.map(e => texto(e, 'evidência', 1000));
  root = fs.realpathSync(root);
  let dir = root;
  for (const component of ['conhecimento', 'sessoes-compartilhadas']) {
    dir = path.join(dir, component);
    if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    dentro(root, dir);
  }
  const digest = createHash('sha256').update(projeto + '\0' + id).digest('hex').slice(0, 32);
  const file = path.join(dir, digest + '.md');
  const payload = { tipo, titulo, resumo, origem, projeto, evidencias, id };
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (fs.existsSync(file)) {
    dentro(root, file);
    const previous = fs.readFileSync(file, 'utf8');
    if (!previous.includes(`fingerprint: ${fingerprint}\n`)) throw new Error('ID já registrado com outro conteúdo; use novo ID para correção, citando a nota anterior.');
    return { nota: path.relative(root, file).replaceAll('\\', '/'), registrado: true, existente: true };
  }
  const content = `---\ntype: ${tipo}\ntitle: ${JSON.stringify(titulo)}\nprojeto: ${JSON.stringify(projeto)}\norigem: ${JSON.stringify(origem)}\nrequest_id: ${JSON.stringify(id)}\ndata: ${new Date().toISOString()}\nfingerprint: ${fingerprint}\n---\n\n# ${titulo.replace(/[\r\n]/g, ' ')}\n\n${resumo}\n\n## Evidências\n\n${evidencias.map(e => '- ' + e.replace(/[\r\n]/g, ' ')).join('\n')}\n\n↩ [[CEREBRO]]\n`;
  try { fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); }
  catch (e) {
    if (e.code === 'EEXIST') return registrarMemoria(root, args);
    throw e;
  }
  return { nota: path.relative(root, file).replaceAll('\\', '/'), registrado: true, existente: false };
}
