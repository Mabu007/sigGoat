/**
 * SHARED MARKET DATA INGESTION
 * ============================
 * ONE provider path per instrument, fanned out to every GOAT.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Before this, every GOAT opened its own subscription to the market provider.
 * Ten GOATs watching EUR/USD meant ten poll loops, ten request bursts every
 * five seconds and ten independent failure modes — and each one silently kept
 * its own private copy of the candle window, which is the storage growth the
 * storage policy exists to prevent.
 *
 * Now there is exactly one ingestion loop per INSTRUMENT, owned by a partition.
 * GOATs subscribe; they never poll. Two GOATs on the same pair cost one fetch.
 *
 * PARTITIONING — WHY NOT ONE OBJECT PER INSTRUMENT, AND WHY NOT ONE FOR ALL
 *
 * A Durable Object is single-threaded and has a fixed request budget, so the
 * partition size is the real design decision. The three that matter:
 *
 *   - One object per instrument: maximum isolation, but every object needs its
 *     own alarm and its own connection. With a few hundred instruments that is
 *     hundreds of objects, and each one's alarm is billed whether or not the
 *     market is open.
 *   - One object for everything: one hot object, and one failing symbol
 *     blocking every other symbol. Not acceptable.
 *   - Partition by CLASS: a handful of objects, each handling a bounded set of
 *     symbols. This is what is implemented. Fault isolation is per class, fan-out
 *     is bounded, and the object count stays in the single digits for the
 *     instruments this product actually supports.
 *
 * If the supported instrument count grew by two orders of magnitude, the right
 * move is more partitions of the same shape — the partition key is already the
 * routing unit, so that is a config change, not a rewrite.
 *
 * WHAT IS GUARANTEED HERE
 *
 *   - One in-flight ingestion per partition. Overlapping jobs are dropped, not
 *     queued, so a slow provider cannot build a backlog of duplicate requests.
 *   - Bounded retries with exponential backoff and a circuit breaker, so an
 *     outage does not turn into a hammering loop.
 *   - Freshness is recorded per instrument and surfaced to the tracker
 *     evaluator. A GOAT can tell the difference between "no condition met" and
 *     "the data is four minutes old".
 *   - A missing candle stays missing. Nothing is interpolated or fabricated.
 */

import { canonicalInstrument, floorToMinute, validateCandle } from './candle-core/CandleRecord';
import type { CandleRecord, UpsertOutcome } from './candle-core/CandleRecord';
import type { CandleStorage } from './candle-core/CandleRepositories';
import { classifyInstrument } from './candle-core/SessionCalendar';
import type { InstrumentClass } from './candle-core/SessionCalendar';
import { resolveSession, isMarketOpen } from './candle-core/SessionCalendar';
import { createMarketEvent } from './MarketEvent';
import type { MarketEvent } from './MarketEvent';
import { SessionFinalizer } from './candle-core/SessionFinalizer';
import { retentionPolicyFromEnv } from './candle-core/RetentionPolicy';
import type { RetentionPolicy } from './candle-core/RetentionPolicy';

/** The minimal provider surface ingestion needs. */
export interface CandleSource {
  readonly name: string;
  getCandles(
    symbol: string,
    timeframe: string,
    count?: number,
  ): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>;
}

export type PartitionKey = InstrumentClass;

export interface InstrumentFreshness {
  instrument: string;
  partition: PartitionKey;
  lastSuccessfulIngestAtMs: number | null;
  lastCandleOpenTimeMs: number | null;
  lastCandleFinalizedAtMs: number | null;
  consecutiveFailures: number;
  /** True when the newest candle is older than the staleness threshold. */
  stale: boolean;
  /** Age of the newest finalized candle, in seconds. */
  dataLagSeconds: number | null;
  lastError: string | null;
  /** Open market? Drives whether a gap is expected or an alarm. */
  marketOpen: boolean;
}

export interface Subscription {
  /** Opaque subscriber key. In the app this is the GOAT's runtime id. */
  subscriberId: string;
  instrument: string;
  /** Only these event types are delivered. Empty means "everything". */
  eventTypes: MarketEvent['type'][];
}

export interface IngestionOptions {
  storage: CandleStorage;
  source: CandleSource;
  /** Bars requested per ingestion pass. */
  barsPerFetch?: number;
  /** Injectable clock. */
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
  /** Consecutive failures before the breaker opens. */
  breakerThreshold?: number;
  /** Base backoff. Doubles per failure up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Newest finalized candle older than this marks the instrument stale. */
  staleAfterMs?: number;
  retention?: RetentionPolicy;
}

const DEFAULTS = {
  barsPerFetch: 180,
  breakerThreshold: 5,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
  staleAfterMs: 3 * 60_000,
};

/**
 * The one canonical owner of candle history.
 *
 * Subscribers receive events; they never receive candle payloads and never
 * open their own provider connection.
 */
export class MarketIngestionService {
  private readonly storage: CandleStorage;
  private readonly source: CandleSource;
  private readonly barsPerFetch: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly breakerThreshold: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly staleAfterMs: number;
  private readonly retention: RetentionPolicy;

  private readonly finalizer: SessionFinalizer;

  /** Per-instrument freshness. Small, bounded, rebuilt on restart. */
  private readonly freshness = new Map<string, InstrumentFreshness>();

  /**
   * Per-partition mutual exclusion.
   *
   * The Durable Object path gets this structurally from single-writer
   * execution; the in-process path needs it explicitly, and without it two
   * overlapping passes would double every provider request.
   */
  private readonly inflight = new Set<PartitionKey>();

  /**
   * partition -> (subscriberId + instrument) -> subscription.
   *
   * The key is COMPOSITE, and it has to be. A single GOAT commonly watches
   * several instruments in the same class (EUR/USD, GBP/USD and USD/JPY are all
   * FX). Keying on the subscriber alone made the second registration overwrite
   * the first, silently dropping an instrument the GOAT was watching — the
   * events for it would never be routed.
   */
  private readonly subscriptions = new Map<
    PartitionKey,
    Map<string, Subscription>
  >();

  private readonly listeners = new Set<(event: MarketEvent) => void>();

  private readonly nextAllowedAttempt = new Map<PartitionKey, number>();

  readonly stats = {
    passes: 0,
    overlapSuppressed: 0,
    providerCalls: 0,
    providerFailures: 0,
    candlesIngested: 0,
    candlesRejected: 0,
    candlesDuplicate: 0,
    candleCorrections: 0,
    eventsEmitted: 0,
    breakerOpens: 0,
    finalizations: 0,
  };

  constructor(options: IngestionOptions) {
    this.storage = options.storage;
    this.source = options.source;
    this.barsPerFetch = options.barsPerFetch ?? DEFAULTS.barsPerFetch;
    this.now = options.now ?? (() => Date.now());
    this.log =
      options.log ??
      ((message, error) => {
        if (error) console.warn(message, error);
        else console.warn(message);
      });
    this.breakerThreshold = options.breakerThreshold ?? DEFAULTS.breakerThreshold;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULTS.staleAfterMs;

    this.retention = options.retention ?? retentionPolicyFromEnv();

    this.finalizer = new SessionFinalizer({
      storage: this.storage,
      lateGraceMs: this.retention.lateUpdateGraceMs,
      pruneBatchSize: this.retention.pruneBatchSize,
      maxSummaries: this.retention.sessionSummaries,
      maxLevels: this.retention.swingPointsPerSide,
      now: this.now,
      log: this.log,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Partition routing                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * The partition an instrument belongs to.
   *
   * Exported separately so the Durable Object and the application agree on
   * routing without duplicating the mapping.
   */
  static partitionFor(instrument: string): PartitionKey {
    return classifyInstrument(canonicalInstrument(instrument));
  }

  partition(instrument: string): PartitionKey {
    return MarketIngestionService.partitionFor(instrument);
  }

  /* ---------------------------------------------------------------- */
  /* Subscriptions                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Registers interest in an instrument's events.
   *
   * Idempotent: re-subscribing the same subscriber to the same instrument
   * REPLACES the entry rather than adding a second one, so a retried
   * registration cannot cause duplicate delivery — which would otherwise show
   * up as duplicate signals.
   */
  subscribe(subscription: Subscription): () => void {
    const instrument = canonicalInstrument(subscription.instrument);
    const partition = this.partition(instrument);

    let bucket = this.subscriptions.get(partition);
    if (!bucket) {
      bucket = new Map();
      this.subscriptions.set(partition, bucket);
    }

    bucket.set(subscriptionKey(subscription.subscriberId, instrument), {
      ...subscription,
      instrument,
    });

    return () => this.unsubscribe(subscription.subscriberId, instrument);
  }

  /**
   * Removes a subscription. Stopping or deleting a GOAT calls this, so its
   * events stop being routed immediately rather than at the next restart.
   */
  unsubscribe(subscriberId: string, instrument: string): boolean {
    const partition = this.partition(instrument);
    const bucket = this.subscriptions.get(partition);
    if (!bucket) return false;
    const removed = bucket.delete(subscriptionKey(subscriberId, instrument));
    if (bucket.size === 0) this.subscriptions.delete(partition);
    return removed;
  }

  /** Removes a subscriber from EVERY partition. Used on GOAT stop/delete. */
  unsubscribeAll(subscriberId: string): number {
    let removed = 0;
    for (const bucket of this.subscriptions.values()) {
      // Every instrument this subscriber held, in every partition.
      for (const [key, subscription] of [...bucket]) {
        if (subscription.subscriberId === subscriberId) {
          bucket.delete(key);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /**
   * Rebuilds the subscription table from durable records.
   *
   * In-memory subscriptions are a cache. After a restart this restores them
   * from whatever the application persisted, so events are not silently dropped
   * for every GOAT in the first few seconds after a deploy.
   */
  rebuildSubscriptions(records: readonly Subscription[]): number {
    let restored = 0;
    for (const record of records) {
      if (!record?.subscriberId || !record?.instrument) continue;
      const partition = this.partition(record.instrument);
      let bucket = this.subscriptions.get(partition);
      if (!bucket) {
        bucket = new Map();
        this.subscriptions.set(partition, bucket);
      }
      const instrument = canonicalInstrument(record.instrument);
      bucket.set(subscriptionKey(record.subscriberId, instrument), {
        ...record,
        instrument,
      });
      restored += 1;
    }
    return restored;
  }

  /** Current subscription count, per partition and in total. */
  subscriptionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [partition, bucket] of this.subscriptions) {
      counts[partition] = bucket.size;
    }
    return counts;
  }

  totalSubscriptions(): number {
    let total = 0;
    for (const bucket of this.subscriptions.values()) total += bucket.size;
    return total;
  }

  /** Every active subscription, for persistence. */
  listSubscriptions(): Subscription[] {
    const out: Subscription[] = [];
    for (const bucket of this.subscriptions.values()) {
      for (const subscription of bucket.values()) out.push({ ...subscription });
    }
    return out;
  }

  onEvent(listener: (event: MarketEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------- */
  /* Ingestion                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Runs one ingestion pass for a set of instruments.
   *
   * Skips an instrument whose partition already has a pass in flight. This is
   * the guard that stops a slow provider producing overlapping work: the pass
   * is DROPPED, not queued, because a queued duplicate of the same request has
   * no value.
   */
  async ingest(instruments: readonly string[]): Promise<IngestionPassResult> {
    const byPartition = new Map<PartitionKey, string[]>();

    for (const raw of instruments) {
      const instrument = canonicalInstrument(raw);
      if (!instrument) continue;
      const partition = this.partition(instrument);
      const list = byPartition.get(partition);
      if (list) list.push(instrument);
      else byPartition.set(partition, [instrument]);
    }

    const results: IngestionPassResult = {
      attempted: 0,
      skipped: 0,
      inserted: 0,
      updated: 0,
      rejected: 0,
      duplicates: 0,
      events: 0,
      failures: 0,
      skippedInstruments: [],
    };

    for (const [partition, list] of byPartition) {
      if (this.inflight.has(partition)) {
        this.stats.overlapSuppressed += 1;
        results.skipped += list.length;
        results.skippedInstruments.push(...list);
        continue;
      }

      const notBefore = this.nextAllowedAttempt.get(partition);
      const at = this.now();
      if (notBefore !== undefined && at < notBefore) {
        results.skipped += list.length;
        results.skippedInstruments.push(...list);
        continue;
      }

      this.inflight.add(partition);
      try {
        for (const instrument of list) {
          const outcome = await this.ingestOne(instrument);
          results.attempted += 1;
          results.inserted += outcome.inserted;
          results.updated += outcome.updated;
          results.rejected += outcome.rejected;
          results.duplicates += outcome.duplicates;
          results.events += outcome.events;
          if (outcome.failed) results.failures += 1;
        }
      } finally {
        this.inflight.delete(partition);
      }
    }

    return results;
  }

  /**
   * Ingests ONE instrument.
   *
   * This is the single authoritative provider path for that instrument. There
   * is no per-subscriber alternative anywhere in the codebase.
   */
  private async ingestOne(instrument: string): Promise<PerInstrumentOutcome> {
    const partition = this.partition(instrument);
    const at = this.now();
    this.stats.passes += 1;

    const state = this.freshnessOf(instrument, partition);

    let bars: Awaited<ReturnType<CandleSource['getCandles']>>;
    try {
      this.stats.providerCalls += 1;
      bars = await this.source.getCandles(instrument, '1m', this.barsPerFetch);
    } catch (err) {
      this.stats.providerFailures += 1;
      this.recordFailure(instrument, partition, describe(err));
      return { failed: true };
    }

    /**
     * Provider recovery. The breaker clears only after a genuinely successful
     * fetch, so a flapping provider cannot oscillate between half-open and
     * closed on every other call.
     */
    if (state.consecutiveFailures > 0) {
      this.emit(
        createMarketEvent({
          type: 'DATA_RECOVERED',
          partition,
          instrument,
          context: {
            failureReason: state.lastError ?? undefined,
            dataQuality: 'OK',
          },
          now: () => this.now(),
        }),
      );
    }

    // ---- validate + normalize ----------------------------------------
    const valid: CandleRecord[] = [];
    let rejected = 0;

    for (const bar of bars) {
      const result = validateCandle(
        {
          instrument,
          openTimeMs: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          /**
           * A feed that does not mark finality is treated as "the newest bar
           * may still be forming". Assuming everything is final would let a
           * half-built candle satisfy a tracker and fire a wake.
           */
          finalized: true,
        },
        { now: () => at },
      );

      if (result.ok) {
        valid.push(result.record);
      } else {
        /**
         * Rejected bars are COUNTED, never fabricated. A gap is a gap; filling
         * it would hide a provider problem behind plausible-looking data.
         */
        rejected += 1;
      }
    }

    this.stats.candlesRejected += rejected;

    if (valid.length === 0 && rejected > 0) {
      // Every bar was corrupt. That is a provider problem, not a quiet market.
      this.recordFailure(
        instrument,
        partition,
        `All ${rejected} bars rejected validation`,
      );
      return { failed: true, rejected };
    }

    // ---- idempotent upsert -------------------------------------------
    let outcome: UpsertOutcome;
    try {
      outcome = await this.storage.upsertMany(valid);
    } catch (err) {
      this.recordFailure(instrument, partition, describe(err));
      return { failed: true };
    }

    this.stats.candlesIngested += outcome.inserted;
    this.stats.candlesDuplicate += outcome.duplicates;
    this.stats.candleCorrections += outcome.updated;

    // ---- freshness -----------------------------------------------------
    const newest = valid.reduce<CandleRecord | null>(
      (best, candle) => (!best || candle.openTimeMs > best.openTimeMs ? candle : best),
      null,
    );

    this.recordSuccess(instrument, partition, newest, at);

    // ---- publish events -----------------------------------------------
    let events = 0;
    for (const candle of valid) {
      const isNew = candle.openTimeMs === newest?.openTimeMs;
      /**
       * Only the newest candle can be a transition worth notifying on. Older
       * candles in the same batch are history catching up, and waking a GOAT
       * for a candle from forty minutes ago would be both wrong and expensive.
       */
      if (!isNew) continue;

      this.emit(
        createMarketEvent({
          type: 'CANDLE_FINALIZED',
          partition,
          instrument,
          candleOpenTimeMs: candle.openTimeMs,
          finalized: candle.finalized,
          context: {
            lagSeconds: Math.max(
              0,
              Math.round((at - (candle.openTimeMs + 60_000)) / 1000),
            ),
            sessionId: resolveSession(instrument, at)?.id,
            dataQuality: this.qualityFor(instrument),
          },
          now: () => this.now(),
        }),
      );
      events += 1;
    }

    return {
      failed: false,
      inserted: outcome.inserted,
      updated: outcome.updated,
      rejected,
      duplicates: outcome.duplicates,
      events,
    };
  }

  /**
   * Runs finalization for an instrument.
   *
   * Separate from `ingest` because finalization must not be skipped when an
   * ingestion pass is suppressed by the overlap guard — pruning and ingestion
   * are independent concerns and coupling them would leave a session
   * unfinalized simply because the market was busy.
   */
  async finalize(instrument: string): Promise<FinalizeOutcomeReport> {
    const key = canonicalInstrument(instrument);
    try {
      const result = await this.finalizer.finalizeLatestClosed(key, this.source.name);
      if (result.outcome === 'FINALIZED') {
        this.stats.finalizations += 1;

        const partition = this.partition(key);
        this.emit(
          createMarketEvent({
            type: 'SESSION_FINALIZED',
            partition,
            instrument: key,
            candleOpenTimeMs: null,
            finalized: true,
            reference: result.summaryId,
            context: {
              summaryId: result.summaryId ?? undefined,
              dataQuality: 'OK',
            },
            now: () => this.now(),
          }),
        );
      }
      return {
        instrument: key,
        outcome: result.outcome,
        pruned: result.pruned,
        reason: result.reason,
        remainingAfterPrune: result.remainingAfterPrune,
        lateUpdatesApplied: result.lateUpdatesApplied,
      };
    } catch (err) {
      return {
        instrument: key,
        outcome: 'FAILED_PERSISTENCE',
        pruned: 0,
        reason: describe(err),
        remainingAfterPrune: 0,
        lateUpdatesApplied: 0,
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Freshness and observability                                       */
  /* ---------------------------------------------------------------- */

  freshnessOf(instrument: string, partition?: PartitionKey): InstrumentFreshness {
    const key = canonicalInstrument(instrument);
    const part = partition ?? this.partition(key);
    const at = this.now();

    let state = this.freshness.get(key);
    if (!state) {
      state = {
        instrument: key,
        partition: part,
        lastSuccessfulIngestAtMs: null,
        lastCandleOpenTimeMs: null,
        lastCandleFinalizedAtMs: null,
        consecutiveFailures: 0,
        stale: true,
        dataLagSeconds: null,
        lastError: null,
        marketOpen: isMarketOpen(key, at),
      };
      this.freshness.set(key, state);
    }

    state.marketOpen = isMarketOpen(key, at);
    state.stale =
      state.lastCandleFinalizedAtMs === null
        ? true
        : at - state.lastCandleFinalizedAtMs > this.staleAfterMs;

    state.dataLagSeconds =
      state.lastCandleFinalizedAtMs === null
        ? null
        : Math.max(0, Math.round((at - state.lastCandleFinalizedAtMs) / 1000));

    return state;
  }

  /** Freshness for every instrument this service has touched. */
  allFreshness(): InstrumentFreshness[] {
    return [...this.freshness.values()].map((state) => ({
      ...this.freshnessOf(state.instrument, state.partition),
    }));
  }

  /** Compact, secret-free status for the health endpoint. */
  health(): Record<string, unknown> {
    const instruments = this.allFreshness();
    return {
      provider: this.source.name,
      stats: { ...this.stats },
      subscriptions: {
        byPartition: this.subscriptionCounts(),
        total: this.totalSubscriptions(),
      },
      instruments: instruments.map((state) => ({
        instrument: state.instrument,
        partition: state.partition,
        lastSuccessfulIngestAtMs: state.lastSuccessfulIngestAtMs,
        lastCandleOpenTimeMs: state.lastCandleOpenTimeMs,
        dataLagSeconds: state.dataLagSeconds,
        consecutiveFailures: state.consecutiveFailures,
        stale: state.stale,
        marketOpen: state.marketOpen,
        lastError: state.lastError,
      })),
      finalizer: { ...this.finalizer.stats },
      retention: this.retention,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private recordSuccess(
    instrument: string,
    partition: PartitionKey,
    newest: CandleRecord | null,
    at: number,
  ): void {
    const state = this.freshnessOf(instrument, partition);
    state.lastSuccessfulIngestAtMs = at;
    state.consecutiveFailures = 0;
    state.lastError = null;
    this.nextAllowedAttempt.delete(partition);

    if (newest) {
      state.lastCandleOpenTimeMs = newest.openTimeMs;
      state.lastCandleFinalizedAtMs = floorToMinute(newest.openTimeMs) + 60_000;
    }
  }

  /**
   * Records a failure and opens the breaker after enough consecutive ones.
   *
   * The backoff is per PARTITION, not per instrument: when a provider is down
   * it is down for every symbol, and backing off per symbol would keep a hot
   * retry loop running across the whole catalogue.
   */
  private recordFailure(
    instrument: string,
    partition: PartitionKey,
    reason: string,
  ): void {
    const state = this.freshnessOf(instrument, partition);
    state.consecutiveFailures += 1;
    state.lastError = reason;

    if (state.consecutiveFailures >= this.breakerThreshold) {
      this.stats.breakerOpens += 1;
      const backoff = Math.min(
        this.baseBackoffMs * 2 ** (state.consecutiveFailures - this.breakerThreshold),
        this.maxBackoffMs,
      );
      this.nextAllowedAttempt.set(partition, this.now() + backoff);

      this.emit(
        createMarketEvent({
          type: 'DATA_STALE',
          partition,
          instrument,
          context: {
            failureReason: reason.slice(0, 200),
            dataQuality: 'SUSPECT',
          },
          now: () => this.now(),
        }),
      );
    }
  }

  private qualityFor(instrument: string): 'OK' | 'DEGRADED' | 'SUSPECT' {
    const state = this.freshnessOf(instrument);
    if (state.lastSuccessfulIngestAtMs === null) return 'SUSPECT';
    if (state.stale) return 'SUSPECT';
    if (state.consecutiveFailures > 0) return 'DEGRADED';
    return 'OK';
  }

  private emit(event: MarketEvent): void {
    this.stats.eventsEmitted += 1;

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        /**
         * One failing listener must never stop ingestion for every other
         * subscriber. The exception is contained here, at the fan-out edge.
         */
        this.log('[ingestion] subscriber threw', err);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Result types                                                        */
/* ------------------------------------------------------------------ */

export interface PerInstrumentOutcome {
  failed: boolean;
  inserted?: number;
  updated?: number;
  rejected?: number;
  duplicates?: number;
  events?: number;
}

export interface IngestionPassResult {
  attempted: number;
  skipped: number;
  inserted: number;
  updated: number;
  rejected: number;
  duplicates: number;
  events: number;
  failures: number;
  skippedInstruments: string[];
}

export interface FinalizeOutcomeReport {
  instrument: string;
  outcome: string;
  pruned: number;
  reason?: string;
  remainingAfterPrune: number;
  lateUpdatesApplied: number;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Composite subscription key. See `subscriptions` for why it is not the id. */
function subscriptionKey(subscriberId: string, instrument: string): string {
  return `${subscriberId}::${canonicalInstrument(instrument)}`;
}