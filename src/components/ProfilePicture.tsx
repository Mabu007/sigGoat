/**
 * PROFILE PICTURE
 * ===============
 * The profile-picture row in Settings: one picture, used everywhere the
 * member appears.
 *
 * WHAT THIS ROW IS
 * ----------------
 * A complete lifecycle, not a file input:
 *
 *   - the picture that is SAVED right now, and — only while an upload is
 *     waiting — a PREVIEW of the new one, clearly marked as not saved;
 *   - a "Save profile picture" button that exists only when there is
 *     something to save, and that is disabled while it is saving;
 *   - a "Replace picture" action, which stages a new picture and leaves the
 *     saved one exactly where it is;
 *   - a "Delete picture" action with a small INLINE confirmation — never a
 *     `window.confirm`, which is a dialog the browser owns and the product
 *     cannot style or explain;
 *   - a truthful message for every outcome, including the failures.
 *
 * THE ONE RULE
 * ------------
 * Choosing a file does NOT change the picture. The picture changes when the
 * save succeeds, and the saved picture stays visible — and stays the
 * authoritative one — for as long as the save has not succeeded.
 */

import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { useProfilePicture } from '../hooks/useProfilePicture';
import './profile-picture.css';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export interface ProfilePictureProps {
  /** The member's name, for the initials fallback and the alt text. */
  name?: string | null;
  className?: string;
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

export function ProfilePicture({ name, className }: ProfilePictureProps) {
  const { url, staged, status, progress, error, upload, save, discard, remove } =
    useProfilePicture();

  const inputId = useId();

  /** The delete confirmation is inline and open at most once. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const busy = status === 'preparing' || status === 'uploading';
  const saving = status === 'committing';
  const canSave = Boolean(staged) && !saving;

  /**
   * A guard that survives the gap between the click and the next render.
   *
   * The button is disabled while the save is running, but two clicks in the
   * same tick would both reach the server before React had a chance to
   * disable it.
   */
  const actingRef = useRef(false);

  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  /**
   * A new file starts a new story: the previous message is dropped.
   */
  useEffect(() => {
    if (staged) setNotice(null);
  }, [staged]);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    /**
     * Clear the input so choosing the SAME file again still fires a change
     * event. Without this, a trader who picks the wrong image cannot retry
     * with the same name.
     */
    event.target.value = '';
    /**
     * Cancelling the file dialog chooses nothing: there is no staged upload,
     * nothing changed and nothing is reported.
     */
    if (!file) return;

    setNotice(null);
    await upload(file);
  };

  const handleSave = async () => {
    if (!canSave || actingRef.current) return;
    actingRef.current = true;
    setNotice(null);
    try {
      const committed = await save();
      setNotice(
        committed
          ? { kind: 'ok', text: 'Your profile picture was saved.' }
          : { kind: 'error', text: 'Your picture was not saved. Your previous picture is still in place.' },
      );
    } finally {
      actingRef.current = false;
    }
  };

  const handleDiscard = () => {
    setNotice(null);
    discard();
  };

  const handleRemove = async () => {
    if (actingRef.current) return;
    actingRef.current = true;
    setConfirmingDelete(false);
    setNotice(null);
    try {
      const removed = await remove();
      setNotice(
        removed
          ? { kind: 'ok', text: 'Your profile picture was deleted.' }
          : { kind: 'error', text: 'Your picture was not deleted. It is still your profile picture.' },
        );
    } finally {
      actingRef.current = false;
    }
  };

  return (
    <div className={['pp-row', className ?? ''].filter(Boolean).join(' ')}>
      <div className="pp-previews">
        <div className="pp-preview">
          <UserAvatar name={name} url={url} size={56} />
          <span className="pp-caption">{url ? 'Saved' : 'No picture'}</span>
        </div>
        {staged ? (
          <div className="pp-preview is-staged">
            <UserAvatar name={name} url={staged.url} size={56} pending />
            <span className="pp-caption">Not saved yet</span>
          </div>
        ) : null}
      </div>

      <div className="pp-copy">
        <p className="pp-title">Profile picture</p>
        <p className="pp-sub">
          Shown next to your name in rooms, chat and member lists.
        </p>
        {staged ? (
          <p className="pp-unsaved">
            Your new picture is uploaded but not saved yet. It becomes your
            profile picture only when you save it.
          </p>
        ) : null}
      </div>

      <div className="pp-actions">
        <label className="pp-button" htmlFor={inputId}>
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : staged ? (
            <Upload size={13} aria-hidden="true" />
          ) : (
            <ImagePlus size={13} aria-hidden="true" />
          )}
          {busy
            ? 'Uploading…'
            : url
              ? 'Replace picture'
              : 'Upload picture'}
        </label>
        <input
          id={inputId}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={handleFile}
          aria-label="Profile picture file"
        />

        <button
          type="button"
          className="pp-button is-primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
        >
          {saving ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : null}
          {saving ? 'Saving…' : 'Save profile picture'}
        </button>

        {staged ? (
          <button
            type="button"
            className="pp-button"
            onClick={handleDiscard}
            disabled={saving}
          >
            Discard new picture
          </button>
        ) : null}

        {url ? (
          <button
            type="button"
            className="pp-button is-danger"
            onClick={() => setConfirmingDelete(true)}
            disabled={saving || busy}
          >
            <Trash2 size={13} aria-hidden="true" />
            Delete picture
          </button>
        ) : null}
      </div>

      {confirmingDelete ? (
        <div className="pp-confirm" role="alertdialog" aria-label="Delete profile picture">
          <p className="pp-confirm-text">
            Delete your profile picture? Your initials will be used everywhere
            until you upload another one.
          </p>
          <div className="pp-actions">
            <button
              type="button"
              className="pp-button is-danger"
              onClick={() => void handleRemove()}
            >
              Delete picture
            </button>
            <button
              type="button"
              className="pp-button"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep picture
            </button>
          </div>
        </div>
      ) : null}

      {busy || saving ? (
        <div
          className="pp-progress"
          role="progressbar"
          aria-label="Profile picture upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="pp-progress-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      {error ? (
        <p className="pp-error" role="alert">
          {error}
        </p>
      ) : null}

      {notice && !error ? (
        <p className={`pp-notice is-${notice.kind}`} role="status">
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

export default ProfilePicture;
