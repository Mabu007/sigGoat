import { useCallback, useEffect, useMemo, useState } from 'react';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import type { Candle, MarketQuote } from '../types';

type Signal = { id: string; market: string; direction: string; status: string; entry?: number; stopLoss?: number; takeProfit?: number; thesis: string; rationale: string; createdAt: string; decision?: string };
type Member = { id: string; name: string; goal: string; markets: string[]; status: string; provider: string; timeframe?: string; latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string }; signals: Signal[] };
type Room = { id: string; slug: string; name: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string; coordinationMode: string; memberCount: number; markets: string[]; asset?: string; provider?: string };
type Payload = { team: Room; members: Member[] };
type FeedItem = { id: string; memberName: string; kind: string; title: string; body: string; at: string; signal?: Signal; member?: Member };
type MarketPayload = { quotes: MarketQuote[]; candles: Candle[]; provider?: string; dataMode?: string };

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`);
  return body as T;
}
const formatPrice = (value?: number, digits = 8) => value == null || !Number.isFinite(value) || value <= 0 ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const ROOM_CHART_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1D'];
const quoteHasPrice = (quote: MarketQuote | null) => Boolean(quote && Number.isFinite(quote.mid) && quote.mid > 0);
const quoteIsFresh = (quote: MarketQuote | null) => Boolean(
  quoteHasPrice(quote) && !quote?.stale &&
  !(typeof quote?.quoteAgeSeconds === 'number' && quote.quoteAgeSeconds > 60)
);

export function PublicTeamView({ slug, onBack = () => { window.location.href = '/#/rooms'; } }: { slug: string; onBack?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketError, setMarketError] = useState('');
  const [marketSymbol, setMarketSymbol] = useState('');
  const [marketProvider, setMarketProvider] = useState('');
  const [dataMode, setDataMode] = useState('');
  const [timeframe, setTimeframe] = useState('15m');

  const load = useCallback(async () => {
    try {
      const result = await read<Payload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug), {
        headers: { Accept: 'application/json' }, cache: 'no-store',
      }));
      setData(result);
      setError('');
      setSelectedMemberId(previous => previous && result.members.some(member => member.id === previous) ? previous : result.members[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this room.');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, [load]);

  const selectedMember = data?.members.find(member => member.id === selectedMemberId) ?? data?.members[0] ?? null;
  // A deployed room has one immutable instrument. Member markets are only a legacy fallback.
  const activeMarket = data?.team.asset || data?.team.markets?.[0] ||
    selectedMember?.latestThesis?.market || selectedMember?.markets?.[0] ||
    selectedMember?.signals?.[0]?.market ||
    (data?.team.provider === 'ctrader' ? 'EURUSD' : data?.team.provider === 'hyperliquid' ? 'BTC' : '');

  useEffect(() => {
    const monitored = selectedMember?.timeframe || '15m';
    setTimeframe(ROOM_CHART_TIMEFRAMES.includes(monitored) ? monitored : '15m');
  }, [selectedMember?.id, selectedMember?.timeframe]);

  useEffect(() => {
    if (!selectedMember || !activeMarket) {
      setCandles([]);
      setMarketQuote(null);
      setMarketSymbol(activeMarket);
      setMarketError(selectedMember ? 'No market configured for this bot.' : '');
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const refreshMarket = async () => {
      try {
        const url = '/api/team-rooms/' + encodeURIComponent(slug) + '/market?memberId=' +
          encodeURIComponent(selectedMember.id) + '&symbol=' + encodeURIComponent(activeMarket) +
          '&timeframe=' + encodeURIComponent(timeframe) + '&count=160';
        const result = await read<MarketPayload>(await fetch(url, {
          headers: { Accept: 'application/json' }, cache: 'no-store',
        }));
        if (cancelled) return;
        const quote = result.quotes?.find(item => item.symbol === activeMarket) ?? result.quotes?.[0] ?? null;
        const nextCandles = Array.isArray(result.candles) ? result.candles : [];
        setMarketSymbol(activeMarket);
        setMarketQuote(quote);
        setCandles(nextCandles);
        setMarketProvider(result.provider || data?.team.provider || '');
        setDataMode(result.dataMode || '');
        setMarketError(quoteHasPrice(quote) || nextCandles.length ? '' : quote?.unavailableReason || 'Market data unavailable from this provider.');
      } catch (err) {
        if (!cancelled) {
          setMarketQuote(null);
          setMarketError(err instanceof Error ? err.message : 'Market data unavailable.');
          // Keep the last valid candle history visible during a transient quote/API failure.
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refreshMarket(), 5000);
      }
    };
    void refreshMarket();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [slug, selectedMember?.id, activeMarket, timeframe, data?.team.provider]);

  const feed = useMemo<FeedItem[]>(() => {
    if (!data) return [];
    const entries: FeedItem[] = [];
    for (const member of data.members) {
      if (member.latestThesis) entries.push({
        id: member.id + '-thesis-' + member.latestThesis.updatedAt,
        memberName: member.name, kind: 'MARKET REVIEW',
        title: member.latestThesis.bias + ' · ' + member.latestThesis.market,
        body: member.latestThesis.summary, at: member.latestThesis.updatedAt, member,
      });
      for (const signal of member.signals || []) entries.push({
        id: signal.id, memberName: member.name,
        kind: signal.decision || signal.status || 'PROPOSAL',
        title: signal.market + ' · ' + signal.direction,
        body: [signal.thesis, signal.rationale].filter(Boolean).join('\n\n'),
        at: signal.createdAt, signal, member,
      });
    }
    return entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [data]);

  // Markers come only from persisted agent signals with a real timestamp and a defined entry.
  const agentEvents = useMemo(() => {
    if (!data || !activeMarket) return [];
    return data.members.flatMap(member => (member.signals || [])
      .filter(signal => signal.market.toUpperCase() === activeMarket.toUpperCase() &&
        Number.isFinite(signal.entry) && (signal.entry || 0) > 0 &&
        Number.isFinite(Date.parse(signal.createdAt)))
      .map(signal => ({
        id: signal.id,
        time: Date.parse(signal.createdAt),
        price: signal.entry,
        direction: signal.direction,
        label: member.name + ' · ' + signal.direction,
      })));
  }, [data, activeMarket]);

  const priceDigits = marketSymbol.toUpperCase().includes('BTC') ? 2 : marketSymbol.toUpperCase().includes('ETH') ? 2 : 5;
  const quoteStatus = !quoteHasPrice(marketQuote)
    ? 'unavailable'
    : quoteIsFresh(marketQuote) && dataMode.toUpperCase() !== 'PAPER'
      ? 'live'
      : 'stale';
  const quoteStatusText = !quoteHasPrice(marketQuote)
    ? (marketError || 'Quote unavailable · waiting for provider')
    : dataMode.toUpperCase() === 'PAPER'
      ? 'Paper/simulated market data'
      : marketQuote?.stale || !quoteIsFresh(marketQuote)
        ? 'Last known price · not streaming'
        : 'Live quote · refreshes every 5 seconds';

  if (loading) return <main className="trade-room-minimal"><div className="trade-room-loading" aria-label="Loading trade room" /></main>;
  if (!data) return <main className="trade-room-minimal"><div className="trade-room-error" role="alert">{error || 'This room is unavailable.'}<button type="button" onClick={onBack} aria-label="Back to rooms">←</button></div></main>;

  return <main className="trade-room-minimal">
    <section className="trade-room-stage" aria-label="Market chart">
      <header className="sg-room-header">
        <div className="sg-room-instrument">
          <div className="sg-room-symbol-line">
            <span className="sg-room-symbol">{activeMarket || 'No asset configured'}</span>
            <span className="sg-room-provider">{(marketProvider || data.team.provider || 'MARKET').toUpperCase()}</span>
            {dataMode && <span className="sg-room-provider">{dataMode.toUpperCase()}</span>}
          </div>
          <div className="sg-room-price-row">
            <span className="sg-room-price">{quoteHasPrice(marketQuote) ? formatPrice(marketQuote!.mid, priceDigits) : '—'}</span>
          </div>
          <div className={'sg-room-status' + (quoteStatus === 'live' ? ' is-live' : quoteStatus === 'stale' ? ' is-stale' : ' is-unavailable')}>
            {quoteStatusText}
          </div>
        </div>
        <div className="sg-room-timeframes" role="group" aria-label="Chart timeframe">
          {ROOM_CHART_TIMEFRAMES.map(frame => <button
            type="button" key={frame} onClick={() => setTimeframe(frame)}
            aria-pressed={timeframe === frame} className="sg-room-timeframe"
          >{frame}</button>)}
        </div>
      </header>
      <div className="trade-room-chart">
        {candles.length ? <TradingViewLightweightChart
          candles={candles} activeQuote={marketQuote} timeframe={timeframe}
          symbol={marketSymbol} roomName={data.team.name} digits={priceDigits}
          agentEvents={agentEvents} dataMode={dataMode}
        /> : <div className="trade-room-chart-empty"><span>{marketError || 'Waiting for provider candle history'}</span></div>}
      </div>
    </section>
    <aside className="trade-room-stream" aria-label="AI collaboration stream">
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
