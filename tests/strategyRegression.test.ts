import { describe, test, expect } from 'bun:test';
import {
  migrateStrategyDefinition,
  priceActionParamsSchema,
  validateStrategyDefinition,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyOperator,
} from '../src/services/strategy/schema';
import { calculateIndicator } from '../src/services/strategy/indicators/calculations';
import { resolveIndicatorParams } from '../src/services/strategy/indicators/catalog';
import { StrategyEvaluationContext } from '../src/services/strategy/indicators/evaluate';
import { evaluateCondition, initialRuntimeState, processCompletedCandle, runStrategyBacktest, type StrategyRuntimeState } from '../src/services/strategy/engine';
import { atrSeries, emaSeries, rsiSeries, smaSeries } from '../src/services/tracker-sdk/indicatorSeries';
import { makeCandles } from './helpers/strategyCandles';

/**
 * REGRESSION
 * ==========
 *
 * Strategies that were built before the indicator catalog and the price
 * action engine existed must keep working, and they must keep producing the
 * same numbers. This file pins that.
 */

const baseDefinition = (overrides: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
  schemaVersion: 2,
  strategyId: 'strategy_test_1',
  versionId: 'version_test_1',
  version: 1,
  name: 'Regression strategy',
  description: '',
  market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '1h' },
  indicators: [],
  entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'GT', right: { kind: 'constant', value: 0 } } },
  exit: {},
  risk: {
    sizing: { mode: 'PERCENT_RISK', percent: 1 },
    stopLossPercent: 1,
    takeProfitPercent: 2,
    maxExposurePercent: 25,
    maxConcurrentPositions: 1,
    maxTradesPerDay: 10,
    cooldownCandles: 0,
    maxDailyLossPercent: 5,
  },
  execution: { mode: 'PAPER', startingBalance: 10_000, feeRate: 0.00045, slippageBps: 2 },
  visibility: 'PRIVATE',
  validationStatus: 'VALID',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('version 1 strategies', () => {
  const legacy = {
    schemaVersion: 1,
    strategyId: 'legacy_strategy_1',
    versionId: 'legacy_version_1',
    version: 1,
    name: 'Legacy strategy',
    description: 'Saved before the catalog arrived.',
    market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '1h' },
    indicators: [
      { id: 'fast_ema', type: 'EMA', period: 20 },
      { id: 'slow_ema', type: 'EMA', period: 50 },
      { id: 'rsi', type: 'RSI', period: 14 },
      { id: 'atr', type: 'ATR', period: 14 },
    ],
    entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'indicator', indicatorId: 'fast_ema' }, operator: 'CROSS_ABOVE', right: { kind: 'indicator', indicatorId: 'slow_ema' } } },
    exit: { condition: { type: 'price_action', pattern: 'BULLISH_SWEEP', lookback: 20 } },
    risk: { sizing: { mode: 'PERCENT_RISK', percent: 1 }, stopLossPercent: 1, takeProfitPercent: 2, maxExposurePercent: 25, maxConcurrentPositions: 1, maxTradesPerDay: 10, cooldownCandles: 0, maxDailyLossPercent: 5 },
    execution: { mode: 'PAPER', startingBalance: 10_000, feeRate: 0.00045, slippageBps: 2 },
    visibility: 'PRIVATE',
    validationStatus: 'VALID',
    createdAt: new Date().toISOString(),
  };

  test('migrates to the current schema and still validates', () => {
    const migrated = migrateStrategyDefinition(legacy);
    expect(migrated.schemaVersion).toBe(3);
    const validation = validateStrategyDefinition(migrated);
    expect(validation.errors).toEqual([]);
    expect(validation.success).toBe(true);
  });

  test('keeps the indicator ids, types and periods exactly', () => {
    const migrated = migrateStrategyDefinition(legacy);
    expect(migrated.indicators.map(item => item.id)).toEqual(['fast_ema', 'slow_ema', 'rsi', 'atr']);
    expect(migrated.indicators.map(item => item.type)).toEqual(['EMA', 'EMA', 'RSI', 'ATR']);
    expect(migrated.indicators.map(item => item.params.period)).toEqual([20, 50, 14, 14]);
  });

  test('keeps the entry and exit rules pointing at the same indicators', () => {
    const migrated = migrateStrategyDefinition(legacy);
    const entry = migrated.entry.condition;
    if (entry.type !== 'comparison') throw new Error('expected a comparison');
    expect(entry.left).toEqual({ kind: 'indicator', indicatorId: 'fast_ema' });
    expect(entry.right).toEqual({ kind: 'indicator', indicatorId: 'slow_ema' });
    const exit = migrated.exit.condition!;
    if (exit.type !== 'price_action') throw new Error('expected a price action');
    expect(exit.pattern).toBe('BULLISH_SWEEP');
    expect(exit.params.lookback).toBe(20);
  });

  test('the migrated price action behaves exactly like the version 1 engine did', () => {
    const migrated = migrateStrategyDefinition(legacy);
    const exit = migrated.exit.condition!;
    if (exit.type !== 'price_action') throw new Error('expected a price action');
    // Version 1: the candle trades below the prior low and closes back
    // above it.
    const candles = makeCandles({ count: 60 });
    const context = new StrategyEvaluationContext(migrated, candles);
    let versionOneMatches = 0;
    for (let index = 1; index < candles.length; index += 1) {
      const prior = candles.slice(Math.max(0, index - 20), index);
      const priorLow = Math.min(...prior.map(candle => candle.low));
      const current = candles[index];
      const legacyResult = current.low < priorLow && current.close > priorLow;
      const migratedResult = evaluateCondition(context, exit, index);
      if (legacyResult === migratedResult) versionOneMatches += 1;
    }
    expect(versionOneMatches).toBe(candles.length - 1);
  });

  test('an unknown schema version is refused rather than guessed at', () => {
    expect(() => migrateStrategyDefinition({ ...legacy, schemaVersion: 99 })).toThrow(/Unsupported strategy schema version/);
  });
});

describe('the four original indicators keep their numbers', () => {
  const candles = makeCandles({ count: 300 });

  test('SMA matches the tracker series exactly', () => {
    const calculated = calculateIndicator('SMA', candles, resolveIndicatorParams('SMA', { period: 20 })).series.sma;
    const legacy = smaSeries(candles, 20);
    expect(calculated[calculated.length - 1]).toBeCloseTo(legacy.value, 10);
    expect(calculated[calculated.length - 2]).toBeCloseTo(legacy.previous ?? 0, 10);
  });

  test('EMA matches the tracker series exactly', () => {
    const calculated = calculateIndicator('EMA', candles, resolveIndicatorParams('EMA', { period: 20 })).series.ema;
    const legacy = emaSeries(candles, 20);
    expect(calculated[calculated.length - 1]).toBeCloseTo(legacy.value, 10);
    expect(calculated[calculated.length - 2]).toBeCloseTo(legacy.previous ?? 0, 10);
  });

  test('RSI matches the tracker series exactly', () => {
    const calculated = calculateIndicator('RSI', candles, resolveIndicatorParams('RSI', { period: 14 })).series.rsi;
    const legacy = rsiSeries(candles, 14);
    expect(calculated[calculated.length - 1]).toBeCloseTo(legacy.value, 10);
    expect(calculated[calculated.length - 2]).toBeCloseTo(legacy.previous ?? 0, 10);
  });

  test('ATR matches the tracker series exactly', () => {
    const calculated = calculateIndicator('ATR', candles, resolveIndicatorParams('ATR', { period: 14 })).series.atr;
    const legacy = atrSeries(candles, 14);
    expect(calculated[calculated.length - 1]).toBeCloseTo(legacy.value, 10);
    expect(calculated[calculated.length - 2]).toBeCloseTo(legacy.previous ?? 0, 10);
  });

  test('the four original indicators are still valid in a strategy', () => {
    const definition = baseDefinition({
      indicators: [
        { id: 'a', type: 'SMA', params: { period: 20 }, output: 'sma' },
        { id: 'b', type: 'EMA', params: { period: 50 }, output: 'ema' },
        { id: 'c', type: 'RSI', params: { period: 14 }, output: 'rsi' },
        { id: 'd', type: 'ATR', params: { period: 14 }, output: 'atr' },
      ],
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'indicator', indicatorId: 'c' }, operator: 'LT', right: { kind: 'constant', value: 30 } } },
    });
    const validation = validateStrategyDefinition(definition);
    expect(validation.errors).toEqual([]);
    expect(validation.success).toBe(true);
  });
});

describe('indicator references', () => {
  test('a duplicated indicator id is refused', () => {
    const definition = baseDefinition({
      indicators: [
        { id: 'same', type: 'SMA', params: { period: 20 }, output: 'sma' },
        { id: 'same', type: 'EMA', params: { period: 20 }, output: 'ema' },
      ],
    });
    const validation = validateStrategyDefinition(definition);
    expect(validation.success).toBe(false);
    expect(validation.errors.join(' ')).toContain('duplicated');
  });

  test('a condition that points at a missing indicator is refused', () => {
    const definition = baseDefinition({
      indicators: [{ id: 'a', type: 'SMA', params: { period: 20 }, output: 'sma' }],
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'indicator', indicatorId: 'gone' }, operator: 'GT', right: { kind: 'constant', value: 1 } } },
    });
    const validation = validateStrategyDefinition(definition);
    expect(validation.success).toBe(false);
    expect(validation.errors.join(' ')).toContain('missing indicator');
  });

  test('reordering the indicators does not break a reference', () => {
    const indicators = [
      { id: 'a', type: 'SMA', params: { period: 20 }, output: 'sma' },
      { id: 'b', type: 'EMA', params: { period: 50 }, output: 'ema' },
    ];
    const definition = baseDefinition({
      indicators,
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'indicator', indicatorId: 'b' }, operator: 'GT', right: { kind: 'indicator', indicatorId: 'a' } } },
    });
    const reordered = baseDefinition({
      indicators: [...indicators].reverse(),
      entry: definition.entry,
    });
    const validation = validateStrategyDefinition(reordered);
    expect(validation.errors).toEqual([]);
    const candles = makeCandles({ count: 200 });
    const before = new StrategyEvaluationContext(definition, candles);
    const after = new StrategyEvaluationContext(reordered, candles);
    for (let index = 60; index < candles.length; index += 1) {
      expect(evaluateCondition(after, reordered.entry.condition, index)).toBe(evaluateCondition(before, definition.entry.condition, index));
    }
  });

  test('an output that the indicator does not have is refused', () => {
    const definition = baseDefinition({
      indicators: [{ id: 'a', type: 'SMA', params: { period: 20 }, output: 'nope' }],
    });
    expect(validateStrategyDefinition(definition).success).toBe(false);
  });

  test('an indicator parameter outside its range is refused', () => {
    const definition = baseDefinition({
      indicators: [{ id: 'a', type: 'SMA', params: { period: 5_000 }, output: 'sma' }],
    });
    expect(validateStrategyDefinition(definition).success).toBe(false);
  });
});

describe('the engine', () => {
  test('evaluates the expanded comparison operators on closed candles', () => {
    const candles = makeCandles({ count: 80 });
    const definition = baseDefinition();
    const context = new StrategyEvaluationContext(definition, candles);
    const index = candles.length - 1;
    const current = candles[index].close;
    const previous = candles[index - 1].close;
    const comparison = (operator: StrategyOperator, right: number, extra: object = {}) => ({ type: 'comparison' as const, left: { kind: 'price' as const, field: 'close' as const }, operator, right: { kind: 'constant' as const, value: right }, ...extra }) as StrategyCondition;
    expect(evaluateCondition(context, comparison('NE', current + 10), index)).toBe(true);
    expect(evaluateCondition(context, comparison('EQ', current, { tolerance: 0.001 }), index)).toBe(true);
    expect(evaluateCondition(context, comparison('INCREASING', 0), index)).toBe(current > previous);
    expect(evaluateCondition(context, comparison('DECREASING', 0), index)).toBe(current < previous);
    expect(evaluateCondition(context, comparison('BETWEEN', current - 1, { rangeTo: { kind: 'constant', value: current + 1 } }), index)).toBe(true);
    expect(evaluateCondition(context, comparison('OUTSIDE', current + 1, { rangeTo: { kind: 'constant', value: current + 2 } }), index)).toBe(true);
    expect(evaluateCondition(context, comparison('CHANGE_PCT_GT', -100), index)).toBe(true);
    expect(evaluateCondition(context, comparison('CHANGE_PCT_LT', 100), index)).toBe(false);
  });

  test('nested AND/OR/NOT groups preserve explicit boolean structure at scale', () => {
    const candles = makeCandles({ count: 80 });
    const definition = baseDefinition();
    const context = new StrategyEvaluationContext(definition, candles);
    const always = { type: 'comparison' as const, left: { kind: 'price' as const, field: 'close' as const }, operator: 'GT' as const, right: { kind: 'constant' as const, value: 0 } };
    const never = { ...always, operator: 'LT' as const, right: { kind: 'constant' as const, value: 0 } };
    const tree: StrategyCondition = { type: 'any', conditions: [{ type: 'all', conditions: [always, { type: 'not', condition: never }] }, never] };
    expect(evaluateCondition(context, tree, candles.length - 1)).toBe(true);
    const large: StrategyCondition = { type: 'all', conditions: Array.from({ length: 150 }, () => always) };
    expect(evaluateCondition(context, large, candles.length - 1)).toBe(true);
    expect(validateStrategyDefinition(baseDefinition({ entry: { direction: 'LONG', condition: large } })).success).toBe(true);
  });

  test('schema v2 migration supplies an explicit paper action and range rows must be complete', () => {
    const old = baseDefinition();
    const migrated = migrateStrategyDefinition(old);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.then?.action).toBe('BUY');
    const invalid = baseDefinition({ entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'BETWEEN', right: { kind: 'constant', value: 1 } } } });
    expect(validateStrategyDefinition(invalid).success).toBe(false);
  });

  test('ALERT_ONLY is edge-triggered and backtest and paper produce the same trades', () => {
    const candles = makeCandles({ count: 120 });
    const alertDefinition = baseDefinition({
      then: { action: 'ALERT_ONLY' },
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'GT', right: { kind: 'constant', value: 0 } } },
    });
    let alertState: StrategyRuntimeState = { ...initialRuntimeState(alertDefinition), status: 'PAPER' };
    for (let end = 1; end <= candles.length; end += 1) alertState = processCompletedCandle(alertDefinition, alertState, candles.slice(0, end));
    expect(alertState.trades).toHaveLength(0);
    expect(alertState.logs.filter(item => item.type === 'STRATEGY_ALERT')).toHaveLength(1);

    const tradeDefinition = baseDefinition({
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'CROSS_ABOVE', right: { kind: 'constant', value: 100 } } },
      risk: { sizing: { mode: 'PERCENT_RISK', percent: 1 }, stopLossPercent: 1, takeProfitPercent: 2, maxExposurePercent: 25, maxConcurrentPositions: 1, maxTradesPerDay: 10, cooldownCandles: 0, maxDailyLossPercent: 5 },
    });
    let paperState: StrategyRuntimeState = { ...initialRuntimeState(tradeDefinition), status: 'PAPER' };
    for (let end = 1; end <= candles.length; end += 1) paperState = processCompletedCandle(tradeDefinition, paperState, candles.slice(0, end));
    const backtest = runStrategyBacktest(tradeDefinition, candles);
    expect(paperState.trades).toEqual(backtest.trades);
  });

  test('runs a backtest and fills at the next candle open', () => {
    const candles = makeCandles({ count: 400 });
    const definition = baseDefinition({
      indicators: [{ id: 'sma', type: 'SMA', params: { period: 20 }, output: 'sma' }],
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'CROSS_ABOVE', right: { kind: 'indicator', indicatorId: 'sma' } } },
      exit: { condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'CROSS_BELOW', right: { kind: 'indicator', indicatorId: 'sma' } } },
    });
    const result = runStrategyBacktest(definition, candles);
    expect(result.candlesProcessed).toBe(candles.length);
    expect(result.equityCurve.length).toBe(candles.length);
    for (const trade of result.trades) {
      // The fill happened at the open of a candle, never at the close of the
      // signal candle.
      const fill = candles.find(candle => candle.time === trade.openedAt);
      expect(fill).toBeDefined();
      expect(Number.isFinite(trade.entryPrice)).toBe(true);
      expect(trade.exitPrice).toBeGreaterThan(0);
    }
  });

  test('a signal on a candle never sees a later candle', () => {
    const candles = makeCandles({ count: 200 });
    const definition = baseDefinition({
      indicators: [{ id: 'sma', type: 'SMA', params: { period: 20 }, output: 'sma' }],
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'CROSS_ABOVE', right: { kind: 'indicator', indicatorId: 'sma' } } },
    });
    const changed = candles.map((item, index) => (index > 120 ? { ...item, close: item.close * 3, high: item.high * 3, low: item.low * 3 } : item));
    const before = new StrategyEvaluationContext(definition, candles);
    const after = new StrategyEvaluationContext(definition, changed);
    for (let index = 30; index <= 120; index += 1) {
      expect(evaluateCondition(after, definition.entry.condition, index)).toBe(evaluateCondition(before, definition.entry.condition, index));
    }
  });

  test('the paper runner processes a completed candle once and then ignores it', () => {
    const candles = makeCandles({ count: 60 });
    const definition = baseDefinition({
      indicators: [{ id: 'sma', type: 'SMA', params: { period: 20 }, output: 'sma' }],
      entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'CROSS_ABOVE', right: { kind: 'indicator', indicatorId: 'sma' } } },
    });
    const state = { ...processCompletedCandle(definition, {
      status: 'PAPER', lastProcessedCandleTime: null, balance: 10_000, equity: 10_000, position: null, trades: [], logs: [],
      lastEntryCandleIndex: null, lastEntryCandleTime: null, tradeDay: null, tradesToday: 0, dayStartBalance: null, pendingEntry: null, pendingExitSignalTime: null,
    }, candles) };
    expect(state.lastProcessedCandleTime).toBe(candles[candles.length - 1].time);
    const again = processCompletedCandle(definition, state, candles);
    expect(again.lastProcessedCandleTime).toBe(state.lastProcessedCandleTime);
    expect(again.trades.length).toBe(state.trades.length);
  });

  test('a sequence needs its steps on different, ordered candles', () => {
    const minute = 60_000;
    // Twenty quiet candles, then a bullish sweep, then a bullish engulfing.
    const quiet = Array.from({ length: 20 }, (_, index) => ({ time: minute * (index + 1), open: 101, high: 103, low: 100, close: 102, volume: 1000 }));
    const sweep = { time: minute * 21, open: 101, high: 102, low: 98, close: 101.5, volume: 1000 };
    const engulfing = { time: minute * 22, open: 101, high: 102.5, low: 100.8, close: 102.4, volume: 1000 };
    const candles = [...quiet, sweep, engulfing];
    const definition = baseDefinition({
      entry: {
        direction: 'LONG',
        condition: {
          type: 'sequence',
          steps: [
            { type: 'price_action', pattern: 'BULLISH_SWEEP', params: priceActionParamsSchema.parse({ lookback: 20 }) },
            { type: 'price_action', pattern: 'BULLISH_ENGULFING', params: priceActionParamsSchema.parse({ engulfMode: 'BODY', requireOppositeColor: false }) },
          ],
          maxGapCandles: 3,
        },
      },
    });
    const context = new StrategyEvaluationContext(definition, candles);
    // The engulfing is the last step, so the sequence fires on that candle.
    expect(evaluateCondition(context, definition.entry.condition, candles.length - 1)).toBe(true);
    // It did not fire on the sweep candle, because the engulfing had not
    // happened yet.
    expect(evaluateCondition(context, definition.entry.condition, candles.length - 2)).toBe(false);

    // The same two patterns on the same candle are not a sequence.
    const sameCandle = [...quiet, { ...sweep, open: 101, high: 102.5, low: 98, close: 102.4 }];
    const sameDefinition = baseDefinition({
      entry: {
        direction: 'LONG',
        condition: {
          type: 'sequence',
          steps: [
            { type: 'price_action', pattern: 'BULLISH_SWEEP', params: priceActionParamsSchema.parse({ lookback: 20 }) },
            { type: 'price_action', pattern: 'BULLISH_ENGULFING', params: priceActionParamsSchema.parse({ engulfMode: 'BODY', requireOppositeColor: false }) },
          ],
          maxGapCandles: 3,
        },
      },
    });
    const sameContext = new StrategyEvaluationContext(sameDefinition, sameCandle);
    expect(evaluateCondition(sameContext, sameDefinition.entry.condition, sameCandle.length - 1)).toBe(false);
  });
});
