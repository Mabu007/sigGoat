/**
 * APPLICATION NAVIGATION
 * ======================
 * Sidebar on desktop, bottom bar on mobile. One array drives both so the two
 * can never drift apart.
 *
 * NAVIGATION MODEL
 *   Trade Rooms · Trades · Settings
 *
 *   `GOATs` was removed as a destination. A trading agent is no longer created
 *   on its own screen: members are authored inside the team builder, and a team
 *   of one member is the single-member case. The `goats` hash now redirects to
 *   Trade Rooms so old links land somewhere useful instead of a dead route.
 *
 *   `Overview` was removed earlier: it duplicated data available elsewhere and
 *   rendered little of its own.
 *
 *   `Skills` is likewise not a top-level destination. Skills are authored and
 *   read from inside a team member, which is where they are used; a separate
 *   top-level screen made them look like a peer of the others when they are
 *   really configuration. The route is preserved as a view so existing links
 *   keep working.
 *
 * ACTIVE INDICATION uses `aria-current="page"`, not only colour. A
 * colour-only indicator is invisible to anyone who cannot distinguish the
 * accent from the muted foreground.
 */

import { Bot, ListChecks, Settings, type LucideIcon } from 'lucide-react';

/** `goats` is intentionally absent: trading agents are created as teams. */
export type TabId =
  | 'rooms'
  | 'trades'
  | 'markets'
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
  { id: 'rooms', label: 'Trade Rooms', shortLabel: 'Rooms', icon: Bot },
  { id: 'trades', label: 'Trades', icon: ListChecks },
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
    <>
      {/* Desktop sidebar */}
      <nav
        aria-label="Main"
        className="premium-sidebar sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line md:flex"
      >
        <div className="flex h-[68px] items-center border-b border-line px-5">
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
                  className={`premium-nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors ${
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

      </nav>

      {/* Mobile bottom bar.
          `env(safe-area-inset-bottom)` keeps the last row clear of the home
          indicator on devices that have one — a hardcoded padding did not. */}
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
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-12 items-center justify-center rounded-md bg-transparent"
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