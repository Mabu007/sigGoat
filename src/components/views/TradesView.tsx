import { useEffect, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

type Trade = { id: string; robotName: string; instrument: string; mode: 'PAPER' | 'LIVE'; direction: string; openedAt: number; closedAt: number; entryPrice: number; exitPrice: number; pnl: number; exitReason: string };

export function TradesView() {
  const { getApiAuthHeaders } = useAuth();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
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
    <header><p className="text-xs font-bold uppercase tracking-widest text-accent-text">Dashboard</p><h1 className="mt-1 text-2xl font-black">Trades</h1><p className="mt-1 text-sm text-fg-muted">Completed trades from your bots.</p></header>
    {error && <p role="alert" className="panel p-4 text-danger">{error}</p>}
    {loading ? <p className="panel p-6">Loading trades…</p> : trades.length ? <div className="panel overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr>{['Bot','Mode','Asset','Side','Opened','Closed','Entry','Exit','P/L','Reason'].map(label => <th key={label} className="border-b border-line p-3 text-xs text-fg-subtle">{label}</th>)}</tr></thead><tbody>{trades.map(trade => <tr key={`${trade.robotName}-${trade.id}`} className="border-b border-line/50"><td className="p-3 font-semibold">{trade.robotName}</td><td className="p-3">{trade.mode}</td><td className="p-3">{trade.instrument}</td><td className="p-3">{trade.direction}</td><td className="p-3">{new Date(trade.openedAt).toLocaleString()}</td><td className="p-3">{new Date(trade.closedAt).toLocaleString()}</td><td className="p-3">{trade.entryPrice}</td><td className="p-3">{trade.exitPrice}</td><td className={`p-3 font-semibold ${trade.pnl >= 0 ? 'text-positive' : 'text-danger'}`}>{trade.pnl.toFixed(2)}</td><td className="p-3">{trade.exitReason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div> : <div className="panel flex flex-col items-center gap-3 p-12 text-center text-fg-muted"><ReceiptText size={30}/><h2 className="font-semibold text-fg">No completed trades yet</h2><p>Start a bot and its completed trades will appear here.</p></div>}
  </div>;
}
