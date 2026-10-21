import type { Candle } from '../../src/types';

/**
 * DETERMINISTIC CANDLES FOR THE STRATEGY TESTS
 * ============================================
 *
 * The tests need a price series that is reproducible, varied enough to move
 * every indicator and free of any market data dependency. The walk below is
 * a fixed seed linear congruential generator, so every run of the suite sees
 * exactly the same candles.
 */

const MINUTE = 60_000;

export interface CandleOptions {
  count?: number;
  start?: number;
  price?: number;
  /** Deterministic seed. */
  seed?: number;
  /** Volume base. */
  volume?: number;
  /** Make every candle have the same range, for zero-range edge cases. */
  flat?: boolean;
}

export function makeCandles(options: CandleOptions = {}): Candle[] {
  const count = options.count ?? 240;
  const start = options.start ?? Date.UTC(2026, 0, 1);
  let price = options.price ?? 100;
  let seed = options.seed ?? 42;
  const candles: Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const drift = (seed / 4294967296) - 0.48;
    const open = price;
    const close = options.flat ? open : Math.max(1, open * (1 + drift * 0.02));
    const high = options.flat ? open : Math.max(open, close) * (1 + 0.001 + (seed % 97) / 100000);
    const low = options.flat ? open : Math.min(open, close) * (1 - 0.001 - (seed % 89) / 100000);
    candles.push({
      time: start + index * MINUTE,
      open,
      high,
      low,
      close,
      volume: options.flat ? 0 : (options.volume ?? 1000) + (seed % 500),
    });
    price = close;
  }
  return candles;
}

/** A candle with an exact shape, for the price-action tests. */
export function candle(time: number, open: number, high: number, low: number, close: number, volume = 1000): Candle {
  return { time, open, high, low, close, volume };
}
