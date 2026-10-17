import { useCallback, useEffect, useRef, useState } from 'react';
import { CandlestickSeries, createChart } from 'lightweight-charts';
import { ArrowLeft, ArrowUpRight, Bot, Check, Copy, Globe, LockKeyhole, RefreshCw, ShieldCheck, Users, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

type Signal = { id: string; market: string; direction: string; status: string; entry?: number; stopLoss?: number; takeProfit?: number; thesis: string; rationale: string; createdAt: string; decision?: string };
type Member = { id: string; name: string; goal: string; markets: string[]; status: string; provider: string; latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string }; signals: Signal[] };
type Room = { id: string; slug: string; name: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string; coordinationMode: string; environment?: 'DEMO' | 'LIVE'; marketDataProvider?: string | null; liveTradingProvider?: 'ctrader' | 'hyperliquid' | null; memberCount: number; markets: string[] };
type MarketPayload = { teamId: string; environment: 'DEMO' | 'LIVE'; symbol: string; quote: { mid: number; bid: number; ask: number; timestamp: number; stale?: boolean; marketState?: string }; candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>; provider: string; dataMode: string; executionAllowed: boolean };
type Payload = { team: Room; members: Member[] };
async function read<T>(response: Response): Promise<T> { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`); return body as T; }

export function PublicTeamView({ slug }: { slug: string }) {
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [marketPayload, setMarketPayload] = useState<MarketPayload | null>(null);
  const [marketSymbol, setMarketSymbol] = useState('');
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await read<Payload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug), { headers: { Accept: 'application/json' }, cache: 'no-store' }));
      setData(result); setError('');
      if (currentUser || authMode === 'dev') {
        const headers = new Headers({ Accept: 'application/json' });
        for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
        setIsOwner((await fetch('/api/goat-teams/' + encodeURIComponent(result.team.id), { headers })).ok);
      } else setIsOwner(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load this team.'); }
    finally { setLoading(false); }
  }, [slug, currentUser, authMode, getApiAuthHeaders]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const first = data?.team.markets?.[0];
    if (first && !marketSymbol) setMarketSymbol(first);
  }, [data, marketSymbol]);
  const loadMarket = useCallback(async () => {
    if (!data?.team.slug || !marketSymbol) return;
    try {
      const query = new URLSearchParams({ symbol: marketSymbol, timeframe: '1h', limit: '200' });
      const payload = await read<MarketPayload>(await fetch('/api/team-rooms/' + encodeURIComponent(data.team.slug) + '/market?' + query.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' }));
      setMarketPayload(payload);
    } catch (err) {
      setMarketPayload(null);
      setError(err instanceof Error ? err.message : 'Could not load demo market data.');
    }
  }, [data?.team.slug, marketSymbol]);
  useEffect(() => {
    void loadMarket();
    const timer = window.setInterval(() => void loadMarket(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadMarket]);
  useEffect(() => {
    if (!chartContainerRef.current || !marketPayload?.candles?.length) return;
    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: 'currentColor' },
      grid: { vertLines: { color: 'rgba(148,163,184,0.12)' }, horzLines: { color: 'rgba(148,163,184,0.12)' } },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.25)' },
      timeScale: { borderColor: 'rgba(148,163,184,0.25)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a', downColor: '#dc2626', borderVisible: false,
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
    candles.setData(marketPayload.candles.map(bar => ({
      time: Math.floor(bar.time / 1000) as any,
      open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [marketPayload]);
  const changeEnvironment = async (environment: 'DEMO' | 'LIVE', provider?: 'ctrader' | 'hyperliquid') => {
    if (!data || environmentBusy) return;
    if (environment === 'LIVE' && !window.confirm('Switch this team to LIVE market data? This does not enable trading by itself, but its existing provider execution permissions still apply.')) return;
    setEnvironmentBusy(true); setError(''); setNotice('');
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id) + '/environment', {
        method: 'POST', headers, body: JSON.stringify({ environment, ...(provider ? { provider } : {}) }),
      });
      const result = await read<{ team: Room; message: string }>(response);
      setData(current => current ? { ...current, team: { ...current.team, ...result.team } } : current);
      setNotice(result.message);
      await load();
      await loadMarket();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not change the team environment.'); }
    finally { setEnvironmentBusy(false); }
  };

  const decide = async (member: Member, signal: Signal, decision: 'ACCEPTED' | 'REJECTED') => {
    setBusy(signal.id); setError(''); setNotice('');
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/goats/' + encodeURIComponent(member.id) + '/signals/' + encodeURIComponent(signal.id) + '/decision', { method: 'POST', headers, body: JSON.stringify({ decision }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || 'The existing proposal review checks rejected this action.');
      setNotice(decision === 'REJECTED' ? 'Proposal rejected and saved.' : 'Proposal accepted. Approval is recorded; no order is submitted by this action.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not review this proposal.'); }
    finally { setBusy(null); }
  };
  if (loading) return <div className="mx-auto max-w-5xl p-8 text-center text-sm text-fg-muted">Loading team…</div>;
  if (!data) return <main className="mx-auto max-w-3xl p-6"><a href="/#/" className="text-sm text-accent-text">← Trade Rooms</a><div role="alert" className="panel mt-4 p-5 text-sm">{error || 'This team link is unavailable.'}</div></main>;
  const { team, members } = data;
  return <main className="mx-auto w-full max-w-5xl space-y-5 px-3 py-5 sm:px-6 sm:py-8">
    <a href="/#/" className="inline-flex items-center gap-2 text-xs text-fg-muted hover:text-fg"><ArrowLeft size={14}/> Trade Rooms</a>
    <section className="panel p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Users size={22}/></div><div><div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-fg-subtle"><span>AI Trading Team</span><span className="rounded-full border border-line px-2 py-1 normal-case tracking-normal">{team.visibility === 'PUBLIC' ? <><Globe size={10} className="mr-1 inline"/>Public</> : <><LockKeyhole size={10} className="mr-1 inline"/>Private link</>}</span><span className="rounded-full border border-line px-2 py-1 normal-case tracking-normal">{team.status}</span></div><h1 className="mt-2 break-words text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{team.name}</h1><p className="mt-2 text-sm text-fg-muted">{team.memberCount} bots · {team.coordinationMode.replaceAll('_', ' ').toLowerCase()} · {team.markets.slice(0,5).join(' · ') || 'Markets not listed'}</p></div></div><div className="flex gap-2"><button type="button" onClick={() => void load()} className="btn btn-secondary"><RefreshCw size={14}/> Refresh</button>{isOwner && <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.href); setCopied(true); }} className="btn btn-secondary"><Copy size={14}/>{copied ? 'Copied' : 'Share'}</button>}</div></div>
      <div className="mt-5 rounded-xl border border-line bg-raised/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-fg">Environment</p><p className="mt-1 text-xs text-fg-muted">{team.environment === 'LIVE' ? `Live market data · ${team.marketDataProvider || team.liveTradingProvider || 'selected provider'}` : 'Demo mode · BiQuote reference market data · no broker connection needed'}</p></div><span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${team.environment === 'LIVE' ? 'border-warning/40 text-warning' : 'border-positive/40 text-positive'}`}>{team.environment || 'DEMO'}</span></div>
        {isOwner && <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={environmentBusy || team.environment !== 'LIVE'} onClick={() => void changeEnvironment('DEMO')} className="btn btn-secondary">Switch to Demo</button><button type="button" disabled={environmentBusy || team.environment === 'LIVE'} onClick={() => void changeEnvironment('LIVE','ctrader')} className="btn btn-secondary">Go Live with cTrader</button><button type="button" disabled={environmentBusy || team.environment === 'LIVE'} onClick={() => void changeEnvironment('LIVE','hyperliquid')} className="btn btn-secondary">Go Live with Hyperliquid</button></div>}
        <p className="mt-2 text-[10px] leading-4 text-fg-subtle">Demo candles use BiQuote's public feed. Live switching requires the team's bots to use the selected provider. This switch does not grant or enable automatic order execution.</p>
      </div>
      <div className="mt-4 rounded-xl border border-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-fg">{marketPayload?.symbol || marketSymbol || 'Market'} · 1h candles</p><p className="mt-1 text-xs text-fg-muted">{marketPayload?.provider || 'Loading market feed…'}{marketPayload?.quote?.stale ? ' · stale quote' : marketPayload?.quote?.marketState === 'closed' ? ' · market closed' : ''}</p></div>{marketPayload?.quote && <div className="text-right"><p className="text-lg font-semibold tabular-nums text-fg">{marketPayload.quote.mid.toLocaleString(undefined,{maximumFractionDigits:8})}</p><p className="text-[10px] text-fg-subtle">Bid {marketPayload.quote.bid.toLocaleString(undefined,{maximumFractionDigits:8})} · Ask {marketPayload.quote.ask.toLocaleString(undefined,{maximumFractionDigits:8})}</p></div>}</div>
        {team.markets.length > 1 && <label className="mt-3 block max-w-xs"><span className="mb-1 block text-[10px] text-fg-subtle">Chart market</span><select className="input" value={marketSymbol} onChange={event => setMarketSymbol(event.target.value)}>{team.markets.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>}
        <div ref={chartContainerRef} className="mt-3 h-[320px] w-full" />
        {!marketPayload && <p className="mt-2 text-xs text-fg-muted">Market candles are loading. If a configured market is not available from BiQuote, choose a supported symbol.</p>}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised/70 p-4"><div><p className="text-sm font-semibold text-fg">Trade with this team</p><p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">Explore its recorded ideas. Automated trade copying is not enabled here; connecting an account and authorizing execution must remain explicit.</p></div><button type="button" onClick={() => setNotice(isOwner ? 'You manage this team. Review proposals below.' : 'You can explore this team here. Automated copy trading is not enabled for visitors yet.')} className="btn btn-primary">Trade with this team <ArrowUpRight size={14}/></button></div>
    </section>
    {error && <div role="alert" className="panel border-warning/40 p-4 text-sm text-fg-muted">{error}</div>}{notice && <div role="status" className="panel p-4 text-sm text-fg-muted">{notice}</div>}
    <section className="space-y-3"><div><h2 className="text-lg font-semibold text-fg">Team bots</h2><p className="text-xs text-fg-muted">Saved market views and proposals from each existing bot.</p></div>
      {members.map(member => <article key={member.id} className="panel p-4 sm:p-5"><div className="flex flex-wrap items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-accent-text"><Bot size={17}/></div><div><h3 className="font-semibold text-fg">{member.name}</h3><p className="mt-1 text-xs text-fg-muted">{member.status} · {member.provider} · {(member.markets || []).join(' · ')}</p></div></div>
        {member.latestThesis && <div className="mt-4 rounded-lg border border-line bg-raised/60 p-3"><p className="text-[10px] uppercase tracking-wide text-fg-subtle">Latest recorded thesis · {member.latestThesis.market} · {member.latestThesis.bias}</p><p className="mt-1 text-sm leading-5 text-fg-muted">{member.latestThesis.summary}</p><p className="mt-2 text-[10px] text-fg-subtle">Recorded {new Date(member.latestThesis.updatedAt).toLocaleString()}</p></div>}
        <div className="mt-4 space-y-2">{member.signals.length ? member.signals.map(signal => <div key={signal.id} className="rounded-xl border border-line p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-fg">{signal.market} · {signal.direction}</span><span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-fg-muted">{signal.decision || signal.status}</span></div><time className="text-[10px] text-fg-subtle">{new Date(signal.createdAt).toLocaleString()}</time></div><p className="mt-2 text-sm text-fg">{signal.thesis}</p><p className="mt-1 text-xs leading-5 text-fg-muted">{signal.rationale}</p><div className="mt-3 grid grid-cols-3 gap-2">{[['Entry',signal.entry],['Stop loss',signal.stopLoss],['Take profit',signal.takeProfit]].map(([label,value]) => <div key={String(label)} className="rounded-lg bg-raised p-2"><p className="text-[9px] uppercase text-fg-subtle">{label}</p><p className="mt-1 break-words text-xs font-semibold text-fg">{value == null ? 'Not recorded' : typeof value === 'number' ? value.toLocaleString(undefined,{maximumFractionDigits:8}) : value}</p></div>)}</div>
          {isOwner && !signal.decision && <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy === signal.id} onClick={() => void decide(member,signal,'REJECTED')} className="btn btn-secondary"><X size={13}/> Reject</button><button type="button" disabled={busy === signal.id} onClick={() => void decide(member,signal,'ACCEPTED')} className="btn btn-primary"><Check size={13}/> Review & accept</button></div>}<p className="mt-2 text-[10px] text-fg-subtle">{isOwner ? 'Uses the existing owner-authorized proposal endpoint and its freshness and policy checks.' : 'Recorded proposal only. Viewing this card does not submit an order.'}</p></div>) : <p className="rounded-lg border border-dashed border-line p-3 text-xs text-fg-subtle">No proposals recorded for this bot.</p>}</div>
      </article>)}
    </section>
    <p className="flex items-start gap-2 px-1 text-[11px] leading-5 text-fg-subtle"><ShieldCheck size={14} className="mt-0.5 shrink-0"/> Acceptance is not order execution. Existing provider authorization, risk validation and execution confirmation remain separate.</p>
  </main>;
}
