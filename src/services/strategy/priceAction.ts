import type { Candle } from '../../types';
import type { PriceActionParams, PriceActionPattern } from './schema';

/**
 * PRICE ACTION
 * ============
 *
 * Every pattern here has an explicit, deterministic definition, written out
 * in the comment above it. There is no hidden tuning: the same candles and
 * the same parameters always produce the same answer.
 *
 * NO LOOK-AHEAD
 *
 * A pattern is evaluated on a COMPLETED candle. The reference levels are
 * built from the candles BEFORE the signal candle, the signal candle itself
 * is the only candle that may be broken or swept, and nothing after the
 * signal candle is ever read. A condition therefore becomes true at the
 * close of the signal candle and the engine can only act on it at the open
 * of the next candle.
 */

const EPSILON = 1e-12;

/** The candles before the signal candle, oldest first. */
function priorWindow(candles: readonly Candle[], index: number, length: number): Candle[] {
  const start = Math.max(0, index - length);
  return candles.slice(start, index);
}

function highestHigh(candles: readonly Candle[]): number {
  let value = Number.NEGATIVE_INFINITY;
  for (const candle of candles) if (candle.high > value) value = candle.high;
  return value;
}

function lowestLow(candles: readonly Candle[]): number {
  let value = Number.POSITIVE_INFINITY;
  for (const candle of candles) if (candle.low < value) value = candle.low;
  return value;
}

function average(values: readonly number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

interface CandleGeometry {
  body: number;
  range: number;
  upperWick: number;
  lowerWick: number;
}

function geometry(candle: Candle): CandleGeometry {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return { body, range, upperWick, lowerWick };
}

/**
 * Is the distance enough for the configured measurement?
 *
 *   TICKS   the absolute distance in price units.
 *   PERCENT the distance as a percentage of the reference level.
 */
function distanceSatisfied(
  mode: 'TICKS' | 'PERCENT',
  distance: number,
  reference: number,
  required: number,
): boolean {
  if (!(required > 0)) return true;
  if (mode === 'TICKS') return distance >= required - EPSILON;
  if (!(reference > 0)) return false;
  return (distance / reference) * 100 >= required - EPSILON;
}

/**
 * LIQUIDITY SWEEP
 *
 *   Bullish sweep, on the signal candle:
 *     1. the reference low is the lowest low of the `lookback` completed
 *        candles before the signal candle;
 *     2. the signal candle trades below that low;
 *     3. the penetration satisfies `minPenetration`, measured in ticks or
 *        in percent of the reference low;
 *     4. when `requireCloseBack` is set, the signal candle closes back
 *        above the reference low;
 *     5. when `requireDirection` is set, the signal candle closes above its
 *        open;
 *     6. when `minWickBodyRatio` is greater than zero, the lower wick must
 *        be at least that many times the body.
 *
 *   A bearish sweep is the exact inverse: the reference high, a trade above
 *   it, a close back below it, a downward close and an upper wick.
 */
function evaluateSweep(
  candles: readonly Candle[],
  index: number,
  params: PriceActionParams,
  bullish: boolean,
): boolean {
  const prior = priorWindow(candles, index, params.lookback);
  if (prior.length < Math.min(2, params.lookback)) return false;
  const current = candles[index];
  const reference = bullish ? lowestLow(prior) : highestHigh(prior);
  if (!Number.isFinite(reference)) return false;

  const penetration = bullish ? reference - current.low : current.high - reference;
  if (penetration <= 0) return false;
  if (!distanceSatisfied(params.distanceMode, penetration, reference, params.minPenetration)) return false;

  if (params.requireCloseBack) {
    if (bullish && !(current.close > reference)) return false;
    if (!bullish && !(current.close < reference)) return false;
  }
  if (params.requireDirection) {
    if (bullish && !(current.close > current.open)) return false;
    if (!bullish && !(current.close < current.open)) return false;
  }
  if (params.minWickBodyRatio > 0) {
    const { body, lowerWick, upperWick } = geometry(current);
    const wick = bullish ? lowerWick : upperWick;
    if (!(wick >= params.minWickBodyRatio * body - EPSILON)) return false;
  }
  return true;
}

/**
 * BREAKOUT
 *
 *   1. the reference level is the highest high (or the lowest low) of the
 *      `lookback` completed candles before the signal candle;
 *   2. the signal candle trades beyond that level;
 *   3. the distance beyond the level satisfies `minBreakoutDistance`;
 *   4. when `requireCloseConfirmation` is set, the CLOSE must be beyond the
 *      level, otherwise the high (or the low) is enough;
 *   5. when `requireNewEvent` is set, the previous candle must not have
 *      been a breakout itself, so one event produces one signal;
 *   6. when `requireVolumeConfirmation` is set, the volume of the signal
 *      candle must be at least `volumeMultiplier` times the average volume
 *      of the `volumePeriod` candles before it.
 */
function evaluateBreakout(
  candles: readonly Candle[],
  index: number,
  params: PriceActionParams,
  bullish: boolean,
): boolean {
  const prior = priorWindow(candles, index, params.lookback);
  if (prior.length < 2) return false;
  const current = candles[index];
  const reference = bullish ? highestHigh(prior) : lowestLow(prior);
  if (!Number.isFinite(reference)) return false;

  const extreme = bullish
    ? (params.requireCloseConfirmation ? current.close : current.high)
    : (params.requireCloseConfirmation ? current.close : current.low);
  const distance = bullish ? extreme - reference : reference - extreme;
  if (!(distance > 0)) return false;
  if (!distanceSatisfied(params.distanceMode, distance, reference, params.minBreakoutDistance)) return false;

  if (params.requireNewEvent) {
    const previous = candles[index - 1];
    if (previous) {
      const beforePrevious = priorWindow(candles, index - 1, params.lookback);
      if (beforePrevious.length >= 2) {
        const previousReference = bullish ? highestHigh(beforePrevious) : lowestLow(beforePrevious);
        const previousExtreme = bullish
          ? (params.requireCloseConfirmation ? previous.close : previous.high)
          : (params.requireCloseConfirmation ? previous.close : previous.low);
        const previousDistance = bullish ? previousExtreme - previousReference : previousReference - previousExtreme;
        if (previousDistance > 0) return false;
      }
    }
  }

  if (params.requireVolumeConfirmation) {
    const volumeWindow = priorWindow(candles, index, params.volumePeriod);
    if (!volumeWindow.length) return false;
    const averageVolume = average(volumeWindow.map(candle => candle.volume));
    if (!(averageVolume > 0)) return false;
    if (current.volume < averageVolume * params.volumeMultiplier - EPSILON) return false;
  }
  return true;
}

/**
 * BREAKOUT AND RETEST
 *
 *   1. somewhere inside the `maxRetestCandles` candles before the signal
 *      candle there was a candle that closed beyond the level of its own
 *      `lookback` window — a qualifying breakout. The most recent one wins;
 *   2. the signal candle traded back down to that level, allowing the
 *      retest to overshoot it by `retestTolerance` of the level;
 *   3. the signal candle closed back above the level, allowing it to close
 *      up to `retestTolerance` below it.
 *
 * The breakout candle is always in the past, so the retest can never use
 * information that was unavailable when it was taken.
 */
function evaluateBreakoutRetest(
  candles: readonly Candle[],
  index: number,
  params: PriceActionParams,
  bullish: boolean,
): boolean {
  const current = candles[index];
  const firstCandidate = Math.max(1, index - params.maxRetestCandles);
  let level: number | null = null;
  for (let candidate = index - 1; candidate >= firstCandidate; candidate -= 1) {
    const before = priorWindow(candles, candidate, params.lookback);
    if (before.length < 2) continue;
    const reference = bullish ? highestHigh(before) : lowestLow(before);
    const bar = candles[candidate];
    const distance = bullish ? bar.close - reference : reference - bar.close;
    if (distance > 0 && distanceSatisfied(params.distanceMode, distance, reference, params.minBreakoutDistance)) {
      level = reference;
      break;
    }
  }
  if (level === null) return false;

  const tolerance = params.retestTolerance;
  if (bullish) {
    if (!(current.low <= level * (1 + tolerance) + EPSILON)) return false;
    if (!(current.close > level * (1 - tolerance) - EPSILON)) return false;
  } else {
    if (!(current.high >= level * (1 - tolerance) - EPSILON)) return false;
    if (!(current.close < level * (1 + tolerance) + EPSILON)) return false;
  }
  return true;
}

/**
 * ENGULFING
 *
 *   1. the previous candle and the signal candle must be two candles;
 *   2. in `BODY` mode the body of the signal candle must cover the whole
 *      body of the previous candle. In `FULL_RANGE` mode the signal candle
 *      must cover the whole range of the previous candle;
 *   3. when `requireOppositeColor` is set, the previous candle must close
 *      against the direction of the signal candle;
 *   4. the body of the signal candle must cover at least `minBodySize`
 *      percent of its own range.
 */
function evaluateEngulfing(
  candles: readonly Candle[],
  index: number,
  params: PriceActionParams,
  bullish: boolean,
): boolean {
  if (index < 1) return false;
  const previous = candles[index - 1];
  const current = candles[index];
  const previousBullish = previous.close > previous.open;
  if (params.requireOppositeColor) {
    if (bullish && previousBullish) return false;
    if (!bullish && !previousBullish) return false;
  }
  const currentBullish = current.close > current.open;
  if (bullish && !currentBullish) return false;
  if (!bullish && currentBullish) return false;

  if (params.engulfMode === 'FULL_RANGE') {
    if (bullish && !(current.high >= previous.high && current.low <= previous.low)) return false;
    if (!bullish && !(current.high >= previous.high && current.low <= previous.low)) return false;
  } else {
    const previousTop = Math.max(previous.open, previous.close);
    const previousBottom = Math.min(previous.open, previous.close);
    const currentTop = Math.max(current.open, current.close);
    const currentBottom = Math.min(current.open, current.close);
    if (bullish && !(currentBottom <= previousBottom && currentTop >= previousTop)) return false;
    if (!bullish && !(currentTop >= previousTop && currentBottom <= previousBottom)) return false;
  }

  if (params.minBodySize > 0) {
    const { body, range } = geometry(current);
    if (range <= 0) return false;
    if ((body / range) * 100 < params.minBodySize - EPSILON) return false;
  }
  return true;
}

/**
 * PIN BAR
 *
 *   1. the signal candle must have a range, a candle with no range has no
 *      pin bar;
 *   2. the dominant wick must be at least `minWickRatio` times the body;
 *   3. the dominant wick must cover at least `minDominantWickPercent` of
 *      the range;
 *   4. the opposing wick must cover at most `maxOpposingWickPercent` of
 *      the range;
 *   5. when `requireDirection` is set, the candle must close in the
 *      direction of the pattern.
 *
 * A doji is safe: its body is zero, so the body multiple is vacuous, but
 * the wick still has to cover the required share of the range.
 */
function evaluatePinBar(
  candles: readonly Candle[],
  index: number,
  params: PriceActionParams,
  bullish: boolean,
): boolean {
  const current = candles[index];
  const { body, range, upperWick, lowerWick } = geometry(current);
  if (!(range > 0)) return false;
  const dominant = bullish ? lowerWick : upperWick;
  const opposing = bullish ? upperWick : lowerWick;
  if (!(dominant >= params.minWickRatio * body - EPSILON)) return false;
  if (!(dominant >= (params.minDominantWickPercent / 100) * range - EPSILON)) return false;
  if (!(opposing <= (params.maxOpposingWickPercent / 100) * range + EPSILON)) return false;
  if (params.requireDirection) {
    if (bullish && !(current.close > current.open)) return false;
    if (!bullish && !(current.close < current.open)) return false;
  }
  return true;
}

/**
 * Evaluates one price-action pattern on a completed candle.
 *
 * `index` is the index of the signal candle. Only candles up to and
 * including that index are read.
 */
export function evaluatePriceAction(
  pattern: PriceActionPattern,
  params: PriceActionParams,
  candles: readonly Candle[],
  index: number,
): boolean {
  const current = candles[index];
  if (!current) return false;
  switch (pattern) {
    case 'BULLISH_SWEEP': return evaluateSweep(candles, index, params, true);
    case 'BEARISH_SWEEP': return evaluateSweep(candles, index, params, false);
    case 'BREAKOUT_HIGH': return evaluateBreakout(candles, index, params, true);
    case 'BREAKOUT_LOW': return evaluateBreakout(candles, index, params, false);
    case 'BREAKOUT_RETEST_HIGH': return evaluateBreakoutRetest(candles, index, params, true);
    case 'BREAKOUT_RETEST_LOW': return evaluateBreakoutRetest(candles, index, params, false);
    case 'BULLISH_ENGULFING': return evaluateEngulfing(candles, index, params, true);
    case 'BEARISH_ENGULFING': return evaluateEngulfing(candles, index, params, false);
    case 'BULLISH_PIN_BAR': return evaluatePinBar(candles, index, params, true);
    case 'BEARISH_PIN_BAR': return evaluatePinBar(candles, index, params, false);
    default: return false;
  }
}

/** A short, readable description of a pattern, for the builder. */
export function describePriceActionPattern(pattern: PriceActionPattern): string {
  switch (pattern) {
    case 'BULLISH_SWEEP': return 'Bullish liquidity sweep';
    case 'BEARISH_SWEEP': return 'Bearish liquidity sweep';
    case 'BREAKOUT_HIGH': return 'Breakout above the prior high';
    case 'BREAKOUT_LOW': return 'Breakout below the prior low';
    case 'BREAKOUT_RETEST_HIGH': return 'Breakout above the prior high, then a retest';
    case 'BREAKOUT_RETEST_LOW': return 'Breakout below the prior low, then a retest';
    case 'BULLISH_ENGULFING': return 'Bullish engulfing';
    case 'BEARISH_ENGULFING': return 'Bearish engulfing';
    case 'BULLISH_PIN_BAR': return 'Bullish pin bar';
    case 'BEARISH_PIN_BAR': return 'Bearish pin bar';
    default: return pattern;
  }
}
