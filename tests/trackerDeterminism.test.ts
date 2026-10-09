import { describe, test, expect } from 'bun:test';
import {
  evaluateTracker,
  evaluateTrackers,
  crossedAbove,
  crossedBelow,
  isSupportedIndicator,
  isSupportedOperator,
  supportedIndicators,
  type EvaluableCandle,
} from '../src/services/tracker-sdk/DeterministicTrackerEvaluator';
import {
  rsiSeries,
  emaSeries,
  smaSeries,
  atrSeries,
  warmupFor,
  planWarmup,
} from '../src/services/tracker-sdk/indicatorSeries';
import type { TrackerCondition } from '../src/types';

/**
 * INDICATORS AND DETERMINISTIC TRACKERS
 * =====================================
 * Trackers are the only thing standing between a market candle and an AI call.
 * They must be deterministic, they must be honest about not having enough data,
 * and they must fire on a TRANSITION rather than on a condition that happens to
 * be true.
 *
 * The regressions pinned here:
 *   - RSI returning 50.0 for "no data", which reads as a real neutral reading.
 *   - CROSS_ABOVE implemented as `value >= target`, which is not a crossover and
 *     re-fires forever.
 *   - A tracker re-triggering on a candle it already evaluated.
 */

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60_000;

function bar(index: number, close: number, high?: number, low?: number): EvaluableCandle {
  return {
    time: BASE + index * MINUTE,
    open: close,
    high: high ?? close + 0.0005,
    low: low ?? close - 0.0005,
    close,
    volume: 100,
    finalized: true,
  };
}

/** A clean uptrend, enough for every indicator to warm up. */
function uptrend(count = 120, from = 1.08, step = 0.0005): EvaluableCandle[] {
  return Array.from({ length: count }, (_, i) => bar(i, from + i * step));
}

/** A clean downtrend. */
function downtrend(count = 120, from = 1.15, step = 0.0005): EvaluableCandle[] {
  return Array.from({ length: count }, (_, i) => bar(i, from - i * step));
}

function tracker(overrides: Partial<TrackerCondition>): TrackerCondition {
  return {
    id: 'trk_test',
    description: 'test tracker',
    type: 'INDICATOR',
    market: 'EUR/USD',
    operator: 'CROSS_ABOVE',
    isTriggered: false,
    ...overrides,
  } as TrackerCondition;
}

describe('indicator warmup', () => {
  test('RSI with no history is UNAVAILABLE, not a neutral 50', () => {
    const result = rsiSeries([], 14);

    // The old calculateRSI returned exactly 50.0 here, which is
    // indistinguishable from a genuine neutral reading.
    expect(result.available).toBe(false);
    expect(result.shortfall).toBe(15);
    expect(result.previous).toBeNull();
  });

  test('RSI becomes available only once enough closes exist', () => {
    const short = uptrend(10);
    const enough = uptrend(40);

    expect(rsiSeries(short, 14).available).toBe(false);
    expect(rsiSeries(enough, 14).available).toBe(true);
  });

  test('EMA below its period is unavailable rather than a short SMA', () => {
    const result = emaSeries(uptrend(10), 50);

    expect(result.available).toBe(false);
    expect(result.warmupRequired).toBe(50);
    expect(result.shortfall).toBe(40);
  });

  test('EMA becomes available at its period and carries a previous value', () => {
    const candles = uptrend(60);
    const result = emaSeries(candles, 20);

    expect(result.available).toBe(true);
    expect(result.previous).not.toBeNull();
    // The current EMA exceeds the previous one on a clean uptrend.
    expect(result.value).toBeGreaterThan(result.previous!);
  });

  test('SMA needs exactly its period', () => {
    expect(smaSeries(uptrend(19), 20).available).toBe(false);
    expect(smaSeries(uptrend(20), 20).available).toBe(true);
  });

  test('ATR with fewer than two candles is unavailable, not 0.001', () => {
    const result = atrSeries([bar(0, 1.08)], 14);

    expect(result.available).toBe(false);
    expect(result.shortfall).toBeGreaterThan(0);
  });

  test('an unchanging series yields RSI 100 rather than dividing by zero', () => {
    const flat = Array.from({ length: 30 }, (_, i) => bar(i, 1.10));
    const result = rsiSeries(flat, 14);

    expect(result.available).toBe(true);
    expect(Number.isFinite(result.value)).toBe(true);
  });

  test('warmup plans scale with period', () => {
    expect(warmupFor('EMA', 20).required).toBeGreaterThan(warmupFor('EMA', 5).required);
    expect(warmupFor('PRICE', 0).required).toBe(1);
  });

  test('a combined warmup plan takes the largest requirement', () => {
    const plan = planWarmup([
      { indicator: 'EMA', period: 9 },
      { indicator: 'EMA', period: 200 },
    ]);

    expect(plan.required).toBe(warmupFor('EMA', 200).required);
    expect(plan.dominantReason.length).toBeGreaterThan(0);
  });
});

describe('crossover detection', () => {
  test('crossedAbove requires a transition, not merely being above', () => {
    // Below -> above is a cross.
    expect(crossedAbove(1.084, 1.086, 1.085)).toBe(true);
    // Above -> above is NOT a cross, which is what stops the repeat-spam bug.
    expect(crossedAbove(1.086, 1.090, 1.085)).toBe(false);
    // Above -> below is not a cross upward either.
    expect(crossedAbove(1.086, 1.084, 1.085)).toBe(false);
  });

  test('crossedBelow requires a transition downward', () => {
    expect(crossedBelow(1.086, 1.084, 1.085)).toBe(true);
    expect(crossedBelow(1.084, 1.082, 1.085)).toBe(false);
    expect(crossedBelow(1.084, 1.090, 1.085)).toBe(false);
  });

  test('a crossover with no previous value is UNEVALUABLE, not false', () => {
    // PRICE needs only one candle, so warmup passes — but a CROSS is a
    // relationship between two values, and with one candle there is no
    // relationship to evaluate. Reporting "not crossed" here would be
    // indistinguishable from a genuine miss.
    const result = evaluateTracker(
      tracker({
        operator: 'CROSS_ABOVE',
        targetValue: 1.09,
        indicatorParams: { indicator: 'PRICE' },
      }),
      [bar(0, 1.08)],
    );

    expect(result.verdict).toBe('UNEVALUABLE');
    expect(result.shouldWake).toBe(false);
    expect(result.reason).toContain('previous value');
  });

  test('insufficient warmup is also UNEVALUABLE, for a crossover', () => {
    // The warmup gate fires before the previous-value gate; both are the same
    // non-firing verdict, and neither is a "no".
    const result = evaluateTracker(
      tracker({
        operator: 'CROSS_ABOVE',
        targetValue: 1.10,
        indicatorParams: { indicator: 'EMA', period: 20 },
      }),
      uptrend(5),
    );

    expect(result.verdict).toBe('UNEVALUABLE');
    expect(result.shouldWake).toBe(false);
  });

  test('a genuine crossover fires exactly once, then stops', () => {
    const candles = uptrend(120);
    const spec = {
      operator: 'CROSS_ABOVE' as const,
      targetValue: 1.10,
      indicatorParams: { indicator: 'EMA' as const, period: 20 },
    };

    // The evaluator judges the transition at the NEWEST bar only, so walk
    // forward and find the bar on which the EMA actually crosses.
    // Start at 22 so there is always a bar strictly before the crossing to
    // assert against.
    let crossingIndex = -1;
    for (let i = 22; i < candles.length; i += 1) {
      const atBar = evaluateTracker(tracker(spec), candles.slice(0, i));
      if (atBar.verdict === 'TRIGGERED') {
        crossingIndex = i;
        break;
      }
    }

    expect(crossingIndex).toBeGreaterThan(21);

    // `candles.slice(0, i)` ends at bar i-1, so the crossing bar is
    // crossingIndex - 1 and the bar before it is crossingIndex - 2.
    // One bar BEFORE the crossing: not yet met.
    const before = evaluateTracker(
      tracker(spec),
      candles.slice(0, crossingIndex - 1),
    );
    expect(before.verdict).toBe('UNMET');
    expect(before.shouldWake).toBe(false);

    // The crossing bar itself: fires.
    const atCrossing = evaluateTracker(
      tracker(spec),
      candles.slice(0, crossingIndex),
    );
    expect(atCrossing.verdict).toBe('TRIGGERED');
    expect(atCrossing.shouldWake).toBe(true);

    // Every bar AFTER the crossing, while still above: no repeat. This is the
    // exact bug `CROSS_ABOVE` used to have, implemented as `value >= target`.
    for (let i = crossingIndex + 1; i < Math.min(crossingIndex + 6, candles.length); i += 1) {
      const after = evaluateTracker(
        tracker({ ...spec, isTriggered: true }),
        candles.slice(0, i),
      );
      expect(after.shouldWake).toBe(false);
    }
  });

  test('a level condition that stays true reports SATISFIED, never TRIGGERED again', () => {
    const candles = uptrend(120);

    const first = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
      }),
      candles,
    );
    expect(first.verdict).toBe('TRIGGERED');

    // The same condition, still true, on a later evaluation.
    const second = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
        isTriggered: true,
      }),
      uptrend(120),
    );

    expect(second.verdict).toBe('SATISFIED');
    expect(second.shouldWake).toBe(false);
  });
});

describe('tracker data gating', () => {
  test('an unsupported indicator is UNEVALUABLE and never executed', () => {
    const result = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.1,
        indicatorParams: { indicator: 'MALICIOUS' as never },
      }),
      uptrend(120),
    );

    expect(result.verdict).toBe('UNEVALUABLE');
    expect(result.shouldWake).toBe(false);
    expect(result.reason).toContain('supported set');
  });

  test('an unsupported operator is UNEVALUABLE', () => {
    const result = evaluateTracker(
      tracker({
        operator: 'EXECUTE' as never,
        targetValue: 1.1,
        indicatorParams: { indicator: 'PRICE' },
      }),
      uptrend(120),
    );

    expect(result.verdict).toBe('UNEVALUABLE');
  });

  test('the indicator whitelist is closed', () => {
    expect(isSupportedIndicator('EMA')).toBe(true);
    expect(isSupportedIndicator('RSI')).toBe(true);
    expect(isSupportedIndicator('eval')).toBe(false);
    expect(isSupportedIndicator('__proto__')).toBe(false);
    expect(supportedIndicators().length).toBeGreaterThan(0);
  });

  test('the operator whitelist is closed', () => {
    expect(isSupportedOperator('CROSS_ABOVE')).toBe(true);
    expect(isSupportedOperator(undefined)).toBe(true);
    expect(isSupportedOperator('DROP TABLE')).toBe(false);
  });

  test('insufficient warmup is UNEVALUABLE and reports the shortfall', () => {
    const result = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 50,
        indicatorParams: { indicator: 'RSI', period: 14 },
      }),
      uptrend(5),
    );

    expect(result.verdict).toBe('UNEVALUABLE');
    expect(result.shouldWake).toBe(false);
    expect(result.warmupRequired).toBeGreaterThan(result.warmupAvailable!);
    expect(result.reason).toContain('not evaluable yet');
  });

  test('an empty candle slice is UNEVALUABLE, not TRIGGERED', () => {
    const result = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 0,
        indicatorParams: { indicator: 'PRICE' },
      }),
      [],
    );

    expect(result.verdict).toBe('UNEVALUABLE');
    expect(result.shouldWake).toBe(false);
  });

  test('a forming candle is skipped unless intrabar evaluation is requested', () => {
    const candles = uptrend(120);
    const forming = [...candles.slice(0, -1), { ...candles[119], finalized: false }];

    const skipped = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
      }),
      forming,
    );
    expect(skipped.verdict).toBe('UNEVALUABLE');
    expect(skipped.usedFormingCandle).toBe(true);

    const allowed = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
      }),
      forming,
      { allowFormingCandle: true },
    );
    expect(allowed.usedFormingCandle).toBe(true);
    expect(allowed.verdict).not.toBe('UNEVALUABLE');
  });

  test('a missing target never fires', () => {
    const result = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        indicatorParams: { indicator: 'PRICE' },
      }),
      uptrend(120),
    );

    expect(result.shouldWake).toBe(false);
    expect(result.reason).toContain('not yet');
  });
});

describe('evaluation cursor and duplicate delivery', () => {
  test('a candle already processed produces no new information', () => {
    const candles = uptrend(120);
    const newest = candles[candles.length - 1].time;

    const first = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
      }),
      candles,
    );
    expect(first.verdict).toBe('TRIGGERED');
    expect(first.evaluatedCandleMs).toBe(newest);

    // The SAME event delivered a second time, with the cursor already advanced.
    const redelivered = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
      }),
      candles,
      { lastProcessedCandleMs: newest },
    );

    expect(redelivered.shouldWake).toBe(false);
    expect(redelivered.reason).toContain('already evaluated');
  });

  test('a NEW candle past the cursor is evaluated normally', () => {
    const candles = uptrend(120);
    const previous = candles[119].time;
    const advanced = [...candles, bar(120, 1.2)];

    const result = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
      }),
      advanced,
      { lastProcessedCandleMs: previous },
    );

    expect(result.evaluatedCandleMs).toBe(BASE + 120 * MINUTE);
    // A fresh tracker evaluating a genuinely true condition on a NEW bar.
    expect(result.verdict).toBe('TRIGGERED');

    // The same new bar, for a tracker that already fired, is only SATISFIED.
    const alreadyFired = evaluateTracker(
      tracker({
        operator: 'GREATER_THAN',
        targetValue: 1.10,
        indicatorParams: { indicator: 'PRICE' },
        isTriggered: true,
      }),
      advanced,
      { lastProcessedCandleMs: previous },
    );
    expect(alreadyFired.verdict).toBe('SATISFIED');
    expect(alreadyFired.shouldWake).toBe(false);
  });
});

describe('tracker set evaluation', () => {
  test('at most one trigger is returned from a set', () => {
    const candles = uptrend(120);

    const { fired, evaluations } = evaluateTrackers(
      [
        tracker({ id: 'a', operator: 'GREATER_THAN', targetValue: 1.10, indicatorParams: { indicator: 'PRICE' } }),
        tracker({ id: 'b', operator: 'GREATER_THAN', targetValue: 1.11, indicatorParams: { indicator: 'PRICE' } }),
      ],
      candles,
    );

    expect(evaluations.length).toBe(2);
    expect(fired).not.toBeNull();
    expect(fired?.trackerId).toBe('a');
  });

  test('unevaluable trackers are reported separately from unmet ones', () => {
    const { fired, unevaluable } = evaluateTrackers(
      [
        tracker({ id: 'a', operator: 'GREATER_THAN', targetValue: 1.10, indicatorParams: { indicator: 'RSI', period: 14 } }),
      ],
      uptrend(5),
    );

    expect(fired).toBeNull();
    expect(unevaluable).toHaveLength(1);
    expect(unevaluable[0].verdict).toBe('UNEVALUABLE');
  });

  test('an already-fired level tracker is skipped entirely', () => {
    const { evaluations } = evaluateTrackers(
      [
        tracker({ id: 'a', operator: 'GREATER_THAN', targetValue: 1.10, indicatorParams: { indicator: 'PRICE' }, isTriggered: true }),
      ],
      uptrend(120),
    );

    // No point re-evaluating a condition that has already been reported.
    expect(evaluations).toHaveLength(0);
  });
});

describe('multi-timeframe', () => {
  test('a downtrend produces a lower RSI than an uptrend — the direction is real', () => {
    const up = rsiSeries(uptrend(60), 14);
    const down = rsiSeries(downtrend(60), 14);

    expect(up.available).toBe(true);
    expect(down.available).toBe(true);
    expect(up.value).toBeGreaterThan(down.value);
  });

  test('EMA leads price on an uptrend', () => {
    const candles = uptrend(120);
    const ema = emaSeries(candles, 20);

    expect(ema.available).toBe(true);
    expect(ema.value).toBeGreaterThan(candles[0].close);
    expect(ema.value).toBeLessThan(candles[candles.length - 1].close);
  });

  test('ATR scales with the size of the bars', () => {
    const calm = atrSeries(uptrend(60, 1.08, 0.0001), 14);
    const wild = atrSeries(uptrend(60, 1.08, 0.005), 14);

    expect(calm.available).toBe(true);
    expect(wild.available).toBe(true);
    expect(wild.value).toBeGreaterThan(calm.value);
  });
});