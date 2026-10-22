import { ChevronDown, ChevronUp, CirclePlus, Copy, Trash2 } from 'lucide-react';
import { indicatorCatalogEntry } from '../../services/strategy/indicators/catalog';
import { PRICE_ACTION_PATTERNS, type PriceActionParams, type PriceActionPattern, type StrategyOperator } from '../../services/strategy/schema';
import { describePriceActionPattern } from '../../services/strategy/priceAction';
import {
  newComparison,
  newGroup,
  newPriceAction,
  newSequence,
  newOperand,
  duplicateConditionDraft,
  type ConditionDraft,
  type IndicatorDraft,
  type OperandDraft,
} from './builderModel';
import { PriceActionFields } from './PriceActionFields';

/**
 * THE CONDITION EDITOR
 * ====================
 *
 * Conditions are a tree: a comparison, a price-action pattern, a group of
 * conditions joined with AND or OR, or a sequence of steps that have to
 * happen one after the other.
 *
 * The editor stays flat where it can. A group is only opened when the user
 * asks for one, so the common case is a short readable list.
 */

const OPERATORS: StrategyOperator[] = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NE', 'CROSS_ABOVE', 'CROSS_BELOW', 'INCREASING', 'DECREASING', 'BETWEEN', 'OUTSIDE', 'CHANGE_PCT_GT', 'CHANGE_PCT_LT'];
const OPERATOR_LABELS: Record<StrategyOperator, string> = {
  GT: 'is above', GTE: 'is at or above', LT: 'is below', LTE: 'is at or below',
  EQ: 'is equal to', NE: 'is not equal to', CROSS_ABOVE: 'crosses above', CROSS_BELOW: 'crosses below',
  INCREASING: 'is increasing', DECREASING: 'is decreasing', BETWEEN: 'is between', OUTSIDE: 'is outside',
  CHANGE_PCT_GT: 'increases by at least %', CHANGE_PCT_LT: 'decreases by at least %',
};

export function ConditionEditor({
  conditions,
  onChange,
  indicators,
  depth = 0,
  removable = true,
  advanced = false,
}: {
  conditions: ConditionDraft[];
  onChange: (update: (previous: ConditionDraft[]) => ConditionDraft[]) => void;
  indicators: IndicatorDraft[];
  depth?: number;
  removable?: boolean;
  advanced?: boolean;
}) {
  const update = (index: number, value: Partial<ConditionDraft>) => onChange(previous => previous.map((item, itemIndex) => {
    if (itemIndex !== index) return item;
    const next = { ...item, ...value } as ConditionDraft;
    if (item.kind === 'comparison' && next.kind === 'comparison' && !('configured' in value)) next.configured = true;
    return next;
  }));
  const remove = (index: number) => onChange(previous => previous.filter((_, itemIndex) => itemIndex !== index));
  const duplicate = (index: number) => onChange(previous => [...previous.slice(0,index+1), duplicateConditionDraft(previous[index]), ...previous.slice(index+1)]);
  const move = (index: number, offset: number) => onChange(previous => {
    const next = [...previous];
    const target = index + offset;
    if (target < 0 || target >= next.length) return previous;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  return <div className={depth ? 'mt-2 space-y-2 border-l border-line pl-3' : 'space-y-2'}>
    {conditions.map((condition, index) => <div key={condition.id} className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-9 items-center gap-1.5 rounded-md px-1 text-[11px] text-fg-muted">
          <input aria-label="Negate condition" type="checkbox" checked={condition.negate} onChange={event => update(index, { negate: event.target.checked } as Partial<ConditionDraft>)} /> NOT
        </label>
        {condition.kind === 'comparison' && <select
          aria-label="Condition type"
          className="input py-1 text-xs"
          value="comparison"
          onChange={event => {
            const next = event.target.value;
            if (next === 'price_action') update(index, newPriceAction());
            else if (next === 'group') update(index, newGroup());
            else if (next === 'sequence') update(index, newSequence());
          }}
        >
          <option value="comparison">Indicator / price comparison</option>
          <option value="price_action">Price action</option>
          <option value="group">Group of conditions</option>
          {advanced && <option value="sequence">Followed by (in order)</option>}
        </select>}
        {condition.kind === 'price_action' && <select
          aria-label="Condition type"
          className="input py-1 text-xs"
          value="price_action"
          onChange={event => {
            const next = event.target.value;
            if (next === 'comparison') update(index, newComparison(indicators[0]?.id ?? ''));
            else if (next === 'group') update(index, newGroup());
            else if (next === 'sequence') update(index, newSequence());
          }}
        >
          <option value="price_action">Price action</option>
          <option value="comparison">Indicator / price comparison</option>
          <option value="group">Group of conditions</option>
          {advanced && <option value="sequence">Followed by (in order)</option>}
        </select>}
        {condition.kind === 'group' && <select
          aria-label="Condition type"
          className="input py-1 text-xs"
          value="group"
          onChange={event => {
            const next = event.target.value;
            if (next === 'comparison') update(index, newComparison(indicators[0]?.id ?? ''));
            else if (next === 'price_action') update(index, newPriceAction());
            else if (next === 'sequence') update(index, newSequence());
          }}
        >
          <option value="group">Group of conditions</option>
          <option value="comparison">Indicator / price comparison</option>
          <option value="price_action">Price action</option>
          {advanced && <option value="sequence">Followed by (in order)</option>}
        </select>}
        {condition.kind === 'sequence' && <select
          aria-label="Condition type"
          className="input py-1 text-xs"
          value="sequence"
          onChange={event => {
            const next = event.target.value;
            if (next === 'comparison') update(index, newComparison(indicators[0]?.id ?? ''));
            else if (next === 'price_action') update(index, newPriceAction());
            else if (next === 'group') update(index, newGroup());
          }}
        >
          {advanced && <option value="sequence">Followed by (in order)</option>}
          <option value="comparison">Indicator / price comparison</option>
          <option value="price_action">Price action</option>
          <option value="group">Group of conditions</option>
        </select>}

        {condition.kind === 'group' && <select
          aria-label="Group join"
          value={condition.join}
          onChange={event => update(index, { join: event.target.value as 'all' | 'any' } as Partial<ConditionDraft>)}
          className="input py-1 text-xs"
        >
          <option value="all">ALL of them (AND)</option>
          <option value="any">ANY of them (OR)</option>
        </select>}

        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => move(index, -1)} aria-label="Move condition up" className="text-fg-subtle"><ChevronUp size={15} /></button>
          <button type="button" onClick={() => move(index, 1)} aria-label="Move condition down" className="text-fg-subtle"><ChevronDown size={15} /></button>
          <button type="button" onClick={() => duplicate(index)} aria-label="Duplicate condition" className="text-fg-subtle"><Copy size={14} /></button>
          {removable && <button type="button" onClick={() => remove(index)} aria-label="Remove condition" className="text-fg-subtle"><Trash2 size={15} /></button>}
        </div>
      </div>

      {condition.kind === 'comparison' && <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(130px,160px)_minmax(0,1fr)]">
        <OperandEditor draft={condition.left} indicators={indicators} onChange={left => {
          const bothConstant = left.kind === 'constant' && condition.right.kind === 'constant';
          update(index, { left, ...(bothConstant && ['CROSS_ABOVE', 'CROSS_BELOW'].includes(condition.operator) ? { operator: 'GT' as const } : {}) } as Partial<ConditionDraft>);
        }} />
        <select aria-label="Operator" value={condition.operator} onChange={event => {
          const operator = event.target.value as StrategyOperator;
          const right = ['CHANGE_PCT_GT', 'CHANGE_PCT_LT'].includes(operator) && condition.right.kind !== 'constant'
            ? newOperand('constant')
            : condition.right;
          update(index, { operator, right, rangeTo: ['BETWEEN','OUTSIDE'].includes(operator) ? (condition.rangeTo ?? newOperand('constant')) : undefined } as Partial<ConditionDraft>);
        }} className="input min-w-0 self-end">
          {OPERATORS.filter(operator => !(['CROSS_ABOVE', 'CROSS_BELOW'].includes(operator) && condition.left.kind === 'constant' && condition.right.kind === 'constant')).map(operator => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}
        </select>
        {!['INCREASING', 'DECREASING'].includes(condition.operator) && <OperandEditor draft={condition.right} indicators={indicators} onChange={right => {
          const bothConstant = condition.left.kind === 'constant' && right.kind === 'constant';
          update(index, { right, ...(bothConstant && ['CROSS_ABOVE', 'CROSS_BELOW'].includes(condition.operator) ? { operator: 'GT' as const } : {}) } as Partial<ConditionDraft>);
        }} />}
        {condition.rangeTo && <><span className="hidden sm:block"/><span className="text-[10px] text-fg-subtle sm:col-span-2">and upper bound</span><OperandEditor draft={condition.rangeTo} indicators={indicators} onChange={rangeTo => update(index, { rangeTo } as Partial<ConditionDraft>)}/></>}
        {condition.operator === 'EQ' && advanced && <label className="text-[10px] text-fg-subtle sm:col-span-3">Numeric tolerance<input type="number" min="0" step="any" value={condition.tolerance ?? 0} onChange={event=>update(index,{tolerance:Number(event.target.value)} as Partial<ConditionDraft>)} className="input mt-1"/></label>}
        {['CHANGE_PCT_GT', 'CHANGE_PCT_LT'].includes(condition.operator) && <p className="text-[10px] text-fg-subtle sm:col-span-3">Enter the percentage amount in the number field (for example, 2 means 2%).</p>}
      </div>}

      {condition.kind === 'price_action' && <>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Price action pattern"
            value={condition.pattern}
            onChange={event => update(index, { pattern: event.target.value as PriceActionPattern } as Partial<ConditionDraft>)}
            className="input py-1 text-xs"
          >
            {PRICE_ACTION_PATTERNS.map(pattern => <option key={pattern} value={pattern}>{describePriceActionPattern(pattern)}</option>)}
          </select>
          <span className="text-[11px] text-fg-subtle">evaluated on the closed candle</span>
        </div>
        <PriceActionFields
          pattern={condition.pattern}
          params={condition.params}
          onChange={(params: PriceActionParams) => update(index, { params } as Partial<ConditionDraft>)}
        />
      </>}

      {condition.kind === 'group' && <div className="mt-2">
        <ConditionEditor
          conditions={condition.conditions}
          onChange={updateChildren => update(index, { conditions: updateChildren(condition.conditions) } as Partial<ConditionDraft>)}
          indicators={indicators}
          depth={depth + 1}
          removable={false}
          advanced={advanced}
        />
        <button type="button" className="btn btn-secondary mt-2" onClick={() => update(index, { conditions: [...condition.conditions, newComparison(indicators[0]?.id ?? '')] } as Partial<ConditionDraft>)}>
          <CirclePlus size={13} /> Add condition to the group
        </button>
      </div>}

      {condition.kind === 'sequence' && <div className="mt-2">
        <p className="text-[11px] text-fg-subtle">Each step has to happen on a later candle than the one before it.</p>
        {condition.steps.map((step, stepIndex) => <div key={step.id} className="mt-2 rounded-lg border border-line p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Step {stepIndex + 1}</span>
            <button type="button" onClick={() => update(index, { steps: condition.steps.filter((_, itemIndex) => itemIndex !== stepIndex) } as Partial<ConditionDraft>)} aria-label="Remove step" className="text-fg-subtle"><Trash2 size={14} /></button>
          </div>
          <ConditionEditor
            conditions={[step]}
            onChange={updateChildren => {
              const steps = [...condition.steps];
              const next = updateChildren(condition.steps);
              if (next[0]) steps[stepIndex] = next[0];
              update(index, { steps } as Partial<ConditionDraft>);
            }}
            indicators={indicators}
            depth={depth + 1}
            removable={false}
            advanced={advanced}
          />
        </div>)}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => update(index, { steps: [...condition.steps, newComparison(indicators[0]?.id ?? '')] } as Partial<ConditionDraft>)}>
            <CirclePlus size={13} /> Add step
          </button>
          <label className="text-xs text-fg-muted">Events within
            <input type="number" min={1} max={5000} value={condition.maxGapCandles} onChange={event => update(index, { maxGapCandles: Number(event.target.value) } as Partial<ConditionDraft>)} className="input mx-1 w-24" />
            candles apart
          </label>
        </div>
      </div>}
    </div>)}
  </div>;
}

function OperandEditor({
  draft,
  indicators,
  onChange,
}: {
  draft: OperandDraft;
  indicators: IndicatorDraft[];
  onChange: (draft: OperandDraft) => void;
}) {
  const first = indicators[0];
  const selected = indicators.find(indicator => indicator.id === draft.indicatorId);
  const entry = selected ? indicatorCatalogEntry(selected.type) : undefined;
  return <div className="grid gap-1 sm:grid-cols-2">
    <select
      aria-label="Operand kind"
      value={draft.kind}
      onChange={event => {
        const kind = event.target.value as OperandDraft['kind'];
        if (kind === 'indicator') onChange({ ...draft, kind, indicatorId: draft.indicatorId || first?.id || '', output: draft.output });
        else if (kind === 'price') onChange({ ...draft, kind });
        else onChange({ ...draft, kind, value: Number.isFinite(draft.value) ? draft.value : 0 });
      }}
      className="input"
    >
      <option value="indicator">Indicator</option>
      <option value="price">Price / volume</option>
      <option value="constant">Number</option>
    </select>
    {draft.kind === 'indicator' && <>
      <select
        aria-label="Indicator"
        value={draft.indicatorId}
        onChange={event => {
          const indicator = indicators.find(item => item.id === event.target.value);
          onChange({ ...draft, indicatorId: event.target.value, output: indicator?.output ?? '' });
        }}
        className="input"
      >
        {indicators.length === 0 && <option value="">No indicators yet</option>}
        {indicators.map(indicator => {
          const catalog = indicatorCatalogEntry(indicator.type);
          const parameters = catalog?.parameters.map(parameter => `${parameter.label} ${indicator.params[parameter.key] ?? parameter.default}`).join(', ');
          return <option key={indicator.id} value={indicator.id}>{catalog?.shortName ?? indicator.type}{parameters ? ` — ${parameters}` : ''}</option>;
        })}
      </select>
      {entry && entry.outputs.length > 1 && <select
        aria-label="Output series"
        value={draft.output || selected?.output || entry.outputs[0].key}
        onChange={event => onChange({ ...draft, output: event.target.value })}
        className="input sm:col-span-2"
      >
        {entry.outputs.map(output => <option key={output.key} value={output.key}>{output.label}</option>)}
      </select>}
    </>}
    {draft.kind === 'price' && <select aria-label="Price field" value={draft.field} onChange={event => onChange({ ...draft, field: event.target.value as OperandDraft['field'] })} className="input sm:col-span-2">
      {['open', 'high', 'low', 'close', 'volume'].map(field => <option key={field} value={field}>{field}</option>)}
    </select>}
    {draft.kind === 'constant' && <input aria-label="Number" type="number" value={draft.value} onChange={event => onChange({ ...draft, value: Number(event.target.value) })} className="input sm:col-span-2" />}
  </div>;
}
