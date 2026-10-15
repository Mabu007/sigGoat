import { describe, expect, test } from 'bun:test';
import { MemoryCandleRepository } from '../src/services/market-data/candle-core/CandleRepositories';
import { MarketIngestionService } from '../src/services/market-data/MarketIngestionService';
import { MINUTE_MS } from '../src/services/market-data/candle-core/CandleRecord';

describe('market ingestion candle finality', () => {
  test('stores the current minute as forming and only emits the newest closed candle', async () => {
    const now = Date.UTC(2026, 9, 15, 12, 0, 30);
    const storage = new MemoryCandleRepository();
    const bars = [
      { time: now - 90_000, open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 10 },
      { time: now - 30_000, open: 1.15, high: 1.25, low: 1.05, close: 1.2, volume: 12 },
    ];
    const service = new MarketIngestionService({
      storage,
      source: {
        name: 'test-feed',
        getCandles: async () => bars,
      },
      now: () => now,
      log: () => undefined,
    });
    const events: Array<{ candleOpenTimeMs?: number; finalized?: boolean }> = [];
    service.onEvent((event) => events.push(event));

    const result = await service.ingest(['EUR/USD']);
    const stored = await storage.recent('EUR/USD', 10);

    expect(result.failures).toBe(0);
    expect(stored).toHaveLength(2);
    const currentMinute = stored.find((candle) => candle.openTimeMs === Math.floor(now / MINUTE_MS) * MINUTE_MS);
    expect(currentMinute?.finalized).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].candleOpenTimeMs).toBe(Math.floor((now - 90_000) / MINUTE_MS) * MINUTE_MS);
    expect(events[0].finalized).toBe(true);
  });
});
