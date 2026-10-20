/**
 * ROOM ACCESS
 * ===========
 * One place that answers "what may this person do in this room?".
 *
 * The rules are deliberately boring and are applied on the SERVER for every
 * privileged operation. The browser hides buttons; that is presentation, not
 * authorization. A user who edits the request body still gets the answer
 * this module gives.
 *
 * THE FOUR ROLES
 * --------------
 *   OWNER  - created the room. Full control.
 *   LEADER - explicitly granted by the owner. Can run sessions and edit
 *            room settings, but cannot delete the room.
 *   MEMBER - joined the room. Can chat, draw and use voice.
 *   GUEST  - may look at a PUBLIC room without joining. Read-only.
 *
 * A PRIVATE room is not readable by a guest at all. The share slug is an
 * invitation: a link holder may JOIN, and joining creates the membership that
 * unlocks the room's content. Holding a link is not the same as being in the
 * room, and the two are checked separately.
 */

import type { GoatTeam } from '../GoatTeamStore';
import { createRoomMemberStore, type RoomMemberStore } from '../RoomMemberStore';
import type { RoomRole } from '../../types/rooms';

export interface RoomAccess {
  role: RoomRole;
  isMember: boolean;
  /** May see the room's content (chat, cover, member list). */
  canView: boolean;
  /** May read and write the room chat. */
  canChat: boolean;
  /** May draw on the shared chart. */
  canDraw: boolean;
  /** May use the room's voice session. */
  canUseVoice: boolean;
  /** May edit room settings. */
  canManage: boolean;
  /** May start and end a live session. */
  canRunSession: boolean;
}

const ACCESS = {
  OWNER: {
    role: 'OWNER' as RoomRole,
    isMember: true,
    canView: true,
    canChat: true,
    canDraw: true,
    canUseVoice: true,
    canManage: true,
    canRunSession: true,
  },
  LEADER: {
    role: 'LEADER' as RoomRole,
    isMember: true,
    canView: true,
    canChat: true,
    canDraw: true,
    canUseVoice: true,
    canManage: true,
    canRunSession: true,
  },
  MEMBER: {
    role: 'MEMBER' as RoomRole,
    isMember: true,
    canView: true,
    canChat: true,
    canDraw: true,
    canUseVoice: true,
    canManage: false,
    canRunSession: false,
  },
  GUEST: {
    role: 'GUEST' as RoomRole,
    isMember: false,
    canView: false,
    canChat: false,
    canDraw: false,
    canUseVoice: false,
    canManage: false,
    canRunSession: false,
  },
} satisfies Record<RoomRole, RoomAccess>;

let memberStore: RoomMemberStore | null = null;

export function getRoomMemberStore(): RoomMemberStore {
  if (!memberStore) memberStore = createRoomMemberStore();
  return memberStore;
}

/** The room's own settings, with defaults applied for rooms created before
 *  these fields existed. Defaults live here so every reader agrees. */
export function roomSettingsOf(team: GoatTeam) {
  const settings = team.settings ?? {};
  return {
    markets: Array.isArray(settings.markets) ? settings.markets : [],
    category: settings.category ?? 'general',
    allowDrawings: settings.allowDrawings !== false,
    voiceEnabled: settings.voiceEnabled !== false,
    maxMembers: settings.maxMembers ?? 100,
    chart: {
      symbol: settings.chart?.symbol ?? team.deployment?.asset ?? 'XAUUSD',
      timeframe: settings.chart?.timeframe ?? '15m',
    },
  };
}

export function isTeamLeader(team: GoatTeam, uid: string): boolean {
  if (!uid) return false;
  if (team.ownerUserId === uid) return true;
  return Array.isArray(team.leaders) && team.leaders.includes(uid);
}

/**
 * Resolves the caller's access to a room.
 *
 * `uid` is the VERIFIED identity (from a checked Firebase token), never a
 * value taken out of a request body.
 */
export async function resolveRoomAccess(
  team: GoatTeam,
  uid: string | null | undefined,
  store: RoomMemberStore = getRoomMemberStore(),
): Promise<RoomAccess> {
  const isPublic = (team.visibility ?? 'PRIVATE') === 'PUBLIC';

  if (uid && team.ownerUserId === uid) return ACCESS.OWNER;
  if (uid && Array.isArray(team.leaders) && team.leaders.includes(uid)) {
    return ACCESS.LEADER;
  }

  if (uid) {
    const membership = await store.get(team.id, uid);
    if (membership) {
      // A member of a room that was switched to private keeps their access:
      // removing them is an explicit moderation action, not a side effect of
      // the owner changing a toggle.
      return ACCESS.MEMBER;
    }
  }

  if (isPublic) return ACCESS.GUEST;
  return ACCESS.GUEST;
}

/**
 * A guest of a PUBLIC room may still watch the shared chart. A guest of a
 * PRIVATE room may not see the room at all.
 */
export function canWatchRoom(team: GoatTeam, access: RoomAccess): boolean {
  if (access.isMember) return true;
  return (team.visibility ?? 'PRIVATE') === 'PUBLIC';
}
