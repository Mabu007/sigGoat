/**
 * ROOM VOICE SESSIONS
 * ===================
 * Voice in a TradingVibes room is a Cloudflare Realtime SFU session.
 *
 * WHO OWNS WHAT
 * -------------
 *   - the API server holds the SFU App Secret and performs every SFU API
 *     call. The browser NEVER sees the secret and never calls the SFU
 *     directly with it.
 *   - the browser owns the WebRTC peer connection, the microphone capture
 *     and the audio elements.
 *   - the roster of who is in voice lives in Firestore so it survives a
 *     serverless cold start.
 *
 * THE ROSTER
 * ----------
 *   goatTeams/{roomId}/voiceParticipants/{uid}
 *
 * One document per participant. The uid is the document id, so a participant
 * can only ever overwrite their OWN row.
 *
 * The SFU does not know about rooms, membership, roles or presence. It moves
 * media. Everything about WHO may speak is decided here, on the server.
 */

import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "../firebaseAdmin";
import {
  closeTracks,
  createSession,
  createTracks,
  getSession,
  renegotiate,
  resolveSfuConfig,
  SfuApiError,
  type SfuSessionDescription,
  type SfuTrackResult,
} from "./sfuClient";
import { pushVoiceRoster } from "../realtime/roomRealtimeGateway";
import type { VoiceParticipant } from "../../shared/roomProtocol";

export interface VoiceRosterEntry extends VoiceParticipant {
  joinedAt: number;
}

export interface VoiceRoster {
  enabled: boolean;
  participants: VoiceParticipant[];
}

const safeId = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

export class VoiceRosterStore {
  private readonly firestore?: Firestore;

  constructor(options: { firestore?: Firestore } = {}) {
    this.firestore = options.firestore;
  }

  private collection(roomId: string) {
    return this.firestore!
      .collection("goatTeams")
      .doc(safeId(roomId))
      .collection("voiceParticipants");
  }

  async list(roomId: string): Promise<VoiceRosterEntry[]> {
    if (!this.firestore) return [];
    const snapshot = await this.collection(roomId).get();
    return snapshot.docs
      .map((doc) => doc.data() as VoiceRosterEntry)
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async set(roomId: string, uid: string, entry: VoiceRosterEntry): Promise<void> {
    if (!this.firestore) return;
    await this.collection(roomId).doc(uid).set(entry);
  }

  async remove(roomId: string, uid: string): Promise<void> {
    if (!this.firestore) return;
    await this.collection(roomId).doc(uid).delete();
  }
}

export function createVoiceRosterStore(): VoiceRosterStore {
  return new VoiceRosterStore({ firestore: getFirebaseAdmin()?.firestore });
}

// ---------------------------------------------------------------------------
// SFU operations
// ---------------------------------------------------------------------------

function requireSfu() {
  const config = resolveSfuConfig();
  if (!config) {
    throw new SfuApiError(
      "Voice is not configured on this server. Set CLOUDFLARE_SFU_APP_ID and CLOUDFLARE_SFU_API_KEY.",
      503,
    );
  }
  return config;
}

export interface PublishResult {
  sessionId: string;
  answer: SfuSessionDescription;
  tracks: SfuTrackResult[];
}

/**
 * Publishes the caller's microphone.
 *
 * The browser has already captured the track and produced an offer. The
 * server creates the SFU session, hands the offer over with the transceiver
 * mid, and returns the SFU's answer.
 */
export async function publishMicrophone(input: {
  sdp: string;
  mid: string;
  trackName?: string;
}): Promise<PublishResult> {
  const config = requireSfu();
  const session = await createSession(config);
  const response = await createTracks(config, session.sessionId, {
    sessionDescription: { type: "offer", sdp: input.sdp },
    tracks: [
      {
        location: "local",
        mid: input.mid,
        trackName: input.trackName ?? "microphone",
      },
    ],
  });
  if (!response.sessionDescription) {
    throw new SfuApiError(
      response.errorDescription || "The SFU did not return an answer.",
      502,
      response.errorCode,
    );
  }
  return {
    sessionId: session.sessionId,
    answer: response.sessionDescription,
    tracks: response.tracks ?? [],
  };
}

export interface SubscribeResult {
  sessionId: string;
  offer?: SfuSessionDescription;
  /** The mid each remote publication was assigned in this connection. */
  tracks: { mid?: string; sessionId?: string; trackName?: string }[];
}

/**
 * Subscribes the caller to every OTHER participant's published microphone.
 *
 * A single receiving connection is used for all remote publications, which
 * is what the SFU is designed for: one session, many remote tracks.
 */
export async function subscribeToRoster(
  publications: { sessionId: string; trackName: string }[],
): Promise<SubscribeResult> {
  const config = requireSfu();
  const session = await createSession(config);
  if (publications.length === 0) {
    return { sessionId: session.sessionId, tracks: [] };
  }
  const response = await createTracks(config, session.sessionId, {
    tracks: publications.map((publication) => ({
      location: "remote" as const,
      sessionId: publication.sessionId,
      trackName: publication.trackName,
    })),
  });
  const tracks = (response.tracks ?? []).map((track) => ({
    mid: track.mid,
    sessionId: track.sessionId,
    trackName: track.trackName,
  }));
  return {
    sessionId: session.sessionId,
    offer: response.sessionDescription,
    tracks,
  };
}

/** Completes the receiving handshake. */
export async function completeSubscription(
  sessionId: string,
  answer: SfuSessionDescription,
): Promise<void> {
  const config = requireSfu();
  await renegotiate(config, sessionId, { sessionDescription: answer });
}
/** Closes a participant's SFU session. */
export async function closeVoiceSession(sessionId: string): Promise<void> {
  const config = resolveSfuConfig();
  if (!config) return;
  try {
    await closeTracks(config, sessionId, { tracks: [], force: true });
  } catch (error) {
    // A session the SFU has already forgotten is not an error worth
    // surfacing: the participant is leaving either way.
    console.warn(
      "[voice] Could not close SFU session:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Reads the SFU's view of a session. Used by the diagnostics endpoint. */
export async function inspectSession(sessionId: string): Promise<unknown> {
  const config = requireSfu();
  return getSession(config, sessionId);
}

/**
 * Publishes the roster to the room's Durable Object so every member sees
 * who is in voice without polling.
 */
export async function broadcastRoster(
  roomId: string,
  participants: VoiceParticipant[],
  enabled: boolean,
): Promise<void> {
  await pushVoiceRoster(roomId, { enabled, participants });
}
