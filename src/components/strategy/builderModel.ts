import {
  defaultIndicatorOutput,
  indicatorCatalogEntry,
  resolveIndicatorParams,
  type IndicatorCatalogEntry,
} from '../../services/strategy/indicators/catalog';
import {
  priceActionParamsSchema,
  type PriceActionParams,
  type PriceActionPattern,
  type StrategyCondition,
  type StrategyOperand,
  type StrategyOperator,
} from '../../services/strategy/schema';
import type { AiDraftCondition } from '../../services/strategy/aiDraft';

/**
 * THE BUILDER MODEL
 * =================
 *
 * The builder edits a slightly looser shape than the saved strategy, so a
 * half finished condition can still be on screen while the user is typing.
 * This module is the only place that knows how to turn the loose shape into
 * the strict one, which is what the schema validates and the engine runs.
 *
 * The same model is used for a hand written strategy and for a strategy the
 * AI drafted, so both paths end up in the same editor.
 */

export type OperandKind = 'indicator' | 'price' | 'constant';
export type PriceField = 'open' | 'high' | 'low' | 'close' | 'volume';
export type Operator = StrategyOperator;

export interface OperandDraft {
  kind: OperandKind;
  /** The id of the indicator, for an indicator operand. */
  indicatorId: string;
  /** The output series of that indicator. */
  output: string;
  /** The price field, for a price operand. */
  field: PriceField;
  /** The number, for a constant operand. */
  value: number;
}

export interface ComparisonDraft {
  id: string;
  kind: 'comparison';
  left: OperandDraft;
  operator: Operator;
  right: OperandDraft;
  negate: boolean;
}

export interface PriceActionDraft {
  id: string;
  kind: 'price_action';
  pattern: PriceActionPattern;
  params: PriceActionParams;
  negate: boolean;
}

export interface GroupDraft {
  id: string;
  kind: 'group';
  join: 'all' | 'any';
  conditions: ConditionDraft[];
  negate: boolean;
}

export interface SequenceDraft {
  id: string;
  kind: 'sequence';
  steps: ConditionDraft[];
  maxGapCandles: number;
  negate: boolean;
}

export type ConditionDraft = ComparisonDraft | PriceActionDraft | GroupDraft | SequenceDraft;

export interface IndicatorDraft {
  id: string;
  type: string;
  params: Record<string, number>;
  output: string;
}

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;

/** The default parameters of an indicator, straight from the catalog. */
export function defaultParams(type: string): Record<string, number> {
  return resolveIndicatorParams(type, {});
}

/**
 * A stable internal id for a new indicator.
 *
 * The id is derived from the indicator type and the number of indicators
 * already in the list, so it never collides and never has to be typed.
 */
export function newIndicatorId(type: string, existing: readonly IndicatorDraft[]): string {
  const base = type.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'indicator';
  let candidate = `ind_${base}`;
  let counter = 2;
  while (existing.some(indicator => indicator.id === candidate)) {
    candidate = `ind_${base}_${counter}`;
    counter += 1;
  }
  return candidate;
}

/** A new indicator of the given type, with the catalog defaults. */
export function newIndicator(type: string, existing: readonly IndicatorDraft[]): IndicatorDraft {
  return {
    id: newIndicatorId(type, existing),
    type,
    params: defaultParams(type),
    output: defaultIndicatorOutput(type),
  };
}

export const newOperand = (kind: OperandKind = 'indicator', indicatorId = ''): OperandDraft => ({
  kind,
  indicatorId,
  output: '',
  field: 'close',
  value: 0,
});

export const newComparison = (indicatorId = ''): ComparisonDraft => ({
  id: uid(),
  kind: 'comparison',
  left: { ...newOperand('indicator', indicatorId), output: '' },
  operator: 'CROSS_ABOVE',
  right: { ...newOperand('constant'), value: 0 },
  negate: false,
});

export const newPriceAction = (pattern: PriceActionPattern = 'BULLISH_SWEEP'): PriceActionDraft => ({
  id: uid(),
  kind: 'price_action',
  pattern,
  params: priceActionParamsSchema.parse({}),
  negate: false,
});

export const newGroup = (join: 'all' | 'any' = 'all'): GroupDraft => ({
  id: uid(),
  kind: 'group',
  join,
  conditions: [],
  negate: false,
});

export const newSequence = (): SequenceDraft => ({
  id: uid(),
  kind: 'sequence',
  steps: [],
  maxGapCandles: 10,
  negate: false,
});

/** The operand of a draft, resolved against the indicator list. */
export function operandFromDraft(draft: OperandDraft): StrategyOperand {
  if (draft.kind === 'constant') return { kind: 'constant', value: Number.isFinite(draft.value) ? draft.value : 0 };
  if (draft.kind === 'price') return { kind: 'price', field: draft.field };
  const operand: StrategyOperand = { kind: 'indicator', indicatorId: draft.indicatorId };
  if (draft.output) (operand as { output?: string }).output = draft.output;
  return operand;
}

/**
 * The strict condition of a draft.
 *
 * A group with no children and a sequence with fewer than two steps are not
 * conditions yet, so they are dropped rather than turned into something
 * that would silently never match.
 */
export function conditionFromDraft(draft: ConditionDraft): StrategyCondition | null {
  let condition: StrategyCondition | null = null;
  if (draft.kind === 'comparison') {
    condition = {
      type: 'comparison',
      left: operandFromDraft(draft.left),
      operator: draft.operator,
      right: operandFromDraft(draft.right),
    };
  } else if (draft.kind === 'price_action') {
    condition = { type: 'price_action', pattern: draft.pattern, params: draft.params };
  } else if (draft.kind === 'group') {
    const children = draft.conditions.map(conditionFromDraft).filter((item): item is StrategyCondition => item !== null);
    if (!children.length) return null;
    condition = children.length === 1 && draft.join === 'all'
      ? children[0]
      : { type: draft.join, conditions: children };
  } else if (draft.kind === 'sequence') {
    const steps = draft.steps.map(conditionFromDraft).filter((item): item is StrategyCondition => item !== null);
    if (steps.length < 2) return null;
    condition = { type: 'sequence', steps, maxGapCandles: draft.maxGapCandles };
  }
  if (!condition) return null;
  return draft.negate ? { type: 'not', condition } : condition;
}

/** The conditions of a list, joined with AND or OR. */
export function groupedCondition(drafts: readonly ConditionDraft[], join: 'all' | 'any'): StrategyCondition | null {
  const conditions = drafts.map(conditionFromDraft).filter((item): item is StrategyCondition => item !== null);
  if (!conditions.length) return null;
  if (conditions.length === 1) return conditions[0];
  return { type: join, conditions };
}

/* ------------------------------------------------------------------ */
/* Reading a saved strategy back into the builder                       */
/* ------------------------------------------------------------------ */

function operandFromStrategy(operand: StrategyOperand, indicators: readonly IndicatorDraft[]): OperandDraft {
  if (operand.kind === 'constant') return { ...newOperand('constant'), value: operand.value };
  if (operand.kind === 'price') return { ...newOperand('price'), field: operand.field };
  const indicator = indicators.find(item => item.id === operand.indicatorId);
  return {
    ...newOperand('indicator', operand.indicatorId),
    output: operand.output ?? indicator?.output ?? '',
  };
}

/** The draft of a saved condition, so a stored strategy can be shown and edited. */
export function draftFromCondition(condition: StrategyCondition, indicators: readonly IndicatorDraft[]): ConditionDraft {
  if (condition.type === 'comparison') {
    return {
      id: uid(),
      kind: 'comparison',
      left: operandFromStrategy(condition.left, indicators),
      operator: condition.operator,
      right: operandFromStrategy(condition.right, indicators),
      negate: false,
    };
  }
  if (condition.type === 'price_action') {
    return { id: uid(), kind: 'price_action', pattern: condition.pattern, params: condition.params, negate: false };
  }
  if (condition.type === 'not') {
    const inner = draftFromCondition(condition.condition, indicators);
    return { ...inner, negate: !inner.negate };
  }
  if (condition.type === 'sequence') {
    return {
      id: uid(),
      kind: 'sequence',
      steps: condition.steps.map(step => draftFromCondition(step, indicators)),
      maxGapCandles: condition.maxGapCandles,
      negate: false,
    };
  }
  return {
    id: uid(),
    kind: 'group',
    join: condition.type,
    conditions: condition.conditions.map(child => draftFromCondition(child, indicators)),
    negate: false,
  };
}

/* ------------------------------------------------------------------ */
/* Reading an AI draft into the builder                                 */
/* ------------------------------------------------------------------ */

const aiOperandToDraft = (operand: AiDraftCondition extends never ? never : any, byRef: Map<string, IndicatorDraft>): OperandDraft => {
  if (operand.kind === 'constant') return { ...newOperand('constant'), value: Number(operand.value) };
  if (operand.kind === 'price') return { ...newOperand('price'), field: operand.field };
  const indicator = byRef.get(operand.indicator);
  return {
    ...newOperand('indicator', indicator?.id ?? operand.indicator),
    output: operand.output ?? indicator?.output ?? '',
  };
};

/**
 * The draft of an AI condition.
 *
 * The AI refers to its indicators by the handle it gave them, so the
 * handles are mapped onto the ids the builder generated. A reference the AI
 * made to an indicator it never declared is kept as a dangling reference,
 * which the validation reports instead of dropping.
 */
export function draftFromAiCondition(
  condition: AiDraftCondition | null,
  byRef: Map<string, IndicatorDraft>,
): ConditionDraft | null {
  if (!condition) return null;
  if (condition.type === 'comparison') {
    return {
      id: uid(),
      kind: 'comparison',
      left: aiOperandToDraft(condition.left, byRef),
      operator: condition.operator,
      right: aiOperandToDraft(condition.right, byRef),
      negate: false,
    };
  }
  if (condition.type === 'price_action') {
    const params: Record<string, unknown> = { ...priceActionParamsSchema.parse({}) };
    for (const [key, value] of Object.entries(condition.params ?? {})) {
      if (value === null || value === undefined) continue;
      if (key in params) params[key] = value;
    }
    return { id: uid(), kind: 'price_action', pattern: condition.pattern, params: priceActionParamsSchema.parse(params), negate: false };
  }
  if (condition.type === 'not') {
    const inner = draftFromAiCondition(condition.condition, byRef);
    if (!inner) return null;
    return { ...inner, negate: !inner.negate };
  }
  if (condition.type === 'sequence') {
    return {
      id: uid(),
      kind: 'sequence',
      steps: condition.steps.map(step => draftFromAiCondition(step, byRef)).filter((item): item is ConditionDraft => item !== null),
      maxGapCandles: condition.maxGapCandles ?? 10,
      negate: false,
    };
  }
  return {
    id: uid(),
    kind: 'group',
    join: condition.type,
    conditions: condition.conditions.map(child => draftFromAiCondition(child, byRef)).filter((item): item is ConditionDraft => item !== null),
    negate: false,
  };
}

/* ------------------------------------------------------------------ */
/* Readable descriptions                                                */
/* ------------------------------------------------------------------ */

/** A readable label of an indicator, for the dropdowns. */
export function indicatorLabel(indicator: IndicatorDraft, index: number): string {
  const entry = indicatorCatalogEntry(indicator.type);
  const parameters = entry?.parameters
    .map(parameter => `${parameter.label} ${indicator.params[parameter.key] ?? parameter.default}`)
    .join(', ');
  const base = entry?.shortName ?? indicator.type;
  return parameters ? `${base} (${parameters})` : base;
}

/** A readable label of an output series. */
export function outputLabel(type: string, output: string): string {
  const entry: IndicatorCatalogEntry | undefined = indicatorCatalogEntry(type);
  return entry?.outputs.find(item => item.key === output)?.label ?? output;
}
