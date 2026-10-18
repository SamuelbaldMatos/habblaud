// Estado do OmniRoute para o Habblaud: conexões (contas), cotas, saúde dos combos e números de uso.
// Lê só rotas que aceitam a chave do /v1 (/api/providers, /api/usage/provider-limits, /api/usage/analytics e
// /api/usage/combo-health) e devolve uma LISTA BRANCA de campos: tokens, chaves e dados de OAuth nunca saem daqui.
// Os e-mails ficam só no servidor (para ligar a conexão Claude às contas do Habblaud) e não vão para o navegador.
import type { AccountUsage, UsageWindow } from '../../shared/types';

export interface OmniQuota {
  name: string;
  /** 0–100. */
  usedPct: number;
  resetAt?: number;
}

export interface OmniProvider {
  /** 8 primeiros caracteres do id da conexão (estável, não sensível). */
  id: string;
  provider: string;
  label: string;
  active: boolean;
  /** ok | limitado | erro | desconhecido */
  state: 'ok' | 'limited' | 'error' | 'unknown';
  error?: string;
  limitedUntil?: number;
  plan?: string;
  quotas: OmniQuota[];
}

export interface OmniComboTarget {
  model: string;
  requests: number;
  successRate: number;
  lastStatus?: string;
  avgLatencyMs?: number;
}

export interface OmniComboHealth {
  name: string;
  targets: OmniComboTarget[];
}

export interface OmniStatus {
  ok: boolean;
  error?: string;
  fetchedAt: number;
  providers: OmniProvider[];
  combos: OmniComboHealth[];
  summary?: {
    requests: number;
    successRatePct: number;
    totalTokens: number;
    avgLatencyMs: number;
    lastRequest?: number;
  };
  byProvider: Array<{ provider: string; requests: number; totalTokens: number; successRatePct: number }>;
}

type Json = Record<string, unknown>;

/** Erro com mensagem escrita pelo próprio Habblaud (segura para o navegador: sem corpo de resposta nem segredo). */
export class OmniStatusError extends Error {}

/** Mensagem pública do erro: só a dos nossos OmniStatusError; o resto (ex.: JSON inválido com trecho do corpo) não sai. */
export function publicStatusError(err: unknown): string {
  return err instanceof OmniStatusError ? err.message.slice(0, 160) : 'OmniRoute indisponível ou com resposta inválida.';
}
type Fetcher = (path: string) => Promise<unknown>;

const LABELS: Record<string, string> = {
  claude: 'Claude (assinatura)',
  codex: 'ChatGPT / Codex',
  agy: 'Antigravity (gmail)',
  antigravity: 'Antigravity (bcgestao)',
  github: 'GitHub Copilot',
  'ollama-local': 'Ollama local',
  moonshot: 'Kimi',
  cheaperinference: 'Cheaper Inference',
};

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function time(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
function clip(v: unknown, max = 140): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  // Mensagens de erro do provedor podem citar um e-mail ou token: some com eles antes de sair.
  return v.replace(/[\w.+-]+@[\w.-]+/g, '<conta>').replace(/\b(?:sk|eyJ)[\w.-]{12,}/g, '***').slice(0, max);
}

/** Percentual usado de uma cota no formato do OmniRoute ({used,total} ou {remainingPercentage}). */
export function quotaPct(q: Json): number | undefined {
  if (q.unlimited === true) return 0;
  const rem = num(q.remainingPercentage);
  if (rem !== undefined) return Math.min(100, Math.max(0, 100 - rem));
  const used = num(q.used);
  const total = num(q.total);
  if (used === undefined || !total) return undefined;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function quotasOf(cache: Json): OmniQuota[] {
  const out: OmniQuota[] = [];
  for (const [name, raw] of Object.entries(obj(cache.quotas))) {
    const q = obj(raw);
    const usedPct = quotaPct(q);
    if (usedPct === undefined) continue;
    // Cotas zeradas de saldo (ex.: Kimi "cash 0/0") não dizem nada.
    if (num(q.total) === 0 && q.remainingPercentage === undefined) continue;
    const quota: OmniQuota = { name, usedPct: Math.round(usedPct * 10) / 10 };
    const reset = time(q.resetAt);
    if (reset) quota.resetAt = reset;
    out.push(quota);
  }
  // As mais gastas primeiro (é o que limita o trabalho).
  return out.sort((a, b) => b.usedPct - a.usedPct).slice(0, 6);
}

/** Converte uma cota de 5h/semana do OmniRoute no uso de conta do Habblaud. */
export function claudeUsageFrom(cache: unknown, now: number): AccountUsage | undefined {
  const c = obj(cache);
  const fetchedAt = time(c.fetchedAt) ?? now;
  const usage: AccountUsage = { source: 'omniroute', fetchedAt };
  for (const [name, raw] of Object.entries(obj(c.quotas))) {
    const q = obj(raw);
    const pct = quotaPct(q);
    if (pct === undefined) continue;
    const w: UsageWindow = { utilization: Math.round(pct) };
    const reset = time(q.resetAt);
    if (reset) w.resetsAt = reset;
    if (/session|5h|five/i.test(name)) usage.fiveHour = w;
    else if (/week|7d|seven/i.test(name)) usage.sevenDay = w;
  }
  return usage.fiveHour || usage.sevenDay ? usage : undefined;
}

export interface OmniSnapshot {
  status: OmniStatus;
  /** Só no servidor: uso da assinatura Claude por e-mail da conexão (para as contas do Habblaud). */
  claudeUsageByEmail: Map<string, AccountUsage>;
}

export async function collectOmniStatus(get: Fetcher, now = Date.now()): Promise<OmniSnapshot> {
  const [providersRaw, limitsRaw, analyticsRaw, healthRaw] = await Promise.all([
    get('/api/providers'),
    get('/api/usage/provider-limits').catch(() => ({})),
    get('/api/usage/analytics').catch(() => ({})),
    get('/api/usage/combo-health?range=24h').catch(() => ({})),
  ]);
  const caches = obj(obj(limitsRaw).caches);
  const providers: OmniProvider[] = [];
  const claudeUsageByEmail = new Map<string, AccountUsage>();
  const connections = Array.isArray(obj(providersRaw).connections) ? (obj(providersRaw).connections as unknown[]) : [];
  for (const raw of connections) {
    const c = obj(raw);
    const id = typeof c.id === 'string' ? c.id : '';
    const provider = typeof c.provider === 'string' ? c.provider : '?';
    if (!id) continue;
    const cache = obj(caches[id]);
    const limitedUntil = time(c.rateLimitedUntil);
    const limited = (limitedUntil !== undefined && limitedUntil > now) || c.lastErrorType === 'quota_exhausted';
    const testStatus = typeof c.testStatus === 'string' ? c.testStatus : '';
    const p: OmniProvider = {
      id: id.slice(0, 8),
      provider,
      label: LABELS[provider] ?? (typeof c.name === 'string' && !c.name.includes('@') ? c.name : provider),
      active: c.isActive === true,
      state: limited ? 'limited' : testStatus === 'active' ? 'ok' : testStatus ? 'error' : 'unknown',
      quotas: quotasOf(cache),
    };
    if (limited && limitedUntil && limitedUntil > now) p.limitedUntil = limitedUntil;
    const err = p.state !== 'ok' ? clip(c.lastError) : undefined;
    if (err) p.error = err;
    const plan = clip(cache.plan, 40);
    if (plan) p.plan = plan;
    providers.push(p);
    if (provider === 'claude' && typeof c.email === 'string') {
      const usage = claudeUsageFrom(cache, now);
      if (usage) claudeUsageByEmail.set(c.email.toLowerCase(), usage);
    }
  }

  const combos: OmniComboHealth[] = [];
  for (const raw of Array.isArray(obj(healthRaw).combos) ? (obj(healthRaw).combos as unknown[]) : []) {
    const c = obj(raw);
    if (typeof c.comboName !== 'string') continue;
    const targets: OmniComboTarget[] = [];
    for (const t of Array.isArray(c.targetHealth) ? (c.targetHealth as unknown[]) : []) {
      const tt = obj(t);
      if (typeof tt.model !== 'string') continue;
      const target: OmniComboTarget = { model: tt.model, requests: num(tt.requests) ?? 0, successRate: num(tt.successRate) ?? 0 };
      if (typeof tt.lastStatus === 'string') target.lastStatus = tt.lastStatus;
      const lat = num(tt.avgLatencyMs);
      if (lat) target.avgLatencyMs = Math.round(lat);
      targets.push(target);
    }
    combos.push({ name: c.comboName, targets });
  }

  const an = obj(analyticsRaw);
  const s = obj(an.summary);
  const status: OmniStatus = { ok: true, fetchedAt: now, providers, combos, byProvider: [] };
  if (Object.keys(s).length) {
    status.summary = {
      requests: num(s.totalRequests) ?? 0,
      successRatePct: num(s.successRatePct) ?? 0,
      totalTokens: num(s.totalTokens) ?? 0,
      avgLatencyMs: Math.round(num(s.avgLatencyMs) ?? 0),
    };
    const last = time(s.lastRequest);
    if (last) status.summary.lastRequest = last;
  }
  for (const raw of Array.isArray(an.byProvider) ? (an.byProvider as unknown[]) : []) {
    const r = obj(raw);
    if (typeof r.provider !== 'string') continue;
    status.byProvider.push({
      provider: r.provider,
      requests: num(r.requests) ?? 0,
      totalTokens: num(r.totalTokens) ?? 0,
      successRatePct: num(r.successRatePct) ?? 0,
    });
  }
  return { status, claudeUsageByEmail };
}

/** Cache de 60 s na frente do OmniRoute (o painel e as contas leem daqui; nunca martelam o OmniRoute). */
export class OmniStatusService {
  private last: OmniSnapshot | undefined;
  private inflight: Promise<OmniSnapshot> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly opts: {
      get: Fetcher;
      ttlMs?: number;
      onSnapshot?: (snap: OmniSnapshot) => void;
      now?: () => number;
    },
  ) {}

  async snapshot(force = false): Promise<OmniSnapshot> {
    const now = (this.opts.now ?? Date.now)();
    if (!force && this.last && now - this.last.status.fetchedAt < (this.opts.ttlMs ?? 60_000)) return this.last;
    this.inflight ??= collectOmniStatus(this.opts.get, now)
      .then((snap) => {
        this.last = snap;
        this.opts.onSnapshot?.(snap);
        return snap;
      })
      .catch((err: unknown) => {
        const failed: OmniSnapshot = {
          status: {
            ...(this.last?.status ?? { providers: [], combos: [], byProvider: [] }),
            ok: false,
            error: publicStatusError(err),
            fetchedAt: now,
          },
          claudeUsageByEmail: this.last?.claudeUsageByEmail ?? new Map(),
        };
        this.last = failed;
        return failed;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  start(intervalMs = 120_000): void {
    if (this.timer) return;
    void this.snapshot(true);
    this.timer = setInterval(() => void this.snapshot(true), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
