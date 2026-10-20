/**
 * USE ROOM VOICE
 * ==============
 * The browser half of a TradingVibes room voice session.
 *
 * WHERE THE WORK HAPPENS
 * ----------------------
 * The server owns the Cloudflare SFU session and the roster; the browser owns
 * the microphone, the peer connections and the audio elements. The browser
 * never sees the SFU App Secret and never talks to the SFU directly.
 *
 * JOIN
 *   1. GET  /api/realtime/status        -> is voice configured on the server?
 *   2. getUserMedia({ audio: true })    -> the local microphone
 *   3. publish peer connection          -> offer -> POST /voice/publish -> answer
 *   4. subscribe peer connection        -> POST /voice/subscribe -> offer -> answer
 *                                         -> POST /voice/answer
 *
 * LEAVE
 *   close both peer connections, stop every media track, remove every audio
 *   element from the DOM, POST /voice/leave.
 *
 * HONESTY RULES
 * -------------
 * - If the server has no SFU credentials, `join()` fails with the server's own
 *   reason. It never pretends to be connected.
 * - The local microphone track is NEVER attached to an <audio> element. Only
 *   remote tracks are, which is what stops the local user hearing themselves.
 * - Every teardown path (leave, unmount, failed join, failed reconnect) closes
 *   the peer connections and stops the tracks. A leaked microphone indicator
 *   is a bug, not a cosmetic issue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import type { VoiceParticipant } from '../shared/roomProtocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'unavailable';

export interface UseRoomVoice {
  status: VoiceStatus;
  error: string | null;
  /** True while the local microphone is published to the SFU. */
  inVoice: boolean;
  muted: boolean;
  speaking: boolean;
  participants: VoiceParticipant[];
  /** Whether the room allows voice at all. */
  enabled: boolean;
  /** True when the server has no SFU credentials configured. */
  available: boolean;
  unavailableReason: string | null;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => Promise<void>;
}

export interface UseRoomVoiceOptions {
  roomId: string | null;
  /** Display name published to the room's voice roster. */
  displayName: string;
  /** Whether the viewer is a room member. Mirrors the server's own rule. */
  canUseVoice: boolean;
  /**
   * Optional upward channel for the local speaking flag. The hook never waits
   * on it and never lets a throwing callback break voice.
   */
  onSpeakingChange?: (speaking: boolean) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** How often the roster is refreshed while the user is in voice. */
const ROSTER_POLL_MS = 5_000;

/** How often the microphone level is sampled for the speaking indicator. */
const SPEAKING_POLL_MS = 120;

/** RMS above this counts as speech. */
const SPEAKING_ON_RMS = 0.035;

/** RMS below this clears the speaking flag (hysteresis, so it does not flicker). */
const SPEAKING_OFF_RMS = 0.018;

/** The number of consecutive silent samples required to clear speaking. */
const SPEAKING_OFF_SAMPLES = 3;

/** ICE gathering is awaited, but never for longer than this. */
const ICE_GATHERING_TIMEOUT_MS = 2_500;

/** One bounded reconnect attempt. Never a loop. */
const MAX_RECONNECTS = 1;

// ---------------------------------------------------------------------------
// Server response shapes
// ---------------------------------------------------------------------------

interface RealtimeStatusResponse {
  voice?: { configured?: boolean; reason?: string | null };
}

interface RosterResponse {
  enabled?: boolean;
  participants?: VoiceParticipant[];
  configured?: boolean;
  reason?: string | null;
}

interface PublishResponse {
  sessionId: string;
  answer: { type: 'offer' | 'answer'; sdp: string };
}

interface SubscribeResponse {
  sessionId: string;
  offer: { type: 'offer' | 'answer'; sdp: string } | null;
  tracks: { mid?: string; sessionId?: string; trackName?: string }[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class VoiceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'VoiceApiError';
  }
}

/**
 * Turns a raw API failure into a sentence a trader can act on.
 *
 * The server already writes user-facing text for most cases; the mapping
 * below only covers the cases where the server could not have known what the
 * browser was trying to do.
 */
function describeApiError(error: unknown): string {
  if (error instanceof VoiceApiError) {
    switch (error.code) {
      case 'ROOM_NOT_JOINED':
        return 'Join the room to use its voice session.';
      case 'ROOM_VOICE_DISABLED':
        return 'Voice is disabled in this room.';
      case 'ROOM_VOICE_NOT_JOINED':
        return 'You are not in the voice session.';
      case 'ROOM_NOT_FOUND':
        return 'That room no longer exists.';
      case 'UNAUTHENTICATED':
        return 'Your session expired. Sign in again to use voice.';
      case 'AUTH_NOT_CONFIGURED':
        return 'This server cannot verify sign-ins, so voice is unavailable.';
      default:
        break;
    }
    if (error.status === 503) return 'Voice is not configured on this server.';
    if (error.status === 0) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Voice failed for an unknown reason.';
}

/** True when the page is not served over a secure context. */
function isInsecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext === false) return true;
  if (location.protocol !== 'http:') return false;
  return location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
}

/**
 * Describes a microphone failure precisely.
 *
 * The browser collapses "the user clicked Block" and "the user dismissed the
 * prompt" into the same `NotAllowedError`, so the permission state is read
 * back to tell the two apart: a denied permission stays denied, a dismissed
 * prompt leaves the permission in its initial state.
 */
async function describeMicrophoneError(error: unknown): Promise<string> {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError': {
      if (isInsecureContext()) {
        return 'Microphone access needs a secure connection. Open this page over HTTPS (or localhost) and try again.';
      }
      const state = await queryMicrophonePermission();
      if (state === 'denied') {
        return 'Microphone access is blocked for this site. Allow the microphone in your browser’s site settings, then try again.';
      }
      if (state === 'granted') {
        return 'The browser refused the microphone even though it is allowed. Close other apps that are using it and try again.';
      }
      return 'Microphone permission was dismissed. Allow the microphone and try again.';
    }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect a microphone and try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your microphone is busy in another application. Close it and try again.';
    case 'OverconstrainedError':
      return 'Your microphone could not provide usable audio.';
    case 'AbortError':
      return 'Microphone capture was interrupted. Try again.';
    case 'TypeError':
      return 'This browser does not support microphone capture.';
    default:
      return error instanceof Error && error.message
        ? `The microphone could not be opened: ${error.message}`
        : 'The microphone could not be opened.';
  }
}

async function queryMicrophonePermission(): Promise<PermissionState | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Waits until ICE gathering completes so the SDP handed to the server
 * contains the candidates. Bounded: a stalled network must not hang the join.
 */
function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs: number = ICE_GATHERING_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Root-mean-square of a time-domain buffer, in the 0..1 range. */
function readRms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const sample = (buffer[index] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(buffer.length, 1));
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useRoomVoice(options: UseRoomVoiceOptions): UseRoomVoice {
  const { roomId, displayName, canUseVoice, onSpeakingChange } = options;
  const { currentUser, getApiAuthHeaders } = useAuth();

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [inVoice, setInVoice] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [roster, setRoster] = useState<VoiceParticipant[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [available, setAvailable] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [remoteSpeaking, setRemoteSpeaking] = useState<Record<string, boolean>>({});

  // ---- refs that must survive re-renders without retriggering effects ----
  const roomIdRef = useRef<string | null>(roomId);
  const displayNameRef = useRef<string>(displayName);
  const canUseVoiceRef = useRef<boolean>(canUseVoice);
  const onSpeakingChangeRef = useRef<((speaking: boolean) => void) | undefined>(onSpeakingChange);
  const currentUidRef = useRef<string | null>(currentUser?.uid ?? null);

  const streamRef = useRef<MediaStream | null>(null);
  const publishPcRef = useRef<RTCPeerConnection | null>(null);
  const subscribePcRef = useRef<RTCPeerConnection | null>(null);
  const publishSessionRef = useRef<string | null>(null);
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteTrackMetaRef = useRef<Map<string, { sessionId?: string; trackName?: string }>>(new Map());
  const subscribedSessionsRef = useRef<string[]>([]);
  const resubscribeCooldownRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const localBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const remoteAnalysersRef = useRef<
    Map<string, { analyser: AnalyserNode; buffer: Uint8Array<ArrayBuffer> }>
  >(new Map());
  const remoteSpeakingRef = useRef<Record<string, boolean>>({});
  const speakingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentSamplesRef = useRef(0);
  const localSpeakingRef = useRef(false);
  const mutedRef = useRef(false);
  const generationRef = useRef(0);
  const reconnectCountRef = useRef(0);
  const reconnectingRef = useRef(false);
  const joinedRef = useRef(false);
  const mountedRef = useRef(true);
  const statusRef = useRef<VoiceStatus>('idle');

  roomIdRef.current = roomId;
  displayNameRef.current = displayName;
  canUseVoiceRef.current = canUseVoice;
  onSpeakingChangeRef.current = onSpeakingChange;
  currentUidRef.current = currentUser?.uid ?? null;
  statusRef.current = status;

  // ---- HTTP -------------------------------------------------------------

  /**
   * One HTTP helper for every voice call.
   *
   * `auth: 'optional'` is used only for the public capability endpoint, which
   * the server exposes without authentication; sending a token there is
   * harmless but must not be a hard requirement.
   */
  const requestJson = useCallback(
    async <T,>(
      path: string,
      init: { method?: string; body?: unknown; auth?: 'required' | 'optional' } = {},
    ): Promise<T> => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';

      if (init.auth === 'optional') {
        try {
          Object.assign(headers, await getApiAuthHeaders());
        } catch {
          /* A public endpoint does not need a token. */
        }
      } else {
        Object.assign(headers, await getApiAuthHeaders());
      }

      let response: Response;
      try {
        response = await fetch(path, {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } catch {
        throw new VoiceApiError('Could not reach the server.', 0);
      }

      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }

      if (!response.ok) {
        const body = (payload ?? {}) as { error?: { code?: string; message?: string } };
        throw new VoiceApiError(
          body.error?.message ?? `The server refused the request (${response.status}).`,
          response.status,
          body.error?.code,
        );
      }
      return payload as T;
    },
    [getApiAuthHeaders],
  );

  const voicePath = useCallback(
    (room: string, suffix = ''): string => `/api/rooms/${encodeURIComponent(room)}/voice${suffix}`,
    [],
  );

  // ---- local media ------------------------------------------------------

  const ensureAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new Ctor();
      }
      const context = audioContextRef.current;
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      return context;
    } catch {
      return null;
    }
  }, []);

  const stopSpeakingLoop = useCallback(() => {
    if (speakingTimerRef.current !== null) {
      clearInterval(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
  }, []);

  const applyLocalSpeaking = useCallback((next: boolean) => {
    if (localSpeakingRef.current === next) return;
    localSpeakingRef.current = next;
    if (!mountedRef.current) return;
    setSpeaking(next);
    const callback = onSpeakingChangeRef.current;
    if (!callback) return;
    try {
      callback(next);
    } catch {
      /* An upward listener must never break voice. */
    }
  }, []);

  /**
   * Samples the microphone and every remote track.
   *
   * The analyser is deliberately NOT connected to the destination: routing it
   * to the speakers would echo the local microphone back at the user.
   */
  const startSpeakingLoop = useCallback(() => {
    stopSpeakingLoop();
    silentSamplesRef.current = 0;
    speakingTimerRef.current = setInterval(() => {
      // Local microphone.
      const localAnalyser = localAnalyserRef.current;
      if (localAnalyser && localBufferRef.current) {
        const rms = readRms(localAnalyser, localBufferRef.current);
        if (rms >= SPEAKING_ON_RMS) {
          silentSamplesRef.current = 0;
          applyLocalSpeaking(true);
        } else if (rms <= SPEAKING_OFF_RMS) {
          silentSamplesRef.current += 1;
          if (silentSamplesRef.current >= SPEAKING_OFF_SAMPLES) applyLocalSpeaking(false);
        }
      }

      // Remote microphones.
      const previous = remoteSpeakingRef.current;
      const next: Record<string, boolean> = {};
      let changed = Object.keys(previous).length !== 0;
      for (const [sessionId, entry] of remoteAnalysersRef.current) {
        const rms = readRms(entry.analyser, entry.buffer);
        next[sessionId] = rms >= SPEAKING_ON_RMS;
        if (next[sessionId] !== Boolean(previous[sessionId])) changed = true;
      }
      remoteSpeakingRef.current = next;
      if (changed && mountedRef.current) setRemoteSpeaking(next);
    }, SPEAKING_POLL_MS);
  }, [applyLocalSpeaking, stopSpeakingLoop]);

  const attachLocalAnalyser = useCallback(
    (stream: MediaStream) => {
      const context = ensureAudioContext();
      if (!context) return;
      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        localAnalyserRef.current = analyser;
        localBufferRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      } catch {
        localAnalyserRef.current = null;
        localBufferRef.current = null;
      }
    },
    [ensureAudioContext],
  );

  const attachRemoteAnalyser = useCallback(
    (sessionId: string, track: MediaStreamTrack) => {
      const context = ensureAudioContext();
      if (!context) return;
      try {
        const source = context.createMediaStreamSource(new MediaStream([track]));
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        remoteAnalysersRef.current.set(sessionId, {
          analyser,
          buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        });
      } catch {
        /* Speaking detection for this participant degrades to the roster flag. */
      }
    },
    [ensureAudioContext],
  );

  // ---- teardown ---------------------------------------------------------

  const removeAudioElements = useCallback(() => {
    audioElementsRef.current.forEach((element) => {
      try {
        element.pause();
        element.srcObject = null;
        element.remove();
      } catch {
        /* The element is going away regardless. */
      }
    });
    audioElementsRef.current.clear();
  }, []);

  const closeSubscriber = useCallback(() => {
    removeAudioElements();
    remoteAnalysersRef.current.clear();
    remoteTrackMetaRef.current.clear();
    subscribedSessionsRef.current = [];

    const subscribe = subscribePcRef.current;
    subscribePcRef.current = null;
    if (subscribe) {
      try {
        subscribe.close();
      } catch {
        /* Already closed. */
      }
    }
  }, [removeAudioElements]);

  const closePublisher = useCallback(() => {
    const publish = publishPcRef.current;
    publishPcRef.current = null;
    if (publish) {
      try {
        publish.close();
      } catch {
        /* Already closed. */
      }
    }
  }, []);

  const closePeerConnections = useCallback(() => {
    closePublisher();
    closeSubscriber();
  }, [closePublisher, closeSubscriber]);

  const stopCapture = useCallback(() => {
    stopSpeakingLoop();
    if (disconnectTimerRef.current !== null) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    localAnalyserRef.current = null;
    localBufferRef.current = null;
    applyLocalSpeaking(false);

    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* Already stopped. */
        }
      });
    }

    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
  }, [applyLocalSpeaking, stopSpeakingLoop]);

  const teardown = useCallback(() => {
    closePeerConnections();
    stopCapture();
    publishSessionRef.current = null;
  }, [closePeerConnections, stopCapture]);

  // ---- remote tracks ----------------------------------------------------

  const handleRemoteTrack = useCallback(
    (event: RTCTrackEvent) => {
      const track = event.track;
      if (!track) return;

      const mid = event.transceiver?.mid ?? '';
      const meta = remoteTrackMetaRef.current.get(mid);
      const sessionId = meta?.sessionId ?? (mid ? `mid:${mid}` : 'unknown');

      let element = audioElementsRef.current.get(sessionId);
      if (!element) {
        element = document.createElement('audio');
        element.autoplay = true;
        element.setAttribute('playsinline', 'true');
        element.setAttribute('aria-hidden', 'true');
        element.style.display = 'none';
        element.dataset.voiceSession = sessionId;
        document.body.appendChild(element);
        audioElementsRef.current.set(sessionId, element);
      }

      element.srcObject = new MediaStream([track]);
      void element.play().catch(() => {
        /* Autoplay refused: the join gesture normally prevents this. */
      });

      attachRemoteAnalyser(sessionId, track);
    },
    [attachRemoteAnalyser],
  );

  // ---- peer connection health ------------------------------------------

  /**
   * Held in a ref so the peer connections can report failures without the
   * publish/subscribe helpers having to depend on the reconnect logic (which
   * depends on them in turn).
   */
  const peerFailureRef = useRef<(which: 'publish' | 'subscribe', pc: RTCPeerConnection) => void>(
    () => undefined,
  );

  /**
   * How long a connection may stay `disconnected` before it counts as failed.
   * A peer connection often reports a brief disconnect and recovers; tearing
   * the session down on the first blip would be worse than waiting.
   */
  const disconnectGraceMs = 8_000;

  const watchPeerConnection = useCallback(
    (which: 'publish' | 'subscribe', pc: RTCPeerConnection) => {
      pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          if (disconnectTimerRef.current !== null) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          if (mountedRef.current && statusRef.current === 'reconnecting') {
            setStatus('connected');
          }
          return;
        }
        if (state === 'disconnected') {
          if (disconnectTimerRef.current !== null) return;
          disconnectTimerRef.current = setTimeout(() => {
            disconnectTimerRef.current = null;
            peerFailureRef.current(which, pc);
          }, disconnectGraceMs);
          return;
        }
        if (state === 'failed' || state === 'closed') {
          peerFailureRef.current(which, pc);
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed') peerFailureRef.current(which, pc);
      });
    },
    [],
  );

  // ---- publish / subscribe ---------------------------------------------

  const publishMicrophone = useCallback(
    async (stream: MediaStream, generation: number): Promise<void> => {
      const room = roomIdRef.current;
      if (!room) throw new VoiceApiError('No room is selected.', 0);

      const track = stream.getAudioTracks()[0];
      if (!track) {
        throw new VoiceApiError('The microphone did not provide an audio track.', 0);
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      watchPeerConnection('publish', pc);
      // A stale attempt must not leave a peer connection behind.
      if (generationRef.current !== generation) {
        pc.close();
        return;
      }
      const previousPublish = publishPcRef.current;
      publishPcRef.current = pc;
      if (previousPublish && previousPublish !== pc) {
        try {
          previousPublish.close();
        } catch {
          /* Already closed. */
        }
      }

      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (generationRef.current !== generation) return;

      const mid =
        transceiver.mid ?? pc.getTransceivers().find((item) => item.sender.track === track)?.mid;
      if (!mid) {
        throw new VoiceApiError('The browser did not identify a microphone track to publish.', 0);
      }

      const published = await requestJson<PublishResponse>(voicePath(room, '/publish'), {
        method: 'POST',
        body: {
          sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
          mid,
          name: displayNameRef.current,
        },
      });

      if (generationRef.current !== generation) return;

      await pc.setRemoteDescription(published.answer);
      publishSessionRef.current = published.sessionId;
      joinedRef.current = true;
    },
    [requestJson, voicePath, watchPeerConnection],
  );

  const subscribeToRoster = useCallback(
    async (generation: number): Promise<void> => {
      const room = roomIdRef.current;
      if (!room) throw new VoiceApiError('No room is selected.', 0);

      const subscription = await requestJson<SubscribeResponse>(voicePath(room, '/subscribe'), {
        method: 'POST',
      });
      if (generationRef.current !== generation) return;

      const tracks = subscription.tracks ?? [];
      remoteTrackMetaRef.current.clear();
      tracks.forEach((track) => {
        if (track.mid) {
          remoteTrackMetaRef.current.set(track.mid, {
            sessionId: track.sessionId,
            trackName: track.trackName,
          });
        }
      });

      if (!subscription.offer) {
        // Nobody else is publishing yet. There is nothing to negotiate; the
        // roster poll re-subscribes as soon as somebody appears.
        subscribedSessionsRef.current = [];
        return;
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      watchPeerConnection('subscribe', pc);
      if (generationRef.current !== generation) {
        pc.close();
        return;
      }
      const previousSubscribe = subscribePcRef.current;
      subscribePcRef.current = pc;
      if (previousSubscribe && previousSubscribe !== pc) {
        try {
          previousSubscribe.close();
        } catch {
          /* Already closed. */
        }
      }
      pc.addEventListener('track', handleRemoteTrack);

      await pc.setRemoteDescription(subscription.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      if (generationRef.current !== generation) return;

      await requestJson(voicePath(room, '/answer'), {
        method: 'POST',
        body: {
          sessionId: subscription.sessionId,
          sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
        },
      });

      subscribedSessionsRef.current = tracks
        .map((track) => track.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId));
    },
    [handleRemoteTrack, requestJson, voicePath, watchPeerConnection],
  );

  // ---- the join sequence -------------------------------------------------

  const runJoin = useCallback(
    async (options: { reuseStream?: boolean } = {}): Promise<void> => {
      const room = roomIdRef.current;
      if (!room) {
        setStatus('error');
        setError('No room is selected.');
        return;
      }
      if (!canUseVoiceRef.current) {
        setStatus('error');
        setError('Join the room to use its voice session.');
        return;
      }

      const generation = ++generationRef.current;
      const isCurrent = () => generationRef.current === generation;

      setStatus(options.reuseStream ? 'reconnecting' : 'connecting');
      setError(null);

      // 1. Is voice configured on the server at all?
      try {
        const capability = await requestJson<RealtimeStatusResponse>('/api/realtime/status', {
          auth: 'optional',
        });
        if (!isCurrent()) return;
        const configured = Boolean(capability?.voice?.configured);
        setAvailable(configured);
        setUnavailableReason(capability?.voice?.reason ?? null);
        if (!configured) {
          setStatus('unavailable');
          setError(
            capability?.voice?.reason ??
              'Voice is not configured on this server. An operator has to set the SFU credentials.',
          );
          return;
        }
      } catch {
        if (!isCurrent()) return;
        // The capability endpoint is a convenience. If it cannot be reached the
        // publish call below produces the real, specific error.
        setAvailable(true);
        setUnavailableReason(null);
      }

      // 2. The microphone.
      let stream = options.reuseStream ? streamRef.current : null;
      if (!stream || !stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          setStatus('error');
          setError(
            isInsecureContext()
              ? 'Microphone access needs a secure connection. Open this page over HTTPS (or localhost) and try again.'
              : 'This browser does not support microphone capture.',
          );
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (error) {
          if (!isCurrent()) return;
          setStatus('error');
          setError(await describeMicrophoneError(error));
          return;
        }
      }

      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      // Any previous peer connections are closed before new ones are made.
      // On a reconnect this releases the failed session; on a first join it
      // is a no-op. The microphone stream itself is kept.
      closePeerConnections();

      // 3. Publish, then 4. subscribe.
      try {
        await publishMicrophone(stream, generation);
        if (!isCurrent()) return;
        await subscribeToRoster(generation);
        if (!isCurrent()) return;
      } catch (error) {
        if (!isCurrent()) return;
        teardown();
        setInVoice(false);
        setStatus('error');
        setError(describeApiError(error));
        // The publish call may already have written the roster entry.
        void requestJson(voicePath(room, '/leave'), { method: 'POST' }).catch(() => undefined);
        return;
      }

      // 5. The published track follows the mute state, and the local speaking
      //    detector starts.
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !mutedRef.current;
      });
      attachLocalAnalyser(stream);
      startSpeakingLoop();
      if (!mountedRef.current) return;
      setInVoice(true);
      setStatus('connected');
      setError(null);
    },
    [
      attachLocalAnalyser,
      closePeerConnections,
      publishMicrophone,
      requestJson,
      startSpeakingLoop,
      subscribeToRoster,
      teardown,
      voicePath,
    ],
  );

  /**
   * A single bounded reconnect. The peer connection failed; the microphone is
   * kept (no second permission prompt) and the publish/subscribe handshake is
   * repeated exactly once. A second failure is a real error, not a retry loop.
   */
  const attemptReconnect = useCallback(() => {
    // A connection can report several failures in a row (a state change and
    // an ICE failure, for example). Only the first one starts a reconnect.
    if (reconnectingRef.current) return;
    if (reconnectCountRef.current >= MAX_RECONNECTS) {
      teardown();
      setInVoice(false);
      setStatus('error');
      setError('The voice connection dropped and could not be restored. Leave voice and join again.');
      return;
    }
    reconnectCountRef.current += 1;
    reconnectingRef.current = true;
    if (!mountedRef.current) return;
    setStatus('reconnecting');
    void runJoin({ reuseStream: true }).finally(() => {
      reconnectingRef.current = false;
    });
  }, [runJoin, teardown]);

  const handlePeerFailure = useCallback(
    (which: 'publish' | 'subscribe', pc: RTCPeerConnection) => {
      const expected = which === 'publish' ? publishPcRef.current : subscribePcRef.current;
      if (expected !== pc) return; // A stale connection from an earlier attempt.
      if (!joinedRef.current) return;
      attemptReconnect();
    },
    [attemptReconnect],
  );

  peerFailureRef.current = handlePeerFailure;

  // ---- the roster ---------------------------------------------------------

  const refreshRoster = useCallback(
    async (room: string): Promise<VoiceParticipant[] | null> => {
      const response = await requestJson<RosterResponse>(voicePath(room));
      const participants = response?.participants ?? [];
      if (mountedRef.current) {
        setRoster(participants);
        if (typeof response?.enabled === 'boolean') setEnabled(response.enabled);
        if (typeof response?.configured === 'boolean') {
          setAvailable(response.configured);
          setUnavailableReason(response.reason ?? null);
        }
      }
      return participants;
    },
    [requestJson, voicePath],
  );

  /**
   * Re-subscribes when a NEW publisher appears.
   *
   * The server creates one receiving session per subscribe call, so hearing a
   * newcomer means negotiating again. Leaving participants need no action: the
   * SFU ends their track by itself.
   */
  const resubscribeForNewPublishers = useCallback(
    async (participants: VoiceParticipant[]): Promise<void> => {
      const room = roomIdRef.current;
      if (!room) return;
      const mySession = publishSessionRef.current;
      const remoteSessions = participants
        .filter((participant) => participant.sessionId && participant.sessionId !== mySession)
        .map((participant) => participant.sessionId as string);
      const known = new Set(subscribedSessionsRef.current);
      const missing = remoteSessions.filter((sessionId) => !known.has(sessionId));
      if (missing.length === 0) return;
      // A failed negotiation must not become a negotiation every five seconds.
      if (Date.now() < resubscribeCooldownRef.current) return;

      const generation = generationRef.current;
      // Only the RECEIVING side is rebuilt. The publish connection carries the
      // local microphone and must stay alive.
      closeSubscriber();
      try {
        await subscribeToRoster(generation);
        if (subscribedSessionsRef.current.length === 0 && remoteSessions.length > 0) {
          resubscribeCooldownRef.current = Date.now() + 15_000;
        }
      } catch {
        resubscribeCooldownRef.current = Date.now() + 15_000;
        /* The next poll tries again. */
      }
    },
    [closeSubscriber, subscribeToRoster],
  );

  // ---- effects -----------------------------------------------------------

  // Capability check on mount, and whenever the room changes.
  useEffect(() => {
    let cancelled = false;
    void requestJson<RealtimeStatusResponse>('/api/realtime/status', { auth: 'optional' })
      .then((capability) => {
        if (cancelled || !mountedRef.current) return;
        const configured = Boolean(capability?.voice?.configured);
        setAvailable(configured);
        setUnavailableReason(capability?.voice?.reason ?? null);
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setAvailable(false);
        setUnavailableReason(
          'Could not check whether voice is available on this server. Try again later.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [requestJson, roomId]);

  // One roster read when the room is opened, so the control knows whether the
  // room allows voice and who is already in it. A single request, not a poll.
  useEffect(() => {
    if (!roomId || !canUseVoice) return;
    let cancelled = false;
    void requestJson<RosterResponse>(voicePath(roomId))
      .then((response) => {
        if (cancelled || !mountedRef.current) return;
        setRoster(response?.participants ?? []);
        if (typeof response?.enabled === 'boolean') setEnabled(response.enabled);
        if (typeof response?.configured === 'boolean') {
          setAvailable(response.configured);
          setUnavailableReason(response.reason ?? null);
        }
      })
      .catch(() => {
        /* A viewer who is not a member gets 403 here; that is not an error. */
      });
    return () => {
      cancelled = true;
    };
  }, [canUseVoice, requestJson, roomId, voicePath]);

  // The roster poll runs ONLY while the user is in voice.
  useEffect(() => {
    if (!inVoice || !roomId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const participants = await refreshRoster(roomId);
        if (cancelled || !participants) return;
        await resubscribeForNewPublishers(participants);
      } catch {
        /* A transient failure must not end the session. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), ROSTER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [inVoice, refreshRoster, resubscribeForNewPublishers, roomId]);

  // Unmount: nothing may survive the component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      teardown();
      const room = roomIdRef.current;
      if (joinedRef.current && room) {
        joinedRef.current = false;
        void requestJson(voicePath(room, '/leave'), { method: 'POST' }).catch(() => undefined);
      }
    };
  }, [requestJson, teardown, voicePath]);

  // ---- public actions ----------------------------------------------------

  const join = useCallback(async () => {
    if (inVoice) return;
    reconnectCountRef.current = 0;
    reconnectingRef.current = false;
    await runJoin();
  }, [inVoice, runJoin]);

  const leave = useCallback(async () => {
    generationRef.current += 1;
    reconnectingRef.current = false;
    teardown();
    joinedRef.current = false;
    mutedRef.current = false;
    if (!mountedRef.current) return;
    setInVoice(false);
    setMuted(false);
    setStatus('idle');
    setError(null);
    remoteSpeakingRef.current = {};
    setRemoteSpeaking({});
    const room = roomIdRef.current;
    if (!room) return;
    try {
      await requestJson(voicePath(room, '/leave'), { method: 'POST' });
    } catch {
      /* The local session is already gone; the server cleans up on its own. */
    }
    try {
      await refreshRoster(room);
    } catch {
      /* The roster is refreshed again the next time the user joins. */
    }
  }, [refreshRoster, requestJson, teardown, voicePath]);

  const toggleMute = useCallback(async () => {
    const room = roomIdRef.current;
    if (!room || !inVoice) return;

    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    // The published track is actually disabled: muting is not a UI lie.
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });

    try {
      await requestJson(voicePath(room, '/mute'), {
        method: 'POST',
        body: { muted: next },
      });
    } catch (error) {
      // The server and the browser must agree. Roll the local state back.
      mutedRef.current = !next;
      setMuted(!next);
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = next;
      });
      setError(describeApiError(error));
    }
  }, [inVoice, requestJson, voicePath]);

  // ---- derived state -----------------------------------------------------

  const participants = useMemo<VoiceParticipant[]>(() => {
    const mySession = publishSessionRef.current;
    return roster.map((participant) => {
      const isLocal =
        (Boolean(mySession) && participant.sessionId === mySession) ||
        (Boolean(currentUidRef.current) && participant.uid === currentUidRef.current);
      if (isLocal) {
        return {
          ...participant,
          muted,
          speaking: localSpeakingRef.current,
        };
      }
      const detected = participant.sessionId
        ? Boolean(remoteSpeaking[participant.sessionId])
        : false;
      return {
        ...participant,
        speaking: Boolean(participant.speaking) || detected,
      };
    });
  }, [muted, remoteSpeaking, roster, speaking]);

  return useMemo(
    () => ({
      status,
      error,
      inVoice,
      muted,
      speaking,
      participants,
      enabled,
      available,
      unavailableReason,
      join,
      leave,
      toggleMute,
    }),
    [
      status,
      error,
      inVoice,
      muted,
      speaking,
      participants,
      enabled,
      available,
      unavailableReason,
      join,
      leave,
      toggleMute,
    ],
  );
}
