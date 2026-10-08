/**
 * ENVIRONMENT BOOTSTRAP
 * ====================
 * MUST be the first import of server.ts (and of anything that reads
 * process.env at module scope, e.g. firebaseAdmin / repositories /
 * apiRouter). ESM evaluates dependencies in import order, so importing this
 * module first guarantees dotenv has populated process.env before any other
 * module body runs.
 *
 * Precedence (highest first):
 *   1. Already-set process.env (real deployments, test harnesses)
 *   2. .env.local          (developer machine)
 *   3. .env                (shared defaults)
 *
 * dotenv runs with override:false so a real environment variable is never
 * clobbered by a file on disk.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

let loaded = false;

export function loadEnv(cwd: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  for (const file of ['.env.local', '.env']) {
    const filePath = path.join(cwd, file);
    if (!fs.existsSync(filePath)) continue;

    dotenv.config({ path: filePath, override: false, quiet: true });
    console.log(`[env] Loaded ${file}`);
  }
}

loadEnv();
