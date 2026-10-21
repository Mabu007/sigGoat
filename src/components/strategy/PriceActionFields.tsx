import type { PriceActionParams, PriceActionPattern } from '../../services/strategy/schema';
import { describePriceActionPattern } from '../../services/strategy/priceAction';

/**
 * THE PRICE-ACTION PARAMETERS
 * ===========================
 *
 * Only the parameters that matter for the chosen pattern are shown. Every
 * one of them has a documented meaning in `services/strategy/priceAction`,
 * and the label says so in plain words.
 */

type FieldSpec = {
  key: keyof PriceActionParams;
  label: string;
  type: 'number' | 'checkbox' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
};

const SWEEP_FIELDS: FieldSpec[] = [
  { key: 'lookback', label: 'Lookback candles', type: 'number', min: 2, max: 500, step: 1, hint: 'Candles examined before the signal candle.' },
  { key: 'distanceMode', label: 'Penetration measured in', type: 'select', options: [{ value: 'TICKS', label: 'Ticks (price units)' }, { value: 'PERCENT', label: 'Percent of the level' }] },
  { key: 'minPenetration', label: 'Minimum penetration', type: 'number', min: 0, step: 0.0001, hint: 'How far the candle must reach beyond the level.' },
  { key: 'requireCloseBack', label: 'Must close back inside', type: 'checkbox', hint: 'The candle has to close back above the swept low (below the swept high).' },
  { key: 'requireDirection', label: 'Candle must close in the pattern direction', type: 'checkbox' },
  { key: 'minWickBodyRatio', label: 'Minimum wick to body ratio', type: 'number', min: 0, max: 100, step: 0.1, hint: '0 turns the check off.' },
];

const BREAKOUT_FIELDS: FieldSpec[] = [
  { key: 'lookback', label: 'Lookback candles', type: 'number', min: 2, max: 500, step: 1 },
  { key: 'distanceMode', label: 'Distance measured in', type: 'select', options: [{ value: 'TICKS', label: 'Ticks (price units)' }, { value: 'PERCENT', label: 'Percent of the level' }] },
  { key: 'minBreakoutDistance', label: 'Minimum breakout distance', type: 'number', min: 0, step: 0.0001 },
  { key: 'requireCloseConfirmation', label: 'Require the close beyond the level', type: 'checkbox', hint: 'Off means the wick alone is enough.' },
  { key: 'requireNewEvent', label: 'Only a new breakout counts', type: 'checkbox', hint: 'Stops the same breakout from firing again on every following candle.' },
  { key: 'requireVolumeConfirmation', label: 'Require volume confirmation', type: 'checkbox' },
  { key: 'volumeMultiplier', label: 'Volume multiple', type: 'number', min: 0, max: 1000, step: 0.1, hint: 'Volume must be at least this many times the average.' },
  { key: 'volumePeriod', label: 'Volume average period', type: 'number', min: 2, max: 500, step: 1 },
];

const RETEST_FIELDS: FieldSpec[] = [
  { key: 'lookback', label: 'Breakout lookback candles', type: 'number', min: 2, max: 500, step: 1 },
  { key: 'distanceMode', label: 'Distance measured in', type: 'select', options: [{ value: 'TICKS', label: 'Ticks (price units)' }, { value: 'PERCENT', label: 'Percent of the level' }] },
  { key: 'minBreakoutDistance', label: 'Minimum breakout distance', type: 'number', min: 0, step: 0.0001 },
  { key: 'requireCloseConfirmation', label: 'Require the close beyond the level', type: 'checkbox' },
  { key: 'requireNewEvent', label: 'Only a new breakout counts', type: 'checkbox' },
  { key: 'retestTolerance', label: 'Retest tolerance', type: 'number', min: 0, max: 1, step: 0.0001, hint: 'How far below the broken level the retest may reach, as a fraction.' },
  { key: 'maxRetestCandles', label: 'Maximum candles to wait', type: 'number', min: 1, max: 200, step: 1 },
];

const ENGULFING_FIELDS: FieldSpec[] = [
  { key: 'engulfMode', label: 'Must cover', type: 'select', options: [{ value: 'BODY', label: 'The previous body' }, { value: 'FULL_RANGE', label: 'The previous whole range' }] },
  { key: 'minBodySize', label: 'Minimum body size (% of range)', type: 'number', min: 0, max: 100, step: 1 },
  { key: 'requireOppositeColor', label: 'Previous candle must close the other way', type: 'checkbox' },
];

const PIN_FIELDS: FieldSpec[] = [
  { key: 'minWickRatio', label: 'Minimum wick to body ratio', type: 'number', min: 0, max: 100, step: 0.1 },
  { key: 'minDominantWickPercent', label: 'Dominant wick (% of range)', type: 'number', min: 0, max: 100, step: 1 },
  { key: 'maxOpposingWickPercent', label: 'Opposing wick (% of range)', type: 'number', min: 0, max: 100, step: 1 },
  { key: 'requireDirection', label: 'Candle must close in the pattern direction', type: 'checkbox' },
];

/** The fields that apply to a pattern. */
export function priceActionFields(pattern: PriceActionPattern): FieldSpec[] {
  if (pattern === 'BULLISH_SWEEP' || pattern === 'BEARISH_SWEEP') return SWEEP_FIELDS;
  if (pattern === 'BREAKOUT_HIGH' || pattern === 'BREAKOUT_LOW') return BREAKOUT_FIELDS;
  if (pattern === 'BREAKOUT_RETEST_HIGH' || pattern === 'BREAKOUT_RETEST_LOW') return RETEST_FIELDS;
  if (pattern === 'BULLISH_ENGULFING' || pattern === 'BEARISH_ENGULFING') return ENGULFING_FIELDS;
  return PIN_FIELDS;
}

export function PriceActionFields({
  pattern,
  params,
  onChange,
}: {
  pattern: PriceActionPattern;
  params: PriceActionParams;
  onChange: (params: PriceActionParams) => void;
}) {
  const fields = priceActionFields(pattern);
  const update = <K extends keyof PriceActionParams>(key: K, value: PriceActionParams[K]) => onChange({ ...params, [key]: value });
  return <div className="mt-2 grid gap-2 sm:grid-cols-2">
    {fields.map(field => {
      if (field.type === 'checkbox') {
        return <label key={String(field.key)} className="flex items-start gap-2 text-xs text-fg-muted sm:col-span-2">
          <input type="checkbox" checked={Boolean(params[field.key])} onChange={event => update(field.key, event.target.checked as PriceActionParams[typeof field.key])} />
          <span>{field.label}{field.hint ? <span className="block text-[11px] text-fg-subtle">{field.hint}</span> : null}</span>
        </label>;
      }
      if (field.type === 'select') {
        return <label key={String(field.key)} className="text-xs text-fg-muted">
          {field.label}
          <select value={String(params[field.key])} onChange={event => update(field.key, event.target.value as PriceActionParams[typeof field.key])} className="input mt-1 w-full">
            {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>;
      }
      return <label key={String(field.key)} className="text-xs text-fg-muted">
        {field.label}
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={Number(params[field.key])}
          onChange={event => update(field.key, Number(event.target.value) as PriceActionParams[typeof field.key])}
          className="input mt-1 w-full"
        />
        {field.hint ? <span className="mt-0.5 block text-[11px] text-fg-subtle">{field.hint}</span> : null}
      </label>;
    })}
    <p className="text-[11px] text-fg-subtle sm:col-span-2">{describePriceActionPattern(pattern)} — the condition is evaluated on the closed candle only.</p>
  </div>;
}
