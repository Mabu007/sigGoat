import { describe, test, expect } from 'bun:test';
import { INDICATOR_CATALOG, resolveIndicatorParams } from '../src/services/strategy/indicators/catalog';
import { calculateIndicator } from '../src/services/strategy/indicators/calculations';
import { makeCandles } from './helpers/strategyCandles';

/**
 * NO LOOK-AHEAD, PROVED FOR THE WHOLE CATALOG
 * ===========================================
 *
 * An indicator that reads the future is the single worst defect a trading
 * system can have: it makes a backtest report a profit that the live
 * runner could never earn.
 *
 * The test is mechanical and covers every indicator in the catalog. It
 * calculates each series twice. The second run has the LAST candle moved a
 * long way. If any value before that candle changes, the indicator read
 * something it could not have known, and the test fails.
 */

const lastCandlePerturbation = (candles: ReturnType<typeof makeCandles>) => {
  const copy = candles.map(candle => ({ ...candle }));
  const last = copy[copy.length - 1];
  last.open = last.open * 1.4;
  last.high = last.high * 1.5;
  last.low = last.low * 0.6;
  last.close = last.close * 1.45;
  last.volume = last.volume * 3 + 1000;
  return copy;
};

describe('indicator look-ahead', () => {
  test('no indicator changes an earlier value when the last candle changes', () => {
    const candles = makeCandles({ count: 300 });
    const perturbed = lastCandlePerturbation(candles);
    for (const entry of INDICATOR_CATALOG) {
      const params = resolveIndicatorParams(entry.key, {});
      const before = calculateIndicator(entry.key, candles, params);
      const after = calculateIndicator(entry.key, perturbed, params);
      for (const output of entry.outputs) {
        const a = before.series[output.key];
        const b = after.series[output.key];
        for (let index = 0; index < candles.length - 1; index += 1) {
          const left = a[index];
          const right = b[index];
          if (Number.isNaN(left) && Number.isNaN(right)) continue;
          expect(right, `${entry.key}.${output.key} changed at candle ${index} when only the last candle changed`).toBe(left);
        }
      }
    }
  });

  test('the last value is allowed to change, so the test above is not vacuous', () => {
    const candles = makeCandles({ count: 300 });
    const perturbed = lastCandlePerturbation(candles);
    let changed = 0;
    for (const entry of INDICATOR_CATALOG) {
      const params = resolveIndicatorParams(entry.key, {});
      const before = calculateIndicator(entry.key, candles, params);
      const after = calculateIndicator(entry.key, perturbed, params);
      for (const output of entry.outputs) {
        const a = before.series[output.key];
        const b = after.series[output.key];
        if (a[a.length - 1] !== b[b.length - 1]) changed += 1;
      }
    }
    expect(changed).toBeGreaterThan(10);
  });

  test('the ichimoku cloud outputs are aligned to the decision candle', () => {
    const candles = makeCandles({ count: 300 });
    const perturbed = lastCandlePerturbation(candles);
    const before = calculateIndicator('ICHIMOKU', candles, resolveIndicatorParams('ICHIMOKU', {}));
    const after = calculateIndicator('ICHIMOKU', perturbed, resolveIndicatorParams('ICHIMOKU', {}));
    for (const output of ['tenkan', 'kijun', 'spanA', 'spanB', 'cloudTop', 'cloudBottom', 'laggingSpan']) {
      const a = before.series[output];
      const b = after.series[output];
      for (let index = 0; index < candles.length - 1; index += 1) {
        if (Number.isNaN(a[index]) && Number.isNaN(b[index])) continue;
        expect(b[index], `ichimoku ${output} changed at candle ${index}`).toBe(a[index]);
      }
    }
  });

  test('the chande forecast oscillator uses a rolling regression, not the whole series', () => {
    const candles = makeCandles({ count: 300 });
    const perturbed = lastCandlePerturbation(candles);
    const before = calculateIndicator('CFO', candles, resolveIndicatorParams('CFO', {}));
    const after = calculateIndicator('CFO', perturbed, resolveIndicatorParams('CFO', {}));
    const a = before.series.cfo;
    const b = after.series.cfo;
    for (let index = 0; index < candles.length - 1; index += 1) {
      if (Number.isNaN(a[index]) && Number.isNaN(b[index])) continue;
      expect(b[index], `cfo changed at candle ${index}`).toBe(a[index]);
    }
  });
});
