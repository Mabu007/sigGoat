/**
 * ROOM SOCKET
 * ===========
 * The browser's connection to a room's Durable Object.
 *
 * WHAT IT DOES
 * ------------
 *   - opens the WebSocket with the caller's Firebase ID token
 *   - reconnects with backoff when the connection drops
 *   - resynchronizes the room state after a reconnect
 *   - keeps the socket alive with a periodic ping
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not decide what a message MEANS. That is the room view's job, and
 * the server's job is to decide what is ALLOWED. This class is transport.
 *
 * The token is fetched fresh on every (re)connect. A token is short lived,
 * so reusing a stale one after a long disconnection would fail the edge
 * verification and the member would be silently dropped from the room.
 */

import {
  ROOM_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '../shared/roomProtocol';

export type RoomSocketStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'error';

export interface RoomSocketOptions {
  /** The Worker's public base url, e.g. https://tradingvibes-realtime.example.workers.dev */
  baseUrl: string;
  roomId: string;
  /** Returns a CURRENT Firebase ID token. Called on every connect attempt. */
  getToken: () => Promise<string | null>;
  onMessage: (message: ServerMessage) => void;
  onStatus?: (status: RoomSocketStatus) => void;
}

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 20_000;

export class RoomSocket {
  private socket: WebSocket | null = null;
  private status: RoomSocketStatus = 'idle';
  private closedByCaller = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RoomSocketOptions) {}

  getStatus(): RoomSocketStatus {
    return this.status;
  }

  private setStatus(status: RoomSocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  /** Opens the socket. Safe to call more than once. */
  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.closedByCaller = false;
    void this.open();
  }

  private async open(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.options.getToken();
    } catch {
      token = null;
    }
    if (!token) {
      this.setStatus('error');
      return;
    }
    if (this.closedByCaller) return;

    const base = this.options.baseUrl.replace(/\/+$/, '');
    const wsBase = base.startsWith('http://')
      ? base.replace(/^http:/, 'ws:')
      : base.startsWith('https://')
        ? base.replace(/^https:/, 'wss:')
        : base;
    const url = `${wsBase}/rooms/${encodeURIComponent(this.options.roomId)}/socket?token=${encodeURIComponent(token)}`;

    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus('open');
      this.startHeartbeat();
      // The server sends the full state on connect, but asking explicitly
      // makes a reconnect deterministic rather than dependent on the
      // server's welcome frame arriving.
      this.send({ v: ROOM_PROTOCOL_VERSION, t: 'state.request' });
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (!message || typeof message.t !== 'string') return;
      this.options.onMessage(message);
    };

    socket.onerror = () => {
      this.setStatus('error');
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      this.socket = null;
      if (this.closedByCaller) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      1000 * 2 ** Math.min(this.reconnectAttempt - 1, 4),
      MAX_BACKOFF_MS,
    );
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ v: ROOM_PROTOCOL_VERSION, t: 'ping' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Sends a message. Silently drops it when the socket is not open. */
  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Closes the socket and stops reconnecting. */
  disconnect(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close(1000, 'left room');
      } catch {
        // A socket that is already closing needs no help.
      }
      this.socket = null;
    }
    this.setStatus('closed');
  }
}
