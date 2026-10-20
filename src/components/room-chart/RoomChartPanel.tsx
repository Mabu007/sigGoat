/**
 * ROOM CHART PANEL
 * ================
 * The shared chart surface of a trade room: the chart, the drawing overlay,
 * the toolbar and the shared-chart controls, wired together.
 *
 * WHAT THIS COMPONENT OWNS
 * ------------------------
 * The panel owns the state that is LOCAL to one participant — the drawing
 * tool, the selected drawing, the indicator switches — and it renders the
 * state that is SHARED — the symbol, the timeframe, the drawings — exactly
 * as the room coordinator hands them over.
 *
 * The panel never invents shared state. When the room coordinator says the
 * shared symbol is EURUSD and the participant's own view is GBPUSD, the
 * panel shows EURUSD and says so, rather than silently rendering one of the
 * two.
 *
 * COMMIT SEMANTICS
 * ----------------
 * `onDrawingCreate`, `onDrawingUpdate`, `onDrawingRemove` and
 * `onDrawingsClear` fire ONCE per committed change. The overlay renders the
 * drag locally and only commits when the pointer is released, so a drag
 * across the chart is one message, not two hundred.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, MarketQuote } from '../../types';
import { ALLOWED_TIMEFRAMES, type RoomDrawing } from '../../shared/roomProtocol';
import { TradingViewLightweightChart, type RoomChartApi } from '../TradingViewLightweightChart';
import { RoomChartCanvas } from './RoomChartCanvas';
import { RoomChartToolbar, type RoomChartLegendEntry } from './RoomChartToolbar';
import {
  computeRoomIndicators,
  normalizeRoomCandles,
  type RoomIndicatorConfig,
} from './roomIndicators';
import {
  DEFAULT_ROOM_DRAWING_COLOR,
  DEFAULT_ROOM_DRAWING_WIDTH,
  type RoomChartTool,
} from './roomChartTypes';

export interface RoomChartPanelProps {
  candles: Candle[];
  activeQuote: MarketQuote | null;
  timeframe: string;
  symbol: string;
  digits?: number;
  roomName?: string;
  dataMode?: string;
  /** Shared symbol from the room coordinator. When it differs from `symbol`, the panel shows the shared value. */
  sharedSymbol?: string;
  sharedTimeframe?: string;
  /** True when this user may change the shared chart (leader). */
  canManageChart?: boolean;
  /** True when this user may draw. */
  canDraw?: boolean;
  /** The shared drawings, from the room coordinator. */
  drawings?: RoomDrawing[];
  /** Called once per COMMITTED change only. Never per pointer move. */
  onDrawingCreate?: (drawing: RoomDrawing) => void;
  onDrawingUpdate?: (drawing: RoomDrawing) => void;
  onDrawingRemove?: (id: string) => void;
  onDrawingsClear?: () => void;
  /** Called when a leader changes the shared symbol/timeframe. */
  onSharedSymbolChange?: (symbol: string) => void;
  onSharedTimeframeChange?: (timeframe: string) => void;
  /** A short status line, e.g. "Synced" / "Reconnecting" / "Offline". */
  connectionLabel?: string;
  connectionState?: 'open' | 'connecting' | 'reconnecting' | 'closed' | 'error';
  /** The author id stored on a drawing this participant creates. */
  userId?: string;
  /** The author name stored on a drawing this participant creates. */
  userName?: string;
  /** The stroke colour for new drawings. */
  drawingColor?: string;
  /** The stroke width for new drawings. */
  drawingWidth?: number;
  className?: string;
}

/** The symbol pattern the room coordinator accepts. */
const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,24}$/;

type HistoryEntry =
  | { type: 'create'; drawing: RoomDrawing }
  | { type: 'remove'; drawing: RoomDrawing }
  | { type: 'update'; before: RoomDrawing; after: RoomDrawing };

const CONNECTION_TONE: Record<string, string> = {
  open: 'badge-positive',
  connecting: 'badge-info',
  reconnecting: 'badge-warning',
  closed: 'badge-neutral',
  error: 'badge-negative',
};

export const RoomChartPanel: React.FC<RoomChartPanelProps> = ({
  candles,
  activeQuote,
  timeframe,
  symbol,
  digits = 5,
  roomName,
  dataMode,
  sharedSymbol,
  sharedTimeframe,
  canManageChart = false,
  canDraw = true,
  drawings = [],
  onDrawingCreate,
  onDrawingUpdate,
  onDrawingRemove,
  onDrawingsClear,
  onSharedSymbolChange,
  onSharedTimeframeChange,
  connectionLabel,
  connectionState = 'open',
  userId = '',
  userName,
  drawingColor = DEFAULT_ROOM_DRAWING_COLOR,
  drawingWidth = DEFAULT_ROOM_DRAWING_WIDTH,
  className,
}) => {
  const [chartApi, setChartApi] = useState<RoomChartApi | null>(null);
  const [tool, setTool] = useState<RoomChartTool>('cursor');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [indicatorConfigs, setIndicatorConfigs] = useState<RoomIndicatorConfig[]>([]);
  const [showVolume, setShowVolume] = useState(true);
  const [symbolDraft, setSymbolDraft] = useState<string>('');
  const historyRef = useRef<HistoryEntry[]>([]);
  const [historyLength, setHistoryLength] = useState(0);
  /**
   * The drawings this participant has committed but the room coordinator has
   * not echoed back yet. A drawing is drawn the instant it is committed; the
   * server's copy replaces the local one when it arrives.
   */
  const [localPatches, setLocalPatches] = useState<Record<string, RoomDrawing | null>>({});

  const effectiveSymbol = sharedSymbol && sharedSymbol.trim() ? sharedSymbol.trim() : symbol;
  const effectiveTimeframe = sharedTimeframe && sharedTimeframe.trim() ? sharedTimeframe.trim() : timeframe;
  const symbolIsShared = !!sharedSymbol && sharedSymbol !== symbol;
  const timeframeIsShared = !!sharedTimeframe && sharedTimeframe !== timeframe;

  useEffect(() => {
    setSymbolDraft(effectiveSymbol);
  }, [effectiveSymbol]);

  /** The bar times, so a drawing always lands on a real bar. */
  const barTimes = useMemo(() => {
    const seen = new Set<number>();
    for (const candle of candles) {
      const time = Math.floor(candle.time / 1000);
      if (Number.isFinite(time) && time > 0) seen.add(time);
    }
    return [...seen].sort((a, b) => a - b);
  }, [candles]);

  /** The provider supplied volume only if at least one bar carries any. */
  const hasVolume = useMemo(
    () => candles.some(candle => Number.isFinite(candle.volume) && candle.volume > 0),
    [candles],
  );

  /**
   * The shared drawings with this participant's own pending changes folded
   * in. A committed drawing appears immediately and is replaced by the
   * coordinator's copy when that copy arrives.
   */
  const effectiveDrawings = useMemo(() => {
    const merged = new Map<string, RoomDrawing>();
    for (const drawing of drawings) merged.set(drawing.id, drawing);
    for (const [id, patch] of Object.entries(localPatches)) {
      if (patch === null) merged.delete(id);
      else merged.set(id, patch);
    }
    return [...merged.values()];
  }, [drawings, localPatches]);

  /** Drops a local patch once the coordinator's state has caught up. */
  useEffect(() => {
    setLocalPatches(current => {
      const next: Record<string, RoomDrawing | null> = {};
      let changed = false;
      for (const [id, patch] of Object.entries(current)) {
        const server = drawings.find(drawing => drawing.id === id);
        if (patch === null) {
          // A pending removal: it is done as soon as the coordinator drops
          // the drawing. Until then it stays hidden locally.
          if (server) next[id] = patch;
          else changed = true;
          continue;
        }
        if (server && server.version >= patch.version) {
          // The coordinator's copy is at least as new as ours.
          changed = true;
          continue;
        }
        next[id] = patch;
      }
      return changed ? next : current;
    });
  }, [drawings]);

  /** The latest value of every active indicator, for the legend. */
  const legend = useMemo<RoomChartLegendEntry[]>(() => {
    const normalized = normalizeRoomCandles(candles);
    const outputs = computeRoomIndicators(normalized, indicatorConfigs);
    const entries: RoomChartLegendEntry[] = [];
    for (const output of outputs) {
      for (const item of output.legend) {
        entries.push({
          label: item.label,
          value: item.value === null
            ? 'warming up'
            : item.value.toLocaleString(undefined, {
              maximumFractionDigits: output.kind === 'rsi' ? 1 : digits,
            }),
          tone: 'neutral',
        });
      }
    }
    return entries;
  }, [candles, indicatorConfigs, digits]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    historyRef.current = [...historyRef.current.slice(-49), entry];
    setHistoryLength(historyRef.current.length);
  }, []);

  const handleCreate = useCallback((drawing: RoomDrawing) => {
    pushHistory({ type: 'create', drawing });
    setLocalPatches(current => ({ ...current, [drawing.id]: drawing }));
    onDrawingCreate?.(drawing);
  }, [onDrawingCreate, pushHistory]);

  const handleUpdate = useCallback((drawing: RoomDrawing) => {
    const before = effectiveDrawings.find(item => item.id === drawing.id) ?? drawing;
    pushHistory({ type: 'update', before, after: drawing });
    setLocalPatches(current => ({ ...current, [drawing.id]: drawing }));
    onDrawingUpdate?.(drawing);
  }, [effectiveDrawings, onDrawingUpdate, pushHistory]);

  const handleRemove = useCallback((id: string) => {
    const removed = effectiveDrawings.find(item => item.id === id);
    if (removed) pushHistory({ type: 'remove', drawing: removed });
    setLocalPatches(current => ({ ...current, [id]: null }));
    setSelectedId(current => (current === id ? null : current));
    onDrawingRemove?.(id);
  }, [effectiveDrawings, onDrawingRemove, pushHistory]);

  const handleUndo = useCallback(() => {
    const entry = historyRef.current.pop();
    setHistoryLength(historyRef.current.length);
    if (!entry) return;
    if (entry.type === 'create') onDrawingRemove?.(entry.drawing.id);
    else if (entry.type === 'remove') onDrawingCreate?.(entry.drawing);
    else onDrawingUpdate?.(entry.before);
  }, [onDrawingCreate, onDrawingRemove, onDrawingUpdate]);

  const handleClearAll = useCallback(() => {
    // The local copies go too: "clear all" means all, here and on the server.
    setLocalPatches({});
    onDrawingsClear?.();
  }, [onDrawingsClear]);

  const selectedDrawing = useMemo(
    () => effectiveDrawings.find(item => item.id === selectedId) ?? null,
    [effectiveDrawings, selectedId],
  );
  /**
   * The room coordinator only lets an author remove their own drawing, so
   * the button is disabled for someone else's drawing rather than letting
   * the user fire a request the server will reject.
   */
  const canRemoveSelected = !!selectedDrawing && selectedDrawing.createdBy === userId;

  const commitSymbol = useCallback(() => {
    const next = symbolDraft.trim();
    if (!SYMBOL_PATTERN.test(next)) {
      setSymbolDraft(effectiveSymbol);
      return;
    }
    if (next === effectiveSymbol) return;
    onSharedSymbolChange?.(next);
  }, [symbolDraft, effectiveSymbol, onSharedSymbolChange]);

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-2 py-1.5 text-[11px]">
        {canManageChart ? (
          <label className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wide text-fg-subtle">Symbol</span>
            <input
              className="input h-7 w-28 px-2 text-[11px]"
              value={symbolDraft}
              aria-label="Shared chart symbol"
              title="Shared chart symbol"
              spellCheck={false}
              onChange={event => setSymbolDraft(event.target.value)}
              onBlur={commitSymbol}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSymbol();
                }
              }}
            />
          </label>
        ) : (
          <span className="font-semibold uppercase tracking-wide text-fg-subtle">
            {effectiveSymbol}
          </span>
        )}

        <div className="flex items-center gap-1" role="group" aria-label="Chart timeframe">
          {ALLOWED_TIMEFRAMES.map(option => {
            const active = option === effectiveTimeframe;
            return (
              <button
                key={option}
                type="button"
                title={`${option} timeframe`}
                aria-label={`${option} timeframe`}
                aria-pressed={active}
                disabled={!canManageChart}
                onClick={() => {
                  if (option === effectiveTimeframe) return;
                  onSharedTimeframeChange?.(option);
                }}
                className={`h-6 min-w-8 rounded px-1.5 text-[11px] font-semibold transition-colors ${
                  active
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-fg-muted hover:bg-raised hover:text-fg'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {option}
              </button>
            );
          })}
        </div>

        {symbolIsShared || timeframeIsShared ? (
          <span className="badge badge-info" title="This chart is shared by the room">
            Shared chart · {effectiveSymbol} {effectiveTimeframe}
          </span>
        ) : null}

        {!canDraw ? (
          <span className="badge badge-neutral" role="status">
            Read-only · you can watch but not draw
          </span>
        ) : null}

        {connectionLabel ? (
          <span className={`badge ${CONNECTION_TONE[connectionState] ?? 'badge-neutral'}`} role="status">
            {connectionLabel}
          </span>
        ) : null}
      </div>

      <RoomChartToolbar
        tool={tool}
        onToolChange={setTool}
        canDraw={canDraw}
        canManageChart={canManageChart}
        indicators={indicatorConfigs}
        onIndicatorsChange={setIndicatorConfigs}
        showVolume={showVolume}
        onShowVolumeChange={setShowVolume}
        hasVolume={hasVolume}
        drawingCount={effectiveDrawings.length}
        selectedId={selectedId}
        canRemoveSelected={canRemoveSelected}
        onRemoveSelected={() => {
          if (selectedId) handleRemove(selectedId);
        }}
        canUndo={historyLength > 0}
        onUndo={handleUndo}
        onClearAll={handleClearAll}
        legend={legend}
      />

      <div className="relative min-h-0 flex-1">
        <TradingViewLightweightChart
          candles={candles}
          activeQuote={activeQuote}
          timeframe={effectiveTimeframe}
          symbol={effectiveSymbol}
          digits={digits}
          roomName={roomName}
          dataMode={dataMode}
          showVolume={showVolume}
          indicators={indicatorConfigs}
          onChartReady={setChartApi}
          overlay={(
            <RoomChartCanvas
              chart={chartApi?.chart ?? null}
              candleSeries={chartApi?.candleSeries ?? null}
              drawings={effectiveDrawings}
              tool={tool}
              selectedId={selectedId}
              canDraw={canDraw}
              barTimes={barTimes}
              createdBy={userId}
              createdByName={userName}
              color={drawingColor}
              width={drawingWidth}
              onSelect={setSelectedId}
              onCreate={handleCreate}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
            />
          )}
        />
      </div>
    </div>
  );
};
