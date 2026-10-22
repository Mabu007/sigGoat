import { useCallback, useEffect, useState } from 'react';
import { Bot, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { AiRobotBuilder } from '../strategy/AiRobotBuilder';

type PublicRobot = {
  id: string;
  slug: string;
  name: string;
  description: string;
  creatorName: string;
  status: string;
  memberCount: number;
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
  const openRobot = (slug: string) => { window.location.href = `/team/${encodeURIComponent(slug)}`; };

  return <div className="mx-auto max-w-7xl space-y-6">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-red-500">SignalGoat · AI Robots</p>
        <h1 className="mt-1 text-2xl font-black text-fg sm:text-3xl">Public AI robots</h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">Watch each robot’s market analysis, review history, and proposals. Connect your own PropDAO or cTrader account in a robot room to set up your personal trading access.</p>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-secondary" type="button" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh AI robots"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''}/> Refresh</button>
        <button className="btn btn-primary" type="button" onClick={create}><Plus size={15}/> Create AI robot</button>
      </div>
    </header>

    {error && <div role="alert" className="panel p-4 text-danger">{error}</div>}
    {loading ? <div role="status" className="panel p-10 text-center text-fg-muted">Loading public AI robots…</div>
      : robots.length === 0 ? <section className="panel grid justify-items-center gap-3 p-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent-text"><Bot size={23}/></span>
        <h2 className="text-lg font-bold text-fg">No public AI robots yet</h2>
        <p className="max-w-md text-sm text-fg-muted">Create the first one. Its analysis will appear here and in its public team room.</p>
        <button className="btn btn-primary mt-1" type="button" onClick={create}><Sparkles size={15}/> Create an AI robot</button>
      </section>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {robots.map(robot => <article key={robot.id} className="panel flex min-h-64 flex-col overflow-hidden transition hover:border-accent/40">
          <div className="flex items-start justify-between gap-3 border-b border-line p-4">
            <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.14em] text-accent-text">Public AI robot</p><h2 className="mt-1 truncate text-lg font-bold text-fg">{robot.name}</h2><p className="mt-1 text-xs text-fg-muted">By {robot.creatorName} · {robot.markets.slice(0, 3).join(', ') || 'Market analysis'}</p></div>
            <span className="shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-400">{robot.status}</span>
          </div>
          <div className="flex-1 space-y-3 p-4">
            <p className="line-clamp-3 text-sm leading-6 text-fg-muted">{robot.description}</p>
            {robot.latestThesis ? <div className="rounded-xl border border-line bg-panel-muted p-3">
              <div className="flex justify-between gap-2 text-[10px] font-bold uppercase tracking-wide text-fg-subtle"><span>Latest analysis · {robot.latestThesis.market}</span><span>{robot.latestThesis.bias}</span></div>
              <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs leading-5 text-fg-muted">{robot.latestThesis.summary}</p>
              <time className="mt-2 block text-[10px] text-fg-subtle" dateTime={robot.latestThesis.updatedAt}>{new Date(robot.latestThesis.updatedAt).toLocaleString()}</time>
            </div> : <p className="rounded-xl border border-dashed border-line p-3 text-xs text-fg-subtle">Waiting for its first analysis run.</p>}
          </div>
          <button type="button" className="m-4 mt-0 btn btn-secondary justify-center" onClick={() => openRobot(robot.slug)}>Watch robot · open team room</button>
        </article>)}
      </div>}

    {createOpen && <AiRobotBuilder headers={headers} onClose={() => setCreateOpen(false)} onCreated={path => { setCreateOpen(false); window.location.assign(path); }} />}
  </div>;
}
