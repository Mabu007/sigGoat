import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowUpRight, Bot, CirclePlus, Search, Sparkles, Users, X, Check, LockKeyhole, Globe, Copy } from 'lucide-react';
import { useGoat } from '../../context/GoatContext';
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
};
type TeamVisibility = 'PUBLIC' | 'PRIVATE';
type DirectoryMode = 'all' | 'active' | 'mine';

export function TradeRoomsView({ onCreateRoom, createTeamRequested, onCreateTeamRequestHandled }: { onCreateRoom: () => void; createTeamRequested: boolean; onCreateTeamRequestHandled: () => void }) {
  const { goats, refreshGoats } = useGoat();
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const [rooms, setRooms] = useState<TradeRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>('all');
  const [myRooms, setMyRooms] = useState<TradeRoom[]>([]);
  const [myRoomsLoading, setMyRoomsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [selectedGoatIds, setSelectedGoatIds] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<TeamVisibility>('PRIVATE');
  const [deployNow, setDeployNow] = useState(false);
  const [coordinationMode, setCoordinationMode] = useState<'INDEPENDENT' | 'CONSENSUS' | 'LEAD_REVIEW'>('INDEPENDENT');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdShareUrl, setCreatedShareUrl] = useState('');

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [botsResponse, teamsResponse] = await Promise.all([
        fetch('/api/robots', { headers: { Accept: 'application/json' }, cache: 'no-store' }),
        fetch('/api/goat-teams/public', { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      ]);
      const botsBody = await botsResponse.json().catch(() => ({}));
      const teamsBody = await teamsResponse.json().catch(() => ({}));
      if (!botsResponse.ok) throw new Error(botsBody?.error?.message || 'Could not load public AI traders.');
      if (!teamsResponse.ok) throw new Error(teamsBody?.error?.message || 'Could not load public teams.');
      const bots: TradeRoom[] = (Array.isArray(botsBody.rooms) ? botsBody.rooms : []).map((room: TradeRoom) => ({ ...room, roomType: 'bot' as const }));
      const teams: TradeRoom[] = (Array.isArray(teamsBody.rooms) ? teamsBody.rooms : []).map((room: TradeRoom) => ({ ...room, roomType: 'team' as const }));
      setRooms([...teams, ...bots].sort((a, b) => (b.updatedAt || b.publishedAt || '').localeCompare(a.updatedAt || a.publishedAt || '')));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Trade Rooms.');
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
        slug: team.shareSlug || team.slug || team.id, name: team.name,
        description: team.description || 'Your AI trading team.',
        markets: Array.isArray(team.members) ? team.members.flatMap((member: any) => member.markets || []).filter(Boolean) : [],
        status: team.status || 'SAVED', creatorName: 'You', publishedAt: team.createdAt, updatedAt: team.updatedAt,
        mode: team.status === 'DEPLOYED' ? 'TEAM' : 'PAPER', latestThesis: null, roomType: 'team',
        memberCount: Array.isArray(team.memberGoatIds) ? team.memberGoatIds.length : Array.isArray(team.members) ? team.members.length : 0,
      }));
      setMyRooms(teams);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load your rooms.'); }
    finally { setMyRoomsLoading(false); }
  }, [currentUser, authMode, getApiAuthHeaders]);

  useEffect(() => {
    if (!createTeamRequested) return;
    setCreateError(''); setCreatedShareUrl(''); setCreateOpen(true);
    onCreateTeamRequestHandled();
  }, [createTeamRequested, onCreateTeamRequestHandled]);

  const visibleRooms = directoryMode === 'mine' ? myRooms : rooms;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleRooms.filter(room => {
      const matchesText = !needle || [room.name, room.description, room.creatorName, ...(room.markets || [])].join(' ').toLowerCase().includes(needle);
      const matchesFilter = directoryMode !== 'active' || /active|deployed|running/i.test(room.status);
      return matchesText && matchesFilter;
    });
  }, [visibleRooms, query, directoryMode]);

  const toggleGoat = (id: string) => setSelectedGoatIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  const createTeam = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError('');
    if (!currentUser && authMode !== 'dev') { setCreateError('Sign in first to create and save a team.'); return; }
    if (!teamName.trim()) { setCreateError('Give your team a name.'); return; }
    if (selectedGoatIds.length < 2) { setCreateError('Choose at least two of your existing AI bots.'); return; }
    setSaving(true);
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/goat-teams', { method: 'POST', headers, body: JSON.stringify({
        name: teamName.trim(), goatIds: selectedGoatIds, visibility, coordinationMode, leadGoatId: coordinationMode === 'LEAD_REVIEW' ? selectedGoatIds[0] : undefined, deploy: deployNow,
      }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body.team) throw new Error(body?.error?.message || 'Could not create the team.');
      if (body.shareUrl) setCreatedShareUrl(new URL(body.shareUrl, window.location.origin).toString());
      await refreshGoats();
      await loadRooms();
      if (body.team?.status === 'PARTIAL') setCreateError('Team saved, but some bots did not deploy. Open My teams to review the results.');
      else if (response.ok) {
        if (visibility === 'PUBLIC' && deployNow) setCreateError('Team deployed and published to the homepage.');
        else setCreateError('Team saved. Share its link any time; public teams appear in the homepage feed after deployment.');
      }
    } catch (err) { setCreateError(err instanceof Error ? err.message : 'Could not create the team.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h1 className="text-2xl font-semibold tracking-tight text-fg">Discover teams and bots</h1><p className="mt-1 text-sm text-fg-muted">Explore trading teams, open a room, and see how its bots work.</p></div>
          <button type="button" onClick={() => { setCreateError(''); setCreatedShareUrl(''); setCreateOpen(true); }} className="btn btn-primary shrink-0"><CirclePlus size={15} /> Create Bot Team</button>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Room directory">
            {([{id:'all',label:'All Rooms'},{id:'active',label:'Active Rooms'},{id:'mine',label:'My Rooms'}] as const).map(item => (
              <button key={item.id} type="button" onClick={() => { setDirectoryMode(item.id); setQuery(''); if (item.id === 'mine') void loadMyRooms(); else setError(''); }} aria-pressed={directoryMode === item.id} className={directoryMode === item.id ? 'rounded-lg border border-accent bg-accent-soft px-3 py-2 text-xs font-medium text-accent-text' : 'rounded-lg border border-line px-3 py-2 text-xs font-medium text-fg-muted hover:bg-raised'}>{item.label}</button>
            ))}
          </div>
          <p className="text-xs text-fg-muted">{directoryMode === 'mine' ? (myRoomsLoading ? 'Loading your rooms…' : filtered.length + ' of ' + myRooms.length + ' rooms') : (loading ? 'Loading public rooms…' : rooms.length + ' public ' + (rooms.length === 1 ? 'room' : 'rooms'))}</p>
        </div>
        <label className="relative block"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" /><input value={query} onChange={event => setQuery(event.target.value)} className="input !pl-9" placeholder={directoryMode === 'mine' ? 'Search your rooms…' : 'Search teams, markets, or strategies…'} aria-label="Search Trade Rooms" /></label>
      </section>
      {error && <div role="alert" className="panel border-warning/40 p-4 text-sm text-fg-muted">{error}</div>}
      {(directoryMode === 'mine' ? myRoomsLoading : loading) ? <div className="panel p-8 text-center text-sm text-fg-muted">Loading rooms…</div> : filtered.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(room => {
            const href = room.roomType === 'team' ? `/team/${encodeURIComponent(room.slug)}` : `/robot/${encodeURIComponent(room.slug)}`;
            return <article key={(room.roomType || 'bot') + room.slug} className="panel group flex min-h-56 flex-col p-4 transition-colors hover:border-accent/60 hover:bg-raised">
              <a href={href} className="flex flex-1 flex-col">
                <div className="flex items-start justify-between gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text">{room.roomType === 'team' ? <Users size={20} /> : <Bot size={20} />}</div><span className="rounded-full border border-line px-2 py-1 text-[10px] text-fg-muted">{room.mode === 'PAPER' ? 'Paper mode' : room.roomType === 'team' ? 'Team room' : room.status}</span></div>
                <h3 className="mt-4 flex items-center gap-2 font-semibold text-fg">{room.name}<ArrowUpRight size={14} className="text-fg-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></h3>
                <p className="mt-1 line-clamp-3 text-sm leading-5 text-fg-muted">{room.description || 'An AI trading room sharing recorded market research.'}</p>
                {room.latestThesis && <div className="mt-3 rounded-lg border border-line bg-raised/70 p-3"><p className="text-[10px] uppercase tracking-wide text-fg-subtle">Latest recorded view · {room.latestThesis.market}</p><p className="mt-1 line-clamp-2 text-xs text-fg">{room.latestThesis.summary}</p></div>}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4"><span className="flex items-center gap-1.5 text-[11px] text-fg-subtle"><Users size={12} /> {room.roomType === 'team' ? `${room.memberCount || 0} bots` : room.creatorName}</span><span className="text-[10px] text-fg-subtle">{(room.markets || []).slice(0, 3).join(' · ') || 'Markets not listed'}</span></div>
              </a>
              {room.roomType === 'team' && <a href={href} className="mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90">Open room <ArrowUpRight size={13} /></a>}
            </article>;
          })}
        </div>
      ) : (
        <div className="panel px-5 py-12 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Bot size={22} /></div><h3 className="mt-4 font-semibold text-fg">{rooms.length ? 'No rooms match that search' : directoryMode === 'mine' ? 'No rooms yet' : 'No public rooms yet'}</h3><p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">{rooms.length ? 'Try another name, market, or filter.' : 'Create a team from your existing AI bots. Choose private or public, then save it or deploy it.'}</p><button type="button" onClick={() => setCreateOpen(true)} className="btn btn-primary mt-5"><CirclePlus size={15} /> Create Bot Team</button></div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setCreateOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="create-team-title" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-line bg-panel p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-4"><div><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Users size={19} /></div><h2 id="create-team-title" className="text-xl font-semibold text-fg">Create Bot Team</h2><p className="mt-1 text-sm leading-5 text-fg-muted">Name it, choose the bots, decide who can see it, then save or deploy.</p></div><button type="button" aria-label="Close create team dialog" disabled={saving} onClick={() => setCreateOpen(false)} className="rounded-lg p-2 text-fg-muted hover:bg-raised"><X size={18} /></button></div>
            {createdShareUrl ? <div className="mt-5 rounded-xl border border-line bg-raised p-4"><p className="text-sm font-semibold text-fg">Your team link</p><p className="mt-1 break-all text-xs text-fg-muted">{createdShareUrl}</p><button type="button" onClick={() => void navigator.clipboard?.writeText(createdShareUrl)} className="btn btn-secondary mt-3"><Copy size={14} /> Copy link</button><button type="button" onClick={() => { setCreateOpen(false); window.location.href = createdShareUrl; }} className="btn btn-primary ml-2 mt-3">Open team</button></div> : <form onSubmit={createTeam} className="mt-5 space-y-5">
              <label className="block"><span className="mb-1.5 block text-xs font-medium text-fg-muted">Team name</span><input autoFocus maxLength={80} value={teamName} onChange={event => setTeamName(event.target.value)} className="input" placeholder="e.g. London Breakout Team" /></label>
              <div><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-fg-muted">Choose at least 2 bots</span><span className="text-[11px] text-fg-subtle">{selectedGoatIds.length} selected</span></div>{goats.length ? <div className="max-h-44 space-y-2 overflow-y-auto rounded-xl border border-line p-2">{goats.map(goat => <label key={goat.id} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-raised"><input type="checkbox" checked={selectedGoatIds.includes(goat.id)} onChange={() => toggleGoat(goat.id)} /><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-accent-text"><Bot size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-fg">{goat.name}</span><span className="block truncate text-[11px] text-fg-subtle">{(goat.markets || []).slice(0, 3).join(' · ') || 'No markets configured'}</span></span><span className="text-[10px] text-fg-subtle">{goat.status}</span></label>)}</div> : <div className="rounded-xl border border-dashed border-line p-4 text-sm text-fg-muted">You haven’t created any bots yet. <button type="button" onClick={onCreateRoom} className="font-semibold text-accent-text underline">Create your first bot</button>, then come back to build a team.</div>}</div>
              <div><span className="mb-2 block text-xs font-medium text-fg-muted">Who can see it?</span><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setVisibility('PRIVATE')} className={`rounded-xl border p-3 text-left ${visibility === 'PRIVATE' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}><LockKeyhole size={16} className="text-accent-text" /><span className="mt-2 block text-sm font-semibold text-fg">Private</span><span className="mt-1 block text-[11px] text-fg-muted">Only people with your link can view it.</span></button><button type="button" onClick={() => setVisibility('PUBLIC')} className={`rounded-xl border p-3 text-left ${visibility === 'PUBLIC' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}><Globe size={16} className="text-accent-text" /><span className="mt-2 block text-sm font-semibold text-fg">Public</span><span className="mt-1 block text-[11px] text-fg-muted">Shows in the homepage feed after deployment.</span></button></div></div>
              <label className="block"><span className="mb-1.5 block text-xs font-medium text-fg-muted">How should bots coordinate?</span><select value={coordinationMode} onChange={event => setCoordinationMode(event.target.value as typeof coordinationMode)} className="input"><option value="INDEPENDENT">Independent analysis</option><option value="CONSENSUS">Consensus — look for agreement</option><option value="LEAD_REVIEW">Lead bot reviews the team</option></select></label>
              <label className="flex items-start gap-3 rounded-xl border border-line bg-raised/70 p-3"><input type="checkbox" checked={deployNow} onChange={event => setDeployNow(event.target.checked)} className="mt-0.5" /><span><span className="block text-sm font-semibold text-fg">Deploy team now</span><span className="mt-1 block text-xs leading-5 text-fg-muted">Deploys the selected bots using their existing runtime and execution settings. Public teams appear in the homepage feed after successful deployment.</span></span></label>
              {createError && <p role="status" className="rounded-lg border border-line bg-raised p-3 text-xs leading-5 text-fg-muted">{createError}</p>}
              <div className="flex gap-2"><button type="button" disabled={saving} onClick={() => setCreateOpen(false)} className="btn btn-secondary flex-1">Cancel</button><button type="submit" disabled={saving || selectedGoatIds.length < 2 || !teamName.trim()} className="btn btn-primary flex-1">{saving ? 'Saving…' : deployNow ? <><Check size={15} /> Save & deploy</> : 'Save team'}</button></div>
            </form>}
          </section>
        </div>
      )}
    </div>
  );
}
