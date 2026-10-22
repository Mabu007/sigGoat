/**
 * TRADE ROOM SIDEBAR
 * ==================
 * One panel container with a switchable view, so the room's right-hand column
 * is a control surface rather than a single endless feed.
 *
 * DESIGN RATIONALE
 * ----------------
 * The sidebar answers four different questions a trader asks mid-session, and
 * they do not want to be interleaved in one scroll:
 *
 *   Room Chat     — what is the room talking about right now?
 *   Breaking News — what moved the macro tape underneath them?
 *   Chat to Mentor — a private word with the room's leader
 *   Group Details — who runs this room, and what is it about?
 *   Connect Broker — which account am I trading this room with?
 *   Tools        — what can these agents even see and do?
 *
 * A trade log interleaved with market commentary is unreadable: the entries
 * have wildly different lifetimes (a headline is relevant for minutes, a
 * question in the room chat for an afternoon, a filled trade is permanent).
 * Splitting them by lifetime is what makes each panel scannable on its own
 * terms.
 *
 * Every panel is driven by real server state and renders an explicit empty or
 * unavailable state. Nothing here invents a value to fill a gap — a room
 * that has no messages says so, a news feed that failed says why.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, CandlestickChart, ChevronLeft, ExternalLink, Link2, Lock, MessageCircle,
  MessagesSquare, Newspaper, Users, X, RefreshCw, Send,
  CheckCircle2, AlertCircle,
} from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { useAuth } from '../context/AuthContext';
import './chat.css';

/* -------------------------------------------------------------------------
   Shared contracts. Kept local and structural: the room payload is the only
   thing that has to agree with these, and duplicating the whole server type
   graph here would rot every time an unrelated field is added.
   ------------------------------------------------------------------------- */

export type TrackerStatus = 'PENDING' | 'UNEVALUABLE' | 'HIT' | 'INVALIDATED' | 'EXPIRED';

export interface RoomTracker {
  id: string;
  description: string;
  type: string;
  market: string;
  targetValue?: number;
  rangeLow?: number;
  rangeHigh?: number;
  operator?: string;
  currentCalculatedValue?: number;
  formulaDescription?: string;
  status?: TrackerStatus;
  isTriggered: boolean;
  triggeredAt?: number;
  lastEvaluatedAt?: number;
  lastEvaluationReason?: string;
}

export interface RoomThesis {
  market: string;
  bias: string;
  summary: string;
  assetState: string | null;
  confidence: number;
  invalidation: string[];
  confirmation: string[];
  observationPlan: string | null;
  relevantTimeframe: string;
  trackers: RoomTracker[];
  updatedAt: string;
}

/**
 * One unit of work an agent actually did.
 *
 * This is what a Team Chat message IS. The room payload derives it from the
 * durable workflow run, so the chat cannot drift from what happened — and the
 * run id is what the click-through reads to show the real activity log.
 */
export interface RoomRun {
  workflowId: string;
  market: string;
  triggerType: string;
  status: string;
  stage: string;
  errorCode: string | null;
  outcome: 'review' | 'proposal' | 'no_trade' | 'failed' | 'running';
  at: string;
  completedAt: string | null;
  headline: string;
  summary: string;
  bias: string | null;
  confidence: number | null;
  levels: { entry?: number; stopLoss?: number; takeProfit?: number; riskReward: string | null } | null;
  agentName: string;
}

export interface RoomRunLog {
  run: { workflowId: string; market: string; triggerType: string; stage: string; status: string; errorCode: string | null; createdAt: string; completedAt: string | null };
  agent: { id: string; name: string } | null;
  activities: { id: string; type: string; stage: string; at: string; details?: Record<string, string | number | boolean | null> }[];
}

export interface RoomMember {
  id: string;
  name: string;
  goal: string;
  markets: string[];
  status: string;
  provider: string;
  timeframe: string;
  skills: string[];
  latestThesis: RoomThesis | null;
  signals: RoomTrade[];
  runs: RoomRun[];
  trades: number;
}

export interface RoomTrade {
  id: string;
  market: string;
  direction: string;
  status: string;
  decision?: string;
  decidedAt?: string;
  decisionNote: string | null;
  orderType?: string;
  entry?: number;
  entryZone?: { low: number; high: number } | null;
  stopLoss?: number;
  takeProfit?: number;
  riskReward: string | null;
  confidence: number;
  thesis: string;
  rationale: string;
  invalidation: string;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  confirmationRequired: string;
  expiresAt: string | null;
  createdAt: string;
  agentName: string;
}

export interface RoomIndicators {
  rsi14: number; ema20: number; ema50: number; atr14: number;
  structureBias: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastSwingHigh: number; lastSwingLow: number; retracementPct: number;
  sma20?: number; macd?: { macd: number; signal: number; histogram: number };
  bollingerBands20?: { middle: number; upper: number; lower: number; bandwidthPct: number };
  stochastic14?: { k: number; d: number }; vwap?: number | null;
  demandZone: { low: number; high: number }; supplyZone: { low: number; high: number };
}

export interface RoomNewsPayload {
  market: string;
  ok: boolean;
  error: string | null;
  fetchedAt: string;
  headlines: { title: string; source: string; publishedAt?: number; link?: string }[];
}

/* -------------------------------------------------------------------------
   Panel registry
   ------------------------------------------------------------------------- */

export type RoomPanelId = 'chat' | 'news' | 'mentor' | 'details' | 'broker' | 'market';

export const ROOM_PANELS: { id: RoomPanelId; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { id: 'chat', label: 'Room Chat', icon: MessagesSquare },
  { id: 'news', label: 'Breaking News', icon: Newspaper },
  { id: 'mentor', label: 'Chat to Mentor', icon: MessageCircle },
  { id: 'details', label: 'Group Details', icon: Users },
  { id: 'broker', label: 'Connect Broker', icon: Link2 },
  { id: 'market', label: 'Market', icon: CandlestickChart },
];

/* -------------------------------------------------------------------------
   Small building blocks
   ------------------------------------------------------------------------- */

const cx = (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(' ');

function PanelEmpty({ title, hint, tone = 'neutral' }: { title: string; hint?: string; tone?: 'neutral' | 'bad' }) {
  return (
    <div className="tr-panel-empty">
      <p className={cx('tr-panel-empty-title', tone === 'bad' && 'is-bad')}>{title}</p>
      {hint && <p className="tr-panel-empty-hint">{hint}</p>}
    </div>
  );
}

function SectionLabel({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="tr-panel-section-label">
      <span>{children}</span>
      {aside}
    </div>
  );
}

/** One label/value line, used by the run log and the room details. */
function Row({ label, value }: { label: string; value: string }) {
  return <div className="tr-kv-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

const money = (value?: number, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—'
    : value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * A price, with enough precision to be useful.
 *
 * A forex price is around 1.12 and a gold price around 4000. Two decimals
 * would print every forex swing level as "1.12", so the digits follow the
 * magnitude of the number.
 */
const price = (value?: number) =>
  value == null || !Number.isFinite(value) ? '—'
    : value.toLocaleString(undefined, {
      minimumFractionDigits: Math.abs(value) < 10 ? 4 : 2,
      maximumFractionDigits: Math.abs(value) < 10 ? 5 : 2,
    });

/** Whether the prices on screen are reference prices rather than a live feed. */
const isReferenceFeed = (dataMode: string) =>
  /PAPER|REFERENCE/i.test(dataMode ?? '');

function relativeTime(value?: string | number): string {
  if (value == null) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const BIAS_TONE: Record<string, string> = {
  BULLISH: 'is-positive', BEARISH: 'is-negative', RANGING: 'is-muted', NEUTRAL: 'is-muted',
};

function compactChatLine(value: string, maxLength = 170): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const sentenceEnd = clean.slice(0, maxLength).lastIndexOf('. ');
  const cutoff = sentenceEnd >= Math.floor(maxLength * 0.55) ? sentenceEnd + 1 : maxLength - 1;
  return clean.slice(0, cutoff).trimEnd() + '…';
}

const AGENT_NAME_COLORS = ['#7c9cff', '#52d6a2', '#f0b35a', '#e58bc4', '#63c7e8', '#b7a0ff', '#f28f75'];
function agentNameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AGENT_NAME_COLORS[Math.abs(hash) % AGENT_NAME_COLORS.length];
}

function localMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
}

/* =========================================================================
   PANEL — Room Chat
   The shared conversation of the room.

   Every entry is something a PERSON in the room said. The room's chat is
   where the market gets discussed, so it carries names and timestamps and
   nothing else.

   IT IS A MESSAGING APP, NOT A FEED
   ---------------------------------
   The panel is a flex column that fills the slot it is given: a fixed status
   strip, a conversation that scrolls, and a composer PINNED to the bottom so
   it never scrolls out of reach. The room's other panels still scroll in the
   outer container; this one does not need it.

   Three behaviours make it feel like a messenger rather than a log:

   1. A new message scrolls the reader down ONLY when they are already at
      the bottom. A reader looking at older messages is left where they are,
      and a "N new messages" pill offers the jump they declined.
   2. Loading older history PREPENDS to the list, so the content under the
      reader's eyes must not move. The scroll offset is measured before the
      prepend and restored after it.
   3. Unread is a COUNT, not a total. It starts at the server's number, grows
      when a message arrives that the reader has not seen, and empties when
      the reader has actually seen the messages.

   A visitor can read the conversation without an account. Posting needs one,
   so the composer is locked for them and opens the sign-in dialog when they
   press it.
   ========================================================================= */

/** One message written by a member of the room. */
export interface RoomChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  /** The author's picture, when the server has one. */
  authorAvatarUrl?: string | null;
  content: string;
  createdAt: string;
  /** The author's role in the room — 'LEADER' or 'MEMBER'. */
  role?: string;
}

/** One page of room history. */
export interface RoomChatPage {
  messages: RoomChatMessage[];
  hasMore: boolean;
}

/** How close to the bottom still counts as "the reader is at the latest message". */
const CHAT_NEAR_BOTTOM_PX = 80;
/** How many older messages one page of history holds. */
const CHAT_HISTORY_PAGE = 40;
/** Only an explicit http(s) URL is ever turned into a link. */
const CHAT_LINK_PATTERN = /https?:\/\/[^\s<>()]+/gi;

/**
 * Whether a URL may be turned into an anchor.
 *
 * A chat message is text written by whoever is in the room, so the markup in
 * it is never interpreted. A link is only a link when it is http or https:
 * `javascript:` and `data:` never become clickable.
 */
function isSafeChatLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A message body.
 *
 * The content is rendered as TEXT. The only thing that is not text is an
 * http(s) URL, which becomes an anchor that opens in a new tab and cannot
 * reach back into this page.
 */
function ChatMessageBody({ content }: { content: string }) {
  const parts = React.useMemo(() => {
    const pieces: { link: boolean; value: string }[] = [];
    let cursor = 0;
    for (const match of content.matchAll(CHAT_LINK_PATTERN)) {
      const index = match.index ?? 0;
      const raw = match[0];
      if (index > cursor) pieces.push({ link: false, value: content.slice(cursor, index) });
      /* A sentence's full stop belongs to the sentence, not to the link. */
      const bare = raw.replace(/[.,;:!?)\]}'"]+$/, '');
      const tail = raw.slice(bare.length);
      if (isSafeChatLink(bare)) pieces.push({ link: true, value: bare });
      else pieces.push({ link: false, value: bare });
      if (tail) pieces.push({ link: false, value: tail });
      cursor = index + raw.length;
    }
    if (cursor < content.length) pieces.push({ link: false, value: content.slice(cursor) });
    return pieces;
  }, [content]);

  return (
    <p className="tr-chat-row-body">
      {parts.map((part, index) => part.link
        ? (
          <a key={index} href={part.value} target="_blank" rel="noopener noreferrer">
            {part.value}
          </a>
        )
        : <React.Fragment key={index}>{part.value}</React.Fragment>)}
    </p>
  );
}

/** The public surface of the room chat panel. */
export interface RoomChatPanelProps {
  /** The messages the room holds right now, oldest first. */
  messages: RoomChatMessage[];
  /** Public AI analysis runs, oldest first. */
  analysisRuns?: RoomRun[];
  /**
   * Posts a message.
   *
   * Return a promise to keep the draft until the server has accepted the
   * message: resolve `false` (or reject) and the draft stays where it is,
   * resolve anything else and the composer clears itself.
   */
  onSend: (content: string) => void | Promise<boolean | void>;
  /** True while a post is in flight. */
  sending: boolean;
  /** True when this viewer may post in the room. */
  canPost: boolean;
  /** Opens the sign-in dialog. Used by the locked composer. */
  onRequestSignIn: () => void;
  viewerId: string | null;
  participantCount: number;
  signedIn: boolean;
  joinError: string;

  /* ---- optional: everything the panel can do on its own ---- */

  /** The room's id. Lets the panel load history and record reads by itself. */
  roomId?: string | null;
  /** Whether older history exists behind the newest page. */
  hasMore?: boolean;
  /** The server's unread count. Used as the starting value. */
  initialUnreadCount?: number;
  /** The server's read cursor, when it has one. */
  lastReadMessageId?: string | null;
  /** Called with the unread count whenever it changes. The tab badge uses it. */
  onUnreadCountChange?: (count: number) => void;
  /** Loads a page of older history. Defaults to the panel's own request. */
  onLoadOlder?: (before: string) => Promise<RoomChatPage>;
  /** Records that a message has been read. Defaults to the panel's own request. */
  onMarkRead?: (messageId: string) => void | Promise<void>;
}

/**
 * THE PANEL, SCOPED TO ONE ROOM.
 *
 * The conversation, the unread count and the read cursor belong to a room.
 * Changing rooms must not carry them over, so the state lives in a component
 * that is keyed by the room: a new room is a new component, with nothing
 * inherited from the last one.
 */
export function RoomChatPanel(props: RoomChatPanelProps) {
  return <RoomChatConversation key={props.roomId ?? 'room'} {...props} />;
}

function RoomChatConversation({
  messages, analysisRuns = [], onSend, sending, canPost, onRequestSignIn, viewerId, participantCount, signedIn, joinError,
  roomId = null, hasMore = false, initialUnreadCount = 0, lastReadMessageId = null,
  onUnreadCountChange, onLoadOlder, onMarkRead,
}: RoomChatPanelProps) {
  const { getApiAuthHeaders } = useAuth();

  const [draft, setDraft] = useState('');
  const [sendingLocal, setSendingLocal] = useState(false);
  /**
   * Why the last send failed.
   *
   * `null` means the send has not failed. An empty string means it failed
   * and the PARENT is explaining why (it has the server's words). Anything
   * else is the server's own message, caught here.
   */
  const [sendError, setSendError] = useState<string | null>(null);
  /** Older history the panel has paged in, oldest first. */
  const [olderMessages, setOlderMessages] = useState<RoomChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  /** Whether older history still exists. */
  const [moreAvailable, setMoreAvailable] = useState(hasMore);
  /** Messages that arrived while the reader was away from the bottom. */
  const [pendingNew, setPendingNew] = useState(0);
  /** The unread count the tab badge shows. */
  const [unreadCount, setUnreadCount] = useState(() => Math.max(0, initialUnreadCount || 0));

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** The list of messages — the anchor for a scroll restore. */
  const listRef = useRef<HTMLDivElement | null>(null);
  /** True when the reader is at (or within a few pixels of) the bottom. */
  const atBottomRef = useRef(true);
  /** True when the panel is actually on screen. */
  const visibleRef = useRef(true);
  /** The last message this reader has been shown. */
  const readCursorRef = useRef<string | null>(lastReadMessageId);
  /** When that message was written — the cursor only ever moves forward. */
  const readCursorAtRef = useRef<string | null>(null);
  /** Every message id the panel has already accounted for. */
  const seenIdsRef = useRef<Set<string>>(new Set());
  /** The scroll geometry captured before an older page is prepended. */
  const restoreRef = useRef<{ height: number; top: number; anchor: HTMLElement | null; anchorTop: number } | null>(null);
  const loadingOlderRef = useRef(false);
  const busyRef = useRef(false);
  /** The list as it is on screen, for callbacks that run outside a render. */
  const mergedRef = useRef<RoomChatMessage[]>([]);
  const moreRef = useRef(hasMore);
  const unreadCallbackRef = useRef(onUnreadCountChange);

  const busy = sending || sendingLocal;

  /** The request headers this browser signs its room calls with. */
  const authHeaders = React.useCallback(async (): Promise<Record<string, string>> => {
    try {
      return await getApiAuthHeaders();
    } catch {
      return {};
    }
  }, [getApiAuthHeaders]);

  /* ---------------------------------------------------------------------
     THE LIST
     The parent owns the newest page and everything appended to it; the panel
     owns the older history it has paged in. The two are merged into one
     ascending list, and a message is never shown twice.
     --------------------------------------------------------------------- */
  const merged = React.useMemo(() => {
    const seen = new Set<string>();
    const list: RoomChatMessage[] = [];
    for (const message of olderMessages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      list.push(message);
    }
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      list.push(message);
    }
    list.sort((left, right) => {
      const a = Date.parse(left.createdAt);
      const b = Date.parse(right.createdAt);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
      return a - b;
    });
    return list;
  }, [olderMessages, messages]);

  const isOwnMessage = React.useCallback(
    (message: RoomChatMessage) => viewerId != null && message.authorId === viewerId,
    [viewerId],
  );

  /* ---------------------------------------------------------------------
     SCROLLING
     --------------------------------------------------------------------- */
  const isNearBottom = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  /* ---------------------------------------------------------------------
     READ RECEIPTS
     The cursor only ever moves forward, and only for a message that is on
     screen and that the reader is actually looking at.
     --------------------------------------------------------------------- */
  const reportRead = React.useCallback(async (messageId: string) => {
    try {
      if (onMarkRead) {
        await onMarkRead(messageId);
        return;
      }
      if (!roomId) return;
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      for (const [key, value] of Object.entries(await authHeaders())) headers.set(key, value);
      await fetch(`/api/rooms/${encodeURIComponent(roomId)}/chat/read`, {
        method: 'POST', headers, body: JSON.stringify({ messageId }), cache: 'no-store',
      });
    } catch {
      /* A read receipt is a courtesy to the server. Failing it must never
         break the panel, and the local unread count has already been reset. */
    }
  }, [onMarkRead, roomId, authHeaders]);

  const markReadIfViewed = React.useCallback(() => {
    if (!visibleRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const element = scrollRef.current;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > CHAT_NEAR_BOTTOM_PX) return;
    const list = mergedRef.current;
    const last = list[list.length - 1];
    if (!last) return;
    if (readCursorRef.current === last.id) return;
    /* The cursor moves FORWARD only. A list that is replaced by an older
       page must never walk the reader's cursor backwards. */
    const cursorAt = readCursorAtRef.current;
    if (cursorAt && Date.parse(last.createdAt) <= Date.parse(cursorAt)) return;
    readCursorRef.current = last.id;
    readCursorAtRef.current = last.createdAt;
    setUnreadCount(0);
    setPendingNew(0);
    void reportRead(last.id);
  }, [reportRead]);

  /* ---------------------------------------------------------------------
     OLDER HISTORY
     The reader asks for the page before the oldest message on screen. The
     page is PREPENDED, so the scroll position is captured first and restored
     after the DOM has grown: the messages the reader was looking at must not
     move.
     --------------------------------------------------------------------- */
  const fetchOlderPage = React.useCallback(async (before: string): Promise<RoomChatPage> => {
    if (onLoadOlder) return onLoadOlder(before);
    if (!roomId) return { messages: [], hasMore: false };
    const headers = new Headers({ Accept: 'application/json' });
    for (const [key, value] of Object.entries(await authHeaders())) headers.set(key, value);
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/chat?before=${encodeURIComponent(before)}&limit=${CHAT_HISTORY_PAGE}`,
      { headers, cache: 'no-store' },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`);
    }
    const page = body as { messages?: RoomChatMessage[]; hasMore?: boolean };
    return {
      messages: Array.isArray(page.messages) ? page.messages : [],
      hasMore: Boolean(page.hasMore),
    };
  }, [onLoadOlder, roomId, authHeaders]);

  const loadOlder = React.useCallback(async () => {
    if (loadingOlderRef.current) return;
    const list = mergedRef.current;
    const oldest = list[0];
    if (!oldest) return;
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    /* The anchor is the message the reader is looking at. Its distance from
       the top of the scroll content is remembered, so the panel can put the
       reader back on exactly that message after the page above it arrives —
       whatever else changed in the meantime. */
    const anchor = listRef.current?.firstElementChild instanceof HTMLElement
      ? listRef.current.firstElementChild
      : null;
    const anchorTop = element && anchor
      ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
      : 0;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const page = await fetchOlderPage(oldest.createdAt);
      if (page.messages.length) {
        /* Remember where the reader was: the content above the fold must not
           move when the page above it arrives. */
        restoreRef.current = { height: previousHeight, top: previousTop, anchor, anchorTop };
        /* Older messages are history, not news: they are never unread. */
        const seen = new Set(seenIdsRef.current);
        for (const message of page.messages) seen.add(message.id);
        seenIdsRef.current = seen;
        setOlderMessages(previous => {
          const known = new Set(previous.map(message => message.id));
          const next = [...previous];
          for (const message of page.messages) {
            if (known.has(message.id)) continue;
            known.add(message.id);
            next.push(message);
          }
          return next;
        });
        setMoreAvailable(page.hasMore);
        moreRef.current = page.hasMore;
      } else {
        setMoreAvailable(false);
        moreRef.current = false;
      }
    } catch (err) {
      setOlderError(err instanceof Error ? err.message : 'Earlier messages could not be loaded.');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [fetchOlderPage]);

  /* ---------------------------------------------------------------------
     EFFECTS
     --------------------------------------------------------------------- */

  /* The server's unread count is the STARTING value. It is adopted again
     only while the panel still believes nothing is unread, so a later poll
     can never drag the count backwards. */
  useEffect(() => {
    const seed = Math.max(0, initialUnreadCount || 0);
    setUnreadCount(current => (current === 0 ? seed : current));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [initialUnreadCount]);

  /* The parent decides whether older history exists behind the newest page. */
  useEffect(() => {
    setMoreAvailable(hasMore);
    moreRef.current = hasMore;
  }, [hasMore]);

  /* The badge is told about every change. */
  useEffect(() => { unreadCallbackRef.current = onUnreadCountChange; });
  useEffect(() => { unreadCallbackRef.current?.(unreadCount); }, [unreadCount]);

  /* A panel that is off screen does not mark anything as read. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      visibleRef.current = entries.some(entry => entry.isIntersecting);
    }, { threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* Restore the scroll position after an older page has been prepended. This
     runs before the browser paints, so the reader never sees the list jump. */
  useLayoutEffect(() => {
    const restore = restoreRef.current;
    if (!restore) return;
    restoreRef.current = null;
    const element = scrollRef.current;
    if (!element) return;
    /* The anchor moved down by exactly the height of the prepended page, so
       the reader is put back on the message they were reading. */
    let delta = element.scrollHeight - restore.height;
    const anchor = restore.anchor;
    if (anchor && anchor.isConnected) {
      const anchorTop = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
      delta = anchorTop - restore.anchorTop;
    }
    element.scrollTop = restore.top + delta;
    atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_NEAR_BOTTOM_PX;
    (window as unknown as { __chatDebug?: unknown }).__chatDebug = { restore, delta, applied: element.scrollTop, connected: Boolean(anchor && anchor.isConnected) };
  }, [olderMessages]);

  /* NEW MESSAGES.
     The list is watched for ids the panel has not seen. The first page the
     server sends is the history, not news: it is not counted as unread and
     the reader is placed at the bottom. After that, a message scrolls the
     reader down only if they were already there. */
  useLayoutEffect(() => {
    mergedRef.current = merged;
    const seen = seenIdsRef.current;
    const fresh = merged.filter(message => !seen.has(message.id));
    if (seen.size === 0) {
      for (const message of merged) seen.add(message.id);
      if (!merged.length) return;
      scrollToBottom('auto');
      atBottomRef.current = true;
      markReadIfViewed();
      return;
    }
    if (!fresh.length) return;
    for (const message of fresh) seen.add(message.id);
    const fromOthers = fresh.filter(message => !isOwnMessage(message));
    if (atBottomRef.current) {
      scrollToBottom('smooth');
      markReadIfViewed();
      return;
    }
    if (!fromOthers.length) return;
    setPendingNew(count => count + fromOthers.length);
    setUnreadCount(count => count + fromOthers.length);
  }, [merged, isOwnMessage, scrollToBottom, markReadIfViewed]);

  /* ---------------------------------------------------------------------
     SCROLLING BY HAND
     --------------------------------------------------------------------- */
  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    if (near) {
      /* The reader has caught up: what is on screen has been seen. */
      markReadIfViewed();
      return;
    }
    const overflows = element.scrollHeight - element.clientHeight > 60;
    if (overflows && element.scrollTop <= 24 && moreRef.current && !loadingOlderRef.current) {
      void loadOlder();
    }
  }, [markReadIfViewed, loadOlder]);

  const jumpToLatest = React.useCallback(() => {
    atBottomRef.current = true;
    setPendingNew(0);
    scrollToBottom('smooth');
    /* The smooth scroll reports itself through the scroll handler; when the
       conversation is short enough not to scroll at all, it is read here. */
    window.setTimeout(() => markReadIfViewed(), 260);
  }, [scrollToBottom, markReadIfViewed]);

  /* ---------------------------------------------------------------------
     POSTING
     --------------------------------------------------------------------- */
  const sendDraft = React.useCallback(async () => {
    const content = draft.trim();
    if (!content || busyRef.current) return;
    busyRef.current = true;
    setSendingLocal(true);
    setSendError(null);
    try {
      const outcome = onSend(content);
      const promise = outcome as unknown as Promise<boolean | void> | undefined;
      if (promise && typeof promise.then === 'function') {
        const settled = await promise;
        if (settled === false) {
          /* The parent says what went wrong; the draft stays put. */
          setSendError('');
          return;
        }
      }
      /* Only a message the server accepted clears the draft. */
      setDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Your message could not be sent.');
    } finally {
      busyRef.current = false;
      setSendingLocal(false);
    }
  }, [draft, onSend]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void sendDraft();
  };

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    else void sendDraft();
  };

  /**
   * What the reader is told about a failure.
   *
   * The server's own words win. The parent usually has them (it made the
   * request), so it is asked first; the panel's own message is the fallback
   * for a parent that says nothing.
   */
  const errorText = sendError !== null
    ? (sendError || (canPost ? joinError : '') || 'Your message could not be sent.')
    : (canPost ? joinError : '');

  return (
    <div className="tr-chat-panel">
      <div className="tr-chat-status" aria-live="polite">
        <span className="tr-chat-status-left">
          <span className="tr-chat-live-dot is-working" />
          <span>ROOM CHAT</span>
          {unreadCount > 0 && <span className="tr-chat-unread">{unreadCount} unread</span>}
        </span>
        <span className="tr-chat-status-right">
          {participantCount > 0 ? `${participantCount} in the room` : 'Be the first to join'}
        </span>
      </div>

      <div className="tr-chat-scroll" ref={scrollRef} onScroll={handleScroll} tabIndex={0}>
        {moreAvailable && (
          <div className="tr-chat-older-bar">
            <button
              type="button"
              className="tr-chat-older"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
            >
              {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {olderError && <p className="tr-panel-error" role="alert">{olderError}</p>}

        {merged.length === 0 && analysisRuns.length === 0 ? (
          <PanelEmpty
            title="No messages yet"
            hint="Start the conversation — share an idea, ask a question, or post what you are watching."
          />
        ) : (
          <div
            ref={listRef}
            className="tr-chat-list"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Room messages"
          >
            {analysisRuns.map(run => <article key={`analysis-${run.workflowId}`} className="tr-chat-row border border-accent/20 bg-accent/5">
              <div className="tr-chat-row-head">
                <span className="tr-chat-row-author">{run.agentName} · AI analysis</span>
                <span className="tr-chat-row-role">{run.outcome.replace(/_/g, ' ')}</span>
                <time className="tr-chat-row-time" dateTime={run.at} title={new Date(run.at).toLocaleString()}>{localMessageTime(run.at)}</time>
              </div>
              <strong className="block text-sm text-fg">{run.headline}</strong>
              {run.bias && <p className="mt-1 text-[11px] text-fg-muted">Bias: {run.bias}{run.confidence != null ? ` · ${Math.round(run.confidence * 100)}% confidence` : ''}</p>}
              <ChatMessageBody content={run.summary || 'No analysis summary was recorded for this run.'} />
              {run.levels && <p className="mt-2 text-[10px] text-fg-subtle">{[
                run.levels.entry != null ? `Entry ${run.levels.entry}` : '',
                run.levels.stopLoss != null ? `Stop ${run.levels.stopLoss}` : '',
                run.levels.takeProfit != null ? `Target ${run.levels.takeProfit}` : '',
              ].filter(Boolean).join(' · ')}</p>}
            </article>)}
            {merged.map(message => {
              const own = isOwnMessage(message);
              return (
                <article
                  key={message.id}
                  className={'tr-chat-row' + (own ? ' is-self' : '')}
                >
                  <div className="tr-chat-row-head">
                    <UserAvatar
                      name={message.authorName}
                      url={message.authorAvatarUrl ?? null}
                      size={20}
                      decorative
                    />
                    <span className="tr-chat-row-author">{own ? 'You' : message.authorName}</span>
                    {message.role === 'LEADER' && <span className="tr-chat-row-role">Leader</span>}
                    <time
                      className="tr-chat-row-time"
                      dateTime={message.createdAt}
                      title={new Date(message.createdAt).toLocaleString()}
                    >
                      {localMessageTime(message.createdAt)}
                    </time>
                  </div>
                  <ChatMessageBody content={message.content} />
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="tr-chat-foot">
        {pendingNew > 0 && (
          <button
            type="button"
            className="tr-chat-jump"
            onClick={jumpToLatest}
            aria-label={`Jump to the latest messages — ${pendingNew} new`}
          >
            <ArrowDown size={12} strokeWidth={2.4} aria-hidden="true" />
            {pendingNew} new {pendingNew === 1 ? 'message' : 'messages'}
          </button>
        )}

        {canPost ? (
          <form className="tr-composer" onSubmit={submit}>
            <label className="tr-sr-only" htmlFor="tr-room-chat-composer">Message the room</label>
            <textarea
              id="tr-room-chat-composer"
              className="tr-composer-input"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              maxLength={2000}
              rows={2}
              placeholder="Share what the market is doing, or ask the room…"
            />
            <div className="tr-composer-foot">
              <span className="tr-composer-count">{draft.trim().length}/2000</span>
              <button
                type="submit"
                className="tr-composer-send"
                disabled={busy || !draft.trim()}
                aria-label="Send message to the room"
              >
                <Send size={12} strokeWidth={2.4} aria-hidden="true" />
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="tr-composer is-locked" onClick={onRequestSignIn}>
            <span className="tr-composer-lock" aria-hidden="true"><Lock size={14} /></span>
            <span className="tr-composer-locked-text">
              {joinError || (signedIn
                ? 'Join this room to post in its conversation.'
                : 'Sign in or create an account to post in this room.')}
            </span>
            <span className="tr-composer-cta">{signedIn ? 'Join room' : 'Sign in'}</span>
          </button>
        )}

        {errorText && <p className="tr-panel-error" role="alert">{errorText}</p>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   RUN LOG — replaces the chat in place, not a modal.

   The user asked to "turn the chat area to logs". Keeping it in the same
   scroll region preserves context: the chart and sidebar frame never move, so
   Back returns to exactly where the list was.
   -------------------------------------------------------------------------- */
export function RunLogView({ log, loading, onBack }: { log: RoomRunLog | null; loading: boolean; onBack: () => void }) {
  return (
    <>
      <div className="tr-log-bar">
        <button type="button" className="tr-log-back" onClick={onBack}>
          <ChevronLeft size={14} strokeWidth={2.4} aria-hidden="true" />
          Back to chat
        </button>
        {log?.agent && <span className="tr-log-agent">{log.agent.name}</span>}
      </div>
      {loading && !log ? (
        <PanelEmpty title="Loading log…" />
      ) : !log ? (
        <PanelEmpty title="Log unavailable" tone="bad" hint="This run's record is no longer available." />
      ) : (
        <div className="tr-log">
          <dl className="tr-kv">
            <Row label="Run" value={log.run.market} />
            <Row label="Trigger" value={log.run.triggerType.replaceAll('_', ' ').toLowerCase()} />
            <Row label="Outcome" value={log.run.status.replaceAll('_', ' ')} />
            <Row label="Final stage" value={log.run.stage.replaceAll('_', ' ')} />
          </dl>
          <div className="tr-log-timeline">
            {log.activities.length === 0
              ? <PanelEmpty title="No stages recorded" />
              : log.activities.map(activity => (
                <div className={'tr-log-step' + (activity.type.startsWith('WORKFLOW_FAILED') || activity.type.endsWith('_FAILED') ? ' is-failed' : '')} key={activity.id}>
                  <span className="tr-log-dot" aria-hidden="true" />
                  <div className="tr-log-step-body">
                    <div className="tr-log-step-head">
                      <span className="tr-log-stage">{activity.stage.replaceAll('_', ' ')}</span>
                      <time dateTime={activity.at}>{new Date(activity.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    </div>
                    <span className="tr-log-type">{activity.type.replaceAll('_', ' ')}</span>
                    {activity.details && Object.keys(activity.details).length > 0 && (
                      <ul className="tr-log-details">
                        {Object.entries(activity.details).map(([key, value]) => (
                          <li key={key}><span>{key.replaceAll('_', ' ')}</span><b>{String(value)}</b></li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
          </div>
          <p className="tr-panel-disclaimer">
            This is the run's durable workflow record — the stages it actually
            passed through. Model prompts and responses are not retained by this
            system, so they cannot be shown here.
          </p>
        </div>
      )}
    </>
  );
}

/* =========================================================================
   PANEL — Breaking News
   ========================================================================= */

function NewsPanel({ news, loading, onRefresh }: { news: RoomNewsPayload | null; loading: boolean; onRefresh: () => void }) {
  const refreshButton = <button type="button" className="tr-news-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh news" title="Refresh news"><RefreshCw size={12} className={loading ? 'is-spinning' : ''} /><span>{loading ? 'Updating…' : 'Refresh'}</span></button>;
  const meta = <div className="tr-news-meta"><span className="tr-news-market">{news?.market ?? 'BREAKING NEWS'}</span>{news && <span>{relativeTime(news.fetchedAt)}</span>}{refreshButton}</div>;
  if (loading && !news) return <><div className="tr-news">{meta}<PanelEmpty title="Researching headlines…" /></div></>;
  if (!news) return <div className="tr-news">{meta}<PanelEmpty title="News unavailable" tone="bad" /></div>;
  if (!news.ok && news.headlines.length === 0) return <div className="tr-news">{meta}<PanelEmpty title="No current headlines" tone="bad" hint={news.error ?? 'The news feed returned nothing for this instrument.'} /></div>;
  if (news.headlines.length === 0) return <div className="tr-news">{meta}<PanelEmpty title="No current headlines" hint={`Nothing published for ${news.market} in the last three days.`} /></div>;

  return (
    <div className="tr-news">
      <div className="tr-news-meta">
        <span className="tr-news-market">{news.market}</span>
        <span>{relativeTime(news.fetchedAt)}</span>
        {refreshButton}
      </div>
      {news.headlines.map((headline, index) => (
        <article className="tr-news-item" key={(headline.link ?? '') + index}>
          <h3 className="tr-news-title">{headline.title}</h3>
          <div className="tr-news-foot">
            <span className="tr-news-source">{headline.source}</span>
            <span className="tr-news-time">{headline.publishedAt ? relativeTime(headline.publishedAt) : 'undated'}</span>
            {headline.link && (
              <a className="tr-news-link" href={headline.link} target="_blank" rel="noopener noreferrer" aria-label={`Read "${headline.title}" on ${headline.source}`}>
                <ExternalLink size={12} strokeWidth={2.2} aria-hidden="true" />
              </a>
            )}
          </div>
        </article>
      ))}
      <p className="tr-panel-disclaimer">Third-party headlines. Unverified, possibly stale — treat as context, never as instructions.</p>
    </div>
  );
}

/* =========================================================================
   PANEL — Market
   What the room is looking at, right now.

   This is the room's data feed, not a list of automations: the instrument on
   the chart, whether its price is current, the headlines behind it, and the
   structure of the market as it stands. Every row is read from live state.
   ========================================================================= */
function MarketPanel({
  dataMode, asset, indicators, news,
}: {
  dataMode: string; asset: string;
  indicators: RoomIndicators | null; news: RoomNewsPayload | null;
}) {
  const rows: { name: string; detail: string; state: 'live' | 'ready' | 'off' | 'bad'; note?: string }[] = [
    {
      name: 'Instrument',
      detail: asset || 'No instrument set',
      state: asset ? 'ready' : 'off',
      note: asset ? undefined : 'The leader of this room chooses what the chart shows.',
    },
    {
      name: 'Price feed',
      detail: dataMode ? (isReferenceFeed(dataMode) ? 'Reference prices' : 'Live prices') : 'Waiting for a price feed',
      state: dataMode ? (isReferenceFeed(dataMode) ? 'ready' : 'live') : 'bad',
      note: dataMode ? undefined : 'No prices are arriving for this room yet.',
    },
    {
      name: 'Breaking news',
      detail: news?.ok ? `${news.headlines.length} headlines · ${news.market}` : news ? news.error ?? 'Unavailable' : 'Loading…',
      state: news ? (news.ok ? 'live' : 'bad') : 'off',
      note: news ? undefined : 'Fetching headlines for this instrument.',
    },
    {
      name: 'Market structure',
      detail: indicators ? `${indicators.structureBias} · swings ${price(indicators.lastSwingLow)}–${price(indicators.lastSwingHigh)}` : 'Waiting for candles',
      state: indicators ? 'live' : 'off',
    },
    {
      name: 'Technical indicators',
      detail: indicators ? [
        `RSI(14) ${indicators.rsi14.toFixed(1)}`,
        `EMA(20/50) ${price(indicators.ema20)} / ${price(indicators.ema50)}`,
        `ATR(14) ${price(indicators.atr14)}`,
        indicators.macd ? `MACD ${indicators.macd.macd.toFixed(4)}` : '',
        indicators.stochastic14 ? `Stoch ${indicators.stochastic14.k.toFixed(1)}/${indicators.stochastic14.d.toFixed(1)}` : '',
        indicators.bollingerBands20 ? `BB ${money(indicators.bollingerBands20.lower)}–${money(indicators.bollingerBands20.upper)}` : '',
        indicators.vwap != null && indicators.vwap > 0 ? `VWAP ${money(indicators.vwap)}` : '',
      ].filter(Boolean).join(' · ') : 'Waiting for candles',
      state: indicators ? 'live' : 'off',
    },
  ];

  const labels = { live: 'Live', ready: 'Ready', off: 'Off', bad: 'Unavailable' };

  return (
    <div className="tr-tools">
      {rows.map(row => (
        <div className="tr-tool" key={row.name}>
          <span className={cx('tr-tool-dot', 'is-' + row.state)} aria-hidden="true" />
          <div className="tr-tool-body">
            <div className="tr-tool-head">
              <span className="tr-tool-name">{row.name}</span>
              <span className={cx('tr-tool-state', 'is-' + row.state)}>{labels[row.state]}</span>
            </div>
            <p className="tr-tool-detail">{row.detail}</p>
            {row.note && <p className="tr-tool-note">{row.note}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* =========================================================================
   PANEL — Chat to Mentor
   A private line between one member and the room's leader.

   The leader sees a list of the conversations their members have started; a
   member sees their own conversation with the leader. These messages are
   never mixed into the room conversation.
   ========================================================================= */

export interface MentorThreadSummary {
  memberId: string;
  memberName: string;
  lastMessageAt: string | null;
  lastMessage: string | null;
}

export function MentorChatPanel({
  threads, activeMemberId, onSelectThread, messages, counterpartName, isLeader,
  onSend, sending, canPost, onJoin, onRequestSignIn, joining, joinError, viewerId, loading, signedIn,
}: {
  threads: MentorThreadSummary[];
  activeMemberId: string | null;
  onSelectThread: (memberId: string) => void;
  messages: RoomChatMessage[];
  counterpartName: string;
  isLeader: boolean;
  onSend: (content: string) => void;
  sending: boolean;
  canPost: boolean;
  onJoin: () => void;
  /** Opens the sign-in dialog. Used by the locked composer. */
  onRequestSignIn: () => void;
  joining: boolean;
  joinError: string;
  viewerId: string | null;
  loading: boolean;
  signedIn: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    onSend(content);
    setDraft('');
  };

  return (
    <>
      <div className="tr-chat-status" aria-live="polite">
        <span className="tr-chat-status-left"><MessageCircle size={12} strokeWidth={2.2} aria-hidden="true" /><span>PRIVATE</span></span>
        <span className="tr-chat-status-right">
          {isLeader ? 'Only you and the member can read this' : `You and ${counterpartName}`}
        </span>
      </div>

      {isLeader && threads.length > 0 && (
        <div className="tr-mentor-threads" role="list" aria-label="Member conversations">
          {threads.map(thread => (
            <button
              type="button"
              role="listitem"
              key={thread.memberId}
              className={'tr-mentor-thread' + (thread.memberId === activeMemberId ? ' is-active' : '')}
              onClick={() => onSelectThread(thread.memberId)}
            >
              <span className="tr-mentor-thread-name">{thread.memberName}</span>
              <span className="tr-mentor-thread-last">
                {thread.lastMessage ? thread.lastMessage.slice(0, 60) : 'No messages yet'}
              </span>
              <span className="tr-mentor-thread-time">
                {thread.lastMessageAt ? relativeTime(thread.lastMessageAt) : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {canPost && !(isLeader && !activeMemberId) ? (
        <form className="tr-composer" onSubmit={submit}>
          <textarea
            className="tr-composer-input"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={isLeader ? 'Write to this member…' : `Ask ${counterpartName} a question…`}
            aria-label="Private message"
          />
          <div className="tr-composer-foot">
            <span className="tr-composer-count">{draft.trim().length}/2000</span>
            <button type="submit" className="tr-composer-send" disabled={sending || !draft.trim()}>
              <Send size={12} strokeWidth={2.4} aria-hidden="true" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      ) : canPost ? (
        <div className="tr-composer is-locked">
          <p className="tr-composer-locked-text">
            {joinError || 'Choose the conversation you want to reply to.'}
          </p>
        </div>
      ) : (
        <button type="button" className="tr-composer is-locked" onClick={signedIn ? onJoin : onRequestSignIn} disabled={joining}>
          <span className="tr-composer-lock" aria-hidden="true"><Lock size={14} /></span>
          <span className="tr-composer-locked-text">
            {joinError || (signedIn
              ? 'Join this room to write to its leader privately.'
              : 'Sign in or create an account to talk to the leader privately.')}
          </span>
          <span className="tr-composer-cta">{joining ? 'Joining…' : signedIn ? 'Join room' : 'Sign in'}</span>
        </button>
      )}

      {loading ? (
        <PanelEmpty title="Loading conversation…" />
      ) : messages.length === 0 ? (
        <PanelEmpty
          title="No private messages yet"
          hint={isLeader
            ? 'When a member writes to you, the conversation appears here.'
            : `Start a private conversation with ${counterpartName}.`}
        />
      ) : (
        <div className="tr-chat">
          {messages.map(message => {
            const own = viewerId != null && message.authorId === viewerId;
            return (
              <article key={message.id} className={'tr-chat-msg is-static' + (own ? ' is-self' : '')}>
                <div className="tr-chat-msg-head">
                  <UserAvatar
                    name={message.authorName}
                    url={message.authorAvatarUrl}
                    size={25}
                    decorative
                    className="tr-agent-avatar"
                  />
                  <span className="tr-agent-name">{message.authorName}</span>
                  <span className="tr-chat-kind is-private">Private</span>
                  <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
                    <span className="tr-chat-clock">{localMessageTime(message.createdAt)}</span>
                    <span className="tr-chat-relative">{relativeTime(message.createdAt)}</span>
                  </time>
                </div>
                <p className="tr-chat-summary is-body">{message.content}</p>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

/* =========================================================================
   PANEL — Group Details
   What this room actually is, said by the room's own records.

   Nothing here is estimated: the name, the leader, the visibility and the
   roster all come from the server's records about this room.
   ========================================================================= */

export interface RoomGroupDetails {
  id: string;
  name: string;
  description: string | null;
  visibility: 'PUBLIC' | 'PRIVATE';
  status: string;
  market: string | null;
  provider: string | null;
  environment: string;
  createdAt: string;
  leader: { id: string; displayName: string };
}

export interface RoomGroupMember {
  id: string;
  displayName: string;
  role: 'LEADER' | 'MEMBER';
  joinedAt: string;
  /** The member's profile picture, as a signed delivery url. */
  avatarUrl?: string | null;
}

export function GroupDetailsPanel({
  room, members, memberCount, isMember, onJoin, onRequestSignIn, joining, joinError, signedIn,
}: {
  room: RoomGroupDetails | null;
  members: RoomGroupMember[];
  memberCount: number;
  isMember: boolean;
  onJoin: () => void;
  /** Opens the sign-in dialog. Used by the join button for a visitor. */
  onRequestSignIn: () => void;
  joining: boolean;
  joinError: string;
  signedIn: boolean;
}) {
  if (!room) return <PanelEmpty title="Loading room details…" />;

  /** The instrument the room is looking at. The leader chooses it. */
  const marketLabel = room.market || 'No instrument set';

  return (
    <div className="tr-details">
      <SectionLabel>Room</SectionLabel>
      <div className="tr-details-card">
        <h3 className="tr-details-name">{room.name}</h3>
        <div className="tr-details-tags">
          <span className="tr-chip is-muted">{room.visibility === 'PUBLIC' ? 'Public room' : 'Private room'}</span>
          <span className="tr-chip is-muted">{room.status}</span>
          <span className="tr-chip is-muted">{room.environment}</span>
        </div>
        {room.description
          ? <p className="tr-details-description">{room.description}</p>
          : <p className="tr-details-description is-empty">
              {isMember
                ? 'The leader has not written a description for this room yet.'
                : 'Join this room to read its description.'}
            </p>}
      </div>

      <SectionLabel>Leader</SectionLabel>
      <div className="tr-details-card">
        <div className="tr-details-row">
          <span className="tr-details-row-label">Mentor</span>
          <span className="tr-details-row-value">{room.leader.displayName}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Members</span>
          <span className="tr-details-row-value">{memberCount}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Market</span>
          <span className="tr-details-row-value">{marketLabel}</span>
        </div>
        <div className="tr-details-row">
          <span className="tr-details-row-label">Created</span>
          <span className="tr-details-row-value">{new Date(room.createdAt).toLocaleDateString()}</span>
        </div>
      </div>

      {members.length > 0 && (
        <>
          <SectionLabel>Who is here</SectionLabel>
          <div className="tr-details-roster">
            {members.map(member => (
              <div className="tr-details-member" key={member.id}>
                <UserAvatar
                  name={member.displayName}
                  url={member.avatarUrl}
                  size={25}
                  decorative
                  className="tr-agent-avatar"
                />
                <span className="tr-details-member-name">{member.displayName}</span>
                <span className="tr-chat-kind">{member.role === 'LEADER' ? 'Leader' : 'Member'}</span>
                <span className="tr-details-member-since">{relativeTime(member.joinedAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!isMember && (
        <button type="button" className="tr-chat-run" onClick={signedIn ? onJoin : onRequestSignIn} disabled={joining}>
          {signedIn ? <Users size={13} strokeWidth={2.4} aria-hidden="true" /> : <Lock size={13} strokeWidth={2.4} aria-hidden="true" />}
          {joining ? 'Joining…' : signedIn ? 'Join this room' : 'Sign in to join'}
        </button>
      )}
      {joinError && <p className="tr-panel-error" role="alert">{joinError}</p>}
    </div>
  );
}

/* =========================================================================
   PANEL — Connect Broker
   The member's OWN trading account, connected in Settings.

   This panel never shows a credential and never claims an account is
   connected unless the server verified it. The connection itself happens in
   the existing Settings screen, which owns the OAuth flow and the vault.
   ========================================================================= */

export interface BrokerConnectionState {
  cTrader: { configured: boolean; connected: boolean; selectedAccountId: string | null; selectedAccountIsLive: boolean } | null;
  propDao: { configured: boolean; connected: boolean } | null;
}

export function ConnectBrokerPanel({
  state, loading, error, onOpenSettings,
}: {
  state: BrokerConnectionState;
  loading: boolean;
  error: string;
  onOpenSettings: (section: 'ctrader' | 'propdao') => void;
}) {
  if (loading) return <PanelEmpty title="Checking your connections…" />;

  const cTrader = state.cTrader;
  const propDao = state.propDao;

  return (
    <div className="tr-broker">
      <p className="tr-panel-disclaimer">
        Connect the account you want to trade this room with. Your connection
        belongs to you — it is never shared with the room leader, and no
        credential is ever shown in the room.
      </p>

      <article className={'tr-broker-card' + (cTrader?.connected ? ' is-connected' : '')}>
        <div className="tr-broker-head">
          <span className="tr-broker-name">cTrader</span>
          {cTrader?.connected
            ? <span className="tr-broker-state is-connected"><CheckCircle2 size={12} /> Connected</span>
            : <span className="tr-broker-state"><AlertCircle size={12} /> Not connected</span>}
        </div>
        <p className="tr-broker-detail">
          {cTrader?.connected
            ? cTrader.selectedAccountId
              ? `Account ${cTrader.selectedAccountId}${cTrader.selectedAccountIsLive ? ' · LIVE' : ' · DEMO'}`
              : 'Authorized, but no trading account is selected yet.'
            : cTrader?.configured
              ? 'Not authorized on this account yet. Connect it to use cTrader prices and orders.'
              : 'cTrader is not configured on this deployment. Ask the operator to add the cTrader Open API credentials.'}
        </p>
        <button type="button" className="tr-broker-action" onClick={() => onOpenSettings('ctrader')}>
          {cTrader?.connected ? 'Manage cTrader account' : 'Connect cTrader'}
        </button>
      </article>

      <article className={'tr-broker-card' + (propDao?.connected ? ' is-connected' : '')}>
        <div className="tr-broker-head">
          <span className="tr-broker-name">PropDAO</span>
          {propDao?.connected
            ? <span className="tr-broker-state is-connected"><CheckCircle2 size={12} /> Connected</span>
            : <span className="tr-broker-state"><AlertCircle size={12} /> Not connected</span>}
        </div>
        <p className="tr-broker-detail">
          {propDao?.connected
            ? 'Your PropDAO key is stored and verified.'
            : propDao?.configured
              ? 'A key is saved but could not be verified. Open the settings to re-check it.'
              : 'No PropDAO key is saved on this account yet. Add one to connect a prop-firm account.'}
        </p>
        <button type="button" className="tr-broker-action" onClick={() => onOpenSettings('propdao')}>
          {propDao?.connected ? 'Manage PropDAO connection' : 'Connect PropDAO'}
        </button>
      </article>

      {error && <p className="tr-panel-error" role="alert">{error}</p>}
    </div>
  );
}

/* =========================================================================
   Shell
   ========================================================================= */

export interface SidebarTabBadge { news?: number; messages?: number }

export const TradeRoomSidebar: React.FC<{
  panel: RoomPanelId;
  onPanelChange: (panel: RoomPanelId) => void;
  /** Quote freshness — describes the panel content, so it lives in its header. */
  status: 'live' | 'stale' | 'unavailable';
  statusTitle: string;
  /**
   * The counts on the tabs.
   *
   * `messages` is the UNREAD count of the room chat, not the number of
   * messages the panel happens to have loaded.
   */
  badges: SidebarTabBadge;
}> = ({ panel, onPanelChange, status, statusTitle, badges }) => {
  const active = ROOM_PANELS.find(entry => entry.id === panel) ?? ROOM_PANELS[0];
  const badgeFor = (id: RoomPanelId) => (id === 'news' ? badges.news : id === 'chat' ? badges.messages : 0);

  return (
    <div className="trade-room-stream-header">
      <div className="tr-panel-titlebar">
        <h2 className="tr-panel-title">{active.label}</h2>
        <span className={'trade-room-identity-status is-' + status} title={statusTitle}>
          {status === 'live' ? 'Live' : status === 'stale' ? 'Stale' : 'No feed'}
        </span>
      </div>
      <div className="tr-panel-tabs" role="tablist" aria-label="Room panel">
        {ROOM_PANELS.map(entry => {
          const Icon = entry.icon;
          const badge = badgeFor(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="tr-panel-tab"
              aria-selected={entry.id === panel}
              aria-label={badge > 0 ? `${entry.label} (${badge})` : entry.label}
              title={badge > 0 ? `${entry.label} — ${badge}` : entry.label}
              onClick={() => onPanelChange(entry.id)}
            >
              <Icon size={15} strokeWidth={2} />
              {badge > 0 && <span className="tr-panel-tab-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export { NewsPanel, MarketPanel, cx, relativeTime, BIAS_TONE, money };
