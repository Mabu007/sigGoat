import { z } from 'zod';
import {
  INDICATOR_CATALOG,
  INDICATOR_CATEGORIES,
  defaultIndicatorOutput,
  indicatorCatalogEntry,
  resolveIndicatorParams,
  validateIndicatorParams,
} from './indicators/catalog';
import { PRICE_ACTION_PATTERNS, priceActionParamsSchema, type PriceActionParams, type PriceActionPattern } from './schema';

/**
 * AI STRATEGY DRAFTING
 * ====================
 *
 * There are two stages, and they are deliberately different.
 *
 *   STAGE A — DRAFT INTERPRETATION
 *     The model turns a natural-language request into a structured DRAFT.
 *     A draft may be incomplete. It records what was understood, what was
 *     left out, what was ambiguous, what the model could not express, and
 *     which assumptions it made. An incomplete draft is a VALID stage A
 *     result.
 *
 *   STAGE B — EXECUTABLE VALIDATION
 *     After the user has reviewed the draft, the draft is turned into an
 *     executable strategy definition. Every field is validated, every
 *     indicator reference is checked, every condition parameter is checked,
 *     and anything still missing is reported. An incomplete strategy is
 *     never saved and never run.
 *
 * The model NEVER produces trading code. It produces JSON that is parsed
 * with a strict schema on the server, and the only thing that can ever be
 * executed is the declarative condition tree this repository evaluates.
 */

/* ------------------------------------------------------------------ */
/* Stage A — the draft                                                  */
/* ------------------------------------------------------------------ */

export const AI_DRAFT_STATUSES = ['READY', 'NEEDS_INPUT', 'UNSUPPORTED'] as const;
export type AiDraftStatus = typeof AI_DRAFT_STATUSES[number];

export const AI_DRAFT_SOURCES = ['ai', 'pattern-fallback'] as const;
export type AiDraftSource = typeof AI_DRAFT_SOURCES[number];

export const AI_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

/**
 * A parameter value in a draft.
 *
 * The catalog holds numbers, but the price-action parameters also hold
 * booleans and a couple of words, so a draft may carry any of them. A
 * `null` means the model did not work the value out.
 */
const nullableNumber = z.union([z.number().finite(), z.boolean(), z.string()]).nullable();

/** An indicator the AI decided to use, with the handle it refers to it by. */
export const aiDraftIndicatorSchema = z.object({
  /** The handle the model uses to refer to this indicator in a condition. */
  ref: z.string().min(1).max(48).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  /** The catalog key, for example `MACD`. */
  key: z.string().min(1).max(32),
  /** Parameters, with `null` for anything the model did not work out. */
  params: z.record(z.string(), nullableNumber).default({}),
  /** The output series to use, when the indicator has more than one. */
  output: z.string().min(1).max(48).nullable().default(null),
}).strict();

export type AiDraftIndicator = z.infer<typeof aiDraftIndicatorSchema>;

export const aiDraftOperandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('price'), field: z.enum(['open', 'high', 'low', 'close', 'volume']) }).strict(),
  z.object({
    kind: z.literal('indicator'),
    /** The `ref` of one of the draft's indicators. */
    indicator: z.string().min(1).max(48),
    output: z.string().min(1).max(48).nullable().default(null),
  }).strict(),
  z.object({ kind: z.literal('constant'), value: z.number().finite() }).strict(),
]);

export type AiDraftOperand = z.infer<typeof aiDraftOperandSchema>;

const draftComparisonSchema = z.object({
  type: z.literal('comparison'),
  left: aiDraftOperandSchema,
  operator: z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'CROSS_ABOVE', 'CROSS_BELOW']),
  right: aiDraftOperandSchema,
}).strict();

const draftPriceActionSchema = z.object({
  type: z.literal('price_action'),
  pattern: z.enum(PRICE_ACTION_PATTERNS),
  /** Parameters, with `null` for anything the model did not work out. */
  params: z.record(z.string(), nullableNumber).default({}),
}).strict();

export type AiDraftCondition =
  | z.infer<typeof draftComparisonSchema>
  | z.infer<typeof draftPriceActionSchema>
  | { type: 'all'; conditions: AiDraftCondition[] }
  | { type: 'any'; conditions: AiDraftCondition[] }
  | { type: 'not'; condition: AiDraftCondition }
  | { type: 'sequence'; steps: AiDraftCondition[]; maxGapCandles: number | null };

export const aiDraftConditionSchema: z.ZodType<AiDraftCondition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    draftComparisonSchema,
    draftPriceActionSchema,
    z.object({ type: z.literal('all'), conditions: z.array(aiDraftConditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('any'), conditions: z.array(aiDraftConditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('not'), condition: aiDraftConditionSchema }).strict(),
    z.object({
      type: z.literal('sequence'),
      steps: z.array(aiDraftConditionSchema).min(2).max(8),
      maxGapCandles: z.number().int().min(1).max(200).nullable().default(null),
    }).strict(),
  ]),
) as unknown as z.ZodType<AiDraftCondition>;

export const aiDraftRiskSchema = z.object({
  sizingMode: z.enum(['PERCENT_RISK', 'FIXED_QUANTITY']).nullable().default(null),
  sizingValue: z.number().finite().nullable().default(null),
  stopLossPercent: z.number().finite().nullable().default(null),
  takeProfitPercent: z.number().finite().nullable().default(null),
  maxExposurePercent: z.number().finite().nullable().default(null),
  maxTradesPerDay: z.number().int().nullable().default(null),
  cooldownCandles: z.number().int().nullable().default(null),
  maxDailyLossPercent: z.number().finite().nullable().default(null),
}).strict();

export const aiDraftSchema = z.object({
  status: z.enum(AI_DRAFT_STATUSES),
  source: z.enum(AI_DRAFT_SOURCES).default('ai'),
  name: z.string().max(80).nullable().default(null),
  description: z.string().max(2000).nullable().default(null),
  direction: z.enum(['LONG', 'SHORT']).nullable().default(null),
  market: z.object({
    provider: z.enum(['hyperliquid', 'biquote', 'ctrader']).default('hyperliquid'),
    instrument: z.string().max(64).nullable().default(null),
    timeframe: z.enum(AI_TIMEFRAMES).nullable().default(null),
  }).strict().default({ provider: 'hyperliquid', instrument: null, timeframe: null }),
  indicators: z.array(aiDraftIndicatorSchema).max(40).default([]),
  entry: aiDraftConditionSchema.nullable().default(null),
  exit: aiDraftConditionSchema.nullable().default(null),
  risk: aiDraftRiskSchema.prefault({}),
  missingFields: z.array(z.string().max(120)).max(50).default([]),
  ambiguities: z.array(z.string().max(400)).max(20).default([]),
  unsupported: z.array(z.string().max(400)).max(20).default([]),
  assumptions: z.array(z.object({
    field: z.string().max(120),
    value: z.string().max(200),
    reason: z.string().max(400),
  }).strict()).max(20).default([]),
  /** The prompt the user typed, kept so the draft can be traced back to it. */
  prompt: z.string().max(4000).default(''),
}).strict();

export type AiDraft = z.infer<typeof aiDraftSchema>;

/* ------------------------------------------------------------------ */
/* The prompt                                                           */
/* ------------------------------------------------------------------ */

/** A compact description of the indicator catalog for the model. */
export function describeIndicatorCatalog(): string {
  const lines: string[] = [];
  for (const category of INDICATOR_CATEGORIES) {
    lines.push(`${category.label.toUpperCase()}:`);
    for (const entry of INDICATOR_CATALOG.filter(item => item.category === category.key)) {
      const parameters = entry.parameters.length
        ? entry.parameters.map(parameter => `${parameter.key}:${parameter.type === 'integer' ? 'int' : 'num'}=${parameter.default} [${parameter.min}-${parameter.max}]`).join(', ')
        : 'none';
      const outputs = entry.outputs.map(output => output.key).join('|');
      lines.push(`- ${entry.key} — ${entry.name} | params: ${parameters} | outputs: ${outputs}`);
    }
  }
  return lines.join('\n');
}

/** A compact description of the price-action patterns for the model. */
export function describePriceActionPatterns(): string {
  const defaults = priceActionParamsSchema.parse({});
  const lines: string[] = [];
  for (const pattern of PRICE_ACTION_PATTERNS) {
    lines.push(`- ${pattern} | params: lookback:int=20 [2-500], distanceMode:TICKS|PERCENT, minPenetration:num=0, requireCloseBack:bool=true, requireDirection:bool=false, minWickBodyRatio:num=0, minBreakoutDistance:num=0, requireCloseConfirmation:bool=true, requireVolumeConfirmation:bool=false, volumeMultiplier:num=1.5, volumePeriod:int=20, requireNewEvent:bool=true, engulfMode:BODY|FULL_RANGE, minBodySize:num=0, requireOppositeColor:bool=true, minWickRatio:num=2, minDominantWickPercent:num=55, maxOpposingWickPercent:num=25, retestTolerance:num=0.001, maxRetestCandles:int=10`);
  }
  return lines.join('\n');
}

/**
 * The instruction sent to the model.
 *
 * It carries the real catalog, the real condition vocabulary and the exact
 * shape of the answer, and it is explicit that an incomplete answer is
 * better than an invented one.
 */
export function buildAiDraftPrompt(prompt: string): string {
  return [
    'You translate a trading request into a structured DRAFT for a rule-based trading robot builder.',
    '',
    'HARD RULES',
    '1. Output ONE JSON object and nothing else. No markdown, no explanation, no code fences.',
    '2. Never invent trading logic, numbers, indicators or instruments the user did not ask for.',
    '3. When the user did not specify something, set the field to null and list its path in missingFields.',
    '4. When the request is ambiguous, pick the most common reading, add it to ambiguities, and continue.',
    '5. When the request needs something this builder cannot express, add it to unsupported and do not fake it.',
    '6. Every assumption you make must be listed in assumptions with the field, the value and the reason.',
    '7. An incomplete draft is a good answer. A complete draft with invented content is a bad answer.',
    '8. Use only the indicators listed below, and only their listed output names.',
    '9. "followed by" means the second thing happened on a LATER candle than the first. Use {"type":"sequence","steps":[...],"maxGapCandles":N}.',
    '10. Never output a strategy that is ready to run unless every required field is present.',
    '',
    'INDICATORS',
    describeIndicatorCatalog(),
    '',
    'PRICE ACTION PATTERNS',
    describePriceActionPatterns(),
    '',
    'ANSWER SHAPE',
    JSON.stringify({
      status: 'READY | NEEDS_INPUT | UNSUPPORTED',
      name: 'string or null',
      description: 'string or null',
      direction: 'LONG | SHORT | null',
      market: { provider: 'hyperliquid', instrument: 'string or null', timeframe: '1m|5m|15m|30m|1h|4h|1d or null' },
      indicators: [{ ref: 'handle used in conditions', key: 'catalog key', params: { name: 'number or null' }, output: 'output name or null' }],
      entry: 'condition or null',
      exit: 'condition or null',
      risk: {
        sizingMode: 'PERCENT_RISK | FIXED_QUANTITY | null',
        sizingValue: 'number or null',
        stopLossPercent: 'number or null',
        takeProfitPercent: 'number or null',
        maxExposurePercent: 'number or null',
        maxTradesPerDay: 'number or null',
        cooldownCandles: 'number or null',
        maxDailyLossPercent: 'number or null',
      },
      missingFields: ['field paths such as market.instrument'],
      ambiguities: ['plain sentences'],
      unsupported: ['plain sentences'],
      assumptions: [{ field: 'field path', value: 'what was assumed', reason: 'why' }],
    }, null, 2),
    '',
    'CONDITION SHAPE',
    JSON.stringify({
      comparison: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'GT|GTE|LT|LTE|EQ|CROSS_ABOVE|CROSS_BELOW', right: { kind: 'indicator', indicator: 'ref', output: 'output or null' } },
      indicatorOperand: { kind: 'indicator', indicator: 'ref of an indicator in the indicators array', output: 'output name or null' },
      priceOperand: { kind: 'price', field: 'open|high|low|close|volume' },
      constantOperand: { kind: 'constant', value: 0 },
      priceAction: { type: 'price_action', pattern: 'one of the patterns above', params: { lookback: 'number or null' } },
      group: { type: 'all | any', conditions: ['conditions'] },
      negation: { type: 'not', condition: 'condition' },
      sequence: { type: 'sequence', steps: ['conditions'], maxGapCandles: 'number or null' },
    }, null, 2),
    '',
    `USER REQUEST\n${prompt}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Parsing the model answer                                             */
/* ------------------------------------------------------------------ */

export interface AiDraftParseResult {
  draft?: AiDraft;
  error?: string;
}

/** Extracts the first JSON object from a model answer. */
export function extractJsonObject(answer: string): string | null {
  const start = answer.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < answer.length; index += 1) {
    const character = answer[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return answer.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parses and strictly validates a model answer.
 *
 * Untrusted model output never reaches the rest of the system without going
 * through this schema.
 */
export function parseAiDraft(answer: string, prompt = ''): AiDraftParseResult {
  const json = extractJsonObject(answer);
  if (!json) return { error: 'The AI response did not contain a JSON object.' };
  let raw: unknown;
  try { raw = JSON.parse(json); }
  catch { return { error: 'The AI response was not valid JSON.' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The AI response was not a JSON object.' };
  const candidate = { ...(raw as Record<string, unknown>), prompt };
  const parsed = aiDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'draft'}: ${issue.message}`).slice(0, 6);
    return { error: `The AI draft did not match the expected shape. ${issues.join(' ')}` };
  }
  return { draft: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Stage B — completeness                                               */
/* ------------------------------------------------------------------ */

/** A field of the draft that still needs a decision before it can run. */
export interface DraftGap {
  /** The path of the field, for example `market.instrument`. */
  field: string;
  /** What the builder needs from the user. */
  message: string;
}

const RISK_FIELDS: Array<{ key: keyof AiDraft['risk']; path: string; message: string }> = [
  { key: 'sizingMode', path: 'risk.sizing', message: 'Choose how a position is sized.' },
  { key: 'sizingValue', path: 'risk.sizingValue', message: 'Choose how much is risked per trade.' },
  { key: 'stopLossPercent', path: 'risk.stopLossPercent', message: 'Set the stop loss distance.' },
  { key: 'takeProfitPercent', path: 'risk.takeProfitPercent', message: 'Set the take profit distance.' },
];

/**
 * Everything the draft still needs before it can become an executable
 * strategy.
 */
export function draftGaps(draft: AiDraft): DraftGap[] {
  const gaps: DraftGap[] = [];
  if (!draft.direction) gaps.push({ field: 'direction', message: 'Choose whether the robot goes long or short.' });
  if (!draft.market.instrument) gaps.push({ field: 'market.instrument', message: 'Choose the market to trade.' });
  if (!draft.market.timeframe) gaps.push({ field: 'market.timeframe', message: 'Choose the chart timeframe.' });
  if (!draft.entry) gaps.push({ field: 'entry', message: 'Describe the entry rule.' });
  for (const risk of RISK_FIELDS) {
    if (draft.risk[risk.key] === null || draft.risk[risk.key] === undefined) {
      gaps.push({ field: risk.path, message: risk.message });
    }
  }
  const refs = new Set(draft.indicators.map(indicator => indicator.ref));
  const visit = (condition: AiDraftCondition | null, path: string) => {
    if (!condition) return;
    if (condition.type === 'comparison') {
      for (const [side, operand] of [['left', condition.left], ['right', condition.right]] as const) {
        if (operand.kind !== 'indicator') continue;
        if (!refs.has(operand.indicator)) {
          gaps.push({ field: `${path}.${side}.indicator`, message: `The condition points at an unknown indicator "${operand.indicator}".` });
        }
      }
      return;
    }
    if (condition.type === 'price_action') {
      for (const [name, value] of Object.entries(condition.params)) {
        if (value === null) gaps.push({ field: `${path}.params.${name}`, message: `Choose a value for "${name}".` });
      }
      return;
    }
    if (condition.type === 'not') { visit(condition.condition, `${path}.condition`); return; }
    if (condition.type === 'sequence') {
      if (condition.maxGapCandles === null) gaps.push({ field: `${path}.maxGapCandles`, message: 'Choose how many candles the two steps may be apart.' });
      condition.steps.forEach((step, index) => visit(step, `${path}.steps.${index}`));
      return;
    }
    condition.conditions.forEach((child, index) => visit(child, `${path}.conditions.${index}`));
  };
  visit(draft.entry, 'entry');
  visit(draft.exit, 'exit');
  for (const indicator of draft.indicators) {
    const entry = indicatorCatalogEntry(indicator.key);
    if (!entry) {
      gaps.push({ field: `indicators.${indicator.ref}.key`, message: `"${indicator.key}" is not an indicator this builder supports.` });
      continue;
    }
    for (const parameter of entry.parameters) {
      const value = indicator.params[parameter.key];
      if (value === null || value === undefined) {
        gaps.push({ field: `indicators.${indicator.ref}.params.${parameter.key}`, message: `Choose a value for ${entry.shortName} ${parameter.label.toLowerCase()}.` });
        continue;
      }
      if (typeof value !== 'number') {
        gaps.push({ field: `indicators.${indicator.ref}.params.${parameter.key}`, message: `${entry.shortName} ${parameter.label.toLowerCase()} must be a number.` });
        continue;
      }
      if (value < parameter.min || value > parameter.max) {
        gaps.push({ field: `indicators.${indicator.ref}.params.${parameter.key}`, message: `${entry.shortName} ${parameter.label.toLowerCase()} must be between ${parameter.min} and ${parameter.max}.` });
      }
    }
    if (indicator.output && !entry.outputs.some(output => output.key === indicator.output)) {
      gaps.push({ field: `indicators.${indicator.ref}.output`, message: `${entry.shortName} has no output called "${indicator.output}".` });
    }
  }
  return gaps;
}

/* ------------------------------------------------------------------ */
/* Stage B — draft to editor model                                      */
/* ------------------------------------------------------------------ */

export interface EditorIndicator {
  id: string;
  type: string;
  params: Record<string, number>;
  output?: string;
}

export interface EditorModel {
  name: string;
  description: string;
  instrument: string;
  timeframe: string | null;
  direction: 'LONG' | 'SHORT';
  indicators: EditorIndicator[];
  entry: AiDraftCondition | null;
  exit: AiDraftCondition | null;
  risk: {
    sizingMode: 'PERCENT_RISK' | 'FIXED_QUANTITY';
    sizingValue: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    maxExposurePercent: number;
    maxTradesPerDay: number;
    cooldownCandles: number;
    maxDailyLossPercent: number;
  };
  gaps: DraftGap[];
  /** The fields the model actually filled in, so the builder can show them. */
  provided: string[];
  /** The handle the model used for each indicator, mapped to the generated id. */
  refMap: Record<string, string>;
}

const EDITOR_DEFAULTS: EditorModel['risk'] = {
  sizingMode: 'PERCENT_RISK',
  sizingValue: 1,
  stopLossPercent: 1,
  takeProfitPercent: 2,
  maxExposurePercent: 25,
  maxTradesPerDay: 10,
  cooldownCandles: 1,
  maxDailyLossPercent: 5,
};

/**
 * Turns a draft into the model the manual builder edits.
 *
 * The builder's own defaults fill the gaps so the editor is usable straight
 * away, but the gaps are reported so every one of them can be shown as
 * "still needs a decision" and the values the model DID supply are marked
 * as such.
 */
export function draftToEditorModel(draft: AiDraft, prompt = ''): EditorModel {
  const provided: string[] = [];
  const refMap: Record<string, string> = {};
  const indicators: EditorIndicator[] = draft.indicators.map((indicator, index) => {
    const entry = indicatorCatalogEntry(indicator.key);
    const params: Record<string, number> = {};
    if (entry) {
      for (const parameter of entry.parameters) {
        const value = indicator.params[parameter.key];
        if (typeof value === 'number' && Number.isFinite(value)) params[parameter.key] = value;
      }
    }
    const resolved = entry ? resolveIndicatorParams(indicator.key, params) : params;
    if (entry) provided.push(`indicators.${indicator.ref}`);
    const id = `ind_${index + 1}_${slug(indicator.ref)}`;
    refMap[indicator.ref] = id;
    return {
      id,
      type: indicator.key,
      params: resolved,
      output: indicator.output ?? (entry ? defaultIndicatorOutput(indicator.key) : undefined),
    };
  });

  const risk = { ...EDITOR_DEFAULTS };
  if (draft.risk.sizingMode) { risk.sizingMode = draft.risk.sizingMode; provided.push('risk.sizing'); }
  if (typeof draft.risk.sizingValue === 'number') { risk.sizingValue = draft.risk.sizingValue; provided.push('risk.sizingValue'); }
  if (typeof draft.risk.stopLossPercent === 'number') { risk.stopLossPercent = draft.risk.stopLossPercent; provided.push('risk.stopLossPercent'); }
  if (typeof draft.risk.takeProfitPercent === 'number') { risk.takeProfitPercent = draft.risk.takeProfitPercent; provided.push('risk.takeProfitPercent'); }
  if (typeof draft.risk.maxExposurePercent === 'number') { risk.maxExposurePercent = draft.risk.maxExposurePercent; provided.push('risk.maxExposurePercent'); }
  if (typeof draft.risk.maxTradesPerDay === 'number') { risk.maxTradesPerDay = draft.risk.maxTradesPerDay; provided.push('risk.maxTradesPerDay'); }
  if (typeof draft.risk.cooldownCandles === 'number') { risk.cooldownCandles = draft.risk.cooldownCandles; provided.push('risk.cooldownCandles'); }
  if (typeof draft.risk.maxDailyLossPercent === 'number') { risk.maxDailyLossPercent = draft.risk.maxDailyLossPercent; provided.push('risk.maxDailyLossPercent'); }

  if (draft.market.instrument) provided.push('market.instrument');
  if (draft.market.timeframe) provided.push('market.timeframe');
  if (draft.direction) provided.push('direction');
  if (draft.entry) provided.push('entry');
  if (draft.exit) provided.push('exit');
  if (draft.name) provided.push('name');
  if (draft.description) provided.push('description');

  return {
    name: draft.name?.trim() || (prompt ? prompt.slice(0, 60) : 'My Trading Robot'),
    description: draft.description?.trim() || prompt,
    instrument: draft.market.instrument?.trim().toUpperCase() || '',
    timeframe: draft.market.timeframe,
    direction: draft.direction ?? 'LONG',
    indicators,
    entry: draft.entry,
    exit: draft.exit,
    risk,
    gaps: draftGaps(draft),
    provided,
    refMap,
  };
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'indicator';

/* ------------------------------------------------------------------ */
/* Stage B — draft to executable strategy                               */
/* ------------------------------------------------------------------ */

import { validateStrategyDefinition, type StrategyCondition, type StrategyDefinition, type StrategyIndicator, type StrategyOperand } from './schema';

/** The options a draft needs to become an executable strategy. */
export interface DraftToDefinitionOptions {
  strategyId: string;
  versionId: string;
  /** The values the user already chose in the editor. */
  defaults?: {
    name?: string;
    description?: string;
    instrument?: string;
    timeframe?: string;
    direction?: 'LONG' | 'SHORT';
    sizingMode?: 'PERCENT_RISK' | 'FIXED_QUANTITY';
    sizingValue?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
    maxExposurePercent?: number;
    maxTradesPerDay?: number;
    cooldownCandles?: number;
    maxDailyLossPercent?: number;
  };
  /** Fixed identifiers, so a saved strategy is reproducible. */
  now?: string;
}

function convertOperand(operand: AiDraftOperand, ids: Map<string, string>): StrategyOperand | null {
  if (operand.kind === 'constant') return { kind: 'constant', value: operand.value };
  if (operand.kind === 'price') return { kind: 'price', field: operand.field };
  const id = ids.get(operand.indicator);
  if (!id) return null;
  const result: StrategyOperand = { kind: 'indicator', indicatorId: id };
  if (operand.output) result.output = operand.output;
  return result;
}

/** Turns a draft condition into an executable condition. */
export function convertDraftCondition(
  condition: AiDraftCondition | null,
  ids: Map<string, string>,
  errors: string[] = [],
): StrategyCondition | null {
  if (!condition) return null;
  if (condition.type === 'comparison') {
    const left = convertOperand(condition.left, ids);
    const right = convertOperand(condition.right, ids);
    if (!left || !right) {
      errors.push('A condition points at an indicator the draft never declared.');
      return null;
    }
    return { type: 'comparison', left, operator: condition.operator, right };
  }
  if (condition.type === 'price_action') {
    const resolved = resolveDraftPriceActionParams(condition.params ?? {});
    errors.push(...resolved.errors);
    return { type: 'price_action', pattern: condition.pattern, params: resolved.params };
  }
  if (condition.type === 'not') {
    const inner = convertDraftCondition(condition.condition, ids, errors);
    return inner ? { type: 'not', condition: inner } : null;
  }
  if (condition.type === 'sequence') {
    const steps = condition.steps.map(step => convertDraftCondition(step, ids, errors)).filter((item): item is StrategyCondition => item !== null);
    if (steps.length < 2) return null;
    return { type: 'sequence', steps, maxGapCandles: condition.maxGapCandles ?? 10 };
  }
  const children = condition.conditions.map(child => convertDraftCondition(child, ids, errors)).filter((item): item is StrategyCondition => item !== null);
  if (!children.length) return null;
  return { type: condition.type, conditions: children };
}

/**
 * STAGE B — turns a reviewed draft into an executable strategy.
 *
 * Nothing is filled in silently. A field the draft did not supply and the
 * user has not chosen yet is reported as an error, and no definition is
 * produced, so an incomplete strategy can never be saved or run.
 */
export function draftToDefinition(
  draft: AiDraft,
  options: DraftToDefinitionOptions,
): { definition?: StrategyDefinition; errors: string[]; gaps: DraftGap[] } {
  const gaps = draftGaps(draft);
  const errors: string[] = [];
  const defaults = options.defaults ?? {};

  const ids = new Map<string, string>();
  const indicators = draft.indicators.map((indicator, index) => {
    const id = `ind_${index + 1}_${slug(indicator.ref)}`;
    ids.set(indicator.ref, id);
    const entry = indicatorCatalogEntry(indicator.key);
    if (!entry) return null;
    const clean: Record<string, number> = {};
    for (const [name, value] of Object.entries(indicator.params)) {
      if (value === null || value === undefined) continue;
      if (!entry.parameters.some(parameter => parameter.key === name)) continue;
      if (typeof value !== 'number') {
        errors.push(`Indicator "${indicator.ref}" parameter "${name}" must be a number.`);
        continue;
      }
      clean[name] = value;
    }
    const resolved = resolveIndicatorParams(indicator.key, clean);
    for (const parameter of entry.parameters) {
      if (resolved[parameter.key] === parameter.default && clean[parameter.key] === undefined) {
        errors.push(`Indicator "${indicator.ref}" still needs a value for ${parameter.label}.`);
      }
    }
    return {
      id,
      type: indicator.key,
      params: resolved,
      output: indicator.output ?? defaultIndicatorOutput(indicator.key),
    } satisfies StrategyIndicator;
  }).filter((item): item is NonNullable<typeof item> => item !== null);

  const entry = convertDraftCondition(draft.entry, ids, errors);
  const exit = convertDraftCondition(draft.exit, ids, errors);
  if (draft.entry && !entry) errors.push('The entry rule could not be translated into conditions this builder can run.');
  if (draft.exit && !exit) errors.push('The exit rule could not be translated into conditions this builder can run.');

  const instrument = (draft.market.instrument ?? defaults.instrument ?? '').trim().toUpperCase();
  const timeframe = draft.market.timeframe ?? defaults.timeframe ?? null;
  const direction = draft.direction ?? defaults.direction ?? 'LONG';
  const sizingMode = draft.risk.sizingMode ?? defaults.sizingMode ?? null;
  const sizingValue = draft.risk.sizingValue ?? defaults.sizingValue ?? null;
  const stopLoss = draft.risk.stopLossPercent ?? defaults.stopLossPercent ?? null;
  const takeProfit = draft.risk.takeProfitPercent ?? defaults.takeProfitPercent ?? null;

  if (!instrument) errors.push('The market is still missing.');
  if (!timeframe) errors.push('The timeframe is still missing.');
  if (!entry) errors.push('The entry rule is still missing.');
  if (!sizingMode || sizingValue === null) errors.push('The position sizing is still missing.');
  if (stopLoss === null) errors.push('The stop loss is still missing.');
  if (takeProfit === null) errors.push('The take profit is still missing.');

  if (errors.length) return { errors, gaps };

  const definition: StrategyDefinition = {
    schemaVersion: 2,
    strategyId: options.strategyId,
    versionId: options.versionId,
    version: 1,
    name: (draft.name ?? defaults.name ?? 'Trading robot').slice(0, 80),
    description: (draft.description ?? defaults.description ?? '').slice(0, 2000),
    market: { provider: draft.market.provider, instrument, timeframe: timeframe as StrategyDefinition['market']['timeframe'] },
    indicators,
    entry: { direction, condition: entry! },
    exit: exit ? { condition: exit } : {},
    risk: {
      sizing: sizingMode === 'PERCENT_RISK'
        ? { mode: 'PERCENT_RISK', percent: sizingValue! }
        : { mode: 'FIXED_QUANTITY', quantity: sizingValue! },
      stopLossPercent: stopLoss!,
      takeProfitPercent: takeProfit!,
      maxExposurePercent: draft.risk.maxExposurePercent ?? defaults.maxExposurePercent ?? 25,
      maxConcurrentPositions: 1,
      maxTradesPerDay: draft.risk.maxTradesPerDay ?? defaults.maxTradesPerDay ?? 10,
      cooldownCandles: draft.risk.cooldownCandles ?? defaults.cooldownCandles ?? 0,
      maxDailyLossPercent: draft.risk.maxDailyLossPercent ?? defaults.maxDailyLossPercent ?? 5,
    },
    execution: { mode: 'PAPER', startingBalance: 10_000, feeRate: 0.00045, slippageBps: 2 },
    visibility: 'PRIVATE',
    validationStatus: 'VALID',
    createdAt: options.now ?? new Date().toISOString(),
  };

  const validation = validateStrategyDefinition(definition);
  if (!validation.success || !validation.definition) {
    return { errors: validation.errors, gaps };
  }
  return { definition: validation.definition, errors: [], gaps };
}

/* ------------------------------------------------------------------ */
/* The labelled deterministic fallback                                  */
/* ------------------------------------------------------------------ */

/**
 * A deliberately small, deliberately honest fallback.
 *
 * It recognises a handful of unambiguous price-action phrases and nothing
 * else. It never guesses an indicator, a parameter or a market, and every
 * draft it produces says where it came from. It exists so a model that
 * answers with something unusable still leaves the user with an editable
 * starting point instead of an error page.
 */
export function buildFallbackDraft(prompt: string): AiDraft {
  const text = prompt.toLowerCase();
  const bullish = !/(sell|short|bearish)\b/.test(text);
  const direction: 'LONG' | 'SHORT' = bullish ? 'LONG' : 'SHORT';
  let pattern: PriceActionPattern | null = null;
  if (/liquidity|sweep|stop hunt|stop run/.test(text)) pattern = bullish ? 'BULLISH_SWEEP' : 'BEARISH_SWEEP';
  else if (/breakout|break above|break below|breaks out/.test(text)) pattern = bullish ? 'BREAKOUT_HIGH' : 'BREAKOUT_LOW';
  else if (/engulf/.test(text)) pattern = bullish ? 'BULLISH_ENGULFING' : 'BEARISH_ENGULFING';
  else if (/pin bar|hammer|shooting star/.test(text)) pattern = bullish ? 'BULLISH_PIN_BAR' : 'BEARISH_PIN_BAR';

  const entry: AiDraftCondition | null = pattern
    ? { type: 'price_action', pattern, params: { lookback: null } }
    : null;

  return aiDraftSchema.parse({
    status: 'NEEDS_INPUT',
    source: 'pattern-fallback',
    name: null,
    description: prompt,
    direction,
    market: { provider: 'hyperliquid', instrument: null, timeframe: null },
    indicators: [],
    entry,
    exit: null,
    risk: {},
    missingFields: [],
    ambiguities: pattern
      ? ['The phrase was matched to a price-action pattern by a simple keyword rule, not by a model.']
      : ['This request could not be matched to a price-action pattern by a simple keyword rule.'],
    unsupported: [],
    assumptions: [],
    prompt,
  });
}

/** The price-action parameters a draft asked for, with the defaults filled in. */
export function resolveDraftPriceActionParams(
  params: Record<string, number | boolean | string | null>,
  defaults: PriceActionParams = priceActionParamsSchema.parse({}),
): { params: PriceActionParams; errors: string[] } {
  const shape = priceActionParamsSchema.shape;
  const resolved: Record<string, unknown> = { ...defaults };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (!(key in shape)) {
      errors.push(`The price-action condition does not accept a parameter called "${key}".`);
      continue;
    }
    const parsed = shape[key as keyof typeof shape].safeParse(value);
    if (parsed.success) resolved[key] = parsed.data;
    else errors.push(`The price-action parameter "${key}" is not a valid value.`);
  }
  return { params: priceActionParamsSchema.parse(resolved), errors };
}

/** The indicator parameters a draft asked for, with the catalog defaults filled in. */
export function resolveDraftIndicatorParams(
  key: string,
  params: Record<string, number | boolean | string | null>,
): { params: Record<string, number>; errors: string[] } {
  const entry = indicatorCatalogEntry(key);
  if (!entry) return { params: {}, errors: [`Unknown indicator "${key}".`] };
  const clean: Record<string, number> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const parameter = entry.parameters.find(item => item.key === name);
    if (!parameter) continue;
    if (typeof value !== 'number') {
      errors.push(`Indicator "${key}" parameter "${name}" must be a number.`);
      continue;
    }
    clean[name] = value;
  }
  errors.push(...validateIndicatorParams(key, clean));
  return { params: resolveIndicatorParams(key, clean), errors };
}
