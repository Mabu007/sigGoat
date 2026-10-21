import { z } from 'zod';
import {
  defaultIndicatorOutput,
  indicatorCatalogEntry,
  validateIndicatorOutput,
  validateIndicatorParams,
} from './indicators/catalog';

/**
 * STRATEGY SCHEMA
 * ===============
 *
 * Two versions live here.
 *
 *   version 1  the shape that shipped first: four indicators (SMA, EMA, RSI,
 *               ATR), one price-action pattern list, one `lookback` number.
 *   version 2  the current shape: the full indicator catalog with named
 *               parameters and selectable outputs, configurable price-action
 *               patterns, and a `sequence` condition for "A and then B".
 *
 * Version 1 strategies are MIGRATED, never reinterpreted. The migration is
 * explicit, versioned and deterministic: every version 1 price-action
 * condition becomes a version 2 condition whose parameters reproduce the
 * version 1 behaviour exactly, and every version 1 indicator keeps its id,
 * its type and its period.
 */

export const STRATEGY_SCHEMA_VERSION = 3 as const;
export const LEGACY_STRATEGY_SCHEMA_VERSION = 1 as const;
export const PREVIOUS_STRATEGY_SCHEMA_VERSION = 2 as const;

/* ------------------------------------------------------------------ */
/* Operands                                                            */
/* ------------------------------------------------------------------ */

const finite = z.number().finite();
const positive = finite.positive();

export const operandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('price'), field: z.enum(['open', 'high', 'low', 'close', 'volume']) }).strict(),
  z.object({
    kind: z.literal('indicator'),
    indicatorId: z.string().min(1).max(64),
    output: z.string().min(1).max(48).optional(),
  }).strict(),
  z.object({ kind: z.literal('constant'), value: finite }).strict(),
]);

export type StrategyOperand =
  | { kind: 'price'; field: 'open' | 'high' | 'low' | 'close' | 'volume' }
  | { kind: 'indicator'; indicatorId: string; output?: string }
  | { kind: 'constant'; value: number };

export type StrategyOperator = 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NE' | 'CROSS_ABOVE' | 'CROSS_BELOW' | 'INCREASING' | 'DECREASING' | 'BETWEEN' | 'OUTSIDE' | 'CHANGE_PCT_GT' | 'CHANGE_PCT_LT';

export interface StrategyComparisonCondition {
  type: 'comparison';
  left: StrategyOperand;
  operator: StrategyOperator;
  right: StrategyOperand;
  rangeTo?: StrategyOperand;
  tolerance?: number;
}

/* ------------------------------------------------------------------ */
/* Price action                                                        */
/* ------------------------------------------------------------------ */

export const PRICE_ACTION_PATTERNS = [
  'BULLISH_SWEEP',
  'BEARISH_SWEEP',
  'BREAKOUT_HIGH',
  'BREAKOUT_LOW',
  'BREAKOUT_RETEST_HIGH',
  'BREAKOUT_RETEST_LOW',
  'BULLISH_ENGULFING',
  'BEARISH_ENGULFING',
  'BULLISH_PIN_BAR',
  'BEARISH_PIN_BAR',
] as const;

export type PriceActionPattern = typeof PRICE_ACTION_PATTERNS[number];

/**
 * The parameters of a price-action condition. Every one of them has a
 * default, and a persisted strategy always stores the full set, so the
 * behaviour of a saved strategy never depends on a later change of default.
 */
export const priceActionParamsSchema = z.object({
  /** Candles examined before the signal candle. */
  lookback: z.number().int().min(2).max(500).default(20),
  /** How a penetration or a breakout distance is measured. */
  distanceMode: z.enum(['TICKS', 'PERCENT']).default('TICKS'),
  /** Minimum penetration of the reference level, in ticks or percent. */
  minPenetration: finite.min(0).max(1_000_000).default(0),
  /** The candle must close back inside the reference level. */
  requireCloseBack: z.boolean().default(true),
  /** The candle must close in the direction of the pattern. */
  requireDirection: z.boolean().default(false),
  /** The sweeping wick must be at least this many times the body. 0 disables it. */
  minWickBodyRatio: finite.min(0).max(100).default(0),
  /** The close (or the high) must be this far beyond the reference level. */
  minBreakoutDistance: finite.min(0).max(1_000_000).default(0),
  /** The breakout must be confirmed by the close, not only by the wick. */
  requireCloseConfirmation: z.boolean().default(true),
  /** The breakout must be confirmed by volume. */
  requireVolumeConfirmation: z.boolean().default(false),
  /** How much volume the breakout candle needs, as a multiple of the average. */
  volumeMultiplier: finite.min(0).max(1_000).default(1.5),
  /** Candles used for the average volume. */
  volumePeriod: z.number().int().min(2).max(500).default(20),
  /** The breakout must be a new event, not a continuation of an old one. */
  requireNewEvent: z.boolean().default(true),
  /** How much of the previous candle the engulfing candle must cover. */
  engulfMode: z.enum(['BODY', 'FULL_RANGE']).default('BODY'),
  /** Minimum body size, as a percentage of the candle range. */
  minBodySize: finite.min(0).max(100).default(0),
  /** The previous candle must close against the current one. */
  requireOppositeColor: z.boolean().default(true),
  /** The dominant wick must be at least this many times the body. */
  minWickRatio: finite.min(0).max(100).default(2),
  /** The dominant wick must cover this percentage of the candle range. */
  minDominantWickPercent: finite.min(0).max(100).default(55),
  /** The opposing wick may cover at most this percentage of the range. */
  maxOpposingWickPercent: finite.min(0).max(100).default(25),
  /** How far below a broken level a retest may reach, as a fraction. */
  retestTolerance: finite.min(0).max(1).default(0.001),
  /** How many candles the retest may take. */
  maxRetestCandles: z.number().int().min(1).max(200).default(10),
}).strict();

export type PriceActionParams = z.infer<typeof priceActionParamsSchema>;

/** The parameters a fresh price-action condition starts with. */
export const DEFAULT_PRICE_ACTION_PARAMS: PriceActionParams = priceActionParamsSchema.parse({});

export interface StrategyPriceActionCondition {
  type: 'price_action';
  pattern: PriceActionPattern;
  params: PriceActionParams;
}

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

const comparisonSchema = z.object({
  type: z.literal('comparison'),
  left: operandSchema,
  operator: z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NE', 'CROSS_ABOVE', 'CROSS_BELOW', 'INCREASING', 'DECREASING', 'BETWEEN', 'OUTSIDE', 'CHANGE_PCT_GT', 'CHANGE_PCT_LT']),
  right: operandSchema,
  rangeTo: operandSchema.optional(),
  tolerance: finite.nonnegative().optional(),
}).strict();

export type StrategyCondition =
  | StrategyComparisonCondition
  | StrategyPriceActionCondition
  | { type: 'all'; conditions: StrategyCondition[] }
  | { type: 'any'; conditions: StrategyCondition[] }
  | { type: 'not'; condition: StrategyCondition }
  | { type: 'sequence'; steps: StrategyCondition[]; maxGapCandles: number };

export const conditionSchema = z.lazy(() =>
  z.discriminatedUnion('type', [
    comparisonSchema,
    z.object({
      type: z.literal('price_action'),
      pattern: z.enum(PRICE_ACTION_PATTERNS),
      params: priceActionParamsSchema,
    }).strict(),
    z.object({ type: z.literal('all'), conditions: z.array(conditionSchema).min(1).max(1000) }).strict(),
    z.object({ type: z.literal('any'), conditions: z.array(conditionSchema).min(1).max(1000) }).strict(),
    z.object({ type: z.literal('not'), condition: conditionSchema }).strict(),
    z.object({
      type: z.literal('sequence'),
      steps: z.array(conditionSchema).min(2).max(100),
      maxGapCandles: z.number().int().min(1).max(5000),
    }).strict(),
  ]),
) as unknown as z.ZodType<StrategyCondition>;

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

/**
 * An indicator instance. The `id` is generated by the builder and never
 * typed by a user; conditions refer to it.
 */
export const indicatorSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  type: z.string().min(1).max(32),
  params: z.record(z.string(), finite).default({}),
  output: z.string().min(1).max(48).optional(),
}).strict().superRefine((indicator, ctx) => {
  const entry = indicatorCatalogEntry(indicator.type);
  if (!entry) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: `Unknown indicator "${indicator.type}".` });
    return;
  }
  for (const message of validateIndicatorParams(indicator.type, indicator.params)) {
    ctx.addIssue({ code: 'custom', path: ['params'], message });
  }
  for (const message of validateIndicatorOutput(indicator.type, indicator.output)) {
    ctx.addIssue({ code: 'custom', path: ['output'], message });
  }
});

export type StrategyIndicator = z.infer<typeof indicatorSchema>;

/* ------------------------------------------------------------------ */
/* Strategy definition                                                 */
/* ------------------------------------------------------------------ */

export const strategyDefinitionSchema = z.object({
  schemaVersion: z.literal(STRATEGY_SCHEMA_VERSION),
  strategyId: z.string().min(8).max(128),
  versionId: z.string().min(8).max(128),
  version: z.number().int().positive(),
  name: z.string().min(2).max(80),
  description: z.string().max(2000).default(''),
  market: z.object({
    provider: z.enum(['hyperliquid', 'biquote', 'ctrader']),
    instrument: z.string().min(1).max(64),
    timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']),
  }).strict(),
  indicators: z.array(indicatorSchema).max(40),
  entry: z.object({ direction: z.enum(['LONG', 'SHORT']), condition: conditionSchema }).strict(),
  then: z.object({ action: z.enum(['BUY', 'SELL', 'CLOSE_POSITION', 'NO_TRADE', 'ALERT_ONLY']) }).strict().optional(),
  exit: z.object({ condition: conditionSchema.optional() }).strict().default({}),
  risk: z.object({
    sizing: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('FIXED_QUANTITY'), quantity: positive.max(1_000_000) }).strict(),
      z.object({ mode: z.literal('PERCENT_RISK'), percent: positive.max(10) }).strict(),
    ]),
    stopLossPercent: positive.max(50),
    takeProfitPercent: positive.max(100),
    maxExposurePercent: positive.max(100).default(25),
    // The v1 runtime intentionally supports one net position. Accepting a
    // larger number here would promise behavior the executor does not have.
    maxConcurrentPositions: z.literal(1).default(1),
    maxTradesPerDay: z.number().int().min(1).max(100).default(10),
    cooldownCandles: z.number().int().min(0).max(10_000).default(0),
    maxDailyLossPercent: positive.max(100).default(5),
  }).strict(),
  execution: z.object({
    mode: z.literal('PAPER'),
    startingBalance: positive.max(1_000_000_000).default(10_000),
    feeRate: finite.min(0).max(0.02).default(0.00045),
    slippageBps: finite.min(0).max(500).default(2),
  }).strict(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']),
  validationStatus: z.literal('VALID'),
  createdAt: z.string().datetime(),
}).strict();

export type StrategyDefinition = Omit<z.infer<typeof strategyDefinitionSchema>, 'schemaVersion'> & { schemaVersion: 2 | 3 };

export interface StrategyValidationResult {
  success: boolean;
  definition?: StrategyDefinition;
  errors: string[];
}

function visitCondition(condition: StrategyCondition, visit: (operand: StrategyOperand) => void, depth = 1): number {
  if (depth > 64) throw new Error('Condition nesting may not exceed 64 levels.');
  if (condition.type === 'comparison') {
    visit(condition.left);
    visit(condition.right);
    if (condition.rangeTo) visit(condition.rangeTo);
    if (['BETWEEN', 'OUTSIDE'].includes(condition.operator) && !condition.rangeTo) throw new Error(`${condition.operator} needs both a lower and upper value.`);
    if (!['BETWEEN', 'OUTSIDE'].includes(condition.operator) && condition.rangeTo) throw new Error('A range end is only valid for BETWEEN or OUTSIDE.');
    if ((condition.operator === 'CROSS_ABOVE' || condition.operator === 'CROSS_BELOW')
      && condition.left.kind === 'constant' && condition.right.kind === 'constant') {
      throw new Error('A crossover needs at least one changing price or indicator value.');
    }
    return 1;
  }
  if (condition.type === 'price_action') return 1;
  if (condition.type === 'not') return 1 + visitCondition(condition.condition, visit, depth + 1);
  if (condition.type === 'sequence') {
    return 1 + condition.steps.reduce((sum, child) => sum + visitCondition(child, visit, depth + 1), 0);
  }
  return 1 + condition.conditions.reduce((sum, child) => sum + visitCondition(child, visit, depth + 1), 0);
}

/** The output series an operand reads from an indicator instance. */
export function resolveOperandOutput(indicator: StrategyIndicator, operand: StrategyOperand): string | undefined {
  if (operand.kind !== 'indicator') return undefined;
  if (operand.output) return operand.output;
  if (indicator.output) return indicator.output;
  return defaultIndicatorOutput(indicator.type);
}

/** Shape and reference validation shared by API input, persisted versions and runtime. */
export function validateStrategyDefinition(input: unknown): StrategyValidationResult {
  const incomingVersion = input && typeof input === 'object' ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (incomingVersion === LEGACY_STRATEGY_SCHEMA_VERSION || incomingVersion === PREVIOUS_STRATEGY_SCHEMA_VERSION) {
    try { return validateStrategyDefinition(migrateStrategyDefinition(input)); }
    catch (error) { return { success: false, errors: [error instanceof Error ? error.message : 'Strategy migration failed.'] }; }
  }
  const parsed = strategyDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'strategy'}: ${issue.message}`) };
  }
  const definition = parsed.data;
  const ids = new Set<string>();
  const errors: string[] = [];
  const byId = new Map<string, StrategyIndicator>();
  for (const indicator of definition.indicators) {
    if (ids.has(indicator.id)) errors.push(`Indicator id "${indicator.id}" is duplicated.`);
    ids.add(indicator.id);
    byId.set(indicator.id, indicator);
  }
  const checkOperand = (operand: StrategyOperand) => {
    if (operand.kind !== 'indicator') return;
    const indicator = byId.get(operand.indicatorId);
    if (!indicator) {
      errors.push(`Condition references missing indicator "${operand.indicatorId}".`);
      return;
    }
    for (const message of validateIndicatorOutput(indicator.type, operand.output)) {
      errors.push(`Condition on "${operand.indicatorId}": ${message}`);
    }
  };
  try {
    const nodes = visitCondition(definition.entry.condition, checkOperand)
      + (definition.exit.condition ? visitCondition(definition.exit.condition, checkOperand) : 0);
    if (nodes > 2000) errors.push('A strategy may contain at most 2,000 condition nodes.');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Condition tree is invalid.');
  }
  if (definition.then?.action === 'BUY' && definition.entry.direction !== 'LONG') errors.push('THEN BUY must use LONG position intent.');
  if (definition.then?.action === 'SELL' && definition.entry.direction !== 'SHORT') errors.push('THEN SELL must use SHORT position intent.');
  if (definition.risk.takeProfitPercent <= definition.execution.slippageBps / 100) {
    errors.push('Take-profit distance must exceed configured slippage.');
  }
  if (definition.risk.stopLossPercent <= definition.execution.slippageBps / 100) {
    errors.push('Stop-loss distance must exceed configured slippage.');
  }
  return errors.length ? { success: false, errors } : { success: true, definition, errors: [] };
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/**
 * The price-action parameters that reproduce the version 1 behaviour
 * exactly.
 *
 * Version 1 had one number per condition, `lookback`, and the pattern
 * definitions were hard coded in the engine. The version 2 parameters below
 * are the version 1 definitions written out, so a migrated strategy keeps
 * meaning the same thing.
 */
const LEGACY_PATTERN_PARAMS: Record<string, Partial<PriceActionParams>> = {
  BULLISH_SWEEP: { lookback: 20, requireCloseBack: true, requireDirection: false, minWickBodyRatio: 0 },
  BEARISH_SWEEP: { lookback: 20, requireCloseBack: true, requireDirection: false, minWickBodyRatio: 0 },
  // Version 1 compared the previous close against the same reference level,
  // which is true for every candle, so its "not a repeat" guard never
  // actually fired. The migrated parameters keep that behaviour and the
  // parameter is stored explicitly, so nothing changes silently.
  BREAKOUT_HIGH: { lookback: 20, requireCloseConfirmation: true, requireNewEvent: false },
  BREAKOUT_LOW: { lookback: 20, requireCloseConfirmation: true, requireNewEvent: false },
  BULLISH_ENGULFING: { engulfMode: 'BODY', requireOppositeColor: true, minBodySize: 0 },
  BEARISH_ENGULFING: { engulfMode: 'BODY', requireOppositeColor: true, minBodySize: 0 },
  BULLISH_PIN_BAR: { minWickRatio: 2, minDominantWickPercent: 55, maxOpposingWickPercent: 25, requireDirection: false },
  BEARISH_PIN_BAR: { minWickRatio: 2, minDominantWickPercent: 55, maxOpposingWickPercent: 25, requireDirection: false },
};

/** The version 1 condition tree, as it was stored. */
interface LegacyCondition {
  type: string;
  pattern?: string;
  lookback?: number;
  left?: LegacyOperand;
  operator?: string;
  right?: LegacyOperand;
  conditions?: LegacyCondition[];
  condition?: LegacyCondition;
}

interface LegacyOperand {
  kind: string;
  field?: string;
  indicatorId?: string;
  value?: number;
}

function migrateOperand(operand: LegacyOperand | undefined): StrategyOperand {
  if (!operand) return { kind: 'constant', value: 0 };
  if (operand.kind === 'price') {
    return { kind: 'price', field: (operand.field ?? 'close') as 'open' | 'high' | 'low' | 'close' | 'volume' };
  }
  if (operand.kind === 'indicator') return { kind: 'indicator', indicatorId: operand.indicatorId ?? '' };
  return { kind: 'constant', value: Number(operand.value ?? 0) };
}

function migrateCondition(condition: LegacyCondition): StrategyCondition {
  switch (condition.type) {
    case 'comparison':
      return {
        type: 'comparison',
        left: migrateOperand(condition.left),
        operator: (condition.operator ?? 'GT') as StrategyOperator,
        right: migrateOperand(condition.right),
      };
    case 'price_action': {
      const pattern = (condition.pattern ?? 'BULLISH_SWEEP') as PriceActionPattern;
      const params = priceActionParamsSchema.parse({
        ...DEFAULT_PRICE_ACTION_PARAMS,
        ...(LEGACY_PATTERN_PARAMS[pattern] ?? {}),
        lookback: condition.lookback ?? 20,
      });
      return { type: 'price_action', pattern, params };
    }
    case 'all':
    case 'any':
      return { type: condition.type, conditions: (condition.conditions ?? []).map(migrateCondition) };
    case 'not':
      return { type: 'not', condition: migrateCondition(condition.condition ?? { type: 'comparison' }) };
    default:
      return { type: 'comparison', left: { kind: 'constant', value: 0 }, operator: 'GT', right: { kind: 'constant', value: 0 } };
  }
}

/**
 * Migrates a stored strategy to the current schema.
 *
 * Version 1 strategies keep their indicator ids, their indicator types and
 * their periods. Their price-action conditions keep their patterns and their
 * lookback, and the parameters that reproduce the version 1 engine exactly
 * are written out explicitly.
 */
export function migrateStrategyDefinition(input: unknown): StrategyDefinition {
  if (!input || typeof input !== 'object') throw new Error('A strategy definition must be an object.');
  const raw = input as Record<string, unknown>;
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined;
  if (version !== STRATEGY_SCHEMA_VERSION && version !== PREVIOUS_STRATEGY_SCHEMA_VERSION && version !== LEGACY_STRATEGY_SCHEMA_VERSION) {
    throw new Error(`Unsupported strategy schema version: ${String(version)}.`);
  }

  if (version === STRATEGY_SCHEMA_VERSION) {
    const result = validateStrategyDefinition(input);
    if (!result.success || !result.definition) throw new Error(result.errors.join(' '));
    return result.definition;
  }

  if (version === PREVIOUS_STRATEGY_SCHEMA_VERSION) {
    const entry = (raw.entry ?? {}) as Record<string, unknown>;
    const migrated = {
      ...raw,
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      then: raw.then ?? { action: entry.direction === 'SHORT' ? 'SELL' : 'BUY' },
    };
    const result = validateStrategyDefinition(migrated);
    if (!result.success || !result.definition) throw new Error(result.errors.join(' '));
    return result.definition;
  }

  const legacyIndicators = Array.isArray(raw.indicators) ? raw.indicators as Array<Record<string, unknown>> : [];
  const indicators: StrategyIndicator[] = legacyIndicators.map(item => ({
    id: String(item.id ?? ''),
    type: String(item.type ?? 'SMA'),
    params: { period: Number(item.period ?? 20) },
    output: defaultIndicatorOutput(String(item.type ?? 'SMA')),
  }));

  const legacyEntry = (raw.entry ?? {}) as Record<string, unknown>;
  const legacyExit = (raw.exit ?? {}) as Record<string, unknown>;

  const migrated = {
    ...raw,
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    indicators,
    entry: {
      direction: (legacyEntry.direction ?? 'LONG') as 'LONG' | 'SHORT',
      condition: migrateCondition((legacyEntry.condition ?? { type: 'comparison' }) as LegacyCondition),
    },
    then: { action: legacyEntry.direction === 'SHORT' ? 'SELL' : 'BUY' },
    exit: legacyExit.condition
      ? { condition: migrateCondition(legacyExit.condition as LegacyCondition) }
      : {},
    validationStatus: 'VALID' as const,
  };

  const result = validateStrategyDefinition(migrated);
  if (!result.success || !result.definition) throw new Error(result.errors.join(' '));
  return result.definition;
}
