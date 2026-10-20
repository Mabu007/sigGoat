/**
 * STORE FILESYSTEM GUARD
 * ======================
 * A store that keeps its state in a JSON file needs a directory to write to.
 * On a serverless host the working directory is usually READ ONLY, so the
 * directory cannot be created and `mkdirSync` throws.
 *
 * A throw here happens while the module is loading, which takes down EVERY
 * route on the server with an opaque platform error. So the directory is
 * created defensively: when it cannot be created the store runs in memory
 * and says so, instead of stopping the whole application.
 *
 * The alternative — refusing to start — is reserved for the primary
 * datastore, where losing a write matters. A room's local cache losing a
 * write is not worth taking the site down for.
 */

import fs from "node:fs";
import path from "node:path";
import { devAuthExplicitlyEnabled, isProductionRuntime } from "./auth";
import { PersistenceUnavailableError } from "./persistenceError";

export function ensureStoreDirectory(filePath: string): boolean {
  const directory = path.dirname(filePath);
  try {
    fs.mkdirSync(directory, { recursive: true });
    return true;
  } catch (error) {
    console.warn(
      `[store] Cannot use ${directory} (${error instanceof Error ? error.message : String(error)}). ` +
        'This store will run in memory only, and its state will not survive a restart.',
    );
    return false;
  }
}

/**
 * How a store may keep its state.
 *
 * The room, session, chart-state and media stores must make the SAME
 * decision as the primary datastore, or the app ends up in a half-broken
 * state where the account is durable and the rooms are not.
 */
export type StoreMode = 'firestore' | 'file' | 'memory' | 'unavailable';

export interface StoreModeDecision {
  mode: StoreMode;
  /** False when the filesystem could not be used. */
  fileBacked: boolean;
  /** Set when the store is not durable, with the reason. */
  reason?: string;
}

/**
 * Decides how a store may persist.
 *
 *   - Firestore is configured: use it, and nothing else.
 *   - Dev auth was explicitly requested: the operator has said "run me
 *     without Firebase credentials", so the store degrades to a file, or to
 *     memory on a read-only filesystem, and says so.
 *   - A production runtime with neither: the store REFUSES. A room that
 *     accepts a write and loses it is worse than a room that answers 503.
 *   - A development runtime: degrade freely; it is a developer machine.
 */
export function resolveStoreMode(hasFirestore: boolean, label: string): StoreModeDecision {
  if (hasFirestore) return { mode: 'firestore', fileBacked: true };

  const reason =
    'No Firebase Admin credential is configured, so this deployment has no durable datastore.';

  if (devAuthExplicitlyEnabled()) {
    console.warn(
      `[store] ${label} is running without Firestore because dev auth was explicitly enabled. ` +
        'Its state is not durable across a redeploy.',
    );
    return { mode: 'file', fileBacked: true, reason };
  }

  if (isProductionRuntime()) {
    console.error(
      `[store] ${label} has no durable datastore in a production runtime and will refuse ` +
        'every operation. ' +
        reason,
    );
    return { mode: 'unavailable', fileBacked: false, reason };
  }

  return { mode: 'file', fileBacked: true, reason };
}

/** Throws when a store is not allowed to operate. */
export function assertStoreAvailable(decision: StoreModeDecision, label: string): void {
  if (decision.mode === 'unavailable') {
    throw new PersistenceUnavailableError(
      `${label} is unavailable: ${decision.reason ?? 'no durable datastore is configured.'}`,
    );
  }
}
