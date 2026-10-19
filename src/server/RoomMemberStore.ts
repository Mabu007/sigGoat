/**
 * ROOM MEMBERSHIP STORE
 * =====================
 * A trading room is a human-led community: the room leader owns it, and
 * people JOIN it to take part in the room conversation and to talk to the
 * leader privately.
 *
 * This store records that membership. It is deliberately separate from the
 * room record itself (see `GoatTeamStore`): the room's OWNER is authoritative
 * on the room document, and a membership row only ever says "this person is
 * in this room". That separation is what makes the authorization checks
 * simple and hard to get wrong:
 *
 *   - the leader is whoever `team.ownerUserId` says, always;
 *   - a member is a row in this store, scoped to one room;
 *   - a private thread is readable by the two uids on it, and nobody else.
 *
 * Firestore in production, a JSON file for self-hosted runs, following the
 * same pattern as the other stores in this application.
 */

import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "./firebaseAdmin";

/** The leader is the room owner; everyone else is a member. */
export type RoomMemberRole = "MEMBER";

export interface RoomMemberRecord {
  /** "<roomId>_<userId>", sanitised. */
  id: string;
  roomId: string;
  userId: string;
  role: RoomMemberRole;
  /** The name the member joined with. A snapshot, not a live lookup. */
  displayName: string;
  joinedAt: string;
}

interface RoomMemberDb {
  members: Record<string, RoomMemberRecord>;
}

const emptyDb = (): RoomMemberDb => ({ members: {} });

/** Firestore document ids cannot contain every character a uid may. */
const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

const memberId = (roomId: string, userId: string) => `${safeId(roomId)}_${safeId(userId)}`;

export class RoomMemberStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private db: RoomMemberDb = emptyDb();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath =
      options.filePath || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "room-members.json");
    if (!this.firestore) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.existsSync(this.filePath)) {
          this.db = { ...emptyDb(), ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<RoomMemberDb>) };
        }
      } catch (error) {
        throw new Error("ROOM_MEMBER_STORE_UNREADABLE: saved room memberships could not be loaded.", { cause: error });
      }
    }
  }

  private collection() {
    return this.firestore!.collection("roomMembers");
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
    fs.renameSync(temp, this.filePath);
  }

  /**
   * Records membership. Idempotent: joining twice keeps the original join
   * time and never creates a second row.
   */
  async join(roomId: string, userId: string, displayName: string): Promise<RoomMemberRecord> {
    const id = memberId(roomId, userId);
    const existing = await this.get(roomId, userId);
    const record: RoomMemberRecord = {
      id,
      roomId,
      userId,
      role: "MEMBER",
      displayName: displayName.trim().slice(0, 80) || "Member",
      joinedAt: existing?.joinedAt ?? new Date().toISOString(),
    };
    if (this.firestore) await this.collection().doc(id).set(record);
    else {
      this.db.members[id] = record;
      this.persist();
    }
    return record;
  }

  async get(roomId: string, userId: string): Promise<RoomMemberRecord | null> {
    const id = memberId(roomId, userId);
    if (this.firestore) {
      const snapshot = await this.collection().doc(id).get();
      return snapshot.exists ? (snapshot.data() as RoomMemberRecord) : null;
    }
    return this.db.members[id] ?? null;
  }

  /** Every member of one room, oldest join first. */
  async list(roomId: string): Promise<RoomMemberRecord[]> {
    if (this.firestore) {
      const snapshot = await this.collection().where("roomId", "==", roomId).get();
      return snapshot.docs
        .map((doc) => doc.data() as RoomMemberRecord)
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    }
    return Object.values(this.db.members)
      .filter((member) => member.roomId === roomId)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }
}

export function createRoomMemberStore(): RoomMemberStore {
  return new RoomMemberStore({ firestore: getFirebaseAdmin()?.firestore });
}
