import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronDown, ChevronUp, CirclePlus, Trash2, WandSparkles, X } from 'lucide-react';
import { indicatorCatalogEntry, type IndicatorCatalogEntry } from '../../services/strategy/indicators/catalog';
import {
  priceActionParamsSchema,
  validateStrategyDefinition,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyIndicator,
} from '../../services/strategy/schema';
import { draftToEditorModel, type AiDraft, type DraftGap } from '../../services/strategy/aiDraft';
import { ConditionEditor } from './ConditionEditor';
import { IndicatorPicker } from './IndicatorPicker';
import {
  defaultParams,
  draftFromAiCondition,
  groupedCondition,
  newComparison,
  newIndicator,
  type ConditionDraft,
  type IndicatorDraft,
} from './builderModel';

/**
 * THE STRATEGY BUILDER
 * ====================
 *
 * One editor for both paths. A strategy written by hand and a strategy the
 * AI drafted end up in exactly the same form, with the same validation and
 * the same save.
 *
 * The builder never invents anything. A value the AI did not supply keeps
 * the builder's own suggested default, and it is marked as a suggestion
 * until the user changes it. A field the draft could not fill at all is
 * listed as still needing a decision.
 */

const requestId = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '_') ?? `request_${Date.now()}_${Math.random().toString(36).slice(2)}`;

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

type Timeframe = typeof TIMEFRAMES[number];

export function StrategyBuilder({
  headers,
  onClose,
  onCreated,
}: {
  headers: (json?: boolean) => Promise<Headers>;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instrument, setInstrument] = useState('BTC');
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PRIVATE');
  const [indicators, setIndicators] = useState<IndicatorDraft[]>([]);
  const [entryConditions, setEntryConditions] = useState<ConditionDraft[]>([]);
  const [entryJoin, setEntryJoin] = useState<'all' | 'any'>('all');
  const [exitConditions, setExitConditions] = useState<ConditionDraft[]>([]);
  const [exitJoin, setExitJoin] = useState<'all' | 'any'>('all');
  const [sizingMode, setSizingMode] = useState<'PERCENT_RISK' | 'FIXED_QUANTITY'>('PERCENT_RISK');
  const [sizeValue, setSizeValue] = useState(1);
  const [stopLoss, setStopLoss] = useState(1);
  const [takeProfit, setTakeProfit] = useState(2);
  const [maxExposure, setMaxExposure] = useState(25);
  const [maxTrades, setMaxTrades] = useState(10);
  const [cooldown, setCooldown] = useState(1);
  const [maxDailyLoss, setMaxDailyLoss] = useState(5);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
  const [aiGaps, setAiGaps] = useState<DraftGap[]>([]);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiProvided, setAiProvided] = useState<Set<string>>(new Set());
  const [aiError, setAiError] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stableRequestId = useRef(requestId());

  const gaps = useMemo(() => new Set(aiGaps.map(gap => gap.field)), [aiGaps]);
  const suggested = useCallback((field: string) => aiProvided.size > 0 && !aiProvided.has(field), [aiProvided]);

  const definition = useMemo<StrategyDefinition | null>(() => {
    const entry = groupedCondition(entryConditions, entryJoin);
    if (!entry) return null;
    const exit = groupedCondition(exitConditions, exitJoin);
    const strategyIndicators: StrategyIndicator[] = indicators.map(indicator => ({
      id: indicator.id,
      type: indicator.type,
      params: indicator.params,
      output: indicator.output,
    }));
    return {
      schemaVersion: 2,
      strategyId: 'draft_strategy',
      versionId: 'draft_version',
      version: 1,
      name: name.trim(),
      description,
      market: { provider: 'hyperliquid', instrument: instrument.trim().toUpperCase(), timeframe },
      indicators: strategyIndicators,
      entry: { direction, condition: entry },
      exit: exit ? { condition: exit } : {},
      risk: {
        sizing: sizingMode === 'PERCENT_RISK' ? { mode: sizingMode, percent: sizeValue } : { mode: sizingMode, quantity: sizeValue },
        stopLossPercent: stopLoss,
        takeProfitPercent: takeProfit,
        maxExposurePercent: maxExposure,
        maxConcurrentPositions: 1,
        maxTradesPerDay: maxTrades,
        cooldownCandles: cooldown,
        maxDailyLossPercent: maxDailyLoss,
      },
      execution: { mode: 'PAPER', startingBalance: 10_000, feeRate: 0.00045, slippageBps: 2 },
      visibility,
      validationStatus: 'VALID',
      createdAt: new Date().toISOString(),
    };
  }, [name, description, instrument, timeframe, direction, visibility, indicators, entryConditions, entryJoin, exitConditions, exitJoin, sizingMode, sizeValue, stopLoss, takeProfit, maxExposure, maxTrades, cooldown, maxDailyLoss]);

  const validation = useMemo(() => (definition ? validateStrategyDefinition(definition) : { success: false, errors: ['Add at least one entry condition.'] }), [definition]);

  const moveIndicator = (index: number, offset: number) => setIndicators(previous => {
    const next = [...previous];
    const target = index + offset;
    if (target < 0 || target >= next.length) return previous;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  const addIndicator = (entry: IndicatorCatalogEntry) => {
    const indicator = newIndicator(entry.key, indicators);
    setIndicators([...indicators, indicator]);
    if (!entryConditions.length) setEntryConditions([newComparison(indicator.id)]);
    setPickerOpen(false);
  };

  const updateIndicator = (index: number, value: Partial<IndicatorDraft>) => setIndicators(previous => previous.map((item, itemIndex) => (itemIndex === index ? { ...item, ...value } : item)));

  /**
   * Removes an indicator.
   *
   * A condition that pointed at the removed indicator would break, so the
   * reference is moved to the first remaining indicator rather than left
   * dangling. Nothing is silently deleted.
   */
  const removeIndicator = (index: number) => {
    const removed = indicators[index];
    if (!removed) return;
    const remaining = indicators.filter((_, itemIndex) => itemIndex !== index);
    const fallback = remaining[0]?.id ?? '';
    const clear = (conditions: ConditionDraft[]): ConditionDraft[] => conditions.map(condition => {
      if (condition.kind === 'comparison') {
        const left = condition.left.indicatorId === removed.id ? { ...condition.left, indicatorId: fallback, output: '' } : condition.left;
        const right = condition.right.indicatorId === removed.id ? { ...condition.right, indicatorId: fallback, output: '' } : condition.right;
        return { ...condition, left, right };
      }
      if (condition.kind === 'group') return { ...condition, conditions: clear(condition.conditions) };
      if (condition.kind === 'sequence') return { ...condition, steps: clear(condition.steps) };
      return condition;
    });
    setIndicators(remaining);
    setEntryConditions(previous => clear(previous));
    setExitConditions(previous => clear(previous));
  };

  const generate = async () => {
    setAiBusy(true);
    setAiError('');
    setAiWarnings([]);
    try {
      const response = await fetch('/api/robot-marketplace/ai-draft', {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body?.error?.message || 'AI strategy generation failed.';
        setAiError(`${message}${body?.prompt ? ` Your request was kept: "${String(body.prompt).slice(0, 160)}".` : ''}`);
        return;
      }
      const draft = body.draft as AiDraft | undefined;
      if (!draft) {
        setAiError('The AI did not return a draft you can edit.');
        return;
      }
      applyDraft(draft, (body.gaps ?? []) as DraftGap[], (body.warnings ?? []) as string[]);
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : 'AI strategy generation failed.');
    } finally {
      setAiBusy(false);
    }
  };

  const applyDraft = (draft: AiDraft, gaps: DraftGap[], warnings: string[]) => {
    const model = draftToEditorModel(draft, aiPrompt);
    const byRef = new Map(Object.entries(model.refMap).map(([ref, id]) => [ref, model.indicators.find(indicator => indicator.id === id)!]).filter(([, value]) => Boolean(value)) as Array<[string, IndicatorDraft]>);
    setAiDraft(draft);
    setAiGaps(gaps);
    setAiWarnings(warnings);
    setAiProvided(new Set(model.provided));
    setName(model.name);
    setDescription(model.description);
    setInstrument(model.instrument || 'BTC');
    setTimeframe((model.timeframe ?? timeframe) as Timeframe);
    setDirection(model.direction);
    setIndicators(model.indicators.map(indicator => ({ ...indicator, output: indicator.output ?? '' })));
    setSizingMode(model.risk.sizingMode);
    setSizeValue(model.risk.sizingValue);
    setStopLoss(model.risk.stopLossPercent);
    setTakeProfit(model.risk.takeProfitPercent);
    setMaxExposure(model.risk.maxExposurePercent);
    setMaxTrades(model.risk.maxTradesPerDay);
    setCooldown(model.risk.cooldownCandles);
    setMaxDailyLoss(model.risk.maxDailyLossPercent);
    const entry = draftFromAiCondition(draft.entry, byRef);
    const exit = draftFromAiCondition(draft.exit, byRef);
    setEntryConditions(entry ? [entry] : []);
    setExitConditions(exit ? [exit] : []);
    setMode('manual');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!definition) throw new Error('Add at least one entry condition.');
      const local = validateStrategyDefinition(definition);
      if (!local.success || !local.definition) throw new Error(local.errors.join(' '));
      const response = await fetch('/api/robot-marketplace', {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify({ clientRequestId: stableRequestId.current, definition: local.definition }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Could not create the trading robot.');
      onCreated(body.robot.slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the trading robot.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-5" role="dialog" aria-modal="true">
    <div className="panel flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-b-none sm:rounded-2xl">
      <div className="flex items-center justify-between border-b border-line p-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-accent-text">Strategy builder</p>
          <h2 className="mt-1 text-xl font-black">Create Trading Robot</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="flex gap-2 border-b border-line px-5 py-3">
        <button type="button" onClick={() => setMode('manual')} className={mode === 'manual' ? 'btn btn-primary' : 'btn btn-secondary'}>Create Manually</button>
        <button type="button" onClick={() => setMode('ai')} className={mode === 'ai' ? 'btn btn-primary' : 'btn btn-secondary'}><WandSparkles size={14} /> Create With AI</button>
      </div>

      <form onSubmit={save} className="overflow-y-auto p-5">
        {mode === 'ai' && <section className="mb-5 space-y-3">
          <label className="block text-xs text-fg-muted">
            Describe the exact strategy
            <textarea
              value={aiPrompt}
              onChange={event => setAiPrompt(event.target.value)}
              rows={5}
              className="input mt-1 w-full"
              placeholder="Example: Buy BTC on the 15-minute chart when RSI 14 crosses above 30 and price is above EMA 200. Stop loss 1%, take profit 2%."
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={aiBusy || aiPrompt.trim().length < 10} onClick={() => void generate()} className="btn btn-secondary">
              <WandSparkles size={14} /> {aiBusy ? 'Drafting…' : 'Draft the strategy'}
            </button>
            <span className="text-[11px] text-fg-subtle">The draft opens in the same editor. Nothing is saved until you confirm it.</span>
          </div>
        </section>}

        {aiError && <p role="alert" className="mb-4 rounded-lg border border-danger/30 p-3 text-xs text-danger">{aiError}</p>}

        {aiDraft && <section className="mb-5 rounded-xl border border-line bg-sunken/60 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <WandSparkles size={15} className="text-accent-text" />
            <h3 className="text-sm font-bold">The draft</h3>
            <span className="badge badge-neutral">{aiDraft.source === 'ai' ? 'written by the model' : 'simple keyword match'}</span>
            <span className="badge badge-neutral">{aiDraft.status.replace('_', ' ').toLowerCase()}</span>
          </div>
          {aiWarnings.map(warning => <p key={warning} className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs text-fg-muted">{warning}</p>)}
          {aiGaps.length > 0 && <div className="mt-3">
            <p className="text-xs font-bold text-fg">Still needs a decision</p>
            <ul className="mt-1 space-y-1">
              {aiGaps.map(gap => <li key={gap.field} className="text-xs text-fg-muted">· <span className="text-fg-subtle">{gap.field}</span> — {gap.message}</li>)}
            </ul>
          </div>}
          {aiDraft.ambiguities.length > 0 && <div className="mt-3">
            <p className="text-xs font-bold text-fg">Ambiguities</p>
            <ul className="mt-1 space-y-1">{aiDraft.ambiguities.map(item => <li key={item} className="text-xs text-fg-muted">· {item}</li>)}</ul>
          </div>}
          {aiDraft.unsupported.length > 0 && <div className="mt-3">
            <p className="text-xs font-bold text-fg">Not supported by this builder</p>
            <ul className="mt-1 space-y-1">{aiDraft.unsupported.map(item => <li key={item} className="text-xs text-danger">· {item}</li>)}</ul>
          </div>}
          {aiDraft.assumptions.length > 0 && <div className="mt-3">
            <p className="text-xs font-bold text-fg">Assumptions</p>
            <ul className="mt-1 space-y-1">{aiDraft.assumptions.map(item => <li key={`${item.field}:${item.value}`} className="text-xs text-fg-muted">· {item.field} = {item.value} — {item.reason}</li>)}</ul>
          </div>}
        </section>}

        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-fg-muted">
              Robot name
              <input required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} className="input mt-1 w-full" />
            </label>
            <label className="text-xs text-fg-muted">
              Visibility
              <select value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)} className="input mt-1 w-full">
                <option value="PRIVATE">Private</option>
                <option value="PUBLIC">Public</option>
              </select>
            </label>
          </div>

          <label className="block text-xs text-fg-muted">
            Description
            <textarea value={description} onChange={event => setDescription(event.target.value)} rows={2} maxLength={2000} className="input mt-1 w-full" />
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className={`text-xs text-fg-muted ${gaps.has('market.instrument') ? 'rounded-lg border border-warning/40 p-2' : ''}`}>
              Market
              <input required value={instrument} onChange={event => setInstrument(event.target.value)} className="input mt-1 w-full" />
              {gaps.has('market.instrument') && <span className="mt-1 block text-[11px] text-warning-text">The draft did not name a market.</span>}
            </label>
            <label className={`text-xs text-fg-muted ${gaps.has('market.timeframe') ? 'rounded-lg border border-warning/40 p-2' : ''}`}>
              Timeframe
              <select value={timeframe} onChange={event => setTimeframe(event.target.value as Timeframe)} className="input mt-1 w-full">
                {TIMEFRAMES.map(value => <option key={value}>{value}</option>)}
              </select>
              {gaps.has('market.timeframe') && <span className="mt-1 block text-[11px] text-warning-text">The draft did not name a timeframe.</span>}
            </label>
            <label className={`text-xs text-fg-muted ${gaps.has('direction') ? 'rounded-lg border border-warning/40 p-2' : ''}`}>
              Direction
              <select value={direction} onChange={event => setDirection(event.target.value as typeof direction)} className="input mt-1 w-full">
                <option>LONG</option>
                <option>SHORT</option>
              </select>
              {gaps.has('direction') && <span className="mt-1 block text-[11px] text-warning-text">The draft did not say which way to trade.</span>}
            </label>
          </div>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold">Indicators</h3>
              <button type="button" className="btn btn-secondary" onClick={() => setPickerOpen(open => !open)}><CirclePlus size={13} /> Add indicator</button>
            </div>
            {pickerOpen && <div className="mt-2"><IndicatorPicker onPick={addIndicator} onClose={() => setPickerOpen(false)} /></div>}
            {!indicators.length && <p className="mt-2 text-xs text-fg-subtle">No indicators yet. Conditions can still use price action on their own.</p>}
            <div className="mt-2 space-y-2">
              {indicators.map((indicator, index) => {
                const entry = indicatorCatalogEntry(indicator.type);
                return <div key={indicator.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-fg">{entry?.name ?? indicator.type}</p>
                      <p className="text-[11px] text-fg-subtle">Internal reference {indicator.id} — generated for you, never typed.</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => moveIndicator(index, -1)} aria-label="Move indicator up" className="text-fg-subtle"><ChevronUp size={15} /></button>
                      <button type="button" onClick={() => moveIndicator(index, 1)} aria-label="Move indicator down" className="text-fg-subtle"><ChevronDown size={15} /></button>
                      <button type="button" onClick={() => removeIndicator(index)} aria-label="Remove indicator" className="text-fg-subtle"><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {entry?.parameters.map(parameter => <label key={parameter.key} className="text-xs text-fg-muted">
                      {parameter.label}
                      <input
                        type="number"
                        min={parameter.min}
                        max={parameter.max}
                        step={parameter.step}
                        value={indicator.params[parameter.key] ?? parameter.default}
                        onChange={event => updateIndicator(index, { params: { ...indicator.params, [parameter.key]: Number(event.target.value) } })}
                        className="input mt-1 w-full"
                      />
                      <span className="mt-0.5 block text-[11px] text-fg-subtle">{parameter.description}</span>
                    </label>)}
                    {entry && entry.outputs.length > 1 && <label className="text-xs text-fg-muted">
                      Output used by default
                      <select value={indicator.output} onChange={event => updateIndicator(index, { output: event.target.value })} className="input mt-1 w-full">
                        {entry.outputs.map(output => <option key={output.key} value={output.key}>{output.label}</option>)}
                      </select>
                    </label>}
                  </div>
                </div>;
              })}
            </div>
          </section>

          <ConditionSection
            title="Entry conditions"
            required
            join={entryJoin}
            setJoin={setEntryJoin}
            conditions={entryConditions}
            setConditions={setEntryConditions}
            indicators={indicators}
            gap={gaps.has('entry')}
          />
          <ConditionSection
            title="Exit conditions (optional)"
            join={exitJoin}
            setJoin={setExitJoin}
            conditions={exitConditions}
            setConditions={setExitConditions}
            indicators={indicators}
          />

          <section>
            <h3 className="text-sm font-bold">Position &amp; risk</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-4">
              <label className="text-xs text-fg-muted">
                Sizing
                <select value={sizingMode} onChange={event => setSizingMode(event.target.value as typeof sizingMode)} className="input mt-1 w-full">
                  <option value="PERCENT_RISK">% equity risk</option>
                  <option value="FIXED_QUANTITY">Fixed quantity</option>
                </select>
              </label>
              <NumberField label={sizingMode === 'PERCENT_RISK' ? 'Risk per trade %' : 'Quantity'} value={sizeValue} onChange={setSizeValue} min={0.01} max={sizingMode === 'PERCENT_RISK' ? 10 : 1_000_000} suggested={suggested('risk.sizingValue')} gap={gaps.has('risk.sizingValue')} />
              <NumberField label="Stop loss %" value={stopLoss} onChange={setStopLoss} min={0.01} max={50} suggested={suggested('risk.stopLossPercent')} gap={gaps.has('risk.stopLossPercent')} />
              <NumberField label="Take profit %" value={takeProfit} onChange={setTakeProfit} min={0.01} max={100} suggested={suggested('risk.takeProfitPercent')} gap={gaps.has('risk.takeProfitPercent')} />
              <NumberField label="Max exposure %" value={maxExposure} onChange={setMaxExposure} min={0.01} max={100} suggested={suggested('risk.maxExposurePercent')} />
              <NumberField label="Max trades / day" value={maxTrades} onChange={setMaxTrades} min={1} max={100} step={1} suggested={suggested('risk.maxTradesPerDay')} />
              <NumberField label="Cooldown candles" value={cooldown} onChange={setCooldown} min={0} max={10_000} step={1} suggested={suggested('risk.cooldownCandles')} />
              <NumberField label="Max daily loss %" value={maxDailyLoss} onChange={setMaxDailyLoss} min={0.01} max={100} suggested={suggested('risk.maxDailyLossPercent')} />
            </div>
          </section>

          {definition && <StrategySummary definition={definition} indicators={indicators} />}
          {!validation.success && <div className="rounded-lg border border-danger/30 p-3 text-xs text-danger">
            {validation.errors.slice(0, 6).map(message => <p key={message}>{message}</p>)}
          </div>}
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button disabled={busy || !validation.success} className="btn btn-primary">{busy ? 'Saving…' : 'Save robot'}</button>
        </div>
      </form>
    </div>
  </div>;
}

function ConditionSection({
  title,
  required = false,
  join,
  setJoin,
  conditions,
  setConditions,
  indicators,
  gap = false,
}: {
  title: string;
  required?: boolean;
  join: 'all' | 'any';
  setJoin: (join: 'all' | 'any') => void;
  conditions: ConditionDraft[];
  setConditions: (update: (previous: ConditionDraft[]) => ConditionDraft[]) => void;
  indicators: IndicatorDraft[];
  gap?: boolean;
}) {
  return <section className={gap ? 'rounded-xl border border-warning/40 p-3' : ''}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        {conditions.length > 1 && <select value={join} onChange={event => setJoin(event.target.value as 'all' | 'any')} aria-label="Condition join" className="input py-1 text-xs">
          <option value="all">ALL (AND)</option>
          <option value="any">ANY (OR)</option>
        </select>}
      </div>
      <button type="button" className="btn btn-secondary" onClick={() => setConditions(previous => [...previous, newComparison(indicators[0]?.id ?? '')])}>
        <CirclePlus size={13} /> Add condition
      </button>
    </div>
    {gap && <p className="mt-1 text-[11px] text-warning-text">The draft did not produce an entry rule for this side.</p>}
    {!conditions.length && <p className="mt-2 text-xs text-fg-subtle">{required ? 'Add the rule that opens a position.' : 'No explicit exit rule. Stops and targets still apply.'}</p>}
    {conditions.length > 0 && <div className="mt-2">
      <ConditionEditor
        conditions={conditions}
        onChange={update => setConditions(update)}
        indicators={indicators}
        removable={!required || conditions.length > 1}
      />
    </div>}
  </section>;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  suggested = false,
  gap = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suggested?: boolean;
  gap?: boolean;
}) {
  return <label className={`text-xs text-fg-muted ${gap ? 'rounded-lg border border-warning/40 p-2' : ''}`}>
    {label}
    {suggested && <span className="badge badge-neutral ml-1 text-[10px]">suggested</span>}
    <input type="number" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} className="input mt-1 w-full" />
  </label>;
}

export function StrategySummary({ definition, indicators }: { definition: StrategyDefinition; indicators?: IndicatorDraft[] }) {
  const list = indicators ?? definition.indicators.map(item => ({ id: item.id, type: item.type, params: item.params, output: item.output ?? '' }));
  const labels = new Map(list.map(item => [item.id, `${item.type} ${describeParameters(item)}`.trim()]));
  return <div className="mt-4 rounded-xl border border-line bg-sunken/60 p-4 text-xs text-fg-muted">
    <p className="font-bold text-fg">Strategy summary</p>
    <p className="mt-2">{definition.entry.direction} {definition.market.instrument} on {definition.market.timeframe}; {list.map(item => `${item.type}(${describeParameters(item)})`).join(', ') || 'no indicators'}.</p>
    <p className="mt-1">Enter when {describeCondition(definition.entry.condition, labels)}.</p>
    <p className="mt-1">{definition.exit.condition ? `Exit when ${describeCondition(definition.exit.condition, labels)}, or` : 'Exit using'} stop {definition.risk.stopLossPercent}% / target {definition.risk.takeProfitPercent}%.</p>
    <p className="mt-1">{definition.risk.sizing.mode === 'PERCENT_RISK' ? `${definition.risk.sizing.percent}% equity risk` : `${definition.risk.sizing.quantity} units`} · max exposure {definition.risk.maxExposurePercent}% · paper only.</p>
  </div>;
}

const describeParameters = (indicator: IndicatorDraft) => {
  const entry = indicatorCatalogEntry(indicator.type);
  if (!entry?.parameters.length) return '';
  return entry.parameters.map(parameter => `${indicator.params[parameter.key] ?? parameter.default}`).join(', ');
};

/**
 * The readable text of a condition.
 *
 * `labels` maps an indicator id to the name it should be called by.
 * `outputs` maps `indicatorId::output` to the text of that output, and an
 * EMPTY string means "do not mention it" — which is what the default output
 * of an indicator gets, because "RSI(14) crosses above 30" already says
 * everything "RSI(14) → RSI crosses above 30" would say, and more.
 */
export function describeCondition(
  condition: StrategyCondition,
  labels: Map<string, string> = new Map(),
  outputs: Map<string, string> = new Map(),
): string {
  if (condition.type === 'all' || condition.type === 'any') return `(${condition.conditions.map(child => describeCondition(child, labels, outputs)).join(condition.type === 'all' ? ' AND ' : ' OR ')})`;
  if (condition.type === 'not') return `NOT ${describeCondition(condition.condition, labels, outputs)}`;
  if (condition.type === 'price_action') return `${condition.pattern.replaceAll('_', ' ').toLowerCase()} (${condition.params.lookback} candles)`;
  if (condition.type === 'sequence') return `${condition.steps.map(step => describeCondition(step, labels, outputs)).join(' THEN ')} (within ${condition.maxGapCandles} candles)`;
  const operand = (value: StrategyCondition extends never ? never : any) => {
    if (value.kind === 'constant') return String(value.value);
    if (value.kind === 'price') return value.field;
    const output = value.output ? (outputs.get(`${value.indicatorId}::${value.output}`) ?? value.output) : '';
    return `${labels.get(value.indicatorId) ?? value.indicatorId}${output ? ` → ${output}` : ''}`;
  };
  return `${operand(condition.left)} ${condition.operator.replaceAll('_', ' ').toLowerCase()} ${operand(condition.right)}`;
}
