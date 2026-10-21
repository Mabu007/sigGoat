/**
 * TRADINGVIBES ROOMS API
 * ======================
 * The room-facing HTTP surface that the rebrand introduces: room settings,
 * live sessions, voice, media uploads, and the internal endpoints the
 * Cloudflare realtime Worker calls.
 *
 * WHERE THIS SITS
 * ---------------
 * This router is mounted at /api alongside the existing `apiRouter`. It does
 * not replace it: the existing room, chat, market and broker endpoints stay
 * exactly where they are, and this module only adds what TradingVibes needs
 * on top of them. Both routers share the same stores and the same
 * `authMiddleware`, so identity means the same thing on every route.
 *
 * AUTHORIZATION
 * -------------
 * Every privileged action is decided here, on the server, from the VERIFIED
 * identity in `req.user.uid`. The browser hides buttons; that is not
 * authorization. A request that says `{"role":"OWNER"}` in its body changes
 * nothing: the role is read from the room document.
 */

import express, { type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { authMiddleware, optionalAuthMiddleware, requireUser } from "./auth";
import { createGoatTeamStore, type GoatTeam } from "./GoatTeamStore";
import {
  canWatchRoom,
  getRoomMemberStore,
  resolveRoomAccess,
  roomSettingsOf,
  type RoomAccess,
} from "./rooms/roomAccess";
import { createRoomSessionStore } from "./rooms/RoomSessionStore";
import { createRoomChartStateStore } from "./rooms/RoomChartStateStore";
import { createRoomPresenceStore, type PresenceMember } from "./rooms/roomPresenceStore";
import { createRoomReadCursorStore } from "./rooms/roomReadCursorStore";
import { persistence } from "./persistence";
import type { ChatMessage } from "../types";
import { createMediaStore, toMediaReference } from "./media/mediaStore";
import {
  buildMediaKey,
  createUploadTicket,
  mediaConfigured,
  realtimeWorkerUrl,
  verifyServiceRequest,
} from "./media/mediaSigner";
import {
  deleteMediaObject,
  isRealtimeConfigured,
  pushSessionState,
  pushVoiceRoster,
} from "./realtime/roomRealtimeGateway";
import {
  broadcastRoster,
  closeVoiceSession,
  completeSubscription,
  createVoiceRosterStore,
  publishMicrophone,
  subscribeToRoster,
} from "./sfu/voiceSessions";
import { isSfuConfigured, sfuUnavailableReason } from "./sfu/sfuClient";
import { PersistenceUnavailableError } from "./persistenceError";
import {
  accessSubject,
  isValidSymbol,
  isValidTimeframe,
  mediaSubject,
  ROOM_PROTOCOL_VERSION,
  roomSubject,
  type RoomDrawing,
} from "../shared/roomProtocol";
import {
  detectMediaType,
  isRoomCategory,
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  type MediaPurpose,
  type RoomCategory,
} from "../types/rooms";
import { createRobotStore, type RobotRecord } from './robots/RobotStore';
import { initialRuntimeState, processCompletedCandle, runStrategyBacktest } from '../services/strategy/engine';
import { migrateStrategyDefinition, type StrategyDefinition } from '../services/strategy/schema';
import { normalizeCompletedCandles, requestedBarsForRange } from '../services/strategy/marketData';
import { hyperliquidProvider } from '../services/market-data/hyperliquid/HyperliquidMarketDataProvider';

export const roomsRouter = express.Router();

const teamStore = createGoatTeamStore();
const memberStore = getRoomMemberStore();
const sessionStore = createRoomSessionStore();
const chartStateStore = createRoomChartStateStore();
const mediaStore = createMediaStore();
const voiceStore = createVoiceRosterStore();
const presenceStore = createRoomPresenceStore();
const readCursorStore = createRoomReadCursorStore();
const robotStore = createRobotStore();

/** The conversation of one room. The id is shared with the legacy API. */
const roomConversationId = (roomId: string) => `room_${roomId}`;

/** How many messages one page of a conversation may carry. */
const ROOM_MESSAGE_PAGE_LIMIT = 30;
const ROOM_MESSAGE_MAX_LENGTH = 2000;

/**
 * The avatar of one member, as a signed delivery url.
 *
 * The stored value is an R2 object key and the url EXPIRES, so it is
 * regenerated on every read. The lookups are cached for the life of one
 * request: a page of fifty messages must not make fifty Firestore reads.
 */
function avatarLookup(): (uid: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (uid: string) => {
    const cached = cache.get(uid);
    if (cached !== undefined) return cached;
    let url: string | null = null;
    try {
      const stored = await mediaStore.getAvatar(uid);
      url = stored ? toMediaReference(stored, "avatar")?.url ?? null : null;
    } catch {
      url = null;
    }
    cache.set(uid, url);
    return url;
  };
}

const MAX_DIRECTORY_ROOMS = 60;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((error) => {
      /**
       * The datastore is not available. That is a configuration problem, not
       * a caller mistake, so it answers 503 with the REAL reason — the same
       * way the legacy router does — instead of an opaque 500.
       */
      if (error instanceof PersistenceUnavailableError) {
        console.error(`[rooms] ${req.method} ${req.originalUrl ?? req.url} — ${error.message}`);
        fail(res, 503, "PERSISTENCE_UNAVAILABLE", error.message);
        return;
      }
      console.error("[rooms] Unhandled route error:", error);
      if (!res.headersSent) {
        fail(res, 500, "INTERNAL_ERROR", "Something went wrong handling that request.");
      }
    });
  };
}

/** Resolves a room by its id or by its share slug. */
async function resolveTeam(idOrSlug: string): Promise<GoatTeam | null> {
  const byId = await teamStore.getById(idOrSlug);
  if (byId) return byId;
  return teamStore.getBySlug(idOrSlug);
}

const GUEST_ACCESS: RoomAccess = {
  role: "GUEST",
  isMember: false,
  canView: false,
  canChat: false,
  canDraw: false,
  canUseVoice: false,
  canManage: false,
  canRunSession: false,
};

function roomView(
  team: GoatTeam,
  access: RoomAccess = GUEST_ACCESS,
  extras: {
    memberCount?: number;
    coverUrl?: string | null;
    creatorName?: string;
    live?: boolean;
    /**
     * How many members hold a live connection right now. Null means the
     * server could not establish it, which is NOT the same as zero.
     */
    onlineCount?: number | null;
    /** Whether the room's leader has a live connection. */
    mentorOnline?: boolean | null;
  } = {},
) {
  const settings = roomSettingsOf(team);
  return {
    id: team.id,
    slug: team.publicSlug ?? team.id,
    name: team.name,
    description: (team.instructions ?? "").slice(0, 400),
    visibility: team.visibility ?? "PRIVATE",
    status: team.status,
    creatorName: extras.creatorName ?? "",
    memberCount: extras.memberCount ?? 0,
    category: settings.category,
    markets: settings.markets,
    chart: settings.chart,
    allowDrawings: settings.allowDrawings,
    voiceEnabled: settings.voiceEnabled,
    coverUrl: extras.coverUrl ?? null,
    live: extras.live ?? false,
    onlineCount: extras.onlineCount ?? null,
    mentorOnline: extras.mentorOnline ?? null,
    role: access.role,
    canManage: access.canManage,
    canChat: access.canChat,
    canDraw: access.canDraw,
    canUseVoice: access.canUseVoice,
    canRunSession: access.canRunSession,
    isMember: access.isMember,
    updatedAt: team.updatedAt,
    createdAt: team.createdAt,
  };
}

async function creatorNameOf(team: GoatTeam): Promise<string> {
  try {
    const profile = await getCreatorProfile(team.ownerUserId);
    return profile?.displayName?.trim() || "Room leader";
  } catch {
    return "Room leader";
  }
}

let profileReader: ((uid: string) => Promise<{ displayName?: string } | null>) | null = null;

/** Injected so this module does not need to know how profiles are stored. */
export function setProfileReader(
  reader: (uid: string) => Promise<{ displayName?: string } | null>,
): void {
  profileReader = reader;
}

async function getCreatorProfile(uid: string) {
  if (profileReader) return profileReader(uid);
  const { getFirebaseAdmin } = await import("./firebaseAdmin");
  const admin = getFirebaseAdmin();
  if (!admin) return null;
  const snapshot = await admin.firestore.collection("users").doc(uid).get();
  if (!snapshot.exists) return null;
  return snapshot.data() as { displayName?: string };
}

// ---------------------------------------------------------------------------
// Realtime capability status
// ---------------------------------------------------------------------------

/**
 * What the browser is allowed to know about the server's capabilities.
 *
 * The UI uses this to show an honest "voice is not configured" state rather
 * than a control that silently fails. No secret, no host, no account id.
 */
roomsRouter.get("/realtime/status", (_req, res) => {
  res.json({
    realtime: {
      configured: isRealtimeConfigured(),
      protocolVersion: ROOM_PROTOCOL_VERSION,
      workerConfigured: Boolean(realtimeWorkerUrl()),
      /**
       * The Worker's public url. It is a public endpoint, not a credential:
       * the browser needs it to open the room socket and to upload images.
       * Authorization still comes from the Firebase ID token.
       */
      url: realtimeWorkerUrl(),
    },
    voice: {
      configured: isSfuConfigured(),
      reason: sfuUnavailableReason() ?? null,
    },
    media: {
      configured: mediaConfigured(),
      maxBytes: MEDIA_MAX_BYTES,
      allowedTypes: MEDIA_ALLOWED_TYPES,
    },
  });
});

// ---------------------------------------------------------------------------
// Robot marketplace (strategy-first compatibility layer)
// ---------------------------------------------------------------------------

async function robotForOwner(idOrSlug: string, userId: string, res: Response) {
  const robot = await robotStore.get(idOrSlug);
  if (!robot) { fail(res, 404, 'ROBOT_NOT_FOUND', 'That trading robot does not exist.'); return null; }
  if (robot.ownerUserId !== userId) { fail(res, 403, 'ROBOT_FORBIDDEN', 'Only the robot creator may perform this action.'); return null; }
  return robot;
}

/**
 * Resolves a robot the caller OWNS, for the endpoints that change it.
 *
 * A robot that belongs to somebody else is reported as NOT FOUND rather than
 * forbidden, so these endpoints cannot be used to discover which robots
 * exist. The cover and the broker binding are owner-only, and this is the
 * single place that decision is made.
 */
async function resolveOwnRobot(idOrSlug: unknown, userId: string, res: Response): Promise<RobotRecord | null> {
  const id = typeof idOrSlug === 'string' ? idOrSlug.trim() : '';
  if (!id) { fail(res, 400, 'INVALID_ROBOT', 'A robot is required.'); return null; }
  const robot = await robotStore.get(id);
  if (!robot || robot.ownerUserId !== userId) {
    fail(res, 404, 'ROBOT_NOT_FOUND', 'That trading robot does not exist.');
    return null;
  }
  return robot;
}

/**
 * The shape a robot takes in the directory.
 *
 * The cover is delivered through a freshly signed url, because the stored
 * value is only the object key: a signed url expires, so a stored url would
 * be a broken image tomorrow.
 */
function robotSummary(robot: RobotRecord, options: { includeBrokerAccountId?: boolean } = {}) {
  const coverReference = robot.cover?.key ? toMediaReference(robot.cover, 'robot-cover') : null;
  return {
    ...robot,
    coverUrl: coverReference?.url ?? null,
    coverContentType: robot.cover?.contentType ?? null,
    /**
     * The broker account is a REFERENCE, never a credential — but the
     * account id itself is the creator's own broker identifier, and the
     * directory is public. So the id is only ever given to the owner, and
     * everybody else sees the label and the environment.
     */
    brokerAccount: robot.brokerAccount
      ? {
        provider: robot.brokerAccount.provider,
        accountId: options.includeBrokerAccountId ? robot.brokerAccount.accountId : '',
        label: robot.brokerAccount.label,
        environment: robot.brokerAccount.environment,
        updatedAt: robot.brokerAccount.updatedAt,
      }
      : null,
  };
}

roomsRouter.get('/robot-marketplace', handle(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 80) : '';
  const robots = (await robotStore.listPublic())
    .filter(robot => !query || `${robot.name} ${robot.description} ${robot.market}`.toLowerCase().includes(query))
    // The cover is delivered through a freshly signed url. The stored value
    // is only the object key, so a url stored on the record would be a
    // broken image tomorrow.
    .map(robot => robotSummary(robot));
  res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
  res.json({ robots, total: robots.length });
}));

roomsRouter.get('/robot-marketplace/mine', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ robots: (await robotStore.listForOwner(user.uid)).map(robot => robotSummary(robot, { includeBrokerAccountId: true })) });
}));

roomsRouter.post('/robot-marketplace', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const clientRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientRequestId)) return fail(res, 400, 'INVALID_REQUEST_ID', 'Creation requires a stable client request id.');
  const robotId = `robot_${createHash('sha256').update(`${user.uid}:${clientRequestId}`).digest('hex').slice(0, 24)}`;
  const existing = await robotStore.get(robotId);
  if (existing) {
    if (existing.ownerUserId !== user.uid) return fail(res, 409, 'ROBOT_ID_CONFLICT', 'That creation request id is already in use.');
    res.json({ robot: existing, created: false });
    return;
  }
  const now = new Date().toISOString();
  const versionId = `${robotId}_v1`;
  // The server owns the identity of the version. The client may send either
  // schema version, and an older one is MIGRATED rather than reinterpreted.
  const candidate = {
    ...(req.body?.definition ?? {}), schemaVersion: req.body?.definition?.schemaVersion, strategyId: robotId, versionId, version: 1,
    validationStatus: 'VALID', createdAt: now,
  };
  let definition: StrategyDefinition;
  try {
    definition = migrateStrategyDefinition(candidate);
  } catch (error) {
    return fail(res, 400, 'INVALID_STRATEGY', error instanceof Error ? error.message : 'The strategy could not be read.');
  }
  const slugBase = definition.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'trading-robot';
  const slug = `${slugBase}-${randomBytes(10).toString('hex')}`;
  const profile = await getCreatorProfile(user.uid).catch(() => null);
  const robot = {
    id: robotId, slug, ownerUserId: user.uid, creatorName: profile?.displayName?.trim().slice(0, 80) || 'Robot creator', name: definition.name,
    description: definition.description, visibility: definition.visibility, currentVersionId: versionId, currentVersion: 1,
    market: definition.market.instrument, timeframe: definition.market.timeframe, runtimeStatus: 'STOPPED' as const,
    createdAt: now, updatedAt: now,
  };
  try {
    await robotStore.create(robot, definition);
  } catch (error) {
    if (error instanceof Error && error.message === 'ROBOT_ALREADY_EXISTS') {
      const duplicate = await robotStore.get(robotId);
      if (duplicate?.ownerUserId === user.uid) {
        res.json({ robot: duplicate, created: false });
        return;
      }
    }
    throw error;
  }
  res.status(201).json({ robot, created: true });
}));

roomsRouter.get('/robot-marketplace/:idOrSlug', optionalAuthMiddleware, handle(async (req, res) => {
  const robot = await robotStore.get(req.params.idOrSlug);
  if (!robot) return fail(res, 404, 'ROBOT_NOT_FOUND', 'That trading robot does not exist.');
  const isOwner = req.user?.uid === robot.ownerUserId;
  if (robot.visibility === 'PRIVATE' && !isOwner) return fail(res, 404, 'ROBOT_NOT_FOUND', 'That trading robot does not exist.');
  const stored = await robotStore.definition(robot);
  if (!stored) return fail(res, 500, 'ROBOT_VERSION_MISSING', 'The current immutable strategy version is unavailable.');
  // A version saved before the current schema is MIGRATED on the way out, so
  // the client always receives the shape it knows how to read.
  let definition: StrategyDefinition;
  try {
    definition = migrateStrategyDefinition(stored);
  } catch {
    return fail(res, 500, 'ROBOT_VERSION_INVALID', 'The stored strategy version could not be read.');
  }
  const backtests = isOwner ? await robotStore.listBacktests(robot) : [];
  // The runtime snapshot belongs to the creator alone. It is the PAPER
  // account, and it must never be confused with a live one.
  const runtime = isOwner ? await robotStore.runtime(robot) : null;
  res.setHeader('Cache-Control', isOwner ? 'private, no-store' : 'public, max-age=10');
  res.json({ robot: robotSummary(robot, { includeBrokerAccountId: isOwner }), definition, backtests, runtime, canManage: isOwner });
}));

roomsRouter.get('/robot-marketplace/:idOrSlug/logs', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const robot = await robotForOwner(req.params.idOrSlug, user.uid, res);
  if (!robot) return;
  res.json({ logs: await robotStore.listLogs(robot) });
}));

roomsRouter.get('/robot-marketplace/:idOrSlug/market', optionalAuthMiddleware, handle(async (req, res) => {
  const robot = await robotStore.get(req.params.idOrSlug);
  if (!robot) return fail(res, 404, 'ROBOT_NOT_FOUND', 'That trading robot does not exist.');
  if (robot.visibility === 'PRIVATE' && req.user?.uid !== robot.ownerUserId) return fail(res, 404, 'ROBOT_NOT_FOUND', 'That trading robot does not exist.');
  const definition = await robotStore.definition(robot);
  if (!definition) return fail(res, 500, 'ROBOT_VERSION_MISSING', 'The current strategy version is unavailable.');
  if (definition.market.provider !== 'hyperliquid') return fail(res, 400, 'UNSUPPORTED_MARKET_PROVIDER', 'The browser runner currently supports Hyperliquid completed candles.');
  const rawCandles = await hyperliquidProvider.getCandles(definition.market.instrument, definition.market.timeframe, 300);
  const candles = normalizeCompletedCandles(rawCandles, definition.market.timeframe);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ candles, provider: hyperliquidProvider.name, dataMode: hyperliquidProvider.dataMode, completedOnly: true });
}));

roomsRouter.post('/robot-marketplace/:idOrSlug/start', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const robot = await robotForOwner(req.params.idOrSlug, user.uid, res);
  if (!robot) return;
  const definition = await robotStore.definition(robot);
  if (!definition) return fail(res, 500, 'ROBOT_VERSION_MISSING', 'The current strategy version is unavailable.');
  const previous = await robotStore.runtime(robot) ?? initialRuntimeState(definition);
  const entry = { id: `start_${Date.now()}`, at: new Date().toISOString(), type: 'RUNTIME_STARTED', message: 'Browser paper-trading runtime started. It stops evaluating when the page is closed or suspended.' };
  const state = { ...previous, status: 'PAPER' as const, logs: [...previous.logs, entry] };
  await robotStore.setRuntime(robot, state); await robotStore.appendLogs(robot, [entry]);
  res.json({ state });
}));

roomsRouter.post('/robot-marketplace/:idOrSlug/stop', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const robot = await robotForOwner(req.params.idOrSlug, user.uid, res);
  if (!robot) return;
  const definition = await robotStore.definition(robot);
  if (!definition) return fail(res, 500, 'ROBOT_VERSION_MISSING', 'The current strategy version is unavailable.');
  const previous = await robotStore.runtime(robot) ?? initialRuntimeState(definition);
  const entry = { id: `stop_${Date.now()}`, at: new Date().toISOString(), type: 'RUNTIME_STOPPED', message: 'Paper-trading runtime stopped.' };
  const state = { ...previous, status: 'STOPPED' as const, logs: [...previous.logs, entry] };
  await robotStore.setRuntime(robot, state); await robotStore.appendLogs(robot, [entry]);
  res.json({ state });
}));

roomsRouter.post('/robot-marketplace/:idOrSlug/process', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const robot = await robotForOwner(req.params.idOrSlug, user.uid, res);
  if (!robot) return;
  const definition = await robotStore.definition(robot);
  if (!definition) return fail(res, 500, 'ROBOT_VERSION_MISSING', 'The current strategy version is unavailable.');
  if (definition.market.provider !== 'hyperliquid') return fail(res, 400, 'UNSUPPORTED_MARKET_PROVIDER', 'The browser runner currently supports Hyperliquid completed candles.');
  // Never trust prices supplied by the browser. The authenticated server
  // resolves the robot's immutable market and loads its provider data.
  const rawCandles = await hyperliquidProvider.getCandles(definition.market.instrument, definition.market.timeframe, 600);
  const candles = normalizeCompletedCandles(rawCandles, definition.market.timeframe);
  if (!candles.length) return fail(res, 422, 'INSUFFICIENT_HISTORY', 'The provider returned no completed candles.');
  const previous = await robotStore.runtime(robot) ?? initialRuntimeState(definition);
  const state = processCompletedCandle(definition, previous, candles);
  const newLogs = state.logs.slice(previous.logs.length);
  await robotStore.setRuntime(robot, state); await robotStore.appendLogs(robot, newLogs);
  res.json({ state, processed: state.lastProcessedCandleTime !== previous.lastProcessedCandleTime });
}));

roomsRouter.post('/robot-marketplace/:idOrSlug/backtests', authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const robot = await robotForOwner(req.params.idOrSlug, user.uid, res);
  if (!robot) return;
  const definition = await robotStore.definition(robot);
  if (!definition) return fail(res, 500, 'ROBOT_VERSION_MISSING', 'The current strategy version is unavailable.');
  if (definition.market.provider !== 'hyperliquid') return fail(res, 400, 'UNSUPPORTED_BACKTEST_PROVIDER', 'Robot backtests currently support existing Hyperliquid historical candles.');
  const from = typeof req.body?.from === 'string' ? Date.parse(req.body.from) : Number.NaN;
  const to = typeof req.body?.to === 'string' ? Date.parse(req.body.to) : Number.NaN;
  const rangeBars = requestedBarsForRange(from, to, definition.market.timeframe);
  if ((Number.isFinite(from) || Number.isFinite(to)) && (!rangeBars || from >= Date.now() || to > Date.now() + 60_000)) {
    return fail(res, 400, 'INVALID_BACKTEST_RANGE', 'Choose a completed historical range with a start before its end.');
  }
  const requestedBars = Math.min(5000, Math.max(100, rangeBars || Number(req.body?.bars) || 1000));
  const rawCandles = await hyperliquidProvider.getCandles(definition.market.instrument, definition.market.timeframe, requestedBars);
  const normalized = normalizeCompletedCandles(rawCandles, definition.market.timeframe);
  const candles = rangeBars ? normalized.filter(candle => candle.time >= from && candle.time <= to) : normalized;
  if (candles.length < 50) return fail(res, 422, 'INSUFFICIENT_HISTORY', `Only ${candles.length} candles were available; at least 50 are required.`);
  const result = runStrategyBacktest(definition, candles);
  const createdAt = new Date().toISOString();
  const record = { id: `backtest_${Date.now()}_${randomBytes(4).toString('hex')}`, robotId: robot.id, ownerUserId: user.uid, strategyVersionId: definition.versionId, configuration: { requestedBars, provider: definition.market.provider, instrument: definition.market.instrument, timeframe: definition.market.timeframe, ...(rangeBars ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : {}) }, result, createdAt };
  await robotStore.saveBacktest(record); await robotStore.appendLogs(robot, result.logs.slice(-2));
  // The directory shows whether a robot has VERIFIED performance, so the
  // summary is kept on the robot record. A backtest is a simulation, and the
  // interface says so wherever the number appears.
  await robotStore.setLastBacktest(robot, {
    strategyVersionId: definition.versionId,
    totalReturn: result.metrics.totalReturn,
    winRate: result.metrics.winRate,
    maxDrawdown: result.metrics.maxDrawdown,
    completedTrades: result.metrics.completedTrades,
    at: createdAt,
  });
  res.status(201).json({ backtest: record });
}));

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/**
 * The public room directory.
 *
 * Public rooms only. A private room never appears here, and no private room
 * detail leaks through a query parameter.
 */
roomsRouter.get("/rooms", handle(async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 24, 1),
    MAX_DIRECTORY_ROOMS,
  );

  const teams = (await teamStore.listPublic())
    .filter((team) => team.status !== "DRAFT")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_DIRECTORY_ROOMS);

  const decorated = teams.map((team) => ({ team, settings: roomSettingsOf(team) }));

  const filtered = decorated.filter(({ team, settings }) => {
    if (category && category !== "all" && settings.category !== category) return false;
    if (!query) return true;
    const haystack = [
      team.name,
      team.instructions ?? "",
      settings.category,
      ...settings.markets,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  const page = filtered.slice(0, limit);
  const memberCounts = await memberStore.countByRooms(page.map((item) => item.team.id));
  /**
   * HOW MANY OF EACH ROOM'S MEMBERS ARE ONLINE.
   *
   * The counts come from the room coordinators, which are the only place
   * that knows who holds a live connection. A room whose presence cannot be
   * established reports null, and the card says so rather than showing a
   * number it does not have.
   */
  const presence = await presenceStore
    .getMany(page.map((item) => item.team.id))
    .catch(() => ({}) as Record<string, { onlineCount: number; mentorOnline: boolean }>);
  const rooms = await Promise.all(
    page.map(async ({ team }) => {
      const cover = await mediaStore.getCover(team.id);
      const roomPresence = presence[team.id];
      return roomView(team, GUEST_ACCESS, {
        memberCount: memberCounts[team.id] ?? 0,
        coverUrl: toMediaReference(cover, "room-cover")?.url ?? null,
        creatorName: await creatorNameOf(team),
        live: Boolean(team.activeSessionId),
        onlineCount: roomPresence ? roomPresence.onlineCount : null,
        mentorOnline: roomPresence ? roomPresence.mentorOnline : null,
      });
    }),
  );

  res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
  res.json({ rooms, total: filtered.length });
}));

/**
 * Creates a room.
 *
 * A room is created from a name, a description and a market category. A
 * cover is OPTIONAL and cannot be uploaded before the room exists, so
 * creation never depends on an image upload succeeding.
 */
roomsRouter.post("/rooms", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 80) {
    return fail(res, 400, "INVALID_ROOM_NAME", "A room name must be 2-80 characters.");
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 2000) {
    return fail(res, 400, "INVALID_ROOM_DESCRIPTION", "The description is too long.");
  }
  if (body.visibility !== undefined && body.visibility !== "PUBLIC" && body.visibility !== "PRIVATE") {
    return fail(res, 400, "INVALID_VISIBILITY", "Visibility must be PUBLIC or PRIVATE.");
  }
  const visibility = body.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE";
  if (body.category !== undefined && !isRoomCategory(body.category)) {
    return fail(res, 400, "INVALID_CATEGORY", "That market category does not exist.");
  }
  const category = (body.category as RoomCategory) ?? "general";

  const markets = Array.isArray(body.markets)
    ? body.markets
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0 && value.length <= 24)
        .slice(0, 12)
    : [];

  const chartInput = (body.chart ?? {}) as { symbol?: unknown; timeframe?: unknown };
  const symbol =
    typeof chartInput.symbol === "string" && isValidSymbol(chartInput.symbol)
      ? chartInput.symbol
      : "XAUUSD";
  const timeframe =
    typeof chartInput.timeframe === "string" && isValidTimeframe(chartInput.timeframe)
      ? chartInput.timeframe
      : "15m";

  const now = new Date().toISOString();
  const slugBase =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) ||
    "trading-room";
  // A private link is a capability URL: a long random suffix, and the room
  // never appears in public discovery.
  const shareSlug = `${slugBase}-${randomBytes(18).toString("hex")}`;

  const team = await teamStore.save({
    id: `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: user.uid,
    name,
    instructions: description || undefined,
    memberGoatIds: [],
    coordinationMode: "INDEPENDENT",
    visibility,
    publicSlug: shareSlug,
    environment: "DEMO",
    marketDataProvider: "biquote",
    monitoringIntervals: [15],
    deployment: { provider: "ctrader", asset: symbol, risk: {} },
    settings: {
      category,
      markets,
      chart: { symbol, timeframe },
      allowDrawings: body.allowDrawings !== false,
      voiceEnabled: body.voiceEnabled !== false,
      maxMembers: 100,
    },
    status: "DEPLOYED",
    deployedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // The creator is a member of the room they just made.
  await memberStore.join(team.id, user.uid, user.email ?? "Room leader");

  const access = await resolveRoomAccess(team, user.uid);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    room: roomView(team, access, { memberCount: 1, creatorName: user.email ?? "Room leader" }),
    shareUrl: `/team/${shareSlug}`,
    discoverable: visibility === "PUBLIC",
  });
}));

/**
 * WHO IS IN THE ROOM RIGHT NOW.
 *
 * The counts come from the room's Durable Object, which is the only place
 * that knows who holds a live connection. A count that cannot be
 * established is reported as null, NOT as zero: "0 online" and "we do not
 * know" are different facts, and only one of them is a lie.
 */
roomsRouter.get("/rooms/:roomId/presence", optionalAuthMiddleware, handle(async (req, res) => {
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const presence = await presenceStore.get(team.id).catch(() => null);
  const isMember = req.user?.uid
    ? await resolveRoomAccess(team, req.user.uid).then((access) => access.isMember)
    : false;

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    /**
     * Null means UNKNOWN: the room has no live coordinator, or its last
     * snapshot is too old to trust. The UI shows a neutral state.
     */
    onlineCount: presence ? presence.onlineCount : null,
    mentorOnline: presence ? presence.mentorOnline : null,
    updatedAt: presence?.updatedAt ?? null,
    /**
     * The identities behind the count are only for members: a private room's
     * roster must not be enumerable by a visitor.
     */
    members: isMember
      ? (presence?.members ?? []).map((member) => ({
          uid: member.uid,
          name: member.name,
          role: member.role,
        }))
      : [],
  });
}));

/**
 * THE ROOM'S REGISTERED MEMBERS.
 *
 * A member of the room may see who else belongs to it, with each person's
 * presence. A visitor may not: enumerating a private room's membership is
 * not something a link-holder may do.
 */
roomsRouter.get("/rooms/:roomId/members", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.isMember) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join this room to see who is in it.");
  }

  const presence = await presenceStore.get(team.id).catch(() => null);
  const onlineUids = new Set((presence?.members ?? []).map((member) => member.uid));
  const avatarFor = avatarLookup();

  const registered = await memberStore.list(team.id).catch(() => []);
  const leaderName = await creatorNameOf(team);
  const roster = [
    {
      uid: team.ownerUserId,
      name: leaderName,
      role: "OWNER" as const,
      joinedAt: null as string | null,
    },
    ...registered
      .filter((member) => member.userId !== team.ownerUserId)
      .map((member) => ({
        uid: member.userId,
        name: member.displayName,
        role: "MEMBER" as const,
        joinedAt: member.joinedAt,
      })),
  ];

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    members: await Promise.all(
      roster.map(async (member) => ({
        ...member,
        online: onlineUids.has(member.uid),
        avatarUrl: await avatarFor(member.uid),
      })),
    ),
    onlineCount: presence ? presence.onlineCount : null,
    mentorOnline: presence ? presence.mentorOnline : null,
    totalMembers: roster.length,
  });
}));

/**
 * The rooms the signed-in user owns or has joined.
 *
 * This is the "My Rooms" tab. It is a different query from the public
 * directory: it is scoped to the viewer, so it is never cached publicly.
 */
roomsRouter.get("/rooms/mine", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const owned = await teamStore.listForUser(user.uid);
  const joined = await memberStore.listForUser(user.uid).catch(() => []);

  const memberRoomIds = new Set(
    joined.map((record) => record.roomId).filter((id) => id !== user.uid),
  );
  const joinedTeams: GoatTeam[] = [];
  for (const roomId of memberRoomIds) {
    const team = await teamStore.getById(roomId);
    if (team) joinedTeams.push(team);
  }

  const all = [...owned, ...joinedTeams].filter(
    (team, index, list) => list.findIndex((other) => other.id === team.id) === index,
  );
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const memberCounts = await memberStore.countByRooms(all.map((team) => team.id));
  const rooms = await Promise.all(
    all.map(async (team) => {
      const access = await resolveRoomAccess(team, user.uid);
      const cover = await mediaStore.getCover(team.id);
      const session = await sessionStore.getActive(team.id).catch(() => null);
      return roomView(team, access, {
        memberCount: memberCounts[team.id] ?? 0,
        coverUrl: toMediaReference(cover, "room-cover")?.url ?? null,
        creatorName: await creatorNameOf(team),
        live: Boolean(session),
      });
    }),
  );

  res.setHeader("Cache-Control", "private, no-store");
  res.json({ rooms });
}));

/**
 * One room's details.
 *
 * A private room is only readable by its members. A public room is readable
 * by anyone, but the response is still shaped by the VIEWER: a visitor gets
 * no cover image of a private room, no member list, and no management rights.
 */
roomsRouter.get("/rooms/:roomId", optionalAuthMiddleware, handle(async (req, res) => {
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }

  const uid = req.user?.uid ?? null;
  const access = await resolveRoomAccess(team, uid);
  if (!canWatchRoom(team, access)) {
    return fail(
      res,
      403,
      "ROOM_NOT_JOINED",
      "This is a private room. Join it to see what is inside.",
    );
  }

  const members = access.isMember
    ? await memberStore.list(team.id).catch(() => [])
    : [];
  const memberCount = access.isMember
    ? members.length + 1
    : (await memberStore.countByRooms([team.id]))[team.id] ?? 0;

  const cover = access.isMember ? await mediaStore.getCover(team.id) : null;
  const session = await sessionStore.getActive(team.id).catch(() => null);
  const chart = await chartStateStore.get(team.id).catch(() => null);
  const settings = roomSettingsOf(team);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    room: roomView(team, access, {
      memberCount,
      coverUrl: toMediaReference(cover, "room-cover")?.url ?? null,
      creatorName: await creatorNameOf(team),
      live: Boolean(session),
    }),
    members: members.map((member) => ({
      id: member.userId,
      name: member.displayName,
      role: member.userId === team.ownerUserId ? "OWNER" : "MEMBER",
      joinedAt: member.joinedAt,
    })),
    session,
    chart,
    settings,
  });
}));

/**
 * Edits a room.
 *
 * Only an owner or a leader may call this, and only for the fields their
 * role allows. A member gets 403; an anonymous visitor gets 401.
 */
roomsRouter.patch("/rooms/:roomId", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canManage) {
    return fail(
      res,
      403,
      "ROOM_NOT_MANAGED",
      "Only the room owner or a leader can change these settings.",
    );
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Partial<GoatTeam> = {};
  const settings = { ...(team.settings ?? {}) };

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 2 || name.length > 80) {
      return fail(res, 400, "INVALID_ROOM_NAME", "A room name must be 2-80 characters.");
    }
    updates.name = name;
  }

  if (typeof body.description === "string" || typeof body.instructions === "string") {
    const description = String(body.description ?? body.instructions ?? "").trim();
    if (description.length > 2000) {
      return fail(res, 400, "INVALID_ROOM_DESCRIPTION", "The description is too long.");
    }
    updates.instructions = description;
  }

  if (typeof body.visibility === "string") {
    if (body.visibility !== "PUBLIC" && body.visibility !== "PRIVATE") {
      return fail(res, 400, "INVALID_VISIBILITY", "Visibility must be PUBLIC or PRIVATE.");
    }
    updates.visibility = body.visibility;
  }

  if (body.category !== undefined) {
    if (!isRoomCategory(body.category)) {
      return fail(res, 400, "INVALID_CATEGORY", "That market category does not exist.");
    }
    settings.category = body.category;
  }

  if (Array.isArray(body.markets)) {
    settings.markets = body.markets
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value.length > 0 && value.length <= 24)
      .slice(0, 12);
  }

  if (body.chart && typeof body.chart === "object") {
    const chart = body.chart as { symbol?: unknown; timeframe?: unknown };
    const next = { ...(settings.chart ?? {}) };
    if (chart.symbol !== undefined) {
      if (!isValidSymbol(chart.symbol)) {
        return fail(res, 400, "INVALID_SYMBOL", "That is not a valid instrument.");
      }
      next.symbol = chart.symbol;
    }
    if (chart.timeframe !== undefined) {
      if (!isValidTimeframe(chart.timeframe)) {
        return fail(res, 400, "INVALID_TIMEFRAME", "That is not a supported timeframe.");
      }
      next.timeframe = chart.timeframe;
    }
    settings.chart = next;
  }

  if (body.allowDrawings !== undefined) {
    if (typeof body.allowDrawings !== "boolean") {
      return fail(res, 400, "INVALID_SETTING", "allowDrawings must be true or false.");
    }
    settings.allowDrawings = body.allowDrawings;
  }

  if (body.voiceEnabled !== undefined) {
    if (typeof body.voiceEnabled !== "boolean") {
      return fail(res, 400, "INVALID_SETTING", "voiceEnabled must be true or false.");
    }
    settings.voiceEnabled = body.voiceEnabled;
  }

  if (body.maxMembers !== undefined) {
    const maxMembers = Number(body.maxMembers);
    if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 1000) {
      return fail(res, 400, "INVALID_SETTING", "maxMembers must be between 1 and 1000.");
    }
    settings.maxMembers = maxMembers;
  }

  if (body.coverKey !== undefined) {
    if (body.coverKey === null) {
      await mediaStore.clearCover(team.id);
    } else if (typeof body.coverKey === "string") {
      const cover = await mediaStore.getCover(team.id);
      if (!cover || cover.key !== body.coverKey) {
        return fail(res, 400, "INVALID_COVER", "That cover image was not uploaded for this room.");
      }
    }
  }

  updates.settings = settings;
  updates.updatedAt = new Date().toISOString();

  const saved = await teamStore.save({ ...team, ...updates });
  const cover = await mediaStore.getCover(saved.id);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    room: roomView(saved, access, {
      coverUrl: toMediaReference(cover, "room-cover")?.url ?? null,
      creatorName: await creatorNameOf(saved),
    }),
    settings: roomSettingsOf(saved),
  });
}));

/**
 * Joins a room.
 *
 * The share link IS the invitation. Holding the link lets a signed-in user
 * create their membership; it does not by itself grant access to a private
 * room's content, which still requires the membership this call creates.
 */
roomsRouter.post("/rooms/:roomId/join", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }

  const members = await memberStore.list(team.id);
  const settings = roomSettingsOf(team);
  if (members.length + 1 >= settings.maxMembers) {
    return fail(res, 409, "ROOM_FULL", "This room has reached its member limit.");
  }

  const existing = await memberStore.get(team.id, user.uid);
  const record = await memberStore.join(team.id, user.uid, req.user?.email ?? "Member");
  const access = await resolveRoomAccess(team, user.uid);
  const cover = await mediaStore.getCover(team.id);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    joined: true,
    alreadyMember: Boolean(existing),
    role: access.role,
    member: {
      id: record.userId,
      name: record.displayName,
      role: record.role,
      joinedAt: record.joinedAt,
    },
    room: roomView(team, access, {
      memberCount: members.length + 1,
      coverUrl: toMediaReference(cover, "room-cover")?.url ?? null,
    }),
  });
}));

// ---------------------------------------------------------------------------
// The room conversation
// ---------------------------------------------------------------------------

/**
 * The room conversation.
 *
 * The same messages the legacy route serves, plus the two things a
 * messaging panel needs and a legacy feed never had: how many messages
 * are UNREAD, and where the reader's cursor is.
 */
roomsRouter.get("/rooms/:roomId/chat", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.isMember) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join this room to read its conversation.");
  }

  const chatId = roomConversationId(team.id);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(String(req.query.limit || ROOM_MESSAGE_PAGE_LIMIT), 10) || ROOM_MESSAGE_PAGE_LIMIT),
  );
  const since = typeof req.query.since === "string" ? req.query.since : "";
  const before = typeof req.query.before === "string" ? req.query.before : "";

  const messages = since
    ? await persistence.messages.listSince(chatId, since, limit)
    : before
      ? await persistence.messages.listBefore(chatId, before, limit)
      : await persistence.messages.listLatest(chatId, limit);

  let hasMore = false;
  if (!since) {
    const oldest = messages[0]?.createdAt;
    hasMore = oldest
      ? (await persistence.messages.listBefore(chatId, oldest, 1)).length > 0
      : false;
  }

  /**
   * THE UNREAD COUNT.
   *
   * The messages newer than the reader's cursor, minus the reader's own:
   * a person never has unread messages of their own making. The count is
   * capped so a very long backlog cannot turn into an unbounded read.
   */
  const cursor = await readCursorStore.get(user.uid, team.id).catch(() => null);
  let unreadCount = 0;
  if (cursor?.lastReadAt) {
    const newer = await persistence.messages
      .listSince(chatId, cursor.lastReadAt, 500)
      .catch(() => [] as ChatMessage[]);
    unreadCount = newer.filter((message) => message.userId !== user.uid).length;
  } else {
    /**
     * No cursor at all: the reader has never read this room, so everything
     * that is not their own is unread.
     */
    const all = await persistence.messages
      .listLatest(chatId, 500)
      .catch(() => [] as ChatMessage[]);
    unreadCount = all.filter((message) => message.userId !== user.uid).length;
  }

  const avatarFor = avatarLookup();
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    messages: await Promise.all(
      messages.map(async (message) => ({
        id: message.id,
        authorId: message.userId,
        authorName: message.authorName ?? "Member",
        authorAvatarUrl: await avatarFor(message.userId),
        content: message.content,
        createdAt: message.createdAt,
        role: message.role,
      })),
    ),
    hasMore,
    unreadCount,
    lastReadMessageId: cursor?.lastReadMessageId ?? null,
  });
}));

/** Posts a message in the room conversation. */
roomsRouter.post("/rooms/:roomId/chat", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.isMember) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join this room before posting in its conversation.");
  }

  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  if (!content) {
    return fail(res, 400, "EMPTY_MESSAGE", "Write something before posting.");
  }
  if (content.length > ROOM_MESSAGE_MAX_LENGTH) {
    return fail(res, 400, "MESSAGE_TOO_LENGTH", `Messages must be ${ROOM_MESSAGE_MAX_LENGTH} characters or fewer.`);
  }

  const chatId = roomConversationId(team.id);
  const now = new Date().toISOString();
  const existing = await persistence.chats.get(chatId);
  if (!existing) {
    await persistence.chats.create({
      id: chatId,
      userId: team.ownerUserId,
      title: team.name,
      kind: "room",
      roomId: team.id,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    });
  }

  const message: ChatMessage = {
    id: `msg_${Date.now()}_${randomBytes(6).toString("hex")}`,
    chatId,
    userId: user.uid,
    role: "user",
    content,
    authorName: (await creatorNameOf(team)) || "Member",
    createdAt: now,
  };
  await persistence.messages.create(chatId, message);
  await persistence.chats.update(chatId, { updatedAt: now, lastMessageAt: now });

  const avatarFor = avatarLookup();
  res.status(201).json({
    message: {
      id: message.id,
      authorId: message.userId,
      authorName: message.authorName ?? "Member",
      authorAvatarUrl: await avatarFor(message.userId),
      content: message.content,
      createdAt: message.createdAt,
      role: message.role,
    },
  });
}));

/**
 * RECORDS THAT THE READER HAS SEEN A MESSAGE.
 *
 * The message must belong to THIS room's conversation: a cursor that
 * pointed at somebody else's conversation would let a reader claim to have
 * read a room they never opened.
 */
roomsRouter.post("/rooms/:roomId/chat/read", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.isMember) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join this room to read its conversation.");
  }

  const messageId = typeof req.body?.messageId === "string" ? req.body.messageId.trim() : "";
  if (!messageId) {
    return fail(res, 400, "INVALID_MESSAGE", "No message was supplied.");
  }

  const chatId = roomConversationId(team.id);
  const page = await persistence.messages.listLatest(chatId, 200);
  let message = page.find((entry) => entry.id === messageId);
  if (!message) {
    // The message may be older than the newest page. That is not an error.
    const older = await persistence.messages.listBefore(
      chatId,
      page[0]?.createdAt ?? "",
      100,
    );
    message = older.find((entry) => entry.id === messageId);
  }
  if (!message) {
    return fail(res, 404, "MESSAGE_NOT_FOUND", "That message is not part of this room's conversation.");
  }

  await readCursorStore.set(user.uid, team.id, {
    messageId: message.id,
    createdAt: message.createdAt,
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ ok: true, unreadCount: 0 });
}));

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

roomsRouter.get("/rooms/:roomId/session", optionalAuthMiddleware, handle(async (req, res) => {
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const session = await sessionStore.getActive(team.id).catch(() => null);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ session });
}));

/**
 * Starts or ends a live session.
 *
 * The transition is decided here, on the server, from the caller's verified
 * role. A member pressing "Start session" gets 403 whether or not the button
 * was hidden.
 */
roomsRouter.post("/rooms/:roomId/session", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canRunSession) {
    return fail(
      res,
      403,
      "ROOM_NOT_MANAGED",
      "Only the room owner or a leader can run the live session.",
    );
  }

  const action = String((req.body ?? {}).action ?? "");
  if (action !== "start" && action !== "end") {
    return fail(res, 400, "INVALID_SESSION_ACTION", "Action must be start or end.");
  }

  if (action === "start") {
    const settings = roomSettingsOf(team);
    const body = (req.body ?? {}) as { symbol?: unknown; timeframe?: unknown };
    const symbol =
      typeof body.symbol === "string" && isValidSymbol(body.symbol)
        ? body.symbol
        : settings.chart.symbol;
    const timeframe =
      typeof body.timeframe === "string" && isValidTimeframe(body.timeframe)
        ? body.timeframe
        : settings.chart.timeframe;

    let session;
    try {
      session = await sessionStore.start({
        roomId: team.id,
        startedBy: user.uid,
        startedByName: team.ownerUserId === user.uid ? undefined : "Leader",
        symbol,
        timeframe,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "ROOM_SESSION_ALREADY_ACTIVE") {
        const active = await sessionStore.getActive(team.id);
        return fail(
          res,
          409,
          "ROOM_SESSION_ALREADY_ACTIVE",
          "A live session is already running in this room.",
        );
      }
      throw error;
    }

    const saved = await teamStore.save({
      ...team,
      activeSessionId: session.id,
      settings: { ...(team.settings ?? {}), chart: { symbol, timeframe } },
      updatedAt: new Date().toISOString(),
    });
    await pushSessionState(saved.id, session);

    res.setHeader("Cache-Control", "private, no-store");
    res.json({ session, room: roomView(saved, access) });
    return;
  }

  const active = await sessionStore.getActive(team.id);
  if (!active) {
    return fail(res, 404, "ROOM_SESSION_NOT_ACTIVE", "There is no live session to end.");
  }
  const ended = await sessionStore.end(team.id, active.id);
  const saved = await teamStore.save({
    ...team,
    activeSessionId: null,
    updatedAt: new Date().toISOString(),
  });
  await pushSessionState(saved.id, ended);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({ session: ended, room: roomView(saved, access) });
}));

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

function voiceParticipantsOf(entries: { uid: string; name: string; muted: boolean; speaking: boolean; sessionId?: string; trackName?: string }[]) {
  return entries.map((entry) => ({
    id: entry.uid,
    uid: entry.uid,
    name: entry.name,
    muted: entry.muted,
    speaking: entry.speaking,
    sessionId: entry.sessionId,
    trackName: entry.trackName,
  }));
}

roomsRouter.get("/rooms/:roomId/voice", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canUseVoice) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join the room to use its voice session.");
  }
  const entries = await voiceStore.list(team.id);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    enabled: roomSettingsOf(team).voiceEnabled,
    participants: voiceParticipantsOf(entries),
    configured: isSfuConfigured(),
    reason: sfuUnavailableReason() ?? null,
  });
}));

/**
 * Publishes the caller's microphone.
 *
 * The browser has already captured the track and produced an offer; the
 * server owns the SFU session and returns the answer.
 */
roomsRouter.post("/rooms/:roomId/voice/publish", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canUseVoice) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join the room to use its voice session.");
  }
  if (!roomSettingsOf(team).voiceEnabled) {
    return fail(res, 403, "ROOM_VOICE_DISABLED", "Voice is disabled in this room.");
  }

  const body = (req.body ?? {}) as { sdp?: unknown; mid?: unknown; name?: unknown };
  if (typeof body.sdp !== "string" || body.sdp.length > 200_000) {
    return fail(res, 400, "INVALID_SDP", "The browser did not send a usable offer.");
  }
  if (typeof body.mid !== "string" || body.mid.length > 32) {
    return fail(res, 400, "INVALID_TRACK", "The browser did not identify a track to publish.");
  }

  const published = await publishMicrophone({ sdp: body.sdp, mid: body.mid });
  const entry = {
    id: user.uid,
    uid: user.uid,
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 60)
        : "Member",
    muted: false,
    speaking: false,
    sessionId: published.sessionId,
    trackName: "microphone",
    joinedAt: Date.now(),
  };
  await voiceStore.set(team.id, user.uid, entry);
  const entries = await voiceStore.list(team.id);
  await broadcastRoster(team.id, voiceParticipantsOf(entries), true);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({ sessionId: published.sessionId, answer: published.answer });
}));

/**
 * Subscribes the caller to the other participants' microphones.
 *
 * One receiving connection carries every remote publication, which is how
 * the SFU is designed to be used.
 */
roomsRouter.post("/rooms/:roomId/voice/subscribe", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canUseVoice) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join the room to use its voice session.");
  }

  const entries = await voiceStore.list(team.id);
  const publications = entries
    .filter((entry) => entry.uid !== user.uid && entry.sessionId)
    .map((entry) => ({ sessionId: entry.sessionId!, trackName: entry.trackName ?? "microphone" }));

  const subscription = await subscribeToRoster(publications);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    sessionId: subscription.sessionId,
    offer: subscription.offer ?? null,
    tracks: subscription.tracks,
  });
}));

/** Completes the receiving handshake with the browser's answer. */
roomsRouter.post("/rooms/:roomId/voice/answer", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canUseVoice) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join the room to use its voice session.");
  }
  const body = (req.body ?? {}) as { sessionId?: unknown; sdp?: unknown };
  if (typeof body.sessionId !== "string" || typeof body.sdp !== "string") {
    return fail(res, 400, "INVALID_SDP", "The browser did not send a usable answer.");
  }
  await completeSubscription(body.sessionId, { type: "answer", sdp: body.sdp });
  res.json({ ok: true });
}));

/** Mutes or unmutes the caller's microphone. */
roomsRouter.post("/rooms/:roomId/voice/mute", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canUseVoice) {
    return fail(res, 403, "ROOM_NOT_JOINED", "Join the room to use its voice session.");
  }
  const body = (req.body ?? {}) as { muted?: unknown };
  if (typeof body.muted !== "boolean") {
    return fail(res, 400, "INVALID_SETTING", "muted must be true or false.");
  }
  const entries = await voiceStore.list(team.id);
  const existing = entries.find((entry) => entry.uid === user.uid);
  if (!existing) {
    return fail(res, 404, "ROOM_VOICE_NOT_JOINED", "You are not in the voice session.");
  }
  await voiceStore.set(team.id, user.uid, { ...existing, muted: body.muted });
  const updated = await voiceStore.list(team.id);
  await broadcastRoster(team.id, voiceParticipantsOf(updated), true);
  res.json({ ok: true, muted: body.muted });
}));

/** Leaves the voice session without leaving the room. */
roomsRouter.post("/rooms/:roomId/voice/leave", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const team = await resolveTeam(req.params.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const entries = await voiceStore.list(team.id);
  const existing = entries.find((entry) => entry.uid === user.uid);
  if (existing?.sessionId) {
    await closeVoiceSession(existing.sessionId);
  }
  await voiceStore.remove(team.id, user.uid);
  const updated = await voiceStore.list(team.id);
  await broadcastRoster(team.id, voiceParticipantsOf(updated), true);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** The signed-in user's own profile, including a signed avatar url. */
roomsRouter.get("/profile", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const admin = (await import("./firebaseAdmin")).getFirebaseAdmin();
  let displayName = "";
  let email = user.email ?? "";
  let photo: { key: string; contentType: string; size: number; updatedAt: string } | null = null;
  if (admin) {
    const snapshot = await admin.firestore.collection("users").doc(user.uid).get();
    if (snapshot.exists) {
      const data = snapshot.data() as { displayName?: string; email?: string; photo?: typeof photo };
      displayName = data.displayName ?? "";
      email = data.email ?? email;
      photo = data.photo ?? null;
    }
  }
  const reference = toMediaReference(photo, "avatar");
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    profile: { id: user.uid, displayName, email },
    avatar: reference,
    avatarUrl: reference?.url ?? null,
  });
}));

// ---------------------------------------------------------------------------
// Media uploads (Cloudflare R2)
// ---------------------------------------------------------------------------

/**
 * Issues a signed upload ticket.
 *
 * The server decides the object key, the size limit and the expiry. The
 * browser cannot choose a key, so it cannot overwrite another user's image.
 */
roomsRouter.post("/media/upload-ticket", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  if (!mediaConfigured()) {
    return fail(
      res,
      503,
      "MEDIA_NOT_CONFIGURED",
      "Image uploads are not configured on this server.",
    );
  }

  const body = (req.body ?? {}) as { purpose?: unknown; roomId?: unknown; robotId?: unknown; contentType?: unknown };
  const purpose = body.purpose as MediaPurpose;
  if (purpose !== "avatar" && purpose !== "room-cover" && purpose !== "robot-cover") {
    return fail(res, 400, "INVALID_PURPOSE", "purpose must be avatar, room-cover or robot-cover.");
  }

  let team: GoatTeam | null = null;
  if (purpose === "robot-cover") {
    const robot = await resolveOwnRobot(body.robotId, user.uid, res);
    if (!robot) return;
  }
  if (purpose === "room-cover") {
    if (typeof body.roomId !== "string") {
      return fail(res, 400, "INVALID_ROOM", "A room is required for a room cover.");
    }
    team = await resolveTeam(body.roomId);
    if (!team) {
      return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
    }
    const access = await resolveRoomAccess(team, user.uid);
    if (!access.canManage) {
      return fail(
        res,
        403,
        "ROOM_NOT_MANAGED",
        "Only the room owner or a leader can change the room cover.",
      );
    }
  }

  const contentType = typeof body.contentType === "string" ? body.contentType : "image/jpeg";
  if (!MEDIA_ALLOWED_TYPES.includes(contentType)) {
    return fail(
      res,
      400,
      "UNSUPPORTED_IMAGE_TYPE",
      "Upload a PNG, JPEG, WebP or GIF image.",
    );
  }

  const key = buildMediaKey({
    purpose,
    uid: user.uid,
    contentType,
    random: randomBytes(8).toString("hex"),
  });
  const ticket = createUploadTicket({ key, purpose, uid: user.uid, contentType });
  if (!ticket) {
    return fail(res, 503, "MEDIA_NOT_CONFIGURED", "Image uploads are not configured on this server.");
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.json({ ticket });
}));

/**
 * Commits an upload.
 *
 * The server checks that the key belongs to this caller and this purpose
 * before it records it, so a client cannot claim somebody else's object.
 */
roomsRouter.post("/media/commit", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const body = (req.body ?? {}) as {
    key?: unknown;
    purpose?: unknown;
    roomId?: unknown;
    robotId?: unknown;
    contentType?: unknown;
    size?: unknown;
  };
  if (typeof body.key !== "string" || !body.key) {
    return fail(res, 400, "INVALID_KEY", "No image key was supplied.");
  }
  const purpose = body.purpose as MediaPurpose;
  if (purpose !== "avatar" && purpose !== "room-cover" && purpose !== "robot-cover") {
    return fail(res, 400, "INVALID_PURPOSE", "purpose must be avatar, room-cover or robot-cover.");
  }

  const expectedPrefix = purpose === "avatar" ? "avatars/" : "covers/";
  if (!body.key.startsWith(expectedPrefix)) {
    return fail(res, 400, "INVALID_KEY", "That image key does not belong to this upload.");
  }
  if (!body.key.includes(`/${user.uid}/`)) {
    return fail(res, 403, "INVALID_KEY", "That image key belongs to somebody else.");
  }

  const contentType = typeof body.contentType === "string" ? body.contentType : "image/jpeg";
  if (!MEDIA_ALLOWED_TYPES.includes(contentType)) {
    return fail(res, 400, "UNSUPPORTED_IMAGE_TYPE", "Upload a PNG, JPEG, WebP or GIF image.");
  }
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0 || size > MEDIA_MAX_BYTES) {
    return fail(res, 400, "IMAGE_TOO_LARGE", "That image is too large.");
  }

  const stored = {
    key: body.key,
    contentType,
    size,
    updatedAt: new Date().toISOString(),
  };

  if (purpose === "avatar") {
    const previous = await mediaStore.getAvatar(user.uid);
    await mediaStore.setAvatar(user.uid, stored);
    if (previous && previous.key !== stored.key) {
      await deleteMediaObject(previous.key);
    }
    const reference = toMediaReference(stored, "avatar");
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ avatar: reference, avatarUrl: reference?.url ?? null });
    return;
  }

  if (purpose === "robot-cover") {
    const robot = await resolveOwnRobot(body.robotId, user.uid, res);
    if (!robot) return;
    const previous = robot.cover;
    await robotStore.setCover(robot, { ...stored });
    // The replaced object is deleted, so a robot that changes its cover does
    // not leave an orphan image in the bucket forever.
    if (previous && previous.key !== stored.key) {
      await deleteMediaObject(previous.key);
    }
    const reference = toMediaReference(stored, "robot-cover");
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ robotCover: reference, robotCoverUrl: reference?.url ?? null });
    return;
  }

  if (typeof body.roomId !== "string") {
    return fail(res, 400, "INVALID_ROOM", "A room is required for a room cover.");
  }
  const team = await resolveTeam(body.roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, user.uid);
  if (!access.canManage) {
    return fail(
      res,
      403,
      "ROOM_NOT_MANAGED",
      "Only the room owner or a leader can change the room cover.",
    );
  }
  const previous = await mediaStore.getCover(team.id);
  await mediaStore.setCover(team.id, stored);
  if (previous && previous.key !== stored.key) {
    await deleteMediaObject(previous.key);
  }
  const reference = toMediaReference(stored, "room-cover");
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ cover: reference, coverUrl: reference?.url ?? null });
}));

/** Removes an image and clears the reference. */
roomsRouter.post("/media/remove", authMiddleware, handle(async (req, res) => {
  const user = requireUser(req);
  const body = (req.body ?? {}) as { purpose?: unknown; roomId?: unknown; robotId?: unknown };
  const purpose = body.purpose as MediaPurpose;

  if (purpose === "avatar") {
    const previous = await mediaStore.getAvatar(user.uid);
    await mediaStore.clearAvatar(user.uid);
    if (previous) await deleteMediaObject(previous.key);
    res.json({ ok: true, avatarUrl: null });
    return;
  }

  if (purpose === "robot-cover") {
    const robot = await resolveOwnRobot(body.robotId, user.uid, res);
    if (!robot) return;
    const previous = robot.cover;
    // Clearing the cover restores the designed default artwork on the card.
    await robotStore.clearCover(robot);
    if (previous) await deleteMediaObject(previous.key);
    res.json({ ok: true, robotCoverUrl: null });
    return;
  }

  if (purpose === "room-cover") {
    if (typeof body.roomId !== "string") {
      return fail(res, 400, "INVALID_ROOM", "A room is required for a room cover.");
    }
    const team = await resolveTeam(body.roomId);
    if (!team) {
      return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
    }
    const access = await resolveRoomAccess(team, user.uid);
    if (!access.canManage) {
      return fail(res, 403, "ROOM_NOT_MANAGED", "Only the room owner or a leader can change the room cover.");
    }
    const previous = await mediaStore.getCover(team.id);
    await mediaStore.clearCover(team.id);
    if (previous) await deleteMediaObject(previous.key);
    res.json({ ok: true, coverUrl: null });
    return;
  }

  fail(res, 400, "INVALID_PURPOSE", "purpose must be avatar, room-cover or robot-cover.");
}));

// ---------------------------------------------------------------------------
// Internal service endpoints (called by the Cloudflare Worker)
// ---------------------------------------------------------------------------

/**
 * The Worker asks the API whether a user may join a room.
 *
 * This is where room authorization actually happens. The Worker holds no
 * Firestore credentials and no membership data; it asks the API, which
 * answers from the authoritative store.
 */
roomsRouter.get("/internal/rooms/access", handle(async (req, res) => {
  const roomId = String(req.query.roomId ?? "");
  const uid = String(req.query.uid ?? "");
  const signature = req.header("x-tradingvibes-service") ?? null;
  if (!roomId || !uid) {
    return fail(res, 400, "INVALID_REQUEST", "roomId and uid are required.");
  }
  if (!verifyServiceRequest("room-access", accessSubject(roomId, uid), signature)) {
    return fail(res, 401, "INVALID_SERVICE_SIGNATURE", "Service signature rejected.");
  }

  const team = await resolveTeam(roomId);
  if (!team) {
    res.json({ allowed: false, reason: "ROOM_NOT_FOUND" });
    return;
  }
  const access = await resolveRoomAccess(team, uid);
  res.json({
    allowed: canWatchRoom(team, access),
    role: access.role,
    canChat: access.canChat,
    canDraw: access.canDraw,
    canUseVoice: access.canUseVoice,
    canManage: access.canManage,
    canRunSession: access.canRunSession,
    name: team.name,
    symbol: roomSettingsOf(team).chart.symbol,
    timeframe: roomSettingsOf(team).chart.timeframe,
    voiceEnabled: roomSettingsOf(team).voiceEnabled,
  });
}));

/**
 * The Worker asks the API to persist a session transition.
 *
 * The acting user is passed as a parameter, not trusted: the API resolves
 * that user's role from the room document before it acts.
 */
roomsRouter.post("/internal/rooms/session", handle(async (req, res) => {
  const body = (req.body ?? {}) as {
    roomId?: unknown;
    action?: unknown;
    uid?: unknown;
    symbol?: unknown;
    timeframe?: unknown;
  };
  const roomId = String(body.roomId ?? "");
  const uid = String(body.uid ?? "");
  const action = String(body.action ?? "");
  const signature = req.header("x-tradingvibes-service") ?? null;
  if (!roomId || !uid) {
    return fail(res, 400, "INVALID_REQUEST", "roomId and uid are required.");
  }
  if (!verifyServiceRequest("room-session", roomSubject(roomId), signature)) {
    return fail(res, 401, "INVALID_SERVICE_SIGNATURE", "Service signature rejected.");
  }

  const team = await resolveTeam(roomId);
  if (!team) {
    return fail(res, 404, "ROOM_NOT_FOUND", "That room does not exist.");
  }
  const access = await resolveRoomAccess(team, uid);
  if (!access.canRunSession) {
    return fail(res, 403, "ROOM_NOT_MANAGED", "That user may not run the live session.");
  }

  if (action === "start") {
    const settings = roomSettingsOf(team);
    const symbol =
      typeof body.symbol === "string" && isValidSymbol(body.symbol)
        ? body.symbol
        : settings.chart.symbol;
    const timeframe =
      typeof body.timeframe === "string" && isValidTimeframe(body.timeframe)
        ? body.timeframe
        : settings.chart.timeframe;
    try {
      const session = await sessionStore.start({
        roomId: team.id,
        startedBy: uid,
        symbol,
        timeframe,
      });
      await teamStore.save({
        ...team,
        activeSessionId: session.id,
        settings: { ...(team.settings ?? {}), chart: { symbol, timeframe } },
        updatedAt: new Date().toISOString(),
      });
      res.json({ session });
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "ROOM_SESSION_ALREADY_ACTIVE") {
        const active = await sessionStore.getActive(team.id);
        res.json({ session: active });
        return;
      }
      throw error;
    }
  }

  if (action === "end") {
    const active = await sessionStore.getActive(team.id);
    if (!active) {
      res.json({ session: null });
      return;
    }
    const ended = await sessionStore.end(team.id, active.id);
    await teamStore.save({
      ...team,
      activeSessionId: null,
      updatedAt: new Date().toISOString(),
    });
    res.json({ session: ended });
    return;
  }

  fail(res, 400, "INVALID_SESSION_ACTION", "Action must be start or end.");
}));

/**
 * The Worker pushes a durable snapshot of the shared chart state.
 *
 * Snapshots are throttled on the Worker side, so a busy room does not turn
 * every drawing drag into a Firestore write.
 */roomsRouter.post("/internal/rooms/snapshot", handle(async (req, res) => {
  const body = (req.body ?? {}) as {
    roomId?: unknown;
    symbol?: unknown;
    timeframe?: unknown;
    drawings?: unknown;
  };
  const roomId = String(body.roomId ?? "");
  const signature = req.header("x-tradingvibes-service") ?? null;
  if (!roomId) {
    return fail(res, 400, "INVALID_REQUEST", "roomId is required.");
  }
  if (!verifyServiceRequest("room-snapshot", roomSubject(roomId), signature)) {
    return fail(res, 401, "INVALID_SERVICE_SIGNATURE", "Service signature rejected.");
  }
  if (typeof body.symbol !== "string" || !isValidSymbol(body.symbol)) {
    return fail(res, 400, "INVALID_SYMBOL", "The snapshot symbol is not valid.");
  }
  if (typeof body.timeframe !== "string" || !isValidTimeframe(body.timeframe)) {
    return fail(res, 400, "INVALID_TIMEFRAME", "The snapshot timeframe is not valid.");
  }
  const drawings = Array.isArray(body.drawings) ? (body.drawings as RoomDrawing[]) : [];
  const written = await chartStateStore.save(roomId, {
    symbol: body.symbol,
    timeframe: body.timeframe,
    drawings,
  });
  res.json({ ok: true, written });
}));

/**
 * THE ROOM COORDINATOR REPORTS WHO IS CONNECTED.
 *
 * The Durable Object is the only place that knows who holds a live
 * connection, so it is the one that reports it. The request is signed with
 * the shared secret, so nobody else can put a member into a room's presence
 * list.
 *
 * The snapshot is keyed by AUTHENTICATED identity, not by socket: the
 * store counts one person once, however many tabs they have open.
 */
roomsRouter.post("/internal/rooms/presence", handle(async (req, res) => {
  const body = (req.body ?? {}) as { roomId?: unknown; members?: unknown };
  const roomId = String(body.roomId ?? "");
  const signature = req.header("x-tradingvibes-service") ?? null;
  if (!roomId) {
    return fail(res, 400, "INVALID_REQUEST", "roomId is required.");
  }
  if (!verifyServiceRequest("room-presence", roomSubject(roomId), signature)) {
    return fail(res, 401, "INVALID_SERVICE_SIGNATURE", "Service signature rejected.");
  }

  const members: PresenceMember[] = Array.isArray(body.members)
    ? (body.members as PresenceMember[])
        .filter((entry) => typeof entry?.uid === "string" && entry.uid.length > 0)
        .slice(0, 200)
    : [];

  const presence = await presenceStore.set(roomId, members).catch(() => null);
  res.json({ ok: true, onlineCount: presence?.onlineCount ?? 0 });
}));

/** The Worker asks the API to broadcast a voice roster change. */
roomsRouter.post("/internal/rooms/voice", handle(async (req, res) => {
  const body = (req.body ?? {}) as { roomId?: unknown; roster?: unknown };
  const roomId = String(body.roomId ?? "");
  const signature = req.header("x-tradingvibes-service") ?? null;
  if (!roomId) {
    return fail(res, 400, "INVALID_REQUEST", "roomId is required.");
  }
  if (!verifyServiceRequest("room-voice", roomSubject(roomId), signature)) {
    return fail(res, 401, "INVALID_SERVICE_SIGNATURE", "Service signature rejected.");
  }
  res.json({ ok: true, roster: body.roster ?? null });
}));
