/**
 * APPLICATION NAVIGATION
 * ======================
 * Sidebar on desktop, bottom bar on mobile. One array drives both so the two
 * can never drift apart.
 *
 * NAVIGATION MODEL
 *   Rooms · Markets · Settings
 *
 * SIRGOAT is a social trading product: rooms, markets, and the settings that
 * connect an account. The destinations that belonged to the previous product
 * — trade proposals, agent skills, backtests — are gone from the navigation.
 * Their hashes still resolve, to the room directory, so an old link lands
 * somewhere real instead of a dead screen.
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
  { id: 'rooms', label: 'Trading Rooms', shortLabel: 'Rooms', icon: Users },
  { id: 'markets', label: 'Markets', icon: CandlestickChart },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/** Shared SIRGOAT logo asset, with rounded corners at every app size. */
export function BrandLogo({
  className = 'h-9 w-9',
  alt = 'SIRGOAT logo',
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src="https://res.cloudinary.com/dlguuk8lt/image/upload/v1792056929/sirgoat_fmuhqm.jpg"
      alt={alt}
      loading="eager"
      decoding="async"
      draggable={false}
      className={`shrink-0 rounded-xl object-cover ${className}`}
    />
  );
}

/** The SIRGOAT wordmark. */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <BrandLogo className="h-9 w-9 rounded-xl" alt="" />
      {!compact && (
        <span className="text-[15px] font-bold tracking-[0.11em] text-fg">
          SIR<span className="text-accent-text">GOAT</span>
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
