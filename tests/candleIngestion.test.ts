import { describe, test, expect } from 'bun:test';
import {
  CandleRecord,
  validateCandle,
  candleId,
  floorToMinute,
  canonicalInstrument,
  MINUTE_MS,
} from '../src/services/market-data/candle-core/CandleRecord';
import { MemoryCandleRepository } from '../src/services/market-data/candle-core/CandleRepositories';

/**
 * CANDLE INGESTION AND DATA INTEGRITY
 * ===================================
 * The ingestion boundary is the last place corrupt data can be stopped. If it
 * lets a bad bar through, every downstream indicator, tracker and signal is
 * computed on a lie — and none of them can tell, because they have no way to
 * know what real data looks like for that instrument.
 *
 * The two invariants under test:
 *   1. Nothing invalid is ever stored.
 *   2. Storing the same candle twice stores it ONCE, and a corrected candle
 *      advances a revision instead of creating a second row.
 */

const INSTRUMENT = 'EUR/USD';
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A well-formed bar, so each test can mutate exactly one field. */
function bar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument: INSTRUMENT,
    openTimeMs: NOW - 5 * MINUTE_MS,
    open: 1.085,
    high: 1.0865,
    low: 1.0845,
    close: 1.086,
    volume: 412,
    finalized: true,
    ...overrides,
  };
}

function valid(overrides: Record<string, unknown> = {}): CandleRecord {
  const result = validateCandle(bar(overrides), { now: () => NOW });
  if (result.ok !== true) {
    throw new Error(`expected valid candle, got ${result.reason}`);
  }
  return result.record;
}

describe('candle validation', () => {
  test('accepts a well-formed one-minute candle', () => {
    const result = validateCandle(bar(), { now: () => NOW });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    expect(result.record.instrument).toBe('EUR/USD');
    expect(result.record.openTimeMs).toBe(NOW - 5 * MINUTE_MS);
    expect(result.record.open).toBe(1.085);
    expect(result.record.close).toBe(1.086);
    expect(result.record.finalized).toBe(true);
    expect(result.record.revision).toBe(1);
  });

  test('rejects a non-finite price rather than coercing it to zero', () => {
    const result = validateCandle(bar({ close: NaN }), { now: () => NOW });

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('OHLC_NON_FINITE');
  });

  test('rejects a non-numeric price that would otherwise become 0', () => {
    const result = validateCandle(
      bar({ open: 'not a number' as unknown as number }),
      { now: () => NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('OHLC_NON_FINITE');
  });

  test('rejects a non-positive price', () => {
    const result = validateCandle(bar({ low: 0 }), { now: () => NOW });

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('OHLC_NOT_POSITIVE');
  });

  test('rejects a close outside the high/low range', () => {
    // The classic corrupt bar: close above the high.
    const result = validateCandle(
      bar({ open: 1.085, high: 1.086, low: 1.084, close: 1.09 }),
      { now: () => NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('OHLC_RANGE_INVALID');
  });

  test('rejects a high below the low', () => {
    const result = validateCandle(
      bar({ high: 1.08, low: 1.09, open: 1.085, close: 1.085 }),
      { now: () => NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('OHLC_RANGE_INVALID');
  });

  test('accepts a flat bar — a dead-quote minute is real data', () => {
    // H == L == O == C is legal in a thin market. Rejecting it would fabricate
    // a gap that the provider did not report.
    const result = validateCandle(
      bar({ open: 1.085, high: 1.085, low: 1.085, close: 1.085 }),
      { now: () => NOW },
    );

    expect(result.ok).toBe(true);
  });

  test('normalises an off-grid timestamp onto the minute boundary', () => {
    const messy = NOW - 5 * MINUTE_MS + 37_000;

    const result = validateCandle(bar({ openTimeMs: messy }), { now: () => NOW });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    // Normalised DOWN to the containing minute: this is the candle's OPEN time.
    expect(result.record.openTimeMs).toBe(NOW - 5 * MINUTE_MS);
    expect(result.record.openTimeMs % MINUTE_MS).toBe(0);
  });

  test('rejects an unusable timestamp rather than defaulting it', () => {
    const result = validateCandle(bar({ openTimeMs: 'soon' }), { now: () => NOW });

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('TIMESTAMP_INVALID');
  });

  test('rejects a candle that claims to open in the future', () => {
    const result = validateCandle(
      bar({ openTimeMs: NOW + 10 * MINUTE_MS }),
      { now: () => NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('TIMESTAMP_FUTURE');
  });

  test('rejects an unusable instrument identifier', () => {
    const result = validateCandle(
      bar({ instrument: '../../etc/passwd' }),
      { now: () => NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('INSTRUMENT_INVALID');
  });

  test('canonicalises the instrument to upper case', () => {
    const result = validateCandle(bar({ instrument: ' eur/usd ' }), {
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.record.instrument).toBe('EUR/USD');
  });

  test('omits volume rather than storing a fabricated zero', () => {
    const result = validateCandle(bar({ volume: undefined }), { now: () => NOW });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.record.volume).toBeUndefined();
    expect('volume' in result.record).toBe(false);
  });

  test('distinguishes a forming candle from a finalized one', () => {
    const result = validateCandle(bar({ finalized: false }), { now: () => NOW });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.record.finalized).toBe(false);
  });
});

describe('candle identity', () => {
  test('the id is instrument plus open minute, and nothing else', () => {
    expect(candleId('eur/usd', NOW)).toBe(`EUR/USD#${NOW}`);

    // Two timestamps inside the same minute must produce the SAME id, or a
    // re-delivery with a slightly different timestamp would create a second row
    // for one minute.
    expect(candleId('EUR/USD', NOW + 1)).toBe(candleId('EUR/USD', NOW + 59_999));
  });

  test('floorToMinute is idempotent', () => {
    const once = floorToMinute(NOW + 37_123);
    expect(floorToMinute(once)).toBe(once);
    expect(once % MINUTE_MS).toBe(0);
  });

  test('canonicalInstrument is stable under casing and whitespace', () => {
    expect(canonicalInstrument('  gbp/usd ')).toBe('GBP/USD');
  });
});

describe('idempotent upsert', () => {
  function repo(): MemoryCandleRepository {
    return new MemoryCandleRepository();
  }

  test('stores a candle once', async () => {
    const storage = repo();

    const outcome = await storage.upsertMany([valid()]);

    expect(outcome.inserted).toBe(1);
    expect(await storage.count('EUR/USD')).toBe(1);
  });

  test('duplicate delivery is a no-op, not a second row', async () => {
    const storage = repo();

    await storage.upsertMany([valid()]);
    const outcome = await storage.upsertMany([valid()]);

    expect(outcome.duplicates).toBe(1);
    expect(outcome.inserted).toBe(0);
    expect(outcome.updated).toBe(0);
    expect(await storage.count('EUR/USD')).toBe(1);
  });

  test('ten identical deliveries still leave exactly one row', async () => {
    const storage = repo();

    for (let i = 0; i < 10; i += 1) {
      await storage.upsertMany([valid()]);
    }

    expect(await storage.count('EUR/USD')).toBe(1);
  });

  test('a corrected candle advances the revision instead of duplicating', async () => {
    const storage = repo();

    await storage.upsertMany([valid()]);

    // A late provider correction: same minute, different close.
    const corrected = valid({ close: 1.0875, high: 1.0875 });
    const outcome = await storage.upsertMany([corrected]);

    expect(outcome.updated).toBe(1);
    expect(outcome.revisions).toHaveLength(1);
    expect(await storage.count('EUR/USD')).toBe(1);

    const stored = await storage.latestAtOrBefore('EUR/USD');
    expect(stored?.close).toBe(1.0875);
    expect(stored?.revision).toBe(2);
  });

  test('promoting a forming candle to final does NOT bump the revision', () => {
    // A close flag advancing is not a value correction. Counting it as one
    // would make every redelivery look like a change and observers would never
    // see a quiet market.
    const storage = new MemoryCandleRepository();
    return (async () => {
      await storage.upsertMany([valid({ finalized: false })]);
      const outcome = await storage.upsertMany([valid({ finalized: true })]);

      expect(outcome.duplicates).toBe(1);
      expect(outcome.revisions).toHaveLength(0);

      const stored = await storage.latestAtOrBefore('EUR/USD');
      expect(stored?.finalized).toBe(true);
      expect(stored?.revision).toBe(1);
    })();
  });

  test('out-of-order arrival is stored in the right position', async () => {
    const storage = repo();

    // Deliberately newest-first, which is what the provider actually sends.
    await storage.upsertMany([
      valid({ openTimeMs: NOW - 2 * MINUTE_MS }),
      valid({ openTimeMs: NOW - 1 * MINUTE_MS }),
      valid({ openTimeMs: NOW - 3 * MINUTE_MS }),
    ]);

    const rows = await storage.range('EUR/USD', 0, NOW + MINUTE_MS);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.openTimeMs)).toEqual([
      NOW - 3 * MINUTE_MS,
      NOW - 2 * MINUTE_MS,
      NOW - 1 * MINUTE_MS,
    ]);
  });

  test('a missing minute stays missing — nothing is interpolated', async () => {
    const storage = repo();

    await storage.upsertMany([
      valid({ openTimeMs: NOW - 5 * MINUTE_MS }),
      // NOTE: NOW - 4 and NOW - 3 are simply absent.
      valid({ openTimeMs: NOW - 2 * MINUTE_MS }),
    ]);

    const rows = await storage.range('EUR/USD', 0, NOW);

    expect(rows.map((r) => r.openTimeMs)).toEqual([
      NOW - 5 * MINUTE_MS,
      NOW - 2 * MINUTE_MS,
    ]);
  });

  test('a rejected bar never reaches storage', async () => {
    const storage = repo();

    const bad = validateCandle(bar({ close: -1 }), { now: () => NOW });
    expect(bad.ok).toBe(false);

    await storage.upsertMany([valid()]);

    expect(await storage.count('EUR/USD')).toBe(1);
  });

  test('a total storage failure propagates rather than looking like success', async () => {
    const storage = repo();
    storage.failNextWrite = 'disk unavailable';

    // The caller MUST see the throw so it skips pruning.
    await expect(storage.upsertMany([valid()])).rejects.toThrow('disk unavailable');
  });

  test('candles are scoped per instrument', async () => {
    const storage = repo();

    await storage.upsertMany([valid(), valid({ instrument: 'GBP/USD' })]);

    expect(await storage.count('EUR/USD')).toBe(1);
    expect(await storage.count('GBP/USD')).toBe(1);
  });

  test('recent returns ascending, bounded to the requested count', async () => {
    const storage = repo();

    for (let i = 0; i < 20; i += 1) {
      await storage.upsertMany([valid({ openTimeMs: NOW - (20 - i) * MINUTE_MS })]);
    }

    const rows = await storage.recent('EUR/USD', 5);

    expect(rows).toHaveLength(5);
    expect(rows[0].openTimeMs).toBeLessThan(rows[4].openTimeMs);
    // The five most RECENT, ending at the newest.
    expect(rows[4].openTimeMs).toBe(NOW - MINUTE_MS);
  });

  test('range is half-open and bounded', async () => {
    const storage = repo();

    for (let i = 0; i < 10; i += 1) {
      await storage.upsertMany([valid({ openTimeMs: NOW - (10 - i) * MINUTE_MS })]);
    }

    const rows = await storage.range(
      'EUR/USD',
      NOW - 5 * MINUTE_MS,
      NOW,
      100,
    );

    // from is inclusive, to is exclusive.
    expect(rows.map((r) => r.openTimeMs)).toEqual([
      NOW - 5 * MINUTE_MS,
      NOW - 4 * MINUTE_MS,
      NOW - 3 * MINUTE_MS,
      NOW - 2 * MINUTE_MS,
      NOW - MINUTE_MS,
    ]);
  });

  test('deleteBefore respects its batch limit', async () => {
    const storage = repo();

    for (let i = 0; i < 50; i += 1) {
      await storage.upsertMany([valid({ openTimeMs: NOW - (50 - i) * MINUTE_MS })]);
    }

    const deleted = await storage.deleteBefore('EUR/USD', NOW, 20);

    expect(deleted).toBe(20);
    expect(await storage.count('EUR/USD')).toBe(30);
  });
});