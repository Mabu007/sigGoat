import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Bot, Check, Copy, Globe, LockKeyhole, RefreshCw, ShieldCheck, Users, X, Activity, BrainCircuit, MessageSquare, Radio, Clock3, ChartNoAxesCombined } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import type { Candle, MarketQuote } from '../types';

type Signal = { id: string; market: string; direction: string; status: string; entry?: number; stopLoss?: number; takeProfit?: number; thesis: string; rationale: string; createdAt: string; decision?: string };
type Member = { id: string; name: string; goal: string; markets: string[]; status: string; provider: string; latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string }; signals: Signal[] };
type Room = { id: string; slug: string; name: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string; coordinationMode: string; memberCount: number; markets: string[] };
type Payload = { team: Room; members: Member[] };
type FeedItem = { id: string; memberName: string; kind: string; title: string; body: string; at: string; signal?: Signal; member?: Member };
async function read<T>(response: Response): Promise<T> { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`); return body as T; }
const formatPrice = (value?: number) => value == null ? 'Not recorded' : value.toLocaleString(undefined, { maximumFractionDigits: 8 });

export function PublicTeamView({ slug, onBack }: { slug: string; onBack: () => void }) {
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [brainOpen, setBrainOpen] = useState(true);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketProvider, setMarketProvider] = useState('Provider not reported');
  const [marketDataMode, setMarketDataMode] = useState('Unknown');
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<number | null>(null);
  const [marketError, setMarketError] = useState('');
  const [refreshAt, setRefreshAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await read<Payload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug), { headers: { Accept: 'application/json' }, cache: 'no-store' }));
      setData(result); setError(''); setRefreshAt(Date.now());
      if (!selectedMemberId && result.members.length) setSelectedMemberId(result.members[0].id);
      if (currentUser || authMode === 'dev') {
        const headers = new Headers({ Accept: 'application/json' });
        for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
        setIsOwner((await fetch('/api/goat-teams/' + encodeURIComponent(result.team.id), { headers })).ok);
      } else setIsOwner(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load this team.'); }
    finally { setLoading(false); }
  }, [slug, currentUser, authMode, getApiAuthHeaders, selectedMemberId]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, [load]);

  const selectedMember = data?.members.find(member => member.id === selectedMemberId) ?? data?.members[0] ?? null;
  const marketSymbol = selectedMember?.latestThesis?.market || selectedMember?.markets?.[0] || selectedMember?.signals?.[0]?.market || '';

  useEffect(() => {
    if (!selectedMember || !marketSymbol) {
      setCandles([]); setMarketQuote(null); setMarketUpdatedAt(null);
      setMarketError(selectedMember ? 'This team member has no market configured.' : '');
      return;
    }
    let cancelled = false;
    const refreshMarket = async () => {
      try {
        // The public robot market endpoint accepts the member's robot id/slug and
        // returns only provider-backed quotes and candles; no chart data is fabricated.
        const response = await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/market?memberId=' + encodeURIComponent(selectedMember.id) + '&symbol=' + encodeURIComponent(marketSymbol) + '&timeframe=1h&count=120', { headers: { Accept: 'application/json' }, cache: 'no-store' });
        const result = await read<{ quotes: MarketQuote[]; candles: Candle[]; provider?: string; dataMode?: string }>(response);
        if (cancelled) return;
        const quote = result.quotes?.find(item => item.symbol === marketSymbol) ?? result.quotes?.[0] ?? null;
        setMarketQuote(quote);
        setCandles(Array.isArray(result.candles) ? result.candles : []);
        setMarketProvider(result.provider || 'Provider not reported');
        setMarketDataMode(result.dataMode || 'Unknown');
        setMarketUpdatedAt(quote?.timestamp ?? null);
        setMarketError(quote || result.candles?.length ? '' : 'The provider returned no quote or candles for this instrument.');
      } catch (err) {
        if (!cancelled) { setCandles([]); setMarketQuote(null); setMarketError(err instanceof Error ? err.message : 'Market data unavailable.'); }
      }
    };
    void refreshMarket();
    const interval = window.setInterval(() => void refreshMarket(), 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [slug, selectedMember?.id, marketSymbol]);

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

  const feed = useMemo<FeedItem[]>(() => {
    if (!data) return [];
    const entries: FeedItem[] = [];
    for (const member of data.members) {
      if (member.latestThesis) entries.push({ id: member.id + '-thesis-' + member.latestThesis.updatedAt, memberName: member.name, kind: 'MARKET REVIEW', title: member.latestThesis.bias + ' · ' + member.latestThesis.market, body: member.latestThesis.summary, at: member.latestThesis.updatedAt, member });
      for (const signal of member.signals || []) entries.push({ id: signal.id, memberName: member.name, kind: signal.decision || signal.status || 'PROPOSAL', title: signal.market + ' · ' + signal.direction, body: [signal.thesis, signal.rationale].filter(Boolean).join('\n\n'), at: signal.createdAt, signal, member });
    }
    return entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [data]);

  const latestExecutionLabel = selectedMember?.signals?.[0]?.decision || selectedMember?.signals?.[0]?.status || 'No proposal recorded';
  const quoteFresh = marketQuote ? Date.now() - marketQuote.timestamp <= 30000 : false;

  if (loading) return <div className="mx-auto max-w-5xl p-8 text-center text-sm text-fg-muted">Loading team room…</div>;
  if (!data) return <main className="mx-auto max-w-3xl p-6"><button type="button" onClick={onBack} className="text-sm text-accent-text">← Trade Rooms</button><div role="alert" className="panel mt-4 p-5 text-sm">{error || 'This team link is unavailable.'}</div></main>;
  const { team, members } = data;

  return <main className="min-h-screen bg-sunken text-fg">
    <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5 lg:px-7">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-xs text-fg-muted hover:text-fg"><ArrowLeft size={14}/> Trade Rooms</button>
      <header className="mt-3 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent-soft text-accent-text"><Users size={21}/></div>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-fg-subtle"><span>AI Trading Room</span><span className="rounded-full border border-line px-2 py-1 normal-case tracking-normal">{team.visibility === 'PUBLIC' ? <><Globe size={10} className="mr-1 inline"/>Public</> : <><LockKeyhole size={10} className="mr-1 inline"/>Private link</>}</span><span className="rounded-full border border-line px-2 py-1 normal-case tracking-normal">{team.status}</span></div><h1 className="mt-1 break-words text-xl font-semibold tracking-tight sm:text-2xl">{team.name}</h1><p className="mt-1 text-xs text-fg-muted">{members.length} bots · {team.coordinationMode.replaceAll('_', ' ').toLowerCase()} · {team.markets.slice(0,5).join(' · ') || 'Markets not listed'}</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-[10px] text-fg-muted"><Radio size={12}/> Periodic refresh · 15s</span><button type="button" onClick={() => void load()} className="btn btn-secondary"><RefreshCw size={14}/> Refresh</button>{isOwner && <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.href); setCopied(true); }} className="btn btn-secondary"><Copy size={14}/>{copied ? 'Copied' : 'Share room'}</button>}</div>
      </header>

      {error && <div role="alert" className="panel mt-3 border-warning/40 p-3 text-sm text-fg-muted">{error}</div>}
      {notice && <div role="status" className="panel mt-3 p-3 text-sm text-fg-muted">{notice}</div>}

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.9fr)]">
        <div className="min-w-0 space-y-4">
          {/* STAGE: market data and trade levels are the visual anchor of the room. */}
          <section className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4 sm:p-5">
              <div><p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-accent-text"><ChartNoAxesCombined size={13}/> Stage · Market</p><h2 className="mt-1 text-lg font-semibold">{marketSymbol || 'No market selected'}</h2><p className="mt-1 text-xs text-fg-muted">{selectedMember ? selectedMember.name + ' · ' + selectedMember.provider : 'Select a team member'}</p></div>
              <div className="text-right"><p className="text-lg font-semibold tabular-nums">{marketQuote ? formatPrice(marketQuote.mid) : '—'}</p><p className="mt-1 text-[10px] text-fg-subtle">{marketQuote ? 'Bid ' + formatPrice(marketQuote.bid) + ' · Ask ' + formatPrice(marketQuote.ask) : 'Waiting for provider quote'}</p></div>
            </div>
            <div className="p-3 sm:p-4">
              {candles.length ? <div className="h-[320px] sm:h-[430px]"><TradingViewLightweightChart candles={candles} activeQuote={marketQuote} timeframe="1h" symbol={marketSymbol} digits={marketSymbol.toUpperCase().includes('BTC') ? 1 : 5}/></div> : <div className="flex h-[250px] flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 text-center"><ChartNoAxesCombined size={25} className="text-fg-subtle"/><p className="mt-3 text-sm font-medium">{marketError || 'No candle data available'}</p><p className="mt-1 max-w-md text-xs leading-5 text-fg-subtle">The room will only draw candles returned by the selected member’s provider. No sample prices or synthetic trade markers are shown.</p></div>}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[10px] text-fg-subtle"><span>Source: {marketProvider} · {marketDataMode}</span><span>{marketUpdatedAt ? 'Quote at ' + new Date(marketUpdatedAt).toLocaleTimeString() : 'Quote timestamp unavailable'}</span></div>
              {marketError && candles.length > 0 && <p className="mt-2 text-xs text-warning">{marketError}</p>}
              <div className="mt-3 flex flex-wrap gap-2">{members.map(member => <button key={member.id} type="button" onClick={() => setSelectedMemberId(member.id)} aria-pressed={selectedMember?.id === member.id} className={`rounded-full border px-3 py-1.5 text-xs transition ${selectedMember?.id === member.id ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-raised text-fg-muted hover:text-fg'}`}><Bot size={12} className="mr-1 inline"/>{member.name}</button>)}</div>
            </div>
          </section>

          {/* WORK: a chronological feed of persisted room records, never invented chat. */}
          <section className="rounded-2xl border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 sm:p-5"><div><p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-accent-text"><MessageSquare size={13}/> Work · Team feed</p><h2 className="mt-1 text-base font-semibold">What the team has recorded</h2><p className="mt-1 text-xs text-fg-muted">Market reviews and trade proposals, ordered by recorded time.</p></div><span className="rounded-full border border-line px-2.5 py-1 text-[10px] text-fg-muted">{feed.length} records</span></div>
            <div className="max-h-[780px] space-y-3 overflow-y-auto p-3 sm:p-4">
              {feed.length ? feed.map(item => <article key={item.id} className="rounded-xl border border-line bg-raised/50 p-3 sm:p-4">
                <div className="flex items-start gap-3"><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-accent-text">{item.kind.includes('REJECT') ? <X size={15}/> : item.kind.includes('ACCEPT') ? <Check size={15}/> : item.kind.includes('REVIEW') ? <BrainCircuit size={15}/> : <Activity size={15}/>}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold">{item.memberName} <span className="font-normal text-fg-subtle">· {item.kind.replaceAll('_',' ')}</span></p><time className="text-[10px] text-fg-subtle">{new Date(item.at).toLocaleString()}</time></div><h3 className="mt-1 text-sm font-semibold">{item.title}</h3><p className="mt-2 whitespace-pre-line text-xs leading-5 text-fg-muted">{item.body || 'No explanation was recorded.'}</p></div></div>
                {item.signal && <><div className="mt-3 grid grid-cols-3 gap-2">{[['Entry',item.signal.entry],['Stop loss',item.signal.stopLoss],['Take profit',item.signal.takeProfit]].map(([label,value]) => <div key={String(label)} className="rounded-lg border border-line bg-surface p-2"><p className="text-[9px] uppercase text-fg-subtle">{label}</p><p className="mt-1 break-words text-xs font-semibold">{formatPrice(typeof value === 'number' ? value : undefined)}</p></div>)}</div>{isOwner && !item.signal.decision && item.member && <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy === item.signal.id} onClick={() => void decide(item.member!, item.signal!, 'REJECTED')} className="btn btn-secondary"><X size={13}/> Reject</button><button type="button" disabled={busy === item.signal.id} onClick={() => void decide(item.member!, item.signal!, 'ACCEPTED')} className="btn btn-primary"><Check size={13}/> Review & accept</button></div>}<p className="mt-2 text-[10px] text-fg-subtle">Recorded proposal only. Accepting records approval; it does not submit an order.</p></>}
              </article>) : <div className="rounded-xl border border-dashed border-line p-8 text-center"><MessageSquare size={22} className="mx-auto text-fg-subtle"/><p className="mt-3 text-sm font-medium">The feed is quiet</p><p className="mt-1 text-xs leading-5 text-fg-subtle">No market reviews or proposals have been recorded for this team yet. The room does not generate pretend agent messages.</p></div>}
            </div>
          </section>
        </div>

        {/* BRAIN: compact, persistent state panel. On mobile it can be collapsed. */}
        <aside className="min-w-0 xl:sticky xl:top-4">
          <section className="overflow-hidden rounded-2xl border border-line bg-surface">
            <button type="button" onClick={() => setBrainOpen(value => !value)} aria-expanded={brainOpen} className="flex w-full items-center justify-between gap-3 border-b border-line p-4 text-left sm:p-5"><span><span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-accent-text"><BrainCircuit size={13}/> Brain · Live state</span><span className="mt-1 block text-sm font-semibold">Team state HUD</span></span><span className="rounded-full border border-line px-2.5 py-1 text-[10px] text-fg-muted">{brainOpen ? 'Hide' : 'Show'}</span></button>
            {brainOpen && <div className="space-y-4 p-4 sm:p-5">
              <div className="rounded-xl border border-line bg-raised p-3"><p className="text-[10px] uppercase tracking-wider text-fg-subtle">Current thesis</p><p className="mt-2 text-sm font-semibold">{selectedMember?.latestThesis ? selectedMember.latestThesis.bias + ' · ' + selectedMember.latestThesis.market : 'No thesis recorded'}</p><p className="mt-2 text-xs leading-5 text-fg-muted">{selectedMember?.latestThesis?.summary || 'The team has not saved a current thesis for this member.'}</p>{selectedMember?.latestThesis?.updatedAt && <p className="mt-2 text-[10px] text-fg-subtle">Recorded {new Date(selectedMember.latestThesis.updatedAt).toLocaleString()}</p>}</div>
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Team status</span><strong>{team.status}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Selected bot</span><strong className="max-w-[60%] truncate">{selectedMember?.name || 'None'}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Market bias</span><strong>{selectedMember?.latestThesis?.bias || 'Not recorded'}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Market data</span><strong className={quoteFresh ? 'text-positive' : 'text-warning'}>{marketQuote ? quoteFresh ? 'Recent quote' : 'Stale quote' : 'Unavailable'}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Candles loaded</span><strong>{candles.length || 'None'}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Latest proposal state</span><strong>{latestExecutionLabel}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Trading mode</span><strong>Provider-reported · {marketDataMode}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Provider</span><strong>{marketProvider}</strong></div>
                <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">Last room refresh</span><strong>{refreshAt ? new Date(refreshAt).toLocaleTimeString() : 'Not yet'}</strong></div>
              </div>
              <div className="rounded-xl border border-line bg-raised/60 p-3"><p className="flex items-center gap-2 text-xs font-semibold"><Clock3 size={13}/> Workflow status</p><p className="mt-2 text-xs leading-5 text-fg-muted">{selectedMember?.signals?.[0] ? 'A proposal is recorded. Review its current state in the Work feed.' : selectedMember?.latestThesis ? 'A market thesis is recorded. No proposal is currently available in this room view.' : 'Waiting for a recorded market review or proposal.'}</p></div>
              <p className="text-[10px] leading-5 text-fg-subtle">This panel reflects persisted room records and provider responses. It refreshes periodically; it is not a continuous stream. A quote is marked recent only when its provider timestamp is within 30 seconds.</p>
              <button type="button" onClick={() => setNotice(isOwner ? 'You manage this team. Review recorded proposals in the Work feed.' : 'You can explore this team here. Automated copy trading is not enabled for visitors.')} className="btn btn-secondary w-full">Trade with this team <ArrowUpRight size={14}/></button>
            </div>}
          </section>
          <section className="mt-3 rounded-2xl border border-line bg-surface p-4"><div className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck size={14} className="text-accent-text"/> Execution safety</div><p className="mt-2 text-[11px] leading-5 text-fg-muted">Proposals, approvals, submitted orders and confirmed executions are different states. This room only reports what its persisted records and provider responses can verify. Viewing or accepting a proposal does not submit an order.</p><p className="mt-3 text-[10px] text-fg-subtle">{isOwner ? 'You are viewing this room as its owner.' : 'Public room · recorded information only.'}</p></section>
        </aside>
      </div>
    </div>
  </main>;
}
