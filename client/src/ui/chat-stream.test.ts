import { describe, expect, it } from 'vitest';
import { parseOmniRouteStreamEvent } from './chat-stream';

describe('parseOmniRouteStreamEvent', () => {
  it('parses text and model events', () => {
    expect(parseOmniRouteStreamEvent('{"text":"Olá","model":"gpt-5"}')).toEqual({
      type: 'data',
      text: 'Olá',
      model: 'gpt-5',
    });
  });

  it('recognizes the stream terminator', () => {
    expect(parseOmniRouteStreamEvent('[DONE]')).toEqual({ type: 'done' });
  });

  it('propagates valid OmniRoute error events', () => {
    expect(() => parseOmniRouteStreamEvent('{"error":"Limite de uso atingido"}')).toThrow('Limite de uso atingido');
  });

  it('reports malformed JSON instead of ignoring it', () => {
    expect(() => parseOmniRouteStreamEvent('{"text":')).toThrow('JSON inválido recebido no stream do OmniRoute');
  });

  it('reports JSON values that are not event objects', () => {
    expect(() => parseOmniRouteStreamEvent('null')).toThrow('Evento inválido no stream do OmniRoute');
  });

  it('parses orchestration, approval and tool result events', () => {
    expect(parseOmniRouteStreamEvent('{"type":"job","jobId":"job-1"}')).toEqual({ type: 'job', jobId: 'job-1' });
    expect(parseOmniRouteStreamEvent('{"type":"approval","approval":{"id":"approval-1","kind":"command","summary":"Executar testes","check":"test"}}')).toEqual({
      type: 'approval',
      approval: { id: 'approval-1', kind: 'command', summary: 'Executar testes', check: 'test' },
    });
    expect(parseOmniRouteStreamEvent('{"type":"tool_result","result":{"tool":"read_file","ok":true,"message":"conteúdo"}}')).toEqual({
      type: 'tool_result',
      result: { tool: 'read_file', ok: true, message: 'conteúdo' },
    });
    expect(parseOmniRouteStreamEvent('{"type":"error","error":"falha da tarefa"}')).toEqual({ type: 'error', error: 'falha da tarefa' });
  });

  it('rejects malformed approval requests', () => {
    expect(() => parseOmniRouteStreamEvent('{"type":"approval","approval":{"id":"x","kind":"write"}}')).toThrow('Pedido de aprovação inválido');
  });
});
