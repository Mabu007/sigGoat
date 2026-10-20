/**
 * ROOM DIRECTORY
 * ==============
 * The list of trading rooms, and the sheet that creates one.
 *
 * THE SERVER IS THE SOURCE OF TRUTH
 * ---------------------------------
 * Every room on this screen comes from the rooms API:
 *
 *   GET /api/rooms?category=&q=&limit=   the public directory
 *   GET /api/rooms/mine                   the rooms the viewer owns or joined
 *
 * Nothing here invents a room, a member count, a cover or a live badge. The
 * cover comes from the media store, `memberCount` from the membership store,
 * and `live` from the server's session state — so a card that says a room is
 * live means a session is actually running in it.
 *
 * WHICH FILTERS ARE SERVER-SIDE
 * -----------------------------
 * The market categories (gold, forex, crypto, ...) are a server-side filter:
 * `category` is part of the query. "Public Rooms", "Private Rooms" and "My
 * Rooms" are client-side views: the first is the public directory itself, the
 * other two are filters over the viewer's own rooms.
 *
 * THE ROOM API DOES NOT CREATE ROOMS
 * ----------------------------------
 * Creation still goes through the room collection endpoint, and the settings
 * the directory owns (category, market tags, chart instrument) are applied
 * with a follow-up PATCH. A room can therefore exist for a moment without a
 * category, and the PATCH failing does not lose the room.
 *
 * A COVER CANNOT BE UPLOADED BEFORE THE ROOM EXISTS
 * -------------------------------------------------
 * The server ties a cover to a stored room, so there is nothing to attach one
 * to while the room is still being created. The sheet says so, and after the
 * room exists the share panel offers to open it, where the cover lives.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  CirclePlus,
  Copy,
  Globe,
  ImagePlus,
  Info,
  LockKeyhole,
  Radio,
  Rocket,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

/** The market categories the server knows about. */
type RoomCategory = 'gold' | 'forex' | 'crypto' | 'indices' | 'commodities' | 'general';
type RoomVisibility = 'PUBLIC' | 'PRIVATE';
type RoomRole = 'OWNER' | 'LEADER' | 'MEMBER' | 'GUEST';

const ROOM_CATEGORY_IDS: RoomCategory[] = ['gold', 'forex', 'crypto', 'indices', 'commodities', 'general'];

const CATEGORY_LABELS: Record<RoomCategory, string> = {
  gold: 'Gold',
  forex: 'Forex',
  crypto: 'Crypto',
  indices: 'Indices',
  commodities: 'Commodities',
  general: 'General',
};

/** One room, exactly as the rooms API returns it. */
interface RoomView {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: RoomVisibility;
  status: string;
  creatorName: string;
  memberCount: number;
  category: RoomCategory;
  markets: string[];
  chart: { symbol: string; timeframe: string };
  allowDrawings: boolean;
  voiceEnabled: boolean;
  coverUrl: string | null;
  live: boolean;
  /**
   * How many members hold a live connection right now. Null means the
   * server could not establish it, which is NOT the same as zero.
   */
  onlineCount: number | null;
  /** Whether the room's leader has a live connection. */
  mentorOnline: boolean | null;
  role: RoomRole;
  canManage: boolean;
  canChat: boolean;
  canDraw: boolean;
  canUseVoice: boolean;
  canRunSession: boolean;
  isMember: boolean;
  updatedAt: string;
  createdAt: string;
}

/** A directory tab. Some are server-side filters, some are client-side. */
type DirectoryMode = 'public' | 'private' | 'mine' | RoomCategory;

interface DirectoryCategory {
  id: DirectoryMode;
  label: string;
  /** The `category` query parameter, or null when the filter is client-side. */
  serverCategory: RoomCategory | null;
}

/**
 * The tabs, in the order they are read.
 *
 * The first three are client-side views (the public directory, the viewer's
 * private rooms, the viewer's rooms). The rest are server-side market
 * categories.
 */
const DIRECTORY_CATEGORIES: DirectoryCategory[] = [
  { id: 'public', label: 'Public Rooms', serverCategory: null },
  { id: 'private', label: 'Private Rooms', serverCategory: null },
  { id: 'mine', label: 'My Rooms', serverCategory: null },
  { id: 'gold', label: 'Gold', serverCategory: 'gold' },
  { id: 'forex', label: 'Forex', serverCategory: 'forex' },
  { id: 'crypto', label: 'Crypto', serverCategory: 'crypto' },
  { id: 'indices', label: 'Indices', serverCategory: 'indices' },
  { id: 'commodities', label: 'Commodities', serverCategory: 'commodities' },
  { id: 'general', label: 'General', serverCategory: 'general' },
];

/** The directory fetch is capped by the server; ask for as much as it serves. */
const DIRECTORY_LIMIT = 60;

/** The instruments the shared chart accepts. */
const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,24}$/;

/**
 * Normalises one room from the API.
 *
 * The server owns these fields; this only guarantees the shape the view
 * relies on, so a room missing an optional field still renders.
 */
function toRoomView(raw: any): RoomView {
  const category: RoomCategory = ROOM_CATEGORY_IDS.includes(raw?.category) ? raw.category : 'general';
  return {
    id: String(raw?.id ?? ''),
    slug: String(raw?.slug ?? raw?.id ?? ''),
    name: String(raw?.name ?? 'Trading room'),
    description: String(raw?.description ?? ''),
    visibility: raw?.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    status: String(raw?.status ?? ''),
    creatorName: String(raw?.creatorName ?? ''),
    memberCount: Number.isFinite(raw?.memberCount) ? Number(raw.memberCount) : 0,
    category,
    markets: Array.isArray(raw?.markets) ? raw.markets.filter((tag: unknown) => typeof tag === 'string') : [],
    chart: {
      symbol: String(raw?.chart?.symbol ?? ''),
      timeframe: String(raw?.chart?.timeframe ?? ''),
    },
    allowDrawings: raw?.allowDrawings !== false,
    voiceEnabled: raw?.voiceEnabled !== false,
    coverUrl: typeof raw?.coverUrl === 'string' && raw.coverUrl.length > 0 ? raw.coverUrl : null,
    live: raw?.live === true,
    onlineCount: typeof raw?.onlineCount === 'number' ? raw.onlineCount : null,
    mentorOnline: typeof raw?.mentorOnline === 'boolean' ? raw.mentorOnline : null,
    role: (raw?.role ?? 'GUEST') as RoomRole,
    canManage: raw?.canManage === true,
    canChat: raw?.canChat === true,
    canDraw: raw?.canDraw === true,
    canUseVoice: raw?.canUseVoice === true,
    canRunSession: raw?.canRunSession === true,
    isMember: raw?.isMember === true,
    updatedAt: String(raw?.updatedAt ?? ''),
    createdAt: String(raw?.createdAt ?? ''),
  };
}

/** Free-text market tags: "XAUUSD, EURUSD" -> ["XAUUSD", "EURUSD"]. */
function parseMarketTags(raw: string): string[] {
  const tags = raw
    .split(/[^A-Za-z0-9._-]+/)
    .map(tag => tag.trim().toUpperCase())
    .filter(tag => tag.length > 0 && tag.length <= 24);
  return Array.from(new Set(tags)).slice(0, 12);
}

export function TradeRoomsView({
  createTeamRequested,
  onCreateTeamRequestHandled,
  showDirectoryContent = true,
  onOpenRoom,
  onShowDirectory,
}: {
  createTeamRequested: boolean;
  onCreateTeamRequestHandled: () => void;
  showDirectoryContent?: boolean;
  onOpenRoom: (type: 'team' | 'bot', slug: string, backLabel: string) => void;
  onShowDirectory: () => void;
}) {
  const { currentUser, authMode, getApiAuthHeaders, openAuthModal } = useAuth();

  /** Dev auth mode has no Firebase user, but the server still knows who it is. */
  const signedIn = Boolean(currentUser) || authMode === 'dev';

  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>('public');
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [query, setQuery] = useState('');

  const [myRooms, setMyRooms] = useState<RoomView[]>([]);
  const [myRoomsLoading, setMyRoomsLoading] = useState(false);

  /* ---- room builder state ---- */
  const [createOpen, setCreateOpen] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomDescription, setRoomDescription] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('PRIVATE');
  const [category, setCategory] = useState<RoomCategory>('general');
  const [marketTags, setMarketTags] = useState('');
  const [chartSymbol, setChartSymbol] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  const [createdShareUrl, setCreatedShareUrl] = useState('');
  const [createdRoomSlug, setCreatedRoomSlug] = useState('');

  /**
   * The header's search box talks to this view through a DOM event, because
   * the header lives above the router and the directory may not be mounted.
   *
   * The event is named after the product. The pre-rename name is still
   * accepted, so an old tab — or anything else still dispatching it — keeps
   * driving the search.
   */
  useEffect(() => {
    const onDirectorySearch = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setQuery(typeof detail === 'string' ? detail : '');
    };
    window.addEventListener('tradingvibes-directory-search', onDirectorySearch);
    window.addEventListener('sirgoat-directory-search', onDirectorySearch);
    return () => {
      window.removeEventListener('tradingvibes-directory-search', onDirectorySearch);
      window.removeEventListener('sirgoat-directory-search', onDirectorySearch);
    };
  }, []);

  /** The category filter of the current tab, or null for the client-side ones. */
  const activeCategory = useMemo(
    () => DIRECTORY_CATEGORIES.find(item => item.id === directoryMode)?.serverCategory ?? null,
    [directoryMode],
  );

  /** "My Rooms" and "Private Rooms" read the viewer's own rooms. */
  const usesMyRooms = directoryMode === 'mine' || directoryMode === 'private';

  /**
   * Headers for a request that is allowed to be anonymous.
   *
   * The public directory needs no session, so a failure to build auth
   * headers is not an error here — the request simply goes out unsigned.
   * Sending them when they exist costs nothing and keeps the directory
   * working on deployments whose legacy API router authenticates every /api
   * path before the rooms router is reached.
   */
  const optionalAuthHeaders = useCallback(async (): Promise<Headers> => {
    const headers = new Headers({ Accept: 'application/json' });
    try {
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
    } catch {
      /* Signed out, or the server has no auth configured. The directory is public. */
    }
    return headers;
  }, [getApiAuthHeaders]);

  const loadPublicRooms = useCallback(
    async (categoryFilter: RoomCategory | null, search: string, signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (categoryFilter) params.set('category', categoryFilter);
        const needle = search.trim();
        if (needle) params.set('q', needle);
        params.set('limit', String(DIRECTORY_LIMIT));

        const response = await fetch(`/api/rooms?${params.toString()}`, {
          headers: await optionalAuthHeaders(),
          cache: 'no-store',
          signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          /**
           * The directory is a public list, so a refusal means the deployment
           * insists on a session for it. Saying so plainly beats showing a
           * raw "Missing Authorization" header error.
           */
          if (response.status === 401) {
            setAuthRequired(true);
            throw new Error('Sign in to browse the room directory on this deployment.');
          }
          throw new Error(body?.error?.message || 'Could not load the room directory.');
        }

        setAuthRequired(false);
        const list: RoomView[] = (Array.isArray(body.rooms) ? body.rooms : []).map(toRoomView);
        setRooms(list);
        setTotal(Number.isFinite(body.total) ? Number(body.total) : list.length);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load the room directory.');
        setRooms([]);
        setTotal(0);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [optionalAuthHeaders],
  );

  const loadMyRooms = useCallback(
    async (signal?: AbortSignal) => {
      setMyRoomsLoading(true);
      setError('');
      try {
        const headers = new Headers({ Accept: 'application/json' });
        for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);

        const response = await fetch('/api/rooms/mine', { headers, cache: 'no-store', signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || 'Could not load your rooms.');

        const list: RoomView[] = (Array.isArray(body.rooms) ? body.rooms : []).map(toRoomView);
        setMyRooms(list);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load your rooms.');
        setMyRooms([]);
      } finally {
        if (!signal?.aborted) setMyRoomsLoading(false);
      }
    },
    [getApiAuthHeaders],
  );

  /**
   * The public directory is fetched from the server, category and search
   * included, so the list is always the server's answer.
   *
   * The session is a dependency too: signing in retries the request with
   * credentials, which is what a deployment that insists on a session needs.
   */
  useEffect(() => {
    if (usesMyRooms) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadPublicRooms(activeCategory, query, controller.signal);
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [usesMyRooms, activeCategory, query, signedIn, loadPublicRooms]);

  /** The viewer's own rooms: a different query, scoped to the viewer. */
  useEffect(() => {
    if (!usesMyRooms) return;
    if (!signedIn) {
      setMyRooms([]);
      setMyRoomsLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadMyRooms(controller.signal);
    return () => controller.abort();
  }, [usesMyRooms, signedIn, loadMyRooms]);

  /**
   * Every entry point starts from a blank draft, so a second room never
   * silently inherits the first one's name or description.
   */
  const openCreateRoom = useCallback(() => {
    setRoomName('');
    setRoomDescription('');
    setVisibility('PRIVATE');
    setCategory('general');
    setMarketTags('');
    setChartSymbol('');
    setCreateError('');
    setCreateNotice('');
    setCreatedShareUrl('');
    setCreatedRoomSlug('');
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    if (!createTeamRequested) return;
    openCreateRoom();
    onCreateTeamRequestHandled();
  }, [createTeamRequested, openCreateRoom, onCreateTeamRequestHandled]);

  /* Escape closes, and the page behind must not scroll while the sheet is up. */
  useEffect(() => {
    if (!createOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setCreateOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [createOpen, saving]);

  /**
   * The rooms on screen.
   *
   * The server-side tabs show exactly what the server returned. The
   * viewer's own rooms are filtered here, because "private" and "a search
   * term" are not server filters on that endpoint.
   */
  const visibleRooms = useMemo(() => {
    if (!usesMyRooms) return rooms;
    const needle = query.trim().toLowerCase();
    return myRooms.filter(room => {
      if (directoryMode === 'private' && room.visibility !== 'PRIVATE') return false;
      if (!needle) return true;
      const searchable = [room.name, room.description, room.creatorName, room.category, ...(room.markets || [])]
        .join(' ')
        .toLowerCase();
      return searchable.includes(needle);
    });
  }, [usesMyRooms, rooms, myRooms, directoryMode, query]);

  const directoryLabels: Record<DirectoryMode, string> = useMemo(() => {
    const labels = {} as Record<DirectoryMode, string>;
    for (const item of DIRECTORY_CATEGORIES) labels[item.id] = item.label;
    return labels;
  }, []);

  /**
   * Creates the room, then applies the directory settings to it.
   *
   * A room only needs a name. Everything else has a default, so the sheet
   * never blocks creation on a question the creator does not have to answer.
   */
  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError('');
    setCreateNotice('');

    if (!signedIn) {
      setCreateError('Sign in to create your room.');
      openAuthModal('signup');
      return;
    }
    if (!roomName.trim()) {
      setCreateError('Give your room a name.');
      return;
    }

    setSaving(true);
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);

      /**
       * ONE REQUEST CREATES THE ROOM WITH ITS SETTINGS.
       *
       * The category, the market tags and the chart instrument are part of
       * the room, so they are part of its creation. A second request to
       * apply them would leave a window where the room exists with the
       * wrong settings.
       */
      const settings: Record<string, unknown> = {
        category,
        markets: parseMarketTags(marketTags),
      };
      const symbol = chartSymbol.trim().toUpperCase();
      if (SYMBOL_PATTERN.test(symbol)) settings.chart = { symbol };

      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: roomName.trim(),
          description: roomDescription.trim(),
          visibility,
          ...settings,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body.room) throw new Error(body?.error?.message || 'Could not create the room.');

      const roomId = String(body.room?.id ?? '');
      const roomSlug = String(body.room?.slug ?? body.room?.id ?? '');
      const settingsWarning = '';

      if (roomSlug) {
        setCreatedShareUrl(new URL(`/team/${roomSlug}`, window.location.origin).toString());
      }
      setCreatedRoomSlug(roomSlug);
      setCreateNotice(
        [
          visibility === 'PUBLIC'
            ? 'Your room is live and listed in the directory.'
            : 'Your room is ready. Share its link to invite people in.',
          settingsWarning,
        ]
          .filter(Boolean)
          .join(' '),
      );

      await Promise.all([loadPublicRooms(activeCategory, query), loadMyRooms()]);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the room.');
    } finally {
      setSaving(false);
    }
  };

  const showingLoading = usesMyRooms ? myRoomsLoading : loading;

  return (
    <div className="space-y-6">
      {showDirectoryContent && (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="yt-room-filters flex flex-wrap gap-2" role="group" aria-label="Room categories">
              {DIRECTORY_CATEGORIES.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onShowDirectory();
                    setDirectoryMode(item.id);
                    setQuery('');
                  }}
                  aria-pressed={directoryMode === item.id}
                  className={directoryMode === item.id ? 'yt-room-filter is-active' : 'yt-room-filter'}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-fg-muted">
              {usesMyRooms
                ? myRoomsLoading
                  ? 'Loading your rooms…'
                  : `${visibleRooms.length} ${visibleRooms.length === 1 ? 'room' : 'rooms'}`
                : loading
                  ? 'Loading rooms…'
                  : `${total} ${total === 1 ? 'room' : 'rooms'}`}
            </p>
          </div>
        </section>
      )}

      {showDirectoryContent && (
        <>
          {error && (
            <div role="alert" className="panel flex flex-wrap items-center justify-between gap-3 border-warning/40 p-4 text-sm text-fg-muted">
              <span>{error}</span>
              {authRequired && !signedIn ? (
                <button type="button" onClick={() => openAuthModal('signin')} className="btn btn-secondary">
                  <Users size={15} /> Sign in
                </button>
              ) : null}
            </div>
          )}

          {usesMyRooms && !signedIn ? (
            <div className="panel px-5 py-12 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text">
                <LockKeyhole size={22} />
              </div>
              <h3 className="mt-4 font-semibold text-fg">Sign in to see your rooms</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
                The rooms you lead and the rooms you have joined are yours alone. Browsing the directory never needs an account.
              </p>
              <button type="button" onClick={() => openAuthModal('signin')} className="btn btn-primary mt-5">
                <Users size={15} /> Sign in
              </button>
            </div>
          ) : showingLoading ? (
            <div className="panel p-8 text-center text-sm text-fg-muted">Loading rooms…</div>
          ) : visibleRooms.length ? (
            <div className="yt-room-grid">
              {visibleRooms.map(room => {
                const categoryLabel = CATEGORY_LABELS[room.category] ?? 'General';
                const isPrivate = room.visibility === 'PRIVATE';
                const marketLabel = (room.markets || []).slice(0, 2).join(' · ') || room.chart?.symbol || 'SOCIAL TRADING';
                return (
                  <article key={room.id || room.slug} className="yt-room-card group">
                    <button
                      type="button"
                      onClick={() => onOpenRoom('team', room.slug, directoryLabels[directoryMode])}
                      className="block w-full min-w-0 text-left"
                    >
                      <div className="yt-room-thumbnail">
                        {room.coverUrl ? (
                          <img
                            src={room.coverUrl}
                            alt=""
                            loading="lazy"
                            className="absolute inset-0 z-0 h-full w-full object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 z-0">
                            <div className="absolute inset-0 bg-gradient-to-br from-raised via-sunken to-raised opacity-80" />
                            <div className="absolute inset-0 opacity-70 bg-[radial-gradient(circle_at_1px_1px,var(--color-line-strong)_1px,transparent_0)] [background-size:14px_14px]" />
                            <div className="relative z-10 flex h-full flex-col items-center justify-center gap-1.5">
                              <ImagePlus size={20} className="text-fg-subtle" aria-hidden="true" />
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
                                No cover
                              </span>
                            </div>
                          </div>
                        )}

                        {/**
                         * THE COVER IS THE CARD.
                         *
                         * The thumbnail carries the cover image and at most
                         * two small facts: whether a session is running,
                         * and how many members are online right now. The
                         * market label, the visibility label and the
                         * category label used to be repeated here AND
                         * below the image, which is noise over the one
                         * thing the card is for.
                         */}
                        {room.live ? (
                          <span className="yt-thumb-live">
                            <Radio size={10} aria-hidden="true" /> LIVE
                          </span>
                        ) : null}

                        <span className="yt-thumb-play" aria-hidden="true">
                          <ArrowUpRight size={21} />
                        </span>
                        <span className="yt-thumb-online">
                          {room.onlineCount === null ? (
                            <span className="yt-thumb-online-unknown">online &mdash;</span>
                          ) : (
                            <>
                              <span className="yt-thumb-online-dot" aria-hidden="true" />
                              {room.onlineCount} online
                            </>
                          )}
                        </span>
                      </div>

                      <div className="yt-room-meta">
                        <div className="min-w-0 flex-1">
                          <h3 className="yt-room-title">{room.name}</h3>
                          <p className="yt-room-creator">
                            {room.creatorName || 'Room leader'}
                            <span aria-hidden="true"> · </span>
                            {room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}
                            {room.mentorOnline === true ? (
                              <span className="yt-room-mentor-line"> · mentor online</span>
                            ) : room.mentorOnline === false ? (
                              <span className="yt-room-mentor-line is-offline"> · mentor offline</span>
                            ) : null}
                          </p>
                          <p className="yt-room-description">{room.description || 'A room for sharing market analysis.'}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span className="badge badge-neutral">{categoryLabel}</span>
                            {isPrivate ? (
                              <span className="badge badge-neutral">
                                <LockKeyhole size={10} aria-hidden="true" /> Private
                              </span>
                            ) : null}
                            {room.markets?.length ? (
                              <span className="badge badge-neutral">{room.markets.slice(0, 2).join(' · ')}</span>
                            ) : null}
                            {/**
                             * ONE ACTION.
                             *
                             * The whole card opens the room, and the
                             * affordance says so once, in words, instead of
                             * a second label competing with the title.
                             */}
                            <span className="yt-room-open">Open</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="panel px-5 py-12 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text">
                <Users size={22} />
              </div>
              <h3 className="mt-4 font-semibold text-fg">
                {usesMyRooms
                  ? directoryMode === 'private'
                    ? 'No private rooms yet'
                    : 'No rooms yet'
                  : activeCategory
                    ? 'No rooms match this category'
                    : 'No public rooms yet'}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
                {usesMyRooms
                  ? 'The rooms you lead and the rooms you have joined will appear here. Create one to get started.'
                  : activeCategory
                    ? 'Try another name or choose a different room category.'
                    : 'No public rooms match this category yet. Lead a room of your own and it will be listed here.'}
              </p>
              <button type="button" onClick={openCreateRoom} className="btn btn-primary mt-5">
                <CirclePlus size={15} /> Create a room
              </button>
            </div>
          )}

          {createOpen && (
            <div
              className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
              role="presentation"
              onMouseDown={event => {
                if (event.target === event.currentTarget && !saving) setCreateOpen(false);
              }}
            >
              <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="create-room-title"
                className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-2xl sm:rounded-2xl"
              >
                <header className="flex items-start justify-between gap-4 border-b border-line p-5">
                  <div className="min-w-0">
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text">
                      <Users size={19} />
                    </div>
                    <h2 id="create-room-title" className="text-xl font-semibold text-fg">
                      Create a room
                    </h2>
                    <p className="mt-1 text-sm leading-5 text-fg-muted">
                      Name it, describe how you trade, and open it. You lead the room.
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Close"
                    disabled={saving}
                    onClick={() => setCreateOpen(false)}
                    className="rounded-lg p-2 text-fg-muted hover:bg-raised"
                  >
                    <X size={18} />
                  </button>
                </header>

                {createdShareUrl ? (
                  <div className="overflow-y-auto p-5">
                    <div className="rounded-xl border border-line bg-raised p-4">
                      <p className="text-sm font-semibold text-fg">Your room link</p>
                      {createNotice && (
                        <p role="status" className="mt-2 rounded-lg border border-positive/40 bg-positive-soft p-2.5 text-xs leading-5 text-fg">
                          {createNotice}
                        </p>
                      )}
                      <p className="mt-1 break-all text-xs text-fg-muted">{createdShareUrl}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard?.writeText(createdShareUrl)}
                          className="btn btn-secondary"
                        >
                          <Copy size={14} /> Copy link
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCreateOpen(false);
                            if (createdRoomSlug) onOpenRoom('team', createdRoomSlug, 'Rooms');
                          }}
                          className="btn btn-primary"
                        >
                          Open room
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCreateOpen(false);
                            if (createdRoomSlug) onOpenRoom('team', createdRoomSlug, 'Rooms');
                          }}
                          className="btn btn-secondary"
                        >
                          <ImagePlus size={14} /> Add a cover
                        </button>
                      </div>
                      <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-line bg-surface p-3 text-[11px] leading-5 text-fg-muted">
                        <ImagePlus size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span>
                          A cover can only be added once the room exists, because the server attaches it to the room
                          itself. Open the room and add it from the room&rsquo;s settings.
                        </span>
                      </p>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={event => void createRoom(event)} className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-fg-muted">Room name</span>
                        <input
                          autoFocus
                          maxLength={80}
                          value={roomName}
                          onChange={event => setRoomName(event.target.value)}
                          className="input"
                          placeholder="e.g. London Breakout Desk"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-fg-muted">Room description</span>
                        <textarea
                          rows={4}
                          maxLength={2000}
                          value={roomDescription}
                          onChange={event => setRoomDescription(event.target.value)}
                          className="input"
                          placeholder={
                            'e.g. We trade the London open. Post the level you are watching before 07:00 and I will post the setup I am taking.\n\nMinimum 1.5R. No trades outside London and New York.'
                          }
                        />
                        <span className="mt-1.5 block text-[11px] leading-4 text-fg-subtle">
                          This is what members read when they arrive. Say what you trade, when, and what you want from them.
                        </span>
                      </label>

                      <div>
                        <span className="mb-2 block text-xs font-medium text-fg-muted">Who can see it?</span>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setVisibility('PRIVATE')}
                            aria-pressed={visibility === 'PRIVATE'}
                            className={`rounded-xl border p-3 text-left ${
                              visibility === 'PRIVATE' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'
                            }`}
                          >
                            <LockKeyhole size={16} className="text-accent-text" />
                            <span className="mt-2 block text-sm font-semibold text-fg">Private</span>
                            <span className="mt-1 block text-[11px] text-fg-muted">
                              Only people with your link can view and join it.
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setVisibility('PUBLIC')}
                            aria-pressed={visibility === 'PUBLIC'}
                            className={`rounded-xl border p-3 text-left ${
                              visibility === 'PUBLIC' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'
                            }`}
                          >
                            <Globe size={16} className="text-accent-text" />
                            <span className="mt-2 block text-sm font-semibold text-fg">Public</span>
                            <span className="mt-1 block text-[11px] text-fg-muted">
                              Listed in the room directory for anyone to find.
                            </span>
                          </button>
                        </div>
                      </div>

                      <div>
                        <span className="mb-2 block text-xs font-medium text-fg-muted">Market category</span>
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Market category">
                          {ROOM_CATEGORY_IDS.map(id => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setCategory(id)}
                              aria-pressed={category === id}
                              className={
                                category === id
                                  ? 'yt-room-filter is-active'
                                  : 'yt-room-filter border-line bg-raised text-fg-muted'
                              }
                            >
                              {CATEGORY_LABELS[id]}
                            </button>
                          ))}
                        </div>
                        <span className="mt-1.5 block text-[11px] leading-4 text-fg-subtle">
                          The category decides which tab the room is listed under. You can change it later.
                        </span>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-fg-muted">Markets</span>
                          <input
                            value={marketTags}
                            onChange={event => setMarketTags(event.target.value)}
                            className="input"
                            placeholder="XAUUSD, EURUSD"
                          />
                          <span className="mt-1.5 block text-[11px] leading-4 text-fg-subtle">
                            The instruments you trade. Comma separated.
                          </span>
                        </label>
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-fg-muted">Chart instrument</span>
                          <input
                            value={chartSymbol}
                            onChange={event => setChartSymbol(event.target.value)}
                            className="input"
                            placeholder="XAUUSD"
                            maxLength={24}
                          />
                          <span className="mt-1.5 block text-[11px] leading-4 text-fg-subtle">
                            Optional. The chart the room opens on.
                          </span>
                        </label>
                      </div>

                      <p className="flex items-start gap-1.5 rounded-lg border border-line bg-raised p-3 text-[11px] leading-5 text-fg-muted">
                        <Info size={13} className="mt-0.5 shrink-0" />
                        <span>
                          A name is all a room needs. You can change the name, the description, the category, the markets,
                          the chart instrument and who can see the room at any time — and add a cover image once the room
                          exists.
                        </span>
                      </p>

                      {createError && (
                        <p role="alert" className="rounded-lg border border-negative/40 bg-negative-soft p-3 text-xs leading-5 text-fg">
                          {createError}
                        </p>
                      )}
                    </div>

                    <footer className="flex flex-wrap gap-2 border-t border-line p-5">
                      <button type="button" disabled={saving} onClick={() => setCreateOpen(false)} className="btn btn-secondary flex-1">
                        Cancel
                      </button>
                      <button type="submit" disabled={saving || !roomName.trim()} className="btn btn-primary flex-1">
                        {saving ? 'Creating…' : (
                          <>
                            <Rocket size={15} /> Create room
                          </>
                        )}
                      </button>
                    </footer>
                  </form>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
