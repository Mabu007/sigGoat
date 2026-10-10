/**
 * TEST HARNESS: CREDENTIAL ENCRYPTION
 * ===================================
 * Sets a master key so the vault is functional in tests.
 *
 * WHY THIS IS NOT OPTIONAL IN THE HARNESS
 *   The vault fails CLOSED: with no `CREDENTIAL_ENCRYPTION_KEY` a save throws
 *   rather than writing plaintext. That is the correct production behaviour,
 *   and it means a test that saves a credential has to supply a key — exactly
 *   as a real deployment must. A harness that quietly generated one would hide
 *   the failure mode this design exists to prevent.
 *
 * THE KEY IS A FIXED TEST VALUE, NOT A RANDOM ONE.
 *   Some suites assert on the persisted envelope across module reloads; a
 *   random per-suite key would make those fail for reasons unrelated to what
 *   they test. This value is checked into a TEST file, is never used outside
 *   `NODE_ENV=test`, and must never appear in any deployment.
 */

import { randomBytes } from 'node:crypto';

/**
 * 32 bytes, generated once and pinned.
 *
 * `Bun.env` / `process.env` plumbing differs between the Node server, the
 * Vercel bundle and the test runner, so the caller passes the object it wants
 * mutated.
 */
export const TEST_MASTER_KEY = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000042',
  'hex',
).toString('base64');

export interface EncryptionEnvSnapshot {
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY_ID?: string;
  PROPDAO_EXECUTION_ENABLED?: string;
  PROPDAO_EXECUTION_AUTHORISED?: string;
  PROPDAO_EXECUTION_TERMS_REFERENCE?: string;
}

/** Installs the test master key. Returns the previous values for restore. */
export function withTestEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
): EncryptionEnvSnapshot {
  const previous: EncryptionEnvSnapshot = {
    CREDENTIAL_ENCRYPTION_KEY: env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY_ID: env.CREDENTIAL_ENCRYPTION_KEY_ID,
    PROPDAO_EXECUTION_ENABLED: env.PROPDAO_EXECUTION_ENABLED,
    PROPDAO_EXECUTION_AUTHORISED: env.PROPDAO_EXECUTION_AUTHORISED,
    PROPDAO_EXECUTION_TERMS_REFERENCE: env.PROPDAO_EXECUTION_TERMS_REFERENCE,
  };

  env.CREDENTIAL_ENCRYPTION_KEY = TEST_MASTER_KEY;
  env.CREDENTIAL_ENCRYPTION_KEY_ID = 'test-key';
  // Execution stays OFF unless a test explicitly turns it on.
  delete env.PROPDAO_EXECUTION_ENABLED;
  delete env.PROPDAO_EXECUTION_AUTHORISED;
  delete env.PROPDAO_EXECUTION_TERMS_REFERENCE;

  return previous;
}

/** Restores the snapshot taken by `withTestEncryptionKey`. */
export function restoreEncryptionEnv(
  previous: EncryptionEnvSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

/** A fresh random master key, for tests that must not share a keyring. */
export function randomMasterKey(): string {
  return randomBytes(32).toString('base64');
}