/**
 * ROOM CHART TOOLBAR
 * ==================
 * The strip above the room chart: the drawing tools, the drawing actions and
 * the indicator switches.
 *
 * DESIGN RULES
 * ------------
 * 1. Every control is reachable by keyboard and carries BOTH a `title` (for
 *    the mouse) and an `aria-label` (for a screen reader), because an icon
 *    with neither is a mystery.
 * 2. Every switch shows its state. A toolbar where you cannot tell what is
 *    on is worse than no toolbar.
 * 3. Nothing that affects the whole room is offered to a user who is not
 *    allowed to affect the whole room: the drawing tools need `canDraw` and
 *    "clear all" needs `canManageChart`.
 * 4. "Clear all" asks first, with an inline confirmation. A destructive
 *    action that fires on the first click is a bug report waiting to happen.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eraser,
  Minus,
  MousePointer2,
  MoveVertical,
  Slash,
  Square,
  Trash2,
  TrendingUp,
  Undo2,
} from 'lucide-react';
import type { RoomIndicatorConfig, RoomIndicatorKind } from './roomIndicators';
import type { RoomChartTool } from './roomChartTypes';

/** One line of the indicator legend. */
export interface RoomChartLegendEntry {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'negative';
}

export interface RoomChartToolbarProps {
  /** The active drawing tool. */
  tool: RoomChartTool;
  onToolChange: (tool: RoomChartTool) => void;
  /** True when this user may draw at all. */
  canDraw: boolean;
  /** True when this user may clear the room's drawings. */
  canManageChart: boolean;
  /** The indicators currently switched on. */
  indicators: RoomIndicatorConfig[];
  onIndicatorsChange: (next: RoomIndicatorConfig[]) => void;
  /** Whether the volume histogram is drawn. */
  showVolume: boolean;
  onShowVolumeChange: (next: boolean) => void;
  /** False when the provider supplied no volume at all. */
  hasVolume: boolean;
  /** How many drawings the room holds. */
  drawingCount: number;
  /** The selected drawing, if any. */
  selectedId: string | null;
  /** True when the selected drawing may be removed by this user. */
  canRemoveSelected: boolean;
  onRemoveSelected: () => void;
  /** True when there is a local action to undo. */
  canUndo: boolean;
  onUndo: () => void;
  onClearAll: () => void;
  /** The latest value of every active indicator. */
  legend: RoomChartLegendEntry[];
  /** Extra classes for the strip's root element. */
  className?: string;
}

const TOOL_BUTTONS: Array<{
  tool: RoomChartTool;
  label: string;
  icon: React.ComponentType<{ size?: number | string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}> = [
  { tool: 'cursor', label: 'Select and move drawings', icon: MousePointer2 },
  { tool: 'trendline', label: 'Trend line', icon: TrendingUp },
  { tool: 'ray', label: 'Ray', icon: Slash },
  { tool: 'hline', label: 'Horizontal line', icon: Minus },
  { tool: 'vline', label: 'Vertical line', icon: MoveVertical },
  { tool: 'rect', label: 'Rectangle', icon: Square },
];

const INDICATOR_BUTTONS: Array<{ kind: RoomIndicatorKind; label: string; title: string }> = [
  { kind: 'sma', label: 'SMA', title: 'Simple moving average' },
  { kind: 'ema', label: 'EMA', title: 'Exponential moving average' },
  { kind: 'rsi', label: 'RSI', title: 'Relative strength index' },
  { kind: 'macd', label: 'MACD', title: 'Moving average convergence divergence' },
  { kind: 'bollinger', label: 'BB', title: 'Bollinger bands' },
];

const PERIOD_FOR: Record<RoomIndicatorKind, number> = {
  sma: 20,
  ema: 20,
  rsi: 14,
  macd: 12,
  bollinger: 20,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A small numeric parameter box.
 *
 * The draft is kept locally while the field is being edited, so a half
 * typed number is not rewritten under the cursor; the value is committed
 * (clamped) on every keystroke and the draft is dropped on blur.
 */
const PeriodInput: React.FC<{
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  draft: string | undefined;
  onDraft: (next: string | undefined) => void;
  onCommit: (next: number) => void;
}> = ({ ariaLabel, value, min, max, draft, onDraft, onCommit }) => (
  <input
    type="number"
    className="input h-7 w-12 px-1 text-[11px]"
    aria-label={ariaLabel}
    title={ariaLabel}
    min={min}
    max={max}
    value={draft !== undefined ? draft : String(value)}
    onChange={event => {
      const raw = event.target.value;
      onDraft(raw);
      if (raw.trim() === '') return;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      onCommit(clamp(parsed, min, max));
    }}
    onBlur={() => onDraft(undefined)}
  />
);

const ICON_BUTTON =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

const ICON_BUTTON_ACTIVE =
  'border-accent bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text';

const CHIP_BUTTON =
  'inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-[11px] font-semibold text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

const CHIP_BUTTON_ACTIVE =
  'border-accent bg-accent-soft text-accent-text hover:border-accent hover:text-accent-text';

export const RoomChartToolbar: React.FC<RoomChartToolbarProps> = ({
  tool,
  onToolChange,
  canDraw,
  canManageChart,
  indicators,
  onIndicatorsChange,
  showVolume,
  onShowVolumeChange,
  hasVolume,
  drawingCount,
  selectedId,
  canRemoveSelected,
  onRemoveSelected,
  canUndo,
  onUndo,
  onClearAll,
  legend,
  className,
}) => {
  const [confirmingClear, setConfirmingClear] = useState(false);
  /** The half-typed numbers, kept per field so the cursor is never fought. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const clearRef = useRef<HTMLDivElement | null>(null);

  /** Keeps a half-typed number, and drops it again on blur. */
  const setDraft = useCallback((key: string, next: string | undefined) => {
    setDrafts(current => {
      const copy = { ...current };
      if (next === undefined) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }, []);

  useEffect(() => {
    if (!confirmingClear) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmingClear(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingClear]);

  const isActive = (kind: RoomIndicatorKind) => indicators.some(entry => entry.kind === kind);

  const toggleIndicator = (kind: RoomIndicatorKind) => {
    if (isActive(kind)) {
      onIndicatorsChange(indicators.filter(entry => entry.kind !== kind));
      return;
    }
    const base: RoomIndicatorConfig = { kind };
    if (kind === 'macd') {
      base.fastPeriod = 12;
      base.slowPeriod = 26;
      base.signalPeriod = 9;
    } else if (kind === 'bollinger') {
      base.period = 20;
      base.deviations = 2;
    } else {
      base.period = PERIOD_FOR[kind];
    }
    onIndicatorsChange([...indicators, base]);
  };

  const updateIndicator = (kind: RoomIndicatorKind, patch: Partial<RoomIndicatorConfig>) => {
    onIndicatorsChange(indicators.map(entry => (entry.kind === kind ? { ...entry, ...patch } : entry)));
  };

  const periodFor = (kind: RoomIndicatorKind) =>
    indicators.find(entry => entry.kind === kind)?.period ?? PERIOD_FOR[kind];

  const macdConfig = indicators.find(entry => entry.kind === 'macd');

  return (
    <div
      role="toolbar"
      aria-label="Chart drawing tools and indicators"
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
    >
      {TOOL_BUTTONS.map(entry => {
        const Icon = entry.icon;
        const active = tool === entry.tool;
        const disabled = !canDraw && entry.tool !== 'cursor';
        return (
          <button
            key={entry.tool}
            type="button"
            title={entry.label}
            aria-label={entry.label}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onToolChange(entry.tool)}
            className={`${ICON_BUTTON} ${active ? ICON_BUTTON_ACTIVE : ''}`}
          >
            <Icon size={16} strokeWidth={2} aria-hidden />
          </button>
        );
      })}

      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />

      <button
        type="button"
        title="Undo your last drawing action"
        aria-label="Undo your last drawing action"
        disabled={!canUndo}
        onClick={onUndo}
        className={ICON_BUTTON}
      >
        <Undo2 size={16} strokeWidth={2} aria-hidden />
      </button>

      <button
        type="button"
        title={selectedId ? 'Remove the selected drawing' : 'Select a drawing to remove it'}
        aria-label="Remove the selected drawing"
        disabled={!selectedId || !canRemoveSelected}
        onClick={onRemoveSelected}
        className={ICON_BUTTON}
      >
        <Trash2 size={16} strokeWidth={2} aria-hidden />
      </button>

      <div className="relative" ref={clearRef}>
        <button
          type="button"
          title="Clear every drawing in the room"
          aria-label="Clear every drawing in the room"
          aria-expanded={confirmingClear}
          disabled={!canManageChart || drawingCount === 0}
          onClick={() => setConfirmingClear(value => !value)}
          className={ICON_BUTTON}
        >
          <Eraser size={16} strokeWidth={2} aria-hidden />
        </button>
        {confirmingClear ? (
          <>
            <button
              type="button"
              aria-label="Dismiss the clear drawings confirmation"
              className="fixed inset-0 z-20 cursor-default bg-transparent"
              onClick={() => setConfirmingClear(false)}
            />
            <div
              role="alertdialog"
              aria-label="Clear every drawing in the room?"
              className="absolute right-0 top-9 z-30 w-56 rounded-lg border border-line-strong bg-raised p-3 shadow-lg"
            >
              <p className="text-xs font-semibold text-fg">Clear every drawing?</p>
              <p className="mt-1 text-[11px] text-fg-muted">
                This removes all {drawingCount} drawing{drawingCount === 1 ? '' : 's'} for everyone in the room.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  title="Keep the drawings"
                  aria-label="Keep the drawings"
                  className="btn btn-secondary h-7 px-2 text-[11px]"
                  onClick={() => setConfirmingClear(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  title="Clear every drawing in the room"
                  aria-label="Confirm clearing every drawing in the room"
                  className="btn btn-danger h-7 px-2 text-[11px]"
                  onClick={() => {
                    setConfirmingClear(false);
                    onClearAll();
                  }}
                >
                  Clear all
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />

      {INDICATOR_BUTTONS.map(entry => {
        const active = isActive(entry.kind);
        return (
          <React.Fragment key={entry.kind}>
            <button
              type="button"
              title={entry.title}
              aria-label={`${entry.title}${active ? ' (on)' : ' (off)'}`}
              aria-pressed={active}
              onClick={() => toggleIndicator(entry.kind)}
              className={`${CHIP_BUTTON} ${active ? CHIP_BUTTON_ACTIVE : ''}`}
            >
              {entry.label}
            </button>
            {active && entry.kind !== 'macd' ? (
              <PeriodInput
                ariaLabel={`${entry.title} period`}
                value={periodFor(entry.kind)}
                min={1}
                max={500}
                draft={drafts[entry.kind]}
                onDraft={next => setDraft(entry.kind, next)}
                onCommit={next => updateIndicator(entry.kind, { period: next })}
              />
            ) : null}
            {active && entry.kind === 'macd' ? (
              <>
                <PeriodInput
                  ariaLabel="MACD fast period"
                  value={macdConfig?.fastPeriod ?? 12}
                  min={2}
                  max={200}
                  draft={drafts['macd-fast']}
                  onDraft={next => setDraft('macd-fast', next)}
                  onCommit={next => updateIndicator('macd', { fastPeriod: next })}
                />
                <PeriodInput
                  ariaLabel="MACD slow period"
                  value={macdConfig?.slowPeriod ?? 26}
                  min={3}
                  max={400}
                  draft={drafts['macd-slow']}
                  onDraft={next => setDraft('macd-slow', next)}
                  onCommit={next => updateIndicator('macd', { slowPeriod: next })}
                />
              </>
            ) : null}
          </React.Fragment>
        );
      })}

      <button
        type="button"
        title={hasVolume ? 'Show the volume histogram' : 'This provider supplies no volume data'}
        aria-label={hasVolume ? 'Show the volume histogram' : 'Volume is unavailable for this market'}
        aria-pressed={showVolume && hasVolume}
        disabled={!hasVolume}
        onClick={() => onShowVolumeChange(!showVolume)}
        className={`${CHIP_BUTTON} ${showVolume && hasVolume ? CHIP_BUTTON_ACTIVE : ''}`}
      >
        VOL
      </button>

      {legend.length > 0 ? (
        <div
          className="ml-auto flex flex-wrap items-center gap-3 pl-2 text-[11px] tabular-nums text-fg-muted"
          aria-label="Indicator values"
        >
          {legend.map(entry => (
            <span key={entry.label} className="whitespace-nowrap">
              <span className="text-fg-subtle">{entry.label}</span>{' '}
              <span
                className={
                  entry.tone === 'positive'
                    ? 'text-positive'
                    : entry.tone === 'negative'
                    ? 'text-negative'
                    : 'text-fg'
                }
              >
                {entry.value}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};
