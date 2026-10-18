import { useCallback, useEffect, useMemo, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import type { Candle, MarketQuote } from '../types';

type Signal = { id: string; market: string; direction: string; status: string; entry?: number; stopLoss?: number; takeProfit?: number; thesis: string; rationale: string; createdAt: string; decision?: string };
type Member = { id: string; name: string; goal: string; markets: string[]; status: string; provider: string; timeframe?: string; latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string }; signals: Signal[] };
type Room = { id: string; slug: string; name: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string; coordinationMode: string; memberCount: number; markets: string[]; asset?: string; provider?: string };
type Payload = { team: Room; members: Member[] };
type FeedItem = { id: string; memberName: string; kind: string; title: string; body: string; at: string; signal?: Signal; member?: Member };
async function read<T>(response: Response): Promise<T> { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`); return body as T; }
const formatPrice = (value?: number) => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 8 });
const ROOM_CHART_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1D'];

export function PublicTeamView({ slug, onBack = () => { window.location.href = '/#/rooms'; } }: { slug: string; onBack?: () => void }) {
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketError, setMarketError] = useState('');
  const [marketSymbol, setMarketSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('15m');
  const [streamVisible, setStreamVisible] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await read<Payload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug), { headers: { Accept: 'application/json' }, cache: 'no-store' }));
      setData(result); setError('');
      setSelectedMemberId(previous => previous && result.members.some(member => member.id === previous) ? previous : result.members[0]?.id || '');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load this room.'); }
    finally { setLoading(false); }
  }, [slug]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, [load]);

  const selectedMember = data?.members.find(member => member.id === selectedMemberId) ?? data?.members[0] ?? null;
  // Keep the shared chart useful before a bot has generated its first thesis or configured markets.
  // These are provider-native symbols: cTrader uses EURUSD; Hyperliquid uses BTC.
  const activeMarket = data?.team.asset || data?.team.markets?.[0] || selectedMember?.latestThesis?.market || selectedMember?.markets?.[0] || selectedMember?.signals?.[0]?.market || (data?.team.provider === 'ctrader' ? 'EURUSD' : data?.team.provider === 'hyperliquid' ? 'BTC' : '');

  useEffect(() => {
    const monitored = selectedMember?.timeframe || '15m';
    setTimeframe(ROOM_CHART_TIMEFRAMES.includes(monitored) ? monitored : '15m');
  }, [selectedMember?.id, selectedMember?.timeframe]);

  useEffect(() => {
    if (!selectedMember || !activeMarket) {
      setCandles([]); setMarketQuote(null); setMarketSymbol(activeMarket);
      setMarketError(selectedMember ? 'No market configured for this bot.' : '');
      return;
    }
    let cancelled = false;
    const refreshMarket = async () => {
      try {
        const response = await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/market?memberId=' + encodeURIComponent(selectedMember.id) + '&symbol=' + encodeURIComponent(activeMarket) + '&timeframe=' + encodeURIComponent(timeframe) + '&count=120', { headers: { Accept: 'application/json' }, cache: 'no-store' });
        const result = await read<{ quotes: MarketQuote[]; candles: Candle[]; provider?: string; dataMode?: string }>(response);
        if (cancelled) return;
        const quote = result.quotes?.find(item => item.symbol === activeMarket) ?? result.quotes?.[0] ?? null;
        setMarketSymbol(activeMarket); setMarketQuote(quote); setCandles(Array.isArray(result.candles) ? result.candles : []);
        
        setMarketError(quote || result.candles?.length ? '' : 'Market data unavailable from this provider.');
      } catch (err) {
        if (!cancelled) { setCandles([]); setMarketQuote(null); setMarketError(err instanceof Error ? err.message : 'Market data unavailable.'); }
      }
    };
    void refreshMarket();
    const interval = window.setInterval(() => void refreshMarket(), 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [slug, selectedMember?.id, activeMarket, timeframe]);

  const feed = useMemo<FeedItem[]>(() => {
    if (!data) return [];
    const entries: FeedItem[] = [];
    for (const member of data.members) {
      if (member.latestThesis) entries.push({ id: member.id + '-thesis-' + member.latestThesis.updatedAt, memberName: member.name, kind: 'MARKET REVIEW', title: member.latestThesis.bias + ' · ' + member.latestThesis.market, body: member.latestThesis.summary, at: member.latestThesis.updatedAt, member });
      for (const signal of member.signals || []) entries.push({ id: signal.id, memberName: member.name, kind: signal.decision || signal.status || 'PROPOSAL', title: signal.market + ' · ' + signal.direction, body: [signal.thesis, signal.rationale].filter(Boolean).join('\\n\\n'), at: signal.createdAt, signal, member });
    }
    return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [data]);

  // Keep auth context available for room-specific provider access without adding controls to the viewing surface.
  void currentUser; void authMode; void getApiAuthHeaders;

  if (loading) return <main className="trade-room-minimal"><div className="trade-room-loading" aria-label="Loading trade room" /></main>;
  if (!data) return <main className="trade-room-minimal"><div className="trade-room-error" role="alert">{error || 'This room is unavailable.'}<button type="button" onClick={onBack} aria-label="Back to rooms">←</button></div></main>;

  return <main className={`trade-room-minimal${streamVisible ? '' : ' is-stream-hidden'}`}>
    <section className="trade-room-stage" aria-label="Market chart">
      <div className="trade-room-topbar">
        <button type="button" onClick={onBack} className="trade-room-back" aria-label="Back to Trade Rooms">← <span>Back to {data.team.visibility === 'PRIVATE' ? 'Private' : 'Public'} Room</span></button>
        <div className="trade-room-topbar-spacer" />
        <button type="button" className="trade-room-stream-toggle" onClick={() => setStreamVisible(value => !value)} aria-expanded={streamVisible} aria-controls="trade-room-stream" title={streamVisible ? 'Hide chat and expand chart' : 'Show chat'}>
          {streamVisible ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
          <span>{streamVisible ? 'Hide chat' : 'Show chat'}</span>
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="text-base font-bold tracking-wide text-white sm:text-lg">{activeMarket || 'No asset configured'}</div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums text-white sm:text-2xl">{marketQuote ? marketQuote.mid.toLocaleString(undefined, { maximumFractionDigits: activeMarket.toUpperCase().includes('BTC') ? 2 : 8 }) : 'Waiting for price…'}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-white/40">{marketQuote?.stale ? 'Last known price · market closed' : marketQuote ? 'Price refreshes every 5 seconds' : marketError || 'Live quote unavailable'}</div>
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-black/20 p-1" role="group" aria-label="Chart timeframe">
          {ROOM_CHART_TIMEFRAMES.map(frame => <button type="button" key={frame} onClick={() => setTimeframe(frame)} aria-pressed={timeframe === frame} className={(timeframe === frame ? 'rounded-lg bg-violet-300 px-3 py-1.5 text-xs font-semibold text-black' : 'rounded-lg px-3 py-1.5 text-xs font-semibold text-white/60 hover:bg-white/10 hover:text-white')}>{frame}</button>)}
        </div>
      </div>
      <div className="trade-room-chart">
        {candles.length ? <TradingViewLightweightChart candles={candles} activeQuote={marketQuote} timeframe={timeframe} symbol={marketSymbol} roomName={data.team.name} digits={marketSymbol.toUpperCase().includes('BTC') ? 1 : 5}/> : <div className="trade-room-chart-empty"><span>{marketError || 'Waiting for market data'}</span></div>}
      </div>
    </section>
    <aside id="trade-room-stream" className="trade-room-stream" aria-label="AI collaboration stream" aria-live="polite" aria-hidden={!streamVisible}>
      <div className="trade-room-stream-list">
        {feed.length ? feed.map(item => <article key={item.id} className="trade-room-stream-item">
          <div className="trade-room-stream-meta"><span className="trade-room-agent">{item.memberName}</span><time dateTime={item.at}>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          <div className="trade-room-stream-kind">{item.kind.replaceAll('_', ' ')}</div>
          <h2>{item.title}</h2>
          {item.body && <p>{item.body}</p>}
          {item.signal && <div className="trade-room-levels"><span>Entry <b>{formatPrice(item.signal.entry)}</b></span><span>Stop <b>{formatPrice(item.signal.stopLoss)}</b></span><span>Target <b>{formatPrice(item.signal.takeProfit)}</b></span></div>}
        </article>) : <div className="trade-room-stream-empty">{error || 'Waiting for the bots to share their first market review.'}</div>}
      </div>
    </aside>
  </main>;
}
