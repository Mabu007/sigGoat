/**
 * VERCEL SERVERLESS ENTRY
 * =======================
 * Vercel's Node runtime accepts a default-exported Express app.
 *
 * WHAT WORKS HERE
 *   Every request/response path: auth, GOAT CRUD, saving an OpenRouter key,
 *   manual "Wake & Re-evaluate", chat, Telegram webhook, daily recaps.
 *
 * WHY THERE IS NO SCHEDULER IN THIS FILE
 *   The per-GOAT schedule is owned by a Cloudflare Durable Object alarm
 *   (see worker/scheduler-worker.ts). This function holds no timers and
 *   restores no long-lived actors at boot, because a serverless instance is
 *   frozen between invocations — an in-process timer would silently stop
 *   firing, which is the failure this architecture exists to prevent.
 *
 *   The DO calls POST /api/internal/wake, which runs the full pipeline on
 *   demand. That request creates the actor, does the work, and returns.
 *
 * `restoreRuntimes()` is therefore intentionally NOT called here. Actors are
 * created lazily by ensureGoatRuntime() when a request needs one, and discarded
 * when the instance is reclaimed.
 *
 * Node-only modules (`node:fs`, `firebase-admin`) live under src/server/ and
 * are fine here: this is the Vercel Node runtime, not the Workers runtime. The
 * Durable Object worker deliberately imports none of them.
 */

import '../src/server/env';
import { createApp } from '../src/server/app';
import { seedDefaultSkills } from '../src/server/apiRouter';

// Seeding default skills is a one-time boot concern and is safe on a cold
// start: it is idempotent and skipped when every skill already exists.
let seeded: Promise<void> | undefined;

function ensureSeeded(): Promise<void> {
  if (!seeded) {
    seeded = seedDefaultSkills().catch((err) => {
      // A seeding failure must not break the instance; the routes still work.
      console.error('[vercel] seedDefaultSkills failed:', err);
    });
  }
  return seeded;
}

const app = createApp({ serveStatic: false });

app.use((_req: unknown, res: import('express').Response, next: import('express').NextFunction) => {
  void ensureSeeded().then(() => next(), next);
});

export default app;
