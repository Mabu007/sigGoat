/**
 * REGRESSION: VITE MUST NEVER SEE AN API RESPONSE
 * ================================================
 *
 * Production symptom: opening Backtest flashed the Vite dev overlay with
 *
 *   Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent
 *   to the client   (at Vite's applyHeaders / corsMiddleware)
 *
 * Root cause: the Vite middleware chain (CORS headers, SPA HTML fallback)
 * was mounted directly behind the API router. An `/api` request whose handler
 * had ALREADY committed a JSON response could fall through to Vite, which
 * then tried to write response headers a second time. Writing headers after
 * the response is committed throws — the overlay merely reports the frame
 * that threw, not the handler that actually double-responded.
 *
 * The fix is ordering, not policy: `createViteGuard` routes every `/api`
 * request away from Vite entirely, so Vite's header-writing middleware has
 * nothing to write onto. These tests pin that invariant down. They deliberately
 * DO NOT disable the HMR overlay or relax CORS — hiding the symptom would
 * leave every other double-response path intact.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { createViteGuard } from '../src/server/devViteGuard';

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('Vite middleware guard', () => {
  test('an /api request never reaches the Vite middleware', async () => {
    const app = express();
    let viteCalls = 0;

    // The historical layout: API router mounted first, guard behind it.
    app.use('/api', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(
      createViteGuard(() => {
        viteCalls += 1;
      }),
    );

    const base = await listen(app);
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(viteCalls).toBe(0);
  });

  test('an API handler that responds AND falls through still never reaches Vite (the original bug shape)', async () => {
    const app = express();
    let viteCalls = 0;

    // Exactly the bug: the handler commits a response, then calls next().
    // Without the guard, control continued into Vite's corsMiddleware, which
    // wrote headers onto the already-committed response -> ERR_HTTP_HEADERS_SENT.
    app.use('/api', (_req, res, next) => {
      res.json({ answered: true });
      next();
    });
    app.use(
      createViteGuard(() => {
        viteCalls += 1;
        throw new Error('vite must never run for /api');
      }),
    );
    // Express's default terminal handler absorbs the post-response fallthrough.
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;
      res.status(500).json({ error: String(err) });
    });

    const base = await listen(app);
    const response = await fetch(`${base}/api/goats`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answered: true });
    expect(viteCalls).toBe(0);
  });

  test('a non-API request is handed to Vite exactly once', async () => {
    const app = express();
    let viteCalls = 0;

    app.use(
      createViteGuard((_req, res, next) => {
        viteCalls += 1;
        (res as express.Response).send('served-by-vite');
        next();
      }),
    );

    const base = await listen(app);
    const response = await fetch(`${base}/backtest`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('served-by-vite');
    expect(viteCalls).toBe(1);
  });

  test('the guard calls next() at most once per request', async () => {
    let nextCalls = 0;
    const guard = createViteGuard(() => {
      /* non-API: vite path */
    });

    guard({ url: '/api/x' }, {}, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(1);

    // A second call to the guard for a different request must not compound
    // on the previous one — next calls are per-request, not shared.
    nextCalls = 0;
    guard({ url: '/api/y' }, {}, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(1);
  });
});
