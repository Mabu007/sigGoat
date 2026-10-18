import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Bot, Check, CirclePlus, Copy, FilePlus2, Globe, Info, LockKeyhole, Plus, Rocket, Search, Trash2, Users, X } from 'lucide-react';
import { SearchablePicker } from '../../components/SearchablePicker';
import { SkillParser } from '../../services/agent/SkillParser';
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
  visibility?: TeamVisibility;
};
type TeamVisibility = 'PUBLIC' | 'PRIVATE';
type DirectoryMode = 'public' | 'private' | 'gold' | 'euro' | 'crypto' | 'forex' | 'mine';
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
  /**
   * Ids from the global skill catalogue, chosen in the picker.
   *
   * Ids, not typed text: the catalogue is real and owned, so the server binds
   * exactly what was chosen instead of re-guessing the words. Free text used to
   * be fuzzy-matched and silently fell back to an unrelated skill.
   */
  skillIds: string[];
};

type SkillOption = { id: string; name: string; description: string; isDefault?: boolean };
type AssetOption = { symbol: string; name: string; category: string };

const MAX_MEMBERS = 10;
const draftKey = () => `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const emptyDraft = (): MemberDraft => ({ key: draftKey(), name: '', jobTitle: '', jobDescription: '', skillIds: [] });

/** Copy for the markdown editor, matching the standalone skill screen. */
const SKILL_STARTER = `---
name: My Trading Skill
timeframes: 15m, 1h
---

# My Trading Skill

Describe what this skill looks for and when it applies.

## Thesis Formation
- What evidence must line up before acting?

## Constraints
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
REQUIRE_INVALIDATION_BEFORE_TRADE

## Invalidation Rules
What breaks the setup.
`;

const PROVIDER_OPTIONS: Array<{ id: TradingProvider; label: string; blurb: string }> = [
  { id: 'ctrader', label: 'cTrader', blurb: 'Standard cTrader assets. Paper prices until you connect a broker; a broker is only needed for live trading.' },
  { id: 'hyperliquid', label: 'Hyperliquid', blurb: 'On-chain perpetuals. Connect a wallet in Settings to trade live.' },
];

/** Sensible starting risk so the deployment step is never an empty form. */
const DEFAULT_RISK = { maxPositionSizePercent: '1', maxDailyLossPercent: '3', maxOpenPositions: '3', stopLossPercent: '1.5', takeProfitPercent: '3' };

/** Demo rooms have no broker, so this is the balance they actually run on. */
const DEFAULT_BALANCE = '10000';

export function TradeRoomsView({ createTeamRequested, onCreateTeamRequestHandled, showDirectoryContent = true, onOpenRoom, onShowDirectory }: { createTeamRequested: boolean; onCreateTeamRequestHandled: () => void; showDirectoryContent?: boolean; onOpenRoom: (type: 'team' | 'bot', slug: string, backLabel: string) => void; onShowDirectory: () => void }) {
  const { refreshGoats } = useGoat();
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
  const [liveTrading, setLiveTrading] = useState(false);
  const [startingBalance, setStartingBalance] = useState('10000');
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsNote, setAssetsNote] = useState('');
  const [assetsLive, setAssetsLive] = useState<{ available: boolean; reason: string | null; dataMode: string }>({ available: false, reason: null, dataMode: 'PAPER' });
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillAuthor, setSkillAuthor] = useState<{ draftKey: string } | null>(null);
  const [skillMarkdown, setSkillMarkdown] = useState(SKILL_STARTER);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState('');
  /** Which venue the currently loaded asset list belongs to. */
  const assetsProviderRef = useRef<TradingProvider | null>(null);
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
        visibility: team.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
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
    setProvider('ctrader'); setAsset(''); setRisk(DEFAULT_RISK); setLiveTrading(false); setStartingBalance(DEFAULT_BALANCE);
    setAssets([]); setAssetsNote(''); setAssetsLive({ available: false, reason: null, dataMode: 'PAPER' });
    assetsProviderRef.current = null;
    setSkillAuthor(null); setSkillMarkdown(SKILL_STARTER); setSkillError('');
    setCreateError(''); setCreateNotice(''); setCreatedShareUrl('');
    setCreateOpen(true);
  }, []);

  /**
   * The global skill catalogue. Populated when the Members step opens rather
   * than at mount, because it is only needed there.
   */
  const loadSkills = useCallback(async () => {
    if (!currentUser && authMode !== 'dev') return;
    try {
      const headers = new Headers({ Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch('/api/skills', { headers, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.skills)) {
        setSkills(body.skills as SkillOption[]);
      }
    } catch {
      // The catalogue is a convenience; members can still be described without it.
    }
  }, [currentUser, authMode, getApiAuthHeaders]);

  /**
   * Assets for the chosen venue.
   *
   * Re-fetched on every provider change so the list can never describe the
   * wrong venue. The response states whether the feed is live and what a broker
   * connection would add, which is what lets the UI say so plainly instead of
   * implying an asset will fill when it cannot.
   */
  const loadAssets = useCallback(async (forProvider: TradingProvider) => {
    if (!currentUser && authMode !== 'dev') return;
    setAssetsLoading(true);
    try {
      const headers = new Headers({ Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const response = await fetch(`/api/markets/assets?provider=${forProvider}`, { headers, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(body.assets)) {
        setAssets(body.assets as AssetOption[]);
        setAssetsNote(typeof body.note === 'string' ? body.note : '');
        setAssetsLive({ available: body.liveAvailable === true, reason: body.liveBlockedReason ?? null, dataMode: String(body.dataMode ?? 'PAPER') });
      }
    } catch {
      setAssets([]);
    } finally { setAssetsLoading(false); }
  }, [currentUser, authMode, getApiAuthHeaders]);

  const chooseProvider = (next: TradingProvider) => {
    setProvider(next);
    // The chosen asset belongs to the old venue; carrying it over would deploy
    // a symbol the new venue may not list.
    setAsset('');
    void loadAssets(next);
  };

  useEffect(() => { if (step === 'members') void loadSkills(); }, [step, loadSkills]);

  /**
   * Assets load on first arrival at the Deploy step and are then kept in sync
   * with the venue. Reloading on every step change would refetch the same list
   * each time the user passes back and forth.
   */
  useEffect(() => {
    if (step !== 'deploy' || assetsProviderRef.current === provider) return;
    assetsProviderRef.current = provider;
    void loadAssets(provider);
  }, [step, provider, loadAssets]);

  /**
   * Authors a skill from markdown and adds it to the member being edited.
   *
   * The skill is persisted to the user's global catalogue, so it is available
   * to every future member, not just this one. Parsing happens client-side
   * with the same parser the standalone skill screen uses, then the normalised
   * fields are posted.
   */
  const saveAuthoredSkill = async () => {
    if (!skillAuthor) return;
    if (!skillMarkdown.trim()) { setSkillError('Write the skill content first.'); return; }
    setSkillSaving(true); setSkillError('');
    try {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) headers.set(key, value);
      const parsed = SkillParser.parse(skillMarkdown.trim());
      const response = await fetch('/api/skills', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: parsed.name,
          description: parsed.description,
          methodology: parsed.methodology,
          constraints: parsed.constraints,
          preferredTimeframes: parsed.preferredTimeframes,
          requiredEvidence: parsed.requiredEvidence,
          invalidationRules: parsed.invalidationRules,
          rawMarkdown: parsed.rawMarkdown,
        }),
      });
      const body = await response.json().catch(() => ({}));
      const created = body?.skill;
      if (!response.ok || !created?.id) throw new Error(body?.error?.message || 'Could not save the skill.');
      setSkills(previous => [...previous, created as SkillOption]);
      setDrafts(previous => previous.map(draft => draft.key === skillAuthor.draftKey
        ? { ...draft, skillIds: [...draft.skillIds, created.id] }
        : draft));
      setSkillAuthor(null); setSkillMarkdown(SKILL_STARTER);
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Could not save the skill.');
    } finally { setSkillSaving(false); }
  };

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
    const onKeyDown = (event: KeyboardEvent) => {
      // Innermost layer first: the skill editor closes before the team sheet.
      if (event.key === 'Escape' && skillAuthor) { setSkillAuthor(null); return; }
      if (event.key === 'Escape' && !saving) setCreateOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [createOpen, saving, skillAuthor]);

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

  const visibleRooms = directoryMode === 'mine' || directoryMode === 'private' ? myRooms : rooms;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleRooms.filter(room => {
      const searchable = [room.name, room.description, room.creatorName, ...(room.markets || [])].join(' ').toLowerCase();
      const matchesText = !needle || searchable.includes(needle);
      const matchesCategory = directoryMode === 'private'
        ? room.visibility === 'PRIVATE'
        : directoryMode === 'gold'
          ? /gold|xau|gld/i.test(searchable)
          : directoryMode === 'euro'
            ? /euro|eur|eurchf|eurusd/i.test(searchable)
            : directoryMode === 'crypto'
              ? /btc|bitcoin|eth|ethereum|sol|crypto|hyperliquid|xrp|doge/i.test(searchable)
              : directoryMode === 'forex'
                ? /forex|fx|eurusd|gbpusd|usd[jc]|audusd|nzdusd/i.test(searchable)
                : true;
      return matchesText && matchesCategory;
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
        skillIds: draft.skillIds,
        skills: draft.skillIds
          .map(id => skills.find(skill => skill.id === id)?.name)
          .filter((name): name is string => Boolean(name)),
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
              liveTrading,
              startingBalance: Number(startingBalance),
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

  const directoryLabels: Record<DirectoryMode, string> = { public: 'Public Rooms', private: 'Private Rooms', gold: 'Gold Rooms', euro: 'Euro Rooms', crypto: 'Crypto Rooms', forex: 'Forex Rooms', mine: 'My Rooms' };

  return (
    <div className="space-y-6">
      {showDirectoryContent && <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="yt-room-filters flex flex-wrap gap-2" role="group" aria-label="Room categories">
            {([
              { id: 'public', label: 'Public Rooms' },
              { id: 'private', label: 'Private Rooms' },
              { id: 'gold', label: 'Gold Rooms' },
              { id: 'euro', label: 'Euro Rooms' },
              { id: 'crypto', label: 'Crypto Rooms' },
              { id: 'forex', label: 'Forex Rooms' },
              { id: 'mine', label: 'My Rooms' },
            ] as const).map(item => (
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
            {directoryMode === 'mine' || directoryMode === 'private' ? (myRoomsLoading ? 'Loading your rooms…' : filtered.length + ' rooms') : (loading ? 'Loading public rooms…' : filtered.length + ' rooms')}
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
            const marketLabel = (room.markets || []).slice(0, 2).join(' · ') || room.latestThesis?.market || 'AI TRADING';
            return (
              <article key={(room.roomType || 'bot') + room.slug} className="yt-room-card group">
                <button type="button" onClick={() => onOpenRoom(room.roomType === 'team' ? 'team' : 'bot', room.slug, directoryLabels[directoryMode])} className="block w-full min-w-0 text-left">
                  <div className="yt-room-thumbnail">
                    <div className="yt-thumb-topline">
                      <span className="yt-thumb-market">{marketLabel}</span>
                      <span className="yt-thumb-mode">{room.mode === 'PAPER' ? 'PAPER' : 'ACTIVE'}</span>
                    </div>
                    <svg viewBox="0 0 480 180" preserveAspectRatio="none" aria-hidden="true" className="yt-thumb-chart">
                      <path d="M0 142 L35 128 L63 139 L92 94 L119 109 L145 77 L176 91 L204 58 L230 81 L256 49 L286 70 L314 42 L341 58 L369 29 L398 47 L426 24 L455 38 L480 17 L480 180 L0 180 Z" fill="var(--color-accent)" fillOpacity=".12" />
                      <path d="M0 142 L35 128 L63 139 L92 94 L119 109 L145 77 L176 91 L204 58 L230 81 L256 49 L286 70 L314 42 L341 58 L369 29 L398 47 L426 24 L455 38 L480 17" fill="none" stroke="var(--color-accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
                      {[40, 90, 140].map(y => <line key={y} x1="0" x2="480" y1={y} y2={y} stroke="currentColor" strokeOpacity=".09" strokeDasharray="4 6" />)}
                    </svg>
                    <span className="yt-thumb-play" aria-hidden="true"><ArrowUpRight size={21} /></span>
                    <span className="yt-thumb-duration">{room.roomType === 'team' ? String(room.memberCount || 0) + ' BOTS' : 'AI BOT'}</span>
                  </div>
                  <div className="yt-room-meta">
                    <div className="yt-room-avatar" aria-hidden="true">{room.roomType === 'team' ? <Users size={18} /> : <Bot size={18} />}</div>
                    <div className="min-w-0 flex-1">
                      <h3 className="yt-room-title">{room.name}</h3>
                      <p className="yt-room-creator">{room.creatorName || 'SIRGOAT CREATOR'} <span aria-hidden="true">·</span> {room.roomType === 'team' ? `${room.memberCount || 0} BOTS` : 'AI BOT'} <span aria-hidden="true">·</span> {room.mode === 'PAPER' ? 'PAPER' : 'ACTIVE'}</p>
                      <p className="yt-room-description">{room.description || 'AI trading room sharing market research.'}</p>
                    </div>
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel px-5 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Bot size={22} /></div>
          <h3 className="mt-4 font-semibold text-fg">{visibleRooms.length ? 'No rooms match this category' : directoryMode === 'mine' || directoryMode === 'private' ? 'No private rooms yet' : 'No public rooms yet'}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            {visibleRooms.length ? 'Try another name or choose a different room category.' : directoryMode === 'mine' || directoryMode === 'private' ? 'Your private and saved teams will appear here. Create a team to get started.' : 'No public rooms match this category yet. Create a team, add the members you need, then publish it.'}
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
                              <div className="mt-2">
                                <span className="mb-1 block text-[11px] font-medium text-fg-muted">Skills</span>
                                <div className="flex gap-2">
                                  <SearchablePicker
                                    multiple
                                    options={skills.map(skill => ({ value: skill.id, label: skill.name, hint: skill.description, group: skill.isDefault ? 'Built-in' : 'Yours' }))}
                                    value={draft.skillIds}
                                    onChange={ids => updateDraft(draft.key, { skillIds: ids })}
                                    placeholder={skills.length ? 'Choose skills…' : 'Loading skills…'}
                                    searchPlaceholder="Search skills…"
                                    aria-label={`Skills for member ${index + 1}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => { setSkillAuthor({ draftKey: draft.key }); setSkillMarkdown(SKILL_STARTER); setSkillError(''); }}
                                    className="btn btn-secondary shrink-0"
                                    title="Write a new skill"
                                  >
                                    <FilePlus2 size={15} /> Write
                                  </button>
                                </div>
                                <span className="mt-1 block text-[10px] text-fg-subtle">
                                  Skills are shared across every member you create.
                                </span>
                              </div>
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
                              onClick={() => chooseProvider(option.id)}
                              aria-pressed={provider === option.id}
                              className={`rounded-xl border p-3 text-left ${provider === option.id ? 'border-accent bg-accent-soft' : 'border-line bg-raised'}`}
                            >
                              <span className="block text-sm font-semibold text-fg">{option.label}</span>
                              <span className="mt-1 block text-[11px] leading-4 text-fg-muted">{option.blurb}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <span className="mb-1.5 block text-xs font-medium text-fg-muted">Asset</span>
                        <SearchablePicker
                          options={assets.map(entry => ({ value: entry.symbol, label: entry.symbol, hint: entry.name, group: entry.category }))}
                          value={asset ? [asset] : []}
                          onChange={next => setAsset(next[0] ?? '')}
                          placeholder={assetsLoading ? 'Loading assets…' : assets.length ? `Choose a ${provider === 'ctrader' ? 'cTrader' : 'Hyperliquid'} asset…` : 'No assets available'}
                          searchPlaceholder={`Search ${provider === 'ctrader' ? 'cTrader' : 'Hyperliquid'} assets…`}
                          aria-label="Asset this team trades"
                        />
                        <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-4 text-fg-subtle">
                          <Info size={12} className="mt-0.5 shrink-0" />
                          <span>
                            {assetsNote}
                            {assetsLive.available
                              ? ' Live trading is available on this venue.'
                              : assetsLive.reason ? ` Live trading needs a broker: ${assetsLive.reason}` : ''}
                          </span>
                        </div>
                        {!assetsLive.available && (
                          <p className="mt-1.5 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-[10px] leading-4 text-fg-muted">
                            You can deploy and paper-trade now. A broker connection is only required for live trading.
                          </p>
                        )}
                      </div>

                      {/*
                        Live trading is opt-in and the ONLY thing that needs a
                        venue credential. Deploying, researching and paper
                        trading deliberately do not.
                      */}
                      <label className="flex items-start gap-3 rounded-xl border border-line bg-raised/70 p-3">
                        <input type="checkbox" checked={liveTrading} onChange={event => setLiveTrading(event.target.checked)} className="mt-0.5" />
                        <span>
                          <span className="block text-sm font-semibold text-fg">Allow live trading</span>
                          <span className="mt-1 block text-xs leading-5 text-fg-muted">
                            {liveTrading
                              ? 'This team may place real orders. A broker connection is required and checked before it deploys.'
                              : 'Off: the team researches and paper-trades only. Turn this on when you want real orders, which needs a connected broker.'}
                          </span>
                        </span>
                      </label>
                      <div>
                        <span className="mb-2 block text-xs font-medium text-fg-muted">Account balance</span>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-medium text-fg-muted">Room balance (USD)</span>
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={startingBalance}
                              onChange={event => setStartingBalance(event.target.value)}
                              className="input w-full"
                            />
                          </label>
                          <p className="self-end rounded-lg border border-line bg-raised px-2.5 py-2 text-[10px] leading-4 text-fg-muted">
                            {liveTrading
                              ? 'Live rooms show the connected account’s real balance instead; this stays as the recorded baseline.'
                              : 'No broker is behind this room, so this is the balance it runs on and sizes positions against.'}
                          </p>
                        </div>
                      </div>
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

          {/*
            Skill editor, layered above the team sheet. Authoring a skill here
            saves it to the user's global catalogue, so it is immediately
            reusable by every future member rather than being scoped to this
            team.
          */}
          {skillAuthor && (
            <div
              className="fixed inset-0 z-[110] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
              role="presentation"
              onMouseDown={event => { if (event.target === event.currentTarget && !skillSaving) setSkillAuthor(null); }}
            >
              <section role="dialog" aria-modal="true" aria-labelledby="skill-author-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-2xl sm:rounded-2xl">
                <header className="flex items-start justify-between gap-4 border-b border-line p-5">
                  <div className="min-w-0">
                    <h3 id="skill-author-title" className="text-lg font-semibold text-fg">Write a skill</h3>
                    <p className="mt-1 text-xs leading-5 text-fg-muted">
                      Markdown with optional frontmatter. Saved to your skills and attached to this member.
                    </p>
                  </div>
                  <button type="button" aria-label="Close skill editor" disabled={skillSaving} onClick={() => setSkillAuthor(null)} className="rounded-lg p-2 text-fg-muted hover:bg-raised"><X size={17} /></button>
                </header>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
                    <span>Supports frontmatter, # Titles, ## Constraints and free-form methodology.</span>
                    <button type="button" onClick={() => setSkillMarkdown(SKILL_STARTER)} className="shrink-0 text-accent-text hover:underline">Reset to template</button>
                  </div>
                  <textarea
                    value={skillMarkdown}
                    onChange={event => setSkillMarkdown(event.target.value)}
                    rows={14}
                    spellCheck={false}
                    aria-label="Skill markdown"
                    className="input !h-80 !font-mono !text-[12px] !leading-relaxed"
                  />
                  {(() => {
                    try {
                      const parsed = SkillParser.parse(skillMarkdown.trim());
                      return (
                        <div className="rounded-xl border border-line bg-raised p-3 text-[11px] leading-5 text-fg-muted">
                          <p className="font-semibold text-fg">Parsed as: {parsed.name}</p>
                          <p className="mt-1">{parsed.description}</p>
                          <p className="mt-1">Timeframes: {(parsed.preferredTimeframes || []).join(', ') || 'none detected'}</p>
                        </div>
                      );
                    } catch {
                      return null;
                    }
                  })()}
                  {skillError && <p role="alert" className="rounded-lg border border-negative/40 bg-negative-soft p-2.5 text-[11px] text-fg">{skillError}</p>}
                </div>

                <footer className="flex gap-2 border-t border-line p-5">
                  <button type="button" disabled={skillSaving} onClick={() => setSkillAuthor(null)} className="btn btn-secondary flex-1">Cancel</button>
                  <button type="button" disabled={skillSaving || !skillMarkdown.trim()} onClick={() => void saveAuthoredSkill()} className="btn btn-primary flex-1">
                    {skillSaving ? 'Saving…' : <><Check size={15} /> Save &amp; attach</>}
                  </button>
                </footer>
              </section>
            </div>
          )}
        </div>
      )}
      </>}
    </div>
  );
}