import { useState } from 'react';
import { Activity, Info, Play, TrendingUp } from 'lucide-react';
import { DefaultRobotCover } from './DefaultRobotCover';

/**
 * THE ROBOT CARD
 * ==============
 *
 * A portrait poster with a floating control bar, in the spirit of the
 * automated-trading apps the design is based on.
 *
 * THE THREE CONTROLS ARE REAL
 * ---------------------------
 *   PAIRS  the instruments and the timeframe the robot trades.
 *   TRADE  the trading workspace: mode, strategy, performance, controls.
 *   INFO   the full reference: creator, instruments, strategy, risk, and
 *           the verified performance, with historical, paper and live
 *           clearly separated.
 *
 * None of them is decorative. Each one opens a sheet that answers a
 * question, and each one is a real button for a keyboard and for a screen
 * reader.
 *
 * THE COVER
 * ---------
 * An uploaded cover is a real image, lazy loaded, with the object-fit that
 * keeps a 4:5 portrait filling the frame. Without one, the drawn default
 * artwork stands in. The two never look the same, so a missing cover is
 * obvious rather than broken.
 */

export interface RobotSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  creatorName: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  market: string;
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

export type RobotCardAction = 'pairs' | 'trade' | 'info';

const STATUS_LABEL: Record<RobotSummary['runtimeStatus'], string> = {
  PAPER: 'PAPER',
  STOPPED: 'IDLE',
  ERROR: 'ERROR',
};

export function RobotCard({
  robot,
  onOpen,
  onAction,
}: {
  robot: RobotSummary;
  onOpen: () => void;
  onAction: (action: RobotCardAction) => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const showArtwork = !robot.coverUrl || coverFailed;

  return (
    <article className="group relative flex min-w-0 flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#0a0710] transition-colors hover:border-red-500/50">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${robot.name}`}
        className="relative block aspect-[4/5] w-full overflow-hidden bg-[#0a0710] text-left"
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

        {/* The readability gradient. It sits on top of the artwork, never
            replaces it. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-black via-black/55 to-transparent"
        />

        <span className="absolute left-3 top-3 flex max-w-[60%] items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/90 backdrop-blur">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
          <span className="truncate">{robot.creatorName || 'Robot creator'}</span>
        </span>
        <span className="absolute right-3 top-3 rounded-full border border-white/20 bg-black/55 px-2.5 py-1 text-[10px] font-bold tracking-wider text-white backdrop-blur">
          {STATUS_LABEL[robot.runtimeStatus] ?? robot.runtimeStatus}
        </span>

        {/*
          The bottom padding clears the control bar, which floats over the
          lower edge of the cover. Without it the description sits BEHIND the
          bar and is half hidden.
        */}
        <span className="absolute inset-x-0 bottom-0 block px-4 pb-12">
          <span className="block text-center text-[17px] font-extrabold leading-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.75)]">
            {robot.name}
          </span>
          <span className="mx-auto mt-1.5 line-clamp-2 block max-w-[90%] text-center text-[11px] leading-snug text-white/75">
            {robot.description || 'Rule-based trading robot'}
          </span>
        </span>
      </button>

      {/* THE CONTROL BAR. It floats over the bottom of the cover, exactly
          where the reference puts it. */}
      <div className="relative z-10 -mt-5 mx-3 flex items-center justify-between gap-1 rounded-2xl border border-red-500/70 bg-[#0b0709]/95 px-1.5 py-1.5 shadow-[0_0_26px_rgba(239,68,68,.28)] backdrop-blur">
        <ControlButton
          label="PAIRS"
          icon={<TrendingUp size={16} />}
          onClick={() => onAction('pairs')}
          hint={`The instruments ${robot.name} trades`}
        />
        <button
          type="button"
          onClick={() => onAction('trade')}
          aria-label={`Trade ${robot.name}`}
          title={`Open the trading workspace of ${robot.name}`}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-[0_0_18px_rgba(239,68,68,.55)] transition hover:bg-red-500 active:scale-95"
        >
          <Play size={22} fill="currentColor" />
        </button>
        <ControlButton
          label="INFO"
          icon={<Info size={16} />}
          onClick={() => onAction('info')}
          hint={`Everything about ${robot.name}`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-[#0a0710] px-4 pb-3 pt-3 text-[11px] text-white/55">
        <span className="font-semibold text-white/85">{robot.market}</span>
        <span aria-hidden="true">·</span>
        <span>{robot.timeframe}</span>
        <span aria-hidden="true">·</span>
        <span>{robot.visibility === 'PRIVATE' ? 'Private' : 'Public'}</span>
        {robot.lastBacktest && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className={robot.lastBacktest.totalReturn >= 0 ? 'text-emerald-400' : 'text-rose-400'}
              title="Historical backtest simulation, not live performance"
            >
              {robot.lastBacktest.totalReturn >= 0 ? '+' : ''}
              {robot.lastBacktest.totalReturn.toFixed(1)}% simulated
            </span>
          </>
        )}
      </div>
    </article>
  );
}

function ControlButton({
  label,
  icon,
  onClick,
  hint,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-label={hint}
      className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] font-bold tracking-wider text-red-300 transition hover:bg-red-500/15 active:bg-red-500/25"
    >
      {icon}
      {label}
    </button>
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
