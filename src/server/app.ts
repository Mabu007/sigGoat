/**
 * EXPRESS APP FACTORY
 * ===================
 * One place that builds the HTTP app, shared by both hosts:
 *
 *   - server.ts  : long-lived Node process (local dev, Fly.io, Render, Railway)
 *   - api/index.ts : Vercel serverless function
 *
 * Keeping this in one module stops the two hosts from drifting, which is how
 * "works locally, 404s on Vercel" bugs happen.
 */

import express, { type Express } from 'express';
import path from 'path';
import fs from 'fs';
import { apiRouter } from './apiRouter';
import { roomsRouter } from './roomsRouter';

export interface CreateAppOptions {
  /** Serve the built client from ./dist. Defaults to NODE_ENV=production. */
  serveStatic?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const serveStatic =
    options.serveStatic ?? process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '1mb' }));

  /**
   * The TradingVibes room surface: settings, live sessions, voice, media
   * uploads and the internal endpoints the Cloudflare realtime Worker calls.
   *
   * IT IS MOUNTED FIRST, AND THAT ORDER MATTERS.
   *
   * The legacy router ends with a blanket `apiRouter.use(authMiddleware)`,
   * which runs for EVERY request that reaches it — including one that
   * matches none of its routes. If the legacy router were mounted first, a
   * signed-out visitor asking for the PUBLIC room directory would be
   * answered with a 401 from that middleware before the rooms router was
   * ever consulted. The two routers share no path (`/rooms*`, `/profile`,
   * `/media/*`, `/realtime/status` and `/internal/rooms/*` exist only in the
   * rooms router), so mounting the rooms router first cannot shadow a
   * legacy route.
   */
  app.use('/api', roomsRouter);
  app.use('/api', apiRouter);

  if (serveStatic) {
    const distDir = path.join(process.cwd(), 'dist');

    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));

      // SPA fallback. Never swallow /api — those routes are matched above and
      // any unmatched /api path must still 404 as JSON, not return HTML.
      app.get('*', (req, res, next) => {
        if ((req.url ?? '').startsWith('/api')) return next();
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      console.warn(
        `[app] dist/ not found at ${distDir}. ` +
          'Run `npm run build` before starting in production.',
      );
    }
  }

  return app;
}
