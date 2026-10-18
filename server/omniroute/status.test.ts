import { describe, expect, it, vi } from 'vitest';
import {
  claudeUsageFrom,
  collectOmniStatus,
  OmniStatusError,
  OmniStatusService,
  publicStatusError,
  quotaPct,
  type OmniSnapshot,
} from './status';

// Data fixa para todos os testes (evita dependência de Date.now())
const NOW = Date.parse('2026-10-18T12:00:00Z'); // 1760774400000

// ---------------------------------------------------------------------------
// 1. quotaPct
// ---------------------------------------------------------------------------

describe('quotaPct', () => {
  it('calcula percentual a partir de {used, total}', () => {
    expect(quotaPct({ used: 30, total: 100 })).toBe(30);
  });

  it('calcula percentual a partir de {remainingPercentage}', () => {
    // usado = 100 - 40 = 60
    expect(quotaPct({ remainingPercentage: 40 })).toBe(60);
  });

  it('retorna 0 quando unlimited: true', () => {
    expect(quotaPct({ unlimited: true })).toBe(0);
  });

  it('retorna undefined quando total é 0', () => {
    expect(quotaPct({ used: 0, total: 0 })).toBeUndefined();
  });

  it('retorna undefined quando total está ausente', () => {
    expect(quotaPct({ used: 10 })).toBeUndefined();
  });

  it('limita o resultado a 100 (não ultrapassa teto)', () => {
    expect(quotaPct({ used: 200, total: 100 })).toBe(100);
  });

  it('limita o resultado a 0 (não vai abaixo do piso)', () => {
    expect(quotaPct({ used: -50, total: 100 })).toBe(0);
  });

  it('limita remainingPercentage acima de 100 a 0% usado', () => {
    // 100 - 110 = -10 → clip para 0
    expect(quotaPct({ remainingPercentage: 110 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. claudeUsageFrom
// ---------------------------------------------------------------------------

describe('claudeUsageFrom', () => {
  const fiveHourReset = '2026-10-18T17:00:00Z';
  const weeklyReset = '2026-10-25T12:00:00Z';

  const cacheComDuas = {
    fetchedAt: '2026-10-18T12:00:00Z',
    quotas: {
      'session (5h)': { used: 40, total: 100, resetAt: fiveHourReset },
      'weekly (7d)': { used: 70, total: 100, resetAt: weeklyReset },
    },
  };

  it('converte cota "session (5h)" em fiveHour com utilization arredondado', () => {
    const usage = claudeUsageFrom(cacheComDuas, NOW);
    expect(usage?.fiveHour?.utilization).toBe(40);
  });

  it('converte cota "weekly (7d)" em sevenDay com utilization arredondado', () => {
    const usage = claudeUsageFrom(cacheComDuas, NOW);
    expect(usage?.sevenDay?.utilization).toBe(70);
  });

  it('resetsAt vem como epoch ms', () => {
    const usage = claudeUsageFrom(cacheComDuas, NOW);
    expect(usage?.fiveHour?.resetsAt).toBe(Date.parse(fiveHourReset));
    expect(usage?.sevenDay?.resetsAt).toBe(Date.parse(weeklyReset));
  });

  it('source é "omniroute"', () => {
    const usage = claudeUsageFrom(cacheComDuas, NOW);
    expect(usage?.source).toBe('omniroute');
  });

  it('utilization é arredondado (sem casas decimais)', () => {
    const cache = {
      quotas: { 'session (5h)': { used: 1, total: 3 } }, // 33.333...
    };
    const usage = claudeUsageFrom(cache, NOW);
    expect(usage?.fiveHour?.utilization).toBe(33);
  });

  it('reconhece variante "session" do Codex (sem "(5h)")', () => {
    const cache = { quotas: { session: { used: 50, total: 100 } } };
    const usage = claudeUsageFrom(cache, NOW);
    expect(usage?.fiveHour?.utilization).toBe(50);
  });

  it('reconhece variante "weekly" do Codex (sem "(7d)")', () => {
    const cache = { quotas: { weekly: { used: 20, total: 100 } } };
    const usage = claudeUsageFrom(cache, NOW);
    expect(usage?.sevenDay?.utilization).toBe(20);
  });

  it('retorna undefined quando não há nenhuma das duas cotas', () => {
    const cache = { quotas: { outras: { used: 10, total: 100 } } };
    expect(claudeUsageFrom(cache, NOW)).toBeUndefined();
  });

  it('fetchedAt usa now quando cache não tem fetchedAt', () => {
    const cache = { quotas: { session: { used: 0, total: 100 } } };
    const usage = claudeUsageFrom(cache, NOW);
    expect(usage?.fetchedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Helpers para montar respostas falsas do OmniRoute
// ---------------------------------------------------------------------------

const ID_COMPLETO = 'conn-aabbccdd-1234-5678-abcd-eeff00112233';
const ID_CURTO = ID_COMPLETO.slice(0, 8); // 'conn-aab'

/** Cria um Map caminho→resposta e retorna um `get` falso. */
function makeFetcher(map: Record<string, unknown>) {
  return async (path: string): Promise<unknown> => {
    if (path in map) return map[path];
    throw new Error(`Caminho não mockado: ${path}`);
  };
}

/** Resposta mínima de /api/providers com UMA conexão configurável. */
function providersPayload(overrides: Record<string, unknown> = {}) {
  return {
    connections: [
      {
        id: ID_COMPLETO,
        provider: 'claude',
        isActive: true,
        testStatus: 'active',
        email: 'Pessoa@Exemplo.com', // maiúsculas para testar lowercase
        providerSpecificData: {
          copilotToken: 'ghp_SUPERSECRETTOKEN9999',
        },
        apiKey: 'sk-abcdefghijklmnop1234',
        accessToken: 'oauth-access-token-xyz',
        refreshToken: 'oauth-refresh-token-abc',
        ...overrides,
      },
    ],
  };
}

/** Resposta mínima de /api/usage/provider-limits. */
function limitsPayload(quotasOverrides: Record<string, unknown> = {}) {
  return {
    caches: {
      [ID_COMPLETO]: {
        plan: 'Pro',
        fetchedAt: '2026-10-18T12:00:00Z',
        quotas: {
          'session (5h)': { used: 50, total: 100, resetAt: '2026-10-18T17:00:00Z' },
          'weekly (7d)': { used: 20, total: 100, resetAt: '2026-10-25T12:00:00Z' },
          ...quotasOverrides,
        },
      },
    },
  };
}

const analyticsMock = {
  summary: {
    totalRequests: 500,
    successRatePct: 98.5,
    totalTokens: 123456,
    avgLatencyMs: 340.7,
    lastRequest: '2026-10-18T11:59:00Z',
  },
  byProvider: [{ provider: 'claude', requests: 500, totalTokens: 123456, successRatePct: 98.5 }],
};

const healthMock = {
  combos: [
    {
      comboName: 'claude-pro',
      targetHealth: [
        { model: 'claude-3-5-sonnet', requests: 100, successRate: 0.99, lastStatus: 'ok', avgLatencyMs: 310 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. collectOmniStatus
// ---------------------------------------------------------------------------

describe('collectOmniStatus', () => {
  // -------------------------------------------------------------------------
  // 3a. Lista branca — dados sensíveis NÃO devem sair
  // -------------------------------------------------------------------------
  describe('lista branca de campos sensíveis', () => {
    it('não vaza copilotToken, apiKey, accessToken, refreshToken nem e-mail completo', async () => {
      const get = makeFetcher({
        '/api/providers': providersPayload(),
        '/api/usage/provider-limits': limitsPayload(),
        '/api/usage/analytics': analyticsMock,
        '/api/usage/combo-health?range=24h': healthMock,
      });
      const { status } = await collectOmniStatus(get, NOW);
      const json = JSON.stringify(status);

      // Tokens e chaves sensíveis NÃO devem aparecer
      expect(json).not.toContain('ghp_SUPERSECRETTOKEN9999');
      expect(json).not.toContain('sk-abcdefghijklmnop1234');
      expect(json).not.toContain('oauth-access-token-xyz');
      expect(json).not.toContain('oauth-refresh-token-abc');

      // E-mail completo NÃO deve sair
      expect(json).not.toContain('pessoa@exemplo.com');
      expect(json).not.toContain('Pessoa@Exemplo.com');

      // Id completo NÃO deve sair (apenas os 8 primeiros são permitidos)
      expect(json).not.toContain(ID_COMPLETO);
      // Os 8 primeiros podem sair
      expect(json).toContain(ID_CURTO);
    });
  });

  // -------------------------------------------------------------------------
  // 3b. lastError com e-mail e token deve ser sanitizado
  // -------------------------------------------------------------------------
  it('lastError com e-mail e token sai com <conta> e ***', async () => {
    const get = makeFetcher({
      '/api/providers': providersPayload({
        testStatus: 'error',
        lastError: 'Falha ao autenticar pessoa@exemplo.com com sk-abcdefghijklmnop1234',
      }),
      '/api/usage/provider-limits': limitsPayload(),
      '/api/usage/analytics': {},
      '/api/usage/combo-health?range=24h': {},
    });
    const { status } = await collectOmniStatus(get, NOW);
    const erro = status.providers[0]?.error ?? '';
    expect(erro).toContain('<conta>');
    expect(erro).toContain('***');
    expect(erro).not.toContain('pessoa@exemplo.com');
    expect(erro).not.toContain('sk-abcdefghijklmnop1234');
  });

  // -------------------------------------------------------------------------
  // 3c. Estado das conexões
  // -------------------------------------------------------------------------
  describe('state da conexão', () => {
    it('rateLimitedUntil no futuro → state "limited" com limitedUntil', async () => {
      const futuro = new Date(NOW + 60_000).toISOString();
      const get = makeFetcher({
        '/api/providers': providersPayload({ rateLimitedUntil: futuro }),
        '/api/usage/provider-limits': limitsPayload(),
        '/api/usage/analytics': {},
        '/api/usage/combo-health?range=24h': {},
      });
      const { status } = await collectOmniStatus(get, NOW);
      const p = status.providers[0]!;
      expect(p.state).toBe('limited');
      expect(p.limitedUntil).toBe(Date.parse(futuro));
    });

    it('lastErrorType "quota_exhausted" → state "limited"', async () => {
      const get = makeFetcher({
        '/api/providers': providersPayload({ lastErrorType: 'quota_exhausted' }),
        '/api/usage/provider-limits': limitsPayload(),
        '/api/usage/analytics': {},
        '/api/usage/combo-health?range=24h': {},
      });
      const { status } = await collectOmniStatus(get, NOW);
      expect(status.providers[0]?.state).toBe('limited');
    });

    it('testStatus "active" → state "ok"', async () => {
      const get = makeFetcher({
        '/api/providers': providersPayload({ testStatus: 'active' }),
        '/api/usage/provider-limits': limitsPayload(),
        '/api/usage/analytics': {},
        '/api/usage/combo-health?range=24h': {},
      });
      const { status } = await collectOmniStatus(get, NOW);
      expect(status.providers[0]?.state).toBe('ok');
    });

    it('testStatus com valor diferente de "active" → state "error"', async () => {
      const get = makeFetcher({
        '/api/providers': providersPayload({ testStatus: 'failed' }),
        '/api/usage/provider-limits': limitsPayload(),
        '/api/usage/analytics': {},
        '/api/usage/combo-health?range=24h': {},
      });
      const { status } = await collectOmniStatus(get, NOW);
      expect(status.providers[0]?.state).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // 3d. claudeUsageByEmail usa e-mail em minúsculas
  // -------------------------------------------------------------------------
  it('claudeUsageByEmail usa o e-mail em minúsculas da conexão provider "claude"', async () => {
    const get = makeFetcher({
      '/api/providers': providersPayload({ email: 'UPPER@EXEMPLO.COM' }),
      '/api/usage/provider-limits': limitsPayload(),
      '/api/usage/analytics': {},
      '/api/usage/combo-health?range=24h': {},
    });
    const { claudeUsageByEmail } = await collectOmniStatus(get, NOW);
    expect(claudeUsageByEmail.has('upper@exemplo.com')).toBe(true);
    expect(claudeUsageByEmail.has('UPPER@EXEMPLO.COM')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3e. Rótulos
  // -------------------------------------------------------------------------
  describe('rótulos de providers', () => {
    async function labelDe(provider: string) {
      const get = makeFetcher({
        '/api/providers': {
          connections: [{ id: 'id-rotulo-01', provider, isActive: true }],
        },
        '/api/usage/provider-limits': {},
        '/api/usage/analytics': {},
        '/api/usage/combo-health?range=24h': {},
      });
      const { status } = await collectOmniStatus(get, NOW);
      return status.providers[0]?.label;
    }

    it('provider "agy" → "Antigravity (gmail)"', async () => {
      expect(await labelDe('agy')).toBe('Antigravity (gmail)');
    });

    it('provider "antigravity" → "Antigravity (bcgestao)"', async () => {
      expect(await labelDe('antigravity')).toBe('Antigravity (bcgestao)');
    });
  });

  // -------------------------------------------------------------------------
  // 3f. Cotas ordenadas e no máximo 6; cota com total 0 descartada
  // -------------------------------------------------------------------------
  it('quotas ordenadas da mais gasta para a menos, no máximo 6', async () => {
    const quotas: Record<string, unknown> = {};
    // Cria 8 cotas com percentuais variados
    for (let i = 1; i <= 8; i++) {
      quotas[`cota-${i}`] = { used: i * 10, total: 100 };
    }
    const get = makeFetcher({
      '/api/providers': providersPayload(),
      '/api/usage/provider-limits': limitsPayload(quotas),
      '/api/usage/analytics': {},
      '/api/usage/combo-health?range=24h': {},
    });
    const { status } = await collectOmniStatus(get, NOW);
    const qs = status.providers[0]?.quotas ?? [];
    // No máximo 6
    expect(qs.length).toBeLessThanOrEqual(6);
    // Ordenadas decrescentemente
    for (let i = 0; i < qs.length - 1; i++) {
      expect(qs[i]!.usedPct).toBeGreaterThanOrEqual(qs[i + 1]!.usedPct);
    }
  });

  it('cota com total 0 e sem remainingPercentage é descartada', async () => {
    const get = makeFetcher({
      '/api/providers': providersPayload(),
      '/api/usage/provider-limits': limitsPayload({
        'cash-zero': { used: 0, total: 0 },
      }),
      '/api/usage/analytics': {},
      '/api/usage/combo-health?range=24h': {},
    });
    const { status } = await collectOmniStatus(get, NOW);
    const nomes = status.providers[0]?.quotas.map((q) => q.name) ?? [];
    expect(nomes).not.toContain('cash-zero');
  });

  // -------------------------------------------------------------------------
  // 3g. Falha em endpoint secundário não derruba providers
  // -------------------------------------------------------------------------
  it('falha em limits, analytics e health não derruba a listagem de providers', async () => {
    const get = async (path: string): Promise<unknown> => {
      if (path === '/api/providers') return providersPayload();
      // Todos os secundários rejeitam
      throw new Error(`Endpoint indisponível: ${path}`);
    };
    const { status } = await collectOmniStatus(get, NOW);
    expect(status.ok).toBe(true);
    expect(status.providers).toHaveLength(1);
    expect(status.providers[0]?.provider).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// 4. publicStatusError
// ---------------------------------------------------------------------------

describe('publicStatusError', () => {
  it('OmniStatusError passa a mensagem original', () => {
    const err = new OmniStatusError('Serviço temporariamente fora do ar');
    expect(publicStatusError(err)).toBe('Serviço temporariamente fora do ar');
  });

  it('OmniStatusError tem mensagem truncada a 160 caracteres', () => {
    const longa = 'x'.repeat(200);
    const err = new OmniStatusError(longa);
    expect(publicStatusError(err).length).toBeLessThanOrEqual(160);
  });

  it('Error comum com corpo contendo segredo vira mensagem fixa (sem o segredo)', () => {
    // Simula um erro que contém corpo JSON com dado sensível na mensagem
    const err = new Error('{"segredo":"x","token":"abc"}');
    const msg = publicStatusError(err);
    expect(msg).toBe('OmniRoute indisponível ou com resposta inválida.');
    expect(msg).not.toContain('segredo');
  });

  it('valor não-Error retorna mensagem fixa', () => {
    expect(publicStatusError('string qualquer')).toBe('OmniRoute indisponível ou com resposta inválida.');
    expect(publicStatusError(null)).toBe('OmniRoute indisponível ou com resposta inválida.');
  });
});

// ---------------------------------------------------------------------------
// 5. OmniStatusService
// ---------------------------------------------------------------------------

describe('OmniStatusService', () => {
  /** Cria um fetcher que conta chamadas e retorna sempre sucesso. */
  function makeContador() {
    let chamadas = 0;
    const get = async (path: string): Promise<unknown> => {
      if (path === '/api/providers') {
        chamadas++;
        return providersPayload();
      }
      return {};
    };
    return { get, getChamadas: () => chamadas };
  }

  // -------------------------------------------------------------------------
  // 5a. Cache por TTL
  // -------------------------------------------------------------------------
  it('segunda chamada dentro do TTL não chama get de novo', async () => {
    const { get, getChamadas } = makeContador();
    let tempoAtual = NOW;
    const svc = new OmniStatusService({
      get,
      ttlMs: 60_000,
      now: () => tempoAtual,
    });

    await svc.snapshot();
    expect(getChamadas()).toBe(1);

    // Avança 30 s (dentro do TTL de 60 s)
    tempoAtual = NOW + 30_000;
    await svc.snapshot();
    expect(getChamadas()).toBe(1); // ainda não deve ter chamado de novo
  });

  it('chamada após expirar o TTL chama get novamente', async () => {
    const { get, getChamadas } = makeContador();
    let tempoAtual = NOW;
    const svc = new OmniStatusService({
      get,
      ttlMs: 10_000,
      now: () => tempoAtual,
    });

    await svc.snapshot();
    expect(getChamadas()).toBe(1);

    // Avança além do TTL
    tempoAtual = NOW + 11_000;
    await svc.snapshot();
    expect(getChamadas()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 5b. Falha: ok:false com mensagem pública e providers do último sucesso
  // -------------------------------------------------------------------------
  it('falha devolve ok:false com mensagem pública e mantém providers do último sucesso', async () => {
    let devefalhar = false;
    const get = async (path: string): Promise<unknown> => {
      if (devefalhar) throw new Error('{"segredo":"dados sensíveis"}');
      if (path === '/api/providers') return providersPayload();
      return {};
    };

    let tempoAtual = NOW;
    const svc = new OmniStatusService({
      get,
      ttlMs: 10_000,
      now: () => tempoAtual,
    });

    // Primeiro snapshot: sucesso
    const snap1 = await svc.snapshot();
    expect(snap1.status.ok).toBe(true);
    expect(snap1.status.providers).toHaveLength(1);

    // Força expiração e falha
    tempoAtual = NOW + 11_000;
    devefalhar = true;
    const snap2 = await svc.snapshot();

    expect(snap2.status.ok).toBe(false);
    // Mensagem pública (sem conteúdo sensível)
    expect(snap2.status.error).toBe('OmniRoute indisponível ou com resposta inválida.');
    expect(snap2.status.error).not.toContain('segredo');
    // Providers do último sucesso ainda presentes
    expect(snap2.status.providers).toHaveLength(1);
  });

  it('falha com OmniStatusError expõe a mensagem original', async () => {
    const get = async (): Promise<unknown> => {
      throw new OmniStatusError('Chave de API expirada');
    };
    const svc = new OmniStatusService({ get, now: () => NOW });
    const snap = await svc.snapshot();
    expect(snap.status.ok).toBe(false);
    expect(snap.status.error).toBe('Chave de API expirada');
  });

  // -------------------------------------------------------------------------
  // 5c. onSnapshot chamado no sucesso
  // -------------------------------------------------------------------------
  it('onSnapshot é chamado quando a coleta tem sucesso', async () => {
    const snapshots: OmniSnapshot[] = [];
    const { get } = makeContador();
    const svc = new OmniStatusService({
      get,
      now: () => NOW,
      onSnapshot: (s) => snapshots.push(s),
    });

    await svc.snapshot();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status.ok).toBe(true);
  });

  it('onSnapshot NÃO é chamado quando a coleta falha', async () => {
    const snapshots: OmniSnapshot[] = [];
    const get = async (): Promise<unknown> => {
      throw new Error('falhou');
    };
    const svc = new OmniStatusService({
      get,
      now: () => NOW,
      onSnapshot: (s) => snapshots.push(s),
    });

    await svc.snapshot();
    expect(snapshots).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5d. force=true ignora o cache
  // -------------------------------------------------------------------------
  it('snapshot(force=true) ignora o TTL e chama get de novo', async () => {
    const { get, getChamadas } = makeContador();
    let tempoAtual = NOW;
    const svc = new OmniStatusService({
      get,
      ttlMs: 60_000,
      now: () => tempoAtual,
    });

    await svc.snapshot();
    expect(getChamadas()).toBe(1);

    // Ainda dentro do TTL mas força atualização
    tempoAtual = NOW + 5_000;
    await svc.snapshot(true);
    expect(getChamadas()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 5e. Inflight: chamadas simultâneas não duplicam a requisição
  // -------------------------------------------------------------------------
  it('chamadas simultâneas compartilham o mesmo inflight', async () => {
    const { get, getChamadas } = makeContador();
    const svc = new OmniStatusService({ get, now: () => NOW });

    // Dispara duas chamadas ao mesmo tempo (sem await entre elas)
    const [snap1, snap2] = await Promise.all([svc.snapshot(), svc.snapshot()]);
    expect(getChamadas()).toBe(1);
    // Ambas devem ter recebido o mesmo resultado
    expect(snap1.status.fetchedAt).toBe(snap2.status.fetchedAt);
  });
});
