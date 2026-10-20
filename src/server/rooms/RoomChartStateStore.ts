/**
 * ROOM CHART STATE STORE
 * ======================
 * The Durable Object holds the LIVE shared chart state (symbol, timeframe,
 * drawings). This store holds the DURABLE copy of the same state, so a room
 * that has been quiet for a week still opens on the chart its members left
 * it on.
 *
 *   goatTeams/{roomId}/chartState/{doc}
 *
 * ONE document per room, not a collection. The state is a single small
 * value: a symbol, a timeframe and a bounded list of drawings. Storing it as
 * a collection of individual drawings would mean a read per drawing on every
 * room open, which is exactly the kind of read amplification that exhausts a
 * Firestore quota.
 *
 * The store is written at most once every SNAPSHOT_MIN_INTERVAL_MS, and only
 * when the state actually changed. Pointer movement during a drag is never
 * persisted; only committed drawing changes are.
 */

import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "../firebaseAdmin";
import { firestoreSafe } from "../repositories";
import type { RoomDrawing } from "../../shared/roomProtocol";
import { ROOM_MAX_DRAWINGS } from "../../shared/roomProtocol";

export interface RoomChartSnapshot {
  roomId: string;
  symbol: string;
  timeframe: string;
  drawings: RoomDrawing[];
  updatedAt: string;
}

interface ChartDb {
  charts: Record<string, RoomChartSnapshot>;
}

const emptyDb = (): ChartDb => ({ charts: {} });

const safeId = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

export class RoomChartStateStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private db: ChartDb = emptyDb();
  private lastWriteAt = new Map<string, number>();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath =
      options.filePath ||
      path.join(
        process.env.DATA_DIR || path.join(process.cwd(), "data"),
        "room-chart-state.json",
      );
    if (!this.firestore) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.existsSync(this.filePath)) {
          this.db = {
            ...emptyDb(),
            ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<ChartDb>),
          };
        }
      } catch (error) {
        throw new Error("ROOM_CHART_STATE_UNREADABLE: saved chart state could not be loaded.", {
          cause: error,
        });
      }
    }
  }

  private collection() {
    return this.firestore!.collection("goatTeams");
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
    fs.renameSync(temp, this.filePath);
  }

  async get(roomId: string): Promise<RoomChartSnapshot | null> {
    const key = safeId(roomId);
    if (this.firestore) {
      const snapshot = await this.collection().doc(key).collection("chartState").doc("current").get();
      if (!snapshot.exists) return null;
      return snapshot.data() as RoomChartSnapshot;
    }
    return this.db.charts[key] ?? null;
  }

  /**
   * Writes the snapshot, but not more often than the throttle allows.
   *
   * Returns true when the write happened. A throttled write returns false so
   * the caller can schedule a trailing write instead of writing immediately.
   */
  async save(
    roomId: string,
    input: { symbol: string; timeframe: string; drawings: RoomDrawing[] },
    options: { force?: boolean; minIntervalMs?: number } = {},
  ): Promise<boolean> {
    const key = safeId(roomId);
    const minInterval = options.minIntervalMs ?? 30_000;
    const now = Date.now();
    const last = this.lastWriteAt.get(key) ?? 0;
    if (!options.force && now - last < minInterval) return false;

    const snapshot: RoomChartSnapshot = {
      roomId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      drawings: input.drawings.slice(-ROOM_MAX_DRAWINGS),
      updatedAt: new Date(now).toISOString(),
    };

    if (this.firestore) {
      await this.collection()
        .doc(key)
        .collection("chartState")
        .doc("current")
        .set(firestoreSafe(snapshot));
    } else {
      this.db.charts[key] = snapshot;
      this.persist();
    }
    this.lastWriteAt.set(key, now);
    return true;
  }
}

export function createRoomChartStateStore(): RoomChartStateStore {
  return new RoomChartStateStore({ firestore: getFirebaseAdmin()?.firestore });
}
