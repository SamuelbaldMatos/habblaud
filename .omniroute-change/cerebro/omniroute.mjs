import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configuracao(runtime = process.env) {
  const profile = runtime.CEREBRO_OMNI_PROFILE || path.join(os.homedir(), '.claude/profiles/omniroute/settings.json');
  let env = {};
  try { env = JSON.parse(fs.readFileSync(profile, 'utf8')).env || {}; } catch {}
  const url = new URL(runtime.CEREBRO_OMNI_URL || runtime.OMNIROUTE_URL || env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:20128');
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || (runtime.HABBLAUD_IN_DOCKER === '1' && url.hostname === 'host.docker.internal');
  if (!localHost || url.protocol !== 'http:' || url.username || url.password)
    throw new Error('OmniRoute deve usar HTTP local, sem credenciais na URL.');
  return { url: url.origin, token: runtime.CEREBRO_OMNI_TOKEN || runtime.OMNIROUTE_TOKEN || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY };
}

export async function estadoOmni() {
  try {
    const { url, token } = configuracao();
    if (!token) return { ok: false, rotulo: 'OmniRoute · GPT gerente', obs: 'credencial local ausente' };
    const r = await fetch(url + '/v1/models', { redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    const data = r.ok ? await r.json() : {};
    const ok = Array.isArray(data.data) && data.data.some(m => m.id === 'orquestrador');
    return { ok, rotulo: 'OmniRoute · GPT gerente', obs: ok ? 'combo orquestrador disponível' : `combo indisponível (HTTP ${r.status})` };
  } catch { return { ok: false, rotulo: 'OmniRoute · GPT gerente', obs: 'gateway local indisponível' }; }
}

export async function* lerStream(body) {
  const decoder = new TextDecoder();
  let buffer = '', complete = false;
  function parse(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const data = JSON.parse(payload);
    if (data.type === 'error' || data.error) throw new Error('OmniRoute retornou erro durante a geração. Verifique o gateway.');
    if (data.delta?.stop_reason === 'max_tokens') throw new Error('Resposta parcial: limite de saída atingido.');
    if (data.type === 'message_stop') complete = true;
    if (data.type === 'content_block_delta' && typeof data.delta?.text === 'string') return data.delta.text;
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      const text = parse(line); if (text) yield text;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const text = parse(buffer); if (text) yield text; }
  if (!complete) throw new Error('Resposta interrompida antes de concluir; não considere a tarefa entregue.');
}

export async function* viaOmni({ sistema, tarefa, modelo = 'orquestrador', blocos, signal }) {
  const { url, token } = configuracao();
  if (!token) throw new Error('Credencial local do OmniRoute ausente.');
  const timeout = AbortSignal.timeout(180000);
  const r = await fetch(url + '/v1/messages', {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelo, max_tokens: 4096, stream: true,
      system: sistema, messages: [{ role: 'user', content: blocos || tarefa }] }),
  });
  if (!r.ok) { await r.body?.cancel(); throw new Error(`OmniRoute HTTP ${r.status}; verifique contas e disponibilidade do combo ${modelo}.`); }
  yield* lerStream(r.body);
}
