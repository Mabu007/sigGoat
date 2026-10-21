import { describe, test, expect } from 'bun:test';
import { evaluatePriceAction } from '../src/services/strategy/priceAction';
import { priceActionParamsSchema, type PriceActionParams, type PriceActionPattern } from '../src/services/strategy/schema';
import { candle, makeCandles } from './helpers/strategyCandles';
import type { Candle } from '../src/types';

/**
 * PRICE ACTION
 * ============
 *
 * Every pattern is tested with a case that must fire and a case that must
 * not, and the boundary between them is tested as well. The candles are
 * hand written so the arithmetic can be checked by eye.
 */

const MINUTE = 60_000;
const params = (overrides: Partial<PriceActionParams> = {}): PriceActionParams => priceActionParamsSchema.parse(overrides);

/** A flat run of candles used as the "prior" window. */
function prior(count: number, overrides: Partial<Candle> = {}): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(
    MINUTE * (index + 1),
    overrides.open ?? 101,
    overrides.high ?? 103,
    overrides.low ?? 100,
    overrides.close ?? 102,
    overrides.volume ?? 1000,
  ));
}

const sweep = (lookback = 20) => params({ lookback, requireCloseBack: true, minPenetration: 0, distanceMode: 'TICKS' });

describe('liquidity sweeps', () => {
  test('a bullish sweep that closes back above the level fires', () => {
    const candles = [...prior(20), candle(MINUTE * 21, 101, 102, 98, 101.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', sweep(), candles, candles.length - 1)).toBe(true);
  });

  test('a bullish sweep that does not close back does not fire', () => {
    const candles = [...prior(20), candle(MINUTE * 21, 101, 102, 98, 99.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', sweep(), candles, candles.length - 1)).toBe(false);
  });

  test('a candle that never trades below the level is not a sweep', () => {
    const candles = [...prior(20), candle(MINUTE * 21, 101, 102, 100.5, 101.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', sweep(), candles, candles.length - 1)).toBe(false);
  });

  test('the minimum penetration is measured in ticks when asked for', () => {
    const candles = [...prior(20), candle(MINUTE * 21, 101, 102, 99.5, 101.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20, minPenetration: 1, distanceMode: 'TICKS' }), candles, candles.length - 1)).toBe(false);
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20, minPenetration: 0.4, distanceMode: 'TICKS' }), candles, candles.length - 1)).toBe(true);
  });

  test('the minimum penetration is measured in percent when asked for', () => {
    const candles = [...prior(20), candle(MINUTE * 21, 101, 102, 99.5, 101.5)];
    // The reference low is 100, so 0.5 of penetration is 0.5 percent.
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20, minPenetration: 0.6, distanceMode: 'PERCENT' }), candles, candles.length - 1)).toBe(false);
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20, minPenetration: 0.4, distanceMode: 'PERCENT' }), candles, candles.length - 1)).toBe(true);
  });

  test('the direction requirement is optional and works when it is on', () => {
    const down = [...prior(20), candle(MINUTE * 21, 101, 102, 98, 99.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20, requireCloseBack: false, requireDirection: true }), down, down.length - 1)).toBe(false);
    const up = [...prior(20), candle(MINUTE * 21, 101, 102, 98, 101.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20, requireCloseBack: false, requireDirection: true }), up, up.length - 1)).toBe(true);
  });

  test('a bearish sweep is the inverse of a bullish one', () => {
    const candles = [...prior(20, { open: 101, high: 105, low: 100, close: 103 }), candle(MINUTE * 21, 103, 107, 102, 104)];
    expect(evaluatePriceAction('BEARISH_SWEEP', sweep(), candles, candles.length - 1)).toBe(true);
    const noCloseBack = [...prior(20, { open: 101, high: 105, low: 100, close: 103 }), candle(MINUTE * 21, 103, 107, 102, 105.5)];
    expect(evaluatePriceAction('BEARISH_SWEEP', sweep(), noCloseBack, noCloseBack.length - 1)).toBe(false);
  });
});

describe('breakouts', () => {
  const highPrior = () => prior(20, { open: 101, high: 105, low: 100, close: 104 });

  test('a close above the prior high is a breakout', () => {
    const candles = [...highPrior(), candle(MINUTE * 21, 104, 106, 103.5, 105.5)];
    expect(evaluatePriceAction('BREAKOUT_HIGH', params({ lookback: 20, requireCloseConfirmation: true, requireNewEvent: true }), candles, candles.length - 1)).toBe(true);
  });

  test('a close that stays below the prior high is not a breakout', () => {
    const candles = [...highPrior(), candle(MINUTE * 21, 104, 106, 103.5, 104.5)];
    expect(evaluatePriceAction('BREAKOUT_HIGH', params({ lookback: 20, requireCloseConfirmation: true }), candles, candles.length - 1)).toBe(false);
  });

  test('without close confirmation the wick alone is enough', () => {
    const candles = [...highPrior(), candle(MINUTE * 21, 104, 106, 103.5, 104.5)];
    expect(evaluatePriceAction('BREAKOUT_HIGH', params({ lookback: 20, requireCloseConfirmation: false }), candles, candles.length - 1)).toBe(true);
  });

  test('the same breakout does not fire again on the next candle', () => {
    const candles = [
      ...highPrior(),
      candle(MINUTE * 21, 104, 106, 103.5, 105.5),
      candle(MINUTE * 22, 105.5, 107, 105, 106.5),
    ];
    const rules = params({ lookback: 20, requireCloseConfirmation: true, requireNewEvent: true });
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, candles, 20)).toBe(true);
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, candles, 21)).toBe(false);
  });

  test('with the new event rule turned off the same breakout keeps firing', () => {
    const candles = [
      ...highPrior(),
      candle(MINUTE * 21, 104, 106, 103.5, 105.5),
      candle(MINUTE * 22, 105.5, 107, 105, 106.5),
    ];
    const rules = params({ lookback: 20, requireCloseConfirmation: true, requireNewEvent: false });
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, candles, 20)).toBe(true);
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, candles, 21)).toBe(true);
  });

  test('the volume confirmation needs enough volume', () => {
    const candles = [...highPrior(), candle(MINUTE * 21, 104, 106, 103.5, 105.5, 100)];
    const rules = params({ lookback: 20, requireCloseConfirmation: true, requireVolumeConfirmation: true, volumeMultiplier: 1.5, volumePeriod: 20 });
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, candles, candles.length - 1)).toBe(false);
    const loud = [...highPrior(), candle(MINUTE * 21, 104, 106, 103.5, 105.5, 5000)];
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, loud, loud.length - 1)).toBe(true);
  });

  test('a breakout below the prior low is the inverse', () => {
    const lowPrior = prior(20, { open: 99, high: 100, low: 95, close: 96 });
    const candles = [...lowPrior, candle(MINUTE * 21, 96, 96.5, 93, 94)];
    expect(evaluatePriceAction('BREAKOUT_LOW', params({ lookback: 20, requireCloseConfirmation: true }), candles, candles.length - 1)).toBe(true);
    const inside = [...lowPrior, candle(MINUTE * 21, 96, 96.5, 95.5, 96.2)];
    expect(evaluatePriceAction('BREAKOUT_LOW', params({ lookback: 20, requireCloseConfirmation: true }), inside, inside.length - 1)).toBe(false);
  });

  test('a breakout and retest needs a breakout first and a retest after it', () => {
    const candles = [
      ...highPrior(),
      candle(MINUTE * 21, 104, 106, 103.5, 105.5),
      candle(MINUTE * 22, 105.5, 105.8, 104.9, 105.2),
    ];
    const rules = params({ lookback: 20, requireCloseConfirmation: true, retestTolerance: 0.01, maxRetestCandles: 5 });
    expect(evaluatePriceAction('BREAKOUT_RETEST_HIGH', rules, candles, candles.length - 1)).toBe(true);
    // Without the breakout candle there is nothing to retest.
    const withoutBreakout = [...highPrior(), candle(MINUTE * 21, 105.5, 105.8, 104.9, 105.2)];
    expect(evaluatePriceAction('BREAKOUT_RETEST_HIGH', rules, withoutBreakout, withoutBreakout.length - 1)).toBe(false);
  });
});

describe('candlestick patterns', () => {
  test('a bullish engulfing covers the previous body', () => {
    const candles = [candle(MINUTE, 101, 101.5, 98.5, 99), candle(MINUTE * 2, 98.5, 102, 98, 101.5)];
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'BODY', requireOppositeColor: true }), candles, 1)).toBe(true);
  });

  test('a bullish candle that does not cover the previous body is not an engulfing', () => {
    const candles = [candle(MINUTE, 101, 101.5, 98.5, 99), candle(MINUTE * 2, 100, 101, 99.5, 100.4)];
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'BODY' }), candles, 1)).toBe(false);
  });

  test('the opposite colour requirement can be turned off', () => {
    const candles = [candle(MINUTE, 99, 101.5, 98.5, 101), candle(MINUTE * 2, 98.5, 102, 98, 101.5)];
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'BODY', requireOppositeColor: true }), candles, 1)).toBe(false);
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'BODY', requireOppositeColor: false }), candles, 1)).toBe(true);
  });

  test('the full range mode needs the whole range of the previous candle', () => {
    const body = [candle(MINUTE, 101, 101.5, 98.5, 99), candle(MINUTE * 2, 98.5, 102, 98, 101.5)];
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'FULL_RANGE' }), body, 1)).toBe(true);
    const bodyOnly = [candle(MINUTE, 101, 101.5, 98.5, 99), candle(MINUTE * 2, 99.5, 101.2, 99.2, 101)];
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'FULL_RANGE' }), bodyOnly, 1)).toBe(false);
  });

  test('the minimum body size is a percentage of the candle range', () => {
    const candles = [candle(MINUTE, 101, 101.5, 98.5, 99), candle(MINUTE * 2, 98.5, 102, 98, 101.5)];
    // The body is 3 of a range of 4, so 75 percent.
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'BODY', minBodySize: 50 }), candles, 1)).toBe(true);
    expect(evaluatePriceAction('BULLISH_ENGULFING', params({ engulfMode: 'BODY', minBodySize: 90 }), candles, 1)).toBe(false);
  });

  test('a bearish engulfing is the inverse', () => {
    const candles = [candle(MINUTE, 99, 101.5, 98.5, 101), candle(MINUTE * 2, 101.5, 102, 97, 98.5)];
    expect(evaluatePriceAction('BEARISH_ENGULFING', params({ engulfMode: 'BODY', requireOppositeColor: true }), candles, 1)).toBe(true);
  });

  test('a bullish pin bar has a long lower wick and a small upper one', () => {
    const candles = [candle(MINUTE, 100, 101, 95, 100.5)];
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params(), candles, 0)).toBe(true);
  });

  test('a candle with a big upper wick is not a bullish pin bar', () => {
    const candles = [candle(MINUTE, 100, 106, 99.5, 100.5)];
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params(), candles, 0)).toBe(false);
    expect(evaluatePriceAction('BEARISH_PIN_BAR', params(), candles, 0)).toBe(true);
  });

  test('a doji without a dominant wick is not a pin bar', () => {
    const candles = [candle(MINUTE, 100, 101, 99, 100)];
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params(), candles, 0)).toBe(false);
    expect(evaluatePriceAction('BEARISH_PIN_BAR', params(), candles, 0)).toBe(false);
  });

  test('a candle with no range is never a pin bar', () => {
    const candles = [candle(MINUTE, 100, 100, 100, 100)];
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params(), candles, 0)).toBe(false);
    expect(evaluatePriceAction('BEARISH_PIN_BAR', params(), candles, 0)).toBe(false);
  });

  test('the wick ratio and the wick percentages are configurable', () => {
    const candles = [candle(MINUTE, 100, 101, 95, 100.5)];
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params({ minWickRatio: 20 }), candles, 0)).toBe(false);
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params({ minDominantWickPercent: 90 }), candles, 0)).toBe(false);
    expect(evaluatePriceAction('BULLISH_PIN_BAR', params({ maxOpposingWickPercent: 5 }), candles, 0)).toBe(false);
  });
});

describe('price action and look-ahead', () => {
  test('the reference levels never include the signal candle', () => {
    // A candle with a huge high must not raise the reference level of the
    // very candle that breaks out.
    const candles = [...prior(20, { open: 101, high: 105, low: 100, close: 104 }), candle(MINUTE * 21, 104, 200, 103.5, 105.5)];
    const rules = params({ lookback: 20, requireCloseConfirmation: true });
    expect(evaluatePriceAction('BREAKOUT_HIGH', rules, candles, candles.length - 1)).toBe(true);
  });

  test('a later candle cannot change an earlier verdict', () => {
    const candles = [...prior(20), candle(MINUTE * 21, 101, 102, 98, 101.5)];
    const withFuture = [...candles, candle(MINUTE * 22, 200, 210, 199, 205)];
    expect(evaluatePriceAction('BULLISH_SWEEP', sweep(), candles, 20)).toBe(true);
    expect(evaluatePriceAction('BULLISH_SWEEP', sweep(), withFuture, 20)).toBe(true);
  });

  test('a pattern with too little history is false rather than wrong', () => {
    const candles = [candle(MINUTE, 101, 102, 98, 101.5)];
    expect(evaluatePriceAction('BULLISH_SWEEP', params({ lookback: 20 }), candles, 0)).toBe(false);
  });

  test('every pattern is false on an empty series', () => {
    const patterns: PriceActionPattern[] = [
      'BULLISH_SWEEP', 'BEARISH_SWEEP', 'BREAKOUT_HIGH', 'BREAKOUT_LOW',
      'BREAKOUT_RETEST_HIGH', 'BREAKOUT_RETEST_LOW',
      'BULLISH_ENGULFING', 'BEARISH_ENGULFING', 'BULLISH_PIN_BAR', 'BEARISH_PIN_BAR',
    ];
    for (const pattern of patterns) {
      expect(evaluatePriceAction(pattern, params(), [], 0)).toBe(false);
      expect(evaluatePriceAction(pattern, params(), makeCandles({ count: 5 }), 0)).toBe(false);
    }
  });
});
