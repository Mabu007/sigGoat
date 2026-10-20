/**
 * ROOM CHART PANEL
 * ================
 * The shared chart surface of a trade room: the chart, the drawing overlay,
 * the toolbar and the shared-chart controls, wired together.
 *
 * WHAT THIS COMPONENT OWNS
 * ------------------------
 * The panel owns the state that is LOCAL to one participant — the drawing
 * tool, the selected drawing, the indicator switches, the undo history and
 * this participant's private drawings — and it renders the state that is
 * SHARED — the symbol, the timeframe, the drawings — exactly as the room
 * coordinator hands them over.
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
 *
 * THE UNDO HISTORY
 * ----------------
 * Every committed change pushes ONE entry onto an undo stack, and the entry
 * carries the mode it was made in. The mode is part of the entry rather
 * than a property of "now", because an entry made in local mode has to be
 * undone in the private list and an entry made in shared mode has to be
 * undone in the room — even if the user has switched modes in between.
 *
 * A redo stack sits next to it: undo moves an entry from one stack to the
 * other, and a NEW action empties the redo stack.
 *
 * THE OPTIMISTIC PATCHES
 * ----------------------
 * A committed drawing appears immediately and the coordinator's copy
 * replaces it when it arrives. The patch that stands in for the gap is
 * dropped as soon as the coordinator has caught up — and a patch for a
 * drawing the coordinator has DROPPED is dropped too, so undoing a
 * creation cannot leave the drawing on the screen forever.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, MarketQuote } from '../../types';
import type { RoomDrawing } from '../../shared/roomProtocol';
import { TradingViewLightweightChart, type RoomChartApi } from '../TradingViewLightweightChart';
import { RoomChartCanvas, type RoomTextRequest } from './RoomChartCanvas';
import { RoomChartToolbar, type RoomChartLegendEntry } from './RoomChartToolbar';
import {
  computeRoomIndicators,
  normalizeRoomCandles,
  type RoomIndicatorConfig,
} from './roomIndicators';
import {
  DEFAULT_ROOM_DRAWING_COLOR,
  DEFAULT_ROOM_DRAWING_WIDTH,
  ROOM_TOOL_SHORTCUTS,
  createRoomDrawingId,
  type RoomChartTool,
} from './roomChartTypes';
import {
  readStoredDrawings,
  roomChartStorageKey,
  writeStoredDrawings,
} from './roomChartStorage';
import { snapTime } from './roomChartGeometry';
import './room-chart.css';

export interface RoomChartPanelProps {
  candles: Candle[];
  activeQuote: MarketQuote | null;
  /** The EFFECTIVE timeframe. The parent decides it: shared or personal. */
  timeframe: string;
  /** The EFFECTIVE symbol. The parent decides it: shared or personal. */
  symbol: string;
  digits?: number;
  roomName?: string;
  /**
   * The room's id.
   *
   * Only used to namespace the private drawings in `localStorage`. The room
   * name is the fallback, so the panel works without it, but two rooms can
   * share a name and a room id cannot.
   */
  roomId?: string;
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

/** Which list an action belongs to. */
type ChartMode = 'shared' | 'local';

/**
 * One reversible action.
 *
 * `mode` is the mode the action was made in, NOT the mode the panel
 * happens to be in when the action is undone.
 */
type HistoryEntry =
  | { type: 'create'; mode: ChartMode; drawings: RoomDrawing[] }
  | { type: 'remove'; mode: ChartMode; drawings: RoomDrawing[] }
  | { type: 'update'; mode: ChartMode; before: RoomDrawing; after: RoomDrawing }
  | { type: 'clear'; mode: ChartMode; drawings: RoomDrawing[] };

/**
 * The optimistic stand-in for a drawing the coordinator has not caught up
 * with yet.
 *
 * `removed` says the drawing is on its way out, `drawing` holds the copy
 * that is shown while it waits, and `at` is when the change was sent — so a
 * change the server never accepted can be given up on.
 */
interface LocalPatch {
  drawing: RoomDrawing | null;
  removed: boolean;
  at: number;
}

/**
 * How long an optimistic patch waits for the coordinator before it gives
 * up. Long enough for a round trip, short enough that a refused change
 * does not hide a drawing forever.
 */
const PATCH_GRACE_MS = 6000;

/** How many actions the undo history keeps. */
const HISTORY_LIMIT = 50;

export const RoomChartPanel: React.FC<RoomChartPanelProps> = ({
  candles,
  activeQuote,
  timeframe,
  symbol,
  digits = 5,
  roomName,
  roomId,
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
  /**
   * This participant's committed drawings that the room coordinator has not
   * echoed back yet. A drawing is drawn the instant it is committed; the
   * coordinator's copy replaces the local one when it arrives.
   */
  const [localPatches, setLocalPatches] = useState<Record<string, LocalPatch>>({});
  /**
   * THIS VIEWER'S PRIVATE DRAWINGS.
   *
   * They exist only while the chart is in 'local' mode. They are never sent
   * to the room, and they never appear to anybody else. Switching back to
   * the shared chart leaves them alone, so a viewer can flip back and forth
   * without losing their own work.
   */
  const [privateDrawings, setPrivateDrawings] = useState<RoomDrawing[]>([]);
  /** The text of the annotation the user is writing, if any. */
  const [textRequest, setTextRequest] = useState<RoomTextRequest | null>(null);
  const [textDraft, setTextDraft] = useState('');

  const isLocal = chartMode === 'local';
  const effectiveSymbol = symbol;
  const effectiveTimeframe = timeframe;
  const mode: ChartMode = isLocal ? 'local' : 'shared';

  /** The undo stack and the redo stack. */
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });

  /**
   * The room callbacks, for the history appliers. They are read through a
   * ref so an undo always uses the CURRENT callback and never a stale one.
   */
  const onDrawingCreateRef = useRef(onDrawingCreate);
  const onDrawingUpdateRef = useRef(onDrawingUpdate);
  const onDrawingRemoveRef = useRef(onDrawingRemove);
  const onDrawingsClearRef = useRef(onDrawingsClear);
  onDrawingCreateRef.current = onDrawingCreate;
  onDrawingUpdateRef.current = onDrawingUpdate;
  onDrawingRemoveRef.current = onDrawingRemove;
  onDrawingsClearRef.current = onDrawingsClear;

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
      if (patch.removed || !patch.drawing) merged.delete(id);
      else merged.set(patch.drawing.id, patch.drawing);
    }
    return [...merged.values()];
  }, [drawings, localPatches, isLocal, privateDrawings]);

  const patchCount = Object.keys(localPatches).length;

  /**
   * Drops a local patch once the coordinator's state has caught up.
   *
   * The three cases:
   *
   *  - the coordinator has the drawing and it is at least as new as ours:
   *    the patch has done its job,
   *  - the coordinator no longer has the drawing: the change was applied
   *    and the patch has to go, or the drawing would stay on the screen
   *    forever after an undo,
   *  - the coordinator still has the drawing but has not caught up: the
   *    patch stays, and it gives up after a grace period so a REFUSED
   *    change cannot hide a drawing forever either.
   */
  useEffect(() => {
    if (patchCount === 0) return;
    const reconcile = () => {
      setLocalPatches(current => {
        if (Object.keys(current).length === 0) return current;
        const server = new Map(drawings.map(drawing => [drawing.id, drawing]));
        const now = Date.now();
        const next: Record<string, LocalPatch> = {};
        let changed = false;
        for (const [id, patch] of Object.entries(current)) {
          const copy = server.get(id);
          if (patch.removed) {
            // A pending removal: done as soon as the coordinator drops the
            // drawing. Until then it stays hidden locally.
            if (!copy) {
              changed = true;
              continue;
            }
            if (now - patch.at > PATCH_GRACE_MS) {
              // The removal was refused: the coordinator still has it, so
              // the drawing comes back.
              changed = true;
              continue;
            }
            next[id] = patch;
            continue;
          }
          const local = patch.drawing;
          if (copy && local && copy.version >= local.version) {
            // The coordinator's copy is at least as new as ours.
            changed = true;
            continue;
          }
          if (!copy && now - patch.at > PATCH_GRACE_MS) {
            // The coordinator never took the drawing, or has dropped it.
            changed = true;
            continue;
          }
          next[id] = patch;
        }
        return changed ? next : current;
      });
    };
    reconcile();
    const timer = window.setInterval(reconcile, 1000);
    return () => window.clearInterval(timer);
  }, [drawings, patchCount]);

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

  /* ------------------------------------------------------------------ */
  /* The history                                                         */
  /* ------------------------------------------------------------------ */

  const pushHistory = useCallback((entry: HistoryEntry) => {
    undoStack.current = [...undoStack.current.slice(-(HISTORY_LIMIT - 1)), entry];
    // A new action ends the redo branch: the future it described is gone.
    redoStack.current = [];
    setHistoryState({ undo: undoStack.current.length, redo: 0 });
  }, []);

  /**
   * Undoes an entry in the private list.
   */
  const applyToLocal = useCallback((entry: HistoryEntry, undo: boolean) => {
    setPrivateDrawings(current => {
      switch (entry.type) {
        case 'create': {
          const ids = new Set(entry.drawings.map(drawing => drawing.id));
          return undo
            ? current.filter(drawing => !ids.has(drawing.id))
            : [...current.filter(drawing => !ids.has(drawing.id)), ...entry.drawings];
        }
        case 'remove': {
          const ids = new Set(entry.drawings.map(drawing => drawing.id));
          return undo
            ? [...current.filter(drawing => !ids.has(drawing.id)), ...entry.drawings]
            : current.filter(drawing => !ids.has(drawing.id));
        }
        case 'update': {
          const target = undo ? entry.before : entry.after;
          return current.some(drawing => drawing.id === target.id)
            ? current.map(drawing => (drawing.id === target.id ? target : drawing))
            : [...current, target];
        }
        case 'clear': {
          const ids = new Set(entry.drawings.map(drawing => drawing.id));
          return undo
            ? [...current.filter(drawing => !ids.has(drawing.id)), ...entry.drawings]
            : current.filter(drawing => !ids.has(drawing.id));
        }
        default:
          return current;
      }
    });
  }, []);

  /**
   * Undoes an entry in the room.
   *
   * Every change sends the room message AND folds the optimistic patch in,
   * so the drawing disappears (or comes back) at once instead of after a
   * round trip.
   */
  const applyToShared = useCallback((entry: HistoryEntry, undo: boolean) => {
    const now = Date.now();
    const remove = (drawing: RoomDrawing) => {
      onDrawingRemoveRef.current?.(drawing.id);
      setLocalPatches(current => ({
        ...current,
        [drawing.id]: { drawing: null, removed: true, at: now },
      }));
    };
    const create = (drawing: RoomDrawing) => {
      onDrawingCreateRef.current?.(drawing);
      setLocalPatches(current => ({
        ...current,
        [drawing.id]: { drawing, removed: false, at: now },
      }));
    };
    switch (entry.type) {
      case 'create':
        // Undoing a creation removes the drawing; redoing it creates it.
        for (const drawing of entry.drawings) {
          if (undo) remove(drawing);
          else create(drawing);
        }
        break;
      case 'remove':
        // Undoing a removal brings the drawing back.
        for (const drawing of entry.drawings) {
          if (undo) create(drawing);
          else remove(drawing);
        }
        break;
      case 'update': {
        const target = undo ? entry.before : entry.after;
        onDrawingUpdateRef.current?.(target);
        setLocalPatches(current => ({
          ...current,
          [target.id]: { drawing: target, removed: false, at: now },
        }));
        break;
      }
      case 'clear':
        if (undo) {
          // Undoing a clear brings every drawing back.
          for (const drawing of entry.drawings) create(drawing);
        } else {
          for (const drawing of entry.drawings) {
            setLocalPatches(current => ({
              ...current,
              [drawing.id]: { drawing: null, removed: true, at: now },
            }));
          }
          onDrawingsClearRef.current?.();
        }
        break;
      default:
        break;
    }
  }, []);

  /** Applies an entry, in the mode the entry was made in. */
  const applyEntry = useCallback((entry: HistoryEntry, undo: boolean) => {
    if (entry.mode === 'local') {
      applyToLocal(entry, undo);
      return;
    }
    applyToShared(entry, undo);
  }, [applyToLocal, applyToShared]);

  const handleUndo = useCallback(() => {
    const entry = undoStack.current[undoStack.current.length - 1];
    if (!entry) return;
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, entry];
    applyEntry(entry, true);
    setHistoryState({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [applyEntry]);

  const handleRedo = useCallback(() => {
    const entry = redoStack.current[redoStack.current.length - 1];
    if (!entry) return;
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, entry];
    applyEntry(entry, false);
    setHistoryState({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [applyEntry]);

  /**
   * The history belongs to ONE chart context. A drawing made on EURUSD
   * cannot be undone once the chart shows GBPUSD, so the history is thrown
   * away when the symbol, the timeframe or the mode changes.
   */
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setHistoryState({ undo: 0, redo: 0 });
    setSelectedId(null);
  }, [symbol, timeframe, chartMode]);

  /* ------------------------------------------------------------------ */
  /* The drawings                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * A COMMITTED DRAWING.
   *
   * In 'local' mode the drawing stays on this viewer's screen and NOTHING
   * is sent to the room. In 'shared' mode it is a room change: it is sent
   * to the coordinator and echoed to everyone.
   */
  const handleCreate = useCallback((drawing: RoomDrawing) => {
    pushHistory({ type: 'create', mode, drawings: [drawing] });
    if (isLocal) {
      setPrivateDrawings(current => [...current.filter(item => item.id !== drawing.id), drawing]);
      return;
    }
    setLocalPatches(current => ({
      ...current,
      [drawing.id]: { drawing, removed: false, at: Date.now() },
    }));
    onDrawingCreate?.(drawing);
  }, [isLocal, mode, onDrawingCreate, pushHistory]);

  /**
   * SEVERAL COMMITTED DRAWINGS AT ONCE.
   *
   * A channel is two trendlines that belong together, so they share ONE
   * history entry: one undo reverses both of them.
   */
  const handleCreateMany = useCallback((drawings: RoomDrawing[]) => {
    if (drawings.length === 0) return;
    pushHistory({ type: 'create', mode, drawings });
    if (isLocal) {
      const ids = new Set(drawings.map(drawing => drawing.id));
      setPrivateDrawings(current => [
        ...current.filter(item => !ids.has(item.id)),
        ...drawings,
      ]);
      return;
    }
    const now = Date.now();
    setLocalPatches(current => {
      const next = { ...current };
      for (const drawing of drawings) {
        next[drawing.id] = { drawing, removed: false, at: now };
      }
      return next;
    });
    for (const drawing of drawings) onDrawingCreate?.(drawing);
  }, [isLocal, mode, onDrawingCreate, pushHistory]);

  const handleUpdate = useCallback((drawing: RoomDrawing) => {
    const before = effectiveDrawings.find(item => item.id === drawing.id) ?? drawing;
    pushHistory({ type: 'update', mode, before, after: drawing });
    if (isLocal) {
      setPrivateDrawings(current => current.map(item => (item.id === drawing.id ? drawing : item)));
      return;
    }
    setLocalPatches(current => ({
      ...current,
      [drawing.id]: { drawing, removed: false, at: Date.now() },
    }));
    onDrawingUpdate?.(drawing);
  }, [effectiveDrawings, isLocal, mode, onDrawingUpdate, pushHistory]);

  const handleRemove = useCallback((id: string) => {
    const removed = effectiveDrawings.find(item => item.id === id);
    if (removed) pushHistory({ type: 'remove', mode, drawings: [removed] });
    setSelectedId(current => (current === id ? null : current));
    if (isLocal) {
      setPrivateDrawings(current => current.filter(item => item.id !== id));
      return;
    }
    setLocalPatches(current => ({
      ...current,
      [id]: { drawing: null, removed: true, at: Date.now() },
    }));
    onDrawingRemove?.(id);
  }, [effectiveDrawings, isLocal, mode, onDrawingRemove, pushHistory]);

  /**
   * CLEARS EVERY DRAWING, and is undoable.
   */
  const handleClearAll = useCallback(() => {
    const removed = effectiveDrawings;
    if (removed.length === 0) return;
    pushHistory({ type: 'clear', mode, drawings: removed });
    setSelectedId(null);
    if (isLocal) {
      setPrivateDrawings([]);
      return;
    }
    const now = Date.now();
    setLocalPatches(current => {
      const next = { ...current };
      for (const drawing of removed) {
        next[drawing.id] = { drawing: null, removed: true, at: now };
      }
      return next;
    });
    onDrawingsClear?.();
  }, [effectiveDrawings, isLocal, mode, onDrawingsClear, pushHistory]);

  /* ------------------------------------------------------------------ */
  /* The private drawings                                                */
  /* ------------------------------------------------------------------ */

  /** Where this participant's private drawings are stored. */
  const storageKey = useMemo(
    () => roomChartStorageKey(roomId || roomName || 'room', effectiveSymbol, effectiveTimeframe),
    [roomId, roomName, effectiveSymbol, effectiveTimeframe],
  );

  /** The key the drawings in the state were loaded from. */
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);

  /**
   * Loads the private drawings for this chart context.
   *
   * Anything malformed in the storage is dropped by the loader, and the
   * history is cleared with the context, so a stored drawing can never
   * belong to a different instrument.
   */
  useEffect(() => {
    setPrivateDrawings(readStoredDrawings(storageKey));
    setHydratedKey(storageKey);
  }, [storageKey]);

  /** Writes the private drawings back, once they have been loaded. */
  useEffect(() => {
    if (hydratedKey !== storageKey) return;
    writeStoredDrawings(storageKey, privateDrawings);
  }, [hydratedKey, storageKey, privateDrawings]);

  /* ------------------------------------------------------------------ */
  /* The text annotation                                                 */
  /* ------------------------------------------------------------------ */

  const handleTextRequest = useCallback((request: RoomTextRequest) => {
    setTextRequest(request);
    setTextDraft('');
  }, []);

  const cancelText = useCallback(() => {
    setTextRequest(null);
    setTextDraft('');
  }, []);

  /**
   * Turns the annotation into a drawing.
   *
   * It is committed as a horizontal line that carries the words in the
   * drawing's EXISTING `label` field, so the wire format does not change.
   */
  const commitText = useCallback(() => {
    const request = textRequest;
    const label = textDraft.trim();
    cancelText();
    if (!request || !label) return;
    const half = Math.max(1, request.span / 2);
    // The underline is anchored on REAL bars, so it is projected exactly
    // like every other drawing.
    const step = barTimes.length >= 2 ? Math.max(1, barTimes[1] - barTimes[0]) : 60;
    const from = snapTime(Math.max(1, request.time - half), barTimes);
    let to = snapTime(request.time + half, barTimes);
    if (to <= from) to = from + step;
    const drawing: RoomDrawing = {
      id: createRoomDrawingId(),
      kind: 'hline',
      points: [
        { time: from, price: request.price },
        { time: to, price: request.price },
      ],
      color: drawingColor,
      width: drawingWidth,
      createdBy: userId,
      createdByName: userName,
      createdAt: Date.now(),
      version: 1,
      label,
    };
    handleCreate(drawing);
  }, [
    barTimes,
    cancelText,
    drawingColor,
    drawingWidth,
    handleCreate,
    textDraft,
    textRequest,
    userId,
    userName,
  ]);

  /* ------------------------------------------------------------------ */
  /* The keyboard                                                        */
  /* ------------------------------------------------------------------ */

  const canRemoveSelected = useMemo(() => {
    const selected = effectiveDrawings.find(item => item.id === selectedId);
    return !!selected && selected.createdBy === userId;
  }, [effectiveDrawings, selectedId, userId]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      if (element.isContentEditable) return true;
      const tag = element.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (modifier && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (event.key === 'Escape') {
        cancelText();
        setSelectedId(null);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedId || !canRemoveSelected) return;
        event.preventDefault();
        handleRemove(selectedId);
        return;
      }
      if (modifier || event.altKey) return;
      const next = ROOM_TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (!next) return;
      if (next !== 'cursor' && !canDraw) return;
      event.preventDefault();
      setTool(next);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canDraw, canRemoveSelected, cancelText, handleRedo, handleRemove, handleUndo, selectedId]);

  /* ------------------------------------------------------------------ */
  /* The chart controls                                                  */
  /* ------------------------------------------------------------------ */

  /** Fits the visible data back into the window. */
  const handleResetZoom = useCallback(() => {
    const api = chartApi;
    if (!api) return;
    try {
      api.timeScale().fitContent();
    } catch {
      // The chart may be on its way out; there is nothing to reset then.
    }
  }, [chartApi]);

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
            canUndo={historyState.undo > 0}
            onUndo={handleUndo}
            canRedo={historyState.redo > 0}
            onRedo={handleRedo}
            onResetZoom={handleResetZoom}
            localMode={isLocal}
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
              digits={digits}
              onSelect={setSelectedId}
              onCreate={handleCreate}
              onCreateMany={handleCreateMany}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
              onTextRequest={handleTextRequest}
            />
          )}
        />

        {/**
         * THE TEXT ANNOTATION PROMPT.
         *
         * A small inline field rather than a `window.prompt`, so the words
         * can be typed, corrected with the keyboard and read out by a
         * screen reader.
         */}
        {textRequest ? (
          <form
            className="room-chart-text-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              commitText();
            }}
          >
            <label className="sr-only" htmlFor="room-chart-text-input">Annotation text</label>
            <input
              id="room-chart-text-input"
              className="input h-7 min-w-0 flex-1 text-[11px]"
              value={textDraft}
              autoFocus
              maxLength={48}
              placeholder="Type the note, then press Enter"
              onChange={event => setTextDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelText();
                }
              }}
            />
            <button
              type="submit"
              title="Add the annotation"
              aria-label="Add the annotation"
              disabled={!textDraft.trim()}
              className="btn btn-primary h-7 px-2 text-[11px]"
            >
              Add
            </button>
            <button
              type="button"
              title="Discard the annotation"
              aria-label="Discard the annotation"
              className="btn btn-secondary h-7 px-2 text-[11px]"
              onClick={cancelText}
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
};
