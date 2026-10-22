import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, PanelRightClose, PanelRightOpen, Settings, X, Save, Trash2, Users, ChevronDown, Radio, Mic, MicOff, Square, Play, SlidersHorizontal, Video, Wifi } from 'lucide-react';
import { RoomChartPanel } from './room-chart/RoomChartPanel';
import { RoomVoiceControlsView } from './RoomVoiceControls';
import RecordingControls from './RecordingControls';
import { RoomCoverPicker } from './RoomCoverPicker';
import { RoomMembersModal } from './RoomMembersModal';
import {
  ConnectBrokerPanel, GroupDetailsPanel, MarketPanel, MentorChatPanel, NewsPanel, RoomChatPanel, RobotLogPanel, RobotChatPanel, RobotNewsReportPanel, TradeRoomSidebar,
  type BrokerConnectionState, type MentorThreadSummary, type RoomChatMessage, type RoomGroupDetails, type RoomGroupMember,
  type RoomIndicators, type RoomMember, type RoomNewsPayload, type RoomPanelId, type RoomRun, type RobotChatMessage,
} from './TradeRoomSidebar';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useRoomRealtime } from '../hooks/useRoomRealtime';
import { useRoomVoice } from '../hooks/useRoomVoice';
import { useSessionRecorder } from '../hooks/useSessionRecorder';
import type { Candle, MarketQuote } from '../types';
import type { RoomDrawing } from '../shared/roomProtocol';
import { ROOM_CATEGORIES, type RoomCategory } from '../types/rooms';

type RobotScheduleStatus = { paused: boolean; nextAnalysisAt: string | null; nextTrackerCheckAt: string | null; leaseUntilMs: number } | null;
type Member = RoomMember & { robotSchedule?: RobotScheduleStatus };
type Room = {
  id: string; owner?: boolean; slug: string; name: string; instructions?: string;
  robotKind?: 'AI_ROBOT' | 'COMMUNITY';
  monitoringIntervals?: number[];
  visibility: 'PUBLIC' | 'PRIVATE'; status: string; memberCount: number; markets: string[];
  asset?: string; provider?: string; balance?: number | null; trades?: number;
  runtimeResources?: {
    scheduler: 'firestore' | 'unavailable';
    dispatcherLastSeenAt: string | null;
    dispatcherSource: string | null;
    perRobotDurableObjects: number;
  };
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

/** One page of the room conversation, with the reader's unread state. */
type RoomChatPage = {
  messages: RoomChatMessage[];
  hasMore: boolean;
  /** The messages the reader has not seen. */
  unreadCount: number;
  /** The reader's read cursor, when they have one. */
  lastReadMessageId: string | null;
};

/** The private line between a member and the room's leader. */
type MentorChatPayload = {
  role: 'LEADER' | 'MEMBER';
  mentor: { id: string; displayName: string };
  threads: MentorThreadSummary[];
  thread: { memberId: string; memberName: string; messages: RoomChatMessage[] } | null;
};

type AssetOption = { symbol: string; name: string; category: string };

/** What the server reports about the realtime services this room can use. */
type RealtimeStatus = {
  realtime: { configured: boolean; protocolVersion: number; workerConfigured: boolean; url: string | null };
  voice: { configured: boolean; reason: string | null };
  media: { configured: boolean; maxBytes: number; allowedTypes: string[] };
};

/** The room record as the TradingVibes room API sees it. */
type RoomDetail = {
  id: string; slug: string; name: string; description: string; visibility: 'PUBLIC' | 'PRIVATE';
  category: RoomCategory; markets: string[]; chart: { symbol: string; timeframe: string };
  coverUrl: string | null; memberCount: number; role: 'OWNER' | 'LEADER' | 'MEMBER' | 'GUEST';
  voiceEnabled: boolean; allowDrawings: boolean;
  canManage: boolean; canChat: boolean; canDraw: boolean; canUseVoice: boolean; canRunSession: boolean;
  isMember: boolean; live: boolean;
};

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

export function PublicTeamView({ slug, backLabel = 'Bots', onBack = () => { window.location.href = '/#/bots'; } }: { slug: string; backLabel?: string; onBack?: () => void }) {
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
  /**
   * THE PERSONAL CHART.
   *
   * `chartSync` decides whether the room's shared chart or this viewer's own
   * chart is on screen. These two values are the personal one; they are used
   * only while sync is OFF, and they are seeded from the shared chart the
   * moment sync is switched off so the first personal frame is not a jump.
   */
  const [chartSync, setChartSync] = useState(true);
  const [personalSymbol, setPersonalSymbol] = useState('');
  const [personalTimeframe, setPersonalTimeframe] = useState('15m');
  const [robotChartTimeframe, setRobotChartTimeframe] = useState('');
  /** The collapsible chart tool strip. Closed by default: it must not cost chart height. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** Which header popover is open. Only one at a time. */
  const [headerPopover, setHeaderPopover] = useState<'voice' | 'record' | null>(null);
  /** The container of the header popovers, so an outside click can close them. */
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<RoomPanelId>('chat');
  const [streamVisible, setStreamVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [robotStatusSaving, setRobotStatusSaving] = useState(false);
  const [copyingRobot, setCopyingRobot] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsName, setSettingsName] = useState('');
  const [settingsDescription, setSettingsDescription] = useState('');
  const [settingsVisibility, setSettingsVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PRIVATE');
  const [settingsInterval, setSettingsInterval] = useState(15);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetSaving, setAssetSaving] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [roomIdentity, setRoomIdentity] = useState<RoomIdentity | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [joining, setJoining] = useState(false);
  const [chatMessages, setChatMessages] = useState<RoomChatMessage[]>([]);
  /** Whether older history exists behind the newest page. */
  const [chatHasMore, setChatHasMore] = useState(false);
  /** The unread count the chat tab badge shows. The panel owns it. */
  const [chatUnread, setChatUnread] = useState(0);
  /** Whether the roster dialog is open. */
  const [membersOpen, setMembersOpen] = useState(false);
  /**
   * WHO IS IN THE ROOM RIGHT NOW.
   *
   * The count comes from the server, which asks the room's Durable Object.
   * It is null when the server cannot establish it, and the UI says so
   * rather than inventing a number.
   */
  const [onlineCount, setOnlineCount] = useState<number | null>(null);
  /** Whether the room's leader has a live connection. */
  const [mentorOnline, setMentorOnline] = useState<boolean | null>(null);
  const [chatError, setChatError] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [mentorThreads, setMentorThreads] = useState<MentorThreadSummary[]>([]);
  const [mentorMessages, setMentorMessages] = useState<RoomChatMessage[]>([]);
  const [mentorMemberId, setMentorMemberId] = useState<string | null>(null);
  const [mentorLoading, setMentorLoading] = useState(false);
  const [mentorError, setMentorError] = useState('');
  const [mentorSending, setMentorSending] = useState(false);
  const [robotMessages, setRobotMessages] = useState<RobotChatMessage[]>([]);
  const [robotChatError, setRobotChatError] = useState('');
  const [robotChatSending, setRobotChatSending] = useState(false);
  const [broker, setBroker] = useState<BrokerConnectionState>({ cTrader: null, propDao: null });
  const [brokerLoading, setBrokerLoading] = useState(false);
  const [brokerError, setBrokerError] = useState('');
  const { currentUser, authMode, getApiAuthHeaders, openAuthModal } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const signedIn = Boolean(currentUser) || authMode === 'dev';
  const isAiRobot = data?.team.robotKind === 'AI_ROBOT';
  const robotDispatcherFresh = Boolean(data?.team.runtimeResources?.dispatcherSource === 'Cloudflare Worker' && data.team.runtimeResources.dispatcherLastSeenAt && Date.now() - Date.parse(data.team.runtimeResources.dispatcherLastSeenAt) < 12 * 60_000);
  const robotStateLabel = data?.team.status === 'PAUSED' ? 'Stopped' : data?.team.status === 'PARTIAL' || !robotDispatcherFresh ? 'Needs attention' : 'Running';

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

  /* ------------------------------------------------------------------ */
  /* The live room                                                        */
  /*                                                                      */
  /* A room, a membership and a live session are three different things.  */
  /* The room exists whether or not anyone is in it. The membership says  */
  /* who may read it. The session is a bounded live episode with a start   */
  /* and an end. The UI keeps them apart: the room is always here, the    */
  /* session badge appears only while a session is actually running.     */
  /* ------------------------------------------------------------------ */

  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus | null>(null);
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [settingsCategory, setSettingsCategory] = useState<RoomCategory>('general');
  const [settingsVoiceEnabled, setSettingsVoiceEnabled] = useState(true);
  const [settingsAllowDrawings, setSettingsAllowDrawings] = useState(true);
  const [settingsCover, setSettingsCover] = useState<string | null>(null);
  const [sessionRecording, setSessionRecording] = useState(false);


  const roomId = data?.team.id ?? null;
  const viewerName = currentUser?.displayName?.trim() || 'Member';

  const createPersonalRobot = useCallback(async () => {
    if (!signedIn) { openAuthModal('signup'); return; }
    if (!data?.team.slug || copyingRobot) return;
    setCopyingRobot(true); setCopyError('');
    try {
      const response = await fetch(`/api/team-rooms/${encodeURIComponent(data.team.slug)}/copy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await optionalAuthHeaders()) }, body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Could not create your personal robot.');
      window.location.assign(body.shareUrl);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : 'Could not create your personal robot.');
    } finally { setCopyingRobot(false); }
  }, [signedIn, openAuthModal, data?.team.slug, copyingRobot, optionalAuthHeaders]);

  /**
   * What the server can actually do.
   *
   * The realtime status is fetched once. It is what lets the room say
   * "voice is not configured on this server" instead of offering a button
   * that silently fails.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await read<RealtimeStatus>(await fetch('/api/realtime/status', {
          headers: { Accept: 'application/json' }, cache: 'no-store',
        }));
        if (!cancelled) setRealtimeStatus(result);
      } catch {
        if (!cancelled) setRealtimeStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** The room as the TradingVibes room API sees it: cover, role, permissions. */
  const loadRoomDetail = useCallback(async () => {
    if (!roomId) return;
    try {
      const result = await read<{ room: RoomDetail }>(await fetch('/api/rooms/' + encodeURIComponent(roomId), {
        headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) }, cache: 'no-store',
      }));
      setRoomDetail(result.room);
    } catch {
      // A private room the viewer has not joined has no detail view. The
      // legacy payload still renders the room shell.
      setRoomDetail(null);
    }
  }, [roomId, optionalAuthHeaders]);

  useEffect(() => { void loadRoomDetail(); }, [loadRoomDetail]);

  /**
   * A HEADER POPOVER CLOSES THE WAY POPOVERS CLOSE.
   *
   * An outside click or Escape dismisses it. It does NOT change anything
   * about the voice session or the recording: those are owned by the hooks
   * in this component, so closing the panel never ends them.
   */
  useEffect(() => {
    if (!headerPopover) return;
    const onPointer = (event: MouseEvent) => {
      if (headerActionsRef.current && !headerActionsRef.current.contains(event.target as Node)) {
        setHeaderPopover(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeaderPopover(null);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [headerPopover]);

  const realtime = useRoomRealtime({
    roomId,
    enabled: !isAiRobot && Boolean(roomId) && signedIn && realtimeStatus?.realtime.configured === true,
    workerUrl: realtimeStatus?.realtime.url ?? null,
    displayName: viewerName,
  });

  const canManageRoom = Boolean(roomDetail?.canManage ?? data?.team.owner);
  const canDrawRoom = Boolean(roomDetail?.canDraw ?? roomIdentity?.isMember);

  /**
   * THE SHARED CHART AND THE PERSONAL CHART
   * ----------------------------------------
   * `sharedSymbol` / `sharedTimeframe` are what the ROOM is on.
   * `activeMarket` / `activeTimeframe` are what THIS VIEWER is looking at,
   * which is the shared pair while Chart Sync is on and the viewer's own
   * pair while it is off.
   */
  const sharedSymbol =
    (realtime.connected && realtime.symbol) ||
    roomDetail?.chart.symbol ||
    data?.team.asset ||
    '';
  const sharedTimeframe =
    (realtime.connected && realtime.timeframe) || roomDetail?.chart.timeframe || '15m';

  const activeMarket = isAiRobot ? (data?.team.asset || sharedSymbol) : chartSync ? sharedSymbol : (personalSymbol || sharedSymbol);
  const activeTimeframe = isAiRobot
    ? (robotChartTimeframe || data?.members[0]?.timeframe || sharedTimeframe)
    : chartSync ? sharedTimeframe : personalTimeframe;


  /**
   * CHART SYNC, AND WHAT IT ACTUALLY MEANS RIGHT NOW.
   *
   * The toggle is never allowed to lie. If the realtime coordinator is not
   * connected — because the Worker is not deployed, because the socket is
   * reconnecting, or because the member is not signed in — the state says
   * SYNC UNAVAILABLE, not SYNCED.
   */
  const realtimeReady = realtime.connected && realtimeStatus?.realtime.configured === true;
  const syncState: 'synced' | 'personal' | 'unavailable' = !chartSync
    ? 'personal'
    : realtimeReady
      ? 'synced'
      : 'unavailable';
  const syncStateLabel =
    syncState === 'synced' ? 'SYNCED WITH ROOM'
      : syncState === 'personal' ? 'PERSONAL VIEW'
        : 'SYNC UNAVAILABLE';
  const syncExplanation =
    syncState === 'synced'
      ? 'You are following the room’s shared chart. Turn sync off to look at your own instrument and timeframe.'
      : syncState === 'personal'
        ? 'You are looking at your own chart. Nothing you change here is shared with the room, and you stay a member.'
        : realtimeStatus && !realtimeStatus.realtime.configured
          ? 'Live sync is not configured on this server, so the room’s shared chart is unavailable. You can still use your own chart.'
          : 'The room’s live connection is not established, so the shared chart cannot be followed right now.';

  /**
   * SWITCHING SYNC ON AND OFF.
   *
   * Turning sync OFF starts from where the shared chart is RIGHT NOW, so
   * the first personal frame is a continuation rather than a jump. Turning
   * it back ON returns to the room's chart immediately.
   */
  const toggleChartSync = useCallback((next: boolean) => {
    if (!next) {
      setPersonalSymbol(sharedSymbol);
      setPersonalTimeframe(sharedTimeframe);
    }
    setChartSync(next);
  }, [sharedSymbol, sharedTimeframe]);

  const voice = useRoomVoice({
    roomId,
    displayName: viewerName,
    canUseVoice: Boolean(roomDetail?.canUseVoice ?? roomIdentity?.isMember),
    onSpeakingChange: (speaking) => realtime.setSpeaking(speaking),
  });

  const recorder = useSessionRecorder({
    roomName: data?.team.name,
    onRecordingChange: (recording) => setSessionRecording(recording),
  });



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
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, isAiRobot ? 30000 : 15000);
    return () => window.clearInterval(interval);
  }, [load, isAiRobot]);

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

  /**
   * THE ROOM CONVERSATION.
   *
   * The room-id route is used rather than the legacy slug route because it
   * also answers with the two things a messaging panel needs: how many
   * messages are UNREAD, and where this reader's cursor is. The panel owns
   * the cursor and the unread count from there.
   */
  const loadChat = useCallback(async (incremental: boolean) => {
    if (!roomIdentity?.isMember || !roomId) return;
    try {
      const cursor = incremental ? chatCursor.current : null;
      const query = cursor ? '?since=' + encodeURIComponent(cursor) : '';
      const result = await read<RoomChatPage>(await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/chat' + query, {
        headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) }, cache: 'no-store',
      }));
      const previous = chatMessagesRef.current;
      const merged = cursor
        ? [...previous, ...result.messages.filter(message => !previous.some(existing => existing.id === message.id))]
        : result.messages;
      applyChatMessages(merged);
      chatCursor.current = merged.length ? merged[merged.length - 1].createdAt : null;
      if (!incremental) {
        setChatHasMore(Boolean(result.hasMore));
        setChatUnread(result.unreadCount ?? 0);
      }
      setChatError('');
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'The room conversation is unavailable.');
    }
  }, [roomId, roomIdentity?.isMember, optionalAuthHeaders, applyChatMessages]);

  useEffect(() => {
    if (isAiRobot || panel !== 'chat' || !roomIdentity?.isMember) return;
    chatCursor.current = null;
    void loadChat(false);
    const timer = window.setInterval(() => void loadChat(true), 5000);
    return () => window.clearInterval(timer);
  }, [isAiRobot, panel, roomIdentity?.isMember, loadChat]);

  /**
   * THE ROOM'S PRESENCE.
   *
   * Polled from the server, which owns the truth (the Durable Object knows
   * who is connected). The client never counts its own sockets and never
   * invents an online state.
   */
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    const loadPresence = async () => {
      try {
        const result = await read<{ onlineCount: number | null; mentorOnline: boolean | null }>(
          await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/presence', {
            headers: { Accept: 'application/json', ...(await optionalAuthHeaders()) },
            cache: 'no-store',
          }),
        );
        if (cancelled) return;
        setOnlineCount(result.onlineCount ?? null);
        setMentorOnline(result.mentorOnline ?? null);
      } catch {
        /* The presence is a nicety: a failure leaves the last known state. */
      }
    };
    void loadPresence();
    const timer = window.setInterval(() => void loadPresence(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [roomId, optionalAuthHeaders]);

  const sendChatMessage = useCallback(async (content: string) => {
    setChatSending(true); setChatError('');
    try {
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const result = await read<{ message: RoomChatMessage }>(await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/chat', {
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
  }, [roomId, getApiAuthHeaders, applyChatMessages]);

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
    if (panel !== 'mentor' || isAiRobot || !roomIdentity?.isMember) return;
    void loadMentorChat(mentorSelection.current);
    const timer = window.setInterval(() => void loadMentorChat(mentorSelection.current), 8000);
    return () => window.clearInterval(timer);
  }, [panel, isAiRobot, roomIdentity?.isMember, loadMentorChat]);

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
    window.location.assign('/robots/#/settings?section=' + section);
  }, []);

  /* ------------------------------------------------------------------ */
  /* The chart                                                            */
  /* ------------------------------------------------------------------ */

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
          encodeURIComponent(activeMarket) + '&timeframe=' + encodeURIComponent(activeTimeframe) +
          '&count=' + (ROOM_TIMEFRAME_BARS[activeTimeframe] ?? 300);
        const result = await read<MarketPayload>(await fetch(url, {
          headers: { Accept: 'application/json' }, cache: 'no-store',
        }));
        if (cancelled) return;
        const quote = result.quotes?.find(item => item.symbol === activeMarket) ?? result.quotes?.[0] ?? null;
        const nextCandles = Array.isArray(result.candles) ? result.candles : [];
        setMarketSymbol(activeMarket);
        setMarketQuote(quote);
        setCandles(nextCandles);
        setCandlesTimeframe(activeTimeframe);
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
  }, [slug, activeMarket, activeTimeframe]);

  /* ------------------------------------------------------------------ */
  /* The live session                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Starting and ending a session is a SERVER decision.
   *
   * The button is hidden from members, but hiding it is only presentation:
   * the server re-checks the caller's role and refuses the transition. The
   * client never flips a local "live" flag to make the room look live.
   */
  const runSession = useCallback(async (action: 'start' | 'end') => {
    if (!roomId || sessionBusy) return;
    setSessionBusy(true); setSessionError('');
    try {
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      await read(await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/session', {
        method: 'POST', headers, body: JSON.stringify({ action, symbol: activeMarket, timeframe: activeTimeframe }),
      }));
      await loadRoomDetail();
      realtime.requestState();
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Could not change the live session.');
    } finally {
      setSessionBusy(false);
    }
  }, [roomId, sessionBusy, getApiAuthHeaders, loadRoomDetail, realtime, activeMarket, activeTimeframe]);

  /**
   * The live session, as the coordinator reports it.
   *
   * `null` means "no session is running". A room with no session is a
   * perfectly normal room, and the UI says so rather than showing a stale
   * "live" badge.
   */
  const liveSession = realtime.session;

  /* ------------------------------------------------------------------ */
  /* Owner controls                                                       */
  /* ------------------------------------------------------------------ */

  const openRoomSettings = useCallback(async () => {
    if (!data) return;
    setSettingsError('');
    setSettingsOpen(true);
    if (!canManageRoom) return;
    setSettingsName(data.team.name);
    setSettingsDescription(data.team.instructions ?? '');
    setSettingsVisibility(data.team.visibility ?? 'PRIVATE');
    setSettingsInterval(data.team.monitoringIntervals?.[0] ?? 15);
    setSettingsCategory(roomDetail?.category ?? 'general');
    setSettingsVoiceEnabled(roomDetail?.voiceEnabled !== false);
    setSettingsAllowDrawings(roomDetail?.allowDrawings !== false);
    setSettingsCover(roomDetail?.coverUrl ?? null);
    await loadRoomDetail();
  }, [data, canManageRoom, roomDetail, loadRoomDetail]);

  const saveRoomSettings = useCallback(async () => {
    if (!data?.team.id || !canManageRoom || settingsSaving) return;
    if (!settingsName.trim()) { setSettingsError('Room name cannot be empty.'); return; }
    setSettingsSaving(true); setSettingsError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/rooms/' + encodeURIComponent(data.team.id), {
        method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          name: settingsName.trim(),
          description: settingsDescription,
          ...(!isAiRobot ? { visibility: settingsVisibility } : {}),
          category: settingsCategory,
          voiceEnabled: settingsVoiceEnabled,
          allowDrawings: settingsAllowDrawings,
          ...(data.team.robotKind === 'AI_ROBOT' ? { monitoringIntervals: [settingsInterval] } : {}),
        }),
      });
      await read<{ room: RoomDetail }>(response);
      setSettingsOpen(false);
      await load();
      await loadRoomDetail();
    } catch (err) { setSettingsError(err instanceof Error ? err.message : 'Could not save the room settings.'); }
    finally { setSettingsSaving(false); }
  }, [data, canManageRoom, isAiRobot, settingsSaving, settingsName, settingsDescription, settingsVisibility, settingsCategory, settingsVoiceEnabled, settingsAllowDrawings, settingsInterval, getApiAuthHeaders, load, loadRoomDetail]);

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
    if (!data?.team.owner || robotStatusSaving) return;
    const action = data.team.status === 'PAUSED' ? 'PLAY' : 'PAUSE';
    setRobotStatusSaving(true); setSettingsError('');
    try {
      const authHeaders = await getApiAuthHeaders();
      const response = await fetch('/api/goat-teams/' + encodeURIComponent(data.team.id) + '/status', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action }),
      });
      await read<{ team: Room }>(response);
      await load();
    } catch (err) { setSettingsError(err instanceof Error ? err.message : 'Could not change the room status.'); }
    finally { setRobotStatusSaving(false); }
  }, [data, robotStatusSaving, getApiAuthHeaders, load]);

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
      window.location.href = '/#/bots';
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
    if (panel !== 'market' && (panel !== 'news' || isAiRobot)) return;
    void loadNews();
    const timer = window.setInterval(() => void loadNews(true), 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [panel, isAiRobot, loadNews]);

  const askRobot = useCallback(async (question: string, includeAccountBalance = false) => {
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
    for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
    return read<{ answer: string; chatHistory: RobotChatMessage[] }>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/robot-chat', {
      method: 'POST', headers, body: JSON.stringify({ question, includeAccountBalance }), cache: 'no-store',
    }));
  }, [slug, getApiAuthHeaders]);

  useEffect(() => {
    if (!isAiRobot || !signedIn) { setRobotMessages([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const headers = new Headers({ Accept: 'application/json' });
        for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
        const result = await read<{ messages: RobotChatMessage[] }>(await fetch('/api/team-rooms/' + encodeURIComponent(slug) + '/robot-chat', { headers, cache: 'no-store' }));
        if (!cancelled) setRobotMessages(result.messages);
      } catch (cause) { if (!cancelled) setRobotChatError(cause instanceof Error ? cause.message : 'Could not load chat history.'); }
    })();
    return () => { cancelled = true; };
  }, [isAiRobot, signedIn, slug, getApiAuthHeaders]);

  const sendRobotQuestion = useCallback(async (question: string, includeAccountBalance: boolean) => {
    setRobotChatSending(true); setRobotChatError('');
    try {
      const answer = await askRobot(question, includeAccountBalance);
      setRobotMessages(answer.chatHistory);
      return true;
    } catch (err) { setRobotChatError(err instanceof Error ? err.message : 'The robot could not answer right now.'); return false; }
    finally { setRobotChatSending(false); }
  }, [askRobot]);

  /**
   * A one-second clock, started at mount so the first paint already has the
   * real time instead of a placeholder that pops a frame later.
   */
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  /**
   * THE ROOM CLOCK.
   *
   * The time is UTC, and it is labelled as such. A trading room is a
   * global room: "20:05" is ambiguous in a way that "20:05 UTC" is not,
   * and two members comparing clocks should be comparing the same clock.
   *
   * The interval only writes the clock, so the header does not re-render
   * every second.
   */
  const roomClock = useMemo(
    () => clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }),
    [clock],
  );

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
    {/**
     * THE NAVIGATION ROW.
     *
     * One row: where you came from, whose room this is, the room's clock and
     * head count, the room-level actions (voice, recording, the live
     * session) and the chat toggle. Nothing here belongs to the chart, and
     * nothing here is duplicated below.
     */}
    <div className="trade-room-topbar">
      <button type="button" className="trade-room-back" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={2.5} aria-hidden="true" />
        <span>Back<span className="trade-room-back-target"> to {backLabel}</span></span>
      </button>
      <div className="trade-room-identity">
        <span className="trade-room-identity-name">{data.team.name}</span>
        {isAiRobot && <span className={'trade-room-robot-state ' + (robotStateLabel === 'Running' ? 'is-running' : 'is-stopped')} role="status" title={robotStateLabel === 'Needs attention' ? 'There is no recent Cloudflare Worker heartbeat. Scheduled analysis may not run.' : undefined}>
          <span aria-hidden="true" />{robotStateLabel}
        </span>}
        {/**
         * THE MENTOR'S AVAILABILITY.
         *
         * It is a NETWORK fact, not a session fact: the leader is online
         * when they hold a live connection, whether or not anybody has
         * started a session. A member can open the room and read the
         * conversation either way, so this is information, never a gate.
         */}
        {!isAiRobot && mentorOnline !== null && (
          <span
            className={'trade-room-mentor ' + (mentorOnline ? 'is-online' : 'is-offline')}
            title={
              mentorOnline
                ? 'The room leader is online.'
                : 'The room leader is offline. You can still read and post in the room.'
            }
          >
            {mentorOnline ? 'Mentor online' : 'Mentor offline'}
          </span>
        )}
        {!isAiRobot && liveSession && (
          <span className="trade-room-live-badge" role="status">
            <Radio size={11} strokeWidth={2.6} aria-hidden="true" />
            Live session
          </span>
        )}
        {!isAiRobot && sessionRecording && (
          <span className="trade-room-rec-badge" role="status">
            <span className="trade-room-recording-dot" aria-hidden="true" />
            REC
          </span>
        )}
        {roomDetail?.coverUrl && (
          <span
            className="trade-room-cover-thumb"
            style={{ backgroundImage: `url(${roomDetail.coverUrl})` }}
            aria-hidden="true"
          />
        )}
      </div>
      {/**
       * THE ROOM'S FIGURES.
       *
       * Three numbers, each measuring exactly one thing:
       *   MEMBERS  how many people have joined the room
       *   ONLINE   how many of them hold a live connection right now
       *   CLOCK    the room's UTC time
       *
       * The old "connected now" figure duplicated the online count, so it
       * is gone. The online count is null when the server cannot establish
       * it, and it is shown as "—" rather than as zero: nobody being here
       * and not knowing are different facts.
       */}
      <dl className="trade-room-stats">
        <div className="trade-room-stat trade-room-stat-clock">
          <dt><Clock size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Room clock (UTC)</span></dt>
          <dd className="trade-room-stat-value">
            {roomClock}
            <span className="trade-room-stat-unit">UTC</span>
          </dd>
        </div>
        <button
          type="button"
          className="trade-room-stat trade-room-stat-button"
          onClick={() => setMembersOpen(true)}
          aria-haspopup="dialog"
          title="Who is in this room"
        >
          <dt><Users size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Members</span></dt>
          <dd className="trade-room-stat-value">{roomIdentity?.memberCount ?? 1}<span className="trade-room-stat-unit">members</span></dd>
        </button>
        <button
          type="button"
          className="trade-room-stat trade-room-stat-button"
          onClick={() => setMembersOpen(true)}
          aria-haspopup="dialog"
          title="Who is online in this room"
        >
          <dt><Wifi size={12} strokeWidth={2.2} aria-hidden="true" /><span className="sr-only">Online now</span></dt>
          <dd className="trade-room-stat-value">
            {onlineCount === null ? '—' : onlineCount}
            <span className="trade-room-stat-unit">online</span>
          </dd>
        </button>
      </dl>

      <div className="trade-room-topbar-actions" ref={headerActionsRef}>
        {isAiRobot && data.team.owner && <button
          type="button"
          className={'sg-room-session-button sg-room-robot-toggle' + (data.team.status === 'PAUSED' ? ' is-play' : ' is-live')}
          onClick={() => void toggleRoomPublished()}
          disabled={robotStatusSaving}
          aria-label={data.team.status === 'PAUSED' ? 'Play robot' : 'Stop robot'}
          aria-pressed={data.team.status !== 'PAUSED'}
          title={data.team.status === 'PAUSED' ? 'Resume scheduled AI analysis' : 'Stop scheduled AI analysis'}
        >
          {data.team.status === 'PAUSED' ? <Play size={12} fill="currentColor" aria-hidden="true" /> : <Square size={12} fill="currentColor" aria-hidden="true" />}
          {robotStatusSaving ? 'Updating…' : data.team.status === 'PAUSED' ? 'Play robot' : 'Stop robot'}
        </button>}
        {data.team.robotKind === 'AI_ROBOT' && <button type="button" className="sg-room-session-button" onClick={() => void createPersonalRobot()} disabled={copyingRobot} title="Create your own independently running copy, using your own account settings">
          {copyingRobot ? 'Starting your copy…' : 'Run your own copy'}
        </button>}
        {!isAiRobot && canManageRoom && (
          <div className="sg-room-session-controls" role="group" aria-label="Live session">
            {liveSession ? (
              <button
                type="button"
                className="sg-room-session-button is-live"
                onClick={() => void runSession('end')}
                disabled={sessionBusy}
              >
                <Square size={12} strokeWidth={2.6} aria-hidden="true" />
                {sessionBusy ? 'Ending…' : 'End session'}
              </button>
            ) : (
              <button
                type="button"
                className="sg-room-session-button"
                onClick={() => void runSession('start')}
                disabled={sessionBusy}
              >
                <Radio size={12} strokeWidth={2.6} aria-hidden="true" />
                {sessionBusy ? 'Starting…' : 'Start session'}
              </button>
            )}
          </div>
        )}

        {/**
         * VOICE.
         *
         * The microphone button opens the existing voice controls. It does
         * NOT join the voice session on the first click: joining asks for
         * the microphone, and that deserves its own explicit action inside
         * the panel.
         *
         * The hook lives in this component, not in the popover, so closing
         * the popover never takes the voice session down with it.
         */}
        {!isAiRobot && <div className="trade-room-popover-wrap">
          <button
            type="button"
            className={'trade-room-icon-button' + (voice.inVoice ? (voice.muted ? ' is-muted' : ' is-live') : '')}
            onClick={() => setHeaderPopover(current => (current === 'voice' ? null : 'voice'))}
            aria-expanded={headerPopover === 'voice'}
            aria-haspopup="dialog"
            title={voice.inVoice ? (voice.muted ? 'You are in voice, muted' : 'You are live in voice') : 'Room voice'}
            aria-label={voice.inVoice ? (voice.muted ? 'Room voice — muted' : 'Room voice — live') : 'Room voice'}
          >
            {/**
             * The icon says whether you are IN voice, and the dot says
             * whether your microphone is live. A crossed-out microphone for
             * somebody who never joined would be a lie about their state.
             */}
            {voice.inVoice && voice.muted
              ? <MicOff size={15} strokeWidth={2.2} aria-hidden="true" />
              : <Mic size={15} strokeWidth={2.2} aria-hidden="true" />}
            <span className="trade-room-icon-state" data-state={voice.inVoice ? (voice.muted ? 'muted' : 'live') : 'idle'} aria-hidden="true" />
          </button>
          {headerPopover === 'voice' && (
            <div className="trade-room-popover" role="dialog" aria-label="Room voice">
              <RoomVoiceControlsView
                voice={voice}
                currentUid={currentUser?.uid ?? null}
                canUseVoice={Boolean(roomDetail?.canUseVoice ?? roomIdentity?.isMember)}
              />
            </div>
          )}
        </div>}

        {/**
         * RECORDING.
         *
         * The icon opens the recording panel. It does not start a recording
         * by itself: starting one opens the browser's own screen-capture
         * picker, and that has to be a deliberate click on "Record".
         */}
        {!isAiRobot && canManageRoom && (
          <div className="trade-room-popover-wrap">
            <button
              type="button"
              className={'trade-room-icon-button' + (recorder.recording ? ' is-recording' : '')}
              onClick={() => setHeaderPopover(current => (current === 'record' ? null : 'record'))}
              aria-expanded={headerPopover === 'record'}
              aria-haspopup="dialog"
              title={recorder.recording ? 'Recording this session' : 'Record this session'}
              aria-label={recorder.recording ? 'Session recording — recording' : 'Session recording'}
            >
              {recorder.recording
                ? <span className="trade-room-recording-dot" aria-hidden="true" />
                : <Video size={15} strokeWidth={2.2} aria-hidden="true" />}
            </button>
            {headerPopover === 'record' && (
              <div className="trade-room-popover" role="dialog" aria-label="Session recording">
                <RecordingControls recorder={recorder} canRecord />
              </div>
            )}
          </div>
        )}

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
    </div>
    <section className="trade-room-stage" aria-label="Market chart">
      {/**
       * THE ASSET AND CONTROL HEADER.
       *
       * The asset symbol and the live price live here and ONLY here — the
       * chart panel used to repeat them, and the timeframe used to exist in
       * two places. One symbol, one price, one timeframe selector.
       */}
      <header className="sg-room-header">
        <div className="sg-room-instrument">
          <div className="sg-room-symbol-line">
            <span className="sg-room-symbol">{activeMarket || 'No instrument yet'}</span>
            {dataMode && <span className="sg-room-provider">{dataMode.toUpperCase() === 'DEMO_REFERENCE' ? 'REFERENCE' : dataMode.toUpperCase()}</span>}
            {!isAiRobot && chartSync && realtime.connected && (
              <span className="sg-room-shared-tag" title="This chart is the room's shared chart">
                SHARED
              </span>
            )}
          </div>
          <div className="sg-room-price-row">
            <span className="sg-room-price">{quoteHasPrice(marketQuote) ? formatPrice(marketQuote!.mid, priceDigits) : '—'}</span>
            <span className={'sg-room-quote' + (quoteStatus === 'live' ? ' is-live' : quoteStatus === 'stale' ? ' is-stale' : ' is-unavailable')}>
              {quoteStatus === 'live' && <span className="sg-room-quote-dot" aria-hidden="true" />}
              <span className="sr-only">{quoteStatus === 'live' ? 'Live quote. ' : 'Quote status. '}</span>
              {quoteStatus === 'live' ? 'refreshes every 5 seconds' : quoteStatusText}
            </span>
          </div>
        </div>

        <div className="sg-room-controls">
          <div className="sg-room-timeframes" role="group" aria-label="Chart timeframe">
            {ROOM_CHART_TIMEFRAMES.map(frame => <button
              type="button"
              key={frame}
              onClick={() => {
                if (isAiRobot) {
                  setRobotChartTimeframe(frame);
                  return;
                }
                if (chartSync) {
                  // A leader's timeframe is the ROOM's timeframe, so it is
                  // broadcast. A follower follows it.
                  if (canManageRoom) realtime.setTimeframe(frame);
                  return;
                }
                // Sync off: this is the viewer's own timeframe and it goes
                // to nobody else.
                setPersonalTimeframe(frame);
              }}
              disabled={!isAiRobot && chartSync && !canManageRoom}
              aria-pressed={activeTimeframe === frame}
              className="sg-room-timeframe"
            >{frame}</button>)}
          </div>

          {/**
           * CHART SYNC.
           *
           * ON  — the viewer follows the room: the leader's asset, the
           *        leader's timeframe and the room's drawings. The viewer
           *        cannot change the shared chart.
           * OFF — the viewer keeps their OWN asset, timeframe and drawings.
           *        Nothing they do reaches the room, and they stay a member:
           *        chat and voice are untouched.
           *
           * It is a local viewing preference, not a way around the room's
           * permissions: the shared chart is still guarded by the server.
           */}
          {!isAiRobot && <button
            type="button"
            className={'sg-room-sync' + (chartSync ? ' is-on' : ' is-off')}
            onClick={() => toggleChartSync(!chartSync)}
            aria-pressed={chartSync}
            title={syncExplanation}
          >
            <span className="sg-room-sync-dot" data-state={syncState} aria-hidden="true" />
            <span className="sg-room-sync-label">Chart Sync</span>
            <span className="sg-room-sync-state">{syncStateLabel}</span>
          </button>}

          <button
            type="button"
            className={'sg-room-tools-button' + (toolsOpen ? ' is-open' : '')}
            onClick={() => setToolsOpen(open => !open)}
            aria-expanded={toolsOpen}
            aria-controls="room-chart-tools"
            title="Chart tools and indicators"
          >
            <SlidersHorizontal size={13} strokeWidth={2.2} aria-hidden="true" />
            <span>Tools</span>
          </button>

          {/**
           * THE ASSET PICKER.
           *
           * With sync ON it changes the ROOM's instrument, and only a
           * leader may do that. With sync OFF it changes the viewer's own
           * instrument, which anybody may do for themselves.
           */}
          {!isAiRobot && (chartSync ? canManageRoom : signedIn) && (
            <div className="sg-room-instrument-picker">
              <label htmlFor="room-instrument" className="sr-only">
                {chartSync ? 'Instrument on this room’s chart' : 'Instrument on your chart'}
              </label>
              <select
                id="room-instrument"
                value={activeMarket}
                disabled={assetsLoading || assetSaving}
                onChange={event => {
                  const next = event.target.value;
                  if (!next) return;
                  if (chartSync) void changeRoomAsset(next);
                  else setPersonalSymbol(next);
                }}
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
            <button type="button" className="sg-room-settings-button sg-room-settings-button-public" onClick={() => void openRoomSettings()} aria-label={isAiRobot ? 'Robot settings' : 'Room settings'} title={isAiRobot ? 'Robot settings' : 'Room settings'}><Settings size={14} aria-hidden="true" /><span>Settings</span></button>
          )}
        </div>
      </header>
      {settingsError && <div className="sg-room-environment-notice" role="status">{settingsError}</div>}
      {sessionError && <div className="sg-room-environment-notice" role="alert">{sessionError}</div>}
      <div className="trade-room-chart">
        {candles.length && candlesTimeframe === activeTimeframe ? <RoomChartPanel
          candles={candles}
          activeQuote={marketQuote}
          timeframe={activeTimeframe}
          symbol={activeMarket}
          roomName={data.team.name}
          digits={priceDigits}
          dataMode={dataMode}
          chartMode={!isAiRobot && chartSync ? 'shared' : 'local'}
          canManageChart={!isAiRobot && canManageRoom}
          canDraw={!isAiRobot && (chartSync ? canManageRoom : canDrawRoom)}
          drawings={!isAiRobot && chartSync ? realtime.drawings : []}
          onDrawingCreate={!isAiRobot && chartSync ? realtime.createDrawing : undefined}
          onDrawingUpdate={!isAiRobot && chartSync ? realtime.updateDrawing : undefined}
          onDrawingRemove={!isAiRobot && chartSync ? realtime.removeDrawing : undefined}
          onDrawingsClear={!isAiRobot && chartSync ? realtime.clearDrawings : undefined}
          toolsOpen={toolsOpen}
          roomId={data.team.id}
          userId={currentUser?.uid}
          userName={viewerName}
        /> : <div className="trade-room-chart-empty"><span>{marketError || (candlesTimeframe !== activeTimeframe ? 'Loading ' + activeTimeframe + ' candles…' : 'Waiting for candle history')}</span></div>}
      </div>
    </section>
    <aside id="trade-room-stream" className="trade-room-stream" aria-label="Room control panel" aria-hidden={!streamVisible}>
      {copyError && <div role="alert" className="sg-room-environment-notice">{copyError}</div>}
      <TradeRoomSidebar
        panel={panel}
        onPanelChange={setPanel}
        status={quoteStatus}
        statusTitle={quoteStatusText}
        robotMode={Boolean(isAiRobot)}
        badges={{
          news: isAiRobot ? 0 : news?.headlines.length ?? 0,
          /**
           * The UNREAD count, not the number of loaded messages. The badge
           * used to show every message the panel had ever held, so it grew
           * with the conversation and never went away.
           */
          messages: isAiRobot ? 0 : chatUnread,
        }}
      />
      <div className="trade-room-stream-list">
        {panel === 'chat' && isAiRobot && <RobotLogPanel runs={data.members.flatMap(member => member.runs)} />}

        {panel === 'chat' && !isAiRobot && <RoomChatPanel
          messages={chatMessages}
          analysisRuns={data.members.flatMap(member => member.runs).sort((left, right) => left.at.localeCompare(right.at)) as RoomRun[]}
          onSend={content => void sendChatMessage(content)}
          sending={chatSending}
          canPost={Boolean(roomIdentity?.isMember)}
          onRequestSignIn={() => { setJoinRequested(true); openAuthModal('signup'); }}
          viewerId={currentUser?.uid ?? null}
          participantCount={roomIdentity?.memberCount ?? 0}
          signedIn={signedIn}
          joinError={chatError || identityError}
          roomId={roomId}
          hasMore={chatHasMore}
          initialUnreadCount={chatUnread}
          onUnreadCountChange={setChatUnread}
        />}

        {panel === 'news' && isAiRobot && <RobotNewsReportPanel market={activeMarket} run={data.members.flatMap(member => member.runs).filter(run => run.analysis).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null} />}
        {panel === 'news' && !isAiRobot && <NewsPanel news={news} loading={newsLoading} onRefresh={() => void loadNews(true)} />}

        {panel === 'mentor' && isAiRobot && <RobotChatPanel
          messages={robotMessages}
          onSend={sendRobotQuestion}
          sending={robotChatSending}
          signedIn={signedIn}
          onRequestSignIn={() => openAuthModal('signup')}
          error={robotChatError}
        />}

        {panel === 'mentor' && !isAiRobot && <MentorChatPanel
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
          robotMode={Boolean(isAiRobot)}
          reviewIntervals={data.team.monitoringIntervals ?? [15]}
          robotStatus={data.team.status}
          robotSchedule={data.members[0]?.robotSchedule ?? null}
          runtimeResources={data.team.runtimeResources ?? null}
          latestRun={data.members.flatMap(member => member.runs).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null}
          recentRuns={data.members.flatMap(member => member.runs).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))}
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
    {membersOpen && (
      <RoomMembersModal
        roomId={roomId}
        canViewRoster={Boolean(roomIdentity?.isMember)}
        viewerId={currentUser?.uid ?? null}
        onClose={() => setMembersOpen(false)}
      />
    )}
    {settingsOpen && <div className="tr-room-settings-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !settingsSaving) setSettingsOpen(false); }}>
      <section className="tr-room-settings" role="dialog" aria-modal="true" aria-labelledby="tr-room-settings-title">
        <header className="tr-room-settings-head"><div><p className="tr-room-settings-eyebrow">{isAiRobot ? 'ROBOT CONTROL' : 'ROOM CONTROL'}</p><h2 id="tr-room-settings-title">{isAiRobot ? 'Robot settings' : 'Settings'}</h2><p>{isAiRobot ? 'Manage the robot, its cover, schedule and market.' : 'Your room, its description, who can see it and what it looks at.'}</p></div><button type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={17} /></button></header>
        <div className="tr-room-settings-body">
          {!canManageRoom ? <>
            <div className="tr-room-preference-row"><div><strong>Appearance</strong><p>Choose how TradingVibes looks on this device.</p></div><button type="button" className="tr-room-preference-toggle" onClick={toggleTheme}>{theme === 'dark' ? '☀' : '☾'}{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button></div>
          </> : <>
            <label><span>Room name</span><input maxLength={80} value={settingsName} onChange={event => setSettingsName(event.target.value)} placeholder="Name your room" /></label>
            <label><span>Room description</span><textarea rows={4} maxLength={4000} value={settingsDescription} onChange={event => setSettingsDescription(event.target.value)} placeholder="What do you trade, and what do you want from the room?" /></label>
            {isAiRobot && <label><span>AI analysis interval</span><select value={settingsInterval} onChange={event => setSettingsInterval(Number(event.target.value))}><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option></select><span className="tr-room-settings-hint">The scheduler checks for a new analysis at this interval.</span></label>}
            <div>
              <p className="tr-room-settings-label">Room cover</p>
              <p className="tr-room-settings-hint">A cover makes the room recognisable in the directory. It is optional.</p>
              <RoomCoverPicker
                roomId={data.team.id}
                currentUrl={settingsCover}
                onChange={url => setSettingsCover(url)}
              />
            </div>
            <div>
              <p className="tr-room-settings-label">Market category</p>
              <p className="tr-room-settings-hint">The category decides where the room appears in the directory.</p>
              <div className="tr-room-intervals">
                {ROOM_CATEGORIES.map(category => <label key={category.id}>
                  <input
                    type="radio"
                    name="room-category"
                    checked={settingsCategory === category.id}
                    onChange={() => setSettingsCategory(category.id as RoomCategory)}
                  />
                  <span>{category.label}</span>
                </label>)}
              </div>
            </div>
            {!isAiRobot && <div>
              <p className="tr-room-settings-label">Who can see this room</p>
              <div className="tr-room-intervals">
                <label><input type="radio" name="room-visibility" checked={settingsVisibility === 'PUBLIC'} onChange={() => setSettingsVisibility('PUBLIC')} /><span>Listed in the directory</span></label>
                <label><input type="radio" name="room-visibility" checked={settingsVisibility === 'PRIVATE'} onChange={() => setSettingsVisibility('PRIVATE')} /><span>Invite only</span></label>
              </div>
            </div>}
            {isAiRobot && <div className="tr-room-settings-hint">Every AI robot appears in the AI Robots directory. Stopping a robot pauses its analysis; it stays visible.</div>}
            <div>
              <p className="tr-room-settings-label">{isAiRobot ? 'Robot features' : 'Room features'}</p>
              <div className="tr-room-intervals">
                <label><input type="checkbox" checked={settingsAllowDrawings} onChange={event => setSettingsAllowDrawings(event.target.checked)} /><span>Members may draw on the shared chart</span></label>
                {!isAiRobot && <label><input type="checkbox" checked={settingsVoiceEnabled} onChange={event => setSettingsVoiceEnabled(event.target.checked)} /><span>Voice is available in this room</span></label>}
              </div>
            </div>
            {!isAiRobot && <div>
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
            </div>}
            <div>
              <p className="tr-room-settings-label">{isAiRobot ? 'Robot controls' : 'Room status'}</p>
              <div className="tr-room-creator-actions">
                <button type="button" className={'sg-room-lifecycle-button ' + (data.team.status === 'PAUSED' ? 'is-play' : 'is-pause')} disabled={settingsSaving || robotStatusSaving} onClick={() => void toggleRoomPublished()}>
                  {data.team.status === 'PAUSED' ? (isAiRobot ? 'Play robot' : 'Publish room') : (isAiRobot ? 'Stop robot' : 'Pause room')}
                </button>
              </div>
              <p className="tr-room-settings-hint">{isAiRobot ? 'A stopped robot stays in the directory, but its scheduled analysis and tracker work are paused.' : 'Pausing a room keeps its data and conversation.'}</p>
            </div>
            <div className="tr-room-danger">
              <p className="tr-room-settings-label">Delete this {isAiRobot ? 'robot' : 'room'}</p>
              <p className="tr-room-settings-hint">Permanently removes the {isAiRobot ? 'robot and' : 'room,'} its conversation and its members.</p>
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
