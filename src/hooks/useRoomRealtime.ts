/**
 * USE ROOM REALTIME
 * =================
 * The React binding for a room's realtime connection.
 *
 * It owns the socket, keeps the room state in React state, and exposes the
 * actions the room view needs. It does NOT own any policy: what a member is
 * allowed to do is decided by the server, and the view asks the server's
 * answer (the `can*` flags on the room) rather than deciding for itself.
 *
 * The socket is opened only when the room is actually open and the user is
 * signed in. It is closed on unmount and whenever the room changes, so a
 * member who moves between rooms never leaves a socket behind.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomSocket, type RoomSocketStatus } from '../lib/roomSocket';
import {
  ROOM_PROTOCOL_VERSION,
  type ClientMessage,
  type RoomDrawing,
  type RoomParticipant,
  type RoomRealtimeState,
  type RoomSessionState,
  type ServerMessage,
  type VoiceParticipant,
} from '../shared/roomProtocol';
import { useAuth } from '../context/AuthContext';

export interface UseRoomRealtimeOptions {
  roomId: string | null;
  /** Whether the socket should be open at all. */
  enabled: boolean;
  /** The Worker's public base url, from GET /api/realtime/status. */
  workerUrl: string | null;
  /** Display name used for presence. */
  displayName: string;
}

export interface UseRoomRealtime {
  status: RoomSocketStatus;
  connected: boolean;
  state: RoomRealtimeState | null;
  self: RoomParticipant | null;
  participants: RoomParticipant[];
  voiceParticipants: VoiceParticipant[];
  voiceEnabled: boolean;
  session: RoomSessionState | null;
  symbol: string;
  timeframe: string;
  drawings: RoomDrawing[];
  error: string | null;
  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: string) => void;
  createDrawing: (drawing: RoomDrawing) => void;
  updateDrawing: (drawing: RoomDrawing) => void;
  removeDrawing: (id: string) => void;
  clearDrawings: () => void;
  setMuted: (muted: boolean) => void;
  setSpeaking: (speaking: boolean) => void;
  joinVoice: () => void;
  leaveVoice: () => void;
  requestState: () => void;
}

export function useRoomRealtime(options: UseRoomRealtimeOptions): UseRoomRealtime {
  const { roomId, enabled, workerUrl, displayName } = options;
  const { currentUser } = useAuth();

  const [status, setStatus] = useState<RoomSocketStatus>('idle');
  const [state, setState] = useState<RoomRealtimeState | null>(null);
  const [self, setSelf] = useState<RoomParticipant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<RoomSocket | null>(null);

  const send = useCallback((message: ClientMessage) => {
    socketRef.current?.send(message);
  }, []);

  useEffect(() => {
    if (!enabled || !roomId || !workerUrl || !currentUser) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setStatus('idle');
      return;
    }

    const socket = new RoomSocket({
      baseUrl: workerUrl,
      roomId,
      getToken: async () => {
        const token = await currentUser.getIdToken();
        return token ?? null;
      },
      onStatus: setStatus,
      onMessage: (message: ServerMessage) => {
        switch (message.t) {
          case 'welcome':
            setState(message.state);
            setSelf(message.self);
            setError(null);
            return;
          case 'state':
            setState(message.state);
            return;
          case 'presence':
            setState((current) =>
              current ? { ...current, participants: message.participants } : current,
            );
            return;
          case 'voice':
            setState((current) =>
              current
                ? {
                    ...current,
                    voice: {
                      enabled: message.enabled,
                      participants: message.participants,
                    },
                  }
                : current,
            );
            return;
          case 'session':
            setState((current) =>
              current ? { ...current, session: message.session } : current,
            );
            return;
          case 'chart.symbol':
            setState((current) =>
              current
                ? {
                    ...current,
                    chart: { ...current.chart, symbol: message.symbol },
                  }
                : current,
            );
            return;
          case 'chart.timeframe':
            setState((current) =>
              current
                ? {
                    ...current,
                    chart: { ...current.chart, timeframe: message.timeframe },
                  }
                : current,
            );
            return;
          case 'drawing.add':
          case 'drawing.update':
            setState((current) => {
              if (!current) return current;
              const drawings = current.chart.drawings.filter(
                (drawing) => drawing.id !== message.drawing.id,
              );
              return {
                ...current,
                chart: {
                  ...current.chart,
                  drawings: [...drawings, message.drawing],
                },
              };
            });
            return;
          case 'drawing.remove':
            setState((current) =>
              current
                ? {
                    ...current,
                    chart: {
                      ...current.chart,
                      drawings: current.chart.drawings.filter(
                        (drawing) => drawing.id !== message.id,
                      ),
                    },
                  }
                : current,
            );
            return;
          case 'drawings.cleared':
            setState((current) =>
              current
                ? { ...current, chart: { ...current.chart, drawings: [] } }
                : current,
            );
            return;
          case 'error':
            setError(message.message);
            return;
          case 'pong':
            return;
          default:
            return;
        }
      },
    });
    socketRef.current = socket;
    socket.connect();

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [enabled, roomId, workerUrl, currentUser]);

  const createDrawing = useCallback(
    (drawing: RoomDrawing) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'drawing.create', drawing });
    },
    [send],
  );
  const updateDrawing = useCallback(
    (drawing: RoomDrawing) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'drawing.update', drawing });
    },
    [send],
  );
  const removeDrawing = useCallback(
    (id: string) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'drawing.remove', id });
    },
    [send],
  );
  const clearDrawings = useCallback(() => {
    send({ v: ROOM_PROTOCOL_VERSION, t: 'drawings.clear' });
  }, [send]);

  const setSymbol = useCallback(
    (symbol: string) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'chart.setSymbol', symbol });
    },
    [send],
  );
  const setTimeframe = useCallback(
    (timeframe: string) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'chart.setTimeframe', timeframe });
    },
    [send],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'voice.mute', muted });
    },
    [send],
  );
  const setSpeaking = useCallback(
    (speaking: boolean) => {
      send({ v: ROOM_PROTOCOL_VERSION, t: 'voice.speaking', speaking });
    },
    [send],
  );
  const joinVoice = useCallback(() => {
    send({ v: ROOM_PROTOCOL_VERSION, t: 'voice.join' });
  }, [send]);
  const leaveVoice = useCallback(() => {
    send({ v: ROOM_PROTOCOL_VERSION, t: 'voice.leave' });
  }, [send]);
  const requestState = useCallback(() => {
    send({ v: ROOM_PROTOCOL_VERSION, t: 'state.request' });
  }, [send]);

  const participants = state?.participants ?? [];
  const voiceParticipants = state?.voice?.participants ?? [];

  return useMemo(
    () => ({
      status,
      connected: status === 'open',
      state,
      self,
      participants,
      voiceParticipants,
      voiceEnabled: state?.voice?.enabled ?? true,
      session: state?.session ?? null,
      symbol: state?.chart?.symbol ?? '',
      timeframe: state?.chart?.timeframe ?? '15m',
      drawings: state?.chart?.drawings ?? [],
      error,
      setSymbol,
      setTimeframe,
      createDrawing,
      updateDrawing,
      removeDrawing,
      clearDrawings,
      setMuted,
      setSpeaking,
      joinVoice,
      leaveVoice,
      requestState,
    }),
    [
      status,
      state,
      self,
      participants,
      voiceParticipants,
      error,
      setSymbol,
      setTimeframe,
      createDrawing,
      updateDrawing,
      removeDrawing,
      clearDrawings,
      setMuted,
      setSpeaking,
      joinVoice,
      leaveVoice,
      requestState,
    ],
  );
}
