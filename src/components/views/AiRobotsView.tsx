import { useCallback, useEffect, useState } from 'react';
import { Bot, Plus, RefreshCw, Sparkles, Users, Activity } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { AiRobotBuilder } from '../AiRobotBuilder';

type PublicRobot = {
  id: string;
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  coverUrl: string | null;
  creatorName: string;
  status: string;
  markets: string[];
  latestThesis: { market: string; bias: string; summary: string; updatedAt: string } | null;
  updatedAt: string;
};

export function AiRobotsView() {
  const { currentUser, authMode, getApiAuthHeaders, openAuthModal } = useAuth();
  const signedIn = Boolean(currentUser) || authMode === 'dev';
  const [robots, setRobots] = useState<PublicRobot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const headers = useCallback(async (json = false) => {
    const result = new Headers(json ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' });
    try { for (const [key, value] of Object.entries(await getApiAuthHeaders())) result.set(key, value); } catch { /* public feed */ }
    return result;
  }, [getApiAuthHeaders]);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/goat-teams/public', { headers: await headers(), cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'AI robots could not be loaded.');
      setRobots((body.rooms ?? []).filter((item: PublicRobot) => item.slug));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI robots could not be loaded.');
    } finally { setLoading(false); setRefreshing(false); }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  const create = () => signedIn ? setCreateOpen(true) : openAuthModal('signup');
  const openRobot = (slug: string) => { window.location.href = `/robots/${encodeURIComponent(slug)}`; };

  return <div className="mx-auto max-w-7xl space-y-6">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-red-500">SignalGoat · AI Robots</p>
        <h1 className="mt-1 text-2xl font-black text-fg sm:text-3xl">AI Robots</h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">Explore every AI robot, follow its market analysis, and connect your own PropDAO or cTrader account from its room.</p>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-secondary" type="button" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh AI robots"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''}/> Refresh</button>
        <button className="btn btn-primary" type="button" onClick={create}><Plus size={15}/> Create AI robot</button>
      </div>
    </header>

    {error && <div role="alert" className="panel p-4 text-danger">{error}</div>}
    {loading ? <div role="status" className="panel p-10 text-center text-fg-muted">Loading AI robots…</div>
      : robots.length === 0 ? <section className="panel grid justify-items-center gap-3 p-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent-text"><Bot size={23}/></span>
        <h2 className="text-lg font-bold text-fg">No AI robots yet</h2>
        <p className="max-w-md text-sm text-fg-muted">Create the first one. Its analysis will appear here and in its robot room.</p>
        <button className="btn btn-primary mt-1" type="button" onClick={create}><Sparkles size={15}/> Create an AI robot</button>
      </section>
      : <div className="grid gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {robots.map(robot => <button key={robot.id} type="button" onClick={() => openRobot(robot.slug)} className="group min-w-0 text-left">
          <span className="relative block aspect-video overflow-hidden rounded-xl border border-line bg-panel-muted shadow-sm transition group-hover:border-accent/50 group-hover:shadow-lg">
            {robot.coverUrl ? <img src={robot.coverUrl} alt={`${robot.name} cover`} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
              : <span className="grid h-full w-full place-items-center bg-gradient-to-br from-sunken via-raised to-accent-soft text-accent-text"><Bot size={38} strokeWidth={1.4}/></span>}
            <span className="absolute left-2.5 top-2.5 rounded-md border border-black/20 bg-black/65 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur">{robot.latestThesis?.bias || 'Monitoring'}</span>
            <span className="absolute bottom-2.5 right-2.5 rounded-md bg-black/75 px-2 py-1 text-[10px] font-semibold text-white">{robot.markets[0] || 'AI Robot'}</span>
          </span>
          <span className="mt-3 flex gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-panel-muted text-accent-text"><Bot size={19}/></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-fg group-hover:text-accent-text">{robot.name}</span>
              <span className="mt-1 flex items-center gap-2 text-[11px] text-fg-muted"><span className="truncate">{robot.creatorName}</span><span aria-hidden="true">·</span><Users size={12}/>{robot.memberCount}<Activity size={12}/>{robot.status}</span>
              <span className="mt-1 line-clamp-2 block text-xs leading-5 text-fg-subtle">{robot.description}</span></span>
          </span>
        </button>)}
      </div>}

    {createOpen && <AiRobotBuilder headers={headers} onClose={() => setCreateOpen(false)} onCreated={path => { setCreateOpen(false); window.location.assign(path); }} />}
  </div>;
}
