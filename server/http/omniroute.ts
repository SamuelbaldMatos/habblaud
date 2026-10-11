import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpError, readJson, sendJson } from './app';
import { isLoopbackAddress, isLoopbackHost } from './guard';
import { AgentRuntime, type AgentModel, type AgentModelReply, type AgentStreamEvent } from './agent-runtime';
import { createAgentMemory } from './agent-memory';

export const OMNIROUTE_COMBOS = [
  'orquestrador',
  'direcionador',
  'codigo',
  'codigo-pesado',
  'revisor',
  'texto',
  'analise',
  'contexto-longo',
  'complexo',
  'maximo',
  'seguranca',
  'rapido',
  'local-privado',
] as const;

export type OmniCombo = (typeof OMNIROUTE_COMBOS)[number];

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
}

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

function parseAgentRunRequest(value: unknown): AgentRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'corpo inválido');
  const request = value as { message?: unknown; messages?: unknown };
  if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, 'mensagem inválida');
  }
  if (request.messages === undefined) return { message: request.message.trim(), messages: [] };
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
  return { message: request.message.trim(), messages };
}

function localRequest(req: IncomingMessage, opts: { inDocker: boolean }): boolean {
  return isLoopbackHost(req.headers.host) && (opts.inDocker || isLoopbackAddress(req.socket.remoteAddress));
}

export function createOmnirouteHandler(opts: {
  inDocker: boolean;
  rootDir?: string;
}): (req: IncomingMessage, res: ServerResponse, path: string) => boolean {
  const complete: AgentModel = async (request) => {
    const { url, token } = resolveOmnirouteConfig(opts.inDocker);
    if (!token) throw new Error('Token do OmniRoute ausente. Verifique o perfil omniroute ou OMNIROUTE_TOKEN.');
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error('URL local do OmniRoute inválida.');
    }
    const localEndpoint =
      endpoint.protocol === 'http:' &&
      !endpoint.username &&
      !endpoint.password &&
      (isLoopbackHost(endpoint.host) || (opts.inDocker && endpoint.hostname === 'host.docker.internal'));
    if (!localEndpoint) throw new Error('OmniRoute deve estar configurado em um endereço HTTP local.');
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
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]),
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
  const runtime = opts.rootDir ? new AgentRuntime({
    rootDir: opts.rootDir, complete, memory,
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
            endpoint = new URL(url);
          } catch {
            throw new HttpError(503, 'URL local do OmniRoute inválida.');
          }
          const localEndpoint =
            endpoint.protocol === 'http:' &&
            !endpoint.username &&
            !endpoint.password &&
            (isLoopbackHost(endpoint.host) || (opts.inDocker && endpoint.hostname === 'host.docker.internal'));
          if (!localEndpoint) throw new HttpError(503, 'OmniRoute deve estar configurado em um endereço HTTP local.');

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
          let jobId: string | undefined;
          const emit = (event: AgentStreamEvent) => {
            if (res.destroyed || res.writableEnded) return;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            if (event.type === 'done') res.end();
          };
          res.on('close', () => {
            if (jobId && !res.writableEnded) runtime.cancel(jobId);
          });
          try {
            jobId = runtime.start(request, emit);
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
