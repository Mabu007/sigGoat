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
 * The SVG itself NEVER takes pointer events. Two things sit on top of it
 * instead:
 *
 *  - a transparent CAPTURE RECTANGLE that covers the chart's plot area and
 *    only exists while a drawing tool is active. A drawing therefore can
 *    never start on the price scale or on the time axis, and the scales
 *    stay usable while a tool is armed.
 *  - the SHAPES themselves, which are hit tested in cursor mode so a
 *    drawing can be picked up, dragged and resized.
 *
 * With no tool active the layer does not take pointer events at all, so the
 * chart keeps its own pan and zoom.
 *
 * A drag emits NOTHING until the pointer is released: the preview is local
 * state, and the commit is a single event. That is a protocol requirement,
 * not an optimisation — the room coordinator would otherwise be flooded with
 * a message per pointer move.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { DrawingKind, DrawingPoint, RoomDrawing } from '../../shared/roomProtocol';
import {
  DEFAULT_ROOM_DRAWING_COLOR,
  DEFAULT_ROOM_DRAWING_WIDTH,
  createRoomDrawingId,
  type RoomChartTool,
} from './roomChartTypes';
import {
  CHANNEL_OFFSET_RATIO,
  TEXT_ANNOTATION_SPAN_RATIO,
  formatDuration,
  formatPrice,
  geometryFor,
  handlesFor,
  insidePlotArea,
  midpointOf,
  movePoints,
  plotAreaFor,
  pointsForNewDrawing,
  projectPoint,
  resizePoints,
  samePoints,
  snapTime,
  type DrawingHandle,
  type Geometry,
  type PlotArea,
  type ScreenPoint,
} from './roomChartGeometry';

/** A text annotation waiting for the words the user wants on it. */
export interface RoomTextRequest {
  /** Epoch seconds of the clicked bar. */
  time: number;
  /** The clicked price. */
  price: number;
  /** How wide the annotation's underline is, in seconds. */
  span: number;
}

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
  /** How many decimals the prices of this market carry. */
  digits?: number;
  /** Called when the selection changes. */
  onSelect: (id: string | null) => void;
  /** Called ONCE per committed creation. */
  onCreate: (drawing: RoomDrawing) => void;
  /** Called ONCE per committed creation of SEVERAL drawings (a channel). */
  onCreateMany?: (drawings: RoomDrawing[]) => void;
  /** Called ONCE per committed move or resize. */
  onUpdate: (drawing: RoomDrawing) => void;
  /** Called when the selected drawing is removed. */
  onRemove: (id: string) => void;
  /** Called when the text tool is used and the words are needed. */
  onTextRequest?: (request: RoomTextRequest) => void;
}

/** The bits every drag has, whatever it is doing. */
interface DragBase {
  /** Where the drag started, in the overlay's pixel space. */
  startScreen: ScreenPoint;
  /** Where the pointer is now, in the overlay's pixel space. */
  currentScreen: ScreenPoint;
  /** The chart point under the pointer, when there is one. */
  pointer: DrawingPoint | null;
  /** The overlay's rectangle when the drag started. */
  rect: DOMRect;
  /** The pointer that owns this drag. */
  pointerId: number;
}

type DragState =
  | ({ mode: 'create'; tool: RoomChartTool; start: DrawingPoint } & DragBase)
  | ({ mode: 'move'; id: string; origin: RoomDrawing; anchor: DrawingPoint } & DragBase)
  | ({ mode: 'resize'; id: string; origin: RoomDrawing; handle: DrawingHandle } & DragBase)
  | ({ mode: 'measure'; start: DrawingPoint } & DragBase);

/** How far the pointer must travel before a click counts as a drag. */
const MIN_DRAG_PIXELS = 4;
/** How close a pointer has to be to a shape for it to count as a hit. */
const HIT_TOLERANCE = 12;
/** How big the invisible grab area around a handle is. */
const HANDLE_GRAB_RADIUS = 9;

/** The drawing kinds a tool can commit as ONE drawing. */
const SINGLE_DRAWING_TOOLS: DrawingKind[] = ['trendline', 'ray', 'hline', 'vline', 'rect'];

function toDrawingKind(tool: RoomChartTool): DrawingKind {
  return SINGLE_DRAWING_TOOLS.includes(tool as DrawingKind) ? (tool as DrawingKind) : 'trendline';
}

function pathFor(geometry: Geometry): string {
  return geometry.kind === 'line'
    ? `M ${geometry.x1} ${geometry.y1} L ${geometry.x2} ${geometry.y2}`
    : `M ${geometry.x} ${geometry.y} h ${geometry.width} v ${geometry.height} h ${-geometry.width} Z`;
}

/**
 * How wide a text annotation's underline is.
 *
 * A share of the visible window, so the label has room to sit in without
 * the underline running off the chart.
 */
function textSpanSeconds(
  chart: IChartApi,
  barTimes: readonly number[],
): number {
  const range = chart.timeScale().getVisibleRange();
  if (range) {
    const from = Number(range.from);
    const to = Number(range.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return Math.max(1, (to - from) * TEXT_ANNOTATION_SPAN_RATIO);
    }
  }
  if (barTimes.length >= 2) {
    const step = barTimes[barTimes.length - 1] - barTimes[0];
    if (step > 0) return Math.max(1, step * TEXT_ANNOTATION_SPAN_RATIO);
  }
  return 60;
}

/**
 * How far a channel's second line sits from the first.
 *
 * A share of the visible price range, so the channel is the same width on
 * every instrument. When the price range cannot be read the drag's own
 * height is used instead.
 */
function channelOffset(
  chart: IChartApi,
  candleSeries: ISeriesApi<'Candlestick'>,
  fallback: number,
): number {
  const range = candleSeries.priceScale().getVisibleRange();
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from) {
    return (range.to - range.from) * CHANNEL_OFFSET_RATIO;
  }
  return Math.abs(fallback);
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
  digits = 5,
  onSelect,
  onCreate,
  onCreateMany,
  onUpdate,
  onRemove,
  onTextRequest,
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
   * The LOCAL ruler. It is not a drawing, it is never committed and it
   * never reaches the room.
   */
  const [measure, setMeasure] = useState<{ start: DrawingPoint; end: DrawingPoint } | null>(null);

  /**
   * The live props, for the window-level listeners below. They are
   * registered once and must not capture a stale prop set.
   */
  const propsRef = useRef({
    chart, candleSeries, tool, canDraw, barTimes, createdBy, createdByName, color, width, digits,
    selectedId, drawings, onSelect, onCreate, onCreateMany, onUpdate, onRemove, onTextRequest,
  });
  propsRef.current = {
    chart, candleSeries, tool, canDraw, barTimes, createdBy, createdByName, color, width, digits,
    selectedId, drawings, onSelect, onCreate, onCreateMany, onUpdate, onRemove, onTextRequest,
  };

  /** Converts a pointer position into a chart point. */
  const toChartPoint = useCallback((screen: ScreenPoint): DrawingPoint | null => {
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

    const releaseCapture = (pointerId: number) => {
      const element = svgRef.current;
      if (!element) return;
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        // The pointer is already gone; nothing to release.
      }
    };

    const cancelDrag = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      releaseCapture(drag.pointerId);
      bump();
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (event.pointerId !== drag.pointerId) return;
      drag.currentScreen = screenOf(event, drag.rect);
      const point = toChartPoint(drag.currentScreen);
      if (point) drag.pointer = point;
      bump();
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      releaseCapture(drag.pointerId);
      /**
       * The overlay has to redraw NOW: the drag is over, so the preview
       * has to go and the drawing it was covering has to come back. A
       * click that changes nothing commits nothing, so without this the
       * preview would stay on the screen until the next redraw.
       */
      bump();
      const current = propsRef.current;
      if (!current.chart || !current.candleSeries) return;

      const dx = drag.currentScreen.x - drag.startScreen.x;
      const dy = drag.currentScreen.y - drag.startScreen.y;
      const wasDragged = Math.hypot(dx, dy) >= MIN_DRAG_PIXELS;

      if (drag.mode === 'create') {
        if (!wasDragged) return;
        const pointer = drag.pointer ?? drag.start;
        if (drag.tool === 'channel') {
          const offset = channelOffset(current.chart, current.candleSeries, pointer.price - drag.start.price);
          const stamp = Date.now();
          const first: RoomDrawing = {
            id: createRoomDrawingId(),
            kind: 'trendline',
            points: [{ ...drag.start }, { ...pointer }],
            color: current.color,
            width: current.width,
            createdBy: current.createdBy,
            createdByName: current.createdByName,
            createdAt: stamp,
            version: 1,
          };
          const second: RoomDrawing = {
            ...first,
            id: createRoomDrawingId(),
            points: [
              { time: drag.start.time, price: drag.start.price - offset },
              { time: pointer.time, price: pointer.price - offset },
            ],
          };
          current.onCreateMany?.([first, second]);
          return;
        }
        const kind = toDrawingKind(drag.tool);
        const points = pointsForNewDrawing(kind, drag.start, pointer);
        const drawing: RoomDrawing = {
          id: createRoomDrawingId(),
          kind,
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

      if (drag.mode === 'measure') {
        if (!wasDragged) {
          setMeasure(null);
          return;
        }
        const pointer = drag.pointer ?? drag.start;
        setMeasure({ start: drag.start, end: pointer });
        return;
      }

      const pointer = drag.pointer;
      if (!pointer) return;
      if (!wasDragged) return;

      if (drag.mode === 'move') {
        const moved = movePoints(drag.origin, drag.anchor, pointer).map(point => ({
          ...point,
          time: snapTime(point.time, current.barTimes),
        }));
        if (samePoints(moved, drag.origin.points)) return;
        current.onUpdate({
          ...drag.origin,
          points: moved,
          version: (drag.origin.version ?? 0) + 1,
        });
        return;
      }

      // A resize: only the grabbed point moves, and the shape keeps the
      // rules it is stored by (a horizontal line stays horizontal, a
      // rectangle keeps two opposite corners).
      const moved = resizePoints(drag.origin.kind, drag.origin, drag.handle, pointer).map(point => ({
        ...point,
        time: snapTime(point.time, current.barTimes),
      }));
      if (samePoints(moved, drag.origin.points)) return;
      current.onUpdate({
        ...drag.origin,
        points: moved,
        version: (drag.origin.version ?? 0) + 1,
      });
    };

    const onPointerCancel = () => {
      cancelDrag();
    };

    /**
     * A drag that leaves the window leaves the drag state behind, and the
     * preview frozen where the pointer was. Losing the focus is the same
     * event as losing the pointer, so the drag is abandoned.
     */
    const onWindowBlur = () => {
      cancelDrag();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (dragRef.current) {
        event.preventDefault();
        cancelDrag();
      }
    };

    /**
     * A click on empty space in cursor mode clears the selection. The
     * overlay itself takes no pointer events in cursor mode, so the click
     * lands on the chart and the window has to hear about it.
     */
    const onWindowPointerDown = (event: PointerEvent) => {
      const current = propsRef.current;
      if (current.tool !== 'cursor') return;
      const target = event.target as Node | null;
      const svg = svgRef.current;
      if (!target) return;
      // A click on a shape is the shape's own business.
      if (svg && svg.contains(target)) return;
      // A click outside the chart is not ours either.
      const element = current.chart?.chartElement();
      if (element && !element.contains(target)) return;
      current.onSelect(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onWindowPointerDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onWindowPointerDown);
    };
  }, []);

  const activeTool = tool !== 'cursor';
  const interactive = canDraw && activeTool;

  /**
   * The chart's plot area, in the overlay's pixel space.
   *
   * It is kept in a ref rather than in state because the chart's own
   * layout settles a tick AFTER the chart exists: the pane is measured,
   * not guessed. The effect below keeps the ref honest while a tool is
   * armed, which is the only time the area is needed.
   */
  const plotAreaRef = useRef<PlotArea | null>(null);

  useEffect(() => {
    if (!chart || !interactive) return;
    const refresh = () => {
      const area = plotAreaFor(chart, svgRef.current);
      const previous = plotAreaRef.current;
      if (area && previous) {
        if (
          area.left === previous.left && area.top === previous.top &&
          area.right === previous.right && area.bottom === previous.bottom
        ) {
          return;
        }
      } else if (!area && !previous) {
        return;
      }
      plotAreaRef.current = area;
      bump();
    };
    refresh();
    /**
     * The pane shrinks when an indicator takes a pane of its own, and the
     * chart reports that a tick late, so the area is polled while a tool
     * is armed. The poll is cheap and it stops the moment the tool does.
     */
    const timer = window.setInterval(refresh, 400);
    return () => window.clearInterval(timer);
  }, [chart, interactive]);

  const plotArea = plotAreaRef.current;

  /**
   * Starts a drawing.
   *
   * The capture rectangle only covers the plot area, so this can only ever
   * be called from inside the chart — but the guard is repeated here,
   * because a drawing that starts on the price scale is a bug the user
   * would have to undo.
   */
  const handlePointerDown = (event: React.PointerEvent<SVGRectElement>) => {
    const current = propsRef.current;
    if (!current.canDraw) return;
    if (current.tool === 'cursor') return;
    if (!current.chart || !current.candleSeries) return;
    const element = svgRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (!insidePlotArea(plotAreaFor(current.chart, element), screen)) return;
    const point = toChartPoint(screen);
    if (!point) return;
    event.preventDefault();

    if (current.tool === 'text') {
      // A text annotation is a CLICK, not a drag: the words are asked for
      // by the panel and the drawing is committed from there. No pointer is
      // captured, because there is no drag to capture one for.
      current.onTextRequest?.({
        time: point.time,
        price: point.price,
        span: textSpanSeconds(current.chart, current.barTimes),
      });
      return;
    }

    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that cannot be captured still drags, it just cannot
      // leave the window.
    }

    const base = {
      startScreen: screen,
      currentScreen: screen,
      pointer: point,
      rect,
      pointerId: event.pointerId,
    };
    dragRef.current = current.tool === 'measure'
      ? { mode: 'measure', start: point, ...base }
      : { mode: 'create', tool: current.tool, start: point, ...base };
    bump();
  };

  /** Grabs a shape so it can be dragged as a whole. */
  const handleShapePointerDown = (event: React.PointerEvent, drawing: RoomDrawing) => {
    event.stopPropagation();
    const current = propsRef.current;
    current.onSelect(drawing.id);
    if (!current.canDraw) return;
    if (!current.chart || !current.candleSeries) return;
    const element = svgRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const anchor = toChartPoint(screen);
    if (!anchor) return;
    event.preventDefault();
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // See above: a drag without a capture still works.
    }
    dragRef.current = {
      mode: 'move',
      id: drawing.id,
      origin: drawing,
      anchor,
      startScreen: screen,
      currentScreen: screen,
      pointer: anchor,
      rect,
      pointerId: event.pointerId,
    };
    bump();
  };

  /** Grabs ONE handle, so one point of the shape moves. */
  const handleHandlePointerDown = (
    event: React.PointerEvent,
    drawing: RoomDrawing,
    handle: DrawingHandle,
  ) => {
    event.stopPropagation();
    const current = propsRef.current;
    current.onSelect(drawing.id);
    if (!current.canDraw) return;
    if (!current.chart || !current.candleSeries) return;
    const element = svgRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.preventDefault();
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // See above.
    }
    dragRef.current = {
      mode: 'resize',
      id: drawing.id,
      origin: drawing,
      handle,
      startScreen: screen,
      currentScreen: screen,
      pointer: toChartPoint(screen),
      rect,
      pointerId: event.pointerId,
    };
    bump();
  };

  /** The shapes being drawn or dragged right now, if any. */
  const previewShapes = useMemo<RoomDrawing[]>(() => {
    const drag = dragRef.current;
    if (!drag || !chart || !candleSeries) return [];
    const base = {
      id: 'preview',
      color,
      width,
      createdBy,
      createdByName,
      createdAt: 0,
      version: 0,
    };
    if (drag.mode === 'measure') return [];
    if (drag.mode === 'create') {
      const pointer = drag.pointer ?? drag.start;
      if (drag.tool === 'channel') {
        const offset = channelOffset(chart, candleSeries, pointer.price - drag.start.price);
        return [
          { ...base, kind: 'trendline' as DrawingKind, points: [{ ...drag.start }, { ...pointer }] },
          {
            ...base,
            id: 'preview-offset',
            kind: 'trendline' as DrawingKind,
            points: [
              { time: drag.start.time, price: drag.start.price - offset },
              { time: pointer.time, price: pointer.price - offset },
            ],
          },
        ];
      }
      const kind = toDrawingKind(drag.tool);
      return [{ ...base, kind, points: pointsForNewDrawing(kind, drag.start, pointer) }];
    }
    const pointer = drag.pointer;
    if (!pointer) return [];
    const points = drag.mode === 'move'
      ? movePoints(drag.origin, drag.anchor, pointer)
      : resizePoints(drag.origin.kind, drag.origin, drag.handle, pointer);
    return [{
      ...drag.origin,
      points: points.map(point => ({ ...point, time: snapTime(point.time, barTimes) })),
    }];
    // The preview depends on the live drag state, which lives in a ref and
    // is signalled through the render counter.
  }, [chart, candleSeries, color, width, createdBy, createdByName, barTimes, renderCount]);

  /** The ruler, live or finished. It never leaves this browser. */
  const measureGeometry = useMemo(() => {
    const drag = dragRef.current;
    const live = drag?.mode === 'measure'
      ? { start: drag.start, end: drag.pointer ?? drag.start }
      : measure;
    if (!live || !chart || !candleSeries) return null;
    const a = projectPoint(chart, candleSeries, live.start);
    const b = projectPoint(chart, candleSeries, live.end);
    if (!a || !b) return null;
    return { a, b, start: live.start, end: live.end };
  }, [chart, candleSeries, measure, renderCount]);

  /** The ruler leaves when the tool does. */
  useEffect(() => {
    if (tool !== 'measure') setMeasure(null);
  }, [tool]);

  /** The drawing currently being dragged, so it is not drawn twice. */
  const draggingId = dragRef.current && 'id' in dragRef.current ? dragRef.current.id : null;

  return (
    <svg
      ref={svgRef}
      className="block h-full w-full"
      style={{ pointerEvents: 'none' }}
      role="group"
      aria-label="Chart drawings"
    >
      {/**
       * The capture surface. It covers the plot area only, so a drawing
       * can never start on the price scale or on the time axis, and the
       * scales stay draggable while a tool is armed.
       */}
      {interactive && plotArea ? (
        <rect
          x={plotArea.left}
          y={plotArea.top}
          width={plotArea.width}
          height={plotArea.height}
          fill="transparent"
          style={{ pointerEvents: 'all', touchAction: 'none', cursor: 'crosshair' }}
          onPointerDown={handlePointerDown}
        />
      ) : null}

      {drawings.map(drawing => {
        if (!chart || !candleSeries) return null;
        if (drawing.id === draggingId) return null;
        const geometry = geometryFor(drawing, chart, candleSeries);
        if (!geometry) return null;
        const selected = drawing.id === selectedId;
        const path = pathFor(geometry);
        const mid = midpointOf(geometry);
        const first = projectPoint(chart, candleSeries, drawing.points[0]);
        const second = projectPoint(chart, candleSeries, drawing.points[1]);
        const handles = selected ? handlesFor(drawing, geometry, first, second) : [];
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
            {drawing.label ? (() => {
              const text = drawing.label.slice(0, 32);
              const chipWidth = text.length * 5.9 + 10;
              return (
                <g pointerEvents="none">
                  <rect
                    x={mid.x - chipWidth / 2}
                    y={mid.y - 18}
                    width={chipWidth}
                    height={15}
                    rx={3}
                    style={{ fill: 'var(--color-sunken)' }}
                    fillOpacity={0.88}
                  />
                  <text
                    x={mid.x}
                    y={mid.y - 6}
                    textAnchor="middle"
                    fontSize={10}
                    fontFamily="'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
                    style={{ fill: drawing.color }}
                  >
                    {text}
                  </text>
                </g>
              );
            })() : null}
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
            {handles.map(handle => (
              <g key={`${drawing.id}-handle-${handle.corner}`}>
                <circle
                  cx={handle.x}
                  cy={handle.y}
                  r={HANDLE_GRAB_RADIUS}
                  fill="transparent"
                  pointerEvents={tool === 'cursor' ? 'all' : 'none'}
                  style={{ cursor: tool === 'cursor' ? 'grab' : 'default' }}
                  onPointerDown={tool === 'cursor'
                    ? (event) => handleHandlePointerDown(event, drawing, handle)
                    : undefined}
                />
                <circle
                  cx={handle.x}
                  cy={handle.y}
                  r={4}
                  style={{ fill: 'var(--color-accent)', stroke: 'var(--color-canvas)' }}
                  strokeWidth={1}
                  pointerEvents="none"
                />
              </g>
            ))}
          </g>
        );
      })}

      {previewShapes.map(preview => {
        if (!chart || !candleSeries) return null;
        const geometry = geometryFor(preview, chart, candleSeries);
        if (!geometry) return null;
        return (
          <path
            key={preview.id}
            d={pathFor(geometry)}
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
      })}

      {measureGeometry ? (() => {
        const { a, b, start, end } = measureGeometry;
        const difference = end.price - start.price;
        const percent = start.price !== 0 ? (difference / Math.abs(start.price)) * 100 : 0;
        const span = Math.abs(end.time - start.time);
        const lines = [
          `${difference >= 0 ? '+' : ''}${formatPrice(difference, digits)} (${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%)`,
          formatDuration(span),
        ];
        const boxWidth = Math.max(...lines.map(line => line.length)) * 6.1 + 14;
        const boxHeight = 30;
        const boxX = Math.max(2, Math.min(a.x, b.x));
        const boxY = Math.max(2, Math.min(a.y, b.y) - boxHeight - 10);
        return (
          <g pointerEvents="none">
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray="5 3"
            />
            <circle cx={a.x} cy={a.y} r={3} fill={color} />
            <circle cx={b.x} cy={b.y} r={3} fill={color} />
            <rect
              x={boxX}
              y={boxY}
              width={boxWidth}
              height={boxHeight}
              rx={4}
              style={{ fill: 'var(--color-sunken)' }}
              fillOpacity={0.92}
              stroke={color}
              strokeOpacity={0.4}
            />
            <text
              x={boxX + 7}
              y={boxY + 13}
              fontSize={10}
              fontFamily="'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
              style={{ fill: color }}
            >
              {lines[0]}
            </text>
            <text
              x={boxX + 7}
              y={boxY + 25}
              fontSize={10}
              fontFamily="'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
              style={{ fill: 'var(--color-fg-subtle)' }}
            >
              {lines[1]}
            </text>
          </g>
        );
      })() : null}
    </svg>
  );
};
