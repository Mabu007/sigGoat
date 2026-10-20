/**
 * ROOM CHART DRAWING OVERLAY
 * ==========================
 * An SVG layer that sits on top of the lightweight-charts canvas and draws
 * the room's shared drawings.
 *
 * WHY AN OVERLAY AND NOT A PRIMITIVE
 * ----------------------------------
 * The chart library can draw price lines and price labels, but a trendline
 * that a user DRAWS needs to follow the pointer, be moved afterwards and be
 * re-projected whenever the chart pans or zooms. That is a screen-space
 * concern, so it is done in SVG on top of the canvas, using the chart's own
 * coordinate mapping for every conversion.
 *
 * COORDINATES
 * -----------
 * A drawing point is (time, price) with the time in EPOCH SECONDS, which is
 * what the shared protocol stores. The chart's time scale speaks the same
 * language, so:
 *
 *   screen x = chart.timeScale().timeToCoordinate(time)
 *   screen y = candleSeries.priceToCoordinate(price)
 *
 * and back the other way. The candle series is the anchor for prices
 * because it owns the price scale the drawings are drawn against.
 *
 * POINTER BEHAVIOUR
 * -----------------
 * With no tool active the layer does not take pointer events at all, so the
 * chart keeps its own pan and zoom. With a drawing tool active the layer
 * captures the pointer and draws a live preview.
 *
 * A drag emits NOTHING until the pointer is released: the preview is local
 * state, and the commit is a single event. That is a protocol requirement,
 * not an optimisation — the room coordinator would otherwise be flooded with
 * a message per pointer move.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { DrawingKind, DrawingPoint, RoomDrawing } from '../../shared/roomProtocol';
import {
  DEFAULT_ROOM_DRAWING_COLOR,
  DEFAULT_ROOM_DRAWING_WIDTH,
  createRoomDrawingId,
  type RoomChartTool,
} from './roomChartTypes';

export interface RoomChartCanvasProps {
  /** The live chart handles. Null until the chart exists. */
  chart: IChartApi | null;
  /** The candle series, used for every price conversion. */
  candleSeries: ISeriesApi<'Candlestick'> | null;
  /** The shared drawings, from the room coordinator. */
  drawings: readonly RoomDrawing[];
  /** The active tool. */
  tool: RoomChartTool;
  /** The currently selected drawing id. */
  selectedId: string | null;
  /** False when this user may not draw. */
  canDraw: boolean;
  /** Epoch seconds of every bar, so a drawing always lands on a real bar. */
  barTimes: readonly number[];
  /** The author id stored on a new drawing. */
  createdBy: string;
  /** The author name stored on a new drawing. */
  createdByName?: string;
  /** Stroke colour for new drawings. */
  color?: string;
  /** Stroke width for new drawings. */
  width?: number;
  /** Called when the selection changes. */
  onSelect: (id: string | null) => void;
  /** Called ONCE per committed creation. */
  onCreate: (drawing: RoomDrawing) => void;
  /** Called ONCE per committed move. */
  onUpdate: (drawing: RoomDrawing) => void;
  /** Called when the selected drawing is removed. */
  onRemove: (id: string) => void;
}

interface ScreenPoint {
  x: number;
  y: number;
}

type Geometry =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number };

type DragState =
  | {
    mode: 'create';
    kind: Exclude<RoomChartTool, 'cursor'>;
    start: DrawingPoint;
    current: DrawingPoint;
    startScreen: ScreenPoint;
    currentScreen: ScreenPoint;
    rect: DOMRect;
  }
  | {
    mode: 'move';
    id: string;
    origin: RoomDrawing;
    startScreen: ScreenPoint;
    currentScreen: ScreenPoint;
    rect: DOMRect;
  };

/** How far the pointer must travel before a click counts as a drag. */
const MIN_DRAG_PIXELS = 4;
/** How close a pointer has to be to a shape for it to count as a hit. */
const HIT_TOLERANCE = 12;

function toDrawingKind(tool: RoomChartTool): Exclude<RoomChartTool, 'cursor'> {
  return tool === 'cursor' ? 'trendline' : tool;
}

/** Snaps a time to the nearest bar, so a drawing always lands on a real bar. */
function snapTime(time: number, barTimes: readonly number[]): number {
  if (barTimes.length === 0) return Math.floor(time);
  let low = 0;
  let high = barTimes.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (barTimes[mid] < time) low = mid + 1;
    else high = mid;
  }
  const after = barTimes[low];
  const before = barTimes[Math.max(0, low - 1)];
  return Math.abs(after - time) <= Math.abs(before - time) ? after : before;
}

function projectPoint(
  chart: IChartApi,
  candleSeries: ISeriesApi<'Candlestick'>,
  point: DrawingPoint,
): ScreenPoint | null {
  const x = chart.timeScale().timeToCoordinate(point.time as Time);
  if (x === null || !Number.isFinite(x)) return null;
  const y = candleSeries.priceToCoordinate(point.price);
  if (!Number.isFinite(y)) return null;
  return { x, y };
}

function geometryFor(
  drawing: Pick<RoomDrawing, 'kind' | 'points'>,
  chart: IChartApi,
  candleSeries: ISeriesApi<'Candlestick'>,
): Geometry | null {
  const first = drawing.points[0];
  const second = drawing.points[1];
  if (!first || !second) return null;
  const a = projectPoint(chart, candleSeries, first);
  const b = projectPoint(chart, candleSeries, second);
  if (!a || !b) return null;

  switch (drawing.kind) {
    case 'trendline':
      return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    case 'ray': {
      // A ray runs to the right edge of the visible window.
      const right = chart.timeScale().width();
      const dx = b.x - a.x;
      const y = Math.abs(dx) < 0.001 ? a.y : a.y + (b.y - a.y) * ((right - a.x) / dx);
      return { kind: 'line', x1: a.x, y1: a.y, x2: right, y2: y };
    }
    case 'hline':
      return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: a.y };
    case 'vline':
      return { kind: 'line', x1: a.x, y1: a.y, x2: a.x, y2: b.y };
    case 'rect':
      return {
        kind: 'rect',
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
      };
    default:
      return null;
  }
}

/** The midpoint of a shape, in screen space. Used to place the label. */
function midpointOf(geometry: Geometry): ScreenPoint {
  if (geometry.kind === 'rect') {
    return { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 };
  }
  return { x: (geometry.x1 + geometry.x2) / 2, y: (geometry.y1 + geometry.y2) / 2 };
}

function samePoints(a: readonly DrawingPoint[], b: readonly DrawingPoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((point, index) => {
    const other = b[index];
    return !!other && point.time === other.time && point.price === other.price;
  });
}

/** The two stored points for a freshly drawn shape. */
function pointsForNewDrawing(
  kind: Exclude<RoomChartTool, 'cursor'>,
  start: DrawingPoint,
  current: DrawingPoint,
): DrawingPoint[] {
  switch (kind) {
    case 'hline':
      // A horizontal line is stored as two points at the SAME price.
      return [{ time: start.time, price: start.price }, { time: current.time, price: start.price }];
    case 'vline':
      // A vertical line is stored as two points at the SAME time.
      return [{ time: start.time, price: start.price }, { time: start.time, price: current.price }];
    default:
      return [start, current];
  }
}

export const RoomChartCanvas: React.FC<RoomChartCanvasProps> = ({
  chart,
  candleSeries,
  drawings,
  tool,
  selectedId,
  canDraw,
  barTimes,
  createdBy,
  createdByName,
  color = DEFAULT_ROOM_DRAWING_COLOR,
  width = DEFAULT_ROOM_DRAWING_WIDTH,
  onSelect,
  onCreate,
  onUpdate,
  onRemove,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /**
   * A counter rather than state: the overlay re-projects itself whenever the
   * chart moves, and the drawing preview is local, so there is nothing here
   * a consumer could observe. The counter is also what makes the preview
   * recompute, because the live drag lives in a ref.
   */
  const [renderCount, bump] = useReducer((count: number) => count + 1, 0);

  /**
   * The live props, for the window-level listeners below. They are
   * registered once and must not capture a stale prop set.
   */
  const propsRef = useRef({
    chart, candleSeries, tool, canDraw, barTimes, createdBy, createdByName, color, width,
    selectedId, drawings, onSelect, onCreate, onUpdate, onRemove,
  });
  propsRef.current = {
    chart, candleSeries, tool, canDraw, barTimes, createdBy, createdByName, color, width,
    selectedId, drawings, onSelect, onCreate, onUpdate, onRemove,
  };

  /** Converts a pointer position into a chart point. */
  const toChartPoint = useCallback((screen: ScreenPoint, rect: DOMRect): DrawingPoint | null => {
    const current = propsRef.current;
    if (!current.chart || !current.candleSeries) return null;
    const time = current.chart.timeScale().coordinateToTime(screen.x);
    if (typeof time !== 'number' || !Number.isFinite(time)) return null;
    const price = current.candleSeries.coordinateToPrice(screen.y);
    if (!Number.isFinite(price) || price === 0) return null;
    return { time: snapTime(time, current.barTimes), price };
  }, []);

  /**
   * Re-projects the overlay whenever the chart's viewport moves.
   *
   * The drawings live in chart space, so a pan or a zoom changes every
   * pixel they occupy. Without this the overlay would keep showing the
   * shapes where they used to be.
   */
  useEffect(() => {
    if (!chart) return;
    const timeScale = chart.timeScale();
    const onViewportChange = () => bump();
    timeScale.subscribeVisibleTimeRangeChange(onViewportChange);
    timeScale.subscribeVisibleLogicalRangeChange(onViewportChange);

    const element = svgRef.current;
    const observer = element
      ? new ResizeObserver(() => bump())
      : null;
    if (element && observer) observer.observe(element);

    return () => {
      timeScale.unsubscribeVisibleTimeRangeChange(onViewportChange);
      timeScale.unsubscribeVisibleLogicalRangeChange(onViewportChange);
      observer?.disconnect();
    };
  }, [chart]);

  /**
   * The drag itself: preview locally, commit once.
   */
  useEffect(() => {
    const screenOf = (event: PointerEvent, rect: DOMRect): ScreenPoint => ({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.currentScreen = screenOf(event, drag.rect);
      if (drag.mode === 'create') {
        // The preview follows the pointer in chart space, not just in pixels.
        const point = toChartPoint(drag.currentScreen, drag.rect);
        if (point) drag.current = point;
      }
      bump();
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const current = propsRef.current;
      if (!current.chart || !current.candleSeries) return;

      const dx = drag.currentScreen.x - drag.startScreen.x;
      const dy = drag.currentScreen.y - drag.startScreen.y;

      if (drag.mode === 'create') {
        if (Math.hypot(dx, dy) < MIN_DRAG_PIXELS) return;
        const points = pointsForNewDrawing(drag.kind, drag.start, drag.current);
        const drawing: RoomDrawing = {
          id: createRoomDrawingId(),
          kind: drag.kind as DrawingKind,
          points,
          color: current.color,
          width: current.width,
          createdBy: current.createdBy,
          createdByName: current.createdByName,
          createdAt: Date.now(),
          version: 1,
        };
        current.onCreate(drawing);
        return;
      }

      // A move: re-project the original points through the drag delta.
      const moved: DrawingPoint[] = [];
      for (const point of drag.origin.points) {
        const screen = projectPoint(current.chart, current.candleSeries, point);
        if (!screen) {
          moved.push(point);
          continue;
        }
        const time = current.chart.timeScale().coordinateToTime(screen.x + dx);
        const price = current.candleSeries.coordinateToPrice(screen.y + dy);
        if (typeof time !== 'number' || !Number.isFinite(price) || price === 0) {
          moved.push(point);
          continue;
        }
        moved.push({ time: snapTime(time, current.barTimes), price });
      }
      if (samePoints(moved, drag.origin.points)) return;
      current.onUpdate({
        ...drag.origin,
        points: moved,
        version: (drag.origin.version ?? 0) + 1,
      });
    };

    const onPointerCancel = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      bump();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dragRef.current) {
          event.preventDefault();
          onPointerCancel();
          return;
        }
        // Nothing is being dragged, so Escape clears the selection.
        propsRef.current.onSelect(null);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && propsRef.current.selectedId) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        /**
         * The room coordinator only lets an author delete their own drawing,
         * so the keyboard must not offer to delete someone else's.
         */
        const selected = propsRef.current.drawings.find(
          drawing => drawing.id === propsRef.current.selectedId,
        );
        if (!selected || selected.createdBy !== propsRef.current.createdBy) return;
        event.preventDefault();
        propsRef.current.onRemove(propsRef.current.selectedId);
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = propsRef.current;
    if (!current.canDraw || current.tool === 'cursor') return;
    if (!current.chart || !current.candleSeries) return;
    const element = svgRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const point = toChartPoint(screen, rect);
    if (!point) return;
    event.preventDefault();
    dragRef.current = {
      mode: 'create',
      kind: toDrawingKind(current.tool),
      start: point,
      current: point,
      startScreen: screen,
      currentScreen: screen,
      rect,
    };
    bump();
  };

  const handleShapePointerDown = (event: React.PointerEvent, drawing: RoomDrawing) => {
    event.stopPropagation();
    const current = propsRef.current;
    current.onSelect(drawing.id);
    if (!current.canDraw) return;
    if (!current.chart || !current.candleSeries) return;
    const element = svgRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    dragRef.current = {
      mode: 'move',
      id: drawing.id,
      origin: drawing,
      startScreen: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      currentScreen: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      rect,
    };
    bump();
  };

  /** The shape currently being drawn or moved, if any. */
  const preview = useMemo<RoomDrawing | null>(() => {
    const drag = dragRef.current;
    if (!drag || !chart || !candleSeries) return null;
    if (drag.mode === 'create') {
      return {
        id: 'preview',
        kind: drag.kind,
        points: pointsForNewDrawing(drag.kind, drag.start, drag.current),
        color,
        width,
        createdBy,
        createdByName,
        createdAt: 0,
        version: 0,
      };
    }
    const dx = drag.currentScreen.x - drag.startScreen.x;
    const dy = drag.currentScreen.y - drag.startScreen.y;
    const moved = drag.origin.points.map(point => {
      const screen = projectPoint(chart, candleSeries, point);
      if (!screen) return point;
      const time = chart.timeScale().coordinateToTime(screen.x + dx);
      const price = candleSeries.coordinateToPrice(screen.y + dy);
      if (typeof time !== 'number' || !Number.isFinite(price) || price === 0) return point;
      return { time: snapTime(time, barTimes), price };
    });
    return { ...drag.origin, points: moved };
    // The preview depends on the live drag state, which lives in a ref and
    // is signalled through the render counter.
  }, [chart, candleSeries, color, width, createdBy, createdByName, barTimes, renderCount]);

  const activeTool = tool !== 'cursor';
  const interactive = canDraw && activeTool;
  /** The drawing currently being dragged, so it is not drawn twice. */
  const movingId = dragRef.current?.mode === 'move' ? dragRef.current.id : null;

  return (
    <svg
      ref={svgRef}
      className="block h-full w-full"
      style={{
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: interactive ? 'crosshair' : 'default',
        // While a tool is active the pointer belongs to the drawing, not to
        // the page: a touch drag must not scroll the room out from under it.
        touchAction: interactive ? 'none' : undefined,
      }}
      role="group"
      aria-label="Chart drawings"
      onPointerDown={handlePointerDown}
    >
      {drawings.map(drawing => {
        if (!chart || !candleSeries) return null;
        if (drawing.id === movingId) return null;
        const geometry = geometryFor(drawing, chart, candleSeries);
        if (!geometry) return null;
        const selected = drawing.id === selectedId;
        const path = geometry.kind === 'line'
          ? `M ${geometry.x1} ${geometry.y1} L ${geometry.x2} ${geometry.y2}`
          : `M ${geometry.x} ${geometry.y} h ${geometry.width} v ${geometry.height} h ${-geometry.width} Z`;
        const mid = midpointOf(geometry);
        return (
          <g key={drawing.id}>
            {selected ? (
              <path
                d={path}
                fill="none"
                style={{ stroke: 'var(--color-accent-text)' }}
                strokeWidth={drawing.width + 4}
                strokeOpacity={0.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            ) : null}
            <path
              d={path}
              fill={geometry.kind === 'rect' ? drawing.color : 'none'}
              fillOpacity={geometry.kind === 'rect' ? 0.12 : 0}
              stroke={drawing.color}
              strokeWidth={drawing.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              pointerEvents="none"
            />
            {selected ? (
              <>
                {geometry.kind === 'line' ? (
                  <>
                    <circle cx={geometry.x1} cy={geometry.y1} r={4} style={{ fill: 'var(--color-accent)', stroke: 'var(--color-canvas)' }} strokeWidth={1} pointerEvents="none" />
                    <circle cx={geometry.x2} cy={geometry.y2} r={4} style={{ fill: 'var(--color-accent)', stroke: 'var(--color-canvas)' }} strokeWidth={1} pointerEvents="none" />
                  </>
                ) : (
                  <>
                    <circle cx={geometry.x} cy={geometry.y} r={4} style={{ fill: 'var(--color-accent)', stroke: 'var(--color-canvas)' }} strokeWidth={1} pointerEvents="none" />
                    <circle cx={geometry.x + geometry.width} cy={geometry.y + geometry.height} r={4} style={{ fill: 'var(--color-accent)', stroke: 'var(--color-canvas)' }} strokeWidth={1} pointerEvents="none" />
                  </>
                )}
              </>
            ) : null}
            {drawing.label ? (
              <text
                x={mid.x}
                y={mid.y - 6}
                textAnchor="middle"
                fontSize={10}
                fontFamily="'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
                style={{ fill: drawing.color, stroke: 'var(--color-sunken)', paintOrder: 'stroke' }}
                strokeWidth={3}
                pointerEvents="none"
              >
                {drawing.label.slice(0, 32)}
              </text>
            ) : null}
            {/* A wide, invisible path so a two-pixel line is still easy to grab. */}
            <path
              d={path}
              fill={geometry.kind === 'rect' ? 'transparent' : 'none'}
              stroke="transparent"
              strokeWidth={HIT_TOLERANCE}
              strokeLinecap="round"
              pointerEvents={tool === 'cursor' ? (geometry.kind === 'rect' ? 'fill' : 'stroke') : 'none'}
              style={{ cursor: tool === 'cursor' ? 'pointer' : 'default' }}
              onPointerDown={tool === 'cursor' ? (event) => handleShapePointerDown(event, drawing) : undefined}
            />
          </g>
        );
      })}

      {preview && chart && candleSeries ? (() => {
        const geometry = geometryFor(preview, chart, candleSeries);
        if (!geometry) return null;
        const path = geometry.kind === 'line'
          ? `M ${geometry.x1} ${geometry.y1} L ${geometry.x2} ${geometry.y2}`
          : `M ${geometry.x} ${geometry.y} h ${geometry.width} v ${geometry.height} h ${-geometry.width} Z`;
        return (
          <path
            d={path}
            fill={geometry.kind === 'rect' ? preview.color : 'none'}
            fillOpacity={geometry.kind === 'rect' ? 0.12 : 0}
            stroke={preview.color}
            strokeWidth={preview.width}
            strokeDasharray="4 3"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        );
      })() : null}
    </svg>
  );
};
