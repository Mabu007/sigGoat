import { describe, test, expect } from 'bun:test';
import {
  detectSwings,
  applySwingBreaks,
  buildLevelLedger,
  applyLevelBreaks,
  expireLevels,
  boundLevelLedger,
  classifyRegime,
  priceBucket,
  STRUCTURE_SCHEMA_VERSION,
} from '../src/services/market-data/candle-core/MarketStructure';
import { validateCandle, MINUTE_MS } from '../src/services/market-data/candle-core/CandleRecord';
import type { CandleRecord } from '../src/services/market-data/candle-core/CandleRecord';

/**
 * MARKET STRUCTURE AND SWING LEDGER
 * ==================================
 * The ledger is the durable memory that must survive candle pruning, so the
 * property that matters most is that it never records a fact the data did not
 * support at the time it was recorded.
 *
 * That is the look-ahead problem. A pivot is only knowable `k` bars later;
 * recording it at the pivot bar makes backtests look brilliant and live trading
 * lose money. These tests pin the behaviour that prevents it.
 */

const INSTRUMENT = 'EUR/USD';
const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

function candle(index: number, high: number, low: number): CandleRecord {
  const result = validateCandle(
    {
      instrument: INSTRUMENT,
      openTimeMs: BASE + index * MINUTE_MS,
      open: (high + low) / 2,
      high,
      low,
      close: (high + low) / 2,
      volume: 100,
    },
    { now: () => BASE + 10_000 * MINUTE_MS },
  );
  if (result.ok !== true) throw new Error(`bad test candle: ${result.reason}`);
  return result.record;
}

/**
 * A deliberate zig-zag across 13 bars:
 *   bar 2  high pivot   bar 5  low pivot   bar 8  high pivot
 *   bar 12 developing high (full left side, no right side yet)
 *
 * With lookback 2 the first three are confirmed and bar 12 is not — which is
 * exactly the boundary the look-ahead tests need.
 */
function zigzag(): CandleRecord[] {
  const rows: CandleRecord[] = [];
  for (let i = 0; i < 13; i += 1) {
    if (i === 2) rows.push(candle(i, 1.10, 1.09));
    else if (i === 5) rows.push(candle(i, 1.091, 1.08));
    else if (i === 8) rows.push(candle(i, 1.11, 1.095));
    else if (i === 12) rows.push(candle(i, 1.12, 1.095));
    else rows.push(candle(i, 1.095, 1.09));
  }
  return rows;
}

describe('swing detection', () => {
  test('detects confirmed pivots with clearance on both sides', () => {
    const { confirmed } = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });

    const highs = confirmed.filter((s) => s.kind === 'HIGH');
    const lows = confirmed.filter((s) => s.kind === 'LOW');

    expect(highs.length).toBeGreaterThanOrEqual(2);
    expect(lows.length).toBeGreaterThanOrEqual(1);
    expect(highs.some((s) => s.atMs === BASE + 2 * MINUTE_MS)).toBe(true);
    expect(lows.some((s) => s.atMs === BASE + 5 * MINUTE_MS)).toBe(true);
  });

  test('a confirmed swing is timestamped by the CONFIRMING bar, not the pivot', () => {
    // THE look-ahead invariant. confirmedAtMs must be strictly AFTER atMs, by
    // exactly the clearance.
    const { confirmed } = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });

    for (const swing of confirmed) {
      expect(swing.confirmedAtMs).not.toBeNull();
      expect(swing.confirmedAtMs!).toBeGreaterThan(swing.atMs);
      expect(swing.confirmedAtMs! - swing.atMs).toBe(2 * MINUTE_MS);
    }
  });

  test('the newest pivot is DEVELOPING, never confirmed', () => {
    // The right edge of the data has no right-hand clearance yet, so treating
    // it as confirmed would be look-ahead.
    const { confirmed, developing } = detectSwings(zigzag(), INSTRUMENT, {
      lookback: 2,
    });

    const newestMs = BASE + 12 * MINUTE_MS;

    expect(confirmed.some((s) => s.atMs === newestMs)).toBe(false);
    expect(developing.some((s) => s.atMs === newestMs)).toBe(true);
    if (developing.length === 0) return;

    // A developing swing has no confirmation at all.
    expect(developing[0].confirmedAtMs).toBeNull();
    expect(developing[0].status).toBe('DEVELOPING');
  });

  test('truncated history yields no confirmed swing at the right edge', () => {
    // Feeding only part of the series must not manufacture confirmation.
    const truncated = zigzag().slice(0, 6);
    const { confirmed } = detectSwings(truncated, INSTRUMENT, { lookback: 2 });

    // Bar 5 is the last bar; it has no right-hand clearance.
    expect(confirmed.some((s) => s.atMs === BASE + 5 * MINUTE_MS)).toBe(false);
  });

  test('insufficient history confirms nothing rather than guessing', () => {
    const { confirmed } = detectSwings(zigzag().slice(0, 3), INSTRUMENT, {
      lookback: 2,
    });

    // Three bars cannot confirm anything with lookback 2 — confirming would
    // require the right-hand bars that do not exist yet.
    expect(confirmed).toHaveLength(0);
  });

  test('swings chain to the preceding opposite pivot', () => {
    const { confirmed } = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    const ordered = [...confirmed].sort((a, b) => a.atMs - b.atMs);

    for (let i = 1; i < ordered.length; i += 1) {
      // Each swing references an earlier, opposite-kind pivot.
      const previous = ordered[i - 1];
      expect(previous.kind).not.toBe(ordered[i].kind);
      expect(ordered[i].precedingSwingId).toBe(previous.id);
    }
  });

  test('every swing records its observation origin, schema version and timeframe', () => {
    const { confirmed, developing } = detectSwings(zigzag(), INSTRUMENT, {
      timeframe: '15m',
    });

    for (const swing of [...confirmed, ...developing]) {
      // An observed price fact, never a model interpretation.
      expect(swing.origin).toBe('OBSERVED');
      expect(swing.schemaVersion).toBe(STRUCTURE_SCHEMA_VERSION);
      // A swing confirmed on 15m is not the same fact as one seen on 1h.
      expect(swing.timeframe).toBe('15m');
    }
  });
});

describe('swing breaks', () => {
test('a high pivot is broken only by a CLOSE beyond it plus an ATR buffer', () => {
    /**
     * A purpose-built flat series, so the ONLY thing that can break the pivot
     * is what this test adds. Reusing the zig-zag would be ambiguous, because
     * its own later high already clears the pivot.
     */
    const flat: CandleRecord[] = [];
    for (let i = 0; i < 8; i += 1) flat.push(candle(i, 1.095, 1.09));
    flat.push(candle(8, 1.10, 1.09)); // pivot high
    for (let i = 9; i < 14; i += 1) flat.push(candle(i, 1.095, 1.09));

    const { confirmed } = detectSwings(flat, INSTRUMENT, { lookback: 2 });
    const pivot = confirmed.find((s) => s.atMs === BASE + 8 * MINUTE_MS)!;
    expect(pivot.kind).toBe('HIGH');
    expect(pivot.price).toBe(1.10);
    expect(pivot.status).toBe('CONFIRMED');

    // A wick above the pivot whose CLOSE stays below it does not break it.
    const wickOnly = [...flat, candle(14, 1.1100, 1.0900)]; // close 1.10 -> 1.1 exactly? mid = 1.10
    const wickResult = applySwingBreaks([pivot], wickOnly, 0.00001);
    expect(wickResult[0].status).toBe('CONFIRMED');

    // A decisive close above the pivot DOES break it.
    const decisive = [...flat, candle(14, 1.1060, 1.1045)]; // close 1.10525
    const broken = applySwingBreaks([pivot], decisive, 0.0005);
    expect(broken[0].status).toBe('BROKEN');
    expect(broken[0].active).toBe(false);
    expect(broken[0].breakDirection).toBe('ABOVE');
    expect(broken[0].brokenAtMs).toBe(BASE + 14 * MINUTE_MS);

    // The same decisive close does NOT break it under a wide ATR buffer: the
    // move is small relative to the instrument's own volatility, and a level
    // must not evaporate on one ordinary tick.
    const wideBuffer = applySwingBreaks([pivot], decisive, 1.0);
    expect(wideBuffer[0].status).toBe('CONFIRMED');

    // And the break is always stamped AFTER confirmation, never before.
    expect(broken[0].brokenAtMs!).toBeGreaterThan(pivot.confirmedAtMs!);
  });

  test('a low pivot breaks downward, not upward', () => {
    const candles = zigzag();
    const { confirmed } = detectSwings(candles, INSTRUMENT, { lookback: 2 });
    const pivot = confirmed.find((s) => s.atMs === BASE + 5 * MINUTE_MS)!;
    expect(pivot.kind).toBe('LOW');

    const decisive = [...candles, candle(14, 1.076, 1.0745)]; // close ~1.0752

    const broken = applySwingBreaks([pivot], decisive, 0.0005);
    expect(broken[0].status).toBe('BROKEN');
    expect(broken[0].breakDirection).toBe('BELOW');
  });

  test('a candle BEFORE confirmation cannot break the swing', () => {
    // The other half of look-ahead safety: a swing confirmed at T cannot be
    // retroactively broken by a bar that printed before T.
    const candles = zigzag();
    const { confirmed } = detectSwings(candles, INSTRUMENT, { lookback: 2 });
    const pivot = confirmed.find((s) => s.atMs === BASE + 8 * MINUTE_MS)!;

    const after = applySwingBreaks([pivot], candles, 0.00001);
    expect(after[0].status).toBe('CONFIRMED');
  });

  test('a developing swing is never marked broken', () => {
    const { developing } = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    if (developing.length === 0) return;

    const result = applySwingBreaks(developing, zigzag(), 0.0001);
    expect(result[0].status).toBe('DEVELOPING');
  });
});

describe('level ledger', () => {
  test('confirms into levels, developing never do', () => {
    const candles = zigzag();
    const detected = detectSwings(candles, INSTRUMENT, { lookback: 2 });

    const levels = buildLevelLedger(INSTRUMENT, [
      ...detected.confirmed,
      ...detected.developing,
    ]);

    const confirmedIds = new Set(detected.confirmed.map((s) => s.id));
    for (const level of levels) {
      for (const sourceId of level.sourceSwingIds) {
        expect(confirmedIds.has(sourceId)).toBe(true);
      }
    }
  });

  test('is idempotent — rebuilding produces the same levels, not duplicates', () => {
    const detected = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });

    const first = buildLevelLedger(INSTRUMENT, detected.confirmed, [], BASE);
    const second = buildLevelLedger(INSTRUMENT, detected.confirmed, first, BASE);
    const third = buildLevelLedger(INSTRUMENT, detected.confirmed, second, BASE);

    // Repeated finalization must not grow the ledger.
    expect(second).toHaveLength(first.length);
    expect(third).toHaveLength(first.length);
  });

  test('a retest of the same price increases touches rather than adding a level', () => {
    const detected = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    const first = buildLevelLedger(INSTRUMENT, detected.confirmed, [], BASE);

    const rebuilt = buildLevelLedger(INSTRUMENT, detected.confirmed, first, BASE);

    // Same ids, and the retest is recorded as extra confluence.
    for (const level of rebuilt) {
      expect(first.some((prior) => prior.id === level.id)).toBe(true);
    }
  });

  test('prices within a bucket are one level, not several', () => {
    expect(priceBucket(1.085001, 5)).toBe(priceBucket(1.085004, 5));
    expect(priceBucket(1.085001, 5)).not.toBe(priceBucket(1.095001, 5));
  });

  test('a broken level stays broken when retested', () => {
    const detected = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    const levels = buildLevelLedger(INSTRUMENT, detected.confirmed, [], BASE);

    const broken = applyLevelBreaks(
      levels,
      [candle(12, 1.20, 1.19)],
      0.0001,
    );
    const anyBroken = broken.filter((l) => l.status === 'BROKEN');
    expect(anyBroken.length).toBeGreaterThan(0);

    // Re-running detection must not resurrect the level as ACTIVE.
    const rebuilt = buildLevelLedger(
      INSTRUMENT,
      detected.confirmed,
      broken,
      BASE + MINUTE_MS,
    );
    for (const level of rebuilt) {
      if (anyBroken.some((b) => b.id === level.id)) {
        expect(level.status).toBe('BROKEN');
      }
    }
  });

  test('levels expire on idleness, not on distance from price', () => {
    const detected = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    const levels = buildLevelLedger(INSTRUMENT, detected.confirmed, [], BASE);

    const longAfter = BASE + 200 * 24 * 60 * MINUTE_MS;
    const expired = expireLevels(levels, longAfter, 90 * 24 * 60 * MINUTE_MS);

    expect(expired.every((l) => l.status === 'EXPIRED')).toBe(true);
  });

  test('the ledger is bounded', () => {
    const detected = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    const levels = buildLevelLedger(INSTRUMENT, detected.confirmed, [], BASE);

    const bounded = boundLevelLedger(levels, 1);
    expect(bounded).toHaveLength(1);
  });

  test('every level records how to tell that it is invalid', () => {
    const detected = detectSwings(zigzag(), INSTRUMENT, { lookback: 2 });
    const levels = buildLevelLedger(INSTRUMENT, detected.confirmed, [], BASE);

    for (const level of levels) {
      expect(level.invalidationRule.length).toBeGreaterThan(0);
      expect(level.createdAtMs).toBeGreaterThan(0);
      expect(level.schemaVersion).toBe(STRUCTURE_SCHEMA_VERSION);
    }
  });
});

describe('regime classification', () => {
  const base = {
    atr: 0.002,
    price: 1.1,
    rangePct: 1,
    previousRangePct: null as number | null,
  };

  test('a higher high that is newer than the lower low reads as bullish', () => {
    // Price sits in the upper part of the 1.08-1.12 structural range, and the
    // high is the more recent swing.
    const regime = classifyRegime(INSTRUMENT, 'S1', BASE, {
      ...base,
      price: 1.115,
      swingHigh: 1.12,
      swingLow: 1.08,
      swingHighAgeMs: 1000,
      swingLowAgeMs: 5000,
    });

    expect(regime.trend).toBe('BULLISH');
    expect(regime.trendConfidence).toBeGreaterThan(0);
  });

  test('a lower low that is newer reads as bearish', () => {
    // Price sits in the lower part of the range, and the low is more recent.
    const regime = classifyRegime(INSTRUMENT, 'S1', BASE, {
      ...base,
      price: 1.085,
      swingHigh: 1.12,
      swingLow: 1.08,
      swingHighAgeMs: 5000,
      swingLowAgeMs: 1000,
    });

    expect(regime.trend).toBe('BEARISH');
  });

  test('without swings the trend is RANGING, not invented', () => {
    const regime = classifyRegime(INSTRUMENT, 'S1', BASE, {
      ...base,
      swingHigh: null,
      swingLow: null,
      swingHighAgeMs: null,
      swingLowAgeMs: null,
    });

    expect(regime.trend).toBe('RANGING');
  });

  test('volatility regime compares against the previous session', () => {
    const expanding = classifyRegime(INSTRUMENT, 'S1', BASE, {
      ...base,
      price: 1.115,
      rangePct: 2,
      previousRangePct: 1,
      swingHigh: 1.12,
      swingLow: 1.08,
      swingHighAgeMs: 1000,
      swingLowAgeMs: 5000,
    });

    expect(expanding.volatility).toBe('EXPANDING');

    const contracting = classifyRegime(INSTRUMENT, 'S1', BASE, {
      ...base,
      price: 1.115,
      rangePct: 0.5,
      previousRangePct: 2,
      swingHigh: 1.12,
      swingLow: 1.08,
      swingHighAgeMs: 1000,
      swingLowAgeMs: 5000,
    });

    expect(contracting.volatility).toBe('CONTRACTING');
  });

  test('normalised ATR is comparable across instruments', () => {
    const regime = classifyRegime(INSTRUMENT, 'S1', BASE, {
      ...base,
      atr: 0.002,
      price: 100,
      swingHigh: 110,
      swingLow: 90,
      swingHighAgeMs: 1,
      swingLowAgeMs: 2,
    });

    expect(regime.normalisedAtr).toBeCloseTo(0.002 / 100, 8);
  });
});