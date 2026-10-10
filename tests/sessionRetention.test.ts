import { describe, test, expect } from 'bun:test';
import {
  resolveSession,
  lastClosedSession,
  localTimeToUtcMs,
  zoneOffsetMs,
  isMarketOpen,
  classifyInstrument,
  sessionSpecFor,
} from '../src/services/market-data/candle-core/SessionCalendar';
import { MINUTE_MS, floorToMinute } from '../src/services/market-data/candle-core/CandleRecord';
import {
  DEFAULT_RETENTION,
  pruneBoundaryMs,
  isEligibleForPruning,
  derivedRetentionBoundary,
  retentionPolicyFromEnv,
  retentionPolicyForInstrument,
} from '../src/services/market-data/candle-core/RetentionPolicy';
import { SessionFinalizer } from '../src/services/market-data/candle-core/SessionFinalizer';
import { MemoryCandleRepository } from '../src/services/market-data/candle-core/CandleRepositories';
import { validateCandle } from '../src/services/market-data/candle-core/CandleRecord';
import type { CandleRecord } from '../src/services/market-data/candle-core/CandleRecord';

/**
 * SESSION CALENDAR, RETENTION AND SAFE FINALIZATION
 * =================================================
 * The load-bearing invariant of this entire module:
 *
 *   NO CANDLE HISTORY IS DELETED BEFORE ITS REQUIRED DURABLE SUMMARY AND
 *   STRUCTURAL FACTS ARE SAFELY PERSISTED.
 *
 * Everything else here is in service of proving that holds under failure, and
 * that session boundaries are correct across DST rather than hardcoded.
 */

const iso = (ms: number) => new Date(ms).toISOString();

describe('session calendar — timezone correctness', () => {
  test('New York is UTC-5 in winter and UTC-4 in summer', () => {
    // The old implementation hardcoded 13:00 UTC for the NY open all year,
    // which is wrong for exactly six months.
    expect(zoneOffsetMs('America/New_York', Date.parse('2026-01-15T12:00:00Z')) / MINUTE_MS).toBe(-300);
    expect(zoneOffsetMs('America/New_York', Date.parse('2026-07-15T12:00:00Z')) / MINUTE_MS).toBe(-240);
  });

  test('a 17:00 New York close resolves to a different UTC instant either side of DST', () => {
    const winter = localTimeToUtcMs('America/New_York', 2026, 1, 15, 17 * 60);
    const summer = localTimeToUtcMs('America/New_York', 2026, 7, 15, 17 * 60);

    expect(winter.exists).toBe(true);
    expect(summer.exists).toBe(true);
    if (!winter.exists || !summer.exists) return;

    // 17:00 EST is 22:00 UTC; 17:00 EDT is 21:00 UTC.
    expect(iso(winter.atMs)).toBe('2026-01-15T22:00:00.000Z');
    expect(iso(summer.atMs)).toBe('2026-07-15T21:00:00.000Z');
  });

  test('reports a spring-forward gap as nonexistent instead of inventing an instant', () => {
    // 02:30 on 2026-03-08 does not exist in New York.
    const result = localTimeToUtcMs('America/New_York', 2026, 3, 8, 150);
    // Asserted structurally: the union is not narrowed by a boolean literal
    // when strictNullChecks is off, and the shape is what matters here.
    expect(result).toEqual({ exists: false, reason: 'NONEXISTENT' });
  });

  test('resolves a fall-back overlap to the earlier occurrence', () => {
    const result = localTimeToUtcMs('America/New_York', 2026, 11, 1, 60);
    expect(result.exists).toBe(true);
    if (!result.exists) return;
    // 01:00 occurs twice; the first pass is chosen so a session opening at the
    // start of the repeated hour does not skip its own opening minute.
    expect(iso(result.atMs)).toBe('2026-11-01T05:00:00.000Z');
  });

  test('handles a half-hour timezone zone without a special case', () => {
    // Asia/Kolkata is UTC+5:30.
    expect(zoneOffsetMs('Asia/Kolkata', Date.parse('2026-07-15T12:00:00Z')) / MINUTE_MS).toBe(330);
  });

  test('TOKYO index hours are resolved in Asia/Tokyo, not New York', () => {
    const spec = sessionSpecFor('XYZ:JP225');
    expect(spec.timezone).toBe('Asia/Tokyo');

    const session = resolveSession('XYZ:JP225', Date.parse('2026-07-15T03:00:00Z'));
    expect(session).not.toBeNull();
    if (!session) return;

    // 09:00 JST = 00:00 UTC in summer.
    expect(iso(session.opensAtMs)).toBe('2026-07-15T00:00:00.000Z');
  });
});

describe('session calendar — instrument-specific sessions', () => {
  test('classifies instruments into their own session geometry', () => {
    expect(classifyInstrument('EUR/USD')).toBe('FX');
    expect(classifyInstrument('XYZ:GOLD')).toBe('METALS');
    expect(classifyInstrument('XYZ:CL')).toBe('ENERGY');
    expect(classifyInstrument('XYZ:JP225')).toBe('INDEX');
    expect(classifyInstrument('BTC')).toBe('CRYPTO');
  });

  test('FX sessions are labelled by their CLOSE date, the market convention', () => {
    // Monday 22:00 UTC is Sunday 17:00 ET, which opens MONDAY's session.
    const session = resolveSession('EUR/USD', Date.parse('2026-01-19T22:00:00Z'));

    expect(session).not.toBeNull();
    if (!session) return;
    expect(session.sessionDate).toBe('2026-01-20');
    expect(session.state).toBe('OPEN');
  });

  test('an index session is a plain intraday window in its own zone', () => {
    const during = resolveSession('XYZ:JP225', Date.parse('2026-07-15T03:00:00Z'));
    const after = resolveSession('XYZ:JP225', Date.parse('2026-07-15T08:00:00Z'));

    expect(during?.state).toBe('OPEN');
    // 09:00 JST = 00:00 UTC.
    expect(iso(during!.opensAtMs)).toBe('2026-07-15T00:00:00.000Z');
    expect(after?.state).toBe('CLOSED');
  });

  test('crypto trades continuously, including on a Saturday', () => {
    const saturday = resolveSession('BTC', Date.parse('2026-01-17T12:00:00Z'));

    expect(saturday).not.toBeNull();
    if (!saturday) return;
    expect(saturday.state).toBe('OPEN');
    expect(isMarketOpen('BTC', Date.parse('2026-01-17T12:00:00Z'))).toBe(true);
  });

  test('the same wall-clock instant is open for crypto and closed for FX on a weekend', () => {
    const at = Date.parse('2026-01-17T12:00:00Z'); // Saturday

    expect(isMarketOpen('BTC', at)).toBe(true);
    expect(isMarketOpen('EUR/USD', at)).toBe(false);
    expect(isMarketOpen('XYZ:JP225', at)).toBe(false);
  });

  test('a weekend resolves to the PREVIOUS session rather than to nothing', () => {
    // This matters for finalization: the previous session's candles are the
    // ones on disk, so it is the one whose summary must be produced.
    const saturday = resolveSession('EUR/USD', Date.parse('2026-01-17T12:00:00Z'));

    expect(saturday).not.toBeNull();
    if (!saturday) return;
    expect(saturday.state).toBe('CLOSED');
    expect(saturday.sessionDate).toBe('2026-01-16');
  });

  test('the instant a session closes resolves to CLOSED, not to null', () => {
    const exact = resolveSession('XYZ:JP225', Date.parse('2026-07-15T06:00:00Z'));

    expect(exact).not.toBeNull();
    expect(exact?.state).toBe('CLOSED');
  });

  test('lastClosedSession never returns a session that is still forming', () => {
    const at = Date.parse('2026-01-15T15:00:00Z');
    const during = resolveSession('EUR/USD', at);
    const closed = lastClosedSession('EUR/USD', at);

    // The session containing `at` is still OPEN (it closes at 22:00Z).
    expect(during?.state).toBe('OPEN');
    expect(during?.sessionDate).toBe('2026-01-15');

    // So the newest FINALIZABLE session is the previous one, which closed on
    // the 14th. Finalizing the 15th here would summarize a partial session as
    // if it were complete.
    expect(closed).not.toBeNull();
    expect(closed?.sessionDate).toBe('2026-01-14');
    expect(closed!.closesAtMs).toBeLessThanOrEqual(at);
  });

  test('once a session has closed, lastClosedSession returns THAT session', () => {
    // 2026-01-15T23:00Z is after the Thursday close at 22:00Z.
    const at = Date.parse('2026-01-15T23:00:00Z');
    const closed = lastClosedSession('EUR/USD', at);

    expect(closed?.sessionDate).toBe('2026-01-15');
    expect(closed?.closesAtMs).toBeLessThanOrEqual(at);
  });
});

describe('retention policy', () => {
  test('defaults match the documented storage policy', () => {
    expect(DEFAULT_RETENTION.h1.days).toBe(7);
    expect(DEFAULT_RETENTION.d1.days).toBe(180);
    expect(DEFAULT_RETENTION.sessionSummaries).toBe(400);
    expect(DEFAULT_RETENTION.pruneBatchSize).toBe(2000);
  });

  test('the prune boundary is driven by a watermark, never by wall clock', () => {
    expect(pruneBoundaryMs(null)).toBeNull();
    expect(pruneBoundaryMs(0)).toBeNull();
    expect(pruneBoundaryMs(NaN)).toBeNull();

    expect(pruneBoundaryMs(1_800_000_123_456)).toBe(
      floorToMinute(1_800_000_123_456),
    );
  });

  test('nothing is eligible for pruning without a watermark', () => {
    // This is the invariant in one line: with no completed finalization, no
    // candle may be deleted, however old it is.
    const ancient = Date.UTC(2020, 0, 1);

    expect(isEligibleForPruning(ancient, null)).toBe(false);
    expect(isEligibleForPruning(ancient, 0)).toBe(false);
  });

  test('only candles strictly below the watermark are eligible', () => {
    const watermark = Date.UTC(2026, 0, 15, 12, 0, 0);

    expect(isEligibleForPruning(watermark - MINUTE_MS, watermark)).toBe(true);
    expect(isEligibleForPruning(watermark, watermark)).toBe(false);
    expect(isEligibleForPruning(watermark + MINUTE_MS, watermark)).toBe(false);
  });

  test('a disabled derived bucket never produces a boundary', () => {
    const policy = { ...DEFAULT_RETENTION, m5: { enabled: false, sessions: 3 } };
    expect(derivedRetentionBoundary('M5', policy, Date.now())).toBeNull();
  });

  test('an unparseable env override falls back rather than disabling pruning', () => {
    const previous = process.env.RETENTION_H1_DAYS;
    process.env.RETENTION_H1_DAYS = 'not-a-number';
    try {
      // A bad value must not become 0 days, which would silently switch
      // retention off.
      expect(retentionPolicyFromEnv().h1.days).toBe(DEFAULT_RETENTION.h1.days);
    } finally {
      if (previous === undefined) delete process.env.RETENTION_H1_DAYS;
      else process.env.RETENTION_H1_DAYS = previous;
    }
  });

  test('a 24/7 market gets a proportionally longer short-term window', () => {
    const fx = retentionPolicyForInstrument('EUR/USD');
    const crypto = retentionPolicyForInstrument('BTC');

    expect(crypto.m5.sessions).toBeGreaterThan(fx.m5.sessions);
  });
});

describe('session finalization', () => {
  /**
   * Builds a dense but realistic session: one candle per minute with a
   * deterministic zig-zag, so swings and levels actually exist.
   */
  function sessionCandles(
    instrument: string,
    fromMs: number,
    minutes: number,
    startPrice = 1.085,
  ): CandleRecord[] {
    const records: CandleRecord[] = [];

    for (let i = 0; i < minutes; i += 1) {
      // A wave with period 7, so every 7th bar is a local extreme.
      const wave = Math.sin((i / 7) * Math.PI * 2);
      const base = startPrice + wave * 0.002;

      const open = base;
      const close = base + Math.cos(i / 3) * 0.0004;
      const high = Math.max(open, close) + 0.0006;
      const low = Math.min(open, close) - 0.0006;

      const result = validateCandle(
        { instrument, openTimeMs: fromMs + i * MINUTE_MS, open, high, low, close, volume: 1000 },
        { now: () => fromMs + (minutes + 10) * MINUTE_MS },
      );

      if (result.ok) records.push(result.record);
    }

    return records;
  }

  async function seedSession(
    storage: MemoryCandleRepository,
    instrument = 'EUR/USD',
    minutes = 240,
  ): Promise<{ session: NonNullable<ReturnType<typeof resolveSession>>; candles: CandleRecord[] }> {
    // Build around a known Monday session and finalize well after it closed.
    const probe = Date.UTC(2026, 0, 14, 23, 0, 0);
    const session = resolveSession(instrument, probe);
    if (!session) throw new Error('session did not resolve');

    const candles = sessionCandles(instrument, session.opensAtMs, minutes);
    await storage.upsertMany(candles);

    return { session, candles };
  }

  function finalizer(storage: MemoryCandleRepository, nowMs: number): SessionFinalizer {
    return new SessionFinalizer({
      storage,
      lateGraceMs: 60_000,
      pruneBatchSize: 100,
      now: () => nowMs,
    });
  }

  test('refuses to finalize a session that is still forming', async () => {
    const storage = new MemoryCandleRepository();
    const session = resolveSession('EUR/USD', Date.UTC(2026, 0, 15, 15, 0, 0))!;

    // "now" is BEFORE the session closes.
    const result = await finalizer(storage, session.closesAtMs - 60_000).finalizeSession(session);

    expect(result.outcome).toBe('SKIPPED_SESSION_LIVE');
    expect(result.pruned).toBe(0);
    // Nothing may be deleted while the session is live.
    expect(await storage.count('EUR/USD')).toBe(0);
  });

  test('defers inside the late-update grace window', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const result = await finalizer(storage, session.closesAtMs + 10_000).finalizeSession(session);

    expect(result.outcome).toBe('SKIPPED_WITHIN_GRACE');
    expect(result.pruned).toBe(0);
    expect(await storage.count('EUR/USD')).toBe(candles.length);
  });

  test('persists the summary BEFORE deleting any candle', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const subject = finalizer(storage, session.closesAtMs + 10 * MINUTE_MS);
    const result = await subject.finalizeSession(session);

    expect(result.outcome).toBe('FINALIZED');

    // THE INVARIANT: the summary exists, is complete, and is readable back
    // before anything was deleted.
    const summary = await storage.summaries.get(result.summaryId!);
    expect(summary).not.toBeNull();
    if (!summary) return;

    expect(summary.candleCount).toBeGreaterThan(0);
    expect(summary.high).toBeGreaterThan(summary.low);
    expect(summary.expectedCandleCount).toBeGreaterThan(0);

    // And the structural facts survive the prune.
    const swings = await storage.structure.listSwings('EUR/USD');
    const levels = await storage.structure.listLevels('EUR/USD');
    expect(swings.length).toBeGreaterThan(0);
    expect(levels.length).toBeGreaterThan(0);
    const regime = await storage.structure.latestRegime('EUR/USD');
    expect(regime).not.toBeNull();

    expect(result.pruned).toBeGreaterThan(0);
  });

  test('summary values are computed from the real candles', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const result = await finalizer(storage, session.closesAtMs + 10 * MINUTE_MS)
      .finalizeSession(session);

    const summary = await storage.summaries.get(result.summaryId!);
    expect(summary).not.toBeNull();
    if (!summary) return;

    const sessionCandlesOnly = candles.filter(
      (c) => c.openTimeMs >= session.opensAtMs && c.openTimeMs < session.closesAtMs,
    );

    expect(summary.high).toBe(Math.max(...sessionCandlesOnly.map((c) => c.high)));
    expect(summary.low).toBe(Math.min(...sessionCandlesOnly.map((c) => c.low)));
    expect(summary.open).toBe(sessionCandlesOnly[0].open);
    expect(summary.close).toBe(sessionCandlesOnly[sessionCandlesOnly.length - 1].close);
    expect(summary.candleCount).toBe(sessionCandlesOnly.length);
  });

  test('does NOT delete anything when the summary write fails', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const subject = finalizer(storage, session.closesAtMs + 10 * MINUTE_MS);

    // Make the summary repository fail, while candles remain readable.
    const originalSave = storage.summaries.save;
    storage.summaries.save = async () => {
      throw new Error('storage unavailable');
    };

    const result = await subject.finalizeSession(session);
    storage.summaries.save = originalSave;

    expect(result.outcome).toBe('FAILED_PERSISTENCE');

    // THE INVARIANT under failure: every candle is still there.
    expect(result.pruned).toBe(0);
    expect(await storage.count('EUR/USD')).toBe(candles.length);
    expect(subject.stats.verificationFailures).toBe(0);
  });

  test('does NOT delete anything when read-back verification fails', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const subject = finalizer(storage, session.closesAtMs + 10 * MINUTE_MS);

    // Write succeeds, read-back does not: the exact window between persisting
    // and deleting that verification exists to close.
    const originalGet = storage.summaries.get;
    storage.summaries.get = async () => null;

    const result = await subject.finalizeSession(session);
    storage.summaries.get = originalGet;

    expect(result.outcome).toBe('FAILED_VERIFICATION');
    expect(result.pruned).toBe(0);
    expect(await storage.count('EUR/USD')).toBe(candles.length);
    expect(subject.stats.verificationFailures).toBe(1);
  });

  test('repeated finalization does not create a second summary', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const subject = finalizer(storage, session.closesAtMs + 10 * MINUTE_MS);

    const first = await subject.finalizeSession(session);
    const second = await subject.finalizeSession(session);
    const third = await subject.finalizeSession(session);

    expect(first.outcome).toBe('FINALIZED');
    // Later runs find nothing left to prune and merge into the existing record.
    expect(second.summaryId).toBe(first.summaryId);
    expect(third.summaryId).toBe(first.summaryId);

    // Exactly one summary for one session, no matter how many runs.
    expect(await storage.summaries.count('EUR/USD')).toBe(1);
    expect(second.mergedExisting).toBe(true);
  });

  test('pruning is bounded to the configured batch size', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage, 'EUR/USD', 240);
    await storage.upsertMany(candles);

    const subject = new SessionFinalizer({
      storage,
      lateGraceMs: 60_000,
      pruneBatchSize: 50,
      now: () => session.closesAtMs + 10 * MINUTE_MS,
    });

    const result = await subject.finalizeSession(session);

    // A batch cap means the rest survives to the next run — never unbounded
    // deletion in one alarm.
    expect(result.pruned).toBeLessThanOrEqual(50);
    expect(await storage.count('EUR/USD')).toBeGreaterThan(0);
  });

  test('a late provider correction is counted and applied before pruning', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    // The provider revises one bar before finalization.
    const target = candles[100];
    const corrected = validateCandle(
      { ...target, close: target.close + 0.001, high: target.high + 0.001 },
      { now: () => session.closesAtMs },
    );
    if (corrected.ok === false) throw new Error('correction must be valid');
    await storage.upsertMany([corrected.record]);

    const result = await finalizer(storage, session.closesAtMs + 10 * MINUTE_MS)
      .finalizeSession(session);

    expect(result.lateUpdatesApplied).toBeGreaterThanOrEqual(1);

    const summary = await storage.summaries.get(result.summaryId!);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.correctedCandleCount).toBeGreaterThanOrEqual(1);
  });

  test('canPrune refuses everything before a session has been finalized', async () => {
    const storage = new MemoryCandleRepository();
    const { candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const subject = finalizer(storage, Date.now());
    const verdict = await subject.canPrune('EUR/USD', candles[0].openTimeMs);

    expect(verdict.allowed).toBe(false);
    expect(verdict.finalizedThroughMs).toBeNull();
  });

  test('an empty session is recorded honestly and prunes nothing', async () => {
    const storage = new MemoryCandleRepository();
    const session = resolveSession('EUR/USD', Date.UTC(2026, 0, 15, 15, 0, 0))!;

    const result = await finalizer(storage, session.closesAtMs + 10 * MINUTE_MS)
      .finalizeSession(session);

    expect(result.outcome).toBe('FAILED_NO_DATA');
    expect(result.pruned).toBe(0);

    const summary = await storage.summaries.get(result.summaryId!);
    expect(summary).not.toBeNull();
    if (!summary) return;

    // No example values invented: an empty session says it is empty.
    expect(summary.candleCount).toBe(0);
    expect(summary.completeness).toBe('EMPTY');
    expect(summary.quality).toBe('SUSPECT');
  });

  test('checkpoints rebuild from durable summaries after a restart', async () => {
    const storage = new MemoryCandleRepository();
    const { session, candles } = await seedSession(storage);
    await storage.upsertMany(candles);

    const result = await finalizer(storage, session.closesAtMs + 10 * MINUTE_MS)
      .finalizeSession(session);
    expect(result.outcome).toBe('FINALIZED');

    // A fresh finalizer (as after a cold start) reconstructs the checkpoints
    // with no state of its own.
    const rebooted = finalizer(storage, session.closesAtMs + 20 * MINUTE_MS);
    const checkpoints = await rebooted.rebuildCheckpoints('EUR/USD');

    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0].summaryVerified).toBe(true);
    expect(checkpoints[0].summaryId).toBe(result.summaryId);
  });
});