/**
 * INDICATOR SERIES — WARMUP-AWARE EVALUATION
 * ===========================================
 * Series-returning indicators that are HONEST about insufficient data.
 *
 * WHY THIS FILE EXISTS
 *
 * `indicators.ts` is the live path and its functions are contractually
 * "always return a number", because the UI and the existing tracker engine
 * depend on that. But that contract produces values that are indistinguishable
 * from real measurements:
 *
 *   calculateRSI(candles, 14)  -> 50.0      when there is no warmup at all
 *   calculateATR(candles, 14)  -> 0.001     when there are < 2 candles
 *   calculateEMA(candles, 50)  -> SMA(short) when history is short
 *   calculateSMA(candles, 20)  -> lastClose when history is short
 *
 * RSI returning exactly 50.0 for "I have no idea" is the dangerous one: it is
 * the neutral reading, so a tracker "RSI above 50" is false and "RSI below 50"
 * is false — the GOAT just sits there silently instead of knowing its tracker
 * is not yet evaluable. Worse, `SMA(short)` fed into `calculateMACD` produces a
 * plausible-looking MACD computed from a moving average of three bars.
 *
 * So this module adds the missing concept: an indicator RESULT that says
 * whether it is available at all.
 *
 *   const rsi = rsiSeries(candles, 14);
 *   if (!rsi.available) -> not evaluable; do NOT fire, report the shortfall
 *   else               -> a real measurement, plus the previous one for
 *                          crossover detection
 *
 * `indicators.ts` is left untouched, so nothing existing changes behaviour.
 */

import type { OhlcCandle } from './indicators';

/** The outcome of evaluating one indicator over a candle slice. */
export interface IndicatorResult<T = number> {
  /** The value. ONLY meaningful when `available` is true. */
  value: T;
  /** The value at the previous candle. Null at the start of the series. */
  previous: T | null;
  /** False when there is not enough history. `value` is then undefined-ish. */
  available: boolean;
  /** Candles the indicator mathematically requires. */
  warmupRequired: number;
  /** Candles actually supplied. */
  warmupAvailable: number;
  /** How many extra candles are needed before this becomes evaluable. */
  shortfall: number;
}

/** The single builder for every result in this module. */
function result<T>(
  value: T,
  previous: T | null,
  warmupRequired: number,
  warmupAvailable: number,
): IndicatorResult<T> {
  const available = warmupAvailable >= warmupRequired;
  return {
    value,
    previous,
    available,
    warmupRequired,
    warmupAvailable,
    shortfall: Math.max(0, warmupRequired - warmupAvailable),
  };
}

/* ------------------------------------------------------------------ */
/* Moving averages                                                     */
/* ------------------------------------------------------------------ */

export function smaSeries(
  candles: readonly OhlcCandle[],
  period: number,
): IndicatorResult {
  const safePeriod = Math.max(1, Math.floor(period));
  const available = candles.length;

  if (candles.length === 0) {
    return result(0, null, safePeriod, 0);
  }

  const current = mean(
    candles.slice(-safePeriod).map((c) => c.close),
  );

  const previous =
    candles.length >= safePeriod + 1
      ? mean(candles.slice(-safePeriod - 1, -1).map((c) => c.close))
      : null;

  return result(current, previous, safePeriod, available);
}

export function emaSeries(
  candles: readonly OhlcCandle[],
  period: number,
): IndicatorResult {
  const safePeriod = Math.max(1, Math.floor(period));
  const available = candles.length;

  if (candles.length === 0) {
    return result(0, null, safePeriod, 0);
  }

  if (candles.length < safePeriod) {
    /**
     * Explicitly UNAVAILABLE. The legacy `calculateEMA` silently substitutes a
     * short SMA here; this returns the same number but flags it as unusable so
     * the caller refuses to act on it.
     */
    return result(mean(candles.map((c) => c.close)), null, safePeriod, available);
  }

  const k = 2 / (safePeriod + 1);
  let seedSum = 0;
  for (let i = 0; i < safePeriod; i += 1) seedSum += candles[i].close;
  let ema = seedSum / safePeriod;

  const values: number[] = [ema];
  for (let i = safePeriod; i < candles.length; i += 1) {
    ema = candles[i].close * k + ema * (1 - k);
    values.push(ema);
  }

  return result(
    values[values.length - 1],
    values.length > 1 ? values[values.length - 2] : null,
    safePeriod,
    available,
  );
}

/* ------------------------------------------------------------------ */
/* RSI                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Wilder's RSI, which is what `calculateRSI` implements.
 *
 * Warmup requirement is `period + 1` candles, not `period`: the first RSI value
 * needs one change, and one change needs two closes.
 */
export function rsiSeries(
  candles: readonly OhlcCandle[],
  period = 14,
): IndicatorResult {
  const safePeriod = Math.max(2, Math.floor(period));
  const required = safePeriod + 1;

  if (candles.length < required) {
    return result(50, null, required, candles.length);
  }

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= safePeriod; i += 1) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / safePeriod;
  let avgLoss = losses / safePeriod;

  const series = [rsiFrom(avgGain, avgLoss)];

  for (let i = safePeriod + 1; i < candles.length; i += 1) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (safePeriod - 1) + gain) / safePeriod;
    avgLoss = (avgLoss * (safePeriod - 1) + loss) / safePeriod;
    series.push(rsiFrom(avgGain, avgLoss));
  }

  return result(
    series[series.length - 1],
    series.length > 1 ? series[series.length - 2] : null,
    required,
    candles.length,
  );
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/* ------------------------------------------------------------------ */
/* ATR                                                                 */
/* ------------------------------------------------------------------ */

export function atrSeries(
  candles: readonly OhlcCandle[],
  period = 14,
): IndicatorResult {
  const safePeriod = Math.max(1, Math.floor(period));
  const required = safePeriod + 1;

  if (candles.length < required) {
    return result(0, null, required, candles.length);
  }

  const series = atrValues(candles);
  const window = series.slice(-safePeriod);
  const value = mean(window);

  const previousWindow =
    series.length >= safePeriod + 1 ? series.slice(-safePeriod - 1, -1) : [];

  return result(
    value,
    previousWindow.length ? mean(previousWindow) : null,
    required,
    candles.length,
  );
}

/** The raw ATR value per bar (Wilder smoothing), one fewer than candles. */
function atrValues(candles: readonly OhlcCandle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    out.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Price                                                               */
/* ------------------------------------------------------------------ */

export function priceSeries(
  candles: readonly OhlcCandle[],
): IndicatorResult {
  const available = candles.length;
  const value = available ? candles[available - 1].close : 0;
  const previous = available > 1 ? candles[available - 2].close : null;
  return result(value, previous, 1, available);
}

/* ------------------------------------------------------------------ */
/* Warmup planning                                                     */
/* ------------------------------------------------------------------ */

export interface WarmupPlan {
  /** Candles that must be fetched for the whole tracker set to evaluate. */
  required: number;
  /** Largest single requirement, used to explain the requirement. */
  dominantReason: string;
}

/**
 * The number of candles an indicator needs before it is trustworthy.
 *
 * The extra headroom over the bare requirement is deliberate: computing an EMA
 * from exactly `period` bars seeds it with a flat average, which is not what
 * the EMA would converge to on a real series. Requiring a multiple of the
 * period trades a few extra rows for an indicator that actually agrees with
 * the library implementation on real data.
 */
export function warmupFor(
  indicator: string,
  period: number,
  fastPeriod?: number,
  slowPeriod?: number,
): { required: number; reason: string } {
  switch (indicator.toUpperCase()) {
    case 'RSI':
      return {
        required: Math.ceil(period * 2),
        reason: `RSI(${period}) needs ${period + 1} changes; ${period * 2} bars lets the Wilder average settle.`,
      };
    case 'EMA':
      return {
        required: Math.ceil(period * 3),
        reason: `EMA(${period}) is seeded from ${period} bars and converges over several multiples.`,
      };
    case 'SMA':
      return { required: period + 1, reason: `SMA(${period}) needs ${period} bars plus one to compare against.` };
    case 'ATR':
      return {
        required: Math.ceil(period * 2),
        reason: `ATR(${period}) needs ${period + 1} true ranges.`,
      };
    case 'MACD':
    case 'MACD_HISTOGRAM':
      return {
        required: Math.ceil((slowPeriod ?? 26) * 3),
        reason: `MACD(${fastPeriod ?? 12},${slowPeriod ?? 26}) needs the slow EMA to converge.`,
      };
    case 'SWING_HIGH':
    case 'SWING_LOW':
      return {
        required: Math.ceil(period * 2) + 1,
        reason: `A ${period}-bar swing needs ${period} bars of clearance on each side to confirm.`,
      };
    case 'SESSION_HIGH':
    case 'SESSION_LOW':
      return { required: 60, reason: 'Session extremes need at least an hour of the session.' };
    case 'PRICE':
    default:
      return { required: 1, reason: 'Price needs one candle.' };
  }
}

/** The warmup across every tracker, so one fetch satisfies all of them. */
export function planWarmup(
  requirements: Array<{ indicator: string; period: number; fastPeriod?: number; slowPeriod?: number }>,
): WarmupPlan {
  let required = 1;
  let dominantReason = 'Price needs one candle.';

  for (const entry of requirements) {
    const plan = warmupFor(entry.indicator, entry.period, entry.fastPeriod, entry.slowPeriod);
    if (plan.required > required) {
      required = plan.required;
      dominantReason = plan.reason;
    }
  }

  return { required, dominantReason };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}