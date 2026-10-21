import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  INDICATOR_CATALOG,
  INDICATOR_CATEGORIES,
  type IndicatorCatalogEntry,
} from '../../services/strategy/indicators/catalog';

/**
 * THE INDICATOR PICKER
 * ====================
 *
 * A searchable list of the whole catalog. The user picks an indicator by
 * its readable name; the builder generates the internal id, so nobody ever
 * types one.
 */

export function IndicatorPicker({ onPick, onClose }: { onPick: (entry: IndicatorCatalogEntry) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return INDICATOR_CATALOG.filter(entry => {
      if (activeCategory !== 'all' && entry.category !== activeCategory) return false;
      if (!text) return true;
      return `${entry.key} ${entry.name} ${entry.shortName} ${entry.description}`.toLowerCase().includes(text);
    });
  }, [query, activeCategory]);

  const grouped = useMemo(() => INDICATOR_CATEGORIES.map(category => ({
    category,
    entries: matches.filter(entry => entry.category === category.key),
  })).filter(group => group.entries.length > 0), [matches]);

  return <div className="rounded-xl border border-line bg-sunken/70 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-1 items-center gap-2 rounded-lg border border-line bg-raised px-2">
        <Search size={14} className="text-fg-subtle" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search indicators"
          aria-label="Search indicators"
          className="w-full bg-transparent py-2 text-sm text-fg outline-none"
        />
      </div>
      <button type="button" onClick={onClose} aria-label="Close the indicator list" className="text-fg-subtle"><X size={16} /></button>
    </div>
    <div className="mt-2 flex flex-wrap gap-1.5">
      <button type="button" onClick={() => setActiveCategory('all')} className={activeCategory === 'all' ? 'badge badge-neutral is-active' : 'badge badge-neutral'}>All</button>
      {INDICATOR_CATEGORIES.map(category => (
        <button key={category.key} type="button" onClick={() => setActiveCategory(category.key)} className={activeCategory === category.key ? 'badge badge-neutral is-active' : 'badge badge-neutral'}>{category.label}</button>
      ))}
    </div>
    <div className="mt-3 max-h-72 overflow-y-auto pr-1">
      {grouped.length === 0 && <p className="text-xs text-fg-muted">No indicator matches that search.</p>}
      {grouped.map(group => <div key={group.category.key} className="mb-3">
        <p className="text-[11px] font-bold uppercase tracking-[.16em] text-fg-subtle">{group.category.label}</p>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {group.entries.map(entry => <button
            key={entry.key}
            type="button"
            onClick={() => onPick(entry)}
            title={entry.description}
            className="rounded-lg border border-line bg-raised/60 px-3 py-2 text-left hover:border-accent/50"
          >
            <span className="block text-sm font-semibold text-fg">{entry.name}</span>
            <span className="mt-0.5 block text-[11px] text-fg-subtle">
              {entry.parameters.length ? entry.parameters.map(parameter => `${parameter.label} ${parameter.default}`).join(' · ') : 'no parameters'}
            </span>
          </button>)}
        </div>
      </div>)}
    </div>
  </div>;
}
