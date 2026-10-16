/**
 * MARKET STATE STORE
 * ==================
 * One shared, timestamped, persisted view of each market: the live quote, the
 * candle window, and every indicator derived from it.
 *
 * WHY THIS EXISTS
 *
 * Before this, each GOAT independently:
 *   - opened its own subscription, so N GOATs on EUR/USD meant N polling
 *     loops hitting the provider every 5 seconds;
 *   - on every tick refetched 60 candles and recomputed RSI/EMA/SMA/ATR/MACD,
 *     swing levels and market structure — identical work, N times over.
 *
 * This store collapses that to ONE fetch and ONE computation per
 * (symbol, timeframe) per TTL, fanned out to every consumer. It is the exact
 * shape a Cloudflare Durable Object would hold: a durable, per-key cache of
 * derived market state, where the key is the market rather than the GOAT.
 *
 * PORTABILITY
 *
 * `MarketStatePersistence` is the seam. Today it writes a JSON file. On
 * Cloudflare it becomes Durable Object storage, R2, or KV with no change to
 * any consumer, because nothing above this file knows where state lives.
 *
 * FRESHNESS RULES
 *
 * - A snapshot older than `ttlMs` is refetched, never served as if current.
 * - Concurrent misses collapse onto ONE in-flight request (thundering-herd
 *   protection); this matters because a wake plus a tick plus a tracker can
 *   all miss at once.
 * - A provider outage does NOT evict a good snapshot. It degrades to the last
 *   known values with `degraded: true`, so a transient network blip cannot
 *   blank out every GOAT's view of the market.
 *
 * FAILURES BACK OFF — THIS IS NOT OPTIONAL
 *
 * A failure keeps the ORIGINAL `fetchedAt`, so a failed snapshot is by
 * definition already older than `ttlMs`. Combined with the freshness test
 * above (which reads `fetchedAt` and nothing else), that made every read after
 * a failure a permanent cache MISS: a real provider round trip, plus a fresh
 * log line, once per poll — forever.
 *
 * For a market the venue does not list that is an unbounded hot loop. A
 * GOAT persisted with `EUR/USD` produced exactly this: the same
 * `[market-state] EUR/USD 15m degraded: ...` line twenty times a minute,
 * indefinitely, and every attempt spent real weight against Hyperliquid's
 * 1200/min budget.
 *
 * `failureBackoffMs` fixes it at the level where the bug lives: consecutive
 * failures on a key extend the next attempt's delay exponentially (capped),
 * and while a key is backing off `getState` returns the last degraded snapshot
 * WITHOUT calling the provider and WITHOUT re-logging. A market that recovers
 * is picked up as soon as the backoff window expires.
 */

import { MarketQuote, Candle } from '../../types';
import { MarketDataProvider } from '../market-data/MarketDataProvider';
import {
  IndicatorSnapshot,
  computeIndicatorSnapshot,
} from '../tracker-sdk/TrackerEvaluator';

/**
 * Usability of a snapshot, in one field.
 *
 *   LIVE       — fetched from the provider and within TTL
 *   DEGRADED   — provider failed; these are the last known values, flagged
 *   UNAVAILABLE— no usable data at all (cold start during an outage)
 *
 * Callers that must not act on unconfirmed prices check this rather than
 * inferring health from booleans.
 */
export type MarketStateStatus =
  | 'LIVE'
  | 'DEGRADED'
  | 'UNAVAILABLE';

export interface MarketStateSnapshot {
  /** Canonical market id used in the key, e.g. `xyz:EUR`. */
  symbol: string;
  timeframe: string;
  /** Storage key: "<MARKET>:<timeframe>". */
  key: string;
  fetchedAt: number;
  lastUpdatedAt: number;
  status: MarketStateStatus;
  /** True when this snapshot is older than the TTL. */
  expired: boolean;
  /** True when the provider failed and these are the last known values. */
  degraded: boolean;
  /** Convenience: the last known price, or null when there is none. */
  latestPrice: number | null;
  quote: MarketQuote | null;
  candles: Candle[];
  indicators: IndicatorSnapshot | null;
  /** Milliseconds spent fetching + computing. Useful for spotting hot paths. */
  computeMs: number;
  /** Provider or computation error that caused a non-LIVE status. */
  error?: string;
}

/** True only when the data is fresh and provider-confirmed. */
export function isUsableMarketState(
  snapshot: Pick<MarketStateSnapshot, 'status'>,
): boolean {
  return snapshot.status === 'LIVE';
}

/** Where snapshots live between process restarts. */
export interface MarketStatePersistence {
  load(key: string): Promise<MarketStateSnapshot | null>;
  save(key: string, snapshot: MarketStateSnapshot): Promise<void>;
}

export interface MarketStateStoreOptions {
  /** How long a snapshot is considered fresh. */
  ttlMs?: number;
  /** Candle window fetched per symbol. */
  candleCount?: number;
  /** Timeframe used for indicator/tracker evaluation. */
  timeframe?: string;
  /** Poll cadence per symbol when subscribed. */
  pollIntervalMs?: number;
  persist?: MarketStatePersistence;
  now?: () => number;
  /** Structured log sink; defaults to console. */
  log?: (message: string, error?: unknown) => void;
  /**
   * First delay applied after a single failure, doubled per consecutive
   * failure up to `maxFailureBackoffMs`. Defaults to one full TTL.
   */
  failureBackoffMs?: number;
  /** Ceiling for the exponential failure backoff. */
  maxFailureBackoffMs?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_CANDLE_COUNT = 120;
const DEFAULT_TIMEFRAME = '15m';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** ~8 minutes. A dead market costs one attempt every 8 minutes, not 60/sec. */
const DEFAULT_MAX_FAILURE_BACKOFF_MS = 480_000;

/**
 * Per-key failure accounting that drives the backoff.
 *
 * Kept SEPARATE from the snapshot rather than as a field on it: a snapshot is
 * the market's view (and is persisted, fanned out and compared by callers),
 * while this is local retry bookkeeping that must never leak into a snapshot
 * or get written to disk.
 */
interface FailureRecord {
  consecutive: number;
  /** Epoch ms before which no provider call is attempted. */
  nextAttemptAt: number;
  /** The message last logged, so a repeat is suppressed rather than re-logged. */
  lastLoggedMessage: string;
  lastLoggedAt: number;
}

/** In-memory persistence: correct for a single process, gone on restart. */
export class MemoryMarketStatePersistence
  implements MarketStatePersistence
{
  private store = new Map<string, MarketStateSnapshot>();

  async load(key: string): Promise<MarketStateSnapshot | null> {
    return this.store.get(key) ?? null;
  }

  async save(
    key: string,
    snapshot: MarketStateSnapshot,
  ): Promise<void> {
    this.store.set(key, snapshot);
  }
}

export class MarketStateStore {
  private readonly snapshots = new Map<string, MarketStateSnapshot>();
  private readonly inflight = new Map<string, Promise<MarketStateSnapshot>>();
  private readonly hydrated = new Set<string>();
  private readonly subscribers = new Map<string, Set<(s: MarketStateSnapshot) => void>>();
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly observers = new Set<(s: MarketStateSnapshot) => void>();
  /**
   * Consecutive-failure bookkeeping, keyed the same way as snapshots. This is
   * what stops a dead market from producing a provider call and a log line on
   * every single read — see the FAILURES BACK OFF section in the header.
   */
  private readonly failures = new Map<string, FailureRecord>();

  private readonly ttlMs: number;
  private readonly candleCount: number;
  private readonly timeframe: string;
  private readonly pollIntervalMs: number;
  private readonly failureBackoffMs: number;
  private readonly maxFailureBackoffMs: number;
  private readonly persist?: MarketStatePersistence;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  /** Counters for observability; proves the de-duplication is working. */
  readonly stats = {
    fetches: 0,
    cacheHits: 0,
    inflightCollapses: 0,
    computeMsTotal: 0,
    degraded: 0,
    /** Reads served from a failed snapshot without touching the provider. */
    backoffServes: 0,
  };

  constructor(
    private readonly provider: MarketDataProvider,
    options: MarketStateStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.candleCount =
      options.candleCount ?? DEFAULT_CANDLE_COUNT;
    this.timeframe =
      options.timeframe ?? DEFAULT_TIMEFRAME;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.failureBackoffMs =
      options.failureBackoffMs ?? this.ttlMs;
    this.maxFailureBackoffMs =
      options.maxFailureBackoffMs ?? DEFAULT_MAX_FAILURE_BACKOFF_MS;
    this.persist = options.persist;
    this.now = options.now ?? (() => Date.now());
    this.log =
      options.log ??
      ((message, error) => {
        if (error) console.warn(message, error);
        else console.warn(message);
      });
  }

  /**
   * Storage key: "<MARKET>:<timeframe>".
   *
   * Market-keyed, never GOAT-keyed — several GOATs watching the same
   * instrument share one entry, one fetch and one indicator computation.
   */
  private key(symbol: string, timeframe: string): string {
    return `${symbol.trim().toUpperCase()}:${timeframe}`;
  }

  /**
   * Current state for a market, fetching only when the cached snapshot has
   * expired. Never throws: a provider failure returns a degraded snapshot.
   *
   * A key inside its failure backoff window is served from the last degraded
   * snapshot WITHOUT calling the provider. Without this the failure path —
   * which deliberately preserves the stale `fetchedAt` — is a permanent cache
   * miss, and a market the venue does not list becomes an unbounded loop of
   * provider calls and log lines.
   */
  async getState(
    symbol: string,
    timeframe?: string,
  ): Promise<MarketStateSnapshot> {
    const tf = timeframe ?? this.timeframe;
    const key = this.key(symbol, tf);
    const now = this.now();

    const cached = this.snapshots.get(key);
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      this.stats.cacheHits += 1;
      return { ...cached, expired: false };
    }

    const failure = this.failures.get(key);
    if (failure && now < failure.nextAttemptAt) {
      // Still inside the cooldown. Serve what we have and do not re-log.
      const degraded =
        cached ??
        this.unavailableSnapshot(symbol, tf, key, failure.lastLoggedMessage);
      this.snapshots.set(key, degraded);
      this.stats.backoffServes += 1;
      return degraded;
    }

    // Collapse concurrent misses onto one request.
    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.inflightCollapses += 1;
      return existing;
    }

    const request = this.refresh(symbol, tf, key)
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, request);
    return request;
  }

  /**
   * Subscribe to a symbol's state. ONE poll loop per symbol is shared by all
   * subscribers, and it starts on the first subscriber and stops when the
   * last one leaves — so GOAT lifecycle changes never leak timers.
   */
  subscribe(
    symbol: string,
    callback: (snapshot: MarketStateSnapshot) => void,
    timeframe?: string,
    pollIntervalMs?: number,
  ): () => void {
    const tf = timeframe ?? this.timeframe;
    const intervalMs = pollIntervalMs ?? this.pollIntervalMs;
    const key = this.key(symbol, tf);

    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(callback);

    if (!this.pollers.has(key)) {
      // Prime immediately so a new GOAT does not wait a full interval.
      void this.getState(symbol, tf)
        .then((snapshot) => {
          if (!snapshot.expired) callback(snapshot);
        })
        .catch(() => {
          /* getState never throws; ignore defensively. */
        });

      const timer = setInterval(() => {
        void this.getState(symbol, tf)
          .then((snapshot) => this.fanOut(key, snapshot))
          .catch(() => {
            /* getState never throws. */
          });
      }, intervalMs);

      timer.unref?.();
      this.pollers.set(key, timer);
    }

    return () => {
      const current = this.subscribers.get(key);
      current?.delete(callback);

      if (current && current.size === 0) {
        this.subscribers.delete(key);

        const timer = this.pollers.get(key);
        if (timer) {
          clearInterval(timer);
          this.pollers.delete(key);
        }
      }
    };
  }

  /** Number of live poll loops; used by tests to prove no timer leaks. */
  activePollers(): number {
    return this.pollers.size;
  }

  /**
   * Observes EVERY fresh snapshot, independent of subscribers.
   *
   * Used by the daily rollup so a recap is built from the same confirmed data
   * the trackers use. Kept separate from `subscribe` because the rollup must
   * keep observing even when no GOAT is currently watching a market.
   */
  onSnapshot(listener: (snapshot: MarketStateSnapshot) => void): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  /** Number of symbols with at least one subscriber. */
  activeSubscribers(): number {
    let total = 0;
    this.subscribers.forEach((set) => {
      total += set.size;
    });
    return total;
  }

  /**
   * Warm a snapshot from persistence without hitting the network.
   *
   * A restored snapshot is marked expired, so the next read refreshes it —
   * the point is to avoid a cold-start thundering herd and to let the UI show
   * something immediately rather than a blank chart.
   */
  async hydrate(
    symbol: string,
    timeframe?: string,
  ): Promise<MarketStateSnapshot | null> {
    const tf = timeframe ?? this.timeframe;
    const key = this.key(symbol, tf);

    if (!this.persist || this.hydrated.has(key)) {
      return this.snapshots.get(key) ?? null;
    }
    this.hydrated.add(key);

    try {
      const restored = await this.persist.load(key);
      if (restored) {
        this.snapshots.set(key, { ...restored, expired: true });
      }
    } catch (err) {
      this.log('[market-state] hydrate failed', err);
    }

    return this.snapshots.get(key) ?? null;
  }

  /**
   * Drops cached snapshots so the next read refetches immediately.
   *
   * The failure backoff is cleared alongside them. `invalidate` exists to say
   * "trust me, ask again now" — leaving a live cooldown in place would make it
   * a silent no-op on exactly the dead markets a caller is most likely to be
   * trying to recover (a market newly listed by the venue, for instance).
   */
  invalidate(symbol?: string): void {
    if (!symbol) {
      this.snapshots.clear();
      this.failures.clear();
      return;
    }

    const prefix = `${symbol.trim().toUpperCase()}:`;
    for (const key of [...this.snapshots.keys()]) {
      if (key.startsWith(prefix)) {
        this.snapshots.delete(key);
      }
    }
    for (const key of [...this.failures.keys()]) {
      if (key.startsWith(prefix)) {
        this.failures.delete(key);
      }
    }
  }

  /** Stops all poll loops. Called on shutdown. */
  stop(): void {
    this.pollers.forEach((timer) => clearInterval(timer));
    this.pollers.clear();
    this.subscribers.clear();
    this.observers.clear();
  }

  private fanOut(key: string, snapshot: MarketStateSnapshot): void {
    const set = this.subscribers.get(key);
    if (!set) return;

    // Copy first: a callback may unsubscribe during iteration.
    for (const callback of [...set]) {
      try {
        callback(snapshot);
      } catch (err) {
        this.log('[market-state] subscriber threw', err);
      }
    }
  }

  private async refresh(
    symbol: string,
    timeframe: string,
    key: string,
  ): Promise<MarketStateSnapshot> {
    const startedAt = this.now();
    const previous = this.snapshots.get(key);

    try {
      this.stats.fetches += 1;

      const [quote, candles] = await Promise.all([
        this.provider.getQuote(symbol),
        this.provider.getCandles(
          symbol,
          timeframe,
          this.candleCount,
        ),
      ]);

      // Never publish an empty/stale quote as LIVE or compute indicators against zero.
      // Provider contracts may preserve zero-valued numeric fields for compatibility,
      // so freshness and price validity must be checked at this boundary.
      if (quote.stale === true) {
        throw new Error(`Provider marked ${symbol} quote as stale`);
      }
      if (!Number.isFinite(quote.mid) || quote.mid <= 0) {
        throw new Error(`Provider returned an invalid mid price for ${symbol}`);
      }
      if (quote.quoteAgeSeconds != null &&
          (!Number.isFinite(quote.quoteAgeSeconds) || quote.quoteAgeSeconds < 0 || quote.quoteAgeSeconds > this.ttlMs / 1000)) {
        throw new Error(`Provider quote for ${symbol} is older than the market-state TTL`);
      }

      const indicators =
        candles.length > 0
          ? computeIndicatorSnapshot(quote, candles)
          : null;

      const computeMs = this.now() - startedAt;
      this.stats.computeMsTotal += computeMs;

      const now = this.now();
      const snapshot: MarketStateSnapshot = {
        symbol,
        timeframe,
        key,
        fetchedAt: now,
        lastUpdatedAt: now,
        status: 'LIVE',
        expired: false,
        degraded: false,
        latestPrice: quote.mid,
        quote,
        candles,
        indicators,
        computeMs,
      };

      this.snapshots.set(key, snapshot);
      this.fanOut(key, snapshot);

      /**
       * A success clears the backoff completely. Without this, a market that
       * failed twice and then recovered would keep carrying a stale
       * `consecutive` count and re-enter a shorter-than-expected cooldown on
       * its next blip.
       */
      this.failures.delete(key);

      for (const listener of [...this.observers]) {
        try {
          listener(snapshot);
        } catch (err) {
          this.log('[market-state] observer threw', err);
        }
      }

      // Write-behind: never block the read path on persistence.
      if (this.persist) {
        void this.persist.save(key, snapshot).catch((err) => {
          this.log('[market-state] persist failed', err);
        });
      }

      return snapshot;
    } catch (err) {
      this.stats.degraded += 1;

      const message =
        err instanceof Error
          ? err.message
          : 'unknown error';

      /**
       * Keep the last good snapshot. Blanking every GOAT's market view
       * because one request failed is strictly worse than showing slightly
       * older real prices, and `degraded` marks them honestly.
       */
      const hasUsableFallback =
        previous?.quote !== null &&
        previous?.quote !== undefined;

      /**
       * Extend the cooldown for this key. Doubling per consecutive failure
       * (capped) means a market that is permanently absent costs one attempt
       * every few minutes instead of one per poll interval, while a market
       * recovering from a brief blip is retried on the very next tick.
       */
      const prior = this.failures.get(key);
      const consecutive = (prior?.consecutive ?? 0) + 1;
      const delay = Math.min(
        this.failureBackoffMs * 2 ** (consecutive - 1),
        this.maxFailureBackoffMs,
      );
      const now = this.now();
      this.failures.set(key, {
        consecutive,
        nextAttemptAt: now + delay,
        lastLoggedMessage: message,
        lastLoggedAt: now,
      });

      const snapshot: MarketStateSnapshot = {
        symbol,
        timeframe,
        key,
        /**
         * Keep the ORIGINAL fetch time. Rewriting it on failure would make a
         * stale snapshot look freshly confirmed to every downstream check.
         */
        fetchedAt: previous?.fetchedAt ?? 0,
        lastUpdatedAt: previous?.lastUpdatedAt ?? 0,
        status: hasUsableFallback ? 'DEGRADED' : 'UNAVAILABLE',
        expired: false,
        degraded: true,
        latestPrice: previous?.quote?.mid ?? null,
        quote: previous?.quote ?? null,
        candles: previous?.candles ?? [],
        indicators: previous?.indicators ?? null,
        computeMs: this.now() - startedAt,
        error: message,
      };

      this.snapshots.set(key, snapshot);

      /**
       * Log the first failure immediately, then at most once per backoff
       * window. Re-logging an identical message every poll is what turned one
       * bad symbol into a wall of identical console output.
       */
      const suppress =
        prior !== undefined &&
        prior.lastLoggedMessage === message &&
        now - prior.lastLoggedAt < this.maxFailureBackoffMs;

      if (!suppress) {
        this.log(
          `[market-state] ${symbol} ${timeframe} degraded: ${message}` +
            (consecutive > 1 ? ` (failure ${consecutive}, retrying in ${Math.round(delay / 1000)}s)` : ''),
        );
      }

      return snapshot;
    }
  }

  /**
   * An UNAVAILABLE snapshot for a key that has never once succeeded.
   *
   * Constructed rather than cached-updated so the backoff path can produce a
   * usable value for a key whose failure record exists but whose snapshot does
   * not (a restart, or a `stop()`/`clear()` between the two).
   */
  private unavailableSnapshot(
    symbol: string,
    timeframe: string,
    key: string,
    message: string,
  ): MarketStateSnapshot {
    return {
      symbol,
      timeframe,
      key,
      fetchedAt: 0,
      lastUpdatedAt: 0,
      status: 'UNAVAILABLE',
      expired: false,
      degraded: true,
      latestPrice: null,
      quote: null,
      candles: [],
      indicators: null,
      computeMs: 0,
      error: message,
    };
  }
}
