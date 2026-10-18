import type { IncomingMessage, ServerResponse } from 'node:http';
import { OmniStatusError, OmniStatusService } from '../omniroute/status';
import type { AccountUsage } from '../../shared/types';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadRecipes } from './recipes';
import type { Recipe } from './recipes';
import { join } from 'node:path';
import { HttpError, readJson, sendJson } from './app';
import { isLoopbackAddress, isLoopbackHost } from './guard';
import { AgentRuntime, type AgentModel, type AgentModelReply, type AgentStreamEvent } from './agent-runtime';
import { createAgentMemory } from './agent-memory';
import { ProjectContextCache } from './project-context';
import { discoverWorkspaces } from './workspaces';

import { OMNIROUTE_COMBOS, type OmniCombo } from '../../shared/omniroute-combos';

export { OMNIROUTE_COMBOS, type OmniCombo };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  message?: string;
  messages?: ChatMessage[];
  combo?: string;
  system?: string;
}

interface AgentRunRequest {
  message: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Id de workspace (validado pelo runtime contra a lista conhecida; nunca vira caminho). */
  workspace?: string;
  /** Conversa do estúdio: a memória do Cérebro é consultada uma vez por conversa. */
  threadId?: string;
}

const ID_FIELD = /^[A-Za-z0-9._-]{1,64}$/;

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 24_000;

function parseChatRequest(value: unknown): Required<Pick<ChatRequest, 'combo' | 'messages'>> & Pick<ChatRequest, 'system'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'corpo inválido');
  const request = value as ChatRequest;
  const combo = request.combo ?? 'orquestrador';
  if (typeof combo !== 'string' || !OMNIROUTE_COMBOS.includes(combo as OmniCombo)) {
    throw new HttpError(400, 'combo OmniRoute inválido');
  }
  if (request.system !== undefined && (typeof request.system !== 'string' || request.system.length > 8_000)) {
    throw new HttpError(400, 'instruções do sistema inválidas');
  }

  let messages = request.messages;
  if (messages === undefined || (Array.isArray(messages) && messages.length === 0)) {
    if (typeof request.message !== 'string' || !request.message.trim()) throw new HttpError(400, 'Envie "message" ou "messages"');
    messages = [{ role: 'user', content: request.message.trim() }];
  }
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) throw new HttpError(400, 'lista de mensagens inválida');
  for (const message of messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !['user', 'assistant', 'system'].includes(message.role) ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new HttpError(400, 'mensagem inválida');
    }
  }
  return { combo, messages, system: request.system };
}

function resolveOmnirouteConfig(inDocker: boolean): { url: string; token?: string } {
  let url = process.env.OMNIROUTE_URL?.trim();
  if (!url) {
    url = inDocker ? 'http://host.docker.internal:20128' : 'http://127.0.0.1:20128';
  }
  let token = process.env.OMNIROUTE_TOKEN?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!token) {
    try {
      const p = join(homedir(), '.claude', 'profiles', 'omniroute', 'settings.json');
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as { env?: Record<string, string> };
        token = raw.env?.ANTHROPIC_AUTH_TOKEN || raw.env?.ANTHROPIC_API_KEY;
      }
    } catch {
      // Ignora erro de leitura do arquivo
    }
  }
  return { url, token };
}

/**
 * Endereço do OmniRoute validado ANTES de qualquer chamada com a chave: só HTTP local (loopback ou, no Docker,
 * host.docker.internal), sem usuário/senha na URL. Fora disso a chave nunca sai do processo.
 */
export function localOmnirouteEndpoint(url: string, inDocker: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('URL local do OmniRoute inválida.');
  }
  const local =
    endpoint.protocol === 'http:' &&
    !endpoint.username &&
    !endpoint.password &&
    (isLoopbackHost(endpoint.host) || (inDocker && endpoint.hostname === 'host.docker.internal'));
  if (!local) throw new Error('OmniRoute deve estar configurado em um endereço HTTP local.');
  return endpoint;
}

function parseAgentRunRequest(value: unknown): AgentRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'corpo inválido');
  const request = value as { message?: unknown; messages?: unknown; workspace?: unknown; threadId?: unknown };
  if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, 'mensagem inválida');
  }
  const extra: Pick<AgentRunRequest, 'workspace' | 'threadId'> = {};
  for (const key of ['workspace', 'threadId'] as const) {
    const v = request[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !ID_FIELD.test(v)) throw new HttpError(400, `${key} inválido`);
    extra[key] = v;
  }
  if (request.messages === undefined) return { message: request.message.trim(), messages: [], ...extra };
  if (!Array.isArray(request.messages) || request.messages.length > 10) throw new HttpError(400, 'histórico inválido');
  const messages = request.messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !['user', 'assistant'].includes((message as ChatMessage).role) ||
      typeof (message as ChatMessage).content !== 'string' ||
      !(message as ChatMessage).content.trim() ||
      (message as ChatMessage).content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new HttpError(400, 'mensagem de histórico inválida');
    }
    return { role: (message as ChatMessage).role as 'user' | 'assistant', content: (message as ChatMessage).content };
  });
  return { message: request.message.trim(), messages, ...extra };
}

/**
 * Escreve eventos SSE de uma tarefa. Com `started = false` guarda tudo até `flush()` (o replay de /stream chega
 * antes do cabeçalho). Fecha a resposta no 'done'.
 */
function sseWriter(res: ServerResponse, started = true): ((event: AgentStreamEvent) => void) & { flush(): void } {
  const pending: AgentStreamEvent[] = [];
  let open = started;
  const write = (event: AgentStreamEvent) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done') res.end();
  };
  const emit = ((event: AgentStreamEvent) => {
    if (open) write(event);
    else pending.push(event);
  }) as ((event: AgentStreamEvent) => void) & { flush(): void };
  emit.flush = () => {
    open = true;
    for (const event of pending.splice(0)) write(event);
  };
  return emit;
}

function localRequest(req: IncomingMessage, opts: { inDocker: boolean }): boolean {
  return isLoopbackHost(req.headers.host) && (opts.inDocker || isLoopbackAddress(req.socket.remoteAddress));
}

export function createOmnirouteHandler(opts: {
  inDocker: boolean;
  rootDir?: string;
  /** Raízes com projetos (um nível abaixo) para o estúdio; ver server/http/workspaces.ts. */
  roots?: string[];
  /** Pasta do cache do cartão do projeto (no Docker, /data/context). */
  contextDir?: string;
  onOmniUsage?: (byEmail: ReadonlyMap<string, AccountUsage>) => void;
  /** Liga a leitura periódica do estado do OmniRoute (o servidor real liga; os testes não). */
  pollOmniStatus?: boolean;
}): (req: IncomingMessage, res: ServerResponse, path: string) => boolean {
  // Estado e cotas do OmniRoute (cache de 60 s, renovado a cada 2 min): alimenta o painel e o uso das contas.
  const omniStatus = new OmniStatusService({
    get: async (p) => {
      const { url, token } = resolveOmnirouteConfig(opts.inDocker);
      if (!token) throw new OmniStatusError('Token do OmniRoute ausente.');
      let endpoint: URL;
      try {
        // Valida o destino ANTES de mandar a chave.
        endpoint = localOmnirouteEndpoint(url, opts.inDocker);
      } catch (err) {
        throw new OmniStatusError((err as Error).message);
      }
      let r: Response;
      try {
        r = await fetch(new URL(p, endpoint), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new OmniStatusError('OmniRoute fora do ar ou sem resposta em 15 s.');
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new OmniStatusError(`OmniRoute respondeu HTTP ${r.status} em ${p.split('?')[0]}.`);
      }
      return r.json();
    },
    onSnapshot: (snap) => opts.onOmniUsage?.(snap.claudeUsageByEmail),
  });
  if (opts.pollOmniStatus) omniStatus.start();
  const complete: AgentModel = async (request) => {
    const { url, token } = resolveOmnirouteConfig(opts.inDocker);
    if (!token) throw new Error('Token do OmniRoute ausente. Verifique o perfil omniroute ou OMNIROUTE_TOKEN.');
    const endpoint = localOmnirouteEndpoint(url, opts.inDocker);
    let upstream: Response;
    try {
      upstream = await fetch(new URL('/v1/messages', endpoint), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: request.combo,
          max_tokens: 4096,
          stream: false,
          system: request.system,
          messages: request.messages,
          ...(request.tools ? { tools: request.tools } : {}),
        }),
        // Sem streaming o corte de 110 s do OmniRoute não vale; 600 s dá tempo ao modelo local na reserva.
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]),
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new Error('Falha ao conectar ao OmniRoute local.');
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw new Error(`OmniRoute recusou a solicitação (HTTP ${upstream.status}).`);
    }
    const raw = await upstream.text();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Resposta do OmniRoute excede o limite de 1 MiB.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OmniRoute retornou JSON inválido.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Resposta inválida do OmniRoute.');
    const body = parsed as AgentModelReply;
    if (!Array.isArray(body.content) || body.content.some((block) => !block || typeof block !== 'object' || typeof block.type !== 'string')) {
      throw new Error('Resposta do OmniRoute não contém blocos válidos.');
    }
    return body;
  };
  const memory = process.env.HABBLAUD_CEREBRO_CLI && process.env.HABBLAUD_CEREBRO_PROJECT
    ? createAgentMemory({ cli: process.env.HABBLAUD_CEREBRO_CLI, project: process.env.HABBLAUD_CEREBRO_PROJECT }) : undefined;
  const workspaces = discoverWorkspaces(opts.rootDir, opts.roots ?? []);
  // Receitas do estúdio: lidas na 1ª consulta e guardadas (mudam só com nova versão).
  let recipes: Recipe[] | undefined;
  const projectContext = new ProjectContextCache({ cacheDir: opts.contextDir });
  const runtime = Object.keys(workspaces).length ? new AgentRuntime({
    workspaces, complete, memory,
    context: { get: (ws, dir) => projectContext.get(ws, dir), render: (card) => projectContext.render(card) },
    maxTotalTokens: process.env.HABBLAUD_AGENT_TOKEN_BUDGET ? Number(process.env.HABBLAUD_AGENT_TOKEN_BUDGET) : undefined,
  }) : undefined;

  return (req, res, path) => {
    if (!path.startsWith('/api/omniroute')) return false;
    const method = req.method ?? 'GET';

    if (path === '/api/omniroute/combos') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      sendJson(res, 200, { ok: true, combos: OMNIROUTE_COMBOS });
      return true;
    }

    if (path === '/api/omniroute/status') {
      if (!localRequest(req, opts)) {
        sendJson(res, 403, { error: 'o estado do OmniRoute só é servido localmente' });
        return true;
      }
      void omniStatus.snapshot().then((snap) => sendJson(res, 200, snap.status));
      return true;
    }

    if (path === '/api/omniroute/chat') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      if (!isLoopbackHost(req.headers.host) || (!opts.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        req.resume();
        sendJson(res, 403, { error: 'o chat OmniRoute só aceita conexões locais' });
        return true;
      }

      readJson(req)
        .then(async (body) => {
          const reqBody = parseChatRequest(body);
          const { url, token } = resolveOmnirouteConfig(opts.inDocker);
          if (!token) {
            throw new HttpError(503, 'Token do OmniRoute ausente. Verifique o perfil omniroute ou OMNIROUTE_TOKEN.');
          }
          let endpoint: URL;
          try {
            endpoint = localOmnirouteEndpoint(url, opts.inDocker);
          } catch (err) {
            throw new HttpError(503, (err as Error).message);
          }

          const system = reqBody.system || 'Você é o assistente inteligente integrado ao Habblaud e VS Code via OmniRoute. Responda de forma concisa, precisa e com blocos de código formatados quando necessário.';

          const controller = new AbortController();
          const abortOnDisconnect = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.on('close', abortOnDisconnect);

          let omniRes: Response;
          try {
            omniRes = await fetch(new URL('/v1/messages', endpoint), {
              method: 'POST',
              redirect: 'error',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: reqBody.combo,
                max_tokens: 4096,
                stream: true,
                system,
                messages: reqBody.messages.map((m) => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content })),
              }),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
            });
          } catch (fetchErr) {
            throw new HttpError(502, 'Falha ao conectar ao OmniRoute local.');
          }

          if (!omniRes.ok) {
            await omniRes.body?.cancel();
            throw new HttpError(502, `OmniRoute recusou a solicitação (HTTP ${omniRes.status}).`);
          }

          if (!omniRes.body) {
            throw new HttpError(500, 'Resposta vazia do OmniRoute');
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Content-Type-Options': 'nosniff',
          });

          const reader = omniRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let finished = false;
          const sendDone = () => {
            if (finished || res.destroyed) return;
            finished = true;
            res.write('data: [DONE]\n\n');
            res.end();
          };
          const forwardEvent = (payload: string): boolean => {
            if (!payload || payload === '[DONE]') return payload === '[DONE]';
            let parsed: {
              type?: string;
              delta?: { text?: string; stop_reason?: string };
              message?: { model?: string };
              error?: unknown;
            };
            try {
              parsed = JSON.parse(payload) as typeof parsed;
            } catch {
              throw new HttpError(502, 'OmniRoute retornou um evento inválido.');
            }
            if (parsed.type === 'error' || parsed.error) throw new HttpError(502, 'OmniRoute interrompeu a geração com um erro.');
            if (parsed.delta?.stop_reason === 'max_tokens') throw new HttpError(502, 'Resposta parcial: limite de saída atingido.');
            if (parsed.type === 'content_block_delta' && typeof parsed.delta?.text === 'string') {
              res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
            } else if (parsed.type === 'message_start' && parsed.message?.model) {
              res.write(`data: ${JSON.stringify({ model: parsed.message.model })}\n\n`);
            }
            return parsed.type === 'message_stop';
          };

          try {
            let upstreamDone = false;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              if (Buffer.byteLength(buf) > 256 * 1024) throw new HttpError(502, 'Evento do OmniRoute excede o limite permitido.');
              const lines = buf.split('\n');
              buf = lines.pop() ?? '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const dataPayload = trimmed.slice(5).trim();
                if (forwardEvent(dataPayload)) {
                  upstreamDone = true;
                  break;
                }
              }
              if (upstreamDone) break;
            }
            if (!upstreamDone && buf.trim()) {
              const trailing = buf.trim();
              if (trailing.startsWith('data:')) upstreamDone = forwardEvent(trailing.slice(5).trim());
            }
            if (!upstreamDone) throw new HttpError(502, 'Resposta do OmniRoute foi interrompida antes de concluir.');
            sendDone();
          } catch (streamErr) {
            if (!res.writableEnded && !res.destroyed) {
              const message = streamErr instanceof HttpError ? streamErr.message : 'Falha ao ler a resposta do OmniRoute.';
              res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
              sendDone();
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            res.removeListener('close', abortOnDisconnect);
          }
        })
        .catch((err) => {
          if (!res.headersSent) {
            if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
            else sendJson(res, 500, { error: (err as Error).message || 'erro interno' });
          } else {
            res.end();
          }
        });

      return true;
    }

    if (path === '/api/omniroute/run') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      if (!localRequest(req, opts)) {
        req.resume();
        sendJson(res, 403, { error: 'o runtime multiagente só aceita conexões locais' });
        return true;
      }
      if (!runtime) {
        req.resume();
        sendJson(res, 503, { error: 'workspace de execução do agente não configurado' });
        return true;
      }
      readJson(req)
        .then((body) => {
          const request = parseAgentRunRequest(body);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Content-Type-Options': 'nosniff',
          });
          const emit = sseWriter(res);
          // Fechar a aba ou recarregar a página NÃO cancela a tarefa: ela segue no servidor e o estúdio reanexa
          // por /jobs/:id/stream?after=N. Cancelar é só pelo botão Parar (DELETE /jobs/:id).
          let off: (() => void) | undefined;
          res.on('close', () => off?.());
          try {
            const jobId = runtime.start(request);
            off = runtime.subscribe(jobId, 0, emit);
          } catch (error) {
            emit({ type: 'error', error: (error as Error).message });
            emit({ type: 'done' });
          }
        })
        .catch((error) => {
          if (!res.headersSent) {
            if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
            else sendJson(res, 500, { error: (error as Error).message || 'erro interno' });
          } else {
            res.end();
          }
        });
      return true;
    }

    if (path === '/api/omniroute/recipes') {
      req.resume();
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'método não permitido' });
      } else if (!localRequest(req, opts)) {
        sendJson(res, 403, { error: 'o estúdio só aceita conexões locais' });
      } else {
        recipes ??= loadRecipes(process.env.HABBLAUD_RECIPES_DIR?.trim() || join(process.cwd(), 'shared', 'recipes'));
        sendJson(res, 200, { recipes });
      }
      return true;
    }

    if (path === '/api/omniroute/workspaces' || path === '/api/omniroute/jobs' || path === '/api/omniroute/context') {
      const allowed = path === '/api/omniroute/context' ? ['GET', 'POST'] : ['GET'];
      if (!allowed.includes(method)) {
        res.setHeader('Allow', allowed.join(', '));
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      req.resume();
      if (!localRequest(req, opts)) {
        sendJson(res, 403, { error: 'o estúdio só aceita conexões locais' });
        return true;
      }
      if (!runtime) {
        sendJson(res, 503, { error: 'workspace de execução do agente não configurado' });
        return true;
      }
      if (path === '/api/omniroute/workspaces') {
        sendJson(res, 200, runtime.workspaceList());
        return true;
      }
      if (path === '/api/omniroute/jobs') {
        sendJson(res, 200, { jobs: runtime.list() });
        return true;
      }
      const workspace = new URL(req.url ?? '/', 'http://x').searchParams.get('workspace') ?? undefined;
      const dir = runtime.workspaceDir(workspace);
      if (!dir) {
        sendJson(res, 404, { error: 'workspace desconhecido' });
        return true;
      }
      const id = workspace ?? runtime.workspaceList().default;
      projectContext
        .get(id, dir, { force: method === 'POST' })
        .then((r) => sendJson(res, 200, r))
        .catch(() => sendJson(res, 500, { error: 'não foi possível montar o cartão do projeto' }));
      return true;
    }

    const streamMatch = /^\/api\/omniroute\/jobs\/([0-9a-f-]{36})\/stream$/.exec(path);
    if (streamMatch) {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      if (!localRequest(req, opts)) {
        sendJson(res, 403, { error: 'o estúdio só aceita conexões locais' });
        return true;
      }
      const afterRaw = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('after') ?? '0');
      const after = Number.isSafeInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
      const emit = sseWriter(res, false);
      const off = runtime?.subscribe(streamMatch[1], after, emit);
      if (!off) {
        sendJson(res, 404, { error: 'tarefa inexistente ou já descartada' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      emit.flush();
      res.on('close', off);
      return true;
    }

    const approvalMatch = /^\/api\/omniroute\/jobs\/([0-9a-f-]{36})\/approvals\/([A-Za-z0-9_-]{32})$/.exec(path);
    if (approvalMatch) {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      if (!localRequest(req, opts)) {
        req.resume();
        sendJson(res, 403, { error: 'aprovações só podem ser respondidas localmente' });
        return true;
      }
      readJson(req)
        .then((body) => {
          const decision = (body as { decision?: unknown })?.decision;
          if (!runtime || (decision !== 'approve' && decision !== 'reject')) throw new HttpError(400, 'decisão inválida');
          const ok = runtime.approve(approvalMatch[1], approvalMatch[2], decision);
          if (!ok) throw new HttpError(404, 'aprovação inexistente, expirada ou já respondida');
          sendJson(res, 200, { ok: true });
        })
        .catch((error) => {
          if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
          else sendJson(res, 500, { error: (error as Error).message || 'erro interno' });
        });
      return true;
    }

    const jobMatch = /^\/api\/omniroute\/jobs\/([0-9a-f-]{36})$/.exec(path);
    if (jobMatch) {
      if (method !== 'DELETE') {
        res.setHeader('Allow', 'DELETE');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      if (!localRequest(req, opts)) {
        req.resume();
        sendJson(res, 403, { error: 'tarefas só podem ser canceladas localmente' });
        return true;
      }
      req.resume();
      if (!runtime?.cancel(jobMatch[1])) sendJson(res, 404, { error: 'tarefa inexistente ou concluída' });
      else sendJson(res, 202, { ok: true, cancelled: true });
      return true;
    }

    return false;
  };
}
