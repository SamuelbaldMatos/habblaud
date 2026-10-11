export interface OmniRouteApproval {
  id: string;
  kind: 'write' | 'command';
  summary: string;
  path?: string;
  check?: string;
  oldContent?: string;
  newContent?: string;
  status?: 'approved' | 'rejected' | 'expired';
}

export type OmniRouteStreamEvent =
  | { type: 'done' }
  | { type: 'data'; text?: string; model?: string }
  | { type: 'job'; jobId: string }
  | { type: 'activity'; activity: string }
  | { type: 'approval'; approval: OmniRouteApproval }
  | { type: 'tool_result'; result: { tool: string; ok: boolean; message: string } }
  | { type: 'error'; error: string };

export function parseOmniRouteStreamEvent(payload: string): OmniRouteStreamEvent {
  if (payload === '[DONE]') return { type: 'done' };

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('JSON inválido recebido no stream do OmniRoute');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Evento inválido no stream do OmniRoute: era esperado um objeto JSON');
  }

  const data = value as Record<string, unknown>;
  if (data.type === 'done') return { type: 'done' };
  if (data.type === 'job' && typeof data.jobId === 'string') return { type: 'job', jobId: data.jobId };
  if (data.type === 'activity' && typeof data.activity === 'string') return { type: 'activity', activity: data.activity };
  if (data.type === 'error') {
    if (typeof data.error !== 'string' || !data.error) throw new Error('OmniRoute retornou um erro sem descrição');
    return { type: 'error', error: data.error };
  }
  if (data.type === 'approval' && data.approval && typeof data.approval === 'object' && !Array.isArray(data.approval)) {
    const approval = data.approval as Record<string, unknown>;
    if (
      typeof approval.id !== 'string' ||
      !['write', 'command'].includes(String(approval.kind)) ||
      typeof approval.summary !== 'string' ||
      (approval.path !== undefined && typeof approval.path !== 'string') ||
      (approval.check !== undefined && typeof approval.check !== 'string') ||
      (approval.oldContent !== undefined && typeof approval.oldContent !== 'string') ||
      (approval.newContent !== undefined && typeof approval.newContent !== 'string')
    ) {
      throw new Error('Pedido de aprovação inválido recebido do Habblaud');
    }
    return {
      type: 'approval',
      approval: {
        id: approval.id as string,
        kind: approval.kind as 'write' | 'command',
        summary: approval.summary as string,
        ...(typeof approval.path === 'string' ? { path: approval.path } : {}),
        ...(typeof approval.check === 'string' ? { check: approval.check } : {}),
        ...(typeof approval.oldContent === 'string' ? { oldContent: approval.oldContent } : {}),
        ...(typeof approval.newContent === 'string' ? { newContent: approval.newContent } : {}),
      },
    };
  }
  if (data.type === 'tool_result' && data.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
    const result = data.result as Record<string, unknown>;
    if (typeof result.tool !== 'string' || typeof result.ok !== 'boolean' || typeof result.message !== 'string') {
      throw new Error('Resultado de ferramenta inválido recebido do Habblaud');
    }
    return { type: 'tool_result', result: { tool: result.tool, ok: result.ok, message: result.message } };
  }
  if (typeof data.error === 'string') throw new Error(data.error);
  if (data.type === 'text' || data.type === 'model' || !data.type) {
    return {
      type: 'data',
      ...(typeof data.text === 'string' ? { text: data.text } : {}),
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
    };
  }
  throw new Error(`Tipo de evento desconhecido do Habblaud: ${String(data.type)}`);
}
