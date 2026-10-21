import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bot, CirclePlus, FlaskConical, LockKeyhole, Play, Square, Link2, Info } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { StrategyDefinition } from '../../services/strategy/schema';
import { StrategyBuilder, StrategySummary } from '../strategy/StrategyBuilder';

type Robot = { id: string; slug: string; name: string; description: string; creatorName: string; visibility: 'PUBLIC' | 'PRIVATE'; market: string; timeframe: string; runtimeStatus: 'STOPPED' | 'PAPER' | 'ERROR'; currentVersion: number; createdAt: string; updatedAt: string };
type Backtest = { id: string; strategyVersionId: string; createdAt: string; configuration: { requestedBars: number; from?: string; to?: string }; result: { metrics: { totalReturn: number; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null; completedTrades: number; averageTrade: number }; candlesProcessed: number; trades: Array<Record<string, unknown>>; equityCurve: Array<{ time: number; equity: number }> } };
type RobotDetail = { robot: Robot; definition: StrategyDefinition; backtests: Backtest[]; canManage: boolean };

const requestId = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '_') ?? `request_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const draftId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random()}`;
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
    window.location.hash = `/robots/${encodeURIComponent(slug)}`;
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };
  const closeRobot = () => { setSelected(null); window.location.hash = '/rooms'; void load(); };

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

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="yt-room-filters flex gap-2" role="group" aria-label="Robot directory"><button className={mode === 'public' ? 'yt-room-filter is-active' : 'yt-room-filter'} onClick={() => setMode('public')}>Public Robots</button><button className={mode === 'mine' ? 'yt-room-filter is-active' : 'yt-room-filter'} onClick={() => setMode('mine')}>My Robots</button></div>
      <button className="btn btn-primary" onClick={() => signedIn ? setCreateOpen(true) : openAuthModal('signup')}><CirclePlus size={15} /> Create Trading Robot</button>
    </div>
    {error && <div role="alert" className="panel border-danger/30 p-4 text-sm text-danger">{error}</div>}
    {loading ? <div className="panel p-10 text-center text-sm text-fg-muted">Loading trading robots…</div> : mode === 'mine' && !signedIn ? <div className="panel p-10 text-center"><LockKeyhole className="mx-auto text-fg-muted" /><p className="mt-3 text-sm text-fg-muted">Sign in to see your robots.</p></div> : robots.length ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{robots.map(robot => <article key={robot.id} className="group relative min-w-0 overflow-hidden rounded-[24px] border border-red-500/20 bg-[#100b0d] shadow-[0_12px_40px_rgba(0,0,0,.18)] transition hover:border-red-400/60">
      <button type="button" className="block w-full text-left" onClick={() => openRobot(robot.slug)} aria-label={`Open ${robot.name}`}>
        <div className="relative aspect-[4/5] overflow-hidden bg-gradient-to-br from-[#103c5a] via-[#091a2b] to-[#03080e]">
          <div className="absolute inset-0 opacity-80" style={{backgroundImage:'radial-gradient(circle at 75% 30%,rgba(47,192,242,.55),transparent 33%),radial-gradient(ellipse at 10% 90%,rgba(0,86,149,.65),transparent 62%)'}} />
          <div className="absolute -left-[20%] top-[17%] flex h-[75%] w-[85%] items-center justify-center rounded-full border-[24px] border-cyan-400/15 bg-slate-950/40 shadow-[inset_0_0_60px_rgba(24,161,213,.25)]"><Bot className="h-28 w-28 text-cyan-300/65" strokeWidth={1} /></div>
          <div className="absolute right-[8%] top-[25%] h-[44%] w-[48%] rounded-full border border-cyan-300/40 bg-gradient-to-br from-cyan-300/50 via-sky-800/50 to-slate-950 shadow-[0_0_65px_rgba(32,191,236,.36)]" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/80 to-transparent px-5 pb-7 pt-28">
            <p className="text-center text-xl font-extrabold text-white drop-shadow-md">{robot.name}</p>
            <p className="mx-auto mt-2 line-clamp-2 max-w-xs text-center text-xs text-slate-300">{robot.description || 'Rule-based trading robot'}</p>
          </div>
          <span className="absolute left-4 top-4 rounded-full bg-black/45 px-3 py-1 text-xs font-medium text-white backdrop-blur">{robot.creatorName || 'Robot creator'}</span>
          <span className="absolute right-4 top-4 rounded-full border border-white/20 bg-black/50 px-2 py-1 text-[10px] font-bold text-white">{robot.runtimeStatus === 'PAPER' ? 'PAPER MODE' : robot.runtimeStatus}</span>
        </div>
      </button>
      <div className="relative -mt-3 mx-4 flex items-center justify-around gap-2 rounded-full border border-red-500/80 bg-[#10090b] p-2 text-red-400 shadow-[0_0_20px_rgba(239,68,68,.25)]">
        <button type="button" onClick={() => openRobot(robot.slug)} className="flex min-w-0 flex-col items-center gap-1 rounded-full px-3 py-2 text-[10px] font-semibold hover:bg-red-500/10"><Activity size={18} /> PAIRS</button>
        <button type="button" onClick={() => openRobot(robot.slug)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-[0_0_15px_rgba(239,68,68,.4)]" aria-label={`Open ${robot.name} workspace`}><Play size={23} fill="currentColor" /></button>
        <button type="button" onClick={() => openRobot(robot.slug)} className="flex min-w-0 flex-col items-center gap-1 rounded-full px-3 py-2 text-[10px] font-semibold hover:bg-red-500/10"><Info size={18} /> INFO</button>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 px-4 pb-5 pt-4 text-xs text-slate-400"><span>{robot.market}</span><span>·</span><span>{robot.timeframe}</span><span>·</span><span>{robot.visibility === 'PRIVATE' ? 'Private' : 'Public'}</span></div>
    </article>)}</div> : <div className="panel p-10 text-center"><Bot className="mx-auto text-accent-text" /><h2 className="mt-3 font-semibold">No trading robots yet</h2><p className="mt-2 text-sm text-fg-muted">Create the first validated strategy robot.</p></div>}
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
  return <div className="space-y-5"><button onClick={onBack} className="text-sm text-fg-muted">← Back to Robot Marketplace</button><header className="panel p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-wider text-accent-text">Trading Robot · strategy v{detail.robot.currentVersion}</p><h1 className="mt-2 text-3xl font-black">{detail.robot.name}</h1><p className="mt-2 max-w-2xl text-sm text-fg-muted">{detail.robot.description}</p><p className="mt-2 text-xs text-fg-subtle">Created by {detail.robot.creatorName} · {detail.robot.market} · {detail.robot.timeframe}</p></div>{detail.canManage && <div className="flex gap-2"><button disabled={busy || detail.robot.runtimeStatus === 'PAPER'} onClick={() => void action('start')} className="btn btn-primary"><Play size={14} /> Start</button><button disabled={busy || detail.robot.runtimeStatus !== 'PAPER'} onClick={() => void action('stop')} className="btn btn-secondary"><Square size={14} /> Stop</button></div>}</div><p className="mt-4 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs text-fg-muted">Paper mode resumes from its saved snapshot when this workspace is reopened, but it evaluates only while this page is open and active. It is not a continuously running cloud service.</p></header>
    <section className="panel p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-bold"><Link2 size={16} /> Broker connections</h2><p className="mt-1 text-xs text-fg-muted">Connect a cTrader account or securely save a PropDAO API key in Settings. This robot still runs in paper mode; connecting a broker does not enable live orders.</p></div><button type="button" className="btn btn-secondary" onClick={() => { window.location.hash = '/settings'; }}>Manage connections</button></div></section><nav className="flex flex-wrap gap-2"><button className={tab === 'details' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('details')}>Robot Details</button><button className={tab === 'backtests' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('backtests')}>Backtest Results</button><button className={tab === 'logs' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('logs')}>Robot Logs</button></nav>{error && <p role="alert" className="panel border-danger/30 p-4 text-sm text-danger">{error}</p>}
    {tab === 'details' && <div className="grid gap-4 lg:grid-cols-2"><section className="panel p-5"><h2 className="font-bold">Strategy definition</h2><StrategySummary definition={detail.definition} /><div className="mt-4 space-y-2 text-sm text-fg-muted"><p>Visibility: <strong className="text-fg">{detail.robot.visibility}</strong></p><p>Runtime: <strong className="text-fg">{detail.robot.runtimeStatus}</strong></p><p>Schema: <strong className="text-fg">v{detail.definition.schemaVersion}</strong></p><p>Version ID: <code className="text-xs">{detail.definition.versionId}</code></p></div></section><section className="panel p-5"><h2 className="font-bold">Risk & execution</h2><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-fg-muted">Stop loss</dt><dd>{detail.definition.risk.stopLossPercent}%</dd></div><div><dt className="text-fg-muted">Take profit</dt><dd>{detail.definition.risk.takeProfitPercent}%</dd></div><div><dt className="text-fg-muted">Max exposure</dt><dd>{detail.definition.risk.maxExposurePercent}%</dd></div><div><dt className="text-fg-muted">Max daily loss</dt><dd>{detail.definition.risk.maxDailyLossPercent}%</dd></div><div><dt className="text-fg-muted">Starting balance</dt><dd>{detail.definition.execution.startingBalance.toLocaleString()}</dd></div><div><dt className="text-fg-muted">Fill model</dt><dd>Next candle open</dd></div></dl></section></div>}
    {tab === 'backtests' && <section className="panel p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-bold">Backtest Results</h2><p className="mt-1 text-xs text-fg-muted">Actual completed Hyperliquid candles; next-open fills, fees, slippage, stops and risk rules match paper mode.</p></div>{detail.canManage && <div className="flex flex-wrap items-end gap-2"><label className="text-xs text-fg-muted">From<input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} className="input mt-1 block" /></label><label className="text-xs text-fg-muted">To<input type="date" value={to} min={from} max={today()} onChange={event => setTo(event.target.value)} className="input mt-1 block" /></label><button disabled={busy || !from || !to || from > to} onClick={() => void backtest()} className="btn btn-primary"><FlaskConical size={14} /> {busy ? 'Running…' : 'Run Backtest'}</button></div>}</div>{latest ? <BacktestResultView backtest={latest} /> : <p className="mt-5 text-sm text-fg-muted">No verified backtest exists for this strategy version.</p>}</section>}
    {tab === 'logs' && <section className="panel p-5"><div className="flex items-center gap-2"><Activity size={16} /><h2 className="font-bold">Robot Logs</h2></div>{detail.canManage ? logs.length ? <div className="mt-4 space-y-2">{logs.map(item => <article key={item.id} className="rounded-xl border border-line p-3"><div className="flex justify-between gap-3"><strong className="text-xs">{item.type.replaceAll('_', ' ')}</strong><time className="text-xs text-fg-subtle">{new Date(item.at).toLocaleString()}</time></div><p className="mt-1 text-sm text-fg-muted">{item.message}</p></article>)}</div> : <p className="mt-4 text-sm text-fg-muted">No runtime events recorded yet.</p> : <p className="mt-4 text-sm text-fg-muted">Execution logs are private to the robot creator.</p>}</section>}
  </div>;
}

function BacktestResultView({ backtest }: { backtest: Backtest }) {
  const metrics = backtest.result.metrics;
  return <><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Total return', `${metrics.totalReturn}%`], ['Net P/L', metrics.netPnl], ['Max drawdown', `${metrics.maxDrawdown}%`], ['Win rate', `${metrics.winRate}%`], ['Profit factor', metrics.profitFactor ?? 'N/A'], ['Completed trades', metrics.completedTrades], ['Average trade', metrics.averageTrade], ['Candles', backtest.result.candlesProcessed]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-line p-3"><p className="text-xs text-fg-muted">{label}</p><p className="mt-1 font-bold">{String(value)}</p></div>)}</div><EquityCurve points={backtest.result.equityCurve} /><p className="mt-4 text-xs text-fg-muted">Strategy version {backtest.strategyVersionId} · {new Date(backtest.createdAt).toLocaleString()}{backtest.configuration.from ? ` · ${new Date(backtest.configuration.from).toLocaleDateString()} – ${new Date(backtest.configuration.to!).toLocaleDateString()}` : ''} · historical simulation only.</p><div className="mt-4 max-h-80 overflow-auto"><table className="w-full text-left text-xs"><thead><tr className="text-fg-muted"><th className="p-2">Opened</th><th>Direction</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Reason</th></tr></thead><tbody>{backtest.result.trades.map((trade, index) => <tr key={`${String(trade.openedAt)}_${index}`} className="border-t border-line"><td className="p-2">{new Date(Number(trade.openedAt)).toLocaleString()}</td><td>{String(trade.direction)}</td><td>{String(trade.entryPrice)}</td><td>{String(trade.exitPrice)}</td><td>{String(trade.pnl)}</td><td>{String(trade.exitReason)}</td></tr>)}</tbody></table></div></>;
}
function EquityCurve({ points }: { points: Array<{ time: number; equity: number }> }) {
  if (points.length < 2) return <p className="mt-4 text-xs text-fg-muted">Not enough equity points to draw a curve.</p>;
  const width = 800; const height = 180; const min = Math.min(...points.map(point => point.equity)); const max = Math.max(...points.map(point => point.equity)); const span = Math.max(max - min, 1); const polyline = points.map((point, index) => `${index / (points.length - 1) * width},${height - (point.equity - min) / span * height}`).join(' ');
  return <div className="mt-5"><p className="mb-2 text-xs font-bold text-fg-muted">Equity curve</p><svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full rounded-xl border border-line bg-sunken/50 p-2" role="img" aria-label="Backtest equity curve"><polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="3" className="text-accent-text" vectorEffect="non-scaling-stroke" /></svg></div>;
}
