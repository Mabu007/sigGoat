import { TrackerCondition, MarketQuote, Candle } from '../../types';
import {
  calculateRSI,
  calculateEMA,
  calculateSMA,
  calculateATR,
  calculateMACD,
  getHighestHigh,
  getLowestLow,
  detectSessionExtremes,
  analyzeMarketStructure,
} from './indicators';

/** Every indicator the tracker SDK can recompute from candles. */
export type EvaluableIndicator =
  | 'RSI'
  | 'EMA'
  | 'SMA'
  | 'ATR'
  | 'MACD'
  | 'MACD_HISTOGRAM'
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'PRICE';

export interface IndicatorSnapshot {
  price: number;
  rsi14: number;
  ema20: number;
  ema50: number;
  sma20: number;
  atr14: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  swingHigh20: number;
  swingLow20: number;
  sessionHigh: number;
  sessionLow: number;
  structureBias: 'BULLISH' | 'BEARISH' | 'RANGING';
}

/**
 * Recomputes every supported indicator ONCE from a candle slice.
 *
 * A tracker that says "EMA(50) crosses above 1.2400" is fully deterministic:
 * the model states the condition, this function computes the value, and the
 * comparison is arithmetic. No LLM runs at evaluation time.
 */
export function computeIndicatorSnapshot(
  quote: MarketQuote,
  candles: Candle[],
  lookback = 20,
): IndicatorSnapshot {
  const macd = calculateMACD(candles, 12, 26, 9);
  const london = detectSessionExtremes(candles, 'LONDON');

  return {
    price: quote.mid,
    rsi14: calculateRSI(candles, 14),
    ema20: calculateEMA(candles, 20),
    ema50: calculateEMA(candles, 50),
    sma20: calculateSMA(candles, 20),
    atr14: calculateATR(candles, 14),
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    swingHigh20: getHighestHigh(candles, lookback),
    swingLow20: getLowestLow(candles, lookback),
    sessionHigh: london.high,
    sessionLow: london.low,
    structureBias: analyzeMarketStructure(candles, quote.mid).bias,
  };
}

/** Resolves one indicator at an arbitrary period from the same candle slice. */
function resolveIndicatorValue(
  indicator: EvaluableIndicator,
  period: number | undefined,
  snapshot: IndicatorSnapshot,
  candles: Candle[],
): number | undefined {
  switch (indicator) {
    case 'PRICE':
      return snapshot.price;
    case 'RSI':
      return period && period !== 14
        ? calculateRSI(candles, period)
        : snapshot.rsi14;
    case 'EMA':
      return period && period !== 20 && period !== 50
        ? calculateEMA(candles, period)
        : period === 50
          ? snapshot.ema50
          : snapshot.ema20;
    case 'SMA':
      return period && period !== 20
        ? calculateSMA(candles, period)
        : snapshot.sma20;
    case 'ATR':
      return period && period !== 14
        ? calculateATR(candles, period)
        : snapshot.atr14;
    case 'MACD':
      return snapshot.macd;
    case 'MACD_HISTOGRAM':
      return snapshot.macdHistogram;
    case 'SWING_HIGH':
      return period
        ? getHighestHigh(candles, period)
        : snapshot.swingHigh20;
    case 'SWING_LOW':
      return period
        ? getLowestLow(candles, period)
        : snapshot.swingLow20;
    case 'SESSION_HIGH':
      return snapshot.sessionHigh;
    case 'SESSION_LOW':
      return snapshot.sessionLow;
    default:
      return undefined;
  }
}

export function formatIndicatorLabel(
  indicator: EvaluableIndicator,
  period?: number,
): string {
  switch (indicator) {
    case 'PRICE':
      return 'Price';
    case 'RSI':
      return `RSI(${period ?? 14})`;
    case 'EMA':
      return `EMA(${period ?? 20})`;
    case 'SMA':
      return `SMA(${period ?? 20})`;
    case 'ATR':
      return `ATR(${period ?? 14})`;
    case 'MACD':
      return 'MACD';
    case 'MACD_HISTOGRAM':
      return 'MACD histogram';
    case 'SWING_HIGH':
      return `${period ?? 20}-bar high`;
    case 'SWING_LOW':
      return `${period ?? 20}-bar low`;
    case 'SESSION_HIGH':
      return 'Session high';
    case 'SESSION_LOW':
      return 'Session low';
    default:
      return indicator;
  }
}

/** Applies the tracker operator to a (value, target) pair. */
function compare(
  operator: string | undefined,
  value: number,
  target: number,
): boolean {
  switch (operator) {
    case 'CROSS_ABOVE':
      return value >= target;
    case 'CROSS_BELOW':
      return value <= target;
    case 'GREATER_THAN':
      return value > target;
    case 'LESS_THAN':
      return value < target;
    case 'WITHIN_RANGE':
      return value >= target;
    default:
      return false;
  }
}

export interface TrackerEvaluationReport {
  isTriggered: boolean;
  tracker: TrackerCondition;
  calculatedValue?: number;
  marketContext: IndicatorSnapshot & {
    spread: number;
  };
  eventReason: string;
  /** Human-readable condition, e.g. "EMA(20) CROSS_ABOVE 1.085". */
  formulaDescription?: string;
  /**
   * Open time of the newest candle this verdict was computed from.
   *
   * This is the evaluation CURSOR. Downstream it becomes both the
   * duplicate-suppression key for a re-delivered event and part of the
   * notification idempotency key, so the same bar can never produce two
   * alerts. Null when no candles were available.
   */
  evaluatedCandleMs?: number | null;
}

export class TrackerEvaluator {
  /**
   * Deterministically evaluates an active tracker against a live quote and
   * recent candles. NO LLM is invoked.
   *
   * `snapshot` may be supplied when the caller already holds a computed
   * indicator set (see MarketStateStore). Passing it avoids recomputing every
   * indicator per tracker, which is what made N trackers on one symbol cost N
   * full calculations on every tick.
   */
  static evaluate(
    tracker: TrackerCondition,
    quote: MarketQuote,
    candles: Candle[],
    snapshot?: IndicatorSnapshot,
  ): TrackerEvaluationReport {
    const report = TrackerEvaluator.evaluateInternal(tracker, quote, candles, snapshot);

    /**
     * Stamp the evaluation cursor once, here, rather than threading the candle
     * slice through every return path. Downstream this is both the
     * duplicate-suppression key for a re-delivered event and part of the
     * notification idempotency key.
     */
    return {
      ...report,
      evaluatedCandleMs:
        candles.length > 0 ? candles[candles.length - 1].time : null,
    };
  }

  private static evaluateInternal(
    tracker: TrackerCondition,
    quote: MarketQuote,
    candles: Candle[],
    snapshot?: IndicatorSnapshot,
  ): TrackerEvaluationReport {
    const computed =
      snapshot ?? computeIndicatorSnapshot(quote, candles);
    const spread = quote.spread;

    const marketContext = { ...computed, spread };

    // ---- Generic indicator expression (the primary path) ----------------
    if (
      tracker.type === 'INDICATOR' ||
      tracker.type === 'EMA_CROSS' ||
      tracker.type === 'RSI_THRESHOLD'
    ) {
      return TrackerEvaluator.evaluateIndicatorExpression(
        tracker,
        quote,
        candles,
        computed,
        spread,
      );
    }

    // ---- Legacy / structural types --------------------------------------
    let isTriggered = false;
    let calculatedValue = quote.mid;
    let eventReason = '';

    switch (tracker.type) {
      case 'PRICE_LEVEL': {
        calculatedValue = quote.mid;
        if (tracker.targetValue !== undefined) {
          isTriggered = compare(
            tracker.operator,
            quote.mid,
            tracker.targetValue,
          );

          if (isTriggered) {
            const label = formatIndicatorLabel('PRICE');
            eventReason =
              `${label} ${tracker.operator ?? 'REACHED'} ${tracker.targetValue} ` +
              `(current: ${quote.mid})`;
          }
        }
        break;
      }

      case 'BREAKOUT': {
        const session = tracker.indicatorParams?.session || 'LONDON';
        const extremes = detectSessionExtremes(candles, session);
        calculatedValue =
          tracker.operator === 'CROSS_BELOW'
            ? extremes.low
            : extremes.high;

        isTriggered = compare(
          tracker.operator,
          quote.mid,
          calculatedValue,
        );

        if (isTriggered) {
          eventReason =
            `Breakout ${tracker.operator === 'CROSS_BELOW' ? 'below' : 'above'} ` +
            `the previous ${session} ${tracker.operator === 'CROSS_BELOW' ? 'low' : 'high'} ` +
            `at ${calculatedValue} (current: ${quote.mid})`;
        }
        break;
      }

      case 'STRUCTURE': {
        const structure = analyzeMarketStructure(candles, quote.mid);
        calculatedValue = quote.mid;

        if (tracker.operator === 'WITHIN_RANGE') {
          const inDemand =
            quote.mid >= structure.demandZone.low &&
            quote.mid <= structure.demandZone.high;
          const inSupply =
            quote.mid >= structure.supplyZone.low &&
            quote.mid <= structure.supplyZone.high;

          isTriggered = inDemand || inSupply;

          if (isTriggered) {
            eventReason = inDemand
              ? `Price retraced into the demand zone ` +
                `(${structure.demandZone.low} - ${structure.demandZone.high})`
              : `Price retraced into the supply zone ` +
                `(${structure.supplyZone.low} - ${structure.supplyZone.high})`;
          }
        }
        break;
      }

      case 'SPREAD': {
        calculatedValue = spread;
        if (
          tracker.targetValue !== undefined &&
          spread <= tracker.targetValue
        ) {
          isTriggered = true;
          eventReason =
            `Spread compressed to ${spread} (threshold: ${tracker.targetValue})`;
        }
        break;
      }

      default: {
        calculatedValue = quote.mid;
        if (
          tracker.targetValue !== undefined &&
          quote.mid >= tracker.targetValue
        ) {
          isTriggered = true;
          eventReason =
            `Tracked condition reached: ${tracker.description}`;
        }
        break;
      }
    }

    return TrackerEvaluator.buildReport(
      tracker,
      isTriggered,
      calculatedValue,
      eventReason,
      marketContext,
    );
  }

  /**
   * Evaluates "indicator X (period N) is in value V" — the tracker primitive
   * the AI writes and the runtime verifies.
   */
  private static evaluateIndicatorExpression(
    tracker: TrackerCondition,
    quote: MarketQuote,
    candles: Candle[],
    snapshot: IndicatorSnapshot,
    spread: number,
  ): TrackerEvaluationReport {
    const indicator = (tracker.indicatorParams?.indicator ??
      inferIndicatorFromType(tracker)) as EvaluableIndicator | undefined;

    if (!indicator) {
      return TrackerEvaluator.buildReport(
        tracker,
        false,
        undefined,
        'Tracker has no resolvable indicator.',
        { ...snapshot, spread },
      );
    }

    const period = tracker.indicatorParams?.period;
    const value = resolveIndicatorValue(
      indicator,
      period,
      snapshot,
      candles,
    );

    if (value === undefined) {
      return TrackerEvaluator.buildReport(
        tracker,
        false,
        undefined,
        `Indicator ${indicator} could not be computed from the supplied candles.`,
        { ...snapshot, spread },
      );
    }

    const target = tracker.targetValue;

    if (target === undefined) {
      return TrackerEvaluator.buildReport(
        tracker,
        false,
        value,
        `${formatIndicatorLabel(indicator, period)} = ${value} (no target set).`,
        { ...snapshot, spread },
      );
    }

    const isTriggered = compare(tracker.operator, value, target);
    const label = formatIndicatorLabel(indicator, period);
    const formula = `${label} ${tracker.operator ?? 'REACHED'} ${target}`;

    const eventReason = isTriggered
      ? `${formula} — met (current: ${value})`
      : `${formula} — not yet (current: ${value})`;

    return TrackerEvaluator.buildReport(
      tracker,
      isTriggered,
      value,
      eventReason,
      { ...snapshot, spread },
      formula,
    );
  }

  private static buildReport(
    tracker: TrackerCondition,
    isTriggered: boolean,
    calculatedValue: number | undefined,
    eventReason: string,
    marketContext: IndicatorSnapshot & { spread: number },
    formulaDescription?: string,
    candles?: readonly Candle[],
  ): TrackerEvaluationReport {
    return {
      isTriggered,
      tracker: {
        ...tracker,
        isTriggered,
        currentCalculatedValue: calculatedValue,
        triggeredAt: isTriggered
          ? Date.now()
          : tracker.triggeredAt,
      },
      calculatedValue,
      marketContext,
      eventReason,
      formulaDescription:
        formulaDescription ?? tracker.formulaDescription,
      evaluatedCandleMs:
        candles && candles.length ? candles[candles.length - 1].time : null,
    };
  }
}

function inferIndicatorFromType(
  tracker: TrackerCondition,
): EvaluableIndicator | undefined {
  if (tracker.type === 'RSI_THRESHOLD') return 'RSI';
  if (tracker.type === 'EMA_CROSS') return 'EMA';
  return undefined;
}
