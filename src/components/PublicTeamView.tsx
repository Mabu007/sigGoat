import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, Clock, PanelRightClose, PanelRightOpen, Wallet } from 'lucide-react';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import {
  ChatPanel, MemoryPanel, NewsPanel, RunLogView, ToolsPanel, TradeModal, TradeRoomSidebar,
  TrackersPanel, TradesPanel,
  type RoomIndicators, type RoomMember, type RoomNewsPayload, type RoomPanelId, type RoomRun, type RoomRunLog, type RoomTrade,
} from './TradeRoomSidebar';
import { useAuth } from '../context/AuthContext';
import type { Candle, MarketQuote } from '../types';

/** A persisted agent signal. The room projection carries the full trade. */
type Signal = RoomTrade;
type Member = RoomMember;
type Room = { id: string; owner?: boolean; slug: string; name: string; visibility: 'PUBLIC' | 'PRIVATE'; status: string; coordinationMode: string; environment?: 'DEMO' | 'LIVE'; marketDataProvider?: string | null; liveTradingProvider?: 'ctrader' | 'hyperliquid' | null; memberCount: number; markets: string[]; asset?: string; provider?: string; liveTrading?: boolean; balance?: number | null; trades?: number };
type AccountPayload = { balance: number | null; currency?: string; source?: 'live' | 'recorded'; environment?: 'live' | 'demo'; reason?: string | null };
type Payload = { team: Room; members: Member[] };
type FeedItem = { id: string; memberName: string; kind: string; title: string; body: string; at: string; signal?: Signal; member?: Member };
type MarketPayload = { quotes: MarketQuote[]; candles: Candle[]; provider?: string; dataMode?: string; environment?: 'DEMO' | 'LIVE'; marketDataProvider?: string; executionAllowed?: boolean; indicators?: RoomIndicators; availableBars?: number; requestedCount?: number };

/**
 * History requested per timeframe, matching the agent's candle plan.
 *
 * Fetching the full series once and revealing it in the chart is far cheaper
 * than paging on scroll: the upstream request is identical either way, and the
 * chart never waits on the network to go back in time.
 */
const ROOM_TIMEFRAME_BARS: Record<string, number> = { '1D': 100, '4h': 200, '1h': 300, '15m': 400, '5m': 500 };

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`);
  return body as T;
}
const formatPrice = (value?: number, digits = 8) => value == null || !Number.isFinite(value) || value <= 0 ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const ROOM_CHART_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1D'];
const quoteHasPrice = (quote: MarketQuote | null) => Boolean(quote && Number.isFinite(quote.mid) && quote.mid > 0);
const quoteIsFresh = (quote: MarketQuote | null) => {
  if (!quoteHasPrice(quote) || quote?.stale) return false;
  if (typeof quote?.quoteAgeSeconds === 'number' && quote.quoteAgeSeconds > 60) return false;
  if (quote && Number.isFinite(quote.timestamp) && quote.timestamp > 1_000_000_000) {
    const timestampMs = quote.timestamp > 1_000_000_000_000 ? quote.timestamp : quote.timestamp * 1000;
    if (Date.now() - timestampMs > 60_000) return false;
  }
  return true;
};

export function PublicTeamView({ slug, backLabel = 'Rooms', onBack = () => { window.location.href = '/#/rooms'; } }: { slug: string; backLabel?: string; onBack?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesTimeframe, setCandlesTimeframe] = useState('');
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketError, setMarketError] = useState('');
  const [marketSymbol, setMarketSymbol] = useState('');
  const [marketProvider, setMarketProvider] = useState('');
  const [dataMode, setDataMode] = useState('');
  const [indicators, setIndicators] = useState<RoomIndicators | null>(null);
  const [timeframe, setTimeframe] = useState('15m');
  const [streamVisible, setStreamVisible] = useState(true);
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();

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

  const changeEnvironment = useCallback(async (environment: 'DEMO' | 'LIVE', provider?: 'ctrader' | 'hyperliquid') => {
    if (!data || !data.team.owner || environmentBusy) return;
    if (environment === 'LIVE' && !window.confirm('Switch this room to live market data? This does not enable or disable trading. Existing GOAT execution permissions remain unchanged.')) return;
    setEnvironmentBusy(true); setEnvironmentNotice(''); setError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id) + '/environment', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ environment, ...(provider ? { provider } : {}) }),
      });
      const result = await read<{ team: Room; message: string }>(response);
      setEnvironmentNotice(result.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the market-data environment.');
    } finally { setEnvironmentBusy(false); }
  }, [data, environmentBusy, getApiAuthHeaders, load]);


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
      setCandlesTimeframe('');
      setMarketQuote(null);
      setMarketSymbol(activeMarket);
      setMarketError(selectedMember ? 'No market configured for this bot.' : '');
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    setCandlesTimeframe('');
    const refreshMarket = async () => {
      try {
        const url = '/api/team-rooms/' + encodeURIComponent(slug) + '/market?memberId=' +
          encodeURIComponent(selectedMember.id) + '&symbol=' + encodeURIComponent(activeMarket) +
          '&timeframe=' + encodeURIComponent(timeframe) + '&count=' + (ROOM_TIMEFRAME_BARS[timeframe] ?? 300);
        const result = await read<MarketPayload>(await fetch(url, {
          headers: { Accept: 'application/json' }, cache: 'no-store',
        }));
        if (cancelled) return;
        const quote = result.quotes?.find(item => item.symbol === activeMarket) ?? result.quotes?.[0] ?? null;
        const nextCandles = Array.isArray(result.candles) ? result.candles : [];
        setMarketSymbol(activeMarket);
        setMarketQuote(quote);
        setCandles(nextCandles);
        setCandlesTimeframe(timeframe);
        setMarketProvider(result.provider || data?.team.provider || '');
        setDataMode(result.dataMode || '');
        // The Memory panel reads the same deterministic context the agents are
        // woken with, so it is kept rather than recomputed in the browser.
        if (result.indicators) setIndicators(result.indicators);
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
        /long|short|buy|sell/i.test(signal.direction) && Number.isFinite(Date.parse(signal.createdAt)))
      .map(signal => ({
        id: signal.id,
        time: Date.parse(signal.createdAt),
        price: signal.entry,
        direction: signal.direction,
        label: member.name + ' · ' + signal.direction,
      })));
  }, [data, activeMarket]);

  const priceDigits = marketSymbol.toUpperCase().includes('BTC') ? 2 : marketSymbol.toUpperCase().includes('ETH') ? 2 : 5;

  /**
   * The sidebar is a switchable control surface. News is fetched only once a
   * panel actually reports on it — it is the one request in this view that
   * costs an upstream round trip, and a visitor reading the chat has no use for
   * headlines. The Tools panel reports news status too, so opening it counts.
   */
  const [panel, setPanel] = useState<RoomPanelId>('chat');
  const [news, setNews] = useState<RoomNewsPayload | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  useEffect(() => {
    if ((panel !== 'news' && panel !== 'tools') || news) return;
    let cancelled = false;
    setNewsLoading(true);
    (async () => {
      const result = await read<RoomNewsPayload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/news', {
        headers: { Accept: 'application/json' }, cache: 'no-store',
      }));
      if (!cancelled) setNews(result);
    })().catch(error => {
      if (!cancelled) setNews({ market: marketSymbol, ok: false, error: error instanceof Error ? error.message : 'News unavailable.', fetchedAt: new Date().toISOString(), headlines: [] });
    }).finally(() => {
      if (!cancelled) setNewsLoading(false);
    });
    return () => { cancelled = true; };
  }, [panel, news, slug, marketSymbol]);

  const [openTrade, setOpenTrade] = useState<RoomTrade | null>(null);

  /**
   * Team Chat is run-backed: opening a message swaps the chat region for that
   * run's activity ledger rather than opening a modal over it, so the chart
   * and sidebar frame never move and Back lands where the list was.
   */
  const [logRun, setLogRun] = useState<RoomRun | null>(null);
  const [runLog, setRunLog] = useState<RoomRunLog | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  useEffect(() => {
    if (!logRun) return;
    let cancelled = false;
    setLogLoading(true);
    setRunLog(null);
    (async () => {
      const result = await read<RoomRunLog>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/runs/' + encodeURIComponent(logRun.workflowId), {
        headers: { Accept: 'application/json' }, cache: 'no-store',
      }));
      if (!cancelled) setRunLog(result);
    })()
      .catch(() => { if (!cancelled) setRunLog(null); })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
  }, [logRun, slug]);

  const [running, setRunning] = useState(false);
  const [runRequestedAt, setRunRequestedAt] = useState<number | null>(null);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [environmentNotice, setEnvironmentNotice] = useState('');
  const runTeam = useCallback(async () => {
    if (running || runRequestedAt !== null) return;
    const requestedAt = Date.now();
    setRunning(true);
    setRunRequestedAt(requestedAt);
    setError('');
    try {
      const headers = await getApiAuthHeaders();
      const response = await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/run', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ market: marketSymbol }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || body?.message || 'The team could not start its review.');
      // The server returns 202 while agents work. Keep the live indicator on
      // until the room poll sees a fresh, terminal run for every member.
    } catch (err) {
      setRunRequestedAt(null);
      setError(err instanceof Error ? err.message : 'The team could not start its review.');
    } finally {
      setRunning(false);
    }
  }, [slug, marketSymbol, getApiAuthHeaders, running, runRequestedAt]);

  const runs = useMemo<RoomRun[]>(() => (data?.members ?? [])
    .flatMap(member => (member.runs ?? []).map(run => ({ ...run, agentName: member.name })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [data]);

  /** Only the room owner may spend model calls; visitors get no Run button. */
  const canRun = (authMode === 'dev' || Boolean(currentUser)) && data?.team.owner === true;
  const teamRunActive = running || runRequestedAt !== null;
  useEffect(() => {
    if (runRequestedAt === null || !data?.members.length) return;
    const startedAfterRequest = (run: RoomRun) => Date.parse(run.at) >= runRequestedAt - 5_000;
    const membersWithFreshRuns = data.members.filter(member => member.runs.some(startedAfterRequest));
    const hasActiveFreshRun = runs.some(run => startedAfterRequest(run) && run.outcome === 'running');
    if (Date.now() - runRequestedAt > 15 * 60_000 || (membersWithFreshRuns.length === data.members.length && !hasActiveFreshRun)) setRunRequestedAt(null);
  }, [data, runs, runRequestedAt]);

  /** Every agent's trades, newest first, each attributed to the agent that raised it. */
  const trades = useMemo<RoomTrade[]>(() => (data?.members ?? [])
    .flatMap(member => member.signals.map(signal => ({ ...signal, agentName: member.name })))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [data]);

  const trackers = useMemo(() => (data?.members ?? [])
    .flatMap(member => member.latestThesis?.trackers ?? []), [data]);

  /**
   * The owner's connected trading account.
   *
   * Only the owner may read it, so this is fetched when signed in and the
   * header falls back to the balance recorded at room creation for everyone
   * else. Polled rarely: a broker balance is not a tick-rate number.
   */
  useEffect(() => {
    if (authMode !== 'dev' && !currentUser) return;
    let cancelled = false;
    const refreshAccount = async () => {
      try {
        const headers = await getApiAuthHeaders();
        const result = await read<AccountPayload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/account', {
          headers: { Accept: 'application/json', ...headers }, cache: 'no-store',
        }));
        if (!cancelled) setAccount(result);
      } catch {
        // The recorded balance from the room payload stands in. A broker being
        // unreachable must never blank the header.
      }
    };
    void refreshAccount();
    const timer = window.setInterval(() => void refreshAccount(), 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [slug, currentUser, authMode, getApiAuthHeaders]);

  /**
   * A one-second clock, started at mount so the first paint already has the
   * real time instead of a placeholder that pops a frame later.
   */
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const roomClock = useMemo(() => clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), [clock]);

  const balance = account?.balance ?? data?.team.balance ?? null;
  const balanceLabel = balance == null ? '—' : balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const balanceTitle = balance == null
    ? 'No account balance is available for this room yet.'
    : account?.source === 'live'
      ? 'Live balance from the connected trading account.'
      : data?.team.liveTrading
        ? 'Balance recorded when this room was created.' + (account?.reason ? ' ' + account.reason : '')
        : 'Demo balance set when this room was created.';
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
  if (!data) return <main className="trade-room-minimal"><div className="trade-room-error" role="alert">
    <span>{error || 'This room is unavailable.'}</span>
    <button type="button" onClick={onBack}><ArrowLeft size={13} strokeWidth={2.5} aria-hidden="true" /> Back to {backLabel}</button>
  </div></main>;

  return <main className={`trade-room-minimal${streamVisible ? '' : ' is-stream-hidden'}`}>
    <div className="trade-room-topbar">
      <button type="button" className="trade-room-back" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={2.5} aria-hidden="true" />
        <span>Back<span className="trade-room-back-target"> to {backLabel}</span></span>
      </button>
      <div className="trade-room-identity">
        <span className="trade-room-identity-name">{data.team.name}</span>
      </div>
      <dl className="trade-room-stats">
        <div className="trade-room-stat trade-room-stat-clock">
          <dt><Clock size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Room clock</span></dt>
          <dd className="trade-room-stat-value">{roomClock}</dd>
        </div>
        <div className="trade-room-stat">
          <dt><Wallet size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Account balance</span></dt>
          <dd className="trade-room-stat-value" title={balanceTitle}>
            {balance == null ? '—' : <><span className="trade-room-stat-unit trade-room-stat-currency">{account?.currency ?? 'USD'}</span>{balanceLabel}</>}
          </dd>
        </div>
        <div className="trade-room-stat">
          <dt><ArrowLeftRight size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Trades</span></dt>
          <dd className="trade-room-stat-value">{data.team.trades ?? 0}<span className="trade-room-stat-unit">trades</span></dd>
        </div>
        <div className={'trade-room-stat trade-room-stat-mode' + (data.team.liveTrading ? ' is-live' : ' is-demo')}>
          <dt><span className="sr-only">Account mode</span></dt>
          <dd className="trade-room-stat-value">{data.team.liveTrading ? 'Live' : 'Demo'}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="trade-room-stream-toggle"
        onClick={() => setStreamVisible(visible => !visible)}
        aria-controls="trade-room-stream"
        aria-expanded={streamVisible}
        aria-label={streamVisible ? 'Hide chat stream' : 'Show chat stream'}
      >
        <span>{streamVisible ? 'Hide chat' : 'Show chat'}</span>
        {streamVisible
          ? <PanelRightClose size={14} strokeWidth={2.5} aria-hidden="true" />
          : <PanelRightOpen size={14} strokeWidth={2.5} aria-hidden="true" />}
      </button>
    </div>
    <section className="trade-room-stage" aria-label="Market chart">
      <header className="sg-room-header">
        <div className="sg-room-instrument">
          <div className="sg-room-symbol-line">
            <span className="sg-room-symbol">{activeMarket || 'No asset configured'}</span>
            <span className="sg-room-provider">{(marketProvider || data.team.provider || 'MARKET').toUpperCase()}</span>
            <span className={'sg-room-provider ' + ((data.team.environment ?? 'DEMO') === 'LIVE' ? 'is-live' : 'is-demo')}>{(data.team.environment ?? 'DEMO') === 'LIVE' ? 'LIVE FEED' : 'DEMO FEED'}</span>
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

        {data.team.owner && <div className="sg-room-environment-controls" aria-label="Team market-data environment">
          <button type="button" disabled={environmentBusy || (data.team.environment ?? 'DEMO') === 'DEMO'} onClick={() => void changeEnvironment('DEMO')} aria-pressed={(data.team.environment ?? 'DEMO') === 'DEMO'}>Demo · BiQuote</button>
          <button type="button" disabled={environmentBusy || (data.team.environment === 'LIVE' && data.team.liveTradingProvider === 'ctrader')} onClick={() => void changeEnvironment('LIVE', 'ctrader')} aria-pressed={data.team.environment === 'LIVE' && data.team.liveTradingProvider === 'ctrader'}>Live · cTrader</button>
          <button type="button" disabled={environmentBusy || (data.team.environment === 'LIVE' && data.team.liveTradingProvider === 'hyperliquid')} onClick={() => void changeEnvironment('LIVE', 'hyperliquid')} aria-pressed={data.team.environment === 'LIVE' && data.team.liveTradingProvider === 'hyperliquid'}>Live · Hyperliquid</button>
        </div>
      </header>
      {environmentNotice && <div className="sg-room-environment-notice" role="status">{environmentNotice}</div>}
      <div className="trade-room-chart">
        {candles.length && candlesTimeframe === timeframe ? <TradingViewLightweightChart
          candles={candles} activeQuote={marketQuote} timeframe={timeframe}
          symbol={marketSymbol} roomName={data.team.name} digits={priceDigits}
          agentEvents={agentEvents} dataMode={dataMode}
        /> : <div className="trade-room-chart-empty"><span>{marketError || (candlesTimeframe !== timeframe ? 'Loading ' + timeframe + ' candles…' : 'Waiting for provider candle history')}</span></div>}
      </div>
    </section>
    <aside id="trade-room-stream" className="trade-room-stream" aria-label="Room control panel" aria-hidden={!streamVisible}>
      <TradeRoomSidebar
        panel={panel}
        onPanelChange={setPanel}
        status={quoteStatus}
        statusTitle={quoteStatusText}
        badges={{
          news: news?.headlines.length ?? 0,
          trades: trades.length,
          trackers: trackers.filter(item => item.status === 'HIT').length,
        }}
      />
      <div className="trade-room-stream-list">
        {panel === 'chat' && (logRun
          ? <RunLogView log={runLog} loading={logLoading} onBack={() => setLogRun(null)} />
          : <ChatPanel runs={runs} onOpenRun={setLogRun} canRun={canRun} onRun={runTeam} running={teamRunActive} />)}

        {panel === 'news' && <NewsPanel news={news} loading={newsLoading} />}
        {panel === 'trackers' && <TrackersPanel members={data.members} />}
        {panel === 'tools' && <ToolsPanel
          members={data.members} provider={marketProvider || data.team.provider || ''} dataMode={dataMode}
          asset={activeMarket || ''} liveTrading={data.team.liveTrading === true} indicators={indicators} news={news}
        />}
        {panel === 'memory' && <MemoryPanel members={data.members} indicators={indicators} asset={activeMarket || ''} />}
        {panel === 'trades' && <TradesPanel trades={trades} onOpen={setOpenTrade} />}
      </div>
    </aside>
    {openTrade && <TradeModal trade={openTrade} onClose={() => setOpenTrade(null)} />}
  </main>;
}
