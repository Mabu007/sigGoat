/**
 * ROOM CHART GEOMETRY
 * ===================
 * The maths behind the drawing overlay: how a stored drawing becomes pixels,
 * where the plot area ends, and what a drag does to a shape's two stored
 * points.
 *
 * WHY IT IS ITS OWN FILE
 * ----------------------
 * The overlay draws with it and the panel stores what it produces, so both
 * have to agree on the same rules. A rectangle is stored as two OPPOSITE
 * corners; a horizontal line is stored as two points at the SAME price; a
 * vertical line is stored as two points at the SAME time. If the drawing
 * code and the storing code disagreed about that, a shape would come back
 * from the server looking different from the way it was drawn.
 *
 * EVERYTHING HERE IS PURE
 * -----------------------
 * No React, no DOM listeners, no state. The only inputs are the chart
 * handles and the drawing, so the behaviour can be reasoned about (and
 * checked) without rendering anything.
 */

import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { DrawingKind, DrawingPoint, RoomDrawing } from '../../shared/roomProtocol';

/** A point in the overlay's own pixel space. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** The shape a drawing turns into on screen. */
export type Geometry =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number };

/**
 * The rectangle the chart actually draws its candles in.
 *
 * The price scale on the right and the time axis at the bottom are NOT part
 * of it: a drawing that starts on a scale is a drawing the user never
 * meant to make.
 */
export interface PlotArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * A grabbable point on a drawing.
 *
 * `pointIndex` is the INDEX in the drawing's two stored points, so a drag
 * knows which point it owns. For a rectangle the four corners are derived
 * from the two stored corners, and `corner` says which of the four it is.
 */
export interface DrawingHandle {
  /** The stored point this handle moves. */
  pointIndex: number;
  /** 0 = top left, 1 = top right, 2 = bottom right, 3 = bottom left. */
  corner: number;
  x: number;
  y: number;
}

/**
 * How far a channel's second line sits from the first.
 *
 * A fraction of the VISIBLE price range rather than a fixed number of
 * dollars: a channel that is 5 pips wide on EURUSD and 5 dollars wide on
 * BTC is not a channel, it is a bug.
 */
export const CHANNEL_OFFSET_RATIO = 0.06;

/** How wide a text annotation's underline is, as a share of the window. */
export const TEXT_ANNOTATION_SPAN_RATIO = 0.2;

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

/** Snaps a time to the nearest bar, so a drawing always lands on a real bar. */
export function snapTime(time: number, barTimes: readonly number[]): number {
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

/**
 * The x of a time, even when that time is not in the loaded window.
 *
 * `timeToCoordinate` answers `null` for a bar the chart does not hold, and
 * a drawing anchored to such a bar would simply vanish. The visible range
 * gives a second answer: the time is somewhere to the left or to the right
 * of it, and the position can be extrapolated. The drawing then reaches
 * into the chart from off screen and comes back when the bar is loaded.
 */
export function timeToCoordinateTolerant(chart: IChartApi, time: number): number | null {
  const direct = chart.timeScale().timeToCoordinate(time as Time);
  if (direct !== null && Number.isFinite(direct)) return direct;
  const range = chart.timeScale().getVisibleRange();
  if (!range) return null;
  const from = Number(range.from);
  const to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const width = chart.timeScale().width();
  if (!Number.isFinite(width) || width <= 0) return null;
  return ((time - from) / (to - from)) * width;
}

/* ------------------------------------------------------------------ */
/* Projection                                                           */
/* ------------------------------------------------------------------ */

/** Projects one stored point into the overlay's pixel space. */
export function projectPoint(
  chart: IChartApi,
  candleSeries: ISeriesApi<'Candlestick'>,
  point: DrawingPoint,
): ScreenPoint | null {
  const x = timeToCoordinateTolerant(chart, point.time);
  if (x === null || !Number.isFinite(x)) return null;
  const y = candleSeries.priceToCoordinate(point.price);
  if (y === null || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * The shape a drawing turns into.
 *
 * Returns `null` only when the drawing cannot be placed at all (no price
 * scale yet, or a malformed drawing). A drawing whose anchor is outside the
 * loaded window still gets a geometry: it is simply drawn off screen.
 */
export function geometryFor(
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
export function midpointOf(geometry: Geometry): ScreenPoint {
  if (geometry.kind === 'rect') {
    return { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 };
  }
  return { x: (geometry.x1 + geometry.x2) / 2, y: (geometry.y1 + geometry.y2) / 2 };
}

/* ------------------------------------------------------------------ */
/* The plot area                                                       */
/* ------------------------------------------------------------------ */

/**
 * The rectangle the chart draws its candles in, in the overlay's pixel
 * space.
 *
 * The chart's own pane element is the plot surface: it is the cell that
 * holds the candles, so it excludes the price scale and the time axis by
 * construction. The chart's reported pane size is used when the element is
 * not there yet, which happens for the first frame after the chart is
 * built.
 */
export function plotAreaFor(chart: IChartApi, overlay: Element | null): PlotArea | null {
  if (overlay) {
    let pane: HTMLElement | null = null;
    try {
      pane = chart.panes()[0]?.getHTMLElement?.() ?? null;
    } catch {
      pane = null;
    }
    if (pane) {
      const paneRect = pane.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      if (paneRect.width > 0 && paneRect.height > 0) {
        const left = paneRect.left - overlayRect.left;
        const top = paneRect.top - overlayRect.top;
        return {
          left,
          top,
          right: left + paneRect.width,
          bottom: top + paneRect.height,
          width: paneRect.width,
          height: paneRect.height,
        };
      }
    }
  }

  let width = 0;
  let height = 0;
  try {
    const size = chart.paneSize(0);
    width = size.width;
    height = size.height;
  } catch {
    return null;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
  };
}

/** True when a screen point is inside the plot area. */
export function insidePlotArea(area: PlotArea | null, point: ScreenPoint): boolean {
  if (!area) return true;
  return (
    point.x >= area.left &&
    point.x <= area.right &&
    point.y >= area.top &&
    point.y <= area.bottom
  );
}

/* ------------------------------------------------------------------ */
/* Points                                                              */
/* ------------------------------------------------------------------ */

export function samePoints(a: readonly DrawingPoint[], b: readonly DrawingPoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((point, index) => {
    const other = b[index];
    return !!other && point.time === other.time && point.price === other.price;
  });
}

/** Orders two points by time, so a shape's direction is never ambiguous. */
export function orderByTime(points: DrawingPoint[]): DrawingPoint[] {
  if (points.length < 2) return points;
  if (points[0].time <= points[1].time) return points;
  return [points[1], points[0]];
}

/** The two stored points for a freshly drawn shape. */
export function pointsForNewDrawing(
  kind: DrawingKind,
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
    case 'rect':
      return orderByTime([{ ...start }, { ...current }]);
    default:
      return [{ ...start }, { ...current }];
  }
}

/**
 * The points a shape ends up with when ONE of its handles is dragged.
 *
 * The rules are the ones the shapes are stored by:
 *
 *  - a horizontal line keeps both points at the same PRICE,
 *  - a vertical line keeps both points at the same TIME,
 *  - a rectangle keeps its two corners OPPOSITE: the grabbed corner follows
 *    the pointer and the corner OPPOSITE to it stays exactly where it was.
 *    A rectangle is stored as two opposite corners, so two of its four
 *    handles sit on a stored point and two sit between them; the rule
 *    above covers all four of them the way a rectangle is expected to
 *    behave. The pair is ordered by time, so the drag direction cannot
 *    flip the shape.
 */
export function resizePoints(
  kind: DrawingKind,
  origin: Pick<RoomDrawing, 'points'>,
  handle: DrawingHandle,
  pointer: DrawingPoint,
): DrawingPoint[] {
  const a = origin.points[0];
  const b = origin.points[1];
  if (!a || !b) return origin.points;
  switch (kind) {
    case 'hline': {
      const price = pointer.price;
      const moved = handle.pointIndex === 0
        ? [{ time: pointer.time, price }, { time: b.time, price }]
        : [{ time: a.time, price }, { time: pointer.time, price }];
      return orderByTime(moved);
    }
    case 'vline': {
      const time = pointer.time;
      const moved = handle.pointIndex === 0
        ? [{ time, price: pointer.price }, { time, price: b.price }]
        : [{ time, price: a.price }, { time, price: pointer.price }];
      return moved;
    }
    case 'rect': {
      const minTime = Math.min(a.time, b.time);
      const maxTime = Math.max(a.time, b.time);
      const minPrice = Math.min(a.price, b.price);
      const maxPrice = Math.max(a.price, b.price);
      /**
       * The corners are numbered the way they are ON SCREEN: 0 is the top
       * left, 1 the top right, 2 the bottom right, 3 the bottom left. A
       * higher price is higher up, so the top left corner is the oldest
       * time and the highest price.
       */
      const opposite = (handle.corner + 2) % 4;
      const anchor = opposite === 0
        ? { time: minTime, price: maxPrice }
        : opposite === 1
        ? { time: maxTime, price: maxPrice }
        : opposite === 2
        ? { time: maxTime, price: minPrice }
        : { time: minTime, price: minPrice };
      return orderByTime([{ ...pointer }, anchor]);
    }
    default:
      return handle.pointIndex === 0
        ? [{ ...pointer }, b]
        : [a, { ...pointer }];
  }
}

/**
 * The points a shape ends up with when its BODY is dragged.
 *
 * The whole shape is translated by the same amount in time and in price, so
 * a horizontal line stays horizontal and a rectangle stays a rectangle.
 */
export function movePoints(
  origin: Pick<RoomDrawing, 'points'>,
  anchor: DrawingPoint,
  pointer: DrawingPoint,
): DrawingPoint[] {
  const dTime = pointer.time - anchor.time;
  const dPrice = pointer.price - anchor.price;
  return origin.points.map(point => ({
    time: point.time + dTime,
    price: point.price + dPrice,
  }));
}

/* ------------------------------------------------------------------ */
/* Handles                                                             */
/* ------------------------------------------------------------------ */

/**
 * The grabbable points of a drawing.
 *
 * A line has two (its ends). A rectangle has FOUR (its corners). A
 * rectangle is stored as two OPPOSITE corners, so only two of its four
 * corners sit on a stored point: the other two are marked with a
 * `pointIndex` of -1, and the resize works from the corner anyway.
 */
export function handlesFor(
  drawing: Pick<RoomDrawing, 'kind' | 'points'>,
  geometry: Geometry,
  a: ScreenPoint | null,
  b: ScreenPoint | null,
): DrawingHandle[] {
  if (geometry.kind === 'line') {
    return [
      { pointIndex: 0, corner: -1, x: geometry.x1, y: geometry.y1 },
      { pointIndex: 1, corner: -1, x: geometry.x2, y: geometry.y2 },
    ];
  }
  if (!a || !b) return [];
  const aLeft = a.x <= b.x;
  const aTop = a.y <= b.y;
  const aCorner = aTop ? (aLeft ? 0 : 1) : (aLeft ? 3 : 2);
  const corners: Array<{ corner: number; x: number; y: number }> = [
    { corner: 0, x: geometry.x, y: geometry.y },
    { corner: 1, x: geometry.x + geometry.width, y: geometry.y },
    { corner: 2, x: geometry.x + geometry.width, y: geometry.y + geometry.height },
    { corner: 3, x: geometry.x, y: geometry.y + geometry.height },
  ];
  return corners.map(entry => ({
    /**
     * The stored point that sits ON this corner, or -1 for the two corners
     * that sit between the stored ones. A rectangle is stored as two
     * opposite corners, so only two of its four corners are stored
     * points; the resize works from the corner, not from the point.
     */
    pointIndex: entry.corner === aCorner ? 0 : entry.corner === (aCorner + 2) % 4 ? 1 : -1,
    corner: entry.corner,
    x: entry.x,
    y: entry.y,
  }));
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** A short human duration: `45m`, `3h 12m`, `2d 4h`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Math.abs(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** A price with a sane number of decimals. */
export function formatPrice(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, Math.min(8, digits)),
  });
}
