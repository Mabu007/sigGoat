import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, Clock, Loader2, Play, Square, Target, X } from 'lucide-react';
import type { StrategyDefinition } from '../../services/strategy/schema';
import { BrokerConnections } from './BrokerConnections';
import { indicatorCatalogEntry } from '../../services/strategy/indicators/catalog';
import { StrategySummary, describeCondition } from './StrategyBuilder';
import type { RobotCardAction, RobotSummary } from './RobotCard';

/**
 * THE ROBOT SHEET
 * ===============
 *
 * The panel behind PAIRS, TRADE and INFO. It is a bottom sheet on a phone
 * and a centred dialog on a larger screen, because the content is a column
 * of information and a column reads better than a grid on a small display.
 *
 * THE THREE VIEWS ANSWER THREE DIFFERENT QUESTIONS
 * -------------------------------------------------
 *   PAIRS  What does this robot trade? The instrument, the timeframe and
 *          the rules that decide when it acts.
 *   TRADE  Where is it now? The execution mode, the broker connection, the
 *          performance so far, and the controls to start or stop the paper
 *          runtime.
 *   INFO   What is this, exactly? The creator, the description, the whole
 *          strategy, the risk settings and every performance number, with
 *          historical, paper and live clearly separated.
 *
 * NOTHING HERE PLACES AN ORDER
 * ----------------------------
 *   The runtime in this build is paper only. The sheet says so, and the
 *   only controls it offers are the ones the paper runtime actually has.
 */

interface RobotDetail {
  robot: RobotSummary;
  definition: StrategyDefinition;
  backtests: Array<{
    id: string;
    createdAt: string;
    result: { metrics: { totalReturn: number; winRate: number; maxDrawdown: number; profitFactor: number | null; completedTrades: number } };
  }>;
  runtime: {
    status: string;
    balance: number;
    equity: number;
    trades: unknown[];
    lastProcessedCandleTime: number | null;
  } | null;
  canManage: boolean;
}

export function RobotSheet({
  robot,
  action,
  headers,
  onClose,
  onOpenWorkspace,
}: {
  robot: RobotSummary;
  action: RobotCardAction;
  headers: (json?: boolean) => Promise<Headers>;
  onClose: () => void;
  onOpenWorkspace: () => void;
}) {
  const [detail, setDetail] = useState<RobotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robot.slug)}`, {
        headers: await headers(),
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'This robot could not be read.');
      setDetail(body as RobotDetail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This robot could not be read.');
    } finally {
      setLoading(false);
    }
  }, [robot.slug, headers]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (kind: 'start' | 'stop') => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(robot.slug)}/${kind}`, {
        method: 'POST',
        headers: await headers(true),
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'The runtime could not be changed.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The runtime could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const title = action === 'pairs' ? 'Pairs' : action === 'trade' ? 'Trade' : 'Info';

  return <div
    className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-5"
    role="dialog"
    aria-modal="true"
    aria-label={`${title} for ${robot.name}`}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-2xl sm:rounded-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-accent-text">{title}</p>
          <h2 className="truncate text-base font-black text-fg">{robot.name}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-fg-subtle hover:text-fg"><X size={18} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && <div className="flex items-center gap-2 py-8 text-sm text-fg-muted"><Loader2 size={16} className="animate-spin" /> Loading…</div>}
        {error && !loading && <p role="alert" className="rounded-lg border border-danger/30 p-3 text-sm text-danger">{error}</p>}
        {!loading && detail && (
          action === 'pairs' ? <PairsView detail={detail} />
            : action === 'trade' ? <TradeView detail={detail} headers={headers} busy={busy} onAct={act} />
              : <InfoView detail={detail} onOpenWorkspace={onOpenWorkspace} />
        )}
      </div>

      {detail && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p className="text-[11px] text-fg-subtle">
            {detail.canManage ? 'You own this robot.' : `By ${detail.robot.creatorName || 'a robot creator'}`}
          </p>
          <button type="button" onClick={onOpenWorkspace} className="btn btn-secondary text-xs">Open the full workspace</button>
        </div>
      )}
    </div>
  </div>;
}

/* ------------------------------------------------------------------ */
/* PAIRS                                                               */
/* ------------------------------------------------------------------ */

/**
 * The readable names of the indicators a condition refers to, so a rule
 * reads "RSI(14) crosses above 30" instead of "rsi → rsi cross above 30".
 */
function conditionLabels(definition: StrategyDefinition): Map<string, string> {
  return new Map(definition.indicators.map(indicator => {
    const parameters = Object.values(indicator.params ?? {});
    return [indicator.id, `${indicator.type}${parameters.length ? `(${parameters.join(', ')})` : ''}`];
  }));
}

/**
 * The readable text of each indicator output.
 *
 * The output an indicator uses by DEFAULT gets an empty string, so it is not
 * repeated: "RSI(14) crosses above 30" reads better than "RSI(14) → RSI
 * crosses above 30", and a second output still names itself.
 */
function conditionOutputs(definition: StrategyDefinition): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const indicator of definition.indicators) {
    const entry = indicatorCatalogEntry(indicator.type);
    if (!entry) continue;
    for (const output of entry.outputs) {
      const isDefault = output.key === (indicator.output ?? entry.outputs[0].key);
      outputs.set(`${indicator.id}::${output.key}`, isDefault ? '' : output.label);
    }
  }
  return outputs;
}

function PairsView({ detail }: { detail: RobotDetail }) {
  const definition = detail.definition;
  const indicators = definition.indicators ?? [];
  const labels = conditionLabels(definition);
  const outputs = conditionOutputs(definition);
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-2">
      <Fact icon={<Target size={13} />} label="Instrument" value={definition.market.instrument} />
      <Fact icon={<Clock size={13} />} label="Timeframe" value={definition.market.timeframe} />
    </div>

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Rules</h3>
      <p className="mt-1.5 text-sm text-fg-muted">
        {describeCondition(definition.entry.condition, labels, outputs)}
      </p>
      {definition.exit.condition && (
        <p className="mt-1 text-sm text-fg-muted">
          Exits when {describeCondition(definition.exit.condition, labels, outputs)}.
        </p>
      )}
    </section>

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Indicators</h3>
      {indicators.length === 0 ? (
        <p className="mt-1.5 text-sm text-fg-muted">This robot uses price action only. It watches the candles themselves, not a derived series.</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {indicators.map(indicator => (
            <li key={indicator.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-2 text-xs">
              <span className="font-medium text-fg">{indicator.type}</span>
              <span className="truncate text-fg-subtle">
                {Object.entries(indicator.params ?? {}).map(([key, value]) => `${key} ${value}`).join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>

    <p className="rounded-lg border border-line bg-sunken/50 p-3 text-[11px] leading-relaxed text-fg-subtle">
      A robot trades one instrument on one timeframe. Changing either means publishing a new version of its strategy.
    </p>
  </div>;
}

/* ------------------------------------------------------------------ */
/* TRADE                                                               */
/* ------------------------------------------------------------------ */

function TradeView({
  detail,
  headers,
  busy,
  onAct,
}: {
  detail: RobotDetail;
  headers: (json?: boolean) => Promise<Headers>;
  busy: boolean;
  onAct: (kind: 'start' | 'stop') => Promise<void>;
}) {
  const latest = detail.backtests?.[0];
  const runtime = detail.runtime;
  return <div className="space-y-4">
    <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[color:var(--color-warning)]" />
      <p className="text-[11px] leading-relaxed text-fg-muted">
        Paper mode. The runtime evaluates completed candles while this page is open, and it never places a live order.
      </p>
    </div>

    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Fact icon={<Activity size={13} />} label="Runtime" value={runtime?.status ?? 'STOPPED'} />
      <Fact icon={<BarChart3 size={13} />} label="Paper balance" value={runtime ? runtime.equity.toFixed(2) : '—'} />
      <Fact icon={<Activity size={13} />} label="Paper trades" value={runtime ? String(runtime.trades.length) : '—'} />
      <Fact icon={<BarChart3 size={13} />} label="Simulated return" value={latest ? `${latest.result.metrics.totalReturn.toFixed(1)}%` : 'none yet'} />
    </div>

    {detail.canManage && (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || runtime?.status === 'PAPER'}
          onClick={() => void onAct('start')}
          className="btn btn-primary text-xs"
        >
          <Play size={13} /> Start paper trading
        </button>
        <button
          type="button"
          disabled={busy || runtime?.status !== 'PAPER'}
          onClick={() => void onAct('stop')}
          className="btn btn-secondary text-xs"
        >
          <Square size={13} /> Stop
        </button>
      </div>
    )}

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Strategy</h3>
      <div className="mt-1.5"><StrategySummary definition={detail.definition} /></div>
    </section>

    {detail.canManage && (
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Broker connection</h3>
        <div className="mt-1.5">
          <BrokerConnections robotSlug={detail.robot.slug} headers={headers} canManage />
        </div>
      </section>
    )}
  </div>;
}

/* ------------------------------------------------------------------ */
/* INFO                                                                */
/* ------------------------------------------------------------------ */

function InfoView({ detail, onOpenWorkspace }: { detail: RobotDetail; onOpenWorkspace: () => void }) {
  const definition = detail.definition;
  const labels = conditionLabels(definition);
  const outputs = conditionOutputs(definition);
  const latest = detail.backtests?.[0];
  return <div className="space-y-4">
    <section>
      <p className="text-sm leading-relaxed text-fg-muted">{detail.robot.description || 'No description was given for this robot.'}</p>
      <p className="mt-2 text-[11px] text-fg-subtle">
        By {detail.robot.creatorName || 'a robot creator'} · strategy v{detail.robot.currentVersion} · {detail.robot.visibility === 'PRIVATE' ? 'Private' : 'Public'}
      </p>
    </section>

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Trading</h3>
      <dl className="mt-1.5 grid grid-cols-2 gap-2">
        <Fact icon={<Target size={13} />} label="Instrument" value={definition.market.instrument} />
        <Fact icon={<Clock size={13} />} label="Timeframe" value={definition.market.timeframe} />
        <Fact icon={<Activity size={13} />} label="Direction" value={definition.entry.direction} />
        <Fact icon={<Activity size={13} />} label="Bound account" value={detail.robot.brokerAccount ? detail.robot.brokerAccount.label : 'none'} />
      </dl>
    </section>

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Strategy overview</h3>
      <p className="mt-1.5 text-sm text-fg-muted">Enters when {describeCondition(definition.entry.condition, labels, outputs)}.</p>
      {definition.exit.condition && <p className="mt-1 text-sm text-fg-muted">Exits when {describeCondition(definition.exit.condition, labels, outputs)}.</p>}
      {definition.indicators.length > 0 && (
        <p className="mt-1 text-sm text-fg-muted">
          Uses {definition.indicators.map(indicator => `${indicator.type}(${Object.values(indicator.params ?? {}).join(', ')})`).join(', ')}.
        </p>
      )}
    </section>

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Risk</h3>
      <dl className="mt-1.5 grid grid-cols-2 gap-2">
        <Fact label="Stop loss" value={`${definition.risk.stopLossPercent}%`} />
        <Fact label="Take profit" value={`${definition.risk.takeProfitPercent}%`} />
        <Fact label="Position sizing" value={definition.risk.sizing.mode === 'PERCENT_RISK' ? `${definition.risk.sizing.percent}% risk` : `${definition.risk.sizing.quantity} units`} />
        <Fact label="Max exposure" value={`${definition.risk.maxExposurePercent}%`} />
        <Fact label="Max trades / day" value={String(definition.risk.maxTradesPerDay)} />
        <Fact label="Max daily loss" value={`${definition.risk.maxDailyLossPercent}%`} />
      </dl>
    </section>

    <section>
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-subtle">Performance</h3>
      <div className="mt-1.5 space-y-2">
        <div className="rounded-lg border border-line p-3">
          <p className="text-[11px] font-bold text-fg">Historical backtest</p>
          {latest ? (
            <>
              <p className="mt-1 text-[11px] text-fg-muted">
                {latest.result.metrics.totalReturn.toFixed(2)}% simulated return · {latest.result.metrics.winRate.toFixed(0)}% win rate · {latest.result.metrics.completedTrades} trades
              </p>
              <p className="mt-1 text-[10px] text-fg-subtle">
                A simulation over historical candles. It is not a promise and it is not live performance.
              </p>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-fg-muted">No verified backtest has been run for this version yet.</p>
          )}
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-[11px] font-bold text-fg">Paper trading</p>
          <p className="mt-1 text-[11px] text-fg-muted">
            {detail.runtime
              ? `${detail.runtime.trades.length} simulated trades · equity ${detail.runtime.equity.toFixed(2)}`
              : 'The paper runtime has not been started for this robot.'}
          </p>
          <p className="mt-1 text-[10px] text-fg-subtle">Simulated fills on completed candles, in the browser.</p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-[11px] font-bold text-fg">Live trading</p>
          <p className="mt-1 text-[11px] text-fg-muted">Not available in this build.</p>
          <p className="mt-1 text-[10px] text-fg-subtle">
            Live execution needs a supported broker adapter, risk validation and an explicit activation step. None of those exist yet, so no live number is shown.
          </p>
        </div>
      </div>
    </section>

    <button type="button" onClick={onOpenWorkspace} className="btn btn-secondary w-full text-xs">Open the full workspace</button>
  </div>;
}

function Fact({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return <div className="min-w-0 rounded-lg border border-line bg-raised/40 px-2.5 py-2">
    <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-fg-subtle">{icon}{label}</p>
    <p className="mt-0.5 truncate text-xs font-semibold text-fg">{value}</p>
  </div>;
}
