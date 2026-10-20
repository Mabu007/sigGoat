/**
 * ROOM CHART LOCAL STORAGE
 * ========================
 * The private drawings of a participant, kept between reloads.
 *
 * WHY THIS EXISTS
 * ---------------
 * A personal (local mode) drawing is the viewer's own work. Losing it on
 * every refresh makes the local chart a sandcastle, so the drawings are
 * written to `localStorage` under a namespaced key.
 *
 * THE KEY
 * -------
 * The key carries the room, the symbol and the timeframe, so:
 *
 *  - two rooms never see each other's drawings,
 *  - two instruments never see each other's drawings,
 *  - and a stored drawing can never leak into a DIFFERENT chart context.
 *
 * The room part is the room id when the parent supplies one and a sanitised
 * room name otherwise. The room name is what the panel has today, so the
 * storage works without any change to the parent; passing the room id makes
 * it exact (two rooms can share a name).
 *
 * THE VALIDATION
 * --------------
 * Everything in `localStorage` is untrusted: it can be edited by hand, it
 * can survive a change of the wire format, and it can be left over from a
 * build that no longer exists. A stored drawing is therefore checked
 * against the SAME validator the server uses, plus a couple of extra
 * checks, and anything that does not pass is DROPPED rather than repaired.
 */

import type { RoomDrawing } from '../../shared/roomProtocol';
import { isValidDrawing } from '../../shared/roomProtocol';

/** The prefix every stored drawing set lives under. */
export const ROOM_CHART_STORAGE_PREFIX = 'tv.roomchart.private.v1';

/** How many drawings one stored set may hold. */
export const ROOM_CHART_STORAGE_LIMIT = 200;

/** Turns a room name into something that can live in a storage key. */
export function sanitizeStoragePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * The key one participant's private drawings live under.
 *
 * `roomKey` is the room id, or the room name when there is no id.
 */
export function roomChartStorageKey(
  roomKey: string,
  symbol: string,
  timeframe: string,
): string {
  const room = sanitizeStoragePart(roomKey) || 'room';
  const sym = sanitizeStoragePart(symbol) || 'symbol';
  const tf = sanitizeStoragePart(timeframe) || 'tf';
  return `${ROOM_CHART_STORAGE_PREFIX}:${room}:${sym}:${tf}`;
}

/**
 * True when a stored value is a drawing this build can use.
 *
 * The protocol's own validator does the heavy lifting (the id, the kind,
 * the two points, the colour, the width); the extras are the fields the
 * protocol leaves optional.
 */
export function isUsableStoredDrawing(value: unknown): value is RoomDrawing {
  if (!isValidDrawing(value)) return false;
  const drawing = value as RoomDrawing;
  if (!Number.isFinite(drawing.createdAt)) return false;
  if (!Number.isFinite(drawing.version)) return false;
  if (drawing.label !== undefined && typeof drawing.label !== 'string') return false;
  if (typeof drawing.createdByName !== 'undefined' && typeof drawing.createdByName !== 'string') {
    return false;
  }
  return true;
}

/**
 * Reads the stored drawings for one chart context.
 *
 * Anything malformed is dropped, and a storage that cannot be read at all
 * (private mode, a quota error, a corrupted value) yields an empty list
 * rather than an exception.
 */
export function readStoredDrawings(key: string): RoomDrawing[] {
  if (typeof localStorage === 'undefined') return [];
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const drawings: RoomDrawing[] = [];
  for (const entry of parsed) {
    if (isUsableStoredDrawing(entry)) drawings.push(entry);
  }
  return drawings.slice(0, ROOM_CHART_STORAGE_LIMIT);
}

/** Writes the private drawings for one chart context. */
export function writeStoredDrawings(key: string, drawings: readonly RoomDrawing[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (drawings.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(drawings.slice(0, ROOM_CHART_STORAGE_LIMIT)));
  } catch {
    // A full or unavailable storage must never break the chart.
  }
}
