/**
 * DURABLE MARKET DATA CLIENT
 * ==========================
 * The Vercel application's authenticated door into the Cloudflare market-data
 * Durable Objects.
 *
 * WHY A CLIENT AND NOT A BINDING
 *
 * Vercel cannot bind a Durable Object. It also cannot hold a SQLite-backed
 * market store, run an alarm, or survive between requests. So the app talks to
 * the Worker over HTTPS with a shared secret, exactly as it already does for
 * the per-GOAT scheduler. That keeps the deployment split honest: Vercel owns
 * request/response work, Cloudflare owns the long-lived stateful runtime.
 *
 * THIS CLIENT OWNS NO MARKET STATE
 *
 * Everything here is a thin, authenticated request. There is no local cache of
 * candles and no fallback file: a cache in the Vercel function would be
 * recreated on every cold start and would be a second, divergent copy of the
 * canonical history. If the Worker is unreachable, this reports unreachable.
 *
 * SECRETS
 *
 * The shared secret is read from the environment and never logged, never
 * returned by any endpoint, and never sent anywhere but the configured worker
 * origin. User OpenRouter keys never reach this layer at all — the Worker
 * holds market data only and has no user identity.
 */

import type { CandleRecord } from './candle-core/CandleRecord';
import { validateMarketEvent } from './MarketEvent';
import type { MarketEvent } from './MarketEvent';

/** Partition names, matching the Durable Object routing keys exactly. */
export type DurablePartition = 'FX' | 'METALS' | 'ENERGY' | 'INDEX' | 'CRYPTO';

export interface DurableMarketDataEnv {
  /** Base URL of the deployed Worker, e.g. https://siggoat-scheduler.workers.dev */
  url: string | null;
  /** Shared secret; sent as `Authorization: Bearer ...`. */
  secret: string | null;
}

export interface DurableMarketHealth {
  reachable: boolean;
  reason?: string;
  /** Per-partition status, when the Worker answered. */
  partitions?: Array<{
    partition: string;
    subscriptions?: number;
    sessionSummaries?: number;
    levels?: number;
    instruments?: Array<{
      instrument: string;
      candles: number;
      newestCandleOpenTimeMs: number;
    }>;
    jobs?: Array<{
      name: string;
      kind: string;
      due_at_ms: number;
      attempts: number;
      last_error: string | null;
    }>;
  }>;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Reads configuration from the environment.
 *
 * `enabled` is false when EITHER half is missing, and never falls back to an
 * insecure default. A missing secret means the integration is simply off, not
 * open — that distinction matters more than convenience here.
 */
export function durableMarketDataEnvFromProcess(): DurableMarketHealthEnv {
  const url = process.env.MARKET_DATA_WORKER_URL?.trim() ?? null;
  const secret = process.env.MARKET_DATA_WORKER_SECRET?.trim() ?? null;
  return {
    url,
    secret,
    enabled: Boolean(url && secret),
  };
}

export interface DurableMarketHealthEnv extends DurableMarketDataEnv {
  enabled: boolean;
}

/**
 * Authenticated client for the market-data Durable Objects.
 *
 * Never throws. Every failure is returned as a structured result so a caller
 * can degrade deliberately instead of crashing a request handler.
 */
export class DurableMarketDataClient {
  private readonly baseUrl: string | null;
  private readonly secret: string | null;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  private lastError: string | null = null;
  private lastSuccessAtMs: number | null = null;

  readonly stats = {
    requests: 0,
    failures: 0,
    timeouts: 0,
  };

  constructor(
    env: DurableMarketHealthEnv,
    options: { timeoutMs?: number } = {},
  ) {
    this.baseUrl = env.url?.replace(/\/+$/, '') ?? null;
    this.secret = env.secret ?? null;
    this.enabled = env.enabled;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get lastFailure(): string | null {
    return this.lastError;
  }

  /* ---------------------------------------------------------------- */
  /* Subscriptions                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Registers interest in an instrument.
   *
   * `subscriberId` is an opaque routing key — in this application the GOAT
   * runtime id. The Worker never learns a user id, and the app never learns
   * the Worker's storage internals.
   */
  async subscribe(params: {
    partition: DurablePartition;
    subscriberId: string;
    instrument: string;
    eventTypes?: MarketEvent['type'][];
  }): Promise<{ ok: boolean; reason?: string }> {
    return this.post(`${params.partition.toLowerCase()}/subscribe`, {
      subscriberId: params.subscriberId,
      instrument: params.instrument,
      eventTypes: params.eventTypes ?? [],
    });
  }

  /**
   * Removes a subscription. Omitting `instrument` removes the subscriber from
   * EVERY partition, which is what GOAT deletion needs.
   */
  async unsubscribe(params: {
    partition?: DurablePartition;
    subscriberId: string;
    instrument?: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const partition = (params.partition ?? 'FX').toLowerCase();
    return this.post(`${partition}/unsubscribe`, {
      subscriberId: params.subscriberId,
      instrument: params.instrument,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Data                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Reads bounded candles from the canonical store.
   *
   * `limit` is enforced client-side as well as server-side. Even a
   * mis-configured Worker cannot make this return an unbounded array.
   */
  async candles(params: {
    partition: DurablePartition;
    instrument: string;
    limit?: number;
    beforeMs?: number;
  }): Promise<{ ok: boolean; candles: CandleRecord[]; truncated: boolean; reason?: string }> {
    const limit = Math.max(1, Math.min(2000, params.limit ?? 240));

    const query = new URLSearchParams({
      instrument: params.instrument,
      limit: String(limit),
    });
    if (params.beforeMs) query.set('beforeMs', String(params.beforeMs));

    const response = await this.request(
      `${params.partition.toLowerCase()}/candles?${query.toString()}`,
    );

    if (!response.ok || !response.body) {
      return {
        ok: false,
        candles: [],
        truncated: false,
        reason: response.reason ?? 'unavailable',
      };
    }

    const payload = response.body as {
      candles?: Array<Record<string, unknown>>;
      truncated?: boolean;
    };

    const candles: CandleRecord[] = [];
    for (const row of payload.candles ?? []) {
      const parsed = parseDurableCandle(row);
      if (parsed) candles.push(parsed);
    }

    return {
      ok: candles.length > 0,
      candles,
      truncated: Boolean(payload.truncated),
      reason: candles.length === 0 ? 'empty' : undefined,
    };
  }

  /** Forces an ingestion pass for a set of instruments. */
  async ingest(params: {
    partition: DurablePartition;
    instruments?: string[];
  }): Promise<{ ok: boolean; reason?: string; counts?: Record<string, number> }> {
    const response = await this.post(
      `${params.partition.toLowerCase()}/ingest`,
      { instruments: params.instruments ?? [] },
    );
    return response as { ok: boolean; reason?: string; counts?: Record<string, number> };
  }

  /** Forces finalization for one instrument. */
  async finalize(params: {
    partition: DurablePartition;
    instrument: string;
  }): Promise<{ ok: boolean; outcome?: string; pruned?: number; reason?: string }> {
    return this.post(`${params.partition.toLowerCase()}/finalize`, {
      instrument: params.instrument,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Health                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Reads every partition's status.
   *
   * Only meaningful for observability: it proves the runtime is reachable, how
   * much history it holds, and whether its alarms are healthy.
   */
  async health(): Promise<DurableMarketHealth> {
    if (!this.enabled) {
      return {
        reachable: false,
        reason: 'MARKET_DATA_WORKER_URL / MARKET_DATA_WORKER_SECRET not set.',
      };
    }

    const partitions = await Promise.all(
      (['FX', 'METALS', 'ENERGY', 'INDEX', 'CRYPTO'] as DurablePartition[]).map(
        async (partition) => {
          const response = await this.post(`${partition.toLowerCase()}/status`, {});
          const body = response as {
            subscriptions?: number;
            sessionSummaries?: number;
            levels?: number;
            instruments?: Array<{
              instrument: string;
              candles: number;
              newestCandleOpenTimeMs: number;
            }>;
            jobs?: Array<{
              name: string;
              kind: string;
              due_at_ms: number;
              attempts: number;
              last_error: string | null;
            }>;
          };

          return {
            partition,
            subscriptions: body.subscriptions,
            sessionSummaries: body.sessionSummaries,
            levels: body.levels,
            instruments: body.instruments,
            jobs: body.jobs,
          };
        },
      ),
    );

    return { reachable: true, partitions };
  }

  /* ---------------------------------------------------------------- */
  /* Transport                                                        */
  /* ---------------------------------------------------------------- */

  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown> & { ok: boolean; reason?: string }> {
    const response = await this.request(path, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });

    if (!response.ok) {
      return { ok: false, reason: response.reason ?? 'unavailable' };
    }

    return { ok: true, ...(response.body as Record<string, unknown>) };
  }

  /**
   * One authenticated request with a bounded timeout.
   *
   * Every failure mode is folded into a result — a network error, a timeout
   * and a 500 are all "the runtime is not answering right now", because that
   * is the only useful thing a caller can do about any of them.
   */
  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ ok: boolean; body: unknown; reason?: string }> {
    if (!this.enabled || !this.baseUrl || !this.secret) {
      return { ok: false, body: null, reason: 'market-data runtime not configured' };
    }

    this.stats.requests += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.secret}`,
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.stats.failures += 1;
        this.lastError = `HTTP ${response.status}`;
        return { ok: false, body: null, reason: `HTTP ${response.status}` };
      }

      this.lastSuccessAtMs = Date.now();
      this.lastError = null;

      const body = await response.json().catch(() => null);
      return { ok: true, body };
    } catch (err) {
      this.stats.failures += 1;
      const aborted = err instanceof Error && err.name === 'AbortError';
      if (aborted) this.stats.timeouts += 1;

      const reason = aborted ? 'timeout' : describe(err);
      this.lastError = reason;

      return { ok: false, body: null, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Compact status for the app's own health endpoint. No secrets. */
  describe(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      configured: Boolean(this.baseUrl && this.secret),
      stats: { ...this.stats },
      lastError: this.lastError,
      lastSuccessAtMs: this.lastSuccessAtMs,
    };
  }
}

/**
 * Validates a candle row coming back from the Durable Object.
 *
 * The Worker is trusted infrastructure, not a trusted input, so the same
 * validation the ingestion boundary applies is applied here. A row that cannot
 * be validated is dropped rather than handed to an indicator.
 */
function parseDurableCandle(row: Record<string, unknown>): CandleRecord | null {
  const openTimeMs = Number(row.open_time_ms ?? row.openTimeMs);
  if (!Number.isFinite(openTimeMs) || openTimeMs <= 0) return null;

  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);

  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (open <= 0 || close <= 0) return null;
  if (high < low) return null;

  const volumeRaw = row.volume;
  const volume =
    typeof volumeRaw === 'number' && Number.isFinite(volumeRaw)
      ? volumeRaw
      : undefined;

  return {
    instrument: String(row.instrument ?? '').trim().toUpperCase(),
    openTimeMs: Math.floor(openTimeMs / 60_000) * 60_000,
    open,
    high,
    low,
    close,
    ...(volume !== undefined ? { volume } : {}),
    finalized: row.finalized === undefined ? true : Boolean(Number(row.finalized) || row.finalized === true),
    receivedAt: Number(row.received_at_ms ?? Date.now()) || Date.now(),
    updatedAt: Number(row.updated_at_ms ?? Date.now()) || Date.now(),
    revision: Number(row.revision ?? 1) || 1,
  };
}

/**
 * Validates an inbound event before the app acts on it.
 *
 * Re-exported here so every consumer of a market event goes through the same
 * gate: a malformed or cross-schema event is dropped, never partially applied.
 */
export { validateMarketEvent };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}