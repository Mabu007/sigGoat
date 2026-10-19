import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, PanelRightClose, PanelRightOpen, Settings, X, Save, Trash2, Users, Globe, LockKeyhole, ChevronDown } from 'lucide-react';
import { TradingViewLightweightChart } from './TradingViewLightweightChart';
import {
  ConnectBrokerPanel, GroupDetailsPanel, MarketPanel, MentorChatPanel, NewsPanel, RoomChatPanel, TradeRoomSidebar,
  type BrokerConnectionState, type MentorThreadSummary, type RoomChatMessage, type RoomGroupDetails, type RoomGroupMember,
  type RoomIndicators, type RoomMember, type RoomNewsPayload, type RoomPanelId,
} from './TradeRoomSidebar';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import type { Candle, MarketQuote } from '../types';

type Member = RoomMember;
type Room = {
  id: string; owner?: boolean; slug: string; name: string; instructions?: string;
  visibility: 'PUBLIC' | 'PRIVATE'; status: string; memberCount: number; markets: string[];
  asset?: string; provider?: string; balance?: number | null; trades?: number;
};
type RoomSkill = { id: string; name: string; description?: string; isDefault?: boolean };
type AccountPayload = { balance: number | null; currency?: string; source?: 'live' | 'recorded'; environment?: 'live' | 'demo'; reason?: string | null };
type Payload = { team: Room; members: Member[] };
type MarketPayload = { quotes: MarketQuote[]; candles: Candle[]; provider?: string; dataMode?: string; indicators?: RoomIndicators; availableBars?: number; requestedCount?: number };

/**
 * WHO AM I IN THIS ROOM.
 *
 * The room document itself is public and shared-cache, so everything that
 * depends on the viewer lives on its own authenticated route.
 */
type RoomIdentity = {
  signedIn: boolean;
  isOwner: boolean;
  isMember: boolean;
  role: 'LEADER' | 'MEMBER' | null;
  room: RoomGroupDetails;
  memberCount: number;
  members: RoomGroupMember[];
};

/** One page of the room conversation. */
type RoomChatPage = { messages: RoomChatMessage[]; hasMore: boolean };

/** The private line between a member and the room's leader. */
type MentorChatPayload = {
  role: 'LEADER' | 'MEMBER';
  mentor: { id: string; displayName: string };
  threads: MentorThreadSummary[];
  thread: { memberId: string; memberName: string; messages: RoomChatMessage[] } | null;
};

type AssetOption = { symbol: string; name: string; category: string };

const ROOM_CHART_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1D'];

/**
 * History requested per timeframe.
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
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesTimeframe, setCandlesTimeframe] = useState('');
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketError, setMarketError] = useState('');
  const [marketSymbol, setMarketSymbol] = useState('');
  const [dataMode, setDataMode] = useState('');
  const [indicators, setIndicators] = useState<RoomIndicators | null>(null);
  const [timeframe, setTimeframe] = useState('15m');
  const [panel, setPanel] = useState<RoomPanelId>('chat');
  const [streamVisible, setStreamVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsName, setSettingsName] = useState('');
  const [settingsDescription, setSettingsDescription] = useState('');
  const [settingsVisibility, setSettingsVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PRIVATE');
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetSaving, setAssetSaving] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [roomIdentity, setRoomIdentity] = useState<RoomIdentity | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [joining, setJoining] = useState(false);
  const [chatMessages, setChatMessages] = useState<RoomChatMessage[]>([]);
  const [chatError, setChatError] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [mentorThreads, setMentorThreads] = useState<MentorThreadSummary[]>([]);
  const [mentorMessages, setMentorMessages] = useState<RoomChatMessage[]>([]);
  const [mentorMemberId, setMentorMemberId] = useState<string | null>(null);
  const [mentorLoading, setMentorLoading] = useState(false);
  const [mentorError, setMentorError] = useState('');
  const [mentorSending, setMentorSending] = useState(false);
  const [broker, setBroker] = useState<BrokerConnectionState>({ cTrader: null, propDao: null });
  const [brokerLoading, setBrokerLoading] = useState(false);
  const [brokerError, setBrokerError] = useState('');
  const { currentUser, authMode, getApiAuthHeaders, openAuthModal } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const signedIn = Boolean(currentUser) || authMode === 'dev';

  /**
   * Auth headers for a room request, or none at all for a visitor who is not
   * signed in.
   *
   * A room link is public: someone who has never signed in must still be
   * able to OPEN it and see the chart and the room. Asking for a token they
   * do not have would turn a public page into an error.
   */
  const optionalAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (authMode === 'dev') {
      try { return await getApiAuthHeaders(); } catch { return {}; }
    }
    if (!currentUser) return {};
    try { return await getApiAuthHeaders(); } catch { return {}; }
  }, [authMode, currentUser, getApiAuthHeaders]);

  const load = useCallback(async () => {
    try {
      const result = await read<Payload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug), {
        headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) }, cache: 'no-store',
      }));
      setData(result);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this room.');
    } finally {
      setLoading(false);
    }
  }, [slug, optionalAuthHeaders]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, [load]);

  /* ------------------------------------------------------------------ */
  /* The room community: who I am, the room chat, the mentor thread.     */
  /* ------------------------------------------------------------------ */

  /** The viewer's standing in this room. */
  const loadIdentity = useCallback(async () => {
    try {
      const result = await read<RoomIdentity>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/me', {
        headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) }, cache: 'no-store',
      }));
      setRoomIdentity(result);
      setIdentityError('');
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : 'Could not load your access to this room.');
    }
  }, [slug, optionalAuthHeaders]);

  useEffect(() => {
    void loadIdentity();
    const timer = window.setInterval(() => void loadIdentity(), 30000);
    return () => window.clearInterval(timer);
  }, [loadIdentity]);

  /**
   * Whether the visitor has asked to be a member of this room.
   *
   * Pressing the locked composer is that ask. When they come back from
   * signing in, the room lets them in — so "register" really is the only
   * step between a visitor and the conversation.
   */
  const [joinRequested, setJoinRequested] = useState(false);

  /** Joining is what opens the conversation to this person. */
  const joinRoom = useCallback(async () => {
    if (joining) return;
    setJoining(true); setChatError(''); setMentorError('');
    try {
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      await read(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/join', { method: 'POST', headers, body: '{}' }));
      await loadIdentity();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Could not join this room.');
    } finally { setJoining(false); }
  }, [joining, slug, getApiAuthHeaders, loadIdentity]);

  /**
   * A visitor who pressed the locked composer and then signed in is let in
   * without a second click.
   */
  useEffect(() => {
    if (!joinRequested || !signedIn) return;
    if (!roomIdentity || roomIdentity.isMember) { setJoinRequested(false); return; }
    setJoinRequested(false);
    void joinRoom();
  }, [joinRequested, signedIn, roomIdentity, joinRoom]);

  /**
   * The room conversation.
   *
   * Read incrementally: the first read takes the latest page, and every
   * poll after it asks only for what has been written since the last message
   * this browser saw. The room's history is never re-read.
   *
   * The cursor lives in a ref, not in state: putting it in state would make
   * every new message restart the poll and re-read the page.
   */
  const chatCursor = useRef<string | null>(null);
  const chatMessagesRef = useRef<RoomChatMessage[]>([]);
  const applyChatMessages = useCallback((next: RoomChatMessage[]) => {
    chatMessagesRef.current = next;
    setChatMessages(next);
  }, []);

  const loadChat = useCallback(async (incremental: boolean) => {
    if (!roomIdentity?.isMember) return;
    try {
      const cursor = incremental ? chatCursor.current : null;
      const query = cursor ? '?since=' + encodeURIComponent(cursor) : '';
      const result = await read<RoomChatPage>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/chat' + query, {
        headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) }, cache: 'no-store',
      }));
      const previous = chatMessagesRef.current;
      const merged = cursor
        ? [...previous, ...result.messages.filter(message => !previous.some(existing => existing.id === message.id))]
        : result.messages;
      applyChatMessages(merged);
      chatCursor.current = merged.length ? merged[merged.length - 1].createdAt : null;
      setChatError('');
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'The room conversation is unavailable.');
    }
  }, [slug, roomIdentity?.isMember, optionalAuthHeaders, applyChatMessages]);

  useEffect(() => {
    if (panel !== 'chat' || !roomIdentity?.isMember) return;
    chatCursor.current = null;
    void loadChat(false);
    const timer = window.setInterval(() => void loadChat(true), 5000);
    return () => window.clearInterval(timer);
  }, [panel, roomIdentity?.isMember, loadChat]);

  const sendChatMessage = useCallback(async (content: string) => {
    setChatSending(true); setChatError('');
    try {
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const result = await read<{ message: RoomChatMessage }>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/chat', {
        method: 'POST', headers, body: JSON.stringify({ content }),
      }));
      const previous = chatMessagesRef.current;
      if (!previous.some(message => message.id === result.message.id)) {
        applyChatMessages([...previous, result.message]);
        chatCursor.current = result.message.createdAt;
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Your message could not be posted.');
    } finally { setChatSending(false); }
  }, [slug, getApiAuthHeaders, applyChatMessages]);

  /**
   * The private line to the room's leader. A member reads their own thread;
   * the leader reads the threads their members started.
   */
  const mentorSelection = useRef<string | null>(null);

  const loadMentorChat = useCallback(async (memberId?: string | null) => {
    if (!roomIdentity?.isMember) return;
    setMentorLoading(true);
    try {
      const query = memberId ? '?memberId=' + encodeURIComponent(memberId) : '';
      const result = await read<MentorChatPayload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/mentor-chat' + query, {
        headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) }, cache: 'no-store',
      }));
      setMentorThreads(result.threads);
      setMentorMessages(result.thread?.messages ?? []);
      mentorSelection.current = result.thread?.memberId ?? mentorSelection.current;
      setMentorMemberId(result.thread?.memberId ?? null);
      setMentorError('');
    } catch (err) {
      setMentorError(err instanceof Error ? err.message : 'The private conversation is unavailable.');
    } finally { setMentorLoading(false); }
  }, [slug, roomIdentity?.isMember, optionalAuthHeaders]);

  useEffect(() => {
    if (panel !== 'mentor' || !roomIdentity?.isMember) return;
    void loadMentorChat(mentorSelection.current);
    const timer = window.setInterval(() => void loadMentorChat(mentorSelection.current), 8000);
    return () => window.clearInterval(timer);
  }, [panel, roomIdentity?.isMember, loadMentorChat]);

  const selectMentorThread = useCallback((memberId: string) => {
    mentorSelection.current = memberId;
    setMentorMemberId(memberId);
    void loadMentorChat(memberId);
  }, [loadMentorChat]);

  const sendMentorMessage = useCallback(async (content: string) => {
    setMentorSending(true); setMentorError('');
    try {
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const result = await read<{ message: RoomChatMessage; memberId: string }>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/mentor-chat', {
        method: 'POST', headers,
        body: JSON.stringify({ content, ...(roomIdentity?.role === 'LEADER' && mentorMemberId ? { memberId: mentorMemberId } : {}) }),
      }));
      setMentorMessages(previous => previous.some(message => message.id === result.message.id) ? previous : [...previous, result.message]);
    } catch (err) {
      setMentorError(err instanceof Error ? err.message : 'Your message could not be sent.');
    } finally { setMentorSending(false); }
  }, [slug, getApiAuthHeaders, roomIdentity?.role, mentorMemberId]);

  /**
   * The member's own broker connections. The panel only reports what the
   * server verified; the connection itself is made in Settings, which owns
   * the OAuth flow and the vault.
   */
  const loadBrokerState = useCallback(async () => {
    if (!signedIn) return;
    setBrokerLoading(true);
    try {
      const headers = { Accept: 'application/json', ...(await getApiAuthHeaders()) };
      const [cTraderResponse, propDaoResponse] = await Promise.all([
        fetch('/api/ctrader/status', { headers }),
        fetch('/api/propdao/status', { headers }),
      ]);
      const cTraderBody = await cTraderResponse.json().catch(() => null);
      const propDaoBody = await propDaoResponse.json().catch(() => null);
      setBroker({
        cTrader: cTraderResponse.ok && cTraderBody
          ? {
              configured: cTraderBody.configured === true,
              connected: cTraderBody.connected === true,
              selectedAccountId: cTraderBody.selectedAccountId ?? null,
              selectedAccountIsLive: cTraderBody.selectedAccountIsLive === true,
            }
          : null,
        propDao: propDaoResponse.ok && propDaoBody
          ? { configured: propDaoBody.credential?.configured === true, connected: propDaoBody.connected === true }
          : null,
      });
      setBrokerError(cTraderResponse.ok && propDaoResponse.ok ? '' : 'Could not read your broker connections.');
    } catch (err) {
      setBrokerError(err instanceof Error ? err.message : 'Could not read your broker connections.');
    } finally { setBrokerLoading(false); }
  }, [signedIn, getApiAuthHeaders]);

  useEffect(() => {
    if (panel !== 'broker') return;
    void loadBrokerState();
  }, [panel, loadBrokerState]);

  /**
   * The connection screens live in Settings, which is where the OAuth
   * callback, the account selection and the vault all are. The room sends
   * the member there with the right section in view.
   */
  const openBrokerSettings = useCallback((section: 'ctrader' | 'propdao') => {
    window.location.hash = '/settings?section=' + section;
  }, []);

  /* ------------------------------------------------------------------ */
  /* The chart                                                            */
  /* ------------------------------------------------------------------ */

  const activeMarket = data?.team.asset || '';

  useEffect(() => {
    if (!activeMarket) {
      setCandles([]);
      setCandlesTimeframe('');
      setMarketQuote(null);
      setMarketError('The leader of this room has not chosen an instrument yet.');
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    setCandlesTimeframe('');
    const refreshMarket = async () => {
      try {
        const url = '/api/team-rooms/' + encodeURIComponent(slug) + '/market?symbol=' +
          encodeURIComponent(activeMarket) + '&timeframe=' + encodeURIComponent(timeframe) +
          '&count=' + (ROOM_TIMEFRAME_BARS[timeframe] ?? 300);
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
        setDataMode(result.dataMode || '');
        if (result.indicators) setIndicators(result.indicators);
        setMarketError(quoteHasPrice(quote) || nextCandles.length ? '' : 'No price data is available for this instrument.');
      } catch (err) {
        if (!cancelled) {
          setMarketQuote(null);
          setMarketError(err instanceof Error ? err.message : 'Market data unavailable.');
          // Keep the last valid candle history visible during a transient failure.
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
  }, [slug, activeMarket, timeframe]);

  /* ------------------------------------------------------------------ */
  /* Owner controls                                                       */
  /* ------------------------------------------------------------------ */

  const openRoomSettings = useCallback(async () => {
    if (!data) return;
    setSettingsError('');
    setSettingsOpen(true);
    if (!data.team.owner) return;
    setSettingsName(data.team.name);
    setSettingsDescription(data.team.instructions ?? '');
    setSettingsVisibility(data.team.visibility ?? 'PRIVATE');
  }, [data]);

  const saveRoomSettings = useCallback(async () => {
    if (!data?.team.owner || settingsSaving) return;
    if (!settingsName.trim()) { setSettingsError('Room name cannot be empty.'); return; }
    setSettingsSaving(true); setSettingsError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id), {
        method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: settingsName.trim(), instructions: settingsDescription, visibility: settingsVisibility }),
      });
      await read<{ team: Room }>(response);
      setSettingsOpen(false);
      await load();
    } catch (err) { setSettingsError(err instanceof Error ? err.message : 'Could not save the room settings.'); }
    finally { setSettingsSaving(false); }
  }, [data, settingsSaving, settingsName, settingsDescription, settingsVisibility, getApiAuthHeaders, load]);

  /**
   * THE INSTRUMENT ON THE ROOM'S CHART.
   *
   * The leader of the room decides what everyone in it is looking at. The
   * list of instruments is the same one the platform actually quotes, so the
   * chart can never be pointed at something that does not exist.
   */
  const loadAssets = useCallback(async () => {
    if (!signedIn) return;
    setAssetsLoading(true);
    try {
      const headers = new Headers({ Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/markets/assets?provider=ctrader', { headers, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.assets)) setAssets(body.assets as AssetOption[]);
    } catch {
      setAssets([]);
    } finally { setAssetsLoading(false); }
  }, [signedIn, getApiAuthHeaders]);

  const changeRoomAsset = useCallback(async (symbol: string) => {
    if (!data?.team.owner || !symbol || assetSaving) return;
    setAssetSaving(true); setSettingsError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id), {
        method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ asset: symbol }),
      });
      await read<{ team: Room }>(response);
      await load();
    } catch (err) { setSettingsError(err instanceof Error ? err.message : 'Could not change the instrument.'); }
    finally { setAssetSaving(false); }
  }, [data, assetSaving, getApiAuthHeaders, load]);

  /**
   * The room's lifecycle: published rooms are listed in the directory, a
   * paused room keeps its history and its members but stops being listed.
   */
  const toggleRoomPublished = useCallback(async () => {
    if (!data?.team.owner) return;
    const action = data.team.status === 'PAUSED' ? 'PLAY' : 'PAUSE';
    setSettingsSaving(true); setSettingsError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id) + '/status', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action }),
      });
      await read<{ team: Room }>(response);
      await load();
    } catch (err) { setSettingsError(err instanceof Error ? err.message : 'Could not change the room status.'); }
    finally { setSettingsSaving(false); }
  }, [data, settingsSaving, getApiAuthHeaders, load]);

  const deleteRoom = useCallback(async () => {
    if (!data?.team.owner || deleteBusy) return;
    const confirmed = window.confirm('Delete this room? This permanently removes the room, its conversation and its members. This cannot be undone.');
    if (!confirmed) return;
    setDeleteBusy(true); setSettingsError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id) + '/reset', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ confirm: true }),
      });
      await read<{ success: boolean }>(response);
      window.location.href = '/#/rooms';
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Could not delete the room.');
      setDeleteBusy(false);
    }
  }, [data, deleteBusy, getApiAuthHeaders]);

  /* ------------------------------------------------------------------ */
  /* Panels                                                              */
  /* ------------------------------------------------------------------ */

  const [news, setNews] = useState<RoomNewsPayload | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const loadNews = useCallback(async (force = false) => {
    setNewsLoading(true);
    try {
      const result = await read<RoomNewsPayload>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/news' + (force ? '?refresh=1' : ''), {
        headers: { Accept: 'application/json' }, cache: 'no-store',
      }));
      setNews(result);
    } catch (error) {
      setNews({ market: marketSymbol, ok: false, error: error instanceof Error ? error.message : 'News unavailable.', fetchedAt: new Date().toISOString(), headlines: [] });
    } finally { setNewsLoading(false); }
  }, [slug, marketSymbol]);
  useEffect(() => {
    if (panel !== 'news' && panel !== 'market') return;
    void loadNews();
    const timer = window.setInterval(() => void loadNews(true), 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [panel, loadNews]);

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

  const priceDigits = marketSymbol.toUpperCase().includes('BTC') ? 2 : marketSymbol.toUpperCase().includes('ETH') ? 2 : 5;
  const quoteStatus = !quoteHasPrice(marketQuote)
    ? 'unavailable'
    : quoteIsFresh(marketQuote) && dataMode.toUpperCase() !== 'PAPER'
      ? 'live'
      : 'stale';
  const quoteStatusText = !quoteHasPrice(marketQuote)
    ? (marketError || 'Quote unavailable · waiting for provider')
    : dataMode.toUpperCase() === 'PAPER'
      ? 'Reference prices'
      : marketQuote?.stale || !quoteIsFresh(marketQuote)
        ? 'Last known price · not streaming'
        : 'Live quote · refreshes every 5 seconds';

  if (loading) return <main className="trade-room-minimal"><div className="trade-room-loading" aria-label="Loading room" /></main>;
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
          <dt><Users size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Members</span></dt>
          <dd className="trade-room-stat-value">{roomIdentity?.memberCount ?? 1}<span className="trade-room-stat-unit">members</span></dd>
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
            <span className="sg-room-symbol">{activeMarket || 'No instrument yet'}</span>
            {dataMode && <span className="sg-room-provider">{dataMode.toUpperCase() === 'DEMO_REFERENCE' ? 'REFERENCE' : dataMode.toUpperCase()}</span>}
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
            type="button"
            key={frame}
            onClick={() => setTimeframe(frame)}
            aria-pressed={timeframe === frame}
            className="sg-room-timeframe"
          >{frame}</button>)}
        </div>

        {data.team.owner && (
          <div className="sg-room-instrument-picker">
            <label htmlFor="room-instrument" className="sr-only">Instrument on this room's chart</label>
            <select
              id="room-instrument"
              value={activeMarket}
              disabled={assetsLoading || assetSaving}
              onChange={event => void changeRoomAsset(event.target.value)}
              onFocus={() => { if (!assets.length) void loadAssets(); }}
              className="sg-room-instrument-select"
            >
              {!assets.length && <option value="">{activeMarket || 'Choose an instrument…'}</option>}
              {assets.map(asset => <option key={asset.symbol} value={asset.symbol}>{asset.symbol} · {asset.name}</option>)}
            </select>
            <ChevronDown size={13} strokeWidth={2.2} aria-hidden="true" />
          </div>
        )}

        {data.team.owner && (
          <button type="button" className="sg-room-settings-button sg-room-settings-button-public" onClick={() => void openRoomSettings()} aria-label="Room settings" title="Room settings"><Settings size={14} aria-hidden="true" /><span>Settings</span></button>
        )}
      </header>
      {settingsError && <div className="sg-room-environment-notice" role="status">{settingsError}</div>}
      <div className="trade-room-chart">
        {candles.length && candlesTimeframe === timeframe ? <TradingViewLightweightChart
          candles={candles} activeQuote={marketQuote} timeframe={timeframe}
          symbol={marketSymbol} roomName={data.team.name} digits={priceDigits}
          dataMode={dataMode}
        /> : <div className="trade-room-chart-empty"><span>{marketError || (candlesTimeframe !== timeframe ? 'Loading ' + timeframe + ' candles…' : 'Waiting for candle history')}</span></div>}
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
          messages: chatMessages.length,
        }}
      />
      <div className="trade-room-stream-list">
        {panel === 'chat' && <RoomChatPanel
          messages={chatMessages}
          onSend={content => void sendChatMessage(content)}
          sending={chatSending}
          canPost={Boolean(roomIdentity?.isMember)}
          onRequestSignIn={() => { setJoinRequested(true); openAuthModal('signup'); }}
          viewerId={currentUser?.uid ?? null}
          participantCount={roomIdentity?.memberCount ?? 0}
          signedIn={signedIn}
          joinError={chatError || identityError}
        />}

        {panel === 'news' && <NewsPanel news={news} loading={newsLoading} onRefresh={() => void loadNews(true)} />}

        {panel === 'mentor' && <MentorChatPanel
          threads={mentorThreads}
          activeMemberId={mentorMemberId}
          onSelectThread={selectMentorThread}
          messages={mentorMessages}
          counterpartName={roomIdentity?.room.leader.displayName ?? 'the room leader'}
          isLeader={roomIdentity?.role === 'LEADER'}
          onSend={content => void sendMentorMessage(content)}
          sending={mentorSending}
          canPost={Boolean(roomIdentity?.isMember)}
          onJoin={() => void joinRoom()}
          onRequestSignIn={() => { setJoinRequested(true); openAuthModal('signup'); }}
          joining={joining}
          joinError={mentorError}
          viewerId={currentUser?.uid ?? null}
          loading={mentorLoading}
          signedIn={signedIn}
        />}

        {panel === 'details' && <GroupDetailsPanel
          room={roomIdentity?.room ?? null}
          members={roomIdentity?.members ?? []}
          memberCount={roomIdentity?.memberCount ?? 0}
          isMember={Boolean(roomIdentity?.isMember)}
          onJoin={() => void joinRoom()}
          onRequestSignIn={() => { setJoinRequested(true); openAuthModal('signup'); }}
          joining={joining}
          joinError={identityError}
          signedIn={signedIn}
        />}

        {panel === 'broker' && <ConnectBrokerPanel
          state={broker}
          loading={brokerLoading}
          error={brokerError}
          onOpenSettings={openBrokerSettings}
        />}

        {panel === 'market' && <MarketPanel
          dataMode={dataMode} asset={activeMarket}
          indicators={indicators} news={news}
        />}
      </div>
    </aside>
    {settingsOpen && <div className="tr-room-settings-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !settingsSaving) setSettingsOpen(false); }}>
      <section className="tr-room-settings" role="dialog" aria-modal="true" aria-labelledby="tr-room-settings-title">
        <header className="tr-room-settings-head"><div><p className="tr-room-settings-eyebrow">ROOM CONTROL</p><h2 id="tr-room-settings-title">Settings</h2><p>Your room, its description, who can see it and what it looks at.</p></div><button type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={17} /></button></header>
        <div className="tr-room-settings-body">
          {!data.team.owner ? <>
            <div className="tr-room-preference-row"><div><strong>Appearance</strong><p>Choose how SIRGOAT looks on this device.</p></div><button type="button" className="tr-room-preference-toggle" onClick={toggleTheme}>{theme === 'dark' ? '☀' : '☾'}{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button></div>
          </> : <>
            <label><span>Room name</span><input maxLength={80} value={settingsName} onChange={event => setSettingsName(event.target.value)} placeholder="Name your room" /></label>
            <label><span>Room description</span><textarea rows={4} maxLength={4000} value={settingsDescription} onChange={event => setSettingsDescription(event.target.value)} placeholder="What do you trade, and what do you want from the room?" /></label>
            <div>
              <p className="tr-room-settings-label">Who can see this room</p>
              <div className="tr-room-intervals">
                <label><input type="radio" name="room-visibility" checked={settingsVisibility === 'PUBLIC'} onChange={() => setSettingsVisibility('PUBLIC')} /><span><Globe size={12} /> Listed in the directory</span></label>
                <label><input type="radio" name="room-visibility" checked={settingsVisibility === 'PRIVATE'} onChange={() => setSettingsVisibility('PRIVATE')} /><span><LockKeyhole size={12} /> Invite only</span></label>
              </div>
            </div>
            <div>
              <p className="tr-room-settings-label">Instrument on the chart</p>
              <p className="tr-room-settings-hint">Everyone in the room looks at the same market. Change it whenever you like.</p>
              <div className="tr-room-instrument-row">
                <select
                  value={activeMarket}
                  disabled={assetsLoading || assetSaving}
                  onChange={event => void changeRoomAsset(event.target.value)}
                  onFocus={() => { if (!assets.length) void loadAssets(); }}
                  aria-label="Instrument on the chart"
                >
                  {!assets.length && <option value="">{activeMarket || 'Choose an instrument…'}</option>}
                  {assets.map(asset => <option key={asset.symbol} value={asset.symbol}>{asset.symbol} · {asset.name}</option>)}
                </select>
                {assetSaving && <span className="tr-room-settings-hint">Saving…</span>}
              </div>
            </div>
            <div>
              <p className="tr-room-settings-label">In the directory</p>
              <div className="tr-room-creator-actions">
                <button type="button" className="sg-room-lifecycle-button" disabled={settingsSaving} onClick={() => void toggleRoomPublished()}>
                  {data.team.status === 'PAUSED' ? 'Publish room' : 'Pause room'}
                </button>
              </div>
              <p className="tr-room-settings-hint">A paused room keeps its conversation and its members, but stops appearing in the directory.</p>
            </div>
            <div className="tr-room-danger">
              <p className="tr-room-settings-label">Delete this room</p>
              <p className="tr-room-settings-hint">Removes the room, its conversation and its members permanently.</p>
              <button type="button" className="sg-room-lifecycle-button is-reset" disabled={deleteBusy || settingsSaving} onClick={() => void deleteRoom()}>
                <Trash2 size={13} /> {deleteBusy ? 'Deleting…' : 'Delete room'}
              </button>
            </div>
            {settingsError && <p className="tr-room-settings-error" role="alert">{settingsError}</p>}
          </>}
        </div>
        {data.team.owner && <footer className="tr-room-settings-foot"><button type="button" disabled={settingsSaving} onClick={() => setSettingsOpen(false)}>Cancel</button><button type="button" disabled={settingsSaving || !settingsName.trim()} onClick={() => void saveRoomSettings()}><Save size={14} />{settingsSaving ? 'Saving…' : 'Save changes'}</button></footer>}
      </section>
    </div>}
  </main>;
}
