import { useEffect, useRef, useState } from 'react';
import { LogIn, LogOut, Plus, RefreshCw, Search, Settings, UserRound } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { BrandMark } from './Navigation';
import { UserAvatar } from './UserAvatar';
import { useAuth } from '../context/AuthContext';
import { useProfilePictureSnapshot } from '../hooks/useProfilePicture';

interface HeaderProps {
  displayName?: string | null;
  email?: string | null;
  onOpenSettings: () => void;
  onCreateRoom: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  lastUpdatedMs?: number | null;
}

export function Header({ displayName, email, onOpenSettings, onCreateRoom, onRefresh, refreshing = false, lastUpdatedMs }: HeaderProps) {
  const [search, setSearch] = useState('');
  const { currentUser, authMode, openAuthModal, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /**
   * THE PROFILE PICTURE.
   *
   * It comes from the shared profile-picture store, so a picture saved in
   * Settings appears here without a reload. The header used to keep its own
   * copy, fetched separately, which is why the two could disagree.
   */
  const { url: avatarUrl } = useProfilePictureSnapshot();

  const signedIn = Boolean(currentUser) || authMode === 'dev';
  const initials = (displayName ?? email ?? '?').trim().charAt(0).toUpperCase();



  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('tradingvibes-directory-search', { detail: search.trim() }));
    if (window.location.hash !== '#/rooms') window.location.hash = '/rooms';
  };

  /**
   * The account menu closes on an outside click or on Escape, so it never
   * traps the person who opened it.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <header className="premium-header yt-header sticky top-0 z-30 border-b border-line">
      <div className="yt-header-inner flex h-[68px] w-full items-center gap-4 px-4 sm:px-6">
        <button type="button" onClick={() => { window.location.hash = '/rooms'; window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); }} aria-label="TradingVibes home — Robots" title="Back to Robots" className="flex shrink-0 items-center gap-3 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <BrandMark compact />
          <span className="hidden text-[15px] font-extrabold tracking-tight text-fg sm:inline">TRADING<span className="text-accent-text">VIBES</span></span>
        </button>

        <form onSubmit={submitSearch} className="yt-search mx-auto flex w-full max-w-[620px] items-center">
          <Search size={18} className="ml-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search trading robots and strategies..." aria-label="Search trading robots" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle" />
          {search && <button type="button" onClick={() => { setSearch(''); window.dispatchEvent(new CustomEvent('tradingvibes-directory-search', { detail: '' })); }} aria-label="Clear search" className="px-2 text-fg-subtle hover:text-fg">×</button>}
          <button type="submit" aria-label="Search" className="yt-search-button flex h-10 w-14 shrink-0 items-center justify-center"><Search size={18} /></button>
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {lastUpdatedMs ? <span className="hidden text-[10px] text-fg-subtle xl:inline">{new Date(lastUpdatedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
          <button type="button" onClick={onRefresh} className="btn btn-ghost h-9 w-9 !px-0" aria-label="Refresh market data" title="Refresh market data"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /></button>
          <ThemeToggle />

          {signedIn ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen(open => !open)}
                className="yt-avatar flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold"
                aria-label="Your account"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <UserAvatar name={displayName ?? email} url={avatarUrl} initials={initials} size={36} />
              </button>
              {menuOpen && (
                <div role="menu" className="absolute right-0 top-11 z-40 w-60 overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-2xl">
                  <div className="border-b border-line px-4 py-3">
                    <p className="truncate text-[12px] font-semibold text-fg">{displayName || 'Trader'}</p>
                    {email && <p className="mt-0.5 truncate text-[10px] text-fg-subtle">{email}</p>}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onOpenSettings(); }}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12px] text-fg hover:bg-raised"
                  >
                    <Settings size={14} aria-hidden="true" /> Settings
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); void logout(); }}
                    className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 text-left text-[12px] text-fg hover:bg-raised"
                  >
                    <LogOut size={14} aria-hidden="true" /> Log out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button type="button" onClick={() => openAuthModal('signin')} className="btn btn-secondary h-9 gap-2 px-3 text-[12px] font-semibold">
              <LogIn size={14} aria-hidden="true" /> <span className="hidden sm:inline">Log in</span>
            </button>
          )}

          <button type="button" onClick={onCreateRoom} className="yt-create-button flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold" aria-label="Create a trading robot"><Plus size={18} /><span className="hidden lg:inline">Create robot</span></button>
        </div>
      </div>
    </header>
  );
}
