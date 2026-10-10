/**
 * APPLICATION NAVIGATION
 * ======================
 * Sidebar on desktop, bottom bar on mobile. One array drives both so the two
 * can never drift apart.
 *
 * NAVIGATION MODEL
 *   Markets · GOATs · Proposals · Backtest · Settings
 *
 *   `Overview` was removed: it duplicated data available in Markets / GOATs /
 *   Proposals and rendered little of its own. The `overview` hash still
 *   redirects to Markets at the router level so old links do not 404.
 *
 *   `Skills` from the previous build is likewise not a top-level destination.
 *   Skills are authored and read from inside a GOAT, which is where they are
 *   used; a separate top-level screen made them look like a peer of Markets
 *   when they are really configuration. The route is preserved as a view so
 *   existing links keep working.
 *
 * ACTIVE INDICATION uses `aria-current="page"`, not only colour. A
 * colour-only indicator is invisible to anyone who cannot distinguish the
 * accent from the muted foreground.
 */

import {
  BarChart3,
  Bot,
  CandlestickChart,
  ListChecks,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export type TabId =
  | 'markets'
  | 'goats'
  | 'proposals'
  | 'skills'
  | 'backtest'
  | 'settings';

export interface NavigationItem {
  id: TabId;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bar. Long labels are abbreviated there. */
  shortLabel?: string;
}

export const NAVIGATION_ITEMS: NavigationItem[] = [
  { id: 'markets', label: 'Markets', icon: CandlestickChart },
  { id: 'goats', label: 'Goats', icon: Bot },
  { id: 'proposals', label: 'Proposals', icon: ListChecks },
  { id: 'backtest', label: 'Backtest', shortLabel: 'Test', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/** The wordmark. Split so "AGoat" can carry the accent. */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
          <path
            d="M4 17.5 9 11l3.5 3.5L20 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="20" cy="6" r="2" fill="currentColor" />
        </svg>
      </span>
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-fg">
          Fund<span className="text-accent-text">AGoat</span>
        </span>
      )}
    </span>
  );
}

interface NavigationProps {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
}

export function Navigation({ activeTab, onSelect }: NavigationProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <nav
        aria-label="Main"
        className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex"
      >
        <div className="flex h-14 items-center border-b border-line px-4">
          <BrandMark />
        </div>

        <ul className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {NAVIGATION_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeTab;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${
                    active
                      ? 'bg-accent-soft text-accent-text'
                      : 'text-fg-muted hover:bg-raised hover:text-fg'
                  }`}
                >
                  <Icon size={16} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-line p-3">
          <p className="text-[11px] leading-relaxed text-fg-subtle">
            Research and proposals only.
            <br />
            FundAGoat does not place orders.
          </p>
        </div>
      </nav>

      {/* Mobile bottom bar.
          `env(safe-area-inset-bottom)` keeps the last row clear of the home
          indicator on devices that have one — a hardcoded padding did not. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-lg md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <ul className="mx-auto grid max-w-lg grid-cols-5">
          {NAVIGATION_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeTab;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex w-full flex-col items-center gap-0.5 px-1 py-2 text-[10px] font-medium transition-colors ${
                    active ? 'text-accent-text' : 'text-fg-subtle'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-7 w-12 items-center justify-center rounded-md ${
                      active ? 'bg-accent-soft' : ''
                    }`}
                  >
                    <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
                  </span>
                  {item.shortLabel ?? item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}