/**
 * SHARED TYPES FOR THE ROOM CHART
 * ================================
 * The small vocabulary the toolbar, the drawing overlay and the panel share.
 *
 * The DRAWING shape itself (`RoomDrawing`) is NOT defined here: it lives in
 * `src/shared/roomProtocol.ts` because that is the wire format the room
 * coordinator validates on the server, and a second definition would be a
 * second chance to disagree with it.
 *
 * THE TOOLS
 * ---------
 * The wire format only knows five drawing kinds (`trendline`, `ray`,
 * `hline`, `vline`, `rect`) and the server validates them, so NO tool may
 * invent a sixth kind. The richer tools are therefore built OUT of the
 * existing kinds:
 *
 *  - `channel` commits TWO `trendline` drawings. The panel keeps them in a
 *    single history entry, so one undo reverses both.
 *  - `text` commits ONE `hline` that carries the text in the drawing's
 *    EXISTING `label` field, so nothing new crosses the wire.
 *  - `measure` is a LOCAL ruler. It is never committed, it never reaches the
 *    room and it never appears in the shared drawing list.
 */

/**
 * The tools the drawing overlay offers.
 *
 * `cursor` selects, moves and resizes. Everything else draws.
 */
export type RoomChartTool =
  | 'cursor'
  | 'trendline'
  | 'ray'
  | 'hline'
  | 'vline'
  | 'rect'
  | 'channel'
  | 'text'
  | 'measure';

export const ROOM_CHART_TOOLS: RoomChartTool[] = [
  'cursor',
  'trendline',
  'ray',
  'hline',
  'vline',
  'rect',
  'channel',
  'text',
  'measure',
];

/**
 * The tools that commit a drawing.
 *
 * `cursor` draws nothing and `measure` is a local ruler, so neither of them
 * belongs here.
 */
export const ROOM_DRAWING_TOOLS: RoomChartTool[] = ROOM_CHART_TOOLS.filter(
  tool => tool !== 'cursor' && tool !== 'measure',
);

/** The tools that never touch the room, whatever the chart mode is. */
export const ROOM_LOCAL_TOOLS: RoomChartTool[] = ['measure'];

/**
 * The keyboard shortcuts, as a map from the lower-cased key to the tool.
 *
 * They are applied by the PANEL (not by the overlay) so they work whether
 * or not the tool strip is open, and they never fire while the user is
 * typing in a field.
 */
export const ROOM_TOOL_SHORTCUTS: Record<string, RoomChartTool> = {
  v: 'cursor',
  t: 'trendline',
  l: 'ray',
  h: 'hline',
  y: 'vline',
  r: 'rect',
  c: 'channel',
  m: 'measure',
  x: 'text',
};

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
