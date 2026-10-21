import type { Candle } from '../../types';

export const STRATEGY_TIMEFRAME_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
} as const;

export type StrategyTimeframe = keyof typeof STRATEGY_TIMEFRAME_MS;

/**
 * One strict normalization boundary for historical and paper-running candles.
 * Invalid OHLC rows, duplicate timestamps, out-of-order rows and an unfinished
 * final interval are removed before the strategy evaluator can see them.
 */
export function normalizeCompletedCandles(
  input: readonly unknown[],
  timeframe: StrategyTimeframe,
  now = Date.now(),
): Candle[] {
  const intervalMs = STRATEGY_TIMEFRAME_MS[timeframe];
  const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
  const byTime = new Map<number, Candle>();

  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Partial<Record<keyof Candle, unknown>>;
    const candle: Candle = {
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    };
    if (!Object.values(candle).every(Number.isFinite)) continue;
    if (candle.time < 0 || candle.time >= currentIntervalStart) continue;
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) continue;
    if (candle.high < Math.max(candle.open, candle.close, candle.low)) continue;
    if (candle.low > Math.min(candle.open, candle.close, candle.high)) continue;
    byTime.set(candle.time, candle);
  }

  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function requestedBarsForRange(from: number, to: number, timeframe: StrategyTimeframe): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return 0;
  return Math.ceil((to - from) / STRATEGY_TIMEFRAME_MS[timeframe]) + 2;
}
