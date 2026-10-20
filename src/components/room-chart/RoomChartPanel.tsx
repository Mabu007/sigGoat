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
import type { RoomDrawing } from '../../shared/roomProtocol';
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
  /** The EFFECTIVE timeframe. The parent decides it: shared or personal. */
  timeframe: string;
  /** The EFFECTIVE symbol. The parent decides it: shared or personal. */
  symbol: string;
  digits?: number;
  roomName?: string;
  dataMode?: string;
  /**
   * 'shared' follows the room's chart. 'local' is this viewer's PRIVATE
   * chart: their own symbol, their own timeframe and their own drawings,
   * none of which reach the room.
   */
  chartMode?: 'shared' | 'local';
  /** True when this user may change the ROOM's shared chart. */
  canManageChart?: boolean;
  /** True when this user may draw. In 'shared' mode that means the room. */
  canDraw?: boolean;
  /** The room's shared drawings. Ignored in 'local' mode. */
  drawings?: RoomDrawing[];
  /** Called once per COMMITTED change only. Never per pointer move. */
  onDrawingCreate?: (drawing: RoomDrawing) => void;
  onDrawingUpdate?: (drawing: RoomDrawing) => void;
  onDrawingRemove?: (id: string) => void;
  onDrawingsClear?: () => void;
  /**
   * Whether the collapsible tool strip is open.
   *
   * The strip does not permanently consume chart height: it is closed by
   * default and the button that opens it lives in the room header, above
   * this component.
   */
  toolsOpen?: boolean;
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

type HistoryEntry =
  | { type: 'create'; drawing: RoomDrawing }
  | { type: 'remove'; drawing: RoomDrawing }
  | { type: 'update'; before: RoomDrawing; after: RoomDrawing };

export const RoomChartPanel: React.FC<RoomChartPanelProps> = ({
  candles,
  activeQuote,
  timeframe,
  symbol,
  digits = 5,
  roomName,
  dataMode,
  chartMode = 'shared',
  canManageChart = false,
  canDraw = true,
  drawings = [],
  onDrawingCreate,
  onDrawingUpdate,
  onDrawingRemove,
  onDrawingsClear,
  toolsOpen = false,
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
  const historyRef = useRef<HistoryEntry[]>([]);
  const [historyLength, setHistoryLength] = useState(0);
  /**
   * This participant's committed drawings that the room coordinator has not
   * echoed back yet. A drawing is drawn the instant it is committed; the
   * server's copy replaces the local one when it arrives.
   */
  const [localPatches, setLocalPatches] = useState<Record<string, RoomDrawing | null>>({});
  /**
   * THIS VIEWER'S PRIVATE DRAWINGS.
   *
   * They exist only while the chart is in 'local' mode. They are never sent
   * to the room, and they never appear to anybody else. Switching back to
   * the shared chart leaves them alone, so a viewer can flip back and forth
   * without losing their own work.
   */
  const [privateDrawings, setPrivateDrawings] = useState<RoomDrawing[]>([]);

  const isLocal = chartMode === 'local';
  const effectiveSymbol = symbol;
  const effectiveTimeframe = timeframe;

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
   *
   * In 'local' mode the room's drawings are not shown at all: the viewer's
   * private chart is their own.
   */
  const effectiveDrawings = useMemo(() => {
    if (isLocal) return privateDrawings;
    const merged = new Map<string, RoomDrawing>();
    for (const drawing of drawings) merged.set(drawing.id, drawing);
    for (const [id, patch] of Object.entries(localPatches)) {
      if (patch === null) merged.delete(id);
      else merged.set(patch.id, patch);
    }
    return [...merged.values()];
  }, [drawings, localPatches, isLocal, privateDrawings]);

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

  /**
   * A COMMITTED DRAWING.
   *
   * In 'local' mode the drawing stays on this viewer's screen and NOTHING
   * is sent to the room. In 'shared' mode it is a room change: it is sent
   * to the coordinator and echoed to everyone.
   */
  const handleCreate = useCallback((drawing: RoomDrawing) => {
    pushHistory({ type: 'create', drawing });
    if (isLocal) {
      setPrivateDrawings(current => [...current.filter(item => item.id !== drawing.id), drawing]);
      return;
    }
    setLocalPatches(current => ({ ...current, [drawing.id]: drawing }));
    onDrawingCreate?.(drawing);
  }, [isLocal, onDrawingCreate, pushHistory]);

  const handleUpdate = useCallback((drawing: RoomDrawing) => {
    const before = effectiveDrawings.find(item => item.id === drawing.id) ?? drawing;
    pushHistory({ type: 'update', before, after: drawing });
    if (isLocal) {
      setPrivateDrawings(current => current.map(item => (item.id === drawing.id ? drawing : item)));
      return;
    }
    setLocalPatches(current => ({ ...current, [drawing.id]: drawing }));
    onDrawingUpdate?.(drawing);
  }, [effectiveDrawings, isLocal, onDrawingUpdate, pushHistory]);

  const handleRemove = useCallback((id: string) => {
    const removed = effectiveDrawings.find(item => item.id === id);
    if (removed) pushHistory({ type: 'remove', drawing: removed });
    setSelectedId(current => (current === id ? null : current));
    if (isLocal) {
      setPrivateDrawings(current => current.filter(item => item.id !== id));
      return;
    }
    setLocalPatches(current => ({ ...current, [id]: null }));
    onDrawingRemove?.(id);
  }, [effectiveDrawings, isLocal, onDrawingRemove, pushHistory]);

  const handleUndo = useCallback(() => {
    const entry = historyRef.current.pop();
    setHistoryLength(historyRef.current.length);
    if (!entry) return;
    if (isLocal) {
      if (entry.type === 'create') {
        setPrivateDrawings(current => current.filter(item => item.id !== entry.drawing.id));
      } else if (entry.type === 'remove') {
        setPrivateDrawings(current => [...current, entry.drawing]);
      } else {
        setPrivateDrawings(current => current.map(item => (item.id === entry.before.id ? entry.before : item)));
      }
      return;
    }
    if (entry.type === 'create') onDrawingRemove?.(entry.drawing.id);
    else if (entry.type === 'remove') onDrawingCreate?.(entry.drawing);
    else onDrawingUpdate?.(entry.before);
  }, [isLocal, onDrawingCreate, onDrawingRemove, onDrawingUpdate]);

  const handleClearAll = useCallback(() => {
    if (isLocal) {
      setPrivateDrawings([]);
      setSelectedId(null);
      return;
    }
    // The local copies go too: "clear all" means all, here and on the server.
    setLocalPatches({});
    onDrawingsClear?.();
  }, [isLocal, onDrawingsClear]);

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

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      {/**
       * THE TOOL STRIP.
       *
       * It is collapsible and CLOSED by default, so it never permanently
       * consumes chart height. The button that opens it lives in the room
       * header, one row above this component — a chart that has to scroll
       * to find its own tools is not a hero.
       */}
      {toolsOpen && (
        <div className="room-chart-tools-strip" role="group" aria-label="Chart tools">
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
            className="room-chart-tools"
          />
        </div>
      )}

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
