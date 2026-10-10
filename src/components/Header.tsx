/**
 * APPLICATION HEADER
 * ==================
 * Sticky top bar: identity on the left, market-data source and account
 * actions on the right.
 *
 * THE DATA SOURCE BADGE IS NOT DECORATIVE
 *   It shows the provider and, critically, whether the feed is LIVE or
 *   SIMULATED. That distinction is the single most important thing on the
 *   screen when prices are driving a trading decision, so it is rendered as a
 *   real state indicator rather than a decorative pill.
 */

import { RefreshCw, TrendingUp } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { BrandMark } from './Navigation';
import { useMarket } from '../context/MarketContext';

interface HeaderProps {
  displayName?: string | null;
  email?: string | null;
  dataMode?: 'LIVE' | 'PAPER';
  onOpenSettings: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  lastUpdatedMs?: number | null;
}

export function Header({
  displayName,
  email,
  dataMode = 'LIVE',
  onOpenSettings,
  onRefresh,
  refreshing = false,
  lastUpdatedMs,
}: HeaderProps) {
  const { quotesError, quotes } = useMarket();

  // Three distinct states, because they mean different things to a trader:
  // disconnected, degraded, or healthy.
  const sourceState = quotesError
    ? { tone: 'negative' as const, label: 'Feed offline' }
    : Object.keys(quotes).length === 0
      ? { tone: 'warning' as const, label: 'Connecting' }
      : { tone: 'positive' as const, label: 'Live' };

  const initials = (displayName ?? email ?? '?').trim().charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-lg">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-3 sm:px-6">
        {/* Mobile-only brand; the sidebar carries it on desktop. */}
        <div className="md:hidden">
          <BrandMark compact />
        </div>

        {/* Feed state */}
        <div className="flex min-w-0 items-center gap-2">
          <TrendingUp size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
          <span className="truncate text-[12px] font-medium text-fg-muted">
            Hyperliquid
          </span>
          <span className={`badge badge-${sourceState.tone}`}>
            <span className="sr-only">Market data status: </span>
            {sourceState.label}
          </span>
          {dataMode === 'PAPER' && (
            <span className="badge badge-warning" title="Simulated prices — not real market data">
              Simulated
            </span>
          )}
          {lastUpdatedMs ? (
            <span className="hidden text-[11px] text-fg-subtle sm:inline">
              {new Date(lastUpdatedMs).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          ) : null}
        </div>

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
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-lg border border-line py-1 pl-1 pr-2.5 text-left transition-colors hover:bg-raised"
            aria-label="Account and settings"
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-sunken text-[11px] font-semibold text-fg-muted"
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