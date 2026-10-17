import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import type { Candle, MarketQuote } from '../types';

type Signal = { id: string; market: string; direction: string; status: string; entry?: number; stopLoss?: number; takeProfit?: number; thesis: string; rationale: string; createdAt: string; decision?: string };
type Member = { id: string; name: string; goal: string; markets: string[]; status: string; provider: string; latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string }; signals: Signal[] };
type Room = { id: string; slug: string; name: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string; coordinationMode: string; memberCount: number; markets: string[] };
type Payload = { team: Room; members: Member[] };
type FeedItem = { id: string; memberName: string; kind: string; title: string; body: string; at: string; signal?: Signal; member?: Member };
async function read<T>(response: Response): Promise<T> { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`); return body as T; }
const formatPrice = (value?: number) => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 8 });

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
  const activeMarket = selectedMember?.latestThesis?.market || selectedMember?.markets?.[0] || selectedMember?.signals?.[0]?.market || '';

  useEffect(() => {
    if (!selectedMember || !activeMarket) {
      setCandles([]); setMarketQuote(null); setMarketSymbol(activeMarket);
      setMarketError(selectedMember ? 'No market configured for this bot.' : '');
      return;
    }
    let cancelled = false;
    const refreshMarket = async () => {
      try {
        const response = await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/market?memberId=' + encodeURIComponent(selectedMember.id) + '&symbol=' + encodeURIComponent(activeMarket) + '&timeframe=1h&count=120', { headers: { Accept: 'application/json' }, cache: 'no-store' });
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
    const interval = window.setInterval(() => void refreshMarket(), 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [slug, selectedMember?.id, activeMarket]);

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

  return <main className="trade-room-minimal">
    <section className="trade-room-stage" aria-label="Market chart">
      <div className="trade-room-chart">
        {candles.length ? <TradingViewLightweightChart candles={candles} activeQuote={marketQuote} timeframe="1h" symbol={marketSymbol} digits={marketSymbol.toUpperCase().includes('BTC') ? 1 : 5}/> : <div className="trade-room-chart-empty"><span>{marketError || 'Waiting for market data'}</span></div>}
      </div>
    </section>
    <aside className="trade-room-stream" aria-label="AI collaboration stream" aria-live="polite">
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
