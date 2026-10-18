import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buscarMemoria, registrarMemoria } from './memoria.mjs';
import { notaSegura } from './ponte.mjs';
import { lerStream } from './omniroute.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testRoot = path.resolve(here, '.test-data');

function fixture(t) {
  fs.mkdirSync(testRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(testRoot, 'memoria-'));
  const vault = path.join(temporary, 'vault');
  fs.mkdirSync(vault);
  t.after(() => {
    const target = fs.realpathSync(temporary);
    const parent = fs.realpathSync(testRoot);
    const relative = path.relative(parent, target);
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'cleanup must stay within .test-data');
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { vault, temporary };
}

function record(overrides = {}) {
  return {
    id: 'codex/session-one/result-one',
    titulo: 'Cache de autenticação compartilhado',
    resumo: 'O projeto Aurora deve invalidar o cache de autenticação após renovar a sessão. A reprodução local confirmou o comportamento.',
    origem: 'codex',
    projeto: 'Aurora',
    evidencias: ['Teste local reproduziu a invalidação do cache após renovar a sessão.'],
    tipo: 'aprendizado',
    ...overrides,
  };
}

function results(value) {
  const items = Array.isArray(value) ? value : value.resultados;
  assert.ok(Array.isArray(items), 'buscarMemoria must return an array or { resultados: [] }');
  return items;
}

function makeJunction(t, destination, link) {
  try {
    fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('The filesystem does not permit directory links: ' + error.code);
    return false;
  }
}

test('a different session retrieves a newly recorded learning immediately', async t => {
  const { vault } = fixture(t);
  const saved = await registrarMemoria(vault, record());
  assert.equal(saved.registrado, true);
  assert.ok(fs.existsSync(path.join(vault, saved.nota)));
  // A fresh module instance represents another chat using the same vault.
  const otherSession = await import('./memoria.mjs?session=claude-roundtrip');
  const matches = results(await otherSession.buscarMemoria(vault, 'cache autenticação', 'Aurora'));
  assert.ok(matches.length > 0);
  assert.match(JSON.stringify(matches), /cache|autenticação/i);
  const stored = fs.readFileSync(path.join(vault, saved.nota), 'utf8');
  assert.match(stored, /Aurora/);
  assert.match(stored, /codex/);
  assert.match(stored, /Teste local reproduziu/);
});

test('repeating the same request is idempotent and preserves the original file', async t => {
  const { vault } = fixture(t);
  const original = await registrarMemoria(vault, record());
  const file = path.join(vault, original.nota);
  const before = fs.readFileSync(file, 'utf8');
  const repeated = await registrarMemoria(vault, record());
  assert.equal(repeated.nota, original.nota);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const matches = results(await buscarMemoria(vault, 'cache autenticação', 'Aurora'));
  assert.equal(matches.length, 1);
});

test('the same id with changed content fails without overwriting knowledge', async t => {
  const { vault } = fixture(t);
  const saved = await registrarMemoria(vault, record());
  const file = path.join(vault, saved.nota);
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(async () => registrarMemoria(vault, record({ resumo: 'Uma afirmação diferente e incompatível.' })));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('handoff records unfinished work and unknown types are refused', async t => {
  const { vault } = fixture(t);
  const saved = await registrarMemoria(vault, record({ id: 'claude/session-three/handoff', tipo: 'handoff', titulo: 'Handoff da migração de cache', resumo: 'Objetivo: migrar o cache. Feito: leitura. Restante: escrita. Evidência: teste de leitura passou; escrita não executada.' }));
  assert.match(fs.readFileSync(path.join(vault, saved.nota), 'utf8'), /^type: handoff$/m);
  await assert.rejects(async () => registrarMemoria(vault, record({ id: 'claude/session-three/x', tipo: 'palpite' })), /Tipo inválido/);
});

test('project filtering keeps matching knowledge from other projects out', async t => {
  const { vault } = fixture(t);
  await registrarMemoria(vault, record());
  await registrarMemoria(vault, record({ id: 'claude/session-two/result-one', projeto: 'Boreal', titulo: 'Cache de autenticação Boreal', resumo: 'O cache de autenticação Boreal usa uma regra independente. A decisão foi comparada com Aurora, mas pertence somente a Boreal.', origem: 'claude' }));
  const all = results(await buscarMemoria(vault, 'cache autenticação'));
  assert.equal(all.length, 2);
  const aurora = results(await buscarMemoria(vault, 'cache autenticação', 'Aurora'));
  assert.equal(aurora.length, 1);
  assert.doesNotMatch(JSON.stringify(aurora), /Boreal/);
});

test('note reads reject traversal outside the vault', t => {
  const { vault, temporary } = fixture(t);
  fs.writeFileSync(path.join(temporary, 'outside.md'), 'This must remain outside the vault.');
  assert.throws(() => notaSegura(vault, '../outside.md'));
  assert.throws(() => notaSegura(vault, path.join(temporary, 'outside.md')));
});

test('note reads reject directory links leading outside the vault', t => {
  const { vault, temporary } = fixture(t);
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'Synthetic fixture, not a real secret.');
  if (!makeJunction(t, outside, path.join(vault, 'linked'))) return;
  assert.throws(() => notaSegura(vault, 'linked/secret.md'));
});

test('memory writes reject a destination directory linked outside the vault', async t => {
  const { vault, temporary } = fixture(t);
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(vault, 'conhecimento'));
  if (!makeJunction(t, outside, path.join(vault, 'conhecimento', 'sessoes-compartilhadas'))) return;
  await assert.rejects(async () => registrarMemoria(vault, record()));
  assert.deepEqual(fs.readdirSync(outside), []);
});

async function* chunks(text, size = 3) {
  const bytes = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function collect(stream) {
  let result = '';
  for await (const part of lerStream(stream)) result += part;
  return result;
}

test('SSE reader handles split JSON, CRLF and multibyte text', async () => {
  const wire = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Memória 🧠"}}\r\n\r\n'
    + 'data: {"type":"content_block_delta","delta":{"text":" compartilhada"}}\n\n'
    + 'data: {"type":"message_stop"}';
  assert.equal(await collect(chunks(wire)), 'Memória 🧠 compartilhada');
});

test('SSE reader rejects premature end instead of returning partial success', async () => {
  const wire = 'data: {"type":"content_block_delta","delta":{"text":"incompleto"}}\n\n';
  await assert.rejects(collect(chunks(wire)), /interrompida|concluir/i);
});

test('SSE reader surfaces gateway error events', async () => {
  const wire = 'data: {"type":"error","error":{"type":"overloaded_error","message":"synthetic"}}\n\n';
  await assert.rejects(collect(chunks(wire)), /erro/i);
});

test('MCP rejects null JSON-RPC without crashing and handles the next ping', () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    null,
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ];
  const child = spawnSync(process.execPath, [path.join(here, 'mcp.mjs')], {
    cwd: here,
    input: requests.map(value => JSON.stringify(value)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(responses.some(response => response.id === null && response.error?.code === -32600));
  assert.deepEqual(responses.find(response => response.id === 2)?.result, {});
});
