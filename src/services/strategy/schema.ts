import { z } from 'zod';

export const STRATEGY_SCHEMA_VERSION = 1 as const;

const finite = z.number().finite();
const positive = finite.positive();
export const operandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('price'), field: z.enum(['open', 'high', 'low', 'close', 'volume']) }).strict(),
  z.object({ kind: z.literal('indicator'), indicatorId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('constant'), value: finite }).strict(),
]);

export type StrategyOperand =
  | { kind: 'price'; field: 'open' | 'high' | 'low' | 'close' | 'volume' }
  | { kind: 'indicator'; indicatorId: string }
  | { kind: 'constant'; value: number };

export interface StrategyComparisonCondition {
  type: 'comparison';
  left: StrategyOperand;
  operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'CROSS_ABOVE' | 'CROSS_BELOW';
  right: StrategyOperand;
}

const comparisonSchema = z.object({
  type: z.literal('comparison'),
  left: operandSchema,
  operator: z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'CROSS_ABOVE', 'CROSS_BELOW']),
  right: operandSchema,
}).strict();

export type StrategyCondition =
  | StrategyComparisonCondition
  | { type: 'all'; conditions: StrategyCondition[] }
  | { type: 'any'; conditions: StrategyCondition[] }
  | { type: 'not'; condition: StrategyCondition };

export const conditionSchema = z.lazy(() =>
  z.discriminatedUnion('type', [
    comparisonSchema,
    z.object({ type: z.literal('all'), conditions: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('any'), conditions: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('not'), condition: conditionSchema }).strict(),
  ]),
) as unknown as z.ZodType<StrategyCondition>;

export const indicatorSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  type: z.enum(['SMA', 'EMA', 'RSI', 'ATR']),
  period: z.number().int().min(2).max(500),
}).strict();

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
  indicators: z.array(indicatorSchema).max(20),
  entry: z.object({ direction: z.enum(['LONG', 'SHORT']), condition: conditionSchema }).strict(),
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

export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;

export interface StrategyValidationResult {
  success: boolean;
  definition?: StrategyDefinition;
  errors: string[];
}

function visitCondition(condition: StrategyCondition, visit: (operand: StrategyOperand) => void, depth = 1): number {
  if (depth > 8) throw new Error('Condition nesting may not exceed 8 levels.');
  if (condition.type === 'comparison') {
    visit(condition.left);
    visit(condition.right);
    if ((condition.operator === 'CROSS_ABOVE' || condition.operator === 'CROSS_BELOW')
      && condition.left.kind === 'constant' && condition.right.kind === 'constant') {
      throw new Error('A crossover needs at least one changing price or indicator value.');
    }
    return 1;
  }
  if (condition.type === 'not') return 1 + visitCondition(condition.condition, visit, depth + 1);
  return 1 + condition.conditions.reduce((sum, child) => sum + visitCondition(child, visit, depth + 1), 0);
}

/** Shape and reference validation shared by API input, persisted versions and runtime. */
export function validateStrategyDefinition(input: unknown): StrategyValidationResult {
  const parsed = strategyDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'strategy'}: ${issue.message}`) };
  }
  const definition = parsed.data;
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const indicator of definition.indicators) {
    if (ids.has(indicator.id)) errors.push(`Indicator id "${indicator.id}" is duplicated.`);
    ids.add(indicator.id);
  }
  const checkOperand = (operand: StrategyOperand) => {
    if (operand.kind === 'indicator' && !ids.has(operand.indicatorId)) {
      errors.push(`Condition references missing indicator "${operand.indicatorId}".`);
    }
  };
  try {
    const nodes = visitCondition(definition.entry.condition, checkOperand)
      + (definition.exit.condition ? visitCondition(definition.exit.condition, checkOperand) : 0);
    if (nodes > 100) errors.push('A strategy may contain at most 100 condition nodes.');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Condition tree is invalid.');
  }
  if (definition.risk.takeProfitPercent <= definition.execution.slippageBps / 100) {
    errors.push('Take-profit distance must exceed configured slippage.');
  }
  if (definition.risk.stopLossPercent <= definition.execution.slippageBps / 100) {
    errors.push('Stop-loss distance must exceed configured slippage.');
  }
  return errors.length ? { success: false, errors } : { success: true, definition, errors: [] };
}

export function migrateStrategyDefinition(input: unknown): StrategyDefinition {
  const version = typeof input === 'object' && input !== null ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== STRATEGY_SCHEMA_VERSION) throw new Error(`Unsupported strategy schema version: ${String(version)}.`);
  const result = validateStrategyDefinition(input);
  if (!result.success || !result.definition) throw new Error(result.errors.join(' '));
  return result.definition;
}
