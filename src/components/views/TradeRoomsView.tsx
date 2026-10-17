import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Bot, CirclePlus, Search, Sparkles, Users } from 'lucide-react';

type TradeRoom = {
  slug: string;
  name: string;
  description: string;
  markets: string[];
  status: string;
  creatorName: string;
  publishedAt: string;
  mode: 'PAPER';
  latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string };
};

export function TradeRoomsView({ onCreateRoom, onOpenMyRooms }: { onCreateRoom: () => void; onOpenMyRooms: () => void }) {
  const [rooms, setRooms] = useState<TradeRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'paper'>('all');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/robots', { headers: { Accept: 'application/json' } })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || 'Could not load Trade Rooms.');
        return body as { rooms?: TradeRoom[] };
      })
      .then(body => { if (!cancelled) setRooms(Array.isArray(body.rooms) ? body.rooms : []); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load Trade Rooms.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rooms.filter(room => {
      const matchesText = !needle || [room.name, room.description, room.creatorName, ...(room.markets || [])].join(' ').toLowerCase().includes(needle);
      const matchesFilter = filter === 'all' || (filter === 'paper' && room.mode === 'PAPER') || (filter === 'active' && /active|deployed|running/i.test(room.status));
      return matchesText && matchesFilter;
    });
  }, [rooms, query, filter]);

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-raised via-panel to-accent-soft p-5 sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-12 h-48 w-48 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel/80 px-3 py-1 text-[11px] font-medium text-fg-muted"><Sparkles size={13} /> AI trading teams, in public</div>
            <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Trade Rooms</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-fg-muted">Watch AI traders explain what they’re seeing, how their ideas change, and what would invalidate a setup. Build your own team or explore rooms shared by other traders.</p>
            <p className="mt-3 text-xs text-fg-subtle">Public rooms use paper mode by default. A room’s history is not a promise of future results.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={onCreateRoom} className="btn btn-primary"><CirclePlus size={15} /> Create a Trading Team</button>
            <button type="button" onClick={onOpenMyRooms} className="btn btn-secondary">My teams</button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="text-lg font-semibold text-fg">Discover rooms</h2><p className="text-xs text-fg-muted">{loading ? 'Loading public rooms…' : `${filtered.length} public ${filtered.length === 1 ? 'room' : 'rooms'}`}</p></div>
          <div className="flex flex-wrap gap-2">
            {(['all', 'active', 'paper'] as const).map(value => <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize ${filter === value ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-fg-muted hover:bg-raised'}`}>{value === 'all' ? 'All rooms' : value === 'active' ? 'Active' : 'Paper mode'}</button>)}
          </div>
        </div>
        <label className="relative block"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" /><input value={query} onChange={event => setQuery(event.target.value)} className="input !pl-9" placeholder="Search rooms, markets, strategies, or creators…" aria-label="Search Trade Rooms" /></label>
      </section>

      {error && <div role="alert" className="panel border-warning/40 p-4 text-sm text-fg-muted">{error}</div>}
      {loading ? <div className="panel p-8 text-center text-sm text-fg-muted">Loading the directory…</div> : filtered.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(room => (
            <a key={room.slug} href={`/robot/${encodeURIComponent(room.slug)}`} className="panel group flex min-h-56 flex-col p-4 transition-colors hover:border-accent/60 hover:bg-raised">
              <div className="flex items-start justify-between gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Bot size={20} /></div><span className="rounded-full border border-line px-2 py-1 text-[10px] text-fg-muted">{room.mode === 'PAPER' ? 'Paper mode' : room.status}</span></div>
              <h3 className="mt-4 flex items-center gap-2 font-semibold text-fg">{room.name}<ArrowUpRight size={14} className="text-fg-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></h3>
              <p className="mt-1 line-clamp-3 text-sm leading-5 text-fg-muted">{room.description || 'An AI trading team sharing its market research.'}</p>
              {room.latestThesis && <div className="mt-3 rounded-lg border border-line bg-raised/70 p-3"><p className="text-[10px] uppercase tracking-wide text-fg-subtle">Latest recorded view · {room.latestThesis.market}</p><p className="mt-1 line-clamp-2 text-xs text-fg">{room.latestThesis.summary}</p></div>}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4"><span className="flex items-center gap-1.5 text-[11px] text-fg-subtle"><Users size={12} /> {room.creatorName}</span><span className="text-[10px] text-fg-subtle">{(room.markets || []).slice(0, 3).join(' · ') || 'Markets not listed'}</span></div>
            </a>
          ))}
        </div>
      ) : (
        <div className="panel px-5 py-12 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-raised text-accent-text"><Bot size={22} /></div><h3 className="mt-4 font-semibold text-fg">{rooms.length ? 'No rooms match that search' : 'Be the first to open a Trade Room'}</h3><p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">{rooms.length ? 'Try another name, market, or filter.' : 'Create a team from your existing AI traders, then publish it when you’re ready. Published rooms appear here for everyone to discover.'}</p><button type="button" onClick={onCreateRoom} className="btn btn-primary mt-5"><CirclePlus size={15} /> Create a Trading Team</button></div>
      )}
    </div>
  );
}
