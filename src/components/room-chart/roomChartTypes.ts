/**
 * SHARED TYPES FOR THE ROOM CHART
 * ================================
 * The small vocabulary the toolbar, the drawing overlay and the panel share.
 *
 * The DRAWING shape itself (`RoomDrawing`) is NOT defined here: it lives in
 * `src/shared/roomProtocol.ts` because that is the wire format the room
 * coordinator validates on the server, and a second definition would be a
 * second chance to disagree with it.
 */

/** The tools the drawing overlay offers. `cursor` selects and moves. */
export type RoomChartTool = 'cursor' | 'trendline' | 'ray' | 'hline' | 'vline' | 'rect';

export const ROOM_CHART_TOOLS: RoomChartTool[] = [
  'cursor',
  'trendline',
  'ray',
  'hline',
  'vline',
  'rect',
];

/** The drawing kinds that can be created (everything except the cursor). */
export const ROOM_DRAWING_TOOLS: RoomChartTool[] = ROOM_CHART_TOOLS.filter(tool => tool !== 'cursor');

export function isRoomChartTool(value: unknown): value is RoomChartTool {
  return typeof value === 'string' && (ROOM_CHART_TOOLS as string[]).includes(value);
}

/**
 * The default stroke colour for a new drawing.
 *
 * A warm gold that reads on both the light and the dark canvas. It has to
 * match `^#[0-9a-fA-F]{3,8}$` because the room coordinator rejects any
 * drawing whose colour does not.
 */
export const DEFAULT_ROOM_DRAWING_COLOR = '#d7a85c';

/** The default stroke width for a new drawing. Must be within 0.5 - 8. */
export const DEFAULT_ROOM_DRAWING_WIDTH = 2;

/**
 * A drawing id that satisfies the protocol's `^[A-Za-z0-9_-]{1,64}$`.
 *
 * Base36 only, so it can never contain a character the server would
 * reject and turn the drawing into a silent no-op.
 */
export function createRoomDrawingId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `d${Date.now().toString(36)}${random}`.slice(0, 64);
}
