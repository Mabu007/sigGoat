/**
 * ROOM COVER PICKER
 * =================
 * The cover image of a trade room, and the one control that puts it there.
 *
 * WHY THIS IS NOT JUST AN <input type="file">
 * -----------------------------------------
 * A bare file input is the fastest way to ship an upload that fails silently
 * and looks broken. This picker is explicit about three things a trader
 * cares about:
 *
 *   1. WHAT IS THERE NOW — a 16:9 preview of the current cover, or an empty
 *      state that looks designed rather than broken.
 *   2. WHAT IS HAPPENING — real upload progress, measured from the bytes
 *      that actually reached the Worker.
 *   3. WHY NOTHING HAPPENED — a real error message, not a silent no-op.
 *
 * THE CREATE-ROOM CASE
 * --------------------
 * The server ties a cover to an EXISTING room: it checks that the caller may
 * manage that room before it issues an upload ticket. So while a room is
 * still being created there is nothing to attach a cover to, and the picker
 * says exactly that ("Save the room first, then add a cover.") instead of
 * accepting a file and quietly dropping it.
 *
 * All styling is Tailwind utilities over the app's own tokens, so the picker
 * follows the light/dark themes without a second stylesheet.
 */

import { useEffect, useId, useState, type ChangeEvent } from 'react';
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { useImageUpload, type ImageUploadPurpose } from '../hooks/useImageUpload';

export interface RoomCoverPickerProps {
  /** Omit while creating a room — a cover can only be attached to a saved room. */
  roomId?: string | null;
  /** Defaults to 'room-cover'. */
  purpose?: ImageUploadPurpose;
  /** The cover that is stored right now. */
  currentUrl?: string | null;
  /** Called with the new url, or null when the cover is removed. */
  onChange?: (url: string | null) => void;
  className?: string;
  /** The field label. */
  label?: string;
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

const NO_ROOM_HINT = 'Save the room first, then add a cover.';

export function RoomCoverPicker({
  roomId,
  purpose = 'room-cover',
  currentUrl,
  onChange,
  className,
  label,
}: RoomCoverPickerProps) {
  const inputId = useId();

  const [preview, setPreview] = useState<string | null>(currentUrl ?? null);
  const [previewBroken, setPreviewBroken] = useState(false);

  const {
    status,
    progress,
    error,
    upload,
    remove,
  } = useImageUpload({
    purpose,
    roomId: roomId ?? null,
    onUploaded: (url) => {
      setPreview(url);
      setPreviewBroken(false);
      onChange?.(url);
    },
  });

  /**
   * The parent owns the truth. When it hands down a different cover, this
   * picker follows it.
   */
  useEffect(() => {
    setPreview(currentUrl ?? null);
    setPreviewBroken(false);
  }, [currentUrl]);

  /** A room cover cannot be uploaded before the room exists. */
  const waitingForRoom = purpose === 'room-cover' && !roomId;

  const busy = status === 'preparing' || status === 'uploading' || status === 'committing';
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  const showImage = Boolean(preview) && !previewBroken;

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    /**
     * Clear the input so choosing the SAME file again still fires a change
     * event. Without this, a trader who picks the wrong image cannot retry
     * with the same name.
     */
    event.target.value = '';
    if (!file) return;
    await upload(file);
  };

  const handleRemove = async () => {
    /**
     * The preview is NOT cleared here: the hook clears it through
     * `onUploaded(null)`, which only happens when the server confirms the
     * removal. A failed removal must leave the cover standing.
     */
    await remove();
  };

  const fieldLabel = label ?? (purpose === 'avatar' ? 'Profile picture' : 'Room cover');

  /**
   * What a screen reader hears while the upload runs. The visible progress
   * is announced through the progressbar itself; this line covers the phase
   * changes (preparing, uploading, committing, done).
   */
  const statusText = busy
    ? status === 'committing'
      ? 'Saving the image.'
      : status === 'preparing'
        ? 'Preparing the upload.'
        : `Uploading the image, ${percent} percent.`
    : status === 'done'
      ? 'The image is uploaded.'
      : '';

  return (
    <div className={className}>
      <span className="label">{fieldLabel}</span>

      {/* ---- preview ---- */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-sunken">
        {showImage ? (
          <img
            src={preview as string}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setPreviewBroken(true)}
          />
        ) : (
          <div className="absolute inset-0">
            <div className="absolute inset-0 bg-gradient-to-br from-raised via-sunken to-raised" />
            <div className="absolute inset-0 opacity-70 bg-[radial-gradient(circle_at_1px_1px,var(--color-line-strong)_1px,transparent_0)] [background-size:14px_14px]" />
            <div className="relative z-10 flex h-full flex-col items-center justify-center gap-2">
              <ImagePlus size={22} className="text-fg-subtle" aria-hidden="true" />
              <p className="text-xs font-medium text-fg-muted">
                {previewBroken ? 'The cover could not be loaded.' : 'No cover yet'}
              </p>
            </div>
          </div>
        )}

        {/* progress overlay */}
        {busy ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/80 px-4 text-center">
            <Loader2 size={20} className="animate-spin text-[color:var(--color-accent-text)]" aria-hidden="true" />
            <p className="text-xs font-medium text-fg">
              {status === 'committing' ? 'Saving the image…' : 'Uploading…'}
            </p>
            {status !== 'committing' ? (
              <p className="text-[11px] tabular-nums text-fg-muted">{percent}%</p>
            ) : null}
          </div>
        ) : null}

        {/* the create-room case, stated plainly */}
        {waitingForRoom ? (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/75 px-4 text-center">
            <p className="text-xs font-medium text-fg-muted" aria-hidden="true">
              {NO_ROOM_HINT}
            </p>
          </div>
        ) : null}
      </div>

      {/* ---- the accessible progress bar ---- */}
      {busy ? (
        <div
          role="progressbar"
          aria-label="Image upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      {/* ---- actions ---- */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="file"
          accept={ACCEPT}
          disabled={waitingForRoom || busy}
          onChange={handleFile}
          className="sr-only peer"
          aria-label={`${fieldLabel} image file`}
        />
        <label
          htmlFor={inputId}
          className={[
            'inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
            waitingForRoom || busy
              ? 'cursor-not-allowed border-line bg-raised text-fg-subtle'
              : 'border-line-strong bg-surface text-fg hover:bg-raised',
            'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          ].join(' ')}
          aria-disabled={waitingForRoom || busy}
        >
          <Upload size={14} aria-hidden="true" />
          {showImage ? 'Replace cover' : 'Add cover'}
        </label>

        {showImage ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy || waitingForRoom}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-negative transition-colors hover:bg-negative-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={14} aria-hidden="true" />
            Remove
          </button>
        ) : null}
      </div>

      {/* ---- messages ---- */}
      <p className="sr-only" aria-live="polite">
        {statusText}
      </p>

      <div className="mt-2 space-y-2">
        {waitingForRoom ? (
          <p className="text-[11px] text-fg-muted">{NO_ROOM_HINT}</p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-xl bg-negative-soft px-3 py-2 text-[11px] font-medium text-negative"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default RoomCoverPicker;
