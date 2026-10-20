/**
 * APPLICATION NAVIGATION
 * ======================
 * Sidebar on desktop, bottom bar on mobile. One array drives both so the two
 * can never drift apart.
 *
 * NAVIGATION MODEL
 *   Rooms · Markets · Settings
 *
 * TradingVibes is a social trading product: rooms, markets, and the settings
 * that connect an account. The destinations that belonged to the previous
 * product — trade proposals, agent skills, backtests — are gone from the
 * navigation. Their hashes still resolve, to the room directory, so an old
 * link lands somewhere real instead of a dead screen.
 *
 * ACTIVE INDICATION uses `aria-current="page"`, not only colour. A
 * colour-only indicator is invisible to anyone who cannot distinguish the
 * accent from the muted foreground.
 */

import { CandlestickChart, Settings, Users, type LucideIcon } from 'lucide-react';

export type TabId =
  | 'rooms'
  | 'markets'
  | 'settings';

export interface NavigationItem {
  id: TabId;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bar. Long labels are abbreviated there. */
  shortLabel?: string;
}

export const NAVIGATION_ITEMS: NavigationItem[] = [
  { id: 'rooms', label: 'Rooms', shortLabel: 'Rooms', icon: Users },
  { id: 'markets', label: 'Markets', icon: CandlestickChart },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/**
 * The TradingVibes mark: three rising candles on a plate.
 *
 * It is drawn inline rather than loaded from an image so it inherits the
 * theme's accent colour, stays crisp at any size, and never waits on a
 * network request to paint.
 */
export function BrandLogo({
  className = 'h-9 w-9',
  alt = 'TradingVibes logo',
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent-soft text-accent-text ${className}`}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <path d="M10.5 13.5V26" />
          <path d="M16 8.5V23" />
          <path d="M21.5 6V20.5" />
        </g>
        <g fill="currentColor">
          <rect x="8.25" y="17" width="4.5" height="6.5" rx="1.25" />
          <rect x="13.75" y="12" width="4.5" height="8" rx="1.25" />
          <rect x="19.25" y="8.5" width="4.5" height="9.5" rx="1.25" />
        </g>
      </svg>
    </span>
  );
}

/** The TradingVibes wordmark. */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <BrandLogo className="h-9 w-9 rounded-xl" alt="" />
      {!compact && (
        <span className="text-[15px] font-bold tracking-[0.11em] text-fg">
          TRADING<span className="text-accent-text">VIBES</span>
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
    <nav
      aria-label="Main"
      className="premium-header fixed inset-x-0 bottom-0 z-40 border-t border-line md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <ul className="mx-auto grid max-w-lg grid-cols-3">
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
                <span aria-hidden="true" className="flex h-7 w-12 items-center justify-center rounded-md bg-transparent">
                  <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
                </span>
                {item.shortLabel ?? item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
