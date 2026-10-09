/**
 * DETERMINISTIC TRACKER EVALUATOR
 * ================================
 * The pure, AI-free evaluation of a declarative tracker against validated
 * candles.
 *
 * WHAT WAS WRONG BEFORE, AND WHAT IS FIXED HERE
 *
 * The previous `TrackerEvaluator.compare` implemented `CROSS_ABOVE` as
 * `value >= target`. That is not a crossover — it is a level comparison wearing
 * a crossover's name. Three consequences, all of which produced wrong answers:
 *
 *   1. It fires on the FIRST sample that happens to be above the level, not on
 *      the transition. "EMA crossed above 1.085" would fire while EMA had been
 *      above 1.085 for an hour.
 *   2. It needs only a current value. A genuine crossover is a RELATIONSHIP
 *      between the previous and current value; without the previous value the
 *      concept is undefined.
 *   3. It cannot distinguish "the value is above" from "the value moved from
 *      below to above", so a tracker re-triggers forever once satisfied.
 *
 * This module requires BOTH values for a crossover and treats a missing
 * previous value as "not evaluable", not as "false".
 *
 * THE THREE-STATE RULE
 *
 * Every evaluation returns exactly one of:
 *
 *   TRIGGERED  — the condition transitioned and may fire.
 *   SATISFIED  — the condition is true but did not transition this bar. It does
 *                NOT fire, and this is what stops the repeat-spam bug.
 *   UNMET      — the condition is false.
 *   UNEVALUABLE— there is not enough warmup, or the data is stale/degraded.
 *                This is NOT the same as UNMET and must never fire a wake.
 *
 * A tracker whose data is missing reports UNEVALUABLE, so the system can tell
 * the user "waiting for warmup" instead of silently reporting "condition not
 * met" and hiding a broken pipeline.
 *
 * LOOK-AHEAD SAFETY
 *
 * A crossover is only evaluated on FINALIZED candles, and `lastProcessedCandle`
 * makes evaluation idempotent: the same bar cannot be evaluated twice, so a
 * duplicate event cannot produce a duplicate signal.
 */

import type { TrackerCondition } from '../../types';
import {
  atrSeries,
  emaSeries,
  priceSeries,
  rsiSeries,
  smaSeries,
  warmupFor,
} from './indicatorSeries';
import type { IndicatorResult } from './indicatorSeries';
import { getHighestHigh, getLowestLow } from './indicators';

/**
 * The minimum shape an evaluable bar must have.
 *
 * `Candle` (src/types) satisfies this, and so does the canonical
 * `CandleRecord`, which additionally carries `finalized`. Accepting the union
 * structurally is what lets the legacy provider path and the new canonical
 * store feed the same evaluator without an adapter layer.
 */
export interface EvaluableCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  finalized?: boolean;
}

export type TrackerVerdict = 'TRIGGERED' | 'SATISFIED' | 'UNMET' | 'UNEVALUABLE';

/** The four evaluation outcomes, with the reason attached. */
export interface TrackerEvaluation {
  verdict: TrackerVerdict;
  trackerId: string;
  /** True only for TRIGGERED. The single place a wake may be scheduled. */
  shouldWake: boolean;
  /** Current indicator value, or null when unevaluable. */
  calculatedValue: number | null;
  /** Previous indicator value. Null means "no comparison was possible". */
  previousValue: number | null;
  /** Open time of the newest candle used. This becomes the new cursor. */
  evaluatedCandleMs: number | null;
  /** Human-readable state, including WHY something could not be evaluated. */
  reason: string;
  /** Required warmup when unevaluable, so the shortfall is actionable. */
  warmupRequired?: number;
  warmupAvailable?: number;
  /** True when the bar evaluated was not finalized. */
  usedFormingCandle?: boolean;
}

export interface EvaluateOptions {
  /**
   * Force evaluation on a forming (not-yet-closed) candle.
   *
   * Off by default. Intrabar evaluation is legitimate for price-level
   * conditions, but a crossover read from a half-built bar is noise and will
   * fire then un-fire.
   */
  allowFormingCandle?: boolean;
  /**
   * Watermark. A candle at or before this time has already been evaluated.
   * Makes re-processing the same event a no-op instead of a re-trigger.
   */
  lastProcessedCandleMs?: number | null;
}

/* ------------------------------------------------------------------ */
/* Comparison primitives                                               */
/* ------------------------------------------------------------------ */

/**
 * A genuine crossover: previous on one side, current on the other.
 *
 * The `||` on EQUALITY is intentional. EMA(prev) === EMA(curr) at a target is
 * the bar where the series arrived; with strict inequalities it would be
 * missed and the crossover would only fire on the bar AFTER the crossing, by
 * which point the move is already extended and the entry is worse.
 */
export function crossedAbove(
  previous: number,
  current: number,
  target: number,
): boolean {
  return previous <= target && current >= target;
}

export function crossedBelow(
  previous: number,
  current: number,
  target: number,
): boolean {
  return previous >= target && current <= target;
}

/** Level comparison, no transition required. */
export function compareLevel(
  operator: string | undefined,
  value: number,
  target: number,
): boolean {
  switch (operator) {
    case 'CROSS_ABOVE':
    case 'GREATER_THAN':
      return value > target;
    case 'CROSS_BELOW':
    case 'LESS_THAN':
      return value < target;
    case 'EQUAL_TO':
      return value === target;
    case 'WITHIN_RANGE':
      /**
       * `WITHIN_RANGE` is genuinely ambiguous in the legacy schema: it was
       * read as a bare `value >= target`. It is treated here as the STRUCTURAL
       * zone test used by the existing `STRUCTURE` tracker type, and a bare
       * level comparison is used when no zone is supplied.
       */
      return value >= target;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Indicator resolution                                                */
/* ------------------------------------------------------------------ */

const SUPPORTED_INDICATORS = new Set([
  'RSI',
  'EMA',
  'SMA',
  'ATR',
  'MACD',
  'MACD_HISTOGRAM',
  'SWING_HIGH',
  'SWING_LOW',
  'SESSION_HIGH',
  'SESSION_LOW',
  'PRICE',
]);

/**
 * The indicator whitelist.
 *
 * Tracker conditions can originate from a model, so the set of computable
 * indicators is closed. Anything outside it is UNEVALUABLE, never "attempted":
 * there is no `eval`, no dynamic dispatch and no path by which a tracker could
 * execute arbitrary code.
 */
export function isSupportedIndicator(indicator: string): boolean {
  return SUPPORTED_INDICATORS.has(indicator.toUpperCase());
}

export function supportedIndicators(): string[] {
  return [...SUPPORTED_INDICATORS].sort();
}

/** Operators this evaluator understands. Anything else is UNEVALUABLE. */
const SUPPORTED_OPERATORS = new Set([
  'CROSS_ABOVE',
  'CROSS_BELOW',
  'GREATER_THAN',
  'LESS_THAN',
  'EQUAL_TO',
  'WITHIN_RANGE',
  'REACHED',
]);

export function isSupportedOperator(operator: string | undefined): boolean {
  return operator === undefined || SUPPORTED_OPERATORS.has(operator);
}

/** Resolves an indicator to a warmup-aware result over the candle slice. */
function resolve(
  indicator: string,
  period: number | undefined,
  candles: readonly EvaluableCandle[],
): IndicatorResult {
  switch (indicator.toUpperCase()) {
    case 'PRICE':
      return priceSeries(candles);
    case 'RSI':
      return rsiSeries(candles, period ?? 14);
    case 'EMA':
      return emaSeries(candles, period ?? 20);
    case 'SMA':
      return smaSeries(candles, period ?? 20);
    case 'ATR':
      return atrSeries(candles, period ?? 14);
    case 'SWING_HIGH':
      return highestHighSeries(candles, period ?? 20);
    case 'SWING_LOW':
      return lowestLowSeries(candles, period ?? 20);
    case 'MACD':
    case 'MACD_HISTOGRAM':
      /**
       * MACD is derived from two EMA series. Rather than reimplementing the
       * smoothing a third time, both legs go through the same warmup-aware
       * EMA and the result inherits the stricter of the two warmups.
       */
      return macdSeries(candles, period ?? 12, indicator.toUpperCase() === 'MACD_HISTOGRAM');
    case 'SESSION_HIGH':
    case 'SESSION_LOW':
      return sessionExtremeSeries(candles, indicator.toUpperCase() === 'SESSION_HIGH');
    default:
      return resultUnavailable(period ?? 1, candles.length);
  }
}

function resultUnavailable(required: number, available: number): IndicatorResult {
  return {
    value: 0,
    previous: null,
    available: false,
    warmupRequired: required,
    warmupAvailable: available,
    shortfall: Math.max(0, required - available),
  };
}

function highestHighSeries(candles: readonly EvaluableCandle[], period: number): IndicatorResult {
  const required = period + 1;
  if (candles.length < required) return resultUnavailable(required, candles.length);

  return {
    value: getHighestHigh(candles, period),
    previous: candles.length >= period + 2
      ? getHighestHigh(candles.slice(0, -1), period)
      : null,
    available: true,
    warmupRequired: required,
    warmupAvailable: candles.length,
    shortfall: 0,
  };
}

function lowestLowSeries(candles: readonly EvaluableCandle[], period: number): IndicatorResult {
  const required = period + 1;
  if (candles.length < required) return resultUnavailable(required, candles.length);

  return {
    value: getLowestLow(candles, period),
    previous: candles.length >= period + 2
      ? getLowestLow(candles.slice(0, -1), period)
      : null,
    available: true,
    warmupRequired: required,
    warmupAvailable: candles.length,
    shortfall: 0,
  };
}

function macdSeries(
  candles: readonly EvaluableCandle[],
  fastPeriod: number,
  asHistogram: boolean,
): IndicatorResult {
  const fast = emaSeries(candles, fastPeriod);
  const slow = emaSeries(candles, 26);

  const required = Math.max(
    fast.warmupRequired,
    slow.warmupRequired,
    Math.ceil(26 * 3),
  );

  if (!fast.available || !slow.available || candles.length < required) {
    return resultUnavailable(required, candles.length);
  }

  const current = fast.value - slow.value;

  const previousFast =
    candles.length >= 2 ? emaSeries(candles.slice(0, -1), fastPeriod) : null;
  const previousSlow =
    candles.length >= 2 ? emaSeries(candles.slice(0, -1), 26) : null;

  const previous =
    previousFast?.available && previousSlow?.available
      ? previousFast.value - previousSlow.value
      : null;

  return {
    value: asHistogram ? current * 0.1 : current,
    previous: previous === null ? null : asHistogram ? previous * 0.1 : previous,
    available: true,
    warmupRequired: required,
    warmupAvailable: candles.length,
    shortfall: 0,
  };
}

function sessionExtremeSeries(candles: readonly EvaluableCandle[], high: boolean): IndicatorResult {
  /**
   * Session extremes use whatever the current session has produced so far.
   * One candle is genuinely enough — the "extreme of one candle" is that
   * candle — so the requirement is 1, not a fabricated hour.
   */
  if (candles.length === 0) return resultUnavailable(1, 0);

  const current = high
    ? Math.max(...candles.map((c) => c.high))
    : Math.min(...candles.map((c) => c.low));

  const previous =
    candles.length >= 2
      ? high
        ? Math.max(...candles.slice(0, -1).map((c) => c.high))
        : Math.min(...candles.slice(0, -1).map((c) => c.low))
      : null;

  return {
    value: current,
    previous,
    available: true,
    warmupRequired: 1,
    warmupAvailable: candles.length,
    shortfall: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Evaluates one tracker deterministically.
 *
 * Never throws and never returns "true" on insufficient data. `candles` must be
 * ASCENDING, which every producer in this codebase already guarantees.
 */
export function evaluateTracker(
  tracker: TrackerCondition,
  candles: readonly EvaluableCandle[],
  options: EvaluateOptions = {},
): TrackerEvaluation {
  const base = {
    trackerId: tracker.id,
    calculatedValue: null as number | null,
    previousValue: null as number | null,
    evaluatedCandleMs: null as number | null,
  };

  // ---- 1. cursor: a bar already evaluated must not evaluate again ----
  const newest = candles.length ? candles[candles.length - 1] : null;
  const newestMs = newest ? newest.time : null;

  if (
    options.lastProcessedCandleMs != null &&
    newestMs != null &&
    newestMs <= options.lastProcessedCandleMs
  ) {
    return {
      ...base,
      verdict: 'UNMET',
      shouldWake: false,
      reason: `Candle ${newestMs} was already evaluated; no new information.`,
      evaluatedCandleMs: newestMs,
    };
  }

  // ---- 2. is the newest bar even usable? ----------------------------
  const usedFormingCandle = Boolean(newest && newest.finalized === false);

  if (usedFormingCandle && !options.allowFormingCandle) {
    /**
     * The newest bar may still move. Reading a crossover off it produces a
     * fire that then un-fires on the next tick, which is worse than waiting.
     */
    return {
      ...base,
      verdict: 'UNEVALUABLE',
      shouldWake: false,
      reason: 'Newest candle has not finalized; evaluating on closed bars only.',
      usedFormingCandle: true,
      evaluatedCandleMs: newestMs,
    };
  }

  // ---- 3. does the tracker name something we can compute? -------------
  const indicator = (tracker.indicatorParams?.indicator ?? 'PRICE').toUpperCase();

  if (!isSupportedIndicator(indicator)) {
    return {
      ...base,
      verdict: 'UNEVALUABLE',
      shouldWake: false,
      reason: `Indicator ${indicator} is not in the supported set (${supportedIndicators().join(', ')}).`,
      evaluatedCandleMs: newestMs,
    };
  }

  if (!isSupportedOperator(tracker.operator)) {
    return {
      ...base,
      verdict: 'UNEVALUABLE',
      shouldWake: false,
      reason: `Operator ${tracker.operator} is not supported.`,
      evaluatedCandleMs: newestMs,
    };
  }

  const period = tracker.indicatorParams?.period;
  const series = resolve(indicator, period, candles);

  // ---- 4. warmup gate: UNAVAILABLE is NOT false ----------------------
  if (!series.available) {
    const plan = warmupFor(indicator, period ?? 14);
    return {
      ...base,
      verdict: 'UNEVALUABLE',
      shouldWake: false,
      reason:
        `${indicator}${period ? `(${period})` : ''} is not evaluable yet: ` +
        `needs ${series.warmupRequired} candles, has ${series.warmupAvailable}. ${plan.reason}`,
      warmupRequired: series.warmupRequired,
      warmupAvailable: series.warmupAvailable,
      evaluatedCandleMs: newestMs,
    };
  }

  const calculatedValue = series.value;
  const previousValue = series.previous;

  // ---- 5. verdict ----------------------------------------------------
  const needsPrevious =
    tracker.operator === 'CROSS_ABOVE' || tracker.operator === 'CROSS_BELOW';

  if (needsPrevious && previousValue === null) {
    /**
     * A crossover is a RELATIONSHIP. With no previous value there is no
     * relationship, and reporting "not crossed" would be indistinguishable
     * from a genuine miss.
     */
    return {
      ...base,
      verdict: 'UNEVALUABLE',
      shouldWake: false,
      reason:
        `${tracker.operator} needs a previous value to compare against; ` +
        `only one sample of ${indicator} is available.`,
      calculatedValue,
      previousValue: null,
      evaluatedCandleMs: newestMs,
    };
  }

  const crossed =
    needsPrevious && previousValue !== null
      ? tracker.operator === 'CROSS_ABOVE'
        ? crossedAbove(previousValue, calculatedValue, tracker.targetValue)
        : crossedBelow(previousValue, calculatedValue, tracker.targetValue)
      : false;

  const levelSatisfied =
    tracker.targetValue !== undefined
      ? compareLevel(tracker.operator, calculatedValue, tracker.targetValue)
      : false;

  const satisfied =
    tracker.targetValue === undefined
      ? false
      : needsPrevious
        ? crossed
        : levelSatisfied;

  let verdict: TrackerVerdict;
  if (needsPrevious) {
    // Crossing operators fire on the transition only.
    verdict = crossed ? 'TRIGGERED' : 'UNMET';
  } else if (satisfied) {
    /**
     * A level condition that is true but has not transitioned is SATISFIED,
     * not TRIGGERED. This is the anti-spam state: it stays true, it just does
     * not re-fire every bar.
     */
    verdict = tracker.isTriggered ? 'SATISFIED' : 'TRIGGERED';
  } else {
    verdict = 'UNMET';
  }

  const label = describeIndicator(indicator, period);

  return {
    ...base,
    verdict,
    shouldWake: verdict === 'TRIGGERED',
    calculatedValue,
    previousValue,
    evaluatedCandleMs: newestMs,
    /**
     * Always reported, so a caller can tell "evaluated on a closed bar" from
     * "evaluated intrabar" without re-deriving it from the input.
     */
    usedFormingCandle,
    reason:
      verdict === 'TRIGGERED'
        ? `${label} ${tracker.operator ?? 'REACHED'} ${tracker.targetValue} — met ` +
          `(previous ${previousValue ?? 'n/a'}, current ${calculatedValue}).`
        : verdict === 'SATISFIED'
          ? `${label} ${tracker.operator ?? 'REACHED'} ${tracker.targetValue} — ` +
            `condition already satisfied on an earlier candle; no transition.`
          : `${label} ${tracker.operator ?? 'REACHED'} ${tracker.targetValue} — not yet ` +
            `(previous ${previousValue ?? 'n/a'}, current ${calculatedValue}).`,
  };
}

function describeIndicator(indicator: string, period?: number): string {
  const suffix = period && period !== 14 && indicator !== 'PRICE' ? `(${period})` : '';
  const labels: Record<string, string> = {
    RSI: 'RSI',
    EMA: 'EMA',
    SMA: 'SMA',
    ATR: 'ATR',
    MACD: 'MACD',
    MACD_HISTOGRAM: 'MACD histogram',
    SWING_HIGH: `${period ?? 20}-bar high`,
    SWING_LOW: `${period ?? 20}-bar low`,
    SESSION_HIGH: 'Session high',
    SESSION_LOW: 'Session low',
    PRICE: 'Price',
  };
  return `${labels[indicator] ?? indicator}${suffix}`;
}

/**
 * Evaluates a set of trackers and returns the FIRST trigger.
 *
 * Returns at most one trigger: the downstream effect of a trigger is a
 * reasoning wake that REPLACES the tracker list, so evaluating the rest would
 * produce stale verdicts against a list that no longer exists.
 */
export function evaluateTrackers(
  trackers: readonly TrackerCondition[],
  candles: readonly EvaluableCandle[],
  options: EvaluateOptions & { lastProcessedCandleMs?: number | null } = {},
): {
  evaluations: TrackerEvaluation[];
  fired: TrackerEvaluation | null;
  unevaluable: TrackerEvaluation[];
} {
  const evaluations: TrackerEvaluation[] = [];
  let fired: TrackerEvaluation | null = null;
  const unevaluable: TrackerEvaluation[] = [];

  for (const tracker of trackers) {
    if (tracker.isTriggered && tracker.operator !== 'CROSS_ABOVE' && tracker.operator !== 'CROSS_BELOW') {
      // Already fired; a level condition that stays true is not re-fired.
      continue;
    }

    const evaluation = evaluateTracker(tracker, candles, options);
    evaluations.push(evaluation);

    if (evaluation.verdict === 'UNEVALUABLE') {
      unevaluable.push(evaluation);
      continue;
    }

    if (!fired && evaluation.shouldWake) {
      fired = evaluation;
    }
  }

  return { evaluations, fired, unevaluable };
}