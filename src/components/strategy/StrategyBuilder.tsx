import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronDown, ChevronUp, CirclePlus, Crosshair, Redo2, Rocket, ShieldCheck, Trash2, Undo2, WandSparkles, X } from 'lucide-react';
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
  conditionDraftErrors,
  draftFromAiCondition,
  groupedCondition,
  newComparison,
  newGroup,
  newIndicator,
  type ConditionDraft,
  type IndicatorDraft,
} from './builderModel';
import './robot-builder.css';

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

interface BuilderSnapshot {
  name: string;
  description: string;
  instrument: string;
  timeframe: Timeframe;
  direction: 'LONG' | 'SHORT';
  visibility: 'PUBLIC' | 'PRIVATE';
  indicators: IndicatorDraft[];
  entryConditions: ConditionDraft[];
  entryJoin: 'all' | 'any';
  exitConditions: ConditionDraft[];
  exitJoin: 'all' | 'any';
  sizingMode: 'PERCENT_RISK' | 'FIXED_QUANTITY';
  sizeValue: number;
  stopLoss: number;
  takeProfit: number;
  maxExposure: number;
  maxTrades: number;
  cooldown: number;
  maxDailyLoss: number;
  advanced: boolean;
  action: 'BUY' | 'SELL' | 'CLOSE_POSITION' | 'NO_TRADE' | 'ALERT_ONLY';
}

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
  const [advanced, setAdvanced] = useState(false);
  const [action, setAction] = useState<'BUY' | 'SELL' | 'CLOSE_POSITION' | 'NO_TRADE' | 'ALERT_ONLY'>('BUY');
  const [riskConfirmed, setRiskConfirmed] = useState(false);

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
  const undoStack = useRef<BuilderSnapshot[]>([]);
  const redoStack = useRef<BuilderSnapshot[]>([]);
  const previousSnapshot = useRef<BuilderSnapshot | null>(null);
  const skipHistory = useRef(false);
  const [, setHistoryVersion] = useState(0);

  const snapshot = useMemo<BuilderSnapshot>(() => ({
    name, description, instrument, timeframe, direction, visibility, indicators,
    entryConditions, entryJoin, exitConditions, exitJoin, sizingMode, sizeValue,
    stopLoss, takeProfit, maxExposure, maxTrades, cooldown, maxDailyLoss, advanced, action,
  }), [name, description, instrument, timeframe, direction, visibility, indicators, entryConditions, entryJoin, exitConditions, exitJoin, sizingMode, sizeValue, stopLoss, takeProfit, maxExposure, maxTrades, cooldown, maxDailyLoss, advanced, action]);

  useEffect(() => {
    const previous = previousSnapshot.current;
    if (skipHistory.current) {
      skipHistory.current = false;
      previousSnapshot.current = snapshot;
      return;
    }
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
      undoStack.current = [...undoStack.current.slice(-49), previous];
      redoStack.current = [];
      setHistoryVersion(version => version + 1);
    }
    previousSnapshot.current = snapshot;
  }, [snapshot]);

  const restoreSnapshot = useCallback((value: BuilderSnapshot) => {
    skipHistory.current = true;
    setName(value.name); setDescription(value.description); setInstrument(value.instrument);
    setTimeframe(value.timeframe); setDirection(value.direction); setVisibility(value.visibility);
    setIndicators(value.indicators); setEntryConditions(value.entryConditions); setEntryJoin(value.entryJoin);
    setExitConditions(value.exitConditions); setExitJoin(value.exitJoin); setSizingMode(value.sizingMode);
    setSizeValue(value.sizeValue); setStopLoss(value.stopLoss); setTakeProfit(value.takeProfit);
    setMaxExposure(value.maxExposure); setMaxTrades(value.maxTrades); setCooldown(value.cooldown);
    setMaxDailyLoss(value.maxDailyLoss); setAdvanced(value.advanced); setAction(value.action);
    setRiskConfirmed(false);
  }, []);

  const undo = () => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    if (previousSnapshot.current) redoStack.current.push(previousSnapshot.current);
    restoreSnapshot(previous);
    setHistoryVersion(version => version + 1);
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    if (previousSnapshot.current) undoStack.current.push(previousSnapshot.current);
    restoreSnapshot(next);
    setHistoryVersion(version => version + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [busy, onClose]);

  const gaps = useMemo(() => new Set(aiGaps.map(gap => gap.field)), [aiGaps]);
  const resolveGap = (field: string) => setAiGaps(previous => previous.filter(gap => gap.field !== field));
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
      schemaVersion: 3,
      strategyId: 'draft_strategy',
      versionId: 'draft_version',
      version: 1,
      name: name.trim(),
      description,
      market: { provider: 'hyperliquid', instrument: instrument.trim().toUpperCase(), timeframe },
      indicators: strategyIndicators,
      entry: { direction, condition: entry },
      then: { action },
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
  }, [name, description, instrument, timeframe, direction, visibility, indicators, entryConditions, entryJoin, exitConditions, exitJoin, sizingMode, sizeValue, stopLoss, takeProfit, maxExposure, maxTrades, cooldown, maxDailyLoss, action]);

  const validation = useMemo(() => {
    const result = definition ? validateStrategyDefinition(definition) : { success: false, errors: ['Add at least one entry condition.'] };
    const draftErrors = [...conditionDraftErrors(entryConditions), ...conditionDraftErrors(exitConditions)];
    const errors = [...result.errors, ...draftErrors, ...aiGaps.map(gap => gap.message)];
    const riskError = (action === 'BUY' || action === 'SELL') && !riskConfirmed ? ['Review and confirm the position size, stop loss and target before deployment.'] : [];
    return { ...result, success: result.success && errors.length === 0 && riskError.length === 0, errors: [...errors, ...riskError] };
  }, [definition, aiGaps, action, riskConfirmed, entryConditions, exitConditions]);

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
    // Each selected indicator creates an editable entry rule immediately.
    // It cannot sit on the strategy as an unused standalone decoration.
    setEntryConditions(previous => [...previous, newComparison(indicator.id)]);
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
        const rangeTo = condition.rangeTo?.indicatorId === removed.id ? { ...condition.rangeTo, indicatorId: fallback, output: '' } : condition.rangeTo;
        return { ...condition, left, right, rangeTo };
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
    setAction(model.direction === 'LONG' ? 'BUY' : 'SELL');
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

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="robot-builder-title" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="robot-builder flex max-h-[96vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-[24px] border border-white/10 bg-[#0d0d12] text-white shadow-2xl sm:rounded-[24px]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 p-5 sm:px-7">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-red-500">Robot studio</p>
          <h2 id="robot-builder-title" className="mt-1 text-xl font-black sm:text-2xl">Build an executable strategy</h2>
          <p className="mt-1 text-xs text-white/45">Design the logic first. Bind it to a market only when you deploy.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={undo} disabled={!undoStack.current.length} aria-label="Undo last change" title="Undo (Ctrl+Z)" className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5 disabled:opacity-35"><Undo2 size={16} /></button>
          <button type="button" onClick={redo} disabled={!redoStack.current.length} aria-label="Redo last change" title="Redo (Ctrl+Y)" className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5 disabled:opacity-35"><Redo2 size={16} /></button>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5"><X size={18} /></button>
        </div>
      </div>
      <div className="grid grid-cols-3 border-b border-white/10 bg-black/20 px-5 py-3 text-[11px] font-bold sm:px-7">
        <span className="flex items-center gap-2 text-red-400"><i className="grid h-5 w-5 place-items-center rounded-full bg-red-600 text-[9px] text-white">1</i> Blueprint</span>
        <span className="flex items-center gap-2 text-white/55"><i className="grid h-5 w-5 place-items-center rounded-full bg-white/10 text-[9px]">2</i> Rules &amp; risk</span>
        <span className="flex items-center justify-end gap-2 text-white/55"><i className="grid h-5 w-5 place-items-center rounded-full bg-white/10 text-[9px]">3</i> Deployment</span>
      </div>
      <div className="flex gap-2 border-b border-white/10 px-5 py-3 sm:px-7">
        <button type="button" onClick={() => setMode('manual')} className={mode === 'manual' ? 'robot-builder-mode is-active' : 'robot-builder-mode'}>Professional editor</button>
        <button type="button" onClick={() => setMode('ai')} className={mode === 'ai' ? 'robot-builder-mode is-active' : 'robot-builder-mode'}><WandSparkles size={14} /> AI strategy architect</button>
      </div>

      <form onSubmit={save} className="overflow-y-auto p-5 sm:px-7 sm:py-6">
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
          <div>
            <label className="text-xs text-fg-muted">
              Robot name
              <input required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} className="input mt-1 w-full" />
            </label>
          </div>

          <label className="block text-xs text-fg-muted">
            Description
            <textarea value={description} onChange={event => setDescription(event.target.value)} rows={2} maxLength={2000} className="input mt-1 w-full" />
          </label>

          <section className="rounded-2xl border border-white/10 bg-white/[.025] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-sm font-bold">Entry conditions</h3><p className="mt-1 text-xs text-fg-subtle">Choose a signal, then set what it must do before the robot enters.</p></div>
              <button type="button" className="btn btn-secondary" onClick={() => setPickerOpen(open => !open)}><CirclePlus size={13} /> Add indicator condition</button>
            </div>
            {pickerOpen && <div className="mt-2"><IndicatorPicker onPick={addIndicator} onClose={() => setPickerOpen(false)} /></div>}
            {!indicators.length && <p className="mt-2 text-xs text-fg-subtle">Use any of the 53 indicators in a condition, or add a price action rule below.</p>}
            <div className="mt-2 space-y-2">
              {indicators.map((indicator, index) => {
                const entry = indicatorCatalogEntry(indicator.type);
                return <div key={indicator.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-fg">{entry?.name ?? indicator.type}</p>
                      <p className="text-[11px] text-fg-subtle">This signal is used by the entry condition below.</p>
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

          <section className="rounded-2xl border border-white/10 bg-white/[.025] p-4">
            <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-red-600/15 text-red-400"><Crosshair size={17}/></span><div><h3 className="text-sm font-bold">Signal context</h3><p className="mt-1 text-[11px] leading-relaxed text-white/45">These settings define how the entry conditions are evaluated. They travel with this immutable strategy version.</p></div></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className={`text-xs text-white/55 ${gaps.has('market.timeframe') ? 'rounded-lg border border-warning/40 p-2' : ''}`}>Condition timeframe<select value={timeframe} onChange={event => { setTimeframe(event.target.value as Timeframe); resolveGap('market.timeframe'); }} className="input mt-1 w-full">{TIMEFRAMES.map(value => <option key={value}>{value}</option>)}</select><span className="mt-1 block text-[10px] text-white/35">Every indicator and price-action rule below evaluates on this candle interval.</span></label>
              <fieldset className={`text-xs text-white/55 ${gaps.has('direction') ? 'rounded-lg border border-warning/40 p-2' : ''}`}><legend>Position intent</legend><div className="mt-1 grid grid-cols-2 gap-2">{(['LONG','SHORT'] as const).map(value=><button key={value} type="button" onClick={()=>{setDirection(value);setAction(value==='LONG'?'BUY':'SELL');resolveGap('direction');}} className={direction===value?'robot-direction is-active':'robot-direction'}>{value==='LONG'?'Buy / Long':'Sell / Short'}</button>)}</div><span className="mt-1 block text-[10px] text-white/35">Direction is part of the entry rule, not a separate market preference.</span></fieldset>
            </div>
          </section>

          <ConditionSection
            title="IF · Entry rules"
            required
            join={entryJoin}
            setJoin={setEntryJoin}
            conditions={entryConditions}
            setConditions={setEntryConditions}
            indicators={indicators}
            gap={gaps.has('entry')}
            advanced={advanced}
            onAdvancedChange={setAdvanced}
            onConditionsEdit={() => setAiGaps(previous => previous.filter(gap => gap.field !== 'entry' && !gap.field.startsWith('entry.')))}
          />
          <ConditionSection
            title="Exit conditions (optional)"
            join={exitJoin}
            setJoin={setExitJoin}
            conditions={exitConditions}
            setConditions={setExitConditions}
            indicators={indicators}
            advanced={advanced}
          />

          <section className="rounded-2xl border border-red-500/25 bg-red-500/[.04] p-4 sm:p-5" aria-label="Then action">
            <div className="flex items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-red-600 text-sm font-black">THEN</span><div><h3 className="text-sm font-bold">What should the robot do?</h3><p className="mt-1 text-[11px] text-white/45">Signals are simulated in paper mode. Nothing here enables live orders.</p></div></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-white/55">Action<select value={action} onChange={event => { const next = event.target.value as typeof action; setAction(next); setRiskConfirmed(false); if (next === 'BUY') setDirection('LONG'); if (next === 'SELL') setDirection('SHORT'); }} className="input mt-1 w-full"><option value="BUY">BUY / open long</option><option value="SELL">SELL / open short</option><option value="CLOSE_POSITION">Close position</option><option value="ALERT_ONLY">Alert only</option><option value="NO_TRADE">No trade / skip</option></select></label>
              {(action === 'BUY' || action === 'SELL') && <p className="self-end text-[11px] text-white/45">{instrument || 'Instrument'} · {direction} · risk {sizeValue}% · stop {stopLoss}% · target {takeProfit}%</p>}
              {action === 'CLOSE_POSITION' && <p className="self-end text-[11px] text-white/45">Closes an existing paper position when these IF rules match. No entry order is created.</p>}
              {(action === 'ALERT_ONLY' || action === 'NO_TRADE') && <p className="self-end text-[11px] text-white/45">No order will be placed for this action.</p>}
              {(action === 'BUY' || action === 'SELL') && <label className="flex items-start gap-2 text-[11px] text-white/65 sm:col-span-2"><input type="checkbox" checked={riskConfirmed} onChange={event=>setRiskConfirmed(event.target.checked)} className="mt-0.5 accent-red-500"/>I reviewed the risk per trade, stop loss, take profit and exposure settings shown below.</label>}
            </div>
            {(action === 'BUY' || action === 'SELL') && <div className="mt-4 border-t border-white/10 pt-4">
              <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-red-400"/><h3 className="text-sm font-bold">Position &amp; risk</h3></div>
              <div className="mt-2 grid gap-3 sm:grid-cols-4">
              <label className="text-xs text-fg-muted">
                Sizing
                <select value={sizingMode} onChange={event => { setSizingMode(event.target.value as typeof sizingMode); resolveGap('risk.sizing'); }} className="input mt-1 w-full">
                  <option value="PERCENT_RISK">% equity risk</option>
                  <option value="FIXED_QUANTITY">Fixed quantity</option>
                </select>
              </label>
              <NumberField label={sizingMode === 'PERCENT_RISK' ? 'Risk per trade %' : 'Quantity'} value={sizeValue} onChange={value => { setRiskConfirmed(false); setSizeValue(value); resolveGap('risk.sizingValue'); }} min={0.01} max={sizingMode === 'PERCENT_RISK' ? 10 : 1_000_000} suggested={suggested('risk.sizingValue')} gap={gaps.has('risk.sizingValue')} />
              <NumberField label="Stop loss %" value={stopLoss} onChange={value => { setRiskConfirmed(false); setStopLoss(value); resolveGap('risk.stopLossPercent'); }} min={0.01} max={50} suggested={suggested('risk.stopLossPercent')} gap={gaps.has('risk.stopLossPercent')} />
              <NumberField label="Take profit %" value={takeProfit} onChange={value => { setRiskConfirmed(false); setTakeProfit(value); resolveGap('risk.takeProfitPercent'); }} min={0.01} max={100} suggested={suggested('risk.takeProfitPercent')} gap={gaps.has('risk.takeProfitPercent')} />
              </div>
              <details className="mt-3 rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-xs font-semibold text-white/65">Advanced risk settings</summary><div className="mt-3 grid gap-3 sm:grid-cols-3">
                <NumberField label="Max exposure %" value={maxExposure} onChange={setMaxExposure} min={0.01} max={100} suggested={suggested('risk.maxExposurePercent')} />
                <NumberField label="Max trades / day" value={maxTrades} onChange={setMaxTrades} min={1} max={100} step={1} suggested={suggested('risk.maxTradesPerDay')} />
                <NumberField label="Cooldown candles" value={cooldown} onChange={setCooldown} min={0} max={10_000} step={1} suggested={suggested('risk.cooldownCandles')} />
                <NumberField label="Max daily loss %" value={maxDailyLoss} onChange={setMaxDailyLoss} min={0.01} max={100} suggested={suggested('risk.maxDailyLossPercent')} />
              </div></details>
            </div>}
          </section>

          <section className="rounded-2xl border border-red-500/25 bg-red-500/[.04] p-4 sm:p-5">
            <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-600 text-white shadow-[0_8px_24px_rgba(220,38,38,.3)]"><Rocket size={18}/></span><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-red-400">Deployment profile</p><h3 className="mt-1 text-base font-black">Bind strategy to a market</h3><p className="mt-1 text-[11px] leading-relaxed text-white/45">Your reusable logic is complete. Choose where this version will run; deployment creates an immutable, auditable robot.</p></div></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr]">
              <label className={`text-xs text-white/55 ${gaps.has('market.instrument') ? 'rounded-lg border border-warning/40 p-2' : ''}`}>Deployment instrument<input required value={instrument} onChange={event=>{setInstrument(event.target.value);resolveGap('market.instrument');}} placeholder="BTC, ETH, SOL…" className="input mt-1 w-full uppercase"/><span className="mt-1 block text-[10px] text-white/35">Hyperliquid symbol. Validated by the server before execution.</span></label>
              <label className="text-xs text-white/55">Publication<select value={visibility} onChange={event=>setVisibility(event.target.value as typeof visibility)} className="input mt-1 w-full"><option value="PRIVATE">Private deployment</option><option value="PUBLIC">Public in Bots directory</option></select><span className="mt-1 block text-[10px] text-white/35">Paper execution only. Public robots expose rules, never credentials.</span></label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px]"><span className="rounded-full bg-white/5 px-2.5 py-1 text-white/55">{instrument.toUpperCase()||'Instrument'}</span><span className="rounded-full bg-white/5 px-2.5 py-1 text-white/55">{timeframe} conditions</span><span className="rounded-full bg-white/5 px-2.5 py-1 text-white/55">{direction}</span><span className="rounded-full bg-white/5 px-2.5 py-1 text-white/55">Paper only</span></div>
          </section>

          {definition && <StrategySummary definition={definition} indicators={indicators} />}
          {!validation.success && <div className="rounded-lg border border-danger/30 p-3 text-xs text-danger">
            {validation.errors.slice(0, 6).map(message => <p key={message}>{message}</p>)}
          </div>}
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button disabled={busy || !validation.success} className="robot-deploy-button"><Rocket size={15}/>{busy ? 'Deploying…' : 'Validate & deploy robot'}</button>
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
  advanced = false,
  onAdvancedChange,
  onConditionsEdit,
}: {
  title: string;
  required?: boolean;
  join: 'all' | 'any';
  setJoin: (join: 'all' | 'any') => void;
  conditions: ConditionDraft[];
  setConditions: (update: (previous: ConditionDraft[]) => ConditionDraft[]) => void;
  indicators: IndicatorDraft[];
  gap?: boolean;
  advanced?: boolean;
  onAdvancedChange?: (value: boolean) => void;
  onConditionsEdit?: () => void;
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
      <div className="flex gap-2"><button type="button" className="btn btn-secondary" onClick={() => { onConditionsEdit?.(); if (!conditions.length || join === 'all') { setConditions(previous => [...previous, newComparison(indicators[0]?.id ?? '')]); return; } const group = newGroup('any'); group.conditions = conditions; setConditions(() => [group, newComparison(indicators[0]?.id ?? '')]); setJoin('all'); }}><CirclePlus size={13} /> + AND</button>
      <button type="button" className="btn btn-secondary" onClick={() => { onConditionsEdit?.(); if (!conditions.length || join === 'any') { setConditions(previous => [...previous, newComparison(indicators[0]?.id ?? '')]); return; } const group = newGroup('all'); group.conditions = conditions; setConditions(() => [group, newComparison(indicators[0]?.id ?? '')]); setJoin('any'); }}>+ OR alternative</button></div>
    </div>
    {conditions.length > 1 && <p className="mt-1 text-[11px] text-white/40">This list is evaluated as {join === 'all' ? 'ALL conditions (AND)' : 'ANY condition (OR)'}. For mixed logic, add a nested group and choose its join.</p>}
    {onAdvancedChange && <button type="button" className="mt-2 text-[11px] font-semibold text-red-400" aria-pressed={advanced} onClick={() => onAdvancedChange(!advanced)}>{advanced ? 'Hide advanced logic' : 'Advanced logic: nested groups & FOLLOWED BY'}</button>}
    {gap && <p className="mt-1 text-[11px] text-warning-text">The draft did not produce an entry rule for this side.</p>}
    {!conditions.length && <p className="mt-2 text-xs text-fg-subtle">{required ? 'Add the rule that opens a position.' : 'No explicit exit rule. Stops and targets still apply.'}</p>}
    {conditions.length > 0 && <div className="mt-2">
      <ConditionEditor
        conditions={conditions}
        onChange={update => { onConditionsEdit?.(); setConditions(update); }}
        indicators={indicators}
        removable={!required || conditions.length > 1}
        advanced={advanced}
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
