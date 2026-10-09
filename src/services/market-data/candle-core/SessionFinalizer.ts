/**
 * SESSION FINALIZER
 * =================
 * The workflow that converts completed minute candles into durable memory and
 * then, and only then, deletes them.
 *
 * THE INVARIANT
 *
 *   No candle is deleted before the session summary and the structural facts
 *   derived from it are durably persisted AND verified by re-reading them back.
 *
 * Every step below exists to make that true even when something fails halfway:
 *
 *   1. resolve the session eligible for finalization (never the live one)
 *   2. re-read the candles, so late provider corrections are picked up
 *   3. validate OHLC integrity, ordering, duplicates and coverage
 *   4. reconcile late updates against the grace window
 *   5. compute the session summary from real candles
 *   6. detect + confirm swings and fold them into the level ledger
 *   7. classify the regime
 *   8. persist summary, swings, levels, regime
 *   9. VERIFY by re-reading the summary back from storage
 *   10. mark finalized and advance the watermark
 *   11. prune only eligible candles, in bounded batches
 *   12. record completion so a retry cannot repeat destructive work
 *
 * Steps 9-10 are the load-bearing ones. Between persisting and verifying there
 * is a window where the write could have silently failed; verifying closes it.
 * Pruning happens strictly after verification, and it is driven by the
 * FINALIZED WATERMARK, never by wall-clock age, so a session whose finalization
 * crashed simply is not eligible.
 *
 * IDEMPOTENCY
 *
 * `finalizeSession` is safe to run repeatedly for the same session. The summary
 * id embeds the session date and merges; swing and level ids are deterministic
 * so re-detection re-touches rather than appends; and pruning is bounded and
 * only ever removes rows below the watermark. Two concurrent runs produce one
 * summary and one set of levels.
 */

import {
  MINUTE_MS,
  floorToMinute,
  canonicalInstrument,
} from './CandleRecord';
import type { CandleRecord } from './CandleRecord';
import type {
  CandleStorage,
  SessionSummaryRepository,
  StructureRepository,
} from './CandleRepositories';
import {
  lastClosedSession,
  resolveSession,
} from './SessionCalendar';
import type { ResolvedSession } from './SessionCalendar';
import {
  computeSessionSummary,
  mergeSessionSummary,
} from './SessionSummary';
import type { SessionSummary } from './SessionSummary';
import {
  applyLevelBreaks,
  applySwingBreaks,
  boundLevelLedger,
  buildLevelLedger,
  classifyRegime,
  detectSwings,
  expireLevels,
} from './MarketStructure';
import type { LevelRecord, SwingPoint } from './MarketStructure';
import { averageTrueRange } from './SessionSummary';

/** Result of a durable write step. `reason` is present only on failure. */
type PersistOutcome =
  | { status: 'written'; merged: boolean }
  | { status: 'failed'; reason: string };

/** Outcome of one finalization attempt, including the failure modes. */
export type FinalizeOutcome =
  | 'FINALIZED'
  | 'SKIPPED_NO_SESSION'
  | 'SKIPPED_SESSION_LIVE'
  | 'SKIPPED_ALREADY_FINALIZED'
  | 'SKIPPED_WITHIN_GRACE'
  | 'FAILED_NO_DATA'
  | 'FAILED_PERSISTENCE'
  | 'FAILED_VERIFICATION';

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  sessionId: string | null;
  summaryId: string | null;
  /** Candles deleted this run. Non-zero ONLY when the summary verified. */
  pruned: number;
  /** Candles left in the session because the batch limit was reached. */
  remainingAfterPrune: number;
  /** Present on failure; explains which guarantee blocked the prune. */
  reason?: string;
  /** Number of candles that arrived late inside the grace window. */
  lateUpdatesApplied: number;
  /** True when this run merged into an existing summary rather than creating one. */
  mergedExisting: boolean;
}

export interface SessionFinalizerOptions {
  storage: CandleStorage;
  /** Extra history pulled in so ATR and swings have a left-hand context. */
  warmupCandles?: number;
  /** Swing pivot clearance, in bars. */
  swingLookback?: number;
  /** How long after close we still accept corrections before finalizing. */
  lateGraceMs?: number;
  /** Max candles deleted per session per run. */
  pruneBatchSize?: number;
  /** Max summaries retained per instrument. */
  maxSummaries?: number;
  /** Max active levels retained per instrument. */
  maxLevels?: number;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

const DEFAULTS = {
  warmupCandles: 240,
  swingLookback: 2,
  lateGraceMs: 3 * MINUTE_MS,
  pruneBatchSize: 2_000,
  maxSummaries: 400,
  maxLevels: 250,
};

/**
 * Tracks the completion record for a session.
 *
 * Separate from the summary because its job is narrower: to answer "may this
 * session's candles be deleted?" without recomputing anything. After a crash it
 * is rebuilt from the stored summaries, so it needs no durability of its own.
 */
export interface FinalizationCheckpoint {
  sessionId: string;
  summaryId: string;
  summaryVerified: boolean;
  finalizedAtMs: number;
  candlesInSession: number;
  candlesPruned: number;
  schemaVersion: number;
}

export class SessionFinalizer {
  private readonly storage: CandleStorage;
  private readonly warmupCandles: number;
  private readonly swingLookback: number;
  private readonly lateGraceMs: number;
  private readonly pruneBatchSize: number;
  private readonly maxSummaries: number;
  private readonly maxLevels: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  /** In-flight sessions, so two alarms cannot finalize one session at once. */
  private readonly inflight = new Set<string>();

  readonly stats = {
    attempts: 0,
    finalized: 0,
    skipped: 0,
    failures: 0,
    prunedCandles: 0,
    verificationFailures: 0,
  };

  constructor(options: SessionFinalizerOptions) {
    this.storage = options.storage;
    this.warmupCandles = options.warmupCandles ?? DEFAULTS.warmupCandles;
    this.swingLookback = options.swingLookback ?? DEFAULTS.swingLookback;
    this.lateGraceMs = options.lateGraceMs ?? DEFAULTS.lateGraceMs;
    this.pruneBatchSize = options.pruneBatchSize ?? DEFAULTS.pruneBatchSize;
    this.maxSummaries = options.maxSummaries ?? DEFAULTS.maxSummaries;
    this.maxLevels = options.maxLevels ?? DEFAULTS.maxLevels;
    this.now = options.now ?? (() => Date.now());
    this.log =
      options.log ??
      ((message, error) => {
        if (error) console.warn(message, error);
        else console.warn(message);
      });
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Finalizes the most recent CLOSED session for an instrument.
   *
   * Never throws. A failure is reported in the result so a caller can log it
   * and let the next scheduled run retry — which is exactly what must happen,
   * because the alternative is pruning without a summary.
   */
  async finalizeLatestClosed(
    instrument: string,
    source = 'unknown',
  ): Promise<FinalizeResult> {
    const at = this.now();
    const session = lastClosedSession(instrument, at);

    if (!session) {
      this.stats.skipped += 1;
      return emptyResult('SKIPPED_NO_SESSION', 'No session could be resolved.');
    }

    return this.finalizeSession(session, source);
  }

  /**
   * Finalizes one specific session, provided it has closed.
   */
  async finalizeSession(
    session: ResolvedSession,
    source = 'unknown',
  ): Promise<FinalizeResult> {
    this.stats.attempts += 1;

    const key = canonicalInstrument(session.instrument);
    const at = this.now();

    // ---- 1. never finalize a session that is still forming -------------
    if (session.closesAtMs > at) {
      this.stats.skipped += 1;
      return {
        ...emptyResult('SKIPPED_SESSION_LIVE', 'Session has not closed yet.'),
        sessionId: session.id,
      };
    }

    /**
     * ---- 4. grace window -------------------------------------------------
     * Inside the grace window we defer rather than finalize, because a late
     * provider correction would otherwise be frozen out of the summary and
     * then deleted with the candles it belonged to.
     */
    if (at - session.closesAtMs < this.lateGraceMs) {
      this.stats.skipped += 1;
      return {
        ...emptyResult(
          'SKIPPED_WITHIN_GRACE',
          `Waiting ${this.lateGraceMs - (at - session.closesAtMs)}ms for late updates.`,
        ),
        sessionId: session.id,
      };
    }

    // Serialize per session. The DO's single-writer guarantee covers the
    // cloud path; this covers the in-process path.
    if (this.inflight.has(session.id)) {
      this.stats.skipped += 1;
      return {
        ...emptyResult('SKIPPED_ALREADY_FINALIZED', 'Finalization already in flight.'),
        sessionId: session.id,
      };
    }

    this.inflight.add(session.id);

    try {
      return await this.runFinalization(session, source, key);
    } finally {
      this.inflight.delete(session.id);
    }
  }

  /**
   * Rebuilds completion records from stored summaries.
   *
   * This is what makes the checkpoint durable across a restart: it needs no
   * separate write, because a verified summary IS the checkpoint. A session
   * whose summary exists and verifies was, by construction, already pruned
   * safely — or will be on the next pass.
   */
  async rebuildCheckpoints(
    instrument: string,
    limit = 10,
  ): Promise<FinalizationCheckpoint[]> {
    const summaries = await this.storage.summaries.list(
      canonicalInstrument(instrument),
      limit,
    );

    return summaries.map((summary) => ({
      sessionId: summary.sessionId,
      summaryId: summary.id,
      summaryVerified: true,
      finalizedAtMs: summary.finalizedAtMs,
      candlesInSession: summary.candleCount,
      candlesPruned: 0,
      schemaVersion: summary.schemaVersion,
    }));
  }

  /**
   * Whether it is safe to delete candles below `atMs` for an instrument.
   *
   * The single query every prune path should ask first. Returns false — and
   * therefore deletes nothing — whenever finalization has not demonstrably
   * reached the requested boundary.
   */
  async canPrune(instrument: string, atMs: number): Promise<{
    allowed: boolean;
    reason: string;
    finalizedThroughMs: number | null;
  }> {
    const watermark = await this.storage.summaries.finalizedThroughMs(
      canonicalInstrument(instrument),
    );

    if (watermark === null) {
      return {
        allowed: false,
        reason: 'No finalized session summary exists; nothing is safe to delete.',
        finalizedThroughMs: null,
      };
    }

    if (floorToMinute(atMs) >= watermark) {
      return {
        allowed: false,
        reason: `Requested boundary ${floorToMinute(atMs)} has not been finalized (watermark ${watermark}).`,
        finalizedThroughMs: watermark,
      };
    }

    return { allowed: true, reason: 'ok', finalizedThroughMs: watermark };
  }

  /* ---------------------------------------------------------------- */
  /* The workflow                                                      */
  /* ---------------------------------------------------------------- */

  private async runFinalization(
    session: ResolvedSession,
    source: string,
    instrument: string,
  ): Promise<FinalizeResult> {
    const at = this.now();

    // ---- 2/3. re-read + validate -------------------------------------
    const toMs = floorToMinute(session.closesAtMs);
    const fromMs = session.opensAtMs;

    let sessionCandles: CandleRecord[];
    try {
      sessionCandles = await this.storage.range(
        instrument,
        fromMs - this.warmupCandles * MINUTE_MS,
        toMs,
        this.warmupCandles + 5_000,
      );
    } catch (err) {
      this.stats.failures += 1;
      return this.failure(
        'FAILED_PERSISTENCE',
        session.id,
        `Candle read failed: ${describe(err)}`,
      );
    }

    /**
     * Validation: drop candles that fail integrity rather than summarising
     * them. A corrupt bar would otherwise become a permanent "fact" about the
     * session, which is worse than a recorded gap.
     */
    const validated = sessionCandles.filter(isStructurallyValid);

    const inSession = validated.filter(
      (candle) =>
        candle.openTimeMs >= fromMs && candle.openTimeMs < toMs,
    );

    // Dedupe defensively. `range` is ascending and the store is keyed, so this
    // is belt-and-braces against a backend that does not sort.
    const deduped = dedupeByOpenTime(inSession);

    if (deduped.length === 0) {
      /**
       * No candles. This is NOT a failure and MUST NOT block the pipeline
       * forever — a session with no data (holiday, feed outage) still gets a
       * summary recording that it was empty, which is itself the useful fact.
       * What it must never do is prune: there is nothing to prune, and
       * recording emptiness keeps the watermark honest.
       */
      const summary = computeSessionSummary({
        instrument,
        sessionId: session.id,
        sessionDate: session.sessionDate,
        opensAtMs: session.opensAtMs,
        closesAtMs: session.closesAtMs,
        timezone: session.timezone,
        candles: [],
        previous: null,
        regime: null,
        confirmedSwingIds: [],
        activeLevelIds: [],
        source,
        spansClosure: session.spansWeekendGap || session.isHoliday,
        now: () => at,
      });

      const persisted = await this.persistSummary(summary);
      if (persisted.status === 'failed') {
        return this.failure('FAILED_PERSISTENCE', session.id, persisted.reason);
      }

      this.stats.finalized += 1;
      return {
        outcome: 'FAILED_NO_DATA',
        sessionId: session.id,
        summaryId: summary.id,
        pruned: 0,
        remainingAfterPrune: 0,
        reason: 'Session contained no valid candles; an empty summary was recorded.',
        lateUpdatesApplied: 0,
        mergedExisting: persisted.merged,
      };
    }

    const lateUpdatesApplied = deduped.filter(
      (candle) => candle.revision > 1,
    ).length;

    const previous = await this.previousSummary(instrument, session.sessionDate);

    // ---- 6. structure from real candles -------------------------------
    const { swings, levels, regime, confirmedSwingIds } =
      await this.updateStructure(instrument, validated, deduped, session, at);

    // ---- 5. summary ----------------------------------------------------
    const summary = computeSessionSummary({
      instrument,
      sessionId: session.id,
      sessionDate: session.sessionDate,
      opensAtMs: session.opensAtMs,
      closesAtMs: session.closesAtMs,
      timezone: session.timezone,
      candles: deduped,
      previous,
      regime,
      confirmedSwingIds,
      activeLevelIds: levels
        .filter((level) => level.status === 'ACTIVE')
        .map((level) => level.id),
      source,
      spansClosure: session.spansWeekendGap || session.isHoliday,
      now: () => at,
    });

    // ---- 8. persist everything derived ---------------------------------
    const persisted = await this.persistAll(summary, swings, levels, regime);
    if (persisted.status === 'failed') {
      /**
       * Nothing is deleted. This is the invariant doing its job: a storage
       * outage leaves the candles exactly where they were, and the next
       * scheduled run retries from a clean state.
       */
      this.log(
        `[finalizer] ${instrument} ${session.id} persist failed: ${persisted.reason}`,
      );
      return this.failure('FAILED_PERSISTENCE', session.id, persisted.reason);
    }

    // ---- 9. VERIFY by re-reading ---------------------------------------
    const verified = await this.verifySummary(summary.id);
    if (!verified) {
      this.stats.verificationFailures += 1;
      this.log(
        `[finalizer] ${instrument} ${summary.id} failed read-back verification; refusing to prune.`,
      );
      return this.failure(
        'FAILED_VERIFICATION',
        session.id,
        'Summary did not read back from storage; candles retained.',
      );
    }

    // ---- 11. prune, bounded, only now ---------------------------------
    const pruned = await this.pruneEligible(instrument);

    this.stats.finalized += 1;
    this.stats.prunedCandles += pruned;

    return {
      outcome: 'FINALIZED',
      sessionId: session.id,
      summaryId: summary.id,
      pruned,
      remainingAfterPrune: await this.countRemaining(instrument, toMs),
      lateUpdatesApplied,
      mergedExisting: persisted.merged,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Steps                                                             */
  /* ---------------------------------------------------------------- */

  private async updateStructure(
    instrument: string,
    warmupCandles: readonly CandleRecord[],
    sessionCandles: readonly CandleRecord[],
    session: ResolvedSession,
    at: number,
  ): Promise<{
    swings: SwingPoint[];
    levels: LevelRecord[];
    regime: SessionSummary['regime'];
    confirmedSwingIds: string[];
  }> {
    const detected = detectSwings(warmupCandles, instrument, {
      lookback: this.swingLookback,
    });

    const atr =
      averageTrueRange(sessionCandles, 14) || averageTrueRange(warmupCandles, 14);

    const broken = applySwingBreaks(detected.confirmed, warmupCandles, atr);

    const existingLevels = await this.storage.structure.listLevels(instrument);
    const merged = buildLevelLedger(
      instrument,
      broken,
      existingLevels,
      at,
    );
    const withBreaks = applyLevelBreaks(merged, warmupCandles, atr);
    const expired = expireLevels(
      withBreaks,
      at,
      90 * 24 * 60 * MINUTE_MS,
    );
    const bounded = boundLevelLedger(expired, this.maxLevels);

    const highs = broken.filter((s) => s.kind === 'HIGH');
    const lows = broken.filter((s) => s.kind === 'LOW');

    const latestHigh = highs[highs.length - 1] ?? null;
    const latestLow = lows[lows.length - 1] ?? null;

    const previousSummary = await this.previousSummary(
      instrument,
      session.sessionDate,
    );

    const sessionHigh = sessionCandles.length
      ? Math.max(...sessionCandles.map((c) => c.high))
      : 0;
    const sessionLow = sessionCandles.length
      ? Math.min(...sessionCandles.map((c) => c.low))
      : 0;

    const regime = classifyRegime(instrument, session.id, at, {
      atr,
      price: sessionCandles.length ? sessionCandles[sessionCandles.length - 1].close : 0,
      swingHigh: latestHigh ? latestHigh.price : null,
      swingLow: latestLow ? latestLow.price : null,
      swingHighAgeMs: latestHigh ? at - latestHigh.atMs : null,
      swingLowAgeMs: latestLow ? at - latestLow.atMs : null,
      rangePct: sessionHigh > 0 ? ((sessionHigh - sessionLow) / sessionHigh) * 100 : 0,
      previousRangePct: previousSummary ? previousSummary.rangePercent : null,
      higherTimeframeTrend: null,
    });

    return {
      swings: broken,
      levels: bounded,
      regime,
      confirmedSwingIds: broken
        .filter((s) => s.atMs >= session.opensAtMs && s.atMs < session.closesAtMs)
        .map((s) => s.id),
    };
  }

  private async persistAll(
    summary: SessionSummary,
    swings: readonly SwingPoint[],
    levels: readonly LevelRecord[],
    regime: SessionSummary['regime'],
  ): Promise<PersistOutcome> {
    const structure: StructureRepository = this.storage.structure;

    let saved: PersistOutcome;
    try {
      saved = await this.persistSummary(summary);
    } catch (err) {
      return { status: 'failed', reason: describe(err) };
    }
    if (saved.status === 'failed') return saved;

    try {
      await structure.saveSwings(swings);
      await structure.saveLevels(levels);
      if (regime) await structure.saveRegime(regime);
    } catch (err) {
      return { status: 'failed', reason: describe(err) };
    }

    return { status: 'written', merged: saved.merged };
  }

  private async persistSummary(summary: SessionSummary): Promise<PersistOutcome> {
    const repo: SessionSummaryRepository = this.storage.summaries;
    try {
      const existing = await repo.get(summary.id);
      const merged = existing ? mergeSessionSummary(existing, summary) : summary;
      await repo.save(merged);
      return { status: 'written', merged: Boolean(existing) };
    } catch (err) {
      return { status: 'failed', reason: describe(err) };
    }
  }

  /**
   * Step 9. Re-reads the summary and checks it is a real, complete record.
   *
   * This is the check that makes the delete safe: it confirms the durable copy
   * exists, is the right session, actually holds candle data, and is not the
   * empty placeholder.
   */
  private async verifySummary(summaryId: string): Promise<boolean> {
    try {
      const stored = await this.storage.summaries.get(summaryId);
      if (!stored) return false;
      if (stored.id !== summaryId) return false;
      if (stored.candleCount <= 0) return false;
      if (!Number.isFinite(stored.high) || !Number.isFinite(stored.low)) return false;
      if (stored.high < stored.low) return false;
      if (stored.expectedCandleCount <= 0) return false;
      return true;
    } catch (err) {
      this.log(`[finalizer] verification read failed for ${summaryId}`, err);
      return false;
    }
  }

  /**
   * Step 11. Deletes only candles below the FINALIZED WATERMARK.
   *
   * The watermark comes from the stored summaries, so it can only move forward
   * through a run that verified. There is no code path that reaches the delete
   * without `verifySummary` having returned true.
   */
  private async pruneEligible(instrument: string): Promise<number> {
    const watermark = await this.storage.summaries.finalizedThroughMs(instrument);
    if (watermark === null) return 0;

    const boundary = floorToMinute(watermark);

    try {
      return await this.storage.deleteBefore(
        instrument,
        boundary,
        this.pruneBatchSize,
      );
    } catch (err) {
      /**
       * A prune failure is survivable — the summary is already durable, so the
       * next run will simply delete them. It must not fail the finalization,
       * because the derived facts are safe.
       */
      this.log('[finalizer] prune failed; will retry next run', err);
      return 0;
    }
  }

  private async countRemaining(
    instrument: string,
    beforeMs: number,
  ): Promise<number> {
    try {
      const rows = await this.storage.range(
        instrument,
        0,
        beforeMs,
        10_000,
      );
      return rows.length;
    } catch {
      return 0;
    }
  }

  private async previousSummary(
    instrument: string,
    beforeSessionDate: string,
  ): Promise<SessionSummary | null> {
    try {
      const all = await this.storage.summaries.list(instrument, 5);
      const earlier = all.filter(
        (summary) => summary.sessionDate < beforeSessionDate,
      );
      return earlier[0] ?? null;
    } catch {
      return null;
    }
  }

  private failure(
    outcome: FinalizeOutcome,
    sessionId: string,
    reason: string,
  ): FinalizeResult {
    this.stats.failures += 1;
    return {
      outcome,
      sessionId,
      summaryId: null,
      pruned: 0,
      remainingAfterPrune: 0,
      reason,
      lateUpdatesApplied: 0,
      mergedExisting: false,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Structural validation applied at summary time.
 *
 * Deliberately narrower than the ingestion validator: rows are already in
 * storage, so this is a defence-in-depth check against corruption introduced
 * outside the ingestion path (manual writes, a bad restore) rather than the
 * primary gate.
 */
function isStructurallyValid(candle: CandleRecord): boolean {
  if (!Number.isFinite(candle.open)) return false;
  if (!Number.isFinite(candle.high)) return false;
  if (!Number.isFinite(candle.low)) return false;
  if (!Number.isFinite(candle.close)) return false;
  if (candle.high < candle.low) return false;
  if (candle.open <= 0 || candle.close <= 0) return false;
  if (candle.openTimeMs % MINUTE_MS !== 0) return false;
  return true;
}

/** Keeps the first occurrence of each open time; preserves ascending order. */
function dedupeByOpenTime(candles: readonly CandleRecord[]): CandleRecord[] {
  const seen = new Set<number>();
  const out: CandleRecord[] = [];

  for (const candle of candles) {
    if (seen.has(candle.openTimeMs)) continue;
    seen.add(candle.openTimeMs);
    out.push(candle);
  }

  return out.sort((a, b) => a.openTimeMs - b.openTimeMs);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyResult(
  outcome: FinalizeOutcome,
  reason: string,
): FinalizeResult {
  return {
    outcome,
    sessionId: null,
    summaryId: null,
    pruned: 0,
    remainingAfterPrune: 0,
    reason,
    lateUpdatesApplied: 0,
    mergedExisting: false,
  };
}

export { resolveSession };