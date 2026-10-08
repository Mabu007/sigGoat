/**
 * VERCEL SERVERLESS ENTRY
 * =======================
 * Vercel's @vercel/node runtime accepts a default-exported Express app.
 *
 * IMPORTANT — WHAT WORKS AND WHAT DOES NOT HERE:
 *
 *   WORKS  : every request/response path (auth, GOAT CRUD, saving an OpenRouter
 *            key, manual "Wake & Re-evaluate", chat, Telegram webhook).
 *
 *   DOES NOT WORK RELIABLY: the BACKGROUND SCHEDULER.
 *            Per-GOAT reasoning intervals and tracker polling are `setTimeout`
 *            loops inside the long-lived process. A serverless function is
 *            frozen between invocations and reclaimed when idle, so hourly
 *            analyses and tracker alerts stop firing.
 *
 *            Fix: run this app on a long-lived host (Fly.io / Render / Railway
 *            / a VM) and point Vercel at it, OR migrate the per-GOAT actors
 *            to Cloudflare Durable Objects (the right long-term home).
 *
 *            Set the GOAT schedule to "Trackers only" or "Manual only" on
 *            serverless so the UI does not promise runs that cannot happen.
 */

import '../src/server/env';
import { createApp } from '../src/server/app';
import {
  restoreRuntimes,
  seedDefaultSkills,
} from '../src/server/apiRouter';

// Seed + restore on cold start. Deliberately NOT awaited in the request
// path: a cold start should serve the first request immediately.
let bootstrapped: Promise<void> | undefined;
function bootstrap(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await seedDefaultSkills();
      await restoreRuntimes();
    })().catch((err) => {
      console.error('[vercel] bootstrap failed:', err);
    });
  }
  return bootstrapped;
}

const app = createApp({ serveStatic: false });

app.use((_req: unknown, res: import('express').Response, next: import('express').NextFunction) => {
  void bootstrap().then(() => next(), next);
});

export default app;
