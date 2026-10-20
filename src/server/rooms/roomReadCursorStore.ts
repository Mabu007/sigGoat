/**
 * ROOM READ CURSOR
 * ================
 * Where each member has read up to, per room.
 *
 * WHY A CURSOR AND NOT A FLAG PER MESSAGE
 * ---------------------------------------
 * A per-message read flag is one write per message viewed, and it does not
 * survive a conversation being pruned. A cursor is ONE small document per
 * (user, room) that is written only when the reader's position moves, and
 * it answers the only question that matters: how many messages are newer
 * than where I stopped reading?
 *
 * The cursor stores the id of the last message the user has actually SEEN
 * and the timestamp of that message. The timestamp is what makes the count
 * a range query rather than a scan: messages newer than the cursor's
 * timestamp, minus the user's own.
 *
 * THE SERVER OWNS IT.
 *
 * The browser never writes this document. A cursor is a statement about
 * what a person has read, and letting the client assert it would let one
 * user clear another user's unread state.
 */

import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "../firebaseAdmin";
import { firestoreSafe } from "../repositories";
import { assertStoreAvailable, ensureStoreDirectory, resolveStoreMode, type StoreModeDecision } from "../storeFs";

export interface ReadCursor {
  /** The room this cursor belongs to. */
  roomId: string;
  /** The last message the user has actually seen. */
  lastReadMessageId: string | null;
  /** The createdAt of that message, so newer messages can be counted. */
  lastReadAt: string | null;
  updatedAt: string;
}

interface CursorDb {
  cursors: Record<string, ReadCursor>;
}

const emptyDb = (): CursorDb => ({ cursors: {} });

const safeId = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

const cursorKey = (uid: string, roomId: string) => `${safeId(uid)}_${safeId(roomId)}`;

export class RoomReadCursorStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private decision: StoreModeDecision = { mode: "memory", fileBacked: false };
  private db: CursorDb = emptyDb();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath =
      options.filePath ||
      path.join(
        process.env.DATA_DIR || path.join(process.cwd(), "data"),
        "room-read-cursors.json",
      );
    if (!this.firestore) {
      this.decision = resolveStoreMode(false, "RoomReadCursorStore");
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
              ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<CursorDb>),
            };
          }
        } catch (error) {
          console.warn("[read-cursor] Saved cursors could not be read; starting empty.", error);
        }
      }
    }
  }

  private collection() {
    return this.firestore!.collection("users");
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
      console.warn("[read-cursor] The read cursor could not be written.", error);
    }
  }

  private assertAvailable() {
    assertStoreAvailable(this.decision, "RoomReadCursorStore");
  }

  async get(uid: string, roomId: string): Promise<ReadCursor | null> {
    this.assertAvailable();
    if (this.firestore) {
      const snapshot = await this.collection()
        .doc(uid)
        .collection("readCursors")
        .doc(safeId(roomId))
        .get();
      return snapshot.exists ? (snapshot.data() as ReadCursor) : null;
    }
    return this.db.cursors[cursorKey(uid, roomId)] ?? null;
  }

  /**
   * Moves the reader's position.
   *
   * The cursor only ever moves FORWARD. A message that arrives late (or a
   * stale page being read) must not drag the cursor backwards and make the
   * conversation look unread again.
   */
  async set(
    uid: string,
    roomId: string,
    position: { messageId: string; createdAt: string },
  ): Promise<ReadCursor> {
    this.assertAvailable();
    const existing = await this.get(uid, roomId).catch(() => null);
    if (existing?.lastReadAt && existing.lastReadAt >= position.createdAt) {
      return existing;
    }
    const cursor: ReadCursor = {
      roomId,
      lastReadMessageId: position.messageId,
      lastReadAt: position.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (this.firestore) {
      await this.collection()
        .doc(uid)
        .collection("readCursors")
        .doc(safeId(roomId))
        .set(firestoreSafe(cursor));
    } else {
      this.db.cursors[cursorKey(uid, roomId)] = cursor;
      this.persist();
    }
    return cursor;
  }
}

export function createRoomReadCursorStore(): RoomReadCursorStore {
  return new RoomReadCursorStore({ firestore: getFirebaseAdmin()?.firestore });
}
