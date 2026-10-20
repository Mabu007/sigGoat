/**
 * RECORDING CONTROLS
 * ==================
 * The recording surface of a TradingVibes room: start a recording, watch it
 * run, and download the file when it is done.
 *
 * WHAT THE USER IS TOLD, AND WHEN
 * -------------------------------
 * Pressing "Record" does NOT start a recording straight away: the browser
 * shows its own share picker and the user chooses a tab or a window. The
 * copy says so before the button is pressed, because a silent picker is the
 * most common complaint about screen recorders.
 *
 * NO UPLOAD
 * ---------
 * The finished file stays in the browser. The only way out of the tab is the
 * download button. Nothing is sent to the server.
 *
 * HONEST STATES
 * -------------
 * - A browser that cannot record says so instead of offering a button that
 *   does nothing.
 * - A blocked microphone, a missing tab audio or a participant that could
 *   not be mixed in are shown as warnings on the finished file. The control
 *   never claims a clean recording it does not have.
 * - Every error code has one specific sentence attached to it, so the user
 *   knows whether they cancelled, the browser blocked them, or the page is
 *   not secure.
 *
 * ACCESSIBILITY
 * -------------
 * Every icon button carries an `aria-label`, the microphone toggle carries
 * `aria-pressed`, the recording state is announced through a live region,
 * and no state is carried by colour alone: the recording dot is paired with
 * the word "Recording" and the timer.
 *
 * STYLING
 * -------
 * Tailwind utilities over the existing design tokens only. No new CSS.
 */

import { useEffect, useRef, useState } from 'react';
import { Circle, Download, Mic, MicOff, Square, Trash2, Video } from 'lucide-react';
import {
  RECORDER_ERROR_MESSAGES,
  type RecorderError,
  type RecordingResult,
  type UseSessionRecorder,
} from '../hooks/useSessionRecorder';

export interface RecordingControlsProps {
  recorder: UseSessionRecorder;
  /** True when the room's leader may record. */
  canRecord?: boolean;
  className?: string;
  onDownload?: (result: RecordingResult) => void;
}

/** `mm:ss`, or `h:mm:ss` once the recording passes the hour mark. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A short, human file size. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The one sentence that belongs to a failure code. */
function errorMessageFor(error: RecorderError | null, fallback: string | null): string | null {
  if (!error) return null;
  return RECORDER_ERROR_MESSAGES[error] ?? fallback ?? 'The recording failed.';
}

/**
 * The recording controls for a room.
 *
 * The hook is passed in, so a view that already owns `useSessionRecorder` can
 * render these controls without creating a second recorder.
 */
export default function RecordingControls({
  recorder,
  canRecord = true,
  className,
  onDownload,
}: RecordingControlsProps) {
  const [includeMicrophone, setIncludeMicrophone] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const previousRecordingRef = useRef(false);

  const result = recorder.recordingResult;
  const recording = recorder.recording;
  const requesting = recorder.status === 'requesting';
  const stopping = recorder.status === 'stopping';

  // A new recording means the previous "downloaded" flag is meaningless.
  useEffect(() => {
    setDownloaded(false);
  }, [result]);

  // Only the start and the stop are announced: the timer would otherwise be
  // read out once a second.
  useEffect(() => {
    if (recording === previousRecordingRef.current) return;
    previousRecordingRef.current = recording;
    setAnnouncement(recording ? 'Recording started.' : 'Recording stopped.');
  }, [recording]);

  const handleDownload = () => {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${result.fileNameBase}.${result.extension}`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // The URL is revoked on the next tick: revoking it in the same tick can
    // cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setDownloaded(true);
    onDownload?.(result);
  };

  const handleRecord = () => {
    if (recording) {
      void recorder.stop();
      return;
    }
    void recorder.start({ includeMicrophone });
  };

  // ---- the copy -----------------------------------------------------------

  const errorText = errorMessageFor(recorder.error, recorder.errorMessage);
  const warnings = result?.warnings ?? [];

  let hint: string;
  if (!canRecord) {
    hint = 'Only the room leader can record this session.';
  } else if (!recorder.supported) {
    hint = 'Recording is not available in this browser.';
  } else if (requesting) {
    hint = 'Pick a tab or a window in the browser dialog. Tick "Share tab audio" to capture the room.';
  } else if (recording) {
    hint = 'Recording. The file stays in this browser — nothing is uploaded.';
  } else if (stopping) {
    hint = 'Finishing the recording…';
  } else {
    hint = 'Pressing Record opens the browser share picker. Choose a tab or a window to capture.';
  }

  const showMicToggle = canRecord && recorder.supported && !recording && !requesting;

  const recordLabel = recording ? 'Stop recording' : 'Record session';
  const recordDisabled =
    !canRecord ||
    !recorder.supported ||
    requesting ||
    stopping;

  // ---- the render ---------------------------------------------------------

  return (
    <section
      aria-label="Session recording"
      className={`flex flex-col gap-2 rounded-xl border border-line bg-surface p-2 text-fg ${
        className ?? ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-fg-muted">
          <Video size={13} aria-hidden="true" />
          <span>Recording</span>
        </span>

        {showMicToggle ? (
          <button
            type="button"
            onClick={() => setIncludeMicrophone((previous) => !previous)}
            aria-pressed={includeMicrophone}
            aria-label={
              includeMicrophone
                ? 'Turn off the microphone in the recording'
                : 'Turn on the microphone in the recording'
            }
            className={`inline-flex h-8 min-h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-medium transition-colors ${
              includeMicrophone
                ? 'border-accent bg-accent-soft text-[color:var(--color-accent-text)]'
                : 'border-line bg-raised text-fg-muted hover:text-fg'
            }`}
          >
            {includeMicrophone ? (
              <Mic size={13} aria-hidden="true" />
            ) : (
              <MicOff size={13} aria-hidden="true" />
            )}
            <span>Include my microphone</span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={handleRecord}
          disabled={recordDisabled}
          aria-label={recordLabel}
          className={`inline-flex h-8 min-h-8 items-center gap-1.5 rounded-xl px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            recording
              ? 'border border-negative bg-transparent text-negative hover:bg-negative-soft'
              : 'bg-accent text-accent-fg hover:bg-accent-hover'
          }`}
        >
          {recording ? (
            <Square size={13} aria-hidden="true" />
          ) : (
            <Circle size={13} aria-hidden="true" />
          )}
          <span>
            {recording
              ? 'Stop'
              : requesting
                ? 'Waiting for the picker…'
                : stopping
                  ? 'Saving…'
                  : 'Record'}
          </span>
        </button>

        {recording ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-negative">
            <span
              aria-hidden="true"
              className="h-2 w-2 animate-pulse rounded-full bg-negative"
            />
            <span className="tabular-nums">{formatDuration(recorder.elapsedSeconds)}</span>
          </span>
        ) : null}

        {recording && recorder.bytes > 0 ? (
          <span className="tabular-nums text-[11px] text-fg-muted">
            {formatBytes(recorder.bytes)}
          </span>
        ) : null}
      </div>

      {/*
        The timer changes every second, so it is NOT inside a live region:
        that would read the clock out once a second. Only the start and the
        stop are announced.
      */}
      <p className="sr-only" role="status">
        {announcement}
      </p>

      <p className="text-[10px] leading-relaxed text-fg-muted">{hint}</p>

      {showMicToggle ? (
        <p className="text-[10px] leading-relaxed text-fg-muted">
          Remote participants&rsquo; audio is included automatically when it is available.
        </p>
      ) : null}

      {errorText ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-xl bg-negative-soft px-2 py-1.5 text-[10px] leading-relaxed text-negative"
        >
          <span aria-hidden="true" className="font-bold">
            !
          </span>
          <span>{errorText}</span>
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul
          className="flex flex-col gap-1 rounded-xl bg-raised px-2 py-1.5 text-[10px] leading-relaxed text-fg-muted"
          aria-label="Recording warnings"
        >
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {result ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <span className="text-[11px] text-fg-muted">
            Recording ready · {formatBytes(result.blob.size)} ·{' '}
            <span className="tabular-nums">{formatDuration(result.durationSeconds)}</span> ·{' '}
            {result.extension}
            {result.microphoneIncluded ? ' · mic included' : ''}
            {result.remoteAudioIncluded ? ' · participants included' : ''}
          </span>

          <button
            type="button"
            onClick={handleDownload}
            aria-label={`Download the recording as ${result.extension}`}
            className="inline-flex h-8 min-h-8 items-center gap-1.5 rounded-xl bg-accent px-3 text-[11px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
          >
            <Download size={13} aria-hidden="true" />
            <span>{downloaded ? 'Downloaded' : 'Download'}</span>
          </button>

          {!downloaded ? (
            <button
              type="button"
              onClick={() => recorder.cancel()}
              aria-label="Discard the recording"
              className="inline-flex h-8 min-h-8 items-center gap-1.5 rounded-xl border border-line bg-raised px-3 text-[11px] font-semibold text-fg-muted transition-colors hover:text-negative"
            >
              <Trash2 size={13} aria-hidden="true" />
              <span>Discard</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
