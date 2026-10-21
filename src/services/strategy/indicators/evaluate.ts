import type { Candle } from '../../../types';
import { calculateIndicator } from './calculations';
import { defaultIndicatorOutput, indicatorCatalogEntry, resolveIndicatorParams } from './catalog';
import { resolveOperandOutput, type StrategyCondition, type StrategyDefinition, type StrategyIndicator, type StrategyOperand } from '../schema';

/**
 * EVALUATION CONTEXT
 * ==================
 *
 * One context holds the candles of a run and the series of every indicator
 * the strategy uses. Every indicator is calculated ONCE, and every output of
 * that indicator is then read from the same series.
 *
 * That matters for two reasons.
 *
 *   Speed. A backtest over a few thousand candles used to recompute the
 *   whole history of an indicator for every operand of every candle.
 *
 *   Correctness. One series per indicator means a condition and the
 *   strategy summary can never disagree about the same number.
 *
 * The context is index based. `point(...)` answers "what was the value of
 * this output at candle i", and only candles up to and including i are ever
 * consulted, which is what keeps the evaluator free of look-ahead.
 */

export interface IndicatorPoint {
  /** The value at the index. Only meaningful when `available` is true. */
  value: number;
  /** The value at the previous candle. */
  previous: number | null;
  /** False when the indicator has no trustworthy value at this index. */
  available: boolean;
}

export interface OperandValue {
  current: number;
  previous: number | null;
  available: boolean;
}

export class StrategyEvaluationContext {
  readonly definition: StrategyDefinition;
  readonly candles: readonly Candle[];
  private readonly indicators = new Map<string, StrategyIndicator>();
  private readonly cache = new Map<string, Record<string, number[]>>();

  constructor(definition: StrategyDefinition, candles: readonly Candle[]) {
    this.definition = definition;
    this.candles = candles;
    for (const indicator of definition.indicators) this.indicators.set(indicator.id, indicator);
  }

  /** The series of every output of one indicator, calculated once. */
  series(indicatorId: string): Record<string, number[]> | null {
    const cached = this.cache.get(indicatorId);
    if (cached) return cached;
    const indicator = this.indicators.get(indicatorId);
    if (!indicator) return null;
    const entry = indicatorCatalogEntry(indicator.type);
    if (!entry) return null;
    const calculated = calculateIndicator(indicator.type, this.candles, resolveIndicatorParams(indicator.type, indicator.params));
    this.cache.set(indicatorId, calculated.series);
    return calculated.series;
  }

  /** The value of one indicator output at one candle. */
  point(indicatorId: string, output: string | undefined, index: number): IndicatorPoint {
    const indicator = this.indicators.get(indicatorId);
    const series = this.series(indicatorId);
    if (!indicator || !series) return { value: Number.NaN, previous: null, available: false };
    const key = output ?? indicator.output ?? defaultIndicatorOutput(indicator.type);
    const values = series[key];
    if (!values) return { value: Number.NaN, previous: null, available: false };
    const value = values[index];
    const previous = index > 0 ? values[index - 1] : null;
    const available = Number.isFinite(value);
    return { value: available ? value : Number.NaN, previous: previous !== null && Number.isFinite(previous) ? previous : null, available };
  }

  /** The value of a condition operand at one candle. */
  operand(operand: StrategyOperand, index: number): OperandValue {
    if (operand.kind === 'constant') return { current: operand.value, previous: operand.value, available: true };
    if (operand.kind === 'indicator') {
      const indicator = this.indicators.get(operand.indicatorId);
      if (!indicator) return { current: Number.NaN, previous: null, available: false };
      const output = resolveOperandOutput(indicator, operand);
      const point = this.point(operand.indicatorId, output, index);
      return { current: point.value, previous: point.previous, available: point.available };
    }
    if (operand.field === 'close') {
      const current = this.candles[index]?.close;
      const previous = index > 0 ? this.candles[index - 1]?.close : undefined;
      return {
        current: typeof current === 'number' ? current : Number.NaN,
        previous: typeof previous === 'number' ? previous : null,
        available: typeof current === 'number' && Number.isFinite(current),
      };
    }
    const current = this.candles[index]?.[operand.field];
    const previous = index > 0 ? this.candles[index - 1]?.[operand.field] : undefined;
    return {
      current: typeof current === 'number' ? current : Number.NaN,
      previous: typeof previous === 'number' ? previous : null,
      available: typeof current === 'number' && Number.isFinite(current),
    };
  }
}

/** The number of candles a condition tree needs before it can be evaluated. */
export function conditionWarmup(condition: StrategyCondition, definition: StrategyDefinition): number {
  let required = 1;
  const visit = (node: StrategyCondition) => {
    switch (node.type) {
      case 'comparison': {
        for (const operand of [node.left, node.right]) {
          if (operand.kind !== 'indicator') continue;
          const indicator = definition.indicators.find(item => item.id === operand.indicatorId);
          if (!indicator) continue;
          const entry = indicatorCatalogEntry(indicator.type);
          if (!entry) continue;
          required = Math.max(required, entry.warmup(resolveIndicatorParams(indicator.type, indicator.params)));
        }
        return;
      }
      case 'price_action': {
        required = Math.max(required, node.params.lookback + 1);
        if (node.params.requireVolumeConfirmation) required = Math.max(required, node.params.volumePeriod + 1);
        return;
      }
      case 'not': visit(node.condition); return;
      case 'all':
      case 'any': node.conditions.forEach(visit); return;
      case 'sequence':
        node.steps.forEach(visit);
        required = Math.max(required, node.maxGapCandles + 1);
        return;
      default: return;
    }
  };
  visit(condition);
  return required;
}
