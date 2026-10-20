/**
 * USE SESSION RECORDER
 * ====================
 * Records a TradingVibes room session in the browser and hands the user a
 * file to download. Nothing is uploaded: the recording never leaves the tab.
 *
 * HOW A RECORDING HAPPENS
 * -----------------------
 * 1. The user presses "Record". That press is the user gesture, which is why
 *    `getDisplayMedia` may be called at all.
 * 2. The BROWSER shows its own share picker. The user picks a tab or a
 *    window and, if they want the room's audio, ticks "Share tab audio".
 *    The picker is the consent step; this hook cannot and does not fake it.
 * 3. The display stream's video track is recorded. Its audio track (the tab
 *    audio) is mixed together with the local microphone (only when the user
 *    asked for it) and every remote participant stream into ONE audio track
 *    through an `AudioContext`.
 * 4. `MediaRecorder` writes one chunk per second. The chunks are kept in an
 *    array and joined into a single `Blob` when the recording stops.
 * 5. The user downloads the file. The server never sees it.
 *
 * THE MIXING GRAPH
 * ----------------
 *      display audio track  ─┐
 *      local microphone      ─┼─> AudioContext ─> MediaStreamAudioDestinationNode ─> mixed track
 *      each remote stream    ─┘
 *
 * The sources are connected ONLY to the destination node. Nothing is ever
 * connected to `ctx.destination`, so the microphone can never echo back into
 * the speakers.
 *
 * HONESTY RULES
 * -------------
 * - The screen-capture indicator must disappear. The display track is always
 *   stopped on stop, cancel, error and unload.
 * - A track the application owns (a remote participant's stream) is NEVER
 *   stopped here. This hook stops only what it created.
 * - A failure that does not end the recording is reported as a warning, not
 *   as a silent success: a blocked microphone says so.
 *
 * NOTE ON THE PUBLIC SHAPE
 * ------------------------
 * The sketch of this hook asked for two members called `recording`: a
 * `boolean` ("true while a recording is running") and a `RecordingResult`
 * ("the finished recording"). TypeScript cannot hold two different members
 * under one name, so the running flag keeps the name `recording` and the
 * finished file is `recordingResult`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecorderStatus =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'stopping'
  | 'error'
  | 'unsupported';

export type RecorderError =
  | 'screen-permission-denied'
  | 'screen-capture-unsupported'
  | 'microphone-permission-denied'
  | 'no-audio-track'
  | 'no-supported-mime'
  | 'recording-failed'
  | 'insecure-context';

export interface RecordingResult {
  blob: Blob;
  /** e.g. "webm" or "mp4" */
  extension: string;
  mimeType: string;
  durationSeconds: number;
  /** A safe, ready-to-use file name WITHOUT an extension. */
  fileNameBase: string;
  /** True when the local microphone was included. */
  microphoneIncluded: boolean;
  /** True when remote participant audio was included. */
  remoteAudioIncluded: boolean;
  /** Warnings the user should be told about, e.g. "participant audio could not be captured". */
  warnings: string[];
}

export interface UseSessionRecorder {
  status: RecorderStatus;
  error: RecorderError | null;
  errorMessage: string | null;
  /** True while a recording is running. */
  recording: boolean;
  /** Elapsed seconds while recording. */
  elapsedSeconds: number;
  /** Approximate size in bytes of what has been captured so far. */
  bytes: number;
  /** True when the browser can record at all. */
  supported: boolean;
  /** Start recording. `includeMicrophone` adds the local mic to the mix. */
  start: (options?: { includeMicrophone?: boolean }) => Promise<boolean>;
  /** Stop recording and produce the final file. */
  stop: () => Promise<RecordingResult | null>;
  /** Discard the current recording without producing a file. */
  cancel: () => void;
  /** The finished recording, ready to download. */
  recordingResult: RecordingResult | null;
}

export interface UseSessionRecorderOptions {
  /** Remote participant audio streams (MediaStream[]) to mix into the recording. */
  remoteStreams?: MediaStream[];
  /** Display name used in the file name. */
  roomName?: string;
  /** Called when the recording starts/stops, so the room can show a "recording" badge. */
  onRecordingChange?: (recording: boolean) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The user-facing text for every failure mode.
 *
 * The wording is deliberately plain: a trader who cannot record needs to know
 * whether they cancelled, the browser blocked them, or the page is insecure.
 */
export const RECORDER_ERROR_MESSAGES: Record<RecorderError, string> = {
  'screen-permission-denied': 'Screen sharing was cancelled. Nothing was recorded.',
  'screen-capture-unsupported':
    'This browser cannot record the screen. Try Chrome or Edge over HTTPS.',
  'microphone-permission-denied':
    'The microphone was blocked, so the recording has no local voice.',
  'no-audio-track': 'No audio was available to record. The recording is silent.',
  'no-supported-mime': 'This browser cannot produce a video file MediaRecorder understands.',
  'recording-failed':
    'The recording ended unexpectedly. The part that was captured is still available to download.',
  'insecure-context': 'Recording needs a secure connection (HTTPS).',
};

/** Preferred container/codec combinations, best first. */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
];

/**
 * The same list without an audio codec.
 *
 * A recorder is stricter about a codec list than `isTypeSupported` is: asking
 * for `opus` on a stream that carries no audio can be refused outright. When
 * the recording is going to be silent, the video-only variants are probed.
 */
const MIME_CANDIDATES_WITHOUT_AUDIO = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

/** One chunk per second, so a long recording never builds one giant buffer. */
const CHUNK_TIMESLICE_MS = 1_000;

/** Three hours of one-second chunks. The recording stops here with a warning. */
const MAX_CHUNKS = 3 * 60 * 60;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** True when the page is not served from a secure context. */
function isInsecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext === false) return true;
  if (typeof location === 'undefined') return false;
  if (location.protocol !== 'http:') return false;
  return location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
}

/** True when the browser exposes everything the recorder needs. */
function detectSupport(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (typeof MediaRecorder === 'undefined') return false;
  if (!navigator.mediaDevices?.getDisplayMedia) return false;
  if (isInsecureContext()) return false;
  return true;
}

/**
 * The first supported container/codec pair, or null when the browser can
 * produce no video file at all.
 */
function pickMimeType(hasAudio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return null;
  const candidates = hasAudio ? MIME_CANDIDATES : MIME_CANDIDATES_WITHOUT_AUDIO;
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* A browser that throws here simply does not offer the type. */
    }
  }
  return null;
}

/** The file extension that matches a mime type. */
function extensionForMimeType(mimeType: string): string {
  if (mimeType.startsWith('video/mp4')) return 'mp4';
  if (mimeType.startsWith('video/webm')) return 'webm';
  const slash = mimeType.indexOf('/');
  const subtype = slash === -1 ? '' : mimeType.slice(slash + 1);
  return subtype.split(';')[0] || 'webm';
}

/** Lower-case, dash separated form of a room name. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'room';
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * `tradingvibes-<room-slug>-<YYYYMMDD-HHMMSS>`, reduced to `[A-Za-z0-9-_]`.
 *
 * The extension is deliberately NOT part of the base name: the caller appends
 * it, because the extension depends on the container the browser produced.
 */
export function buildRecordingFileNameBase(roomName?: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(
    now.getHours(),
  )}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `tradingvibes-${slugify(roomName ?? '')}-${stamp}`.replace(/[^A-Za-z0-9-_]/g, '');
}

/** The error a `getDisplayMedia` rejection should become. */
function describeDisplayMediaError(error: unknown): RecorderError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return isInsecureContext() ? 'insecure-context' : 'screen-permission-denied';
    case 'NotSupportedError':
    case 'TypeError':
    case 'NotFoundError':
    case 'AbortError':
      return 'screen-capture-unsupported';
    default:
      return 'recording-failed';
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useSessionRecorder(options: UseSessionRecorderOptions = {}): UseSessionRecorder {
  const { remoteStreams, roomName, onRecordingChange } = options;

  // ---- state --------------------------------------------------------------

  const [status, setStatus] = useState<RecorderStatus>(() =>
    detectSupport() ? 'idle' : 'unsupported',
  );
  const [error, setError] = useState<RecorderError | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [recordingResult, setRecordingResult] = useState<RecordingResult | null>(null);

  // ---- refs ---------------------------------------------------------------

  const mountedRef = useRef(true);
  const statusRef = useRef<RecorderStatus>(status);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const sourceNodesRef = useRef<Set<AudioNode>>(new Set());
  const connectedTrackIdsRef = useRef<Set<string>>(new Set());
  /** Every remote track that was EVER mixed in, so a participant who leaves is not reported as missing. */
  const includedRemoteTrackIdsRef = useRef<Set<string>>(new Set());
  const remoteSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const remoteStreamListenersRef = useRef<Map<MediaStream, () => void>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);
  const mimeTypeRef = useRef<string>('video/webm');
  const totalBytesRef = useRef(0);
  const warningsRef = useRef<string[]>([]);
  const microphoneIncludedRef = useRef(false);
  const remoteAudioIncludedRef = useRef(false);
  const discardRef = useRef(false);
  const finalizedRef = useRef(false);
  const displayEndedRef = useRef(false);
  const pendingResolveRef = useRef<((result: RecordingResult | null) => void) | null>(null);
  const stopPromiseRef = useRef<Promise<RecordingResult | null> | null>(null);
  const finalizeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteStreamsRef = useRef<MediaStream[]>(remoteStreams ?? []);
  const onRecordingChangeRef = useRef<((recording: boolean) => void) | undefined>(onRecordingChange);
  const roomNameRef = useRef<string | undefined>(roomName);

  remoteStreamsRef.current = remoteStreams ?? [];
  onRecordingChangeRef.current = onRecordingChange;
  roomNameRef.current = roomName;
  statusRef.current = status;

  // ---- support ------------------------------------------------------------

  const supported = useMemo(() => detectSupport(), []);

  useEffect(() => {
    if (supported) return;
    const code: RecorderError = isInsecureContext()
      ? 'insecure-context'
      : 'screen-capture-unsupported';
    setStatus('unsupported');
    setError(code);
    setErrorMessage(RECORDER_ERROR_MESSAGES[code]);
  }, [supported]);

  // ---- helpers ------------------------------------------------------------

  const notifyRecordingChange = useCallback((next: boolean) => {
    const callback = onRecordingChangeRef.current;
    if (!callback) return;
    try {
      callback(next);
    } catch {
      /* An upward listener must never break the recording. */
    }
  }, []);

  const failWith = useCallback((code: RecorderError) => {
    const nextStatus: RecorderStatus =
      code === 'screen-capture-unsupported' || code === 'insecure-context' ? 'unsupported' : 'error';
    statusRef.current = nextStatus;
    if (!mountedRef.current) return;
    setStatus(nextStatus);
    setError(code);
    setErrorMessage(RECORDER_ERROR_MESSAGES[code]);
  }, []);

  const addWarning = useCallback((message: string) => {
    if (warningsRef.current.includes(message)) return;
    warningsRef.current.push(message);
  }, []);

  /**
   * Releases everything this hook created.
   *
   * The display stream and the microphone belong to the recorder, so their
   * tracks are stopped — that is what makes the browser's "you are sharing"
   * indicator disappear. The remote participant streams belong to the room,
   * so their tracks are left running; only the graph nodes this hook built
   * are disconnected.
   */
  const releaseMedia = useCallback(() => {
    const display = displayStreamRef.current;
    displayStreamRef.current = null;
    if (display) {
      display.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* Already stopped. */
        }
      });
    }

    const mic = micStreamRef.current;
    micStreamRef.current = null;
    if (mic) {
      mic.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* Already stopped. */
        }
      });
    }

    remoteSourcesRef.current.forEach((source) => {
      try {
        source.disconnect();
      } catch {
        /* Already disconnected. */
      }
    });
    remoteSourcesRef.current.clear();

    sourceNodesRef.current.forEach((node) => {
      try {
        node.disconnect();
      } catch {
        /* Already disconnected. */
      }
    });
    sourceNodesRef.current.clear();
    connectedTrackIdsRef.current.clear();
    includedRemoteTrackIdsRef.current.clear();

    const context = audioContextRef.current;
    audioContextRef.current = null;
    audioDestinationRef.current = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Builds the finished file from the collected chunks.
   *
   * `finalizedRef` makes this safe to call from several directions at once:
   * the recorder's `stop` event, the display track's `ended` event and the
   * explicit `stop()` call can all fire for the same recording.
   */
  const finalize = useCallback(
    (failure: RecorderError | null = null) => {
      if (finalizedRef.current) return;
      finalizedRef.current = true;

      stopTimer();
      if (finalizeWatchdogRef.current !== null) {
        clearTimeout(finalizeWatchdogRef.current);
        finalizeWatchdogRef.current = null;
      }
      recorderRef.current = null;

      const chunks = chunksRef.current;
      chunksRef.current = [];

      const displayVideoTrack = displayStreamRef.current?.getVideoTracks()[0] ?? null;
      if (displayEndedRef.current || displayVideoTrack?.readyState === 'ended') {
        addWarning('Screen sharing was stopped, so the recording was closed and saved.');
      }

      // A participant whose audio never made it into the mix is reported by
      // name and count, not silently dropped.
      let skippedParticipants = 0;
      for (const stream of remoteStreamsRef.current) {
        const tracks = stream.getAudioTracks();
        if (tracks.length === 0) {
          skippedParticipants += 1;
          continue;
        }
        const included = tracks.some((track) => includedRemoteTrackIdsRef.current.has(track.id));
        if (!included) skippedParticipants += 1;
      }
      if (skippedParticipants === 1) {
        addWarning("One participant's audio could not be included.");
      } else if (skippedParticipants > 1) {
        addWarning(`${skippedParticipants} participants' audio could not be included.`);
      }

      const totalBytes = totalBytesRef.current;
      totalBytesRef.current = 0;
      const discard = discardRef.current;
      discardRef.current = false;

      const durationSeconds =
        startedAtRef.current > 0
          ? Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000))
          : Math.max(0, Math.round(elapsedRef.current));
      elapsedRef.current = durationSeconds;

      let result: RecordingResult | null = null;
      if (!discard && chunks.length > 0) {
        const mimeType = mimeTypeRef.current;
        result = {
          blob: new Blob(chunks, { type: mimeType }),
          extension: extensionForMimeType(mimeType),
          mimeType,
          durationSeconds,
          fileNameBase: buildRecordingFileNameBase(roomNameRef.current),
          microphoneIncluded: microphoneIncludedRef.current,
          remoteAudioIncluded: remoteAudioIncludedRef.current,
          warnings: [...warningsRef.current],
        };
      }

      releaseMedia();
      microphoneIncludedRef.current = false;
      remoteAudioIncludedRef.current = false;

      const resolve = pendingResolveRef.current;
      pendingResolveRef.current = null;
      stopPromiseRef.current = null;

      if (mountedRef.current) {
        setBytes(totalBytes);
        setElapsedSeconds(elapsedRef.current);
        setRecordingResult(result);
        if (failure) {
          setStatus('error');
          setError(failure);
          setErrorMessage(RECORDER_ERROR_MESSAGES[failure]);
        } else {
          setStatus('idle');
          setError(null);
          setErrorMessage(null);
        }
      }

      notifyRecordingChange(false);

      if (resolve) resolve(result);
    },
    [addWarning, notifyRecordingChange, releaseMedia, stopTimer],
  );

  /**
   * Connects one audio track to the recording's destination node.
   *
   * The source is NEVER connected to `ctx.destination`, which is what keeps the
   * local microphone from echoing back through the speakers.
   */
  const connectTrack = useCallback(
    (
      track: MediaStreamTrack | undefined,
      kind: 'display' | 'microphone' | 'remote',
    ): MediaStreamAudioSourceNode | null => {
      const context = audioContextRef.current;
      const destination = audioDestinationRef.current;
      if (!context || !destination) return null;
      if (!track || track.readyState === 'ended') return null;
      if (connectedTrackIdsRef.current.has(track.id)) return null;
      try {
        const source = context.createMediaStreamSource(new MediaStream([track]));
        source.connect(destination);
        sourceNodesRef.current.add(source);
        connectedTrackIdsRef.current.add(track.id);
        if (kind === 'remote') {
          remoteSourcesRef.current.set(track.id, source);
          includedRemoteTrackIdsRef.current.add(track.id);
        }
        return source;
      } catch {
        return null;
      }
    },
    [],
  );

  /**
   * Keeps the remote participant audio in sync with the room roster.
   *
   * Participants join and leave while a recording runs, so the mix is
   * refreshed whenever the stream list changes. Remote tracks are never
   * stopped: the room owns them.
   */
  const syncRemoteAudio = useCallback(() => {
    const context = audioContextRef.current;
    const destination = audioDestinationRef.current;
    if (!context || !destination) return;

    const wanted = new Set<string>();
    for (const stream of remoteStreamsRef.current) {
      for (const track of stream.getAudioTracks()) {
        wanted.add(track.id);
        if (connectedTrackIdsRef.current.has(track.id)) continue;
        if (!connectTrack(track, 'remote')) continue;
        remoteAudioIncludedRef.current = true;
      }
    }

    remoteSourcesRef.current.forEach((source, trackId) => {
      if (wanted.has(trackId)) return;
      try {
        source.disconnect();
      } catch {
        /* Already disconnected. */
      }
      remoteSourcesRef.current.delete(trackId);
      connectedTrackIdsRef.current.delete(trackId);
    });
  }, [connectTrack]);

  // Remote streams that appear while the recording runs are picked up here.
  useEffect(() => {
    syncRemoteAudio();
    for (const stream of remoteStreamsRef.current) {
      if (remoteStreamListenersRef.current.has(stream)) continue;
      const handler = () => syncRemoteAudio();
      remoteStreamListenersRef.current.set(stream, handler);
      stream.addEventListener('addtrack', handler);
      stream.addEventListener('removetrack', handler);
    }
  }, [remoteStreams, syncRemoteAudio]);

  // ---- the recording lifecycle -------------------------------------------

  const start = useCallback(
    async (startOptions: { includeMicrophone?: boolean } = {}): Promise<boolean> => {
      if (statusRef.current === 'requesting' || statusRef.current === 'recording') return false;
      if (!supported) {
        failWith(isInsecureContext() ? 'insecure-context' : 'screen-capture-unsupported');
        return false;
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
        failWith('screen-capture-unsupported');
        return false;
      }

      finalizedRef.current = false;
      discardRef.current = false;
      displayEndedRef.current = false;
      warningsRef.current = [];
      chunksRef.current = [];
      totalBytesRef.current = 0;
      microphoneIncludedRef.current = false;
      remoteAudioIncludedRef.current = false;
      elapsedRef.current = 0;
      startedAtRef.current = 0;

      if (mountedRef.current) {
        setStatus('requesting');
        setError(null);
        setErrorMessage(null);
        setElapsedSeconds(0);
        setBytes(0);
        setRecordingResult(null);
      }
      statusRef.current = 'requesting';

      // The audio graph is built BEFORE the picker opens, while the click
      // gesture is still alive, so the AudioContext is allowed to run.
      let context: AudioContext | null = null;
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) {
          context = new Ctor();
          audioContextRef.current = context;
          audioDestinationRef.current = context.createMediaStreamDestination();
        }
      } catch {
        context = null;
        audioContextRef.current = null;
        audioDestinationRef.current = null;
      }

      // 1. The browser's own share picker. The user's choice is the consent.
      let displayStream: MediaStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (pickerError) {
        releaseMedia();
        failWith(describeDisplayMediaError(pickerError));
        return false;
      }

      if (finalizedRef.current) {
        displayStream.getTracks().forEach((track) => track.stop());
        releaseMedia();
        return false;
      }

      displayStreamRef.current = displayStream;

      const videoTrack = displayStream.getVideoTracks()[0];
      if (!videoTrack) {
        releaseMedia();
        failWith('screen-capture-unsupported');
        return false;
      }

      // 2. The local microphone, only when the user asked for it.
      let micStream: MediaStream | null = null;
      if (startOptions.includeMicrophone) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micStreamRef.current = micStream;
        } catch {
          micStream = null;
          micStreamRef.current = null;
          // A blocked microphone degrades the recording, it does not end it.
          addWarning(RECORDER_ERROR_MESSAGES['microphone-permission-denied']);
          if (mountedRef.current) {
            setError('microphone-permission-denied');
            setErrorMessage(RECORDER_ERROR_MESSAGES['microphone-permission-denied']);
          }
        }
      }

      // 3. The audio mix.
      let audioSourceCount = 0;
      const displayAudioTrack = displayStream.getAudioTracks()[0];
      if (displayAudioTrack && connectTrack(displayAudioTrack, 'display')) audioSourceCount += 1;

      const micTrack = micStream?.getAudioTracks()[0];
      if (micTrack && connectTrack(micTrack, 'microphone')) {
        audioSourceCount += 1;
        microphoneIncludedRef.current = true;
      }

      for (const stream of remoteStreamsRef.current) {
        for (const track of stream.getAudioTracks()) {
          if (!connectTrack(track, 'remote')) continue;
          audioSourceCount += 1;
          remoteAudioIncludedRef.current = true;
        }
      }

      // Without an AudioContext there is no mix, so only the raw tab audio
      // (if any) can be recorded, and it is added to the stream directly.
      const hasMix = Boolean(audioDestinationRef.current);
      const mixedAudioTracks = audioDestinationRef.current?.stream.getAudioTracks() ?? [];
      let recordAudioTracks: MediaStreamTrack[] = mixedAudioTracks;
      if (!hasMix) {
        if (displayAudioTrack && displayAudioTrack.readyState === 'live') {
          recordAudioTracks = [displayAudioTrack];
          audioSourceCount = 1;
          addWarning(
            'Audio could not be mixed in this browser, so only the shared tab audio was captured.',
          );
        } else {
          audioSourceCount = 0;
        }
      }

      if (context && context.state === 'suspended') {
        try {
          await context.resume();
        } catch {
          /* A suspended context records silence; the warning says so. */
        }
        if (context.state === 'suspended') {
          addWarning('Audio could not be activated, so the recording may be silent.');
        }
      }

      if (audioSourceCount === 0) {
        addWarning(RECORDER_ERROR_MESSAGES['no-audio-track']);
        if (mountedRef.current) {
          setError('no-audio-track');
          setErrorMessage(RECORDER_ERROR_MESSAGES['no-audio-track']);
        }
      }

      // 4. The recorded stream: the screen plus the single mixed audio track.
      const recordStream = new MediaStream([videoTrack, ...recordAudioTracks]);
      const hasAudio = recordAudioTracks.length > 0;

      // 5. The container. It is probed, never hardcoded.
      const mimeType = pickMimeType(hasAudio);
      if (!mimeType) {
        releaseMedia();
        failWith('no-supported-mime');
        return false;
      }
      mimeTypeRef.current = mimeType;

      // 6. The recorder itself.
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(recordStream, { mimeType });
      } catch {
        releaseMedia();
        failWith('no-supported-mime');
        return false;
      }
      recorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        totalBytesRef.current += event.data.size;
        if (mountedRef.current) setBytes(totalBytesRef.current);

        if (chunksRef.current.length >= MAX_CHUNKS) {
          addWarning(
            'The recording reached the three-hour limit, so it was stopped and saved.',
          );
          try {
            if (recorder.state !== 'inactive') recorder.stop();
            else finalize();
          } catch {
            finalize();
          }
        }
      };

      recorder.onerror = () => {
        finalize('recording-failed');
      };

      recorder.onstop = () => {
        finalize();
      };

      // 7. The user stops sharing from the browser's own UI.
      const handleDisplayEnded = () => {
        displayEndedRef.current = true;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
            return;
          } catch {
            /* Fall through to the manual finalise. */
          }
        }
        finalize();
      };
      videoTrack.addEventListener('ended', handleDisplayEnded);

      try {
        recorder.start(CHUNK_TIMESLICE_MS);
      } catch {
        videoTrack.removeEventListener('ended', handleDisplayEnded);
        releaseMedia();
        failWith('recording-failed');
        return false;
      }

      startedAtRef.current = Date.now();
      elapsedRef.current = 0;
      stopTimer();
      timerRef.current = setInterval(() => {
        elapsedRef.current = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
        if (mountedRef.current) setElapsedSeconds(elapsedRef.current);
      }, 1_000);

      statusRef.current = 'recording';
      if (mountedRef.current) {
        setStatus('recording');
        setElapsedSeconds(0);
      }
      notifyRecordingChange(true);
      return true;
    },
    [addWarning, connectTrack, failWith, notifyRecordingChange, releaseMedia, stopTimer, supported],
  );

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    if (stopPromiseRef.current) return stopPromiseRef.current;

    statusRef.current = 'stopping';
    if (mountedRef.current) setStatus('stopping');

    const promise = new Promise<RecordingResult | null>((resolve) => {
      pendingResolveRef.current = resolve;
    });
    stopPromiseRef.current = promise;

    try {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        finalize();
      }
    } catch {
      finalize();
    }

    // A recorder that never reports `stop` must not strand the caller.
    if (finalizeWatchdogRef.current !== null) {
      clearTimeout(finalizeWatchdogRef.current);
    }
    finalizeWatchdogRef.current = setTimeout(() => finalize(), 5_000);

    return promise;
  }, [finalize]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) {
      // Nothing is running: this throws away a finished file the user has
      // not downloaded yet.
      if (mountedRef.current) {
        setRecordingResult(null);
        setBytes(0);
        setElapsedSeconds(0);
      }
      return;
    }
    discardRef.current = true;
    try {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        finalize();
      }
    } catch {
      finalize();
    }
    if (finalizeWatchdogRef.current !== null) {
      clearTimeout(finalizeWatchdogRef.current);
    }
    finalizeWatchdogRef.current = setTimeout(() => finalize(), 5_000);
  }, [finalize]);

  // ---- teardown -----------------------------------------------------------

  /**
   * The unload path.
   *
   * Nothing can be downloaded once the page is going away, but the screen
   * capture MUST stop: a leaked capture keeps the browser's sharing
   * indicator lit and the tab's microphone hot.
   */
  const teardownForUnload = useCallback(() => {
    const recorder = recorderRef.current;
    discardRef.current = true;
    if (recorder) {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* The page is going away anyway. */
      }
    }
    releaseMedia();
    stopTimer();
    notifyRecordingChange(false);
  }, [notifyRecordingChange, releaseMedia, stopTimer]);

  useEffect(() => {
    const onPageHide = () => teardownForUnload();
    const onBeforeUnload = () => teardownForUnload();
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [teardownForUnload]);

  // Unmount: nothing may survive the component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRef.current = true;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* Already stopped. */
        }
      }
      stopTimer();
      releaseMedia();
      remoteStreamListenersRef.current.forEach((handler, stream) => {
        stream.removeEventListener('addtrack', handler);
        stream.removeEventListener('removetrack', handler);
      });
      remoteStreamListenersRef.current.clear();
      const resolve = pendingResolveRef.current;
      pendingResolveRef.current = null;
      stopPromiseRef.current = null;
      if (resolve) resolve(null);
    };
  }, [releaseMedia, stopTimer]);

  // ---- the public shape ---------------------------------------------------

  return useMemo(
    () => ({
      status,
      error,
      errorMessage,
      recording: status === 'recording',
      elapsedSeconds,
      bytes,
      supported,
      start,
      stop,
      cancel,
      recordingResult,
    }),
    [status, error, errorMessage, elapsedSeconds, bytes, supported, start, stop, cancel, recordingResult],
  );
}
