import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, CirclePlus, FlaskConical, Image as ImageIcon, Link2, LockKeyhole, Play, Square } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { StrategyDefinition } from '../../services/strategy/schema';
import { StrategyBuilder, StrategySummary } from '../strategy/StrategyBuilder';
import { RobotCard, RobotEmptyState, type RobotCardAction, type RobotSummary } from '../strategy/RobotCard';
import { RobotSheet } from '../strategy/RobotSheet';
import { BrokerConnections } from '../strategy/BrokerConnections';
import { RoomCoverPicker } from '../RoomCoverPicker';

type Robot = RobotSummary;
type Backtest = { id: string; strategyVersionId: string; createdAt: string; configuration: { requestedBars: number; from?: string; to?: string }; result: { metrics: { totalReturn: number; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null; completedTrades: number; averageTrade: number }; candlesProcessed: number; trades: Array<Record<string, unknown>>; equityCurve: Array<{ time: number; equity: number }> } };
type RobotDetail = { robot: Robot; definition: StrategyDefinition; backtests: Backtest[]; canManage: boolean };

const requestId = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '_') ?? `request_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function selectedRobotFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#\/robots\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function TradingRobotsView() {
  const { currentUser, authMode, getApiAuthHeaders, openAuthModal } = useAuth();
  const signedIn = Boolean(currentUser) || authMode === 'dev';
  const [robots, setRobots] = useState<Robot[]>([]);
  const [mode, setMode] = useState<'public' | 'mine'>('public');
  const [selected, setSelected] = useState<string | null>(selectedRobotFromHash);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** The robot whose sheet is open, and which of the three views it is. */
  const [sheet, setSheet] = useState<{ robot: Robot; action: RobotCardAction } | null>(null);

  const headers = useCallback(async (json = false) => {
    const value = new Headers(json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' });
    try { for (const [key, item] of Object.entries(await getApiAuthHeaders())) value.set(key, item); } catch { /* Public marketplace read. */ }
    return value;
  }, [getApiAuthHeaders]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (mode === 'mine' && !signedIn) { setRobots([]); return; }
      const url = mode === 'mine' ? '/api/robot-marketplace/mine' : `/api/robot-marketplace?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: await headers(), cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Could not load trading robots.');
      setRobots(Array.isArray(body.robots) ? body.robots : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load trading robots.'); }
    finally { setLoading(false); }
  }, [headers, mode, query, signedIn]);

  const openRobot = (slug: string) => {
    setSelected(slug);
    setSheet(null);
    window.location.hash = `/robots/${encodeURIComponent(slug)}`;
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };
  const closeRobot = () => { setSelected(null); setSheet(null); window.location.hash = '/rooms'; void load(); };

  useEffect(() => { if (!selected) void load(); }, [load, selected]);
  useEffect(() => {
    const listener = (event: Event) => setQuery(String((event as CustomEvent<string>).detail ?? '').trim());
    window.addEventListener('tradingvibes-directory-search', listener);
    return () => window.removeEventListener('tradingvibes-directory-search', listener);
  }, []);
  useEffect(() => {
    const listener = () => setSelected(selectedRobotFromHash());
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);

  if (selected) return <RobotWorkspace slug={selected} headers={headers} onBack={closeRobot} />;

  return <div className="space-y-4 sm:space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
      <div className="yt-room-filters flex gap-2" role="group" aria-label="Robot directory">
        <button className={mode === 'public' ? 'yt-room-filter is-active' : 'yt-room-filter'} onClick={() => setMode('public')}>Public Robots</button>
        <button className={mode === 'mine' ? 'yt-room-filter is-active' : 'yt-room-filter'} onClick={() => setMode('mine')}>My Robots</button>
      </div>
      <button className="btn btn-primary" onClick={() => signedIn ? setCreateOpen(true) : openAuthModal('signup')}><CirclePlus size={15} /> Create Trading Robot</button>
    </div>
    {error && <div role="alert" className="panel border-danger/30 p-4 text-sm text-danger">{error}</div>}
    {loading
      ? <div className="panel p-10 text-center text-sm text-fg-muted">Loading trading robots…</div>
      : mode === 'mine' && !signedIn
        ? <div className="panel p-10 text-center"><LockKeyhole className="mx-auto text-fg-muted" /><p className="mt-3 text-sm text-fg-muted">Sign in to see your robots.</p></div>
        : robots.length
          ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {robots.map(robot => (
              <RobotCard
                key={robot.id}
                robot={robot}
                onOpen={() => openRobot(robot.slug)}
                onAction={action => setSheet({ robot, action })}
              />
            ))}
          </div>
          : <RobotEmptyState onCreate={() => signedIn ? setCreateOpen(true) : openAuthModal('signup')} />}

    {sheet && (
      <RobotSheet
        robot={sheet.robot}
        action={sheet.action}
        headers={headers}
        onClose={() => setSheet(null)}
        onOpenWorkspace={() => openRobot(sheet.robot.slug)}
      />
    )}
    {createOpen && <StrategyBuilder headers={headers} onClose={() => setCreateOpen(false)} onCreated={slug => { setCreateOpen(false); openRobot(slug); }} />}
  </div>;
}

function RobotWorkspace({ slug, headers, onBack }: { slug: string; headers: (json?: boolean) => Promise<Headers>; onBack: () => void }) {
  const [detail, setDetail] = useState<RobotDetail | null>(null); const [tab, setTab] = useState<'details' | 'backtests' | 'logs'>('details'); const [logs, setLogs] = useState<Array<{ id: string; at: string; type: string; message: string }>>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today()); const timer = useRef<number | null>(null);
  const loadDetail = useCallback(async () => { try { const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}`, { headers: await headers(), cache: 'no-store' }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || 'Could not load robot.'); setDetail(body); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load robot.'); } }, [slug, headers]);
  const loadLogs = useCallback(async () => { if (!detail?.canManage) return; const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}/logs`, { headers: await headers(), cache: 'no-store' }); const body = await response.json().catch(() => ({})); if (response.ok) setLogs(body.logs ?? []); }, [detail?.canManage, slug, headers]);
  const process = useCallback(async () => { const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}/process`, { method: 'POST', headers: await headers(true), body: '{}' }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || 'Candle processing failed.'); }, [slug, headers]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => { if (timer.current) window.clearInterval(timer.current); timer.current = null; if (detail?.canManage && detail.robot.runtimeStatus === 'PAPER') { void process().catch(cause => setError(cause instanceof Error ? cause.message : 'Paper runner failed.')); timer.current = window.setInterval(() => void process().catch(cause => setError(cause instanceof Error ? cause.message : 'Paper runner failed.')), 30_000); } return () => { if (timer.current) window.clearInterval(timer.current); }; }, [detail?.canManage, detail?.robot.runtimeStatus, process]);
  useEffect(() => { if (tab === 'logs') void loadLogs(); }, [tab, loadLogs]);
  const action = async (kind: 'start' | 'stop') => { setBusy(true); setError(''); try { const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}/${kind}`, { method: 'POST', headers: await headers(true), body: '{}' }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || `Could not ${kind} robot.`); await loadDetail(); await loadLogs(); } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${kind} robot.`); } finally { setBusy(false); } };
  const backtest = async () => { setBusy(true); setError(''); try { const response = await fetch(`/api/robot-marketplace/${encodeURIComponent(slug)}/backtests`, { method: 'POST', headers: await headers(true), body: JSON.stringify({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` }) }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || 'Backtest failed.'); await loadDetail(); setTab('backtests'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Backtest failed.'); } finally { setBusy(false); } };
  if (!detail) return <div className="panel p-8"><button onClick={onBack} className="text-sm text-fg-muted">← Back to robots</button><p className="mt-6 text-sm">{error || 'Loading robot…'}</p></div>;
  const latest = detail.backtests?.[0];
  return <div className="space-y-4 sm:space-y-5">
    <button onClick={onBack} className="text-sm text-fg-muted">← Back to robots</button>
    <header className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-accent-text">Trading Robot · strategy v{detail.robot.currentVersion}</p>
          <h1 className="mt-2 text-2xl font-black sm:text-3xl">{detail.robot.name}</h1>
          <p className="mt-2 max-w-2xl text-sm text-fg-muted">{detail.robot.description}</p>
          <p className="mt-2 text-xs text-fg-subtle">Created by {detail.robot.creatorName} · {detail.robot.market} · {detail.robot.timeframe}</p>
        </div>
        {detail.canManage && <div className="flex gap-2">
          <button disabled={busy || detail.robot.runtimeStatus === 'PAPER'} onClick={() => void action('start')} className="btn btn-primary"><Play size={14} /> <span className="hidden sm:inline">Start</span></button>
          <button disabled={busy || detail.robot.runtimeStatus !== 'PAPER'} onClick={() => void action('stop')} className="btn btn-secondary"><Square size={14} /> <span className="hidden sm:inline">Stop</span></button>
        </div>}
      </div>
      <p className="mt-4 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs text-fg-muted">Paper mode resumes from its saved snapshot when this workspace is reopened, but it evaluates only while this page is open and active. It is not a continuously running cloud service.</p>
    </header>

    <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Robot workspace sections">
      <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'btn btn-primary shrink-0' : 'btn btn-secondary shrink-0'} onClick={() => setTab('details')}>Robot Details</button>
      <button role="tab" aria-selected={tab === 'backtests'} className={tab === 'backtests' ? 'btn btn-primary shrink-0' : 'btn btn-secondary shrink-0'} onClick={() => setTab('backtests')}>Backtest Results</button>
      <button role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'btn btn-primary shrink-0' : 'btn btn-secondary shrink-0'} onClick={() => setTab('logs')}>Robot Logs</button>
    </nav>
    {error && <p role="alert" className="panel border-danger/30 p-4 text-sm text-danger">{error}</p>}

    {tab === 'details' && <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel p-4 sm:p-5">
        <h2 className="font-bold">Strategy definition</h2>
        <StrategySummary definition={detail.definition} />
        <div className="mt-4 space-y-2 text-sm text-fg-muted">
          <p>Visibility: <strong className="text-fg">{detail.robot.visibility}</strong></p>
          <p>Runtime: <strong className="text-fg">{detail.robot.runtimeStatus}</strong></p>
          <p>Schema: <strong className="text-fg">v{detail.definition.schemaVersion}</strong></p>
          <p>Version ID: <code className="text-xs break-all">{detail.definition.versionId}</code></p>
        </div>
      </section>
      <section className="panel p-4 sm:p-5">
        <h2 className="font-bold">Risk &amp; execution</h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-fg-muted">Stop loss</dt><dd>{detail.definition.risk.stopLossPercent}%</dd></div>
          <div><dt className="text-fg-muted">Take profit</dt><dd>{detail.definition.risk.takeProfitPercent}%</dd></div>
          <div><dt className="text-fg-muted">Max exposure</dt><dd>{detail.definition.risk.maxExposurePercent}%</dd></div>
          <div><dt className="text-fg-muted">Max daily loss</dt><dd>{detail.definition.risk.maxDailyLossPercent}%</dd></div>
          <div><dt className="text-fg-muted">Starting balance</dt><dd>{detail.definition.execution.startingBalance.toLocaleString()}</dd></div>
          <div><dt className="text-fg-muted">Fill model</dt><dd>Next candle open</dd></div>
        </dl>
      </section>

      {detail.canManage && <section className="panel p-4 sm:p-5 lg:col-span-2">
        <h2 className="flex items-center gap-2 font-bold"><ImageIcon size={16} /> Robot cover</h2>
        <p className="mt-1 text-xs text-fg-muted">A portrait cover for this robot, 4:5. It is stored in the app's own image storage and only the creator can change it.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-[200px_1fr]">
          <RoomCoverPicker
            purpose="robot-cover"
            robotId={detail.robot.id}
            currentUrl={detail.robot.coverUrl ?? null}
            aspect="portrait"
            onChange={() => { void loadDetail(); }}
          />
          <p className="self-center text-[11px] leading-relaxed text-fg-subtle">
            Upload a PNG, JPEG, WebP or GIF up to 4&nbsp;MB. The image is stored in the same private bucket as the other uploads in the app, and it is delivered through a signed link that expires. Removing the cover restores the default artwork.
          </p>
        </div>
      </section>}

      <section className="panel p-4 sm:p-5 lg:col-span-2">
        <h2 className="flex items-center gap-2 font-bold"><Link2 size={16} /> Broker connections</h2>
        <p className="mt-1 text-xs text-fg-muted">Bind this robot to one of your own broker accounts. The robot still runs in paper mode: connecting a broker never enables live orders.</p>
        <div className="mt-3">
          {detail.canManage
            ? <BrokerConnections robotSlug={detail.robot.slug} headers={headers} canManage onChanged={() => { void loadDetail(); }} />
            : <p className="text-xs text-fg-subtle">This robot is bound to {detail.robot.brokerAccount ? detail.robot.brokerAccount.label : 'no account'}. Only the creator can change that.</p>}
        </div>
      </section>
    </div>}

    {tab === 'backtests' && <section className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="font-bold">Backtest Results</h2><p className="mt-1 text-xs text-fg-muted">Actual completed Hyperliquid candles; next-open fills, fees, slippage, stops and risk rules match paper mode.</p></div>
        {detail.canManage && <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-fg-muted">From<input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} className="input mt-1 block" /></label>
          <label className="text-xs text-fg-muted">To<input type="date" value={to} min={from} max={today()} onChange={event => setTo(event.target.value)} className="input mt-1 block" /></label>
          <button disabled={busy || !from || !to || from > to} onClick={() => void backtest()} className="btn btn-primary"><FlaskConical size={14} /> {busy ? 'Running…' : 'Run Backtest'}</button>
        </div>}
      </div>
      {latest ? <BacktestResultView backtest={latest} /> : <p className="mt-5 text-sm text-fg-muted">No verified backtest exists for this strategy version.</p>}
    </section>}
    {tab === 'logs' && <section className="panel p-4 sm:p-5">
      <div className="flex items-center gap-2"><Activity size={16} /><h2 className="font-bold">Robot Logs</h2></div>
      {detail.canManage
        ? logs.length ? <div className="mt-4 space-y-2">{logs.map(item => <article key={item.id} className="rounded-xl border border-line p-3"><div className="flex justify-between gap-3"><strong className="text-xs">{item.type.replaceAll('_', ' ')}</strong><time className="text-xs text-fg-subtle">{new Date(item.at).toLocaleString()}</time></div><p className="mt-1 text-sm text-fg-muted">{item.message}</p></article>)}</div> : <p className="mt-4 text-sm text-fg-muted">No runtime events recorded yet.</p>
        : <p className="mt-4 text-sm text-fg-muted">Execution logs are private to the robot creator.</p>}
    </section>}
  </div>;
}

function BacktestResultView({ backtest }: { backtest: Backtest }) {
  const metrics = backtest.result.metrics;
  return <><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Total return', `${metrics.totalReturn}%`], ['Net P/L', metrics.netPnl], ['Max drawdown', `${metrics.maxDrawdown}%`], ['Win rate', `${metrics.winRate}%`], ['Profit factor', metrics.profitFactor ?? 'N/A'], ['Completed trades', metrics.completedTrades], ['Average trade', metrics.averageTrade], ['Candles', backtest.result.candlesProcessed]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-line p-3"><p className="text-xs text-fg-muted">{label}</p><p className="mt-1 font-bold">{String(value)}</p></div>)}</div><EquityCurve points={backtest.result.equityCurve} /><p className="mt-4 text-xs text-fg-muted">Strategy version {backtest.strategyVersionId} · {new Date(backtest.createdAt).toLocaleString()}{backtest.configuration.from ? ` · ${new Date(backtest.configuration.from).toLocaleDateString()} – ${new Date(backtest.configuration.to!).toLocaleDateString()}` : ''} · historical simulation only.</p><div className="mt-4 max-h-80 overflow-auto"><table className="w-full min-w-[420px] text-left text-xs"><thead><tr className="text-fg-muted"><th className="p-2">Opened</th><th>Direction</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Reason</th></tr></thead><tbody>{backtest.result.trades.map((trade, index) => <tr key={`${String(trade.openedAt)}_${index}`} className="border-t border-line"><td className="p-2">{new Date(Number(trade.openedAt)).toLocaleString()}</td><td>{String(trade.direction)}</td><td>{String(trade.entryPrice)}</td><td>{String(trade.exitPrice)}</td><td>{String(trade.pnl)}</td><td>{String(trade.exitReason)}</td></tr>)}</tbody></table></div></>;
}
function EquityCurve({ points }: { points: Array<{ time: number; equity: number }> }) {
  if (points.length < 2) return <p className="mt-4 text-xs text-fg-muted">Not enough equity points to draw a curve.</p>;
  const width = 800; const height = 180; const min = Math.min(...points.map(point => point.equity)); const max = Math.max(...points.map(point => point.equity)); const span = Math.max(max - min, 1); const polyline = points.map((point, index) => `${index / (points.length - 1) * width},${height - (point.equity - min) / span * height}`).join(' ');
  return <div className="mt-5"><p className="mb-2 text-xs font-bold text-fg-muted">Equity curve</p><svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full rounded-xl border border-line bg-sunken/50 p-2" role="img" aria-label="Backtest equity curve"><polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="3" className="text-accent-text" vectorEffect="non-scaling-stroke" /></svg></div>;
}
