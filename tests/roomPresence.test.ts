/**
 * ROOM PRESENCE, MEMBERS AND UNREAD MESSAGES
 * ==========================================
 *
 * The rules these tests pin:
 *
 *   - the ONLINE count is a count of PEOPLE, not of connections, and it is
 *     null when it cannot be established rather than zero;
 *   - the MENTOR's availability is a network fact and is independent of
 *     whether a session has been started;
 *   - a member may see the room's roster and a visitor may not;
 *   - a read cursor only ever moves FORWARD, and a message that is not in
 *     the room's conversation cannot be used to move it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    FUNDAGOAT_ALLOW_DEV_AUTH: process.env.FUNDAGOAT_ALLOW_DEV_AUTH,
    DATA_DIR: process.env.DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  process.env.NODE_ENV = 'test';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.FUNDAGOAT_ALLOW_DEV_AUTH = '1';
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradingvibes-presence-test-'));
  process.env.DATA_DIR = dataDir;

  const { roomsRouter } = await import('../src/server/roomsRouter');
  const app = express();
  app.use(express.json());
  app.use('/api', roomsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function req(
  method: string,
  urlPath: string,
  options?: { userId?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options?.userId) headers['x-dev-user-id'] = options.userId;
  return fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (res) => {
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  });
}

/* ------------------------------------------------------------------ */
/* The presence store                                                  */
/* ------------------------------------------------------------------ */

describe('room presence', () => {
  test('counts PEOPLE, not connections', async () => {
    const { RoomPresenceStore } = await import('../src/server/rooms/roomPresenceStore');
    const store = new RoomPresenceStore({
      filePath: path.join(dataDir, 'presence-unit.json'),
    });

    const presence = await store.set('room_a', [
      { uid: 'user_a', name: 'A', role: 'OWNER', connectedAt: 100 },
      { uid: 'user_a', name: 'A', role: 'OWNER', connectedAt: 200 },
      { uid: 'user_a', name: 'A', role: 'OWNER', connectedAt: 300 },
      { uid: 'user_b', name: 'B', role: 'MEMBER', connectedAt: 150 },
    ]);

    // Three connections, two people.
    expect(presence.onlineCount).toBe(2);
    expect(presence.members).toHaveLength(2);
  });

  test('the mentor is online when the owner or a leader is connected', async () => {
    const { RoomPresenceStore } = await import('../src/server/rooms/roomPresenceStore');
    const store = new RoomPresenceStore({
      filePath: path.join(dataDir, 'presence-mentor.json'),
    });

    const withOwner = await store.set('room_b', [
      { uid: 'owner', name: 'Owner', role: 'OWNER', connectedAt: 1 },
    ]);
    expect(withOwner.mentorOnline).toBe(true);

    const withLeader = await store.set('room_c', [
      { uid: 'leader', name: 'Leader', role: 'LEADER', connectedAt: 1 },
    ]);
    expect(withLeader.mentorOnline).toBe(true);

    // Members only: the mentor is OFFLINE, even though people are here.
    const membersOnly = await store.set('room_d', [
      { uid: 'member', name: 'Member', role: 'MEMBER', connectedAt: 1 },
    ]);
    expect(membersOnly.mentorOnline).toBe(false);
    expect(membersOnly.onlineCount).toBe(1);
  });

  test('a room with nobody in it is offline, not unknown', async () => {
    const { RoomPresenceStore } = await import('../src/server/rooms/roomPresenceStore');
    const store = new RoomPresenceStore({
      filePath: path.join(dataDir, 'presence-empty.json'),
    });
    const presence = await store.set('room_e', []);
    expect(presence.onlineCount).toBe(0);
    expect(presence.mentorOnline).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The read cursor                                                     */
/* ------------------------------------------------------------------ */

describe('room read cursor', () => {
  test('moves forward and never backwards', async () => {
    const { RoomReadCursorStore } = await import('../src/server/rooms/roomReadCursorStore');
    const store = new RoomReadCursorStore({
      filePath: path.join(dataDir, 'cursor-unit.json'),
    });

    const first = await store.set('user_a', 'room_a', {
      messageId: 'm2',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    expect(first.lastReadMessageId).toBe('m2');

    // An older message must not drag the cursor back.
    const older = await store.set('user_a', 'room_a', {
      messageId: 'm1',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(older.lastReadMessageId).toBe('m2');

    const newer = await store.set('user_a', 'room_a', {
      messageId: 'm3',
      createdAt: '2026-01-01T00:00:03.000Z',
    });
    expect(newer.lastReadMessageId).toBe('m3');
  });

  test('a cursor belongs to one user and one room', async () => {
    const { RoomReadCursorStore } = await import('../src/server/rooms/roomReadCursorStore');
    const store = new RoomReadCursorStore({
      filePath: path.join(dataDir, 'cursor-scope.json'),
    });

    await store.set('user_a', 'room_a', {
      messageId: 'm1',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(await store.get('user_a', 'room_a')).not.toBeNull();
    // Another room, and another user, are unaffected.
    expect(await store.get('user_a', 'room_b')).toBeNull();
    expect(await store.get('user_b', 'room_a')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The routes                                                          */
/* ------------------------------------------------------------------ */

describe('the room roster and conversation routes', () => {
  test('the roster needs an identity', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_1',
      body: { name: 'Presence room', visibility: 'PRIVATE' },
    });
    expect(created.status).toBe(200);
    const roomId = created.json.room.id;

    const anonymous = await req('GET', `/rooms/${roomId}/members`);
    expect(anonymous.status).toBe(401);
  });

  test('a visitor may not enumerate the members of a private room', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_2',
      body: { name: 'Private roster room', visibility: 'PRIVATE' },
    });
    const roomId = created.json.room.id;

    const visitor = await req('GET', `/rooms/${roomId}/members`, { userId: 'visitor_1' });
    expect(visitor.status).toBe(403);
    expect(visitor.json.error.code).toBe('ROOM_NOT_JOINED');
  });

  test('a member sees the roster, and the leader is in it', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_3',
      body: { name: 'Roster room', visibility: 'PRIVATE' },
    });
    const roomId = created.json.room.id;
    await req('POST', `/rooms/${roomId}/join`, { userId: 'member_1', body: {} });

    const roster = await req('GET', `/rooms/${roomId}/members`, { userId: 'member_1' });
    expect(roster.status).toBe(200);
    expect(roster.json.totalMembers).toBe(2);
    const roles = roster.json.members.map((member: any) => member.role);
    expect(roles).toContain('OWNER');
    // Presence is unknown until the coordinator reports it.
    expect(roster.json.onlineCount).toBeNull();
  });

  test('a member can read the conversation, a visitor cannot', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_4',
      body: { name: 'Conversation room', visibility: 'PRIVATE' },
    });
    const roomId = created.json.room.id;
    await req('POST', `/rooms/${roomId}/join`, { userId: 'member_2', body: {} });

    const posted = await req('POST', `/rooms/${roomId}/chat`, {
      userId: 'member_2',
      body: { content: 'Is anyone watching gold?' },
    });
    expect(posted.status).toBe(201);
    expect(posted.json.message.authorName).toBeTruthy();

    const member = await req('GET', `/rooms/${roomId}/chat`, { userId: 'member_2' });
    expect(member.status).toBe(200);
    expect(member.json.messages).toHaveLength(1);
    // The author's own message is never unread for the author.
    expect(member.json.unreadCount).toBe(0);

    const visitor = await req('GET', `/rooms/${roomId}/chat`, { userId: 'visitor_2' });
    expect(visitor.status).toBe(403);
  });

  test('a reader who has not read the room sees its messages as unread', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_5',
      body: { name: 'Unread room', visibility: 'PRIVATE' },
    });
    const roomId = created.json.room.id;
    await req('POST', `/rooms/${roomId}/join`, { userId: 'member_3', body: {} });
    await req('POST', `/rooms/${roomId}/chat`, {
      userId: 'owner_5',
      body: { content: 'First message' },
    });
    await req('POST', `/rooms/${roomId}/chat`, {
      userId: 'owner_5',
      body: { content: 'Second message' },
    });

    const before = await req('GET', `/rooms/${roomId}/chat`, { userId: 'member_3' });
    expect(before.json.unreadCount).toBe(2);

    // Reading the last message clears the count.
    const lastId = before.json.messages[before.json.messages.length - 1].id;
    const read = await req('POST', `/rooms/${roomId}/chat/read`, {
      userId: 'member_3',
      body: { messageId: lastId },
    });
    expect(read.status).toBe(200);
    expect(read.json.unreadCount).toBe(0);

    const after = await req('GET', `/rooms/${roomId}/chat`, { userId: 'member_3' });
    expect(after.json.unreadCount).toBe(0);
  });

  test('a cursor cannot be pointed at a message from another conversation', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_6',
      body: { name: 'Cursor room', visibility: 'PRIVATE' },
    });
    const roomId = created.json.room.id;
    await req('POST', `/rooms/${roomId}/join`, { userId: 'member_4', body: {} });

    const read = await req('POST', `/rooms/${roomId}/chat/read`, {
      userId: 'member_4',
      body: { messageId: 'msg_from_somewhere_else' },
    });
    expect(read.status).toBe(404);
  });

  test('a presence report is only accepted with the service signature', async () => {
    const created = await req('POST', '/rooms', {
      userId: 'owner_7',
      body: { name: 'Signed presence room', visibility: 'PRIVATE' },
    });
    const roomId = created.json.room.id;

    const unsigned = await req('POST', '/internal/rooms/presence', {
      body: { roomId, members: [{ uid: 'owner_7', name: 'Owner', role: 'OWNER', connectedAt: 1 }] },
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.json.error.code).toBe('INVALID_SERVICE_SIGNATURE');
  });
});
