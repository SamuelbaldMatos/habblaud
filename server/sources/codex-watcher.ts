import type { SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import { CODEX_RECENT_WINDOW_MS, readCodexSessionMetadata } from './codex';
import type { CodexSessionMetadata } from './codex';
import { opaqueSessionId, privateWorkspaceId } from './privacy';

const POLL_MS = 10_000;
const ACTIVE_MS = 45_000;

export class CodexWatcher {
  private readonly sessions = new Map<string, CodexSessionMetadata>();
  private timer?: NodeJS.Timeout;
  private ok = true;
  private error?: string;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      sessionsDir: string;
      office: Office;
      now?: () => number;
      pollMs?: number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.safePoll();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of this.sessions.keys()) this.opts.office.closeMain(this.agentId(id));
    this.sessions.clear();
  }

  poll(): void {
    const now = this.now();
    const result = readCodexSessionMetadata(this.opts.sessionsDir, { now });
    if (!result.ok) {
      this.ok = false;
      this.error = 'Não foi possível ler os metadados recentes do Codex.';
      log.warnOnce('codex:read-error', this.error);
      return;
    }

    this.ok = true;
    this.error = undefined;
    const seen = new Set<string>();
    for (const session of result.sessions) {
      const id = session.session_id;
      const agentId = this.agentId(id);
      const publicSessionId = opaqueSessionId('codex', id);
      const previous = this.sessions.get(id);
      const age = now - session.modified_at;
      const status = age >= 0 && age <= ACTIVE_MS ? 'working' : 'idle';
      const startedAt = Date.parse(session.timestamp);
      this.opts.office.addMain({
        id: agentId,
        account: 'codex',
        sessionId: publicSessionId,
        cwd: privateWorkspaceId(session.cwd),
        role: 'Codex (experimental)',
        startedAt: Number.isFinite(startedAt) ? startedAt : session.modified_at,
        status,
      });
      if (!previous || previous.modified_at !== session.modified_at) {
        this.opts.office.addActivity(
          agentId,
          {
            id: `${agentId}:activity:${session.modified_at}`,
            at: session.modified_at,
            kind: 'other',
            icon: '💬',
            text: 'Atividade recente no Codex',
          },
          true,
        );
      }
      this.sessions.set(id, session);
      seen.add(id);
    }

    for (const [id, session] of this.sessions) {
      if (seen.has(id) || now - session.modified_at <= CODEX_RECENT_WINDOW_MS) continue;
      this.opts.office.closeMain(this.agentId(id));
      this.sessions.delete(id);
    }
  }

  sources(): SourceInfo[] {
    return [
      {
        label: 'Codex (experimental)',
        path: 'Codex sessions',
        sessions: this.sessions.size,
        ok: this.ok,
        ...(this.error ? { error: this.error } : {}),
      },
    ];
  }

  private safePoll(): void {
    try {
      this.poll();
    } catch (error) {
      this.ok = false;
      this.error = 'Falha ao consultar metadados recentes do Codex.';
      log.warnOnce('codex:unexpected-error', `Falha ao consultar metadados recentes do Codex: ${errMsg(error)}`);
    }
  }

  private agentId(sessionId: string): string {
    return `codex:${opaqueSessionId('codex', sessionId)}`;
  }
}
