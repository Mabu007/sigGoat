/**
 * TRADINGVIBES ROOM DOMAIN TYPES
 * ===============================
 * The room record itself lives in `goatTeams` (see `src/server/GoatTeamStore.ts`)
 * — that collection predates the rebrand and already holds every room, so
 * renaming it would orphan live data for no benefit. These types describe the
 * fields TradingVibes adds ON TOP of the existing room record, plus the
 * shapes returned to the browser.
 *
 * A ROOM, A MEMBERSHIP AND A SESSION ARE THREE DIFFERENT THINGS.
 *
 *   - the room exists whether or not anyone is in it, and whether or not a
 *     live session is running;
 *   - a membership row says who may read the room;
 *   - a session is a bounded live episode with a start and an end.
 *
 * Conflating them is how a product ends up unable to say "the room is here
 * but nobody is live right now".
 */

import type { RoomDrawing, RoomSessionState } from '../shared/roomProtocol';

export type { RoomDrawing, RoomSessionState };

/** The market categories a room can belong to. */
export type RoomCategory =
  | 'gold'
  | 'forex'
  | 'crypto'
  | 'indices'
  | 'commodities'
  | 'general';

export const ROOM_CATEGORIES: { id: RoomCategory; label: string }[] = [
  { id: 'gold', label: 'Gold' },
  { id: 'forex', label: 'Forex' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'indices', label: 'Indices' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'general', label: 'General' },
];

export const ROOM_CATEGORY_IDS: RoomCategory[] = ROOM_CATEGORIES.map(
  (category) => category.id,
);

export function isRoomCategory(value: unknown): value is RoomCategory {
  return (
    typeof value === 'string' &&
    (ROOM_CATEGORY_IDS as string[]).includes(value)
  );
}

/** Who may change what. The room owner is the only LEADER by default. */
export type RoomRole = 'OWNER' | 'LEADER' | 'MEMBER' | 'GUEST';

export function isRoomRole(value: unknown): value is RoomRole {
  return (
    value === 'OWNER' ||
    value === 'LEADER' ||
    value === 'MEMBER' ||
    value === 'GUEST'
  );
}

export interface RoomChartDefaults {
  symbol: string;
  timeframe: string;
}

/** The persistent room settings a leader can edit. */
export interface RoomSettings {
  /** Free text market tags used by the directory filters. */
  markets: string[];
  category: RoomCategory;
  /** R2 object key of the room cover image. */
  coverKey?: string;
  /** Signed delivery url for the cover, regenerated on every server read. */
  coverUrl?: string;
  chart: RoomChartDefaults;
  /** Whether members may draw on the shared chart. */
  allowDrawings: boolean;
  /** Whether the room may open a voice session. */
  voiceEnabled: boolean;
  /** Maximum number of members. */
  maxMembers: number;
}

/** A durable session record, stored at
 *  `goatTeams/{roomId}/sessions/{sessionId}`. */
export interface RoomSessionRecord {
  id: string;
  roomId: string;
  status: 'starting' | 'live' | 'ending' | 'ended';
  startedAt: string;
  endedAt?: string;
  startedBy: string;
  startedByName?: string;
  symbol?: string;
  timeframe?: string;
  recording?: boolean;
  participantCount?: number;
  /** True when the session was recorded locally by the leader. */
  hasRecording?: boolean;
}

// ---------------------------------------------------------------------------
// Media (Cloudflare R2)
// ---------------------------------------------------------------------------

export type MediaPurpose = 'avatar' | 'room-cover';

export interface MediaReference {
  /** R2 object key. The canonical stored value. */
  key: string;
  /** Signed delivery url. Never persisted as the source of truth. */
  url: string;
  purpose: MediaPurpose;
  contentType: string;
  size: number;
  updatedAt: string;
}

/** What the server hands the browser before an upload. */
export interface MediaUploadTicket {
  key: string;
  uploadUrl: string;
  expiresAt: string;
  /** Headers the browser MUST send with the upload. */
  headers: Record<string, string>;
  purpose: MediaPurpose;
  maxBytes: number;
  allowedTypes: string[];
}

export const MEDIA_MAX_BYTES = 4 * 1024 * 1024;

export const MEDIA_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** Magic-byte prefixes for the allowed image types. A client-declared MIME
 *  type proves nothing; these do. */
export const MEDIA_SIGNATURES: { type: string; bytes: number[] }[] = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46] },
];

export function detectMediaType(bytes: Uint8Array): string | null {
  for (const signature of MEDIA_SIGNATURES) {
    if (bytes.length < signature.bytes.length) continue;
    let matches = true;
    for (let index = 0; index < signature.bytes.length; index += 1) {
      if (bytes[index] !== signature.bytes[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return signature.type;
  }
  // WebP: "RIFF" .... "WEBP"
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}
