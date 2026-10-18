import { useState } from 'react';
import { ListChecks, Plus, RefreshCw, Search, Sparkles } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { BrandMark } from './Navigation';

interface HeaderProps {
  displayName?: string | null;
  email?: string | null;
  onOpenSettings: () => void;
  onCreateBotTeam: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  lastUpdatedMs?: number | null;
}

export function Header({ displayName, email, onOpenSettings, onCreateBotTeam, onRefresh, refreshing = false, lastUpdatedMs }: HeaderProps) {
  const [search, setSearch] = useState('');
  const initials = (displayName ?? email ?? '?').trim().charAt(0).toUpperCase();
  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('sirgoat-directory-search', { detail: search.trim() }));
    if (window.location.hash !== '#/rooms') window.location.hash = '/rooms';
  };

  return (
    <header className="premium-header yt-header sticky top-0 z-30 border-b border-line">
      <div className="yt-header-inner flex h-[68px] w-full items-center gap-4 px-4 sm:px-6">
        <button type="button" onClick={() => { window.location.hash = '/rooms'; window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); }} aria-label="SIRGOAT home — Teams" title="Back to Teams" className="flex shrink-0 items-center gap-3 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <BrandMark compact />
          <span className="hidden text-[15px] font-extrabold tracking-tight text-fg sm:inline">SIR<span className="text-accent-text">GOAT</span></span>
        </button>

        <form onSubmit={submitSearch} className="yt-search mx-auto flex w-full max-w-[620px] items-center">
          <Search size={18} className="ml-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search trading rooms, bots, markets..." aria-label="Search trading rooms, bots and markets" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle" />
          {search && <button type="button" onClick={() => { setSearch(''); window.dispatchEvent(new CustomEvent('sirgoat-directory-search', { detail: '' })); }} aria-label="Clear search" className="px-2 text-fg-subtle hover:text-fg">×</button>}
          <button type="submit" aria-label="Search" className="yt-search-button flex h-10 w-14 shrink-0 items-center justify-center"><Search size={18} /></button>
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {lastUpdatedMs ? <span className="hidden text-[10px] text-fg-subtle xl:inline">{new Date(lastUpdatedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
          <button type="button" onClick={onRefresh} className="btn btn-ghost h-9 w-9 !px-0" aria-label="Refresh market data" title="Refresh market data"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /></button>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('sirgoat-chatbot-open'))} className="yt-icon-button hidden sm:flex" aria-label="Open AI assistant" title="AI assistant"><Sparkles size={18} /></button>
          <button type="button" onClick={() => { window.location.hash = '/trades'; }} className="yt-icon-button flex" aria-label="View trades" title="Trades"><ListChecks size={18} /></button>
          <ThemeToggle />
          <button type="button" onClick={onCreateBotTeam} className="yt-create-button flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold" aria-label="Create trading room"><Plus size={18} /><span className="hidden lg:inline">Create</span></button>
          <button type="button" onClick={onOpenSettings} className="yt-avatar flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold" aria-label="Account and settings">{initials}</button>
        </div>
      </div>
    </header>
  );
}
