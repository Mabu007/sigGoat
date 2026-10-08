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

export interface CreateAppOptions {
  /** Serve the built client from ./dist. Defaults to NODE_ENV=production. */
  serveStatic?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const serveStatic =
    options.serveStatic ?? process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '1mb' }));
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
