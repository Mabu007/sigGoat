/**
 * ROOM PRESENCE STORE
 * ===================
 * Who is actually connected to a room right now.
 *
 * THE SERVER IS AUTHORITATIVE.
 *
 * The Durable Object holds the live connections. It pushes a snapshot here,
 * and the API serves it. Nothing is inferred from a timer, a cached list or
 * a count of sockets: the snapshot carries the AUTHENTICATED identity of
 * every connection, so the same person with three tabs is one person.
 *
 * A SNAPSHOT, NOT A LEASE
 * -----------------------
 * The snapshot is what the Durable Object last saw. If the object dies, the
 * snapshot goes stale, and a stale snapshot is reported as UNKNOWN rather
 * than as a number: an out-of-date "3 online" is a lie, and a lie in a
 * presence indicator is worse than no indicator.
 */

import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "../firebaseAdmin";
import { firestoreSafe } from "../repositories";
import { assertStoreAvailable, ensureStoreDirectory, resolveStoreMode, type StoreModeDecision } from "../storeFs";

/** How old a snapshot may be before it is treated as unknown. */
export const PRESENCE_STALE_MS = 90_000;

export interface PresenceMember {
  uid: string;
  name: string;
  /** OWNER, LEADER or MEMBER. */
  role: string;
  /** When this connection opened. */
  connectedAt: number;
}

export interface RoomPresence {
  roomId: string;
  members: PresenceMember[];
  /** Unique users, not connections. */
  onlineCount: number;
  /** True when the room's owner or a leader has a live connection. */
  mentorOnline: boolean;
  updatedAt: string;
  updatedAtMs: number;
}

interface PresenceDb {
  presence: Record<string, RoomPresence>;
}

const emptyDb = (): PresenceDb => ({ presence: {} });

const safeId = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

export class RoomPresenceStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private decision: StoreModeDecision = { mode: "memory", fileBacked: false };
  private db: PresenceDb = emptyDb();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath =
      options.filePath ||
      path.join(
        process.env.DATA_DIR || path.join(process.cwd(), "data"),
        "room-presence.json",
      );
    if (!this.firestore) {
      this.decision = resolveStoreMode(false, "RoomPresenceStore");
      if (this.decision.mode !== "unavailable") {
        this.decision = {
          ...this.decision,
          fileBacked: ensureStoreDirectory(this.filePath),
        };
      }
      if (this.decision.fileBacked) {
        try {
          if (fs.existsSync(this.filePath)) {
            this.db = {
              ...emptyDb(),
              ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PresenceDb>),
            };
          }
        } catch (error) {
          console.warn("[presence] The saved presence could not be read; starting empty.", error);
        }
      }
    }
  }

  private collection() {
    return this.firestore!.collection("goatTeams");
  }

  private persist() {
    if (!this.decision.fileBacked) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = this.filePath + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      this.decision = { ...this.decision, fileBacked: false };
      console.warn("[presence] The presence snapshot could not be written.", error);
    }
  }

  private assertAvailable() {
    assertStoreAvailable(this.decision, "RoomPresenceStore");
  }

  /** Records the snapshot a room's Durable Object reported. */
  async set(roomId: string, members: PresenceMember[]): Promise<RoomPresence> {
    this.assertAvailable();
    const key = safeId(roomId);

    /**
     * ONE ENTRY PER PERSON.
     *
     * A member with three tabs is one member. The Durable Object sends one
     * entry per CONNECTION, so the de-duplication happens here, where the
     * count is produced.
     */
    const byUid = new Map<string, PresenceMember>();
    for (const member of members) {
      if (!member?.uid) continue;
      const existing = byUid.get(member.uid);
      if (!existing || member.connectedAt < existing.connectedAt) {
        byUid.set(member.uid, member);
      }
    }
    const unique = [...byUid.values()];
    const now = Date.now();
    const presence: RoomPresence = {
      roomId,
      members: unique,
      onlineCount: unique.length,
      mentorOnline: unique.some(
        (member) => member.role === "OWNER" || member.role === "LEADER",
      ),
      updatedAt: new Date(now).toISOString(),
      updatedAtMs: now,
    };

    if (this.firestore) {
      await this.collection()
        .doc(key)
        .collection("presence")
        .doc("current")
        .set(firestoreSafe(presence));
    } else {
      this.db.presence[key] = presence;
      this.persist();
    }
    return presence;
  }

  /**
   * The room's last reported presence.
   *
   * Returns null when there is no snapshot OR when the snapshot is older
   * than the staleness window: an out-of-date count is not a count.
   */
  async get(roomId: string): Promise<RoomPresence | null> {
    this.assertAvailable();
    const key = safeId(roomId);
    let presence: RoomPresence | null = null;
    if (this.firestore) {
      const snapshot = await this.collection()
        .doc(key)
        .collection("presence")
        .doc("current")
        .get();
      if (snapshot.exists) presence = snapshot.data() as RoomPresence;
    } else {
      presence = this.db.presence[key] ?? null;
    }
    if (!presence) return null;
    if (Date.now() - (presence.updatedAtMs ?? 0) > PRESENCE_STALE_MS) return null;
    return presence;
  }

  /** The presence of many rooms at once, for the room directory. */
  async getMany(roomIds: string[]): Promise<Record<string, RoomPresence>> {
    const out: Record<string, RoomPresence> = {};
    for (const roomId of roomIds) {
      const presence = await this.get(roomId).catch(() => null);
      if (presence) out[roomId] = presence;
    }
    return out;
  }

  /** Removes a room's presence. Used when a room is deleted. */
  async clear(roomId: string): Promise<void> {
    this.assertAvailable();
    const key = safeId(roomId);
    if (this.firestore) {
      await this.collection()
        .doc(key)
        .collection("presence")
        .doc("current")
        .delete()
        .catch(() => undefined);
      return;
    }
    delete this.db.presence[key];
    this.persist();
  }
}

export function createRoomPresenceStore(): RoomPresenceStore {
  return new RoomPresenceStore({ firestore: getFirebaseAdmin()?.firestore });
}
