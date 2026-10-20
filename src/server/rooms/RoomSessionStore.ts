/**
 * ROOM SESSION STORE
 * ==================
 * A live session is a bounded episode: it starts, it runs, it ends. It is
 * NOT the room. A room may exist with no session, and a session may end
 * while the room stays open for the next one.
 *
 * Durable records live at
 *
 *   goatTeams/{roomId}/sessions/{sessionId}
 *
 * which is a SUBCOLLECTION of the room document. That keeps a session's
 * lifetime tied to its room: deleting the room deletes its sessions, and a
 * session can never be read without reading its room first.
 *
 * The ACTIVE session is tracked by `activeSessionId` on the room document,
 * because "is a session running right now?" is asked on every room read and
 * must not require a subcollection query.
 *
 * Firestore in production, a JSON file for self-hosted runs — the same
 * pattern as the other stores in this application.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "../firebaseAdmin";
import { firestoreSafe } from "../repositories";

export type RoomSessionStatus = "starting" | "live" | "ending" | "ended";

export interface RoomSessionRecord {
  id: string;
  roomId: string;
  status: RoomSessionStatus;
  startedAt: string;
  endedAt?: string;
  startedBy: string;
  startedByName?: string;
  symbol?: string;
  timeframe?: string;
  recording?: boolean;
  participantCount?: number;
  hasRecording?: boolean;
}

export interface StartSessionInput {
  roomId: string;
  startedBy: string;
  startedByName?: string;
  symbol?: string;
  timeframe?: string;
}

interface SessionDb {
  sessions: Record<string, RoomSessionRecord>;
  active: Record<string, string>;
}

const emptyDb = (): SessionDb => ({ sessions: {}, active: {} });

const safeId = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

export class RoomSessionStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private db: SessionDb = emptyDb();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath =
      options.filePath ||
      path.join(
        process.env.DATA_DIR || path.join(process.cwd(), "data"),
        "room-sessions.json",
      );
    if (!this.firestore) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.existsSync(this.filePath)) {
          this.db = {
            ...emptyDb(),
            ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<SessionDb>),
          };
        }
      } catch (error) {
        throw new Error("ROOM_SESSION_STORE_UNREADABLE: saved room sessions could not be loaded.", {
          cause: error,
        });
      }
    }
  }

  private collection() {
    return this.firestore!.collection("goatTeams");
  }

  private sessionsCollection(roomId: string) {
    return this.collection().doc(safeId(roomId)).collection("sessions");
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
    fs.renameSync(temp, this.filePath);
  }

  /**
   * Starts a session.
   *
   * The "one active session per room" rule is enforced with a transaction on
   * the room document, so two leaders pressing Start at the same instant
   * cannot both win. The loser gets `ROOM_SESSION_ALREADY_ACTIVE`.
   */
  async start(input: StartSessionInput): Promise<RoomSessionRecord> {
    const roomId = safeId(input.roomId);
    const id = `s_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    const record: RoomSessionRecord = {
      id,
      roomId: input.roomId,
      status: "live",
      startedAt: new Date().toISOString(),
      startedBy: input.startedBy,
      startedByName: input.startedByName,
      symbol: input.symbol,
      timeframe: input.timeframe,
    };

    if (this.firestore) {
      const roomRef = this.collection().doc(roomId);
      await this.firestore.runTransaction(async (tx) => {
        const roomSnapshot = await tx.get(roomRef);
        if (!roomSnapshot.exists) {
          throw new Error("ROOM_NOT_FOUND");
        }
        const activeId = roomSnapshot.get("activeSessionId") as string | undefined;
        if (activeId) {
          const activeSnapshot = await tx.get(
            this.sessionsCollection(input.roomId).doc(activeId),
          );
          const active = activeSnapshot.data() as RoomSessionRecord | undefined;
          // A session that was never closed cleanly does not block the room
          // forever: only a session that is genuinely still running does.
          if (active && active.status !== "ended") {
            throw new Error("ROOM_SESSION_ALREADY_ACTIVE");
          }
        }
        tx.create(this.sessionsCollection(input.roomId).doc(id), firestoreSafe(record));
        tx.update(roomRef, { activeSessionId: id, updatedAt: record.startedAt });
      });
      return record;
    }

    const activeId = this.db.active[roomId];
    if (activeId) {
      const active = this.db.sessions[activeId];
      if (active && active.status !== "ended") {
        throw new Error("ROOM_SESSION_ALREADY_ACTIVE");
      }
    }
    this.db.sessions[id] = record;
    this.db.active[roomId] = id;
    this.persist();
    return record;
  }

  async end(roomId: string, sessionId?: string): Promise<RoomSessionRecord | null> {
    const safeRoomId = safeId(roomId);
    const endedAt = new Date().toISOString();

    if (this.firestore) {
      const roomRef = this.collection().doc(safeRoomId);
      const targetId =
        sessionId ??
        ((await roomRef.get()).get("activeSessionId") as string | undefined);
      if (!targetId) return null;
      const sessionRef = this.sessionsCollection(roomId).doc(targetId);
      const snapshot = await sessionRef.get();
      if (!snapshot.exists) return null;
      const current = snapshot.data() as RoomSessionRecord;
      if (current.status === "ended") return current;
      const updated: RoomSessionRecord = { ...current, status: "ended", endedAt };
      await sessionRef.set(firestoreSafe(updated));
      await roomRef.update({ activeSessionId: null, updatedAt: endedAt });
      return updated;
    }

    const targetId = sessionId ?? this.db.active[safeRoomId];
    if (!targetId) return null;
    const current = this.db.sessions[targetId];
    if (!current) return null;
    if (current.status === "ended") return current;
    const updated: RoomSessionRecord = { ...current, status: "ended", endedAt };
    this.db.sessions[targetId] = updated;
    if (this.db.active[safeRoomId] === targetId) {
      this.db.active[safeRoomId] = "";
    }
    this.persist();
    return updated;
  }

  /** The session that is running right now, if any. */
  async getActive(roomId: string): Promise<RoomSessionRecord | null> {
    const safeRoomId = safeId(roomId);
    if (this.firestore) {
      const roomSnapshot = await this.collection().doc(safeRoomId).get();
      if (!roomSnapshot.exists) return null;
      const activeId = roomSnapshot.get("activeSessionId") as string | undefined;
      if (!activeId) return null;
      const snapshot = await this.sessionsCollection(roomId).doc(activeId).get();
      if (!snapshot.exists) return null;
      const record = snapshot.data() as RoomSessionRecord;
      return record.status === "ended" ? null : record;
    }
    const activeId = this.db.active[safeRoomId];
    if (!activeId) return null;
    const record = this.db.sessions[activeId];
    if (!record || record.status === "ended") return null;
    return record;
  }

  /** Recent sessions for a room, newest first. */
  async list(roomId: string, limit = 20): Promise<RoomSessionRecord[]> {
    if (this.firestore) {
      const snapshot = await this.sessionsCollection(roomId)
        .orderBy("startedAt", "desc")
        .limit(Math.min(Math.max(limit, 1), 50))
        .get();
      return snapshot.docs.map((doc) => doc.data() as RoomSessionRecord);
    }
    return Object.values(this.db.sessions)
      .filter((session) => session.roomId === roomId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }
}

export function createRoomSessionStore(): RoomSessionStore {
  return new RoomSessionStore({ firestore: getFirebaseAdmin()?.firestore });
}
