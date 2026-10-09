/**
 * VERCEL SERVERLESS ENTRY
 * =======================
 * This module is BUNDLED to `api/index.js` by the build (see
 * scripts/build-api.mjs and the `build` npm script).
 *
 * WHY IT IS BUNDLED
 *
 * Vercel's Node builder transpiles each TypeScript file in isolation and emits
 * plain `.js`. The emitted `api/index.js` therefore still contained
 * `import '../src/server/env'`, and Node's ESM resolver requires a real file
 * extension — so every request died with
 * `ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/src/server/env'`.
 * That took the entire API surface offline in production while working
 * perfectly under tsx locally.
 *
 * Bundling resolves every relative import at build time and emits extensioned
 * specifiers, so the deployed function has no resolution step left to get
 * wrong. `node_modules` stays external, so firebase-admin and express are
 * loaded normally rather than inlined into one 4 MB file.
 *
 * WHAT WORKS HERE
 *   Every request/response path: auth, GOAT CRUD, provider keys, manual wake,
 *   chat, Telegram webhook, market ingestion status, daily recaps.
 *
 * WHY THERE IS NO SCHEDULER IN THIS FILE
 *   The per-GOAT schedule is owned by a Cloudflare Durable Object alarm
 *   (worker/scheduler-worker.ts). This function holds no timers and restores
 *   no long-lived actors at boot, because a serverless instance is frozen
 *   between invocations — an in-process timer would silently stop firing,
 *   which is the failure this architecture exists to prevent.
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

import './env';
import { createApp } from './app';
import { seedDefaultSkills } from './apiRouter';

// Seeding default skills is a one-time boot concern and is safe on a cold
// start: it is idempotent and skipped when every skill already exists.
let seeded: Promise<void> | undefined;

function ensureSeeded(): Promise<void> {
  if (!seeded) {
    seeded = seedDefaultSkills().catch((err: unknown) => {
      // A seeding failure must not break the instance; the routes still work.
      console.error('[vercel] seedDefaultSkills failed:', err);
    });
  }
  return seeded;
}

const app = createApp({ serveStatic: false });

app.use(
  (
    _req: unknown,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    void ensureSeeded().then(() => next(), next);
  },
);

export default app;