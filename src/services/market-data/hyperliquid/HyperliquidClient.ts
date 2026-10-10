/**
 * HYPERLIQUID INFO CLIENT
 * =======================
 * The only module that speaks HTTP to Hyperliquid.
 *
 * Everything provider-specific lives here: the endpoint, the wire format
 * (which is inconsistently typed — numbers arrive as STRINGS in most
 * responses), and the rate-limit accounting. The `MarketDataProvider` above
 * it deals only in normalised types.
 *
 * OFFICIAL DOCS (read before changing anything here)
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 *
 * RATE LIMITS (documented, per IP)
 *   1200 weight/minute, aggregated across all REST calls:
 *     - `l2Book`, `allMids` ............................. 2
 *     - every other documented `info` request .......... 20
 *     - `candleSnapshot` ................ 20 + 1 per 60 candles returned
 *   The budget below models that, because "we will get rate limited" is not a
 *   strategy — it is an outage that starts when the tracked universe grows.
 *
 * NULLABILITY IS REAL AND IS NOT DEFENSIVE PROGRAMMING
 *   `midPx`, `premium` and `impactPxs` are documented as nullable and are
 *   observed as `null` in live responses on the HIP-3 dex. Every numeric field
 *   is parsed through `asNumber`, which returns `null` for absent, `null`,
 *   empty and non-finite alike. A caller asking for a bid and receiving `null`
 *   is being told the book is empty; it must not receive `0`.
 */

import {
  HYPERLIQUID_DEXES,
  HYPERLIQUID_INTERVALS,
  HyperliquidDex,
  HyperliquidInterval,
  INTERVAL_MAP,
  NormaliseMarketInput,
  normaliseMarket,
  NormalisedMarket,
} from './MarketCatalog';

const MAINNET_INFO_URL = 'https://api.hyperliquid.xyz/info';
const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Documented REST weight budget, per IP per minute.
 *
 * Set below the documented 1200 so a client sharing an egress IP with
 * something else degrades on OUR side first — with backoff — rather than
 * getting a hard 429.
 */
const WEIGHT_BUDGET_PER_MINUTE = 1100;

/** Documented request weights. */
const WEIGHT = {
  /** `l2Book`, `allMids`. */
  light: 2,
  /** `meta`, `metaAndAssetCtxs`, `spotMeta`, `spotMetaAndAssetCtxs`, `perpDexs`. */
  info: 20,
  /** Base weight of a `candleSnapshot`; +1 per 60 items returned. */
  candleBase: 20,
  candlePer60: 1,
} as const;

/** Requests older than this are dropped from the in-flight window. */
const INFLIGHT_TTL_MS = 20_000;

/**
 * Documented ceiling on retained candle history.
 *
 * "Only the most recent 5000 candles are available" — asking for more does
 * not return more, it just makes the time range enormous.
 */
const MAX_CANDLES_PER_REQUEST = 5000;

export interface HyperliquidCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HyperliquidAssetContext {
  /** Mark price. Falls back to oracle then mid when mark is absent. */
  markPx: number | null;
  /** Mid price; `null` when the book is empty. */
  midPx: number | null;
  oraclePx: number | null;
  /** Reference price from 24h ago. Change must be DERIVED from this. */
  prevDayPx: number | null;
  /** 24h notional volume in USD. */
  dayNtlVlm: number | null;
  openInterest: number | null;
  funding: number | null;
  /** [bid, ask] from the impact-price model, or null. */
  impactPxs: [number, number] | null;
}

export interface HyperliquidMarketSnapshot {
  market: NormalisedMarket;
  context: HyperliquidAssetContext;
}

/** Provider error, classified. Never carries a response body verbatim. */
export class HyperliquidError extends Error {
  readonly status?: number;
  readonly code: HyperliquidErrorCode;

  constructor(code: HyperliquidErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'HyperliquidError';
    this.code = code;
    this.status = status;
  }
}

export type HyperliquidErrorCode =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN_MARKET';

export interface HyperliquidClientOptions {
  /** Overrides the endpoint. Used by tests and by a future testnet switch. */
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Injected for tests. Defaults to global `fetch`.
   *
   * Typed loosely on purpose: Node's `fetch` and the DOM's `fetch` have
   * different, mutually-incompatible type identities across the environments
   * this file compiles under, and the only capability actually used is
   * "call a URL and return a Response".
   */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Called when a response cannot be parsed. Never receives the body. */
  onWarn?: (message: string) => void;
}

/**
 * Parses a provider numeric field.
 *
 * Returns `null` — never `0` — for anything that is not a finite number.
 * Confusing "absent" with "zero" is how a dead market shows up as a flat
 * price of 0.00 on the Markets screen.
 */
function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A tiny weighted-token-bucket limiter.
 *
 * Not decoration: a `candleSnapshot` returning 500 candles costs ~28 weight,
 * so the default 16-market universe polled every minute costs ~450/min, and a
 * user-triggered candle fetch can overlap it. Without accounting, the two add
 * up silently and the next response is a 429 for every user.
 */
class WeightLimiter {
  private spent: Array<{ at: number; weight: number }> = [];

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(at: number): void {
    const cutoff = at - 60_000;
    while (this.spent.length > 0 && this.spent[0].at < cutoff) this.spent.shift();
  }

  /** Weight consumed in the trailing minute. */
  used(at = this.now()): number {
    this.prune(at);
    return this.spent.reduce((total, entry) => total + entry.weight, 0);
  }

  remaining(at = this.now()): number {
    return Math.max(0, this.limitPerMinute - this.used(at));
  }

  /**
   * Reserves weight, or throws when the budget is spent.
   *
   * Callers pass the cost they can compute in advance; the actual charge is
   * settled afterwards by `settle`, which is how a candle call reserves 20
   * up front and adds its per-60-candles cost once the size is known.
   */
  reserve(weight: number, at = this.now()): void {
    this.prune(at);
    if (this.used(at) + weight > this.limitPerMinute) {
      throw new HyperliquidError(
        'RATE_LIMITED',
        'Hyperliquid request budget is exhausted for this minute. Try again shortly.',
        429,
      );
    }
    this.spent.push({ at, weight });
  }

  /** Adjusts the most recent reservation, e.g. to charge per-candle weight. */
  settle(additionalWeight: number, at = this.now()): void {
    if (additionalWeight <= 0) return;
    const last = this.spent[this.spent.length - 1];
    if (last) last.weight += additionalWeight;
  }

  reset(): void {
    this.spent = [];
  }
}

/** Collapses identical concurrent reads so N callers make one request. */
class InflightRegistry {
  private entries = new Map<string, { at: number; promise: Promise<unknown> }>();

  run<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && now - existing.at < INFLIGHT_TTL_MS) {
      return existing.promise as Promise<T>;
    }
    const promise = factory().finally(() => {
      // Only clear if still ours: a newer caller may already have replaced it.
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
    });
    this.entries.set(key, { at: now, promise });
    return promise;
  }
}

export class HyperliquidClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly onWarn: (message: string) => void;
  private readonly limiter: WeightLimiter;
  private readonly inflight = new InflightRegistry();

  /**
   * Cached universe + context.
   *
   * Holding CONTEXT here (not just the market list) is what makes the refresh
   * free: `metaAndAssetCtxs` returns both halves, so a cache hit needs no
   * request at all, and prices stay fresh for as long as the TTL allows.
   */
  private metadataCache: { at: number; markets: HyperliquidMarketSnapshot[] } | null = null;

  private static readonly METADATA_TTL_MS = 10 * 60_000;

  constructor(options: HyperliquidClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.HYPERLIQUID_INFO_URL?.trim() ?? MAINNET_INFO_URL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.onWarn =
      options.onWarn ??
      ((message) => console.warn(`[hyperliquid] ${message}`));
    this.limiter = new WeightLimiter(WEIGHT_BUDGET_PER_MINUTE);
  }

  /** Trailing-minute weight usage. Exposed for /api/settings/status. */
  rateLimitState(): { used: number; limit: number; remaining: number } {
    const used = this.limiter.used();
    return { used, limit: WEIGHT_BUDGET_PER_MINUTE, remaining: Math.max(0, WEIGHT_BUDGET_PER_MINUTE - used) };
  }

  /**
   * One `POST /info`.
   *
   * The error path is where provider responses are most dangerous: they can
   * echo the request. Only the status and the provider's own short error
   * string are propagated, never the raw body.
   */
  private async info<T>(body: Record<string, unknown>, weight: number): Promise<T> {
    this.limiter.reserve(weight);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new HyperliquidError(
          'RATE_LIMITED',
          'Hyperliquid rate limit reached. Back off for a few seconds.',
          429,
        );
      }

      if (!response.ok) {
        throw new HyperliquidError(
          'PROVIDER_ERROR',
          `Hyperliquid responded ${response.status} for "${String(body.type)}".`,
          response.status,
        );
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new HyperliquidError(
          'INVALID_RESPONSE',
          `Hyperliquid returned a body that is not valid JSON for "${String(body.type)}".`,
        );
      }
    } catch (error) {
      if (error instanceof HyperliquidError) throw error;
      if (isAbortError(error)) {
        throw new HyperliquidError(
          'TIMEOUT',
          `Hyperliquid did not respond within ${this.timeoutMs}ms.`,
        );
      }
      throw new HyperliquidError('NETWORK', 'Hyperliquid could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lists every instrument on the configured dexes, with live context.
   *
   * ONE `metaAndAssetCtxs` per dex yields BOTH halves of the response, so
   * listing and pricing cost the same single weight-20 request. Fetching the
   * universe once and the context separately would double the cost for the
   * entire market list on every refresh.
   *
   * Cached for ten minutes (the universe changes weekly, prices do not) and
   * collapsed while concurrent, so a burst of callers makes one request.
   */
  async listMarkets(
    dexes: readonly HyperliquidDex[] = HYPERLIQUID_DEXES,
  ): Promise<HyperliquidMarketSnapshot[]> {
    return this.inflight.run(`meta:${dexes.join(',')}`, async () => {
      const cached = this.metadataCache;
      if (cached && Date.now() - cached.at < HyperliquidClient.METADATA_TTL_MS) {
        return cached.markets;
      }

      const collected: HyperliquidMarketSnapshot[] = [];
      for (const dex of dexes) {
        let response: unknown;
        try {
          response = await this.info<unknown>({ type: 'metaAndAssetCtxs', dex }, WEIGHT.info);
        } catch (error) {
          // A HIP-3 dex that has been renamed or removed comes back as an
          // error, not an empty list. That is not fatal — the remaining dexes
          // still serve — but it must be visible rather than silent.
          this.onWarn(
            `dex "${dex || '(default)'}" metadata unavailable: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
          continue;
        }

        const markets = parseMetaAndAssetCtxs(response, dex);
        if (markets === null) {
          this.onWarn(`dex "${dex || '(default)'}" returned an unreadable meta payload; skipping.`);
          continue;
        }

        // Contexts are positional against the universe, so they are captured
        // here while both halves of the response are in hand.
        const contexts = parseAssetContexts(
          response,
          markets.map((market) => market.symbol),
        );
        for (const market of markets) {
          collected.push({
            market,
            context: contexts.get(market.symbol.toUpperCase()) ?? nullContext(),
          });
        }
      }

      this.metadataCache = { at: Date.now(), markets: collected };
      return collected;
    });
  }

  /** Cached universe without context, for search and routing. */
  async listMarketsCached(dexes: readonly HyperliquidDex[] = HYPERLIQUID_DEXES): Promise<NormalisedMarket[]> {
    const snapshots = await this.listMarkets(dexes);
    return snapshots.map((snapshot) => snapshot.market);
  }

  /** Forces the next `listMarkets` to re-read the provider. */
  invalidateMetadata(): void {
    this.metadataCache = null;
  }

  /**
   * Mid prices for the whole default dex in one weight-2 call.
   *
   * `allMids` returns a flat `coin -> price` map. Documented caveat: when a
   * book is empty the provider falls back to the last trade price, so a mid
   * from this endpoint is a reference, not a guaranteed two-sided quote.
   */
  async allMids(dex: HyperliquidDex = ''): Promise<Record<string, number>> {
    return this.inflight.run(`allMids:${dex}`, async () => {
      const response = await this.info<Record<string, unknown>>(
        { type: 'allMids', ...(dex ? { dex } : {}) },
        WEIGHT.light,
      );
      const out: Record<string, number> = {};
      for (const [coin, price] of Object.entries(response ?? {})) {
        const value = asNumber(price);
        if (value !== null && value > 0) out[coin] = value;
      }
      return out;
    });
  }

  /**
   * Best bid and ask from the L2 book.
   *
   * Returns `null` — not zeros — when the book is empty or the coin is
   * unknown. Callers must render "no quote" rather than a synthetic spread.
   */
  async bestBidAsk(coin: string): Promise<{ bid: number; ask: number } | null> {
    return this.inflight.run(`l2:${coin}`, async () => {
      const response = await this.info<unknown>({ type: 'l2Book', coin }, WEIGHT.light);
      const levels = asRecord(response)?.levels;
      if (!Array.isArray(levels) || levels.length < 2) return null;

      const bid = asNumber(asRecord((levels[0] as unknown[])?.[0])?.px);
      const ask = asNumber(asRecord((levels[1] as unknown[])?.[0])?.px);
      if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) return null;
      return { bid, ask };
    });
  }

  /**
   * Historical candles.
   *
   * Request shape is documented; the RESPONSE is an array of OBJECTS with
   * string-typed prices (not the array-of-arrays form used by several other
   * exchanges): `{ t, T, s, i, o, h, l, c, v, n }`.
   *
   * `count` is CLAMPED HERE, not left to the caller. This is the module that
   * knows the documented ceiling (5000 candles of retained history), and a
   * client-side clamp would mean the request span — which is derived from the
   * count — is computed from an unbounded number the first time anything
   * upstream forgets to bound it.
   */
  async candles(
    coin: string,
    timeframe: string,
    count: number,
  ): Promise<HyperliquidCandle[]> {
    const interval = INTERVAL_MAP[timeframe];
    if (!interval) {
      throw new HyperliquidError(
        'INVALID_RESPONSE',
        `"${timeframe}" is not a Hyperliquid candle interval. Supported: ${HYPERLIQUID_INTERVALS.join(', ')}.`,
      );
    }

    const requested = Number.isFinite(count) ? Math.floor(count) : 1;
    const limit = Math.min(Math.max(requested, 1), MAX_CANDLES_PER_REQUEST);

    const endTime = Date.now();
    // Ask for enough wall-clock time to cover `limit` bars, with 2x headroom
    // for gaps (a market that was closed, an interval we rounded up) so a
    // thin market returns a few bars rather than none.
    const spanMs = intervalToMs(interval) * limit * 2;
    const startTime = endTime - spanMs;

    const response = await this.info<unknown>(
      { type: 'candleSnapshot', req: { coin, interval, startTime, endTime } },
      WEIGHT.candleBase,
    );

    if (!Array.isArray(response)) {
      throw new HyperliquidError(
        'INVALID_RESPONSE',
        `candleSnapshot for "${coin}" did not return an array.`,
      );
    }

    // Documented cost is 20 plus 1 per 60 items RETURNED, so charge the real
    // amount after the fact rather than reserving the worst case.
    this.limiter.settle(Math.ceil(response.length / 60) * WEIGHT.candlePer60);

    const candles: HyperliquidCandle[] = [];
    for (const row of response) {
      const record = asRecord(row);
      if (!record) continue;
      const time = asNumber(record.t);
      const open = asNumber(record.o);
      const high = asNumber(record.h);
      const low = asNumber(record.l);
      const close = asNumber(record.c);
      const volume = asNumber(record.v);

      if (time === null || open === null || high === null || low === null || close === null) continue;
      // A bar with no price is noise; a bar with a zero volume is real (a
      // market that simply did not trade in that minute).
      if (open <= 0 || close <= 0 || high <= 0 || low <= 0) continue;
      if (high < low) continue;

      candles.push({
        time,
        open,
        high,
        low,
        close,
        volume: volume !== null && volume >= 0 ? volume : 0,
      });
    }

    // The provider returns newest-first. Every internal consumer expects
    // ascending, including the Durable Object's upsert path.
    candles.sort((a, b) => a.time - b.time);

    // Keep the most recent `limit` bars.
    return candles.length > limit ? candles.slice(candles.length - limit) : candles;
  }

  /** Confirms the venue is reachable. Used by the Markets connection badge. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.info<Record<string, unknown>>({ type: 'meta' }, WEIGHT.info);
      const universe = asRecord(response)?.universe;
      const count = Array.isArray(universe) ? universe.length : 0;
      return { ok: true, detail: `Hyperliquid reachable — ${count} instruments on the default dex.` };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'Hyperliquid is unreachable.',
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function nullContext(): HyperliquidAssetContext {
  return {
    markPx: null,
    midPx: null,
    oraclePx: null,
    prevDayPx: null,
    dayNtlVlm: null,
    openInterest: null,
    funding: null,
    impactPxs: null,
  };
}

/**
 * Parses `metaAndAssetCtxs`, which is a 2-element array
 * `[meta, assetCtxs]` with positionally index-matched entries.
 *
 * Returns only the MARKET half; contexts are attached in a second, separately
 * cacheable pass so a cached universe does not pin a stale price.
 */
export function parseMetaAndAssetCtxs(
  response: unknown,
  dex: string,
): NormalisedMarket[] | null {
  if (!Array.isArray(response) || response.length === 0) return null;
  const meta = asRecord(response[0]);
  const universe = meta?.universe;
  if (!Array.isArray(universe)) return null;

  const markets: NormalisedMarket[] = [];
  for (const entry of universe) {
    const record = asRecord(entry);
    if (!record) continue;
    const input: NormaliseMarketInput = {
      name: typeof record.name === 'string' ? record.name : '',
      dex,
      szDecimals: asNumber(record.szDecimals) ?? undefined,
      maxLeverage: asNumber(record.maxLeverage) ?? undefined,
      isDelisted: record.isDelisted === true,
      marginMode: typeof record.marginMode === 'string' ? record.marginMode : undefined,
      onlyIsolated: record.onlyIsolated === true,
    };
    const market = normaliseMarket(input);
    if (market) markets.push(market);
  }
  return markets;
}

/**
 * Extracts the context half, keyed by upper-cased symbol.
 *
 * `assetCtxs` IS POSITIONALLY INDEX-MATCHED to `meta.universe`. The documented
 * `metaAndAssetCtxs` example shows entries with NO `coin` field at all:
 *
 *   [ { "universe": [ {"name":"BTC", …} ] },
 *     [ {"funding":"…","markPx":"…"} ] ]
 *
 * (The spot response DOES carry `coin`, but the perp one does not.) Keying off
 * `coin` alone therefore yields an empty map for every perp, and every quote
 * silently loses its price. The universe names are supplied so positional
 * matching works; an explicit `coin` field, when present, takes precedence.
 */
export function parseAssetContexts(
  response: unknown,
  universeNames: readonly string[] = [],
): Map<string, HyperliquidAssetContext> {
  const out = new Map<string, HyperliquidAssetContext>();
  if (!Array.isArray(response) || response.length < 2) return out;
  const contexts = response[1];
  if (!Array.isArray(contexts)) return out;

  for (let index = 0; index < contexts.length; index += 1) {
    const record = asRecord(contexts[index]);
    if (!record) continue;

    // Prefer the explicit field; fall back to positional matching, which is
    // the documented contract for perps.
    const explicit = typeof record.coin === 'string' ? record.coin : null;
    const positional = universeNames[index];
    const coin = explicit ?? positional;
    if (!coin) continue;

    const impact = Array.isArray(record.impactPxs) ? record.impactPxs : null;
    const bid = impact ? asNumber(impact[0]) : null;
    const ask = impact ? asNumber(impact[1]) : null;

    out.set(coin.toUpperCase(), {
      markPx: asNumber(record.markPx),
      midPx: asNumber(record.midPx),
      oraclePx: asNumber(record.oraclePx),
      prevDayPx: asNumber(record.prevDayPx),
      dayNtlVlm: asNumber(record.dayNtlVlm),
      openInterest: asNumber(record.openInterest),
      funding: asNumber(record.funding),
      impactPxs: bid !== null && ask !== null ? [bid, ask] : null,
    });
  }

  return out;
}

/** Interval duration in milliseconds. `1M` is 30d, the calendar convention. */
export function intervalToMs(interval: HyperliquidInterval): number {
  switch (interval) {
    case '1m': return 60_000;
    case '3m': return 3 * 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '30m': return 30 * 60_000;
    case '1h': return 60 * 60_000;
    case '2h': return 2 * 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '8h': return 8 * 60 * 60_000;
    case '12h': return 12 * 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    case '3d': return 3 * 24 * 60 * 60_000;
    case '1w': return 7 * 24 * 60 * 60_000;
    case '1M': return 30 * 24 * 60 * 60_000;
    default: return 60_000;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/** Shared client instance. */
export const hyperliquidClient = new HyperliquidClient();