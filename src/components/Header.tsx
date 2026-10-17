/**
 * APPLICATION HEADER
 * ==================
 * Sticky top bar: identity on the left, market-data source and account
 * actions on the right.
 *
 * Feed health is no longer surfaced here. It was a three-state badge, but the
 * only value it ever carried was "Feed offline", which said nothing actionable
 * and duplicated state the market views already own. Where it matters, PAPER
 * versus LIVE is now labelled per view, at the point the data is consumed.
 */

import { RefreshCw, Sparkles, Users } from 'lucide-react';
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

export function Header({
  displayName,
  email,
  onOpenSettings,
  onCreateBotTeam,
  onRefresh,
  refreshing = false,
  lastUpdatedMs,
}: HeaderProps) {
  const initials = (displayName ?? email ?? '?').trim().charAt(0).toUpperCase();

  return (
    <header className="premium-header sticky top-0 z-30 border-b border-line">
      <div className="mx-auto flex h-[68px] w-full max-w-7xl items-center gap-3 px-3 sm:px-6">
        {/* Mobile-only brand; the sidebar carries it on desktop. */}
        <div className="md:hidden">
          <BrandMark compact />
        </div>

        {/* Feed state */}
        {lastUpdatedMs ? (
          <span className="hidden text-[11px] text-fg-subtle sm:inline">
            {new Date(lastUpdatedMs).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="btn btn-ghost h-9 w-9 !px-0"
            aria-label="Refresh market data"
            title="Refresh"
          >
            <RefreshCw
              size={15}
              aria-hidden="true"
              className={refreshing ? 'animate-spin' : ''}
            />
          </button>

          <ThemeToggle />

          <button
            type="button"
            onClick={onCreateBotTeam}
            className="btn btn-primary h-9 !px-3"
            aria-label="Create Bot Team"
            title="Create Bot Team"
          >
            <Users size={15} aria-hidden="true" />
            <span className="hidden sm:inline">Create Bot Team</span>
            <span className="sm:hidden">Create</span>
          </button>

          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('sirgoat-chatbot-open'))}
            className="group relative flex items-center gap-2 rounded-xl border border-line bg-raised/70 px-3 py-2 text-[12px] font-semibold text-fg shadow-sm transition-all hover:border-line-strong hover:bg-raised md:px-4"
            aria-label="Open AI assistant"
            title="AI assistant"
          >
            <Sparkles
              size={15}
              aria-hidden="true"
              className="text-accent-text transition-transform group-hover:scale-110"
            />
            <span className="hidden sm:inline">AI assistant</span>
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-xl border border-line bg-raised/60 py-1 pl-1 pr-2.5 text-left shadow-sm transition-all hover:border-line-strong hover:bg-raised"
            aria-label="Account and settings"
          >
            <span
              aria-hidden="true"
              className="premium-avatar flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-bold text-fg"
            >
              {initials}
            </span>
            <span className="hidden max-w-[120px] truncate text-[12px] font-medium text-fg sm:inline">
              {displayName ?? email ?? 'Account'}
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}