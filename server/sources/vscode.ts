import { isAbsolute as isPosixAbsolute } from 'node:path/posix';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import type { SourceInfo } from '../../shared/types';
import type { Office } from '../model/office';
import { opaqueSessionId, privateWorkspaceId } from './privacy';

function isAnyAbsolute(p: string): boolean {
  return isPosixAbsolute(p) || isWindowsAbsolute(p);
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const SESSION_TTL_MS = 60 * 60 * 1_000;

export type VscodeHookEventName = (typeof EVENTS)[number];

export interface VscodeHookEvent {
  event: VscodeHookEventName;
  sessionId: string;
  cwd: string;
  toolName?: string;
}

export interface VscodeEventResult {
  ok: boolean;
  error?: string;
}

function parseEvent(input: unknown): VscodeHookEvent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.event !== 'string' || !EVENTS.includes(value.event as VscodeHookEventName)) return undefined;
  if (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) return undefined;
  if (typeof value.cwd !== 'string' || value.cwd.length > 4_096 || !isAnyAbsolute(value.cwd)) return undefined;
  if (value.toolName !== undefined && (typeof value.toolName !== 'string' || !TOOL_NAME.test(value.toolName))) return undefined;
  if ((value.event === 'PreToolUse' || value.event === 'PostToolUse') && value.toolName === undefined) return undefined;
  return {
    event: value.event as VscodeHookEventName,
    sessionId: value.sessionId,
    cwd: value.cwd,
    ...(typeof value.toolName === 'string' ? { toolName: value.toolName } : {}),
  };
}

function activityFor(event: VscodeHookEvent, at: number, seq: number, agentId: string) {
  const tool = event.toolName;
  switch (event.event) {
    case 'SessionStart':
      return { id: `${agentId}:${seq}`, at, kind: 'other' as const, icon: '🪟', text: 'Sessão VS Code conectada' };
    case 'UserPromptSubmit':
      return { id: `${agentId}:${seq}`, at, kind: 'prompt' as const, icon: '💬', text: 'Nova mensagem para o agente' };
    case 'PreToolUse':
      return {
        id: `${agentId}:${seq}`,
        at,
        kind: 'other' as const,
        icon: '⚙️',
        text: `Usando ${(tool ?? 'ferramenta').slice(0, 32)}`,
        tool,
      };
    case 'PostToolUse':
      return {
        id: `${agentId}:${seq}`,
        at,
        kind: 'other' as const,
        icon: '✓',
        text: `Concluiu ${(tool ?? 'ferramenta').slice(0, 32)}`,
        tool,
      };
    case 'Stop':
      return { id: `${agentId}:${seq}`, at, kind: 'done' as const, icon: '✅', text: 'Concluiu a resposta' };
  }
}

export class VscodeActivitySource {
  private readonly sessions = new Set<string>();
  private timer?: NodeJS.Timeout;
  private seq = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly opts: {
      office: Office;
      path: string;
      now?: () => number;
      ttlMs?: number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of this.sessions) this.opts.office.closeMain(id);
    this.sessions.clear();
  }

  record(input: unknown): VscodeEventResult {
    const event = parseEvent(input);
    if (!event) return { ok: false, error: 'evento VS Code inválido' };

    const publicSessionId = opaqueSessionId('vscode', event.sessionId);
    const id = `vscode:${publicSessionId}`;
    const at = this.now();
    const status = event.event === 'Stop' || event.event === 'SessionStart' ? 'idle' : 'working';
    this.opts.office.addMain({
      id,
      account: 'vscode-copilot',
      sessionId: publicSessionId,
      cwd: privateWorkspaceId(event.cwd),
      role: 'VS Code Copilot',
      startedAt: at,
      status,
    });
    this.sessions.add(id);
    if (event.event === 'Stop') this.opts.office.setStatus(id, 'idle');
    this.opts.office.addActivity(id, activityFor(event, at, ++this.seq, id), true);
    return { ok: true };
  }

  sources(): SourceInfo[] {
    return [{ label: 'VS Code (Local hooks)', path: 'VS Code hooks', sessions: this.sessions.size, ok: true }];
  }

  private sweep(): void {
    const now = this.now();
    for (const id of this.sessions) {
      const agent = this.opts.office.get(id);
      if (!agent) {
        this.sessions.delete(id);
        continue;
      }
      if (now - agent.lastEventAt <= this.ttlMs) continue;
      this.opts.office.closeMain(id);
      this.sessions.delete(id);
    }
  }
}
