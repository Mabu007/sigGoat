/**
 * ROOM VOICE CONTROLS
 * ===================
 * The voice surface of a TradingVibes room: join/leave, mute, and who is in
 * the room right now.
 *
 * HONEST STATES
 * -------------
 * A control that cannot work says so. When the server has no SFU credentials,
 * or the room has voice switched off, or the viewer is not a member, the
 * button is disabled and the reason is written next to it. Nothing here ever
 * implies a working microphone that does not exist.
 *
 * ACCESSIBILITY
 * -------------
 * Every icon button carries an `aria-label`, the mute button carries
 * `aria-pressed`, every interactive element is at least 32px on its small
 * axis, and no state is communicated by colour alone — each one is paired
 * with an icon and, where it matters, a text label for screen readers.
 *
 * STYLING
 * -------
 * Tailwind utilities over the existing design tokens only. No new CSS.
 */

import { AlertTriangle, Loader2, Mic, MicOff, PhoneOff, Users, Volume2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRoomVoice, type UseRoomVoice } from '../hooks/useRoomVoice';
import type { VoiceParticipant } from '../shared/roomProtocol';

export interface RoomVoiceControlsProps {
  /** The room whose voice session these controls open. */
  roomId: string | null;
  /** The name published to the voice roster. */
  displayName: string;
  /** Whether the viewer may use this room's voice session. */
  canUseVoice: boolean;
  className?: string;
  /** Render the participant roster. Default: true. */
  showParticipants?: boolean;
  /**
   * Forwarded to the hook. Use it to mirror the local speaking flag into the
   * room socket so other members see it.
   */
  onSpeakingChange?: (speaking: boolean) => void;
}

export interface RoomVoiceControlsViewProps {
  /** The voice session state, normally from `useRoomVoice`. */
  voice: UseRoomVoice;
  /** The signed-in user's uid, so the roster can label them "You". */
  currentUid?: string | null;
  /** Whether the viewer may use this room's voice session. Default: true. */
  canUseVoice?: boolean;
  className?: string;
  /** Render the participant roster. Default: true. */
  showParticipants?: boolean;
}

const JOIN_LABEL = 'Join voice';
const LEAVE_LABEL = 'Leave voice';

/**
 * The signed-in user's id, whichever auth mode the server runs in.
 *
 * With Firebase the uid comes from the user object. In development auth mode
 * there is no Firebase user at all: the server identifies the caller with the
 * `x-dev-user-id` header, whose value the browser already keeps in
 * localStorage under the key `src/lib/apiAuth.ts` uses. Reading the same key
 * here is what lets the roster label the local user "You" in both modes.
 */
function resolveLocalUid(firebaseUid: string | null | undefined): string | null {
  if (firebaseUid) return firebaseUid;
  try {
    return window.localStorage.getItem('signalgoat.devUserId');
  } catch {
    return null;
  }
}

/**
 * The reason the voice control cannot be used, or null when it can.
 *
 * "Checking…" is a real state: the capability endpoint has not answered yet,
 * and saying "voice is not configured" before it answers would be a lie.
 */
function blockingReason(voice: UseRoomVoice, canUseVoice: boolean): string | null {
  if (!canUseVoice) return 'Join the room to use its voice session.';
  if (!voice.available && !voice.unavailableReason) {
    return 'Checking whether voice is available…';
  }
  if (!voice.available) {
    return voice.unavailableReason ?? 'Voice is not configured on this server.';
  }
  if (!voice.enabled) return 'Voice is disabled in this room.';
  return null;
}

function ParticipantRow({
  participant,
  isLocal,
}: {
  participant: VoiceParticipant;
  isLocal: boolean;
}) {
  const initials = (participant.name || '?').trim().charAt(0).toUpperCase();

  return (
    <li className="flex items-center gap-2 rounded-lg bg-raised px-2 py-1.5">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-[10px] font-bold text-fg-muted"
      >
        {initials}
      </span>

      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">
        {isLocal ? 'You' : participant.name || 'Member'}
      </span>

      {participant.muted ? (
        <span className="flex shrink-0 items-center gap-1 text-negative">
          <MicOff size={13} aria-hidden="true" />
          <span className="sr-only">Muted</span>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 text-fg-subtle">
          <Mic size={13} aria-hidden="true" />
          <span className="sr-only">Unmuted</span>
        </span>
      )}

      {participant.speaking ? (
        <span className="flex shrink-0 items-center gap-1 text-positive">
          <Volume2 size={13} aria-hidden="true" />
          <span className="sr-only">Speaking</span>
        </span>
      ) : null}
    </li>
  );
}

/**
 * The presentational half. It renders a `UseRoomVoice` and nothing else, so
 * a view that already owns the hook can reuse the exact same markup.
 */
export function RoomVoiceControlsView({
  voice,
  currentUid,
  canUseVoice = true,
  className,
  showParticipants = true,
}: RoomVoiceControlsViewProps) {
  const blocked = blockingReason(voice, canUseVoice);
  const busy = voice.status === 'connecting' || voice.status === 'reconnecting';
  const inVoice = voice.inVoice;
  const participants = voice.participants;

  const primaryDisabled = !inVoice && (blocked !== null || busy);
  const primaryLabel = inVoice
    ? LEAVE_LABEL
    : busy
      ? voice.status === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…'
      : JOIN_LABEL;

  /**
   * One line of truth about the current state. The error always wins: it is
   * the thing the user has to act on.
   */
  let hint: string | null = null;
  let hintTone: 'muted' | 'negative' = 'muted';
  if (voice.status === 'error') {
    hint = voice.error ?? 'Voice failed.';
    hintTone = 'negative';
  } else if (voice.status === 'unavailable') {
    hint = voice.unavailableReason ?? voice.error ?? 'Voice is not configured on this server.';
  } else if (inVoice) {
    hint =
      voice.status === 'connected'
        ? 'You are live. Everyone in voice can hear you.'
        : 'The connection dropped. Trying once to restore it…';
  } else {
    hint = blocked;
  }

  return (
    <section
      aria-label="Room voice"
      className={`flex flex-col gap-2 rounded-xl border border-line bg-surface p-2 text-fg ${
        className ?? ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (inVoice) void voice.leave();
            else void voice.join();
          }}
          disabled={primaryDisabled}
          aria-label={inVoice ? LEAVE_LABEL : JOIN_LABEL}
          className={`inline-flex h-8 min-h-8 items-center gap-1.5 rounded-xl px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            inVoice
              ? 'border border-negative bg-transparent text-negative hover:bg-negative-soft'
              : 'bg-accent text-accent-fg hover:bg-accent-hover'
          }`}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : inVoice ? (
            <PhoneOff size={14} aria-hidden="true" />
          ) : (
            <Mic size={14} aria-hidden="true" />
          )}
          <span>{primaryLabel}</span>
        </button>

        <button
          type="button"
          onClick={() => void voice.toggleMute()}
          disabled={!inVoice}
          aria-pressed={voice.muted}
          aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
          className={`inline-flex h-8 min-h-8 w-8 min-w-8 items-center justify-center rounded-xl border border-line bg-raised transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            voice.muted ? 'text-negative' : 'text-positive'
          }`}
        >
          {voice.muted ? (
            <MicOff size={15} aria-hidden="true" />
          ) : (
            <Mic size={15} aria-hidden="true" />
          )}
        </button>

        {participants.length > 0 ? (
          <span className="flex items-center gap-1 text-[11px] text-[color:var(--color-accent-text)]">
            <Users size={13} aria-hidden="true" />
            <span>{participants.length} in voice</span>
          </span>
        ) : null}
      </div>

      {hint ? (
        <p
          className={`flex items-start gap-1 text-[10px] leading-relaxed ${
            hintTone === 'negative'
              ? 'text-negative'
              : inVoice
                ? 'text-[color:var(--color-accent-text)]'
                : 'text-fg-muted'
          }`}
        >
          {hintTone === 'negative' ? (
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          ) : null}
          <span>{hint}</span>
        </p>
      ) : null}

      {showParticipants && participants.length > 0 ? (
        <ul
          className="flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-line pt-2"
          role="list"
          aria-label="Voice participants"
        >
          {participants.map((participant) => (
            <ParticipantRow
              key={participant.uid || participant.id || participant.name}
              participant={participant}
              isLocal={Boolean(currentUid) && participant.uid === currentUid}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The voice control for a room. It owns the `useRoomVoice` hook, so a view
 * only has to hand over the room id, the display name and whether the viewer
 * is a member.
 */
export default function RoomVoiceControls({
  roomId,
  displayName,
  canUseVoice,
  className,
  showParticipants = true,
  onSpeakingChange,
}: RoomVoiceControlsProps) {
  const { currentUser } = useAuth();
  const voice = useRoomVoice({ roomId, displayName, canUseVoice, onSpeakingChange });
  const localUid = resolveLocalUid(currentUser?.uid ?? null);

  return (
    <RoomVoiceControlsView
      voice={voice}
      currentUid={localUid}
      canUseVoice={canUseVoice}
      className={className}
      showParticipants={showParticipants}
    />
  );
}
