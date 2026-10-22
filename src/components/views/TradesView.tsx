import { useEffect, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

type Trade = { id: string; robotName: string; instrument: string; mode: 'PAPER' | 'LIVE'; direction: string; openedAt: number; closedAt: number; entryPrice: number; exitPrice: number; pnl: number; exitReason: string };

export function TradesView() {
  const { getApiAuthHeaders } = useAuth();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [modeFilter, setModeFilter] = useState<'ALL' | 'PAPER' | 'LIVE'>('ALL');
  const [robotFilter, setRobotFilter] = useState('ALL');
  const filtered = trades.filter(trade => (modeFilter === 'ALL' || trade.mode === modeFilter) && (robotFilter === 'ALL' || trade.robotName === robotFilter));
  const robots = [...new Set(trades.map(trade => trade.robotName))].sort();
  const netPnl = filtered.reduce((sum, trade) => sum + (Number.isFinite(trade.pnl) ? trade.pnl : 0), 0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/robot-trades', { headers: await getApiAuthHeaders(), cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message ?? 'Trades could not be loaded.');
        if (active) { setTrades(body.trades ?? []); setError(''); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Trades could not be loaded.'); }
      finally { if (active) setLoading(false); }
    };
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [getApiAuthHeaders]);
  return <div className="mx-auto max-w-6xl space-y-5 pb-20">
    <header><p className="text-xs font-bold uppercase tracking-widest text-accent-text">Dashboard</p><h1 className="mt-1 text-2xl font-black">Trades</h1><p className="mt-1 text-sm text-fg-muted">Completed paper and live trades from your bots.</p></header>
    <div className="flex flex-wrap items-end gap-3" aria-label="Trade filters">
      <label className="flex flex-col gap-1 text-xs text-fg-muted">Trading mode<select className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg" value={modeFilter} onChange={event => setModeFilter(event.target.value as 'ALL' | 'PAPER' | 'LIVE')}><option value="ALL">All trades</option><option value="PAPER">Paper</option><option value="LIVE">Live</option></select></label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">Bot<select className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg" value={robotFilter} onChange={event => setRobotFilter(event.target.value)}><option value="ALL">All bots</option>{robots.map(robot => <option key={robot} value={robot}>{robot}</option>)}</select></label>
      <div className="ml-auto text-right text-sm"><span className="text-fg-muted">{filtered.length} completed trades</span><strong className={`block ${netPnl >= 0 ? 'text-positive' : 'text-danger'}`}>Net P/L: {netPnl.toFixed(2)}</strong></div>
    </div>
    {error && <p role="alert" className="panel p-4 text-danger">{error}</p>}
    {loading ? <p className="panel p-6">Loading trades…</p> : filtered.length ? <div className="panel overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr>{['Bot','Mode','Asset','Side','Opened','Closed','Entry','Exit','P/L','Reason'].map(label => <th key={label} className="border-b border-line p-3 text-xs text-fg-subtle">{label}</th>)}</tr></thead><tbody>{filtered.map(trade => <tr key={`${trade.robotName}-${trade.id}`} className="border-b border-line/50"><td className="p-3 font-semibold">{trade.robotName}</td><td className="p-3">{trade.mode}</td><td className="p-3">{trade.instrument}</td><td className="p-3">{trade.direction}</td><td className="p-3">{new Date(trade.openedAt).toLocaleString()}</td><td className="p-3">{new Date(trade.closedAt).toLocaleString()}</td><td className="p-3">{trade.entryPrice}</td><td className="p-3">{trade.exitPrice}</td><td className={`p-3 font-semibold ${trade.pnl >= 0 ? 'text-positive' : 'text-danger'}`}>{trade.pnl.toFixed(2)}</td><td className="p-3">{trade.exitReason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div> : <div className="panel flex flex-col items-center gap-3 p-12 text-center text-fg-muted"><ReceiptText size={30}/><h2 className="font-semibold text-fg">No matching completed trades</h2><p>Completed trades matching your filters will appear here.</p></div>}
  </div>;
}
