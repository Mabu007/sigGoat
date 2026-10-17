import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowUpRight, Bot, Check, CirclePlus, Copy, Globe, LockKeyhole, Plus, Rocket, Search, Trash2, Users, X } from 'lucide-react';
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
type TradingProvider = 'ctrader' | 'hyperliquid';
type BuildStep = 'team' | 'members' | 'deploy';

/** A member the user saved earlier and is re-using in this team. */
type PoolMember = { id: string; name: string; jobTitle: string; jobDescription: string; skills: string[]; asset?: string; status: string };

/**
 * A member being authored right now, inside the team builder.
 *
 * New members are not persisted on their own: they are submitted with the team
 * and created server-side in the same request, because the team is the only
 * unit a user creates.
 */
type MemberDraft = {
  key: string;
  name: string;
  jobTitle: string;
  jobDescription: string;
  skills: string;
};

const MAX_MEMBERS = 10;
const draftKey = () => `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const emptyDraft = (): MemberDraft => ({ key: draftKey(), name: '', jobTitle: '', jobDescription: '', skills: '' });

const PROVIDER_OPTIONS: Array<{ id: TradingProvider; label: string; blurb: string }> = [
  { id: 'ctrader', label: 'cTrader', blurb: 'Broker-connected execution. Requires a linked cTrader account.' },
  { id: 'hyperliquid', label: 'Hyperliquid', blurb: 'On-chain perpetuals through your connected wallet.' },
];

/** Sensible starting risk so the deployment step is never an empty form. */
const DEFAULT_RISK = { maxPositionSizePercent: '1', maxDailyLossPercent: '3', maxOpenPositions: '3', stopLossPercent: '1.5', takeProfitPercent: '3' };

export function TradeRoomsView({ createTeamRequested, onCreateTeamRequestHandled }: { createTeamRequested: boolean; onCreateTeamRequestHandled: () => void }) {
  const { refreshGoats } = useGoat();
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const [rooms, setRooms] = useState<TradeRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>('all');
  const [myRooms, setMyRooms] = useState<TradeRoom[]>([]);
  const [myRoomsLoading, setMyRoomsLoading] = useState(false);

  /* ---- team builder state ---- */
  const [createOpen, setCreateOpen] = useState(false);
  const [step, setStep] = useState<BuildStep>('team');
  const [teamName, setTeamName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [visibility, setVisibility] = useState<TeamVisibility>('PRIVATE');
  const [poolMembers, setPoolMembers] = useState<PoolMember[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [reuseMemberId, setReuseMemberId] = useState('');
  const [drafts, setDrafts] = useState<MemberDraft[]>([emptyDraft()]);
  const [provider, setProvider] = useState<TradingProvider>('ctrader');
  const [asset, setAsset] = useState('');
  const [risk, setRisk] = useState(DEFAULT_RISK);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createNotice, setCreateNotice] = useState('');
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
        slug: team.publicSlug || team.id, name: team.name,
        description: team.instructions || team.description || 'Your AI trading team.',
        markets: team.deployment?.asset ? [team.deployment.asset] : Array.isArray(team.members) ? team.members.flatMap((member: any) => member.markets || []).filter(Boolean) : [],
        status: team.status || 'SAVED', creatorName: 'You', publishedAt: team.createdAt, updatedAt: team.updatedAt,
        mode: team.status === 'DEPLOYED' ? 'TEAM' : 'PAPER', latestThesis: null, roomType: 'team',
        memberCount: Array.isArray(team.memberGoatIds) ? team.memberGoatIds.length : Array.isArray(team.members) ? team.members.length : 0,
      }));
      setMyRooms(teams);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load your rooms.'); }
    finally { setMyRoomsLoading(false); }
  }, [currentUser, authMode, getApiAuthHeaders]);

  /**
   * Every entry point starts from a blank draft. Reopening used to keep the
   * previous team's name and roster, so a second save silently duplicated a
   * team; and the empty-state button skipped its reset entirely, so after a
   * successful create the stale share panel came back instead of the form.
   */
  const openCreateTeam = useCallback(() => {
    setStep('team');
    setTeamName(''); setInstructions(''); setVisibility('PRIVATE');
    setPoolMembers([]); setReuseMemberId(''); setDrafts([emptyDraft()]);
    setProvider('ctrader'); setAsset(''); setRisk(DEFAULT_RISK);
    setCreateError(''); setCreateNotice(''); setCreatedShareUrl('');
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    if (!createTeamRequested) return;
    openCreateTeam();
    onCreateTeamRequestHandled();
  }, [createTeamRequested, openCreateTeam, onCreateTeamRequestHandled]);

  /* Escape closes, and the page behind must not scroll while the sheet is up. */
  useEffect(() => {
    if (!createOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) setCreateOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [createOpen, saving]);

  /**
   * Members already saved by earlier teams. They are offered as a dropdown so
   * the same specialist can be added to any number of teams without being
   * re-authored each time.
   */
  const loadPool = useCallback(async () => {
    if (!currentUser && authMode !== 'dev') return;
    setPoolLoading(true);
    try {
      const headers = new Headers({ Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/team-members', { headers, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.members)) setPoolMembers(body.members as PoolMember[]);
    } catch {
      // The roster is an optional convenience; authoring inline still works.
    } finally { setPoolLoading(false); }
  }, [currentUser, authMode, getApiAuthHeaders]);

  const visibleRooms = directoryMode === 'mine' ? myRooms : rooms;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleRooms.filter(room => {
      const matchesText = !needle || [room.name, room.description, room.creatorName, ...(room.markets || [])].join(' ').toLowerCase().includes(needle);
      const matchesFilter = directoryMode !== 'active' || /active|deployed|running/i.test(room.status);
      return matchesText && matchesFilter;
    });
  }, [visibleRooms, query, directoryMode]);

  /* A team of one is valid: one specialist is just the smallest team. */
  const reusedMember = reuseMemberId ? poolMembers.find(member => member.id === reuseMemberId) ?? null : null;
  const rosterCount = drafts.length + (reusedMember ? 1 : 0);
  const allDraftsValid = drafts.every(draft => Boolean(draft.name.trim() && draft.jobTitle.trim() && draft.jobDescription.trim()));
  const stepMembersReady = rosterCount >= 1 && allDraftsValid;

  const updateDraft = (key: string, patch: Partial<MemberDraft>) => setDrafts(previous => previous.map(draft => draft.key === key ? { ...draft, ...patch } : draft));
  const removeDraft = (key: string) => setDrafts(previous => previous.filter(draft => draft.key !== key));

  const createTeam = async (event: FormEvent, deploy: boolean) => {
    event.preventDefault();
    setCreateError(''); setCreateNotice('');
    if (!currentUser && authMode !== 'dev') { setCreateError('Sign in first to create your team.'); return; }
    if (!teamName.trim()) { setCreateError('Give your team a name.'); return; }
    if (!stepMembersReady) { setCreateError(drafts.length === 0 ? 'Add at least one team member.' : 'Every member needs a name, a job title, and a job description.'); return; }
    if (deploy && !asset.trim()) { setCreateError('Choose the asset this team trades.'); return; }

    setSaving(true);
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);

      /**
       * Members authored in this step are sent with the team and created by the
       * same request. Nothing here creates a standalone trading agent: the team
       * is the unit of creation.
       */
      const newMembers = drafts.map(draft => ({
        name: draft.name.trim(),
        jobTitle: draft.jobTitle.trim(),
        jobDescription: draft.jobDescription.trim(),
        skills: draft.skills.split(',').map(skill => skill.trim()).filter(Boolean),
      }));
      const response = await fetch('/api/goat-teams', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: teamName.trim(),
          instructions: instructions.trim(),
          memberGoatIds: reuseMemberId ? [reuseMemberId] : [],
          newMembers,
          visibility,
          deploy,
          ...(deploy ? {
            deployment: {
              provider,
              asset: asset.trim().toUpperCase(),
              risk: {
                maxPositionSizePercent: Number(risk.maxPositionSizePercent),
                maxDailyLossPercent: Number(risk.maxDailyLossPercent),
                maxOpenPositions: Number(risk.maxOpenPositions),
                stopLossPercent: Number(risk.stopLossPercent),
                takeProfitPercent: Number(risk.takeProfitPercent),
              },
            },
          } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body.team) throw new Error(body?.error?.message || 'Could not create the team.');

      if (body.shareUrl) setCreatedShareUrl(new URL(body.shareUrl, window.location.origin).toString());
      await refreshGoats();
      await loadMyRooms().catch(() => {});
      await loadRooms();

      if (body.team?.status === 'PARTIAL') setCreateNotice('Team saved, but some members did not deploy. Open My Rooms to review the results.');
      else if (deploy) setCreateNotice(visibility === 'PUBLIC' ? 'Team deployed and published to the homepage.' : 'Team saved and deployed. Share its link any time.');
      else setCreateNotice('Team saved. Deploy it later to start trading, or share its link now.');
    } catch (err) { setCreateError(err instanceof Error ? err.message : 'Could not create the team.'); }
    finally { setSaving(false); }
  };

  const STEPS: Array<{ id: BuildStep; label: string }> = [
    { id: 'team', label: 'Team' },
    { id: 'members', label: 'Members' },
    { id: 'deploy', label: 'Deploy' },
  ];
  const stepIndex = STEPS.findIndex(item => item.id === step);

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">Discover teams and bots</h1>
            <p className="mt-1 text-sm text-fg-muted">Explore trading teams, open a room, and see how its bots work.</p>
          </div>
          <button type="button" onClick={openCreateTeam} className="btn btn-primary shrink-0"><CirclePlus size={15} /> Create Bot Team</button>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Room directory">
            {([{ id: 'all', label: 'All Rooms' }, { id: 'active', label: 'Active Rooms' }, { id: 'mine', label: 'My Rooms' }] as const).map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => { setDirectoryMode(item.id); setQuery(''); if (item.id === 'mine') void loadMyRooms(); else setError(''); }}
                aria-pressed={directoryMode === item.id}
                className={directoryMode === item.id ? 'rounded-lg border border-accent bg-accent-soft px-3 py-2 text-xs font-medium text-accent-text' : 'rounded-lg border border-line px-3 py-2 text-xs font-medium text-fg-muted hover:bg-raised'}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-fg-muted">
            {directoryMode === 'mine' ? (myRoomsLoading ? 'Loading your rooms…' : filtered.length + ' of ' + myRooms.length + ' rooms') : (loading ? 'Loading public rooms…' : rooms.length + ' public ' + (rooms.length === 1 ? 'room' : 'rooms'))}
          </p>
        </div>
        <label className="relative block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={query} onChange={event => setQuery(event.target.value)} className="input !pl-9" placeholder={directoryMode === 'mine' ? 'Search your rooms…' : 'Search teams, markets, or strategies…'} aria-label="Search Trade Rooms" />
        </label>
      </section>

      {error && <div role="alert" className="panel border-warning/40 p-4 text-sm text-fg-muted">{error}</div>}

      {(directoryMode === 'mine' ? myRoomsLoading : loading) ? (
        <div className="panel p-8 text-center text-sm text-fg-muted">Loading rooms…</div>
      ) : filtered.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(room => {
            const href = room.roomType === 'team' ? `/team/${encodeURIComponent(room.slug)}` : `/robot/${encodeURIComponent(room.slug)}`;
            return (
              <article key={(room.roomType || 'bot') + room.slug} className="panel group flex min-h-56 flex-col p-4 transition-colors hover:border-accent/60 hover:bg-raised">
                <a href={href} className="flex flex-1 flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text">{room.roomType === 'team' ? <Users size={20} /> : <Bot size={20} />}</div>
                    <span className="rounded-full border border-line px-2 py-1 text-[10px] text-fg-muted">{room.mode === 'PAPER' ? 'Paper mode' : room.roomType === 'team' ? 'Team room' : room.status}</span>
                  </div>
                  <h3 className="mt-4 flex items-center gap-2 font-semibold text-fg">{room.name}<ArrowUpRight size={14} className="text-fg-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></h3>
                  <p className="mt-1 line-clamp-3 text-sm leading-5 text-fg-muted">{room.description || 'An AI trading room sharing recorded market research.'}</p>
                  {room.latestThesis && <div className="mt-3 rounded-lg border border-line bg-raised/70 p-3"><p className="text-[10px] uppercase tracking-wide text-fg-subtle">Latest recorded view · {room.latestThesis.market}</p><p className="mt-1 line-clamp-2 text-xs text-fg">{room.latestThesis.summary}</p></div>}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
                    <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle"><Users size={12} /> {room.roomType === 'team' ? `${room.memberCount || 0} bots` : room.creatorName}</span>
                    <span className="text-[10px] text-fg-subtle">{(room.markets || []).slice(0, 3).join(' · ') || 'Markets not listed'}</span>
                  </div>
                </a>
                {room.roomType === 'team' && <a href={href} className="mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90">Open room <ArrowUpRight size={13} /></a>}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel px-5 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Bot size={22} /></div>
          <h3 className="mt-4 font-semibold text-fg">{visibleRooms.length ? 'No rooms match that search' : directoryMode === 'mine' ? 'No teams yet' : 'No public rooms yet'}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            {visibleRooms.length ? 'Try another name, market, or filter.' : directoryMode === 'mine' ? 'Your teams will appear here. A team can have a single member or many, and each member can be reused across teams.' : 'No public teams or bots are listed yet. Create a team, add the members you need, then deploy it.'}
          </p>
          <button type="button" onClick={openCreateTeam} className="btn btn-primary mt-5"><CirclePlus size={15} /> Create Bot Team</button>
        </div>
      )}

      {createOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget && !saving) setCreateOpen(false); }}
        >
          {/* `bg-panel` was never a theme token — the palette exposes
               `--color-surface`, so the sheet rendered fully transparent. */}
          <section role="dialog" aria-modal="true" aria-labelledby="create-team-title" className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-2xl sm:rounded-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-line p-5">
              <div className="min-w-0">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Users size={19} /></div>
                <h2 id="create-team-title" className="text-xl font-semibold text-fg">Create Bot Team</h2>
                <p className="mt-1 text-sm leading-5 text-fg-muted">Name the team, add its members, then choose how it trades.</p>
              </div>
              <button type="button" aria-label="Close create team dialog" disabled={saving} onClick={() => setCreateOpen(false)} className="rounded-lg p-2 text-fg-muted hover:bg-raised"><X size={18} /></button>
            </header>

            {createdShareUrl ? (
              <div className="overflow-y-auto p-5">
                <div className="rounded-xl border border-line bg-raised p-4">
                  <p className="text-sm font-semibold text-fg">Your team link</p>
                  {createNotice && <p role="status" className="mt-2 rounded-lg border border-positive/40 bg-positive-soft p-2.5 text-xs leading-5 text-fg">{createNotice}</p>}
                  <p className="mt-1 break-all text-xs text-fg-muted">{createdShareUrl}</p>
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(createdShareUrl)} className="btn btn-secondary mt-3"><Copy size={14} /> Copy link</button>
                  <button type="button" onClick={() => { setCreateOpen(false); window.location.href = createdShareUrl; }} className="btn btn-primary ml-2 mt-3">Open team</button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={event => void createTeam(event, false)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <nav className="flex gap-1.5 border-b border-line px-5 py-3" aria-label="Team setup steps">
                  {STEPS.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setStep(item.id)}
                      aria-current={step === item.id ? 'step' : undefined}
                      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${step === item.id ? 'bg-accent-soft text-accent-text' : index < stepIndex ? 'text-fg-muted hover:bg-raised' : 'text-fg-subtle hover:bg-raised'}`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${index <= stepIndex ? 'bg-accent text-white' : 'border border-line'}`}>{index + 1}</span>
                      {item.label}
                    </button>
                  ))}
                </nav>

                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                  {step === 'team' && (
                    <>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-fg-muted">Team name</span>
                        <input autoFocus maxLength={80} value={teamName} onChange={event => setTeamName(event.target.value)} className="input" placeholder="e.g. London Breakout Team" />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-fg-muted">How should the team work?</span>
                        <textarea
                          rows={5}
                          maxLength={4000}
                          value={instructions}
                          onChange={event => setInstructions(event.target.value)}
                          className="input"
                          placeholder={'e.g. Only trade London hours.\nRequire two members to agree before entering.\nNever hold overnight.'}
                        />
                        <span className="mt-1.5 block text-[11px] leading-4 text-fg-subtle">
                          These instructions apply to every member of this team and override their personal habits.
                        </span>
                      </label>
                      <div>
                        <span className="mb-2 block text-xs font-medium text-fg-muted">Who can see it?</span>
                        <div className="grid grid-cols-2 gap-2">
                          <button type="button" onClick={() => setVisibility('PRIVATE')} aria-pressed={visibility === 'PRIVATE'} className={`rounded-xl border p-3 text-left ${visibility === 'PRIVATE' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}>
                            <LockKeyhole size={16} className="text-accent-text" />
                            <span className="mt-2 block text-sm font-semibold text-fg">Private</span>
                            <span className="mt-1 block text-[11px] text-fg-muted">Only people with your link can view it.</span>
                          </button>
                          <button type="button" onClick={() => setVisibility('PUBLIC')} aria-pressed={visibility === 'PUBLIC'} className={`rounded-xl border p-3 text-left ${visibility === 'PUBLIC' ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}>
                            <Globe size={16} className="text-accent-text" />
                            <span className="mt-2 block text-sm font-semibold text-fg">Public</span>
                            <span className="mt-1 block text-[11px] text-fg-muted">Shows in the homepage feed after deployment.</span>
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {step === 'members' && (
                    <>
                      <div className="rounded-xl border border-line bg-raised/70 p-3">
                        <p className="text-sm font-semibold text-fg">Add a member you already have</p>
                        <p className="mt-1 text-[11px] leading-4 text-fg-subtle">Members saved by earlier teams can be reused in this one.</p>
                        <div className="mt-2.5 flex gap-2">
                          <select
                            value={reuseMemberId}
                            onChange={event => setReuseMemberId(event.target.value)}
                            onFocus={() => void loadPool()}
                            className="input"
                            aria-label="Choose an existing member"
                          >
                            <option value="">{poolLoading ? 'Loading your members…' : poolMembers.length ? 'Select a saved member…' : 'No saved members yet'}</option>
                            {poolMembers.filter(member => member.id !== reuseMemberId).map(member => (
                              <option key={member.id} value={member.id}>{member.name} · {member.jobTitle}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={!reuseMemberId}
                            onClick={() => { setReuseMemberId(''); }}
                            className="btn btn-secondary shrink-0"
                          >
                            Remove
                          </button>
                        </div>
                        {reusedMember && (
                          <p className="mt-2 rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-[11px] text-fg">
                            On this team: {reusedMember.name} · {reusedMember.jobTitle}
                          </p>
                        )}
                      </div>

                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs font-medium text-fg-muted">New members</span>
                          <span className="text-[11px] text-fg-subtle">{rosterCount} of {MAX_MEMBERS} on this team</span>
                        </div>
                        <div className="space-y-3">
                          {drafts.map((draft, index) => (
                            <div key={draft.key} className="rounded-xl border border-line p-3">
                              <div className="mb-2 flex items-center justify-between">
                                <p className="text-[11px] font-semibold text-fg">Member {index + 1}</p>
                                {drafts.length > 1 && (
                                  <button type="button" onClick={() => removeDraft(draft.key)} aria-label={`Remove member ${index + 1}`} className="rounded-lg p-1 text-fg-subtle hover:bg-raised hover:text-negative"><Trash2 size={14} /></button>
                                )}
                              </div>
                              <div className="grid gap-2 sm:grid-cols-2">
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-fg-muted">Name</span>
                                  <input value={draft.name} onChange={event => updateDraft(draft.key, { name: event.target.value })} className="input" placeholder="e.g. Ava" />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-fg-muted">Job title</span>
                                  <input value={draft.jobTitle} onChange={event => updateDraft(draft.key, { jobTitle: event.target.value })} className="input" placeholder="e.g. Risk Manager" />
                                </label>
                              </div>
                              <label className="mt-2 block">
                                <span className="mb-1 block text-[11px] font-medium text-fg-muted">Job description</span>
                                <textarea rows={2} maxLength={1000} value={draft.jobDescription} onChange={event => updateDraft(draft.key, { jobDescription: event.target.value })} className="input" placeholder="What is this member responsible for?" />
                              </label>
                              <label className="mt-2 block">
                                <span className="mb-1 block text-[11px] font-medium text-fg-muted">Skills</span>
                                <input value={draft.skills} onChange={event => updateDraft(draft.key, { skills: event.target.value })} className="input" placeholder="Liquidity sweeps, trend following" />
                                <span className="mt-1 block text-[10px] text-fg-subtle">Separate with commas.</span>
                              </label>
                            </div>
                          ))}
                        </div>
                        <button type="button" onClick={() => setDrafts(previous => previous.length >= MAX_MEMBERS ? previous : [...previous, emptyDraft()])} className="btn btn-secondary mt-3 w-full"><Plus size={15} /> Add another member</button>
                        <p className="mt-2 text-[11px] leading-4 text-fg-subtle">A team needs at least one member. One member is a valid team.</p>
                      </div>
                    </>
                  )}

                  {step === 'deploy' && (
                    <>
                      <div>
                        <span className="mb-2 block text-xs font-medium text-fg-muted">Trading provider</span>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {PROVIDER_OPTIONS.map(option => (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => setProvider(option.id)}
                              aria-pressed={provider === option.id}
                              className={`rounded-xl border p-3 text-left ${provider === option.id ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}
                            >
                              <span className="block text-sm font-semibold text-fg">{option.label}</span>
                              <span className="mt-1 block text-[11px] leading-4 text-fg-muted">{option.blurb}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-fg-muted">Asset</span>
                        <input value={asset} onChange={event => setAsset(event.target.value.toUpperCase())} className="input uppercase" placeholder="e.g. BTC, XAUUSD" />
                        <span className="mt-1.5 block text-[11px] text-fg-subtle">The whole team trades this one instrument.</span>
                      </label>
                      <div>
                        <span className="mb-2 block text-xs font-medium text-fg-muted">Risk parameters</span>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {([
                            ['maxPositionSizePercent', 'Max position size (%)'],
                            ['maxDailyLossPercent', 'Max daily loss (%)'],
                            ['maxOpenPositions', 'Max open positions'],
                            ['stopLossPercent', 'Stop loss (%)'],
                            ['takeProfitPercent', 'Take profit (%)'],
                          ] as const).map(([field, label]) => (
                            <label key={field} className="block">
                              <span className="mb-1 block text-[11px] font-medium text-fg-muted">{label}</span>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={risk[field]}
                                onChange={event => setRisk(previous => ({ ...previous, [field]: event.target.value }))}
                                className="input"
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                      <p className="rounded-lg border border-line bg-raised p-3 text-[11px] leading-5 text-fg-muted">
                        Deploying starts scheduling and an initial market review for every member, under these settings. Saving without deploying keeps the team inactive.
                      </p>
                    </>
                  )}

                  {createError && <p role="alert" className="rounded-lg border border-negative/40 bg-negative-soft p-3 text-xs leading-5 text-fg">{createError}</p>}
                </div>

                <footer className="flex flex-wrap gap-2 border-t border-line p-5">
                  {stepIndex > 0 && (
                    <button type="button" disabled={saving} onClick={() => setStep(STEPS[stepIndex - 1].id)} className="btn btn-secondary">Back</button>
                  )}
                  <button type="button" disabled={saving} onClick={() => setCreateOpen(false)} className="btn btn-secondary flex-1">Cancel</button>
                  {step === 'deploy' ? (
                    <>
                      <button type="submit" disabled={saving} className="btn btn-secondary flex-1">{saving ? 'Saving…' : 'Save team'}</button>
                      <button type="button" disabled={saving || !asset.trim()} onClick={event => void createTeam(event, true)} className="btn btn-primary flex-1">{saving ? 'Deploying…' : <><Rocket size={15} /> Save &amp; deploy</>}</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={step === 'team' ? !teamName.trim() : !stepMembersReady}
                      onClick={() => setStep(STEPS[stepIndex + 1].id)}
                      className="btn btn-primary flex-1"
                    >
                      {step === 'team' ? <>Next: members <Check size={15} /></> : <>Next: deploy <Check size={15} /></>}
                    </button>
                  )}
                </footer>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}