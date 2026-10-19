import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, CirclePlus, Copy, Globe, Info, LockKeyhole, Rocket, Search, Users, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

type TradeRoom = {
  slug: string;
  name: string;
  description: string;
  markets: string[];
  status: string;
  creatorName: string;
  publishedAt?: string;
  updatedAt?: string;
  mode: 'PAPER' | 'TEAM';
  latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string };
  roomType?: 'bot' | 'team';
  memberCount?: number;
  environment?: 'DEMO' | 'LIVE';
  marketDataProvider?: string | null;
  visibility?: TeamVisibility;
};
type TeamVisibility = 'PUBLIC' | 'PRIVATE';
type DirectoryMode = 'public' | 'private' | 'gold' | 'euro' | 'crypto' | 'forex' | 'mine';

/**
 * A room is a community. It has a name, a description, a leader and a
 * membership — nothing else is required to create one.
 */
const ROOM_CATEGORIES: Array<{ id: DirectoryMode; label: string }> = [
  { id: 'public', label: 'Public Rooms' },
  { id: 'private', label: 'Private Rooms' },
  { id: 'gold', label: 'Gold Rooms' },
  { id: 'euro', label: 'Euro Rooms' },
  { id: 'crypto', label: 'Crypto Rooms' },
  { id: 'forex', label: 'Forex Rooms' },
  { id: 'mine', label: 'My Rooms' },
];

const MARKET_KEYWORDS: Record<string, RegExp> = {
  gold: /gold|xau|gld|silver|xag/i,
  euro: /euro|eur|eurchf|eurusd/i,
  crypto: /btc|bitcoin|eth|ethereum|sol|crypto|hyperliquid|xrp|doge/i,
  forex: /forex|fx|eurusd|gbpusd|usd[jc]|audusd|nzdusd/i,
};

export function TradeRoomsView({ createTeamRequested, onCreateTeamRequestHandled, showDirectoryContent = true, onOpenRoom, onShowDirectory }: { createTeamRequested: boolean; onCreateTeamRequestHandled: () => void; showDirectoryContent?: boolean; onOpenRoom: (type: 'team' | 'bot', slug: string, backLabel: string) => void; onShowDirectory: () => void }) {
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const [rooms, setRooms] = useState<TradeRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  // Sync the global YouTube-style header search with the room directory search.
  useEffect(() => {
    const onDirectorySearch = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setQuery(typeof detail === 'string' ? detail : '');
    };
    window.addEventListener('sirgoat-directory-search', onDirectorySearch);
    return () => window.removeEventListener('sirgoat-directory-search', onDirectorySearch);
  }, []);
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>('public');
  const [myRooms, setMyRooms] = useState<TradeRoom[]>([]);
  const [myRoomsLoading, setMyRoomsLoading] = useState(false);

  /* ---- room builder state ---- */
  const [createOpen, setCreateOpen] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomDescription, setRoomDescription] = useState('');
  const [visibility, setVisibility] = useState<TeamVisibility>('PRIVATE');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  const [createdShareUrl, setCreatedShareUrl] = useState('');

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/goat-teams/public', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Could not load the room directory.');
      const teams: TradeRoom[] = (Array.isArray(body.rooms) ? body.rooms : []).map((room: TradeRoom) => ({ ...room, roomType: 'team' as const }));
      setRooms(teams.sort((a, b) => (b.updatedAt || b.publishedAt || '').localeCompare(a.updatedAt || a.publishedAt || '')));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the room directory.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadRooms(); }, [loadRooms]);

  const loadMyRooms = useCallback(async () => {
    if (!currentUser && authMode !== 'dev') { setError('Sign in to see your rooms.'); return; }
    setMyRoomsLoading(true); setError('');
    try {
      const headers = new Headers({ Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/goat-teams', { headers, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Could not load your rooms.');
      const teams: TradeRoom[] = (Array.isArray(body.teams) ? body.teams : []).map((team: any) => ({
        slug: team.publicSlug || team.id, name: team.name,
        description: team.instructions || team.description || 'Your trading room.',
        markets: team.deployment?.asset ? [team.deployment.asset] : [],
        status: team.status || 'SAVED', creatorName: 'You', publishedAt: team.createdAt, updatedAt: team.updatedAt,
        mode: 'TEAM', latestThesis: null, roomType: 'team',
        visibility: team.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
        environment: team.environment || 'DEMO', marketDataProvider: team.marketDataProvider || 'biquote',
      }));
      setMyRooms(teams);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load your rooms.'); }
    finally { setMyRoomsLoading(false); }
  }, [currentUser, authMode, getApiAuthHeaders]);

  /**
   * Every entry point starts from a blank draft, so a second room never
   * silently inherits the first one's name or description.
   */
  const openCreateRoom = useCallback(() => {
    setRoomName('');
    setRoomDescription('');
    setVisibility('PRIVATE');
    setCreateError('');
    setCreateNotice('');
    setCreatedShareUrl('');
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
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [createOpen, saving]);

  const visibleRooms = directoryMode === 'mine' || directoryMode === 'private' ? myRooms : rooms;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleRooms.filter(room => {
      const searchable = [room.name, room.description, room.creatorName, ...(room.markets || [])].join(' ').toLowerCase();
      const matchesText = !needle || searchable.includes(needle);
      const matchesCategory = directoryMode === 'private'
        ? room.visibility === 'PRIVATE'
        : MARKET_KEYWORDS[directoryMode]
          ? MARKET_KEYWORDS[directoryMode].test(searchable)
          : true;
      return matchesText && matchesCategory;
    });
  }, [visibleRooms, query, directoryMode]);

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError(''); setCreateNotice('');
    if (!currentUser && authMode !== 'dev') { setCreateError('Sign in first to create your room.'); return; }
    if (!roomName.trim()) { setCreateError('Give your room a name.'); return; }

    setSaving(true);
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/goat-teams', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: roomName.trim(),
          instructions: roomDescription.trim(),
          visibility,
          monitoringIntervals: [15],
          deploy: false,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body.team) throw new Error(body?.error?.message || 'Could not create the room.');

      if (body.shareUrl) setCreatedShareUrl(new URL(body.shareUrl, window.location.origin).toString());
      await loadMyRooms().catch(() => {});
      await loadRooms();
      setCreateNotice(visibility === 'PUBLIC'
        ? 'Your room is live and listed in the directory.'
        : 'Your room is ready. Share its link to invite people in.');
    } catch (err) { setCreateError(err instanceof Error ? err.message : 'Could not create the room.'); }
    finally { setSaving(false); }
  };

  const directoryLabels: Record<DirectoryMode, string> = { public: 'Public Rooms', private: 'Private Rooms', gold: 'Gold Rooms', euro: 'Euro Rooms', crypto: 'Crypto Rooms', forex: 'Forex Rooms', mine: 'My Rooms' };

  return (
    <div className="space-y-6">
      {showDirectoryContent && <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="yt-room-filters flex flex-wrap gap-2" role="group" aria-label="Room categories">
            {ROOM_CATEGORIES.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onShowDirectory();
                  setDirectoryMode(item.id);
                  setQuery('');
                  if (item.id === 'mine' || item.id === 'private') void loadMyRooms();
                  else setError('');
                }}
                aria-pressed={directoryMode === item.id}
                className={directoryMode === item.id ? 'yt-room-filter is-active' : 'yt-room-filter'}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-fg-muted">
            {directoryMode === 'mine' || directoryMode === 'private' ? (myRoomsLoading ? 'Loading your rooms…' : filtered.length + ' rooms') : (loading ? 'Loading rooms…' : filtered.length + ' rooms')}
          </p>
        </div>
      </section>}

      {showDirectoryContent && <>
      {error && <div role="alert" className="panel border-warning/40 p-4 text-sm text-fg-muted">{error}</div>}

      {((directoryMode === 'mine' || directoryMode === 'private') ? myRoomsLoading : loading) ? (
        <div className="panel p-8 text-center text-sm text-fg-muted">Loading rooms…</div>
      ) : filtered.length ? (
        <div className="yt-room-grid">
          {filtered.map(room => {
            const marketLabel = (room.markets || []).slice(0, 2).join(' · ') || 'SOCIAL TRADING';
            const isPrivate = room.visibility === 'PRIVATE';
            return (
              <article key={room.slug} className="yt-room-card group">
                <button type="button" onClick={() => onOpenRoom('team', room.slug, directoryLabels[directoryMode])} className="block w-full min-w-0 text-left">
                  <div className="yt-room-thumbnail">
                    <div className="yt-thumb-topline">
                      <span className="yt-thumb-market">{marketLabel}</span>
                      <span className="yt-thumb-mode">{isPrivate ? 'PRIVATE' : 'OPEN'}</span>
                    </div>
                    <svg viewBox="0 0 480 180" preserveAspectRatio="none" aria-hidden="true" className="yt-thumb-chart">
                      <path d="M0 142 L35 128 L63 139 L92 94 L119 109 L145 77 L176 91 L204 58 L230 81 L256 49 L286 70 L314 42 L341 58 L369 29 L398 47 L426 24 L455 38 L480 17 L480 180 L0 180 Z" fill="var(--color-accent)" fillOpacity=".12" />
                      <path d="M0 142 L35 128 L63 139 L92 94 L119 109 L145 77 L176 91 L204 58 L230 81 L256 49 L286 70 L314 42 L341 58 L369 29 L398 47 L426 24 L455 38 L480 17" fill="none" stroke="var(--color-accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
                      {[40, 90, 140].map(y => <line key={y} x1="0" x2="480" y1={y} y2={y} stroke="currentColor" strokeOpacity=".09" strokeDasharray="4 6" />)}
                    </svg>
                    <span className="yt-thumb-play" aria-hidden="true"><ArrowUpRight size={21} /></span>
                    <span className="yt-thumb-duration">{isPrivate ? 'INVITE ONLY' : 'OPEN ROOM'}</span>
                  </div>
                  <div className="yt-room-meta">
                    <div className="yt-room-avatar" aria-hidden="true"><Users size={18} /></div>
                    <div className="min-w-0 flex-1">
                      <h3 className="yt-room-title">{room.name}</h3>
                      <p className="yt-room-creator">{room.creatorName || 'Room leader'} <span aria-hidden="true">·</span> {room.status === 'DEPLOYED' ? 'LIVE' : room.status}</p>
                      <p className="yt-room-description">{room.description || 'A room for sharing market analysis.'}</p>
                    </div>
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel px-5 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Users size={22} /></div>
          <h3 className="mt-4 font-semibold text-fg">{visibleRooms.length ? 'No rooms match this category' : directoryMode === 'mine' || directoryMode === 'private' ? 'No private rooms yet' : 'No public rooms yet'}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            {visibleRooms.length ? 'Try another name or choose a different room category.' : directoryMode === 'mine' || directoryMode === 'private' ? 'The rooms you lead will appear here. Create one to get started.' : 'No public rooms match this category yet. Lead a room of your own and it will be listed here.'}
          </p>
          <button type="button" onClick={openCreateRoom} className="btn btn-primary mt-5"><CirclePlus size={15} /> Create a room</button>
        </div>
      )}

      {createOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget && !saving) setCreateOpen(false); }}
        >
          <section role="dialog" aria-modal="true" aria-labelledby="create-room-title" className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-2xl sm:rounded-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-line p-5">
              <div className="min-w-0">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Users size={19} /></div>
                <h2 id="create-room-title" className="text-xl font-semibold text-fg">Create a room</h2>
                <p className="mt-1 text-sm leading-5 text-fg-muted">Name it, describe how you trade, and open it. You lead the room.</p>
              </div>
              <button type="button" aria-label="Close" disabled={saving} onClick={() => setCreateOpen(false)} className="rounded-lg p-2 text-fg-muted hover:bg-raised"><X size={18} /></button>
            </header>

            {createdShareUrl ? (
              <div className="overflow-y-auto p-5">
                <div className="rounded-xl border border-line bg-raised p-4">
                  <p className="text-sm font-semibold text-fg">Your room link</p>
                  {createNotice && <p role="status" className="mt-2 rounded-lg border border-positive/40 bg-positive-soft p-2.5 text-xs leading-5 text-fg">{createNotice}</p>}
                  <p className="mt-1 break-all text-xs text-fg-muted">{createdShareUrl}</p>
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(createdShareUrl)} className="btn btn-secondary mt-3"><Copy size={14} /> Copy link</button>
                  <button type="button" onClick={() => { setCreateOpen(false); window.location.href = createdShareUrl; }} className="btn btn-primary ml-2 mt-3">Open room</button>
                </div>
              </div>
            ) : (
              <form onSubmit={event => void createRoom(event)} className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-fg-muted">Room name</span>
                    <input autoFocus maxLength={80} value={roomName} onChange={event => setRoomName(event.target.value)} className="input" placeholder="e.g. London Breakout Desk" />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-fg-muted">Room description</span>
                    <textarea
                      rows={5}
                      maxLength={4000}
                      value={roomDescription}
                      onChange={event => setRoomDescription(event.target.value)}
                      className="input"
                      placeholder={'e.g. We trade the London open. Post the level you are watching before 07:00 and I will post the setup I am taking.\n\nMinimum 1.5R. No trades outside London and New York.'}
                    />
                    <span className="mt-1.5 block text-[11px] leading-4 text-fg-subtle">
                      This is what members read when they arrive. Say what you trade, when, and what you want from them.
                    </span>
                  </label>
                  <div>
                    <span className="mb-2 block text-xs font-medium text-fg-muted">Who can see it?</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setVisibility('PRIVATE')} aria-pressed={visibility === 'PRIVATE'} className={`rounded-xl border p-3 text-left ${visibility === 'PRIVATE' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}>
                        <LockKeyhole size={16} className="text-accent-text" />
                        <span className="mt-2 block text-sm font-semibold text-fg">Private</span>
                        <span className="mt-1 block text-[11px] text-fg-muted">Only people with your link can view and join it.</span>
                      </button>
                      <button type="button" onClick={() => setVisibility('PUBLIC')} aria-pressed={visibility === 'PUBLIC'} className={`rounded-xl border p-3 text-left ${visibility === 'PUBLIC' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}>
                        <Globe size={16} className="text-accent-text" />
                        <span className="mt-2 block text-sm font-semibold text-fg">Public</span>
                        <span className="mt-1 block text-[11px] text-fg-muted">Listed in the room directory for anyone to find.</span>
                      </button>
                    </div>
                  </div>
                  <p className="flex items-start gap-1.5 rounded-lg border border-line bg-raised p-3 text-[11px] leading-5 text-fg-muted">
                    <Info size={13} className="mt-0.5 shrink-0" />
                    <span>You can change the name, the description, the chart instrument and who can see the room at any time.</span>
                  </p>

                  {createError && <p role="alert" className="rounded-lg border border-negative/40 bg-negative-soft p-3 text-xs leading-5 text-fg">{createError}</p>}
                </div>

                <footer className="flex flex-wrap gap-2 border-t border-line p-5">
                  <button type="button" disabled={saving} onClick={() => setCreateOpen(false)} className="btn btn-secondary flex-1">Cancel</button>
                  <button type="submit" disabled={saving || !roomName.trim()} className="btn btn-primary flex-1">
                    {saving ? 'Creating…' : <><Rocket size={15} /> Create room</>}
                  </button>
                </footer>
              </form>
            )}
          </section>
        </div>
      )}
      </>}
    </div>
  );
}
