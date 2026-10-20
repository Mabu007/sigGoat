/**
 * ROOM COORDINATOR (DURABLE OBJECT)
 * ==================================
 * ONE instance per room. It owns that room's shared state and every
 * WebSocket connected to it.
 *
 * WHAT IT OWNS
 * ------------
 *   - the shared chart symbol and timeframe
 *   - the shared drawings
 *   - who is connected (presence)
 *   - the live session state
 *   - the voice roster
 *
 * WHAT IT DOES NOT OWN
 * ---------------------
 *   - authorization. The API decides who may be in the room and who may do
 *     what; the Worker verifies the token and asks the API before this
 *     object is even reached. This object applies the answer it was given.
 *   - the permanent record. Durable Object storage is a fast, recoverable
 *     cache. The permanent record is in Firestore, and this object writes a
 *     THROTTLED snapshot there.
 *
 * WHY A SNAPSHOT AND NOT A WRITE PER EVENT
 * -----------------------------------------
 * A drag produces hundreds of pointer events. Only COMMITTED changes (a
 * drawing created, moved, deleted) reach this object at all, and even those
 * are batched into a snapshot at most once every 30 seconds. Firestore
 * therefore sees a handful of writes per busy room per minute, not one per
 * mouse move.
 */

import {
  isFrameWithinLimit,
  parseClientMessage,
  ROOM_MAX_DRAWINGS,
  ROOM_PROTOCOL_VERSION,
  type ClientMessage,
  type RoomDrawing,
  type RoomParticipant,
  type RoomRealtimeState,
  type RoomRole,
  type RoomSessionState,
  type ServerMessage,
  type VoiceParticipant,
} from "../../src/shared/roomProtocol";
import { signServiceRequest } from "./signing";

export interface RoomCoordinatorEnv {
  ROOM_API_ORIGIN: string;
  ROOM_REALTIME_SECRET: string;
}

interface ConnectionRecord {
  id: string;
  participant: RoomParticipant;
  socket: WebSocket;
  /** What this connection is allowed to do. Decided by the API. */
  canChat: boolean;
  canDraw: boolean;
  canManage: boolean;
  canRunSession: boolean;
  canUseVoice: boolean;
}

interface PersistedRoomState {
  symbol: string;
  timeframe: string;
  /**
   * Whether the state has been seeded from the room's own settings.
   *
   * Until it has, the room's instrument and timeframe — which the API knows
   * and this object does not — are adopted on the first connection. After
   * that the room's own state wins, so a leader who changed the shared
   * chart is not overridden by a later joiner.
   */
  initialised: boolean;
  drawings: RoomDrawing[];
  session: RoomSessionState | null;
  voice: { enabled: boolean; participants: VoiceParticipant[] };
}

const DEFAULT_STATE: PersistedRoomState = {
  symbol: "XAUUSD",
  timeframe: "15m",
  initialised: false,
  drawings: [],
  session: null,
  voice: { enabled: true, participants: [] },
};

/** How often a changed room state is written to Firestore. */
const SNAPSHOT_INTERVAL_MS = 30_000;

export class RoomCoordinator implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: RoomCoordinatorEnv;

  private roomState: PersistedRoomState = { ...DEFAULT_STATE, drawings: [] };
  private connections = new Map<string, ConnectionRecord>();
  private stateLoaded = false;
  private snapshotAlarmScheduled = false;

  constructor(state: DurableObjectState, env: RoomCoordinatorEnv) {
    this.state = state;
    this.env = env;
  }

  // -- lifecycle ---------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleUpgrade(request);
    }

    if (url.pathname === "/rooms/state" && request.method === "GET") {
      await this.ensureStateLoaded();
      return this.json({ state: this.realtimeState() });
    }

    if (url.pathname === "/rooms/session" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { session?: unknown };
      await this.ensureStateLoaded();
      this.roomState.session = (body.session ?? null) as RoomSessionState | null;
      await this.persistState();
      this.broadcast({ v: ROOM_PROTOCOL_VERSION, t: "session", session: this.roomState.session });
      return this.json({ ok: true });
    }

    if (url.pathname === "/rooms/voice" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        roster?: { enabled?: boolean; participants?: VoiceParticipant[] };
      };
      await this.ensureStateLoaded();
      this.roomState.voice = {
        enabled: body.roster?.enabled !== false,
        participants: Array.isArray(body.roster?.participants)
          ? body.roster.participants
          : [],
      };
      await this.persistState();
      this.broadcast({
        v: ROOM_PROTOCOL_VERSION,
        t: "voice",
        enabled: this.roomState.voice.enabled,
        participants: this.roomState.voice.participants,
      });
      return this.json({ ok: true });
    }

    return this.json({ error: { code: "NOT_FOUND", message: "No such endpoint." } }, 404);
  }

  async alarm(): Promise<void> {
    this.snapshotAlarmScheduled = false;
    await this.ensureStateLoaded();
    await this.pushSnapshot();
  }

  // -- websocket ---------------------------------------------------------

  private async handleUpgrade(request: Request): Promise<Response> {
    await this.ensureStateLoaded();

    const access = this.readAccess(request);
    if (!access) {
      return new Response("Missing room access", { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const id = crypto.randomUUID();
    const participant: RoomParticipant = {
      id,
      uid: access.uid,
      name: access.name.slice(0, 60) || "Member",
      role: access.role as RoomRole,
      muted: true,
      speaking: false,
      joinedAt: Date.now(),
    };

    /**
     * The first connection to a room seeds the shared chart from the room's
     * own settings, which the API reported with the access decision. After
     * that the room's shared state wins, so a leader who changed the
     * instrument is not overridden by somebody joining later.
     */
    if (!this.roomState.initialised) {
      this.roomState.symbol = access.symbol || this.roomState.symbol;
      this.roomState.timeframe = access.timeframe || this.roomState.timeframe;
      this.roomState.initialised = true;
      await this.persistState();
    }

    this.state.acceptWebSocket(server);
    this.connections.set(id, {
      id,
      participant,
      socket: server,
      canChat: access.canChat,
      canDraw: access.canDraw,
      canManage: access.canManage,
      canRunSession: access.canRunSession,
      canUseVoice: access.canUseVoice,
    });

    server.addEventListener("message", (event) => {
      void this.handleMessage(id, event.data as string);
    });
    server.addEventListener("close", () => {
      this.connections.delete(id);
      this.broadcastPresence();
    });
    server.addEventListener("error", () => {
      this.connections.delete(id);
      this.broadcastPresence();
    });

    this.send(server, {
      v: ROOM_PROTOCOL_VERSION,
      t: "welcome",
      state: this.realtimeState(),
      self: participant,
    });
    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  private readAccess(request: Request): {
    uid: string;
    name: string;
    role: string;
    canChat: boolean;
    canDraw: boolean;
    canManage: boolean;
    canRunSession: boolean;
    canUseVoice: boolean;
    symbol?: string;
    timeframe?: string;
  } | null {
    const raw = request.headers.get("x-room-access");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.uid !== "string" || !parsed.uid) return null;
      return {
        uid: parsed.uid,
        name: typeof parsed.name === "string" ? parsed.name : "Member",
        role: typeof parsed.role === "string" ? parsed.role : "GUEST",
        canChat: parsed.canChat === true,
        canDraw: parsed.canDraw === true,
        canManage: parsed.canManage === true,
        canRunSession: parsed.canRunSession === true,
        canUseVoice: parsed.canUseVoice === true,
        symbol: typeof parsed.symbol === "string" ? parsed.symbol : undefined,
        timeframe: typeof parsed.timeframe === "string" ? parsed.timeframe : undefined,
      };
    } catch {
      return null;
    }
  }

  private async handleMessage(connectionId: string, raw: string): Promise<void> {
    if (typeof raw !== "string") return;
    if (!isFrameWithinLimit(raw)) {
      this.sendError(connectionId, "FRAME_TOO_LARGE", "That message is too large.");
      return;
    }
    const message = parseClientMessage(raw);
    if (!message) {
      this.sendError(connectionId, "INVALID_MESSAGE", "That message was not understood.");
      return;
    }
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    try {
      await this.applyMessage(connection, message);
    } catch (error) {
      console.error("[room] Failed to apply a message:", error);
      this.sendError(connectionId, "APPLY_FAILED", "That action could not be completed.");
    }
  }

  private async applyMessage(
    connection: ConnectionRecord,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.t) {
      case 'hello':
        return;
      case 'state.request':
        this.send(connection.socket, {
          v: ROOM_PROTOCOL_VERSION,
          t: "state",
          state: this.realtimeState(),
        });
        return;
      case 'chart.setSymbol': {
        if (!connection.canManage) {
          this.sendError(connection.id, "NOT_ALLOWED", "Only the room leader can change the shared chart.");
          return;
        }
        this.roomState.symbol = message.symbol;
        await this.persistState();
        this.scheduleSnapshot();
        this.broadcast({
          v: ROOM_PROTOCOL_VERSION,
          t: "chart.symbol",
          symbol: message.symbol,
          by: connection.participant.uid,
          byName: connection.participant.name,
        });
        return;
      }
      case 'chart.setTimeframe': {
        if (!connection.canManage) {
          this.sendError(connection.id, "NOT_ALLOWED", "Only the room leader can change the shared chart.");
          return;
        }
        this.roomState.timeframe = message.timeframe;
        await this.persistState();
        this.scheduleSnapshot();
        this.broadcast({
          v: ROOM_PROTOCOL_VERSION,
          t: "chart.timeframe",
          timeframe: message.timeframe,
          by: connection.participant.uid,
          byName: connection.participant.name,
        });
        return;
      }
      case 'drawing.create':
      case 'drawing.update': {
        if (!connection.canDraw) {
          this.sendError(connection.id, "NOT_ALLOWED", "You cannot draw on this chart.");
          return;
        }
        const drawing: RoomDrawing = {
          ...message.drawing,
          createdBy: connection.participant.uid,
          createdByName: connection.participant.name,
          version: (message.drawing.version ?? 0) + 1,
        };
        const index = this.roomState.drawings.findIndex((item) => item.id === drawing.id);
        if (index >= 0) {
          this.roomState.drawings[index] = drawing;
        } else {
          this.roomState.drawings.push(drawing);
          if (this.roomState.drawings.length > ROOM_MAX_DRAWINGS) {
            this.roomState.drawings.splice(
              0,
              this.roomState.drawings.length - ROOM_MAX_DRAWINGS,
            );
          }
        }
        await this.persistState();
        this.scheduleSnapshot();
        this.broadcast({
          v: ROOM_PROTOCOL_VERSION,
          t: message.t === 'drawing.create' ? 'drawing.add' : 'drawing.update',
          drawing,
        });
        return;
      }
      case 'drawing.remove': {
        if (!connection.canDraw) {
          this.sendError(connection.id, "NOT_ALLOWED", "You cannot change this chart.");
          return;
        }
        const existing = this.roomState.drawings.find((item) => item.id === message.id);
        if (!existing) return;
        const isOwner = existing.createdBy === connection.participant.uid;
        if (!isOwner && !connection.canManage) {
          this.sendError(connection.id, "NOT_ALLOWED", "That is not your drawing.");
          return;
        }
        this.roomState.drawings = this.roomState.drawings.filter(
          (item) => item.id !== message.id,
        );
        await this.persistState();
        this.scheduleSnapshot();
        this.broadcast({
          v: ROOM_PROTOCOL_VERSION,
          t: "drawing.remove",
          id: message.id,
          by: connection.participant.uid,
          byName: connection.participant.name,
        });
        return;
      }
      case 'drawings.clear': {
        if (!connection.canManage) {
          this.sendError(connection.id, "NOT_ALLOWED", "Only the room leader can clear the chart.");
          return;
        }
        this.roomState.drawings = [];
        await this.persistState();
        this.scheduleSnapshot();
        this.broadcast({
          v: ROOM_PROTOCOL_VERSION,
          t: "drawings.cleared",
          by: connection.participant.uid,
          byName: connection.participant.name,
        });
        return;
      }
      case 'session.start': {
        if (!connection.canRunSession) {
          this.sendError(connection.id, "NOT_ALLOWED", "Only the room leader can start the live session.");
          return;
        }
        const session = await this.callApiSession("start", connection.participant.uid, message.symbol, message.timeframe);
        if (session) {
          this.roomState.session = session;
          await this.persistState();
          this.broadcast({ v: ROOM_PROTOCOL_VERSION, t: "session", session });
        }
        return;
      }
      case 'session.end': {
        if (!connection.canRunSession) {
          this.sendError(connection.id, "NOT_ALLOWED", "Only the room leader can end the live session.");
          return;
        }
        const session = await this.callApiSession("end", connection.participant.uid);
        this.roomState.session = session ?? null;
        await this.persistState();
        this.broadcast({ v: ROOM_PROTOCOL_VERSION, t: "session", session: this.roomState.session });
        return;
      }
      case 'voice.join':
      case 'voice.leave': {
        if (!connection.canUseVoice) {
          this.sendError(connection.id, "NOT_ALLOWED", "Join the room to use its voice session.");
          return;
        }
        const inVoice = message.t === 'voice.join';
        const existing = this.roomState.voice.participants.filter(
          (participant) => participant.uid !== connection.participant.uid,
        );
        this.roomState.voice.participants = inVoice
          ? [
              ...existing,
              {
                id: connection.participant.id,
                uid: connection.participant.uid,
                name: connection.participant.name,
                muted: true,
                speaking: false,
              },
            ]
          : existing;
        await this.persistState();
        this.broadcastVoice();
        return;
      }
      case 'voice.mute':
      case 'voice.speaking': {
        const flag = message.t === 'voice.mute' ? message.muted : message.speaking;
        connection.participant.muted = message.t === 'voice.mute' ? !flag : connection.participant.muted;
        connection.participant.speaking = message.t === 'voice.speaking' ? flag : false;
        this.roomState.voice.participants = this.roomState.voice.participants.map(
          (participant) =>
            participant.uid === connection.participant.uid
              ? {
                  ...participant,
                  muted: message.t === 'voice.mute' ? !flag : participant.muted,
                  speaking: message.t === 'voice.speaking' ? flag : participant.speaking,
                }
              : participant,
        );
        await this.persistState();
        this.broadcastVoice();
        return;
      }
      case 'ping':
        this.send(connection.socket, {
          v: ROOM_PROTOCOL_VERSION,
          t: "pong",
          serverTime: Date.now(),
        });
        return;
      default:
        return;
    }
  }

  // -- session lifecycle -------------------------------------------------

  /**
   * Asks the API to perform the session transition.
   *
   * The API owns the durable record and re-checks the caller's role against
   * the room document. This object never invents a session on its own.
   */
  private async callApiSession(
    action: "start" | "end",
    uid: string,
    symbol?: string,
    timeframe?: string,
  ): Promise<RoomSessionState | null> {
    const origin = (this.env.ROOM_API_ORIGIN ?? "").split(",")[0]?.trim().replace(/\/+$/, "");
    if (!origin) return null;
    const roomId = this.roomId;
    const signature = await signServiceRequest(
      "room-session",
      roomId,
      this.env.ROOM_REALTIME_SECRET,
    );
    try {
      const response = await fetch(`${origin}/api/internal/rooms/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tradingvibes-service": signature,
        },
        body: JSON.stringify({ roomId, action, uid, symbol, timeframe }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { session?: RoomSessionState | null };
      return body.session ?? null;
    } catch {
      return null;
    }
  }

  // -- persistence -------------------------------------------------------

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const stored = await this.state.storage.get<PersistedRoomState>("state");
    if (stored) {
      this.roomState = {
        symbol: stored.symbol ?? DEFAULT_STATE.symbol,
        timeframe: stored.timeframe ?? DEFAULT_STATE.timeframe,
        initialised: stored.initialised === true,
        drawings: Array.isArray(stored.drawings) ? stored.drawings : [],
        session: stored.session ?? null,
        voice: stored.voice ?? { enabled: true, participants: [] },
      };
    }
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put("state", this.roomState);
  }

  /**
   * Schedules a durable snapshot.
   *
   * The alarm is the trailing write: it fires at most once per interval no
   * matter how often the state changes, and it survives the object being
   * evicted.
   */
  private scheduleSnapshot(): void {
    if (this.snapshotAlarmScheduled) return;
    this.snapshotAlarmScheduled = true;
    this.state.setAlarm(Date.now() + SNAPSHOT_INTERVAL_MS);
  }

  private async pushSnapshot(): Promise<void> {
    const origin = (this.env.ROOM_API_ORIGIN ?? "").split(",")[0]?.trim().replace(/\/+$/, "");
    if (!origin) return;
    const signature = await signServiceRequest(
      "room-snapshot",
      this.roomId,
      this.env.ROOM_REALTIME_SECRET,
    );
    try {
      await fetch(`${origin}/api/internal/rooms/snapshot`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tradingvibes-service": signature,
        },
        body: JSON.stringify({
          roomId: this.roomId,
          symbol: this.roomState.symbol,
          timeframe: this.roomState.timeframe,
          drawings: this.roomState.drawings,
        }),
      });
    } catch (error) {
      console.warn(
        "[room] Snapshot push failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // -- broadcasting ------------------------------------------------------

  private get roomId(): string {
    return this.state.id.name ?? "room";
  }

  private realtimeState(): RoomRealtimeState {
    return {
      version: ROOM_PROTOCOL_VERSION,
      chart: {
        symbol: this.roomState.symbol,
        timeframe: this.roomState.timeframe,
        drawings: this.roomState.drawings,
      },
      session: this.roomState.session,
      participants: [...this.connections.values()].map((connection) => connection.participant),
      voice: this.roomState.voice,
      serverTime: Date.now(),
    };
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      try {
        connection.socket.send(payload);
      } catch {
        // A socket that cannot be written to is closed on its next event.
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({
      v: ROOM_PROTOCOL_VERSION,
      t: "presence",
      participants: [...this.connections.values()].map((connection) => connection.participant),
    });
  }

  private broadcastVoice(): void {
    this.broadcast({
      v: ROOM_PROTOCOL_VERSION,
      t: "voice",
      enabled: this.roomState.voice.enabled,
      participants: this.roomState.voice.participants,
    });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Ignored: the close handler removes the connection.
    }
  }

  private sendError(connectionId: string, code: string, message: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.send(connection.socket, { v: ROOM_PROTOCOL_VERSION, t: "error", code, message });
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
