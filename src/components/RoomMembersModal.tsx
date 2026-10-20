/**
 * ROOM MEMBERS
 * ============
 * Who is in the room, and who is here RIGHT NOW.
 *
 * THE TWO COUNTS ARE DIFFERENT THINGS
 * -----------------------------------
 *   MEMBERS  how many people have joined the room. It grows and it does
 *            not shrink until somebody leaves.
 *   ONLINE   how many of those people hold a live connection at this
 *            moment. It rises and falls with the room.
 *
 * The online count comes from the room's Durable Object and is reported by
 * the server. When the server cannot establish it the count is shown as
 * UNAVAILABLE rather than as zero, because "nobody is here" and "we do not
 * know" are different facts.
 *
 * A VISITOR MAY NOT ENUMERATE A ROOM'S MEMBERS
 * -------------------------------------------
 * The list is only served to a member of the room. A visitor sees the
 * counts and nothing else.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Users, X, Wifi, WifiOff } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { useAuth } from '../context/AuthContext';
import './room-members.css';

export interface RoomMemberRow {
  uid: string;
  name: string;
  role: 'OWNER' | 'LEADER' | 'MEMBER';
  joinedAt?: string | null;
  online: boolean;
  avatarUrl?: string | null;
}

export interface RoomMembersModalProps {
  roomId: string | null;
  /** True when the signed-in member may see the roster. */
  canViewRoster: boolean;
  /** The signed-in user's id, so their own row can be marked. */
  viewerId?: string | null;
  onClose: () => void;
}

interface MembersResponse {
  members: RoomMemberRow[];
  onlineCount: number | null;
  mentorOnline: boolean | null;
  totalMembers: number;
}

export function RoomMembersModal({
  roomId,
  canViewRoster,
  viewerId = null,
  onClose,
}: RoomMembersModalProps) {
  const { getApiAuthHeaders } = useAuth();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [data, setData] = useState<MembersResponse | null>(null);
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    if (!roomId) return;
    setState('loading');
    setError('');
    try {
      const headers = new Headers({ Accept: 'application/json' });
      for (const [key, value] of Object.entries(await getApiAuthHeaders())) {
        headers.set(key, value);
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
        headers,
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        /**
         * A VISITOR GETS AN EXPLANATION, NOT AN AUTHORIZATION ERROR.
         *
         * The roster is for the room's members. A signed-out visitor is
         * told that, in words, instead of being shown the server's
         * authorization message.
         */
        setError(
          response.status === 401
            ? 'Sign in to see who is in this room.'
            : response.status === 403
              ? 'Join this room to see who is in it.'
              : body?.error?.message || 'The member list is unavailable.',
        );
        setState('error');
        return;
      }
      setData(body as MembersResponse);
      setState('ready');
    } catch {
      setError('The member list could not be loaded.');
      setState('error');
    }
  }, [roomId, getApiAuthHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * THE DIALOG CLOSES THE WAY A DIALOG CLOSES.
   *
   * Escape closes it, the backdrop closes it, and the close button takes
   * the focus when it opens so a keyboard user is not left behind the
   * list.
   */
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const members = data?.members ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return members;
    return members.filter(
      (member) =>
        member.name.toLowerCase().includes(needle) || member.role.toLowerCase().includes(needle),
    );
  }, [data, query]);

  const online = filtered.filter((member) => member.online);
  const offline = filtered.filter((member) => !member.online);

  return (
    <div
      className="room-members-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="room-members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-members-title"
        ref={dialogRef}
      >
        <header className="room-members-head">
          <div className="room-members-head-text">
            <h2 id="room-members-title" className="room-members-title">
              <Users size={15} strokeWidth={2.2} aria-hidden="true" />
              Room members
            </h2>
            <p className="room-members-sub">
              {data
                ? `${data.totalMembers} registered${
                    data.onlineCount === null
                      ? ' · online count unavailable'
                      : ` · ${data.onlineCount} online`
                  }`
                : 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            className="room-members-close"
            onClick={onClose}
            aria-label="Close the member list"
            ref={closeRef}
          >
            <X size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </header>

        {state === 'loading' && <p className="room-members-state">Loading the member list…</p>}

        {state === 'error' && (
          <p className="room-members-state is-error" role="alert">
            {error}
          </p>
        )}

        {state === 'ready' && data && (
          <>
            {data.members.length > 6 && (
              <div className="room-members-search">
                <Search size={13} strokeWidth={2.2} aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search members"
                  aria-label="Search the member list"
                />
              </div>
            )}

            {!canViewRoster && (
              <p className="room-members-note">
                Join the room to see who is in it.
              </p>
            )}

            {canViewRoster && filtered.length === 0 && (
              <p className="room-members-state">
                {query.trim() ? 'No member matches that search.' : 'No members yet.'}
              </p>
            )}

            {canViewRoster && online.length > 0 && (
              <section className="room-members-group" aria-label="Online now">
                <h3 className="room-members-group-title">Online now</h3>
                <ul className="room-members-list">
                  {online.map((member) => (
                    <RoomMemberRowView
                      key={member.uid}
                      member={member}
                      isViewer={member.uid === viewerId}
                    />
                  ))}
                </ul>
              </section>
            )}

            {canViewRoster && offline.length > 0 && (
              <section className="room-members-group" aria-label="Offline members">
                <h3 className="room-members-group-title">Offline</h3>
                <ul className="room-members-list">
                  {offline.map((member) => (
                    <RoomMemberRowView
                      key={member.uid}
                      member={member}
                      isViewer={member.uid === viewerId}
                    />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RoomMemberRowView({
  member,
  isViewer,
}: {
  member: RoomMemberRow;
  isViewer: boolean;
}) {
  return (
    <li className="room-members-row">
      <UserAvatar name={member.name} url={member.avatarUrl} size={30} />
      <span className="room-members-row-text">
        <span className="room-members-row-name">
          {member.name}
          {isViewer && <span className="room-members-you">you</span>}
        </span>
        <span className="room-members-row-role">
          {member.role === 'OWNER' ? 'Room leader' : member.role === 'LEADER' ? 'Leader' : 'Member'}
        </span>
      </span>
      <span
        className={
          member.online ? 'room-members-presence is-online' : 'room-members-presence is-offline'
        }
        title={member.online ? 'Online now' : 'Offline'}
      >
        {member.online ? (
          <Wifi size={12} strokeWidth={2.4} aria-hidden="true" />
        ) : (
          <WifiOff size={12} strokeWidth={2.4} aria-hidden="true" />
        )}
        <span className="sr-only">{member.online ? 'Online now' : 'Offline'}</span>
      </span>
    </li>
  );
}
