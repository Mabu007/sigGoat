import { useState } from 'react';
import { Activity } from 'lucide-react';
import { DefaultRobotCover } from './DefaultRobotCover';

/** A wide artwork card that opens the robot's own workspace. */

export interface RobotSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  creatorName: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  market: string;
  assetSelected?: boolean;
  alertPreferences?: { entry: boolean; exit: boolean; fill: boolean; risk: boolean };
  contactPhone?: string;
  timeframe: string;
  runtimeStatus: 'STOPPED' | 'PAPER' | 'ERROR';
  currentVersion: number;
  coverUrl?: string | null;
  brokerAccount?: { provider: string; accountId: string; label: string; environment: string } | null;
  lastBacktest?: {
    totalReturn: number;
    winRate: number;
    maxDrawdown: number;
    completedTrades: number;
    at: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/** Kept for the existing robot details sheet. */
export type RobotCardAction = 'pairs' | 'trade' | 'info';

export function RobotCard({
  robot,
  onOpen,
}: {
  robot: RobotSummary;
  onOpen: () => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const showArtwork = !robot.coverUrl || coverFailed;

  return (
    <article className="group min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${robot.name}`}
        className="robot-directory-card relative block aspect-video w-full overflow-hidden rounded-2xl bg-[#0a0710] text-left shadow-lg transition duration-200 hover:-translate-y-1 hover:shadow-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
      >
        {showArtwork ? (
          <DefaultRobotCover seed={robot.id} className="absolute inset-0 h-full w-full" />
        ) : (
          <img
            src={robot.coverUrl ?? ''}
            alt={`${robot.name} cover`}
            loading="lazy"
            decoding="async"
            onError={() => setCoverFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}

        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black via-black/65 to-transparent" />
        <span className="absolute inset-x-0 bottom-0 block px-5 pb-5 pt-12 text-white sm:px-6 sm:pb-6">
          <span className="block text-xl font-bold leading-tight tracking-tight drop-shadow-md">{robot.name}</span>
          <span className="mt-1.5 line-clamp-2 block text-[13px] font-light leading-relaxed text-white/75">{robot.description || 'Explore this trading bot.'}</span>
        </span>
      </button>
    </article>
  );
}

/** The empty state for a directory with nothing in it. */
export function RobotEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="panel flex flex-col items-center p-10 text-center">
      <Activity size={28} className="text-accent-text" />
      <h2 className="mt-3 font-semibold">No trading robots yet</h2>
      <p className="mt-2 max-w-sm text-sm text-fg-muted">
        Build a strategy, backtest it, and publish it to the marketplace.
      </p>
      <button type="button" onClick={onCreate} className="btn btn-primary mt-4">
        Create the first robot
      </button>
    </div>
  );
}
