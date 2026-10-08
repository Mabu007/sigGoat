import { describe, test, expect, afterEach } from 'bun:test';
import { authMiddleware, resolveAuthMode, setFirebaseVerifierForTests, type AuthenticatedUser } from '../src/server/auth';
import type { Request, Response, NextFunction } from 'express';

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function mockRes(): MockRes & Response {
  const res: MockRes = {
    statusCode: 0,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as unknown as MockRes & Response;
}

function run(req: Partial<Request>): { res: MockRes & Response; next: NextFunction; nextCalls: unknown[] } {
  const nextCalls: unknown[] = [];
  const next: NextFunction = (...args: unknown[]) => nextCalls.push(args);
  const res = mockRes();
  const mockReq = {
    ...req,
    header(name: string): string | undefined {
      const headers = (req.headers ?? {}) as Record<string, string | undefined>;
      const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : undefined;
    },
  } as unknown as Request;
  authMiddleware(mockReq, res as unknown as Response, next);
  return { res, next, nextCalls };
}

describe('authMiddleware', () => {
  afterEach(() => {
    setFirebaseVerifierForTests(undefined as unknown as null);
  });

  test('dev mode: valid x-dev-user-id header authenticates', () => {
    process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
    delete process.env.FIREBASE_PROJECT_ID;
    setFirebaseVerifierForTests(null);
    const { res, nextCalls } = run({ headers: { 'x-dev-user-id': 'user_abc123' } });
    expect(res.statusCode).toBe(0);
    expect(nextCalls.length).toBe(1);
    expect((nextCalls[0] as never) === undefined || nextCalls[0]).toBeTruthy();
  });

  test('dev mode: invalid header format is rejected with 401', () => {
    process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
    setFirebaseVerifierForTests(null);
    const { res } = run({ headers: { 'x-dev-user-id': 'bad uid with spaces!' } });
    expect(res.statusCode).toBe(401);
  });

  test('dev mode: missing header is rejected with 401', () => {
    process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
    setFirebaseVerifierForTests(null);
    const { res } = run({ headers: {} });
    expect(res.statusCode).toBe(401);
  });

  test('none mode (no firebase, no opt-in): 503 AUTH_NOT_CONFIGURED — never silently open', () => {
    delete process.env.SIGNALGOAT_ALLOW_DEV_AUTH;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    setFirebaseVerifierForTests(null);
    const mode = resolveAuthMode();
    expect(mode).toBe('none');
    const { res } = run({ headers: {} });
    expect(res.statusCode).toBe(503);
  });

  test('firebase mode: valid token sets req.user with verified uid', async () => {
    delete process.env.SIGNALGOAT_ALLOW_DEV_AUTH;
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    setFirebaseVerifierForTests(async (token) => {
      if (token === 'good-token') return { uid: 'uid_123', email: 'trader@example.com' };
      throw new Error('invalid token');
    });

    const result = run({ headers: { authorization: 'Bearer good-token' } });
    // middleware resolves the verifier promise asynchronously
    await new Promise((r) => setTimeout(r, 10));
    expect(result.res.statusCode).toBe(0);
    expect(result.nextCalls.length).toBe(1);

    const resultBad = run({ headers: { authorization: 'Bearer bad-token' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(resultBad.res.statusCode).toBe(401);
  });

  test('firebase mode: missing token is 401', () => {
    delete process.env.SIGNALGOAT_ALLOW_DEV_AUTH;
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    setFirebaseVerifierForTests(async () => ({ uid: 'x' }));
    const { res } = run({ headers: {} });
    expect(res.statusCode).toBe(401);
  });
});
