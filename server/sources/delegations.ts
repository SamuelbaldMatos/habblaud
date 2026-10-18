// Delegações do OmniRoute no escritório: cada tarefa que o coordenador (Claude, Codex, VS Code...) manda para um
// combo de outra provedora vira um agente na sala do projeto. Assim a divisão do trabalho fica visível: quem está
// com qual tarefa, por qual combo, qual modelo respondeu e quando terminou.
// Entrada: POST /api/delegations (só local), um evento por mudança. Nada do pedido nem da resposta é guardado:
// só título curto, combo, modelo e estado.
import { isAbsolute as isPosixAbsolute } from 'node:path/posix';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import type { SourceInfo } from '../../shared/types';
import type { Office } from '../model/office';
import { opaqueSessionId } from './privacy';

const ID = /^[A-Za-z0-9._:-]{1,80}$/;
const COMBO = /^[a-z0-9-]{1,48}$/;
const STATES = ['working', 'done', 'error'] as const;
/** Delegação sem notícia há mais que isto sai do escritório (o despachante pode ter morrido). */
const STALE_MS = 30 * 60_000;

export type DelegationState = (typeof STATES)[number];

export interface DelegationEvent {
  id: string;
  combo: string;
  title: string;
  state: DelegationState;
  cwd: string;
  model?: string;
  detail?: string;
}

function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

export function parseDelegation(input: unknown): DelegationEvent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const v = input as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID.test(v.id)) return undefined;
  if (typeof v.combo !== 'string' || !COMBO.test(v.combo)) return undefined;
  if (typeof v.state !== 'string' || !STATES.includes(v.state as DelegationState)) return undefined;
  if (typeof v.cwd !== 'string' || v.cwd.length > 4_096 || !(isPosixAbsolute(v.cwd) || isWindowsAbsolute(v.cwd))) return undefined;
  const title = oneLine(v.title, 120);
  if (!title) return undefined;
  const ev: DelegationEvent = { id: v.id, combo: v.combo, title, state: v.state as DelegationState, cwd: v.cwd };
  const model = oneLine(v.model, 60);
  if (model) ev.model = model;
  const detail = oneLine(v.detail, 160);
  if (detail) ev.detail = detail;
  return ev;
}

export class DelegationSource {
  private readonly seen = new Map<string, number>();
  private seq = 0;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly opts: { office: Office; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of this.seen.keys()) this.opts.office.closeMain(id);
    this.seen.clear();
  }

  record(input: unknown): { ok: boolean; error?: string } {
    const ev = parseDelegation(input);
    if (!ev) return { ok: false, error: 'delegação inválida' };
    const id = `delegacao:${opaqueSessionId('delegacao', ev.id)}`;
    const at = this.now();
    const role = `${ev.combo}${ev.model ? ` · ${ev.model}` : ''}`;
    this.opts.office.addMain({
      id,
      account: 'omniroute',
      sessionId: id.slice(10, 26),
      cwd: ev.cwd,
      role,
      startedAt: this.seen.get(id) ?? at,
      status: ev.state === 'working' ? 'working' : 'idle',
    });
    if (!this.seen.has(id)) this.seen.set(id, at);
    const prefix = ev.state === 'done' ? 'Entregou: ' : ev.state === 'error' ? 'Falhou: ' : '';
    const full = `${prefix}${ev.title}`;
    this.opts.office.addActivity(id, {
      id: `${id}:${++this.seq}`,
      at,
      kind: ev.state === 'done' ? 'done' : 'other',
      icon: ev.state === 'working' ? '🔀' : ev.state === 'done' ? '📦' : '⚠️',
      // Texto curto no balão; o resto (título inteiro, etapa, modelo) no detalhe.
      text: full.length > 46 ? `${full.slice(0, 45)}…` : full,
      detail: [full, ev.detail, ev.model && `modelo ${ev.model}`].filter(Boolean).join(' · ').slice(0, 300),
      ...(ev.state === 'error' ? { error: true } : {}),
    }, true);
    if (ev.state !== 'working') this.opts.office.setStatus(id, 'idle');
    this.last.set(id, at);
    return { ok: true };
  }

  /** Última notícia de cada delegação (o sweep tira as paradas há mais de 30 min). */
  private readonly last = new Map<string, number>();

  sources(): SourceInfo[] {
    return [{ label: 'Delegações OmniRoute', path: 'POST /api/delegations', sessions: this.seen.size, ok: true }];
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, at] of this.last) {
      if (now - at < STALE_MS) continue;
      this.opts.office.closeMain(id);
      this.last.delete(id);
      this.seen.delete(id);
    }
  }
}
