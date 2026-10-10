/**
 * CREDENTIAL PROVIDER REGISTRY
 * ============================
 * Declares every provider the vault can hold a secret for, and builds the
 * process-wide `CredentialVault` from whichever `PersistenceLayer` the
 * runtime selected.
 *
 * Declaring them in ONE place (rather than at each call site) is what makes
 * "is this secret encrypted?" answerable by reading a single file.
 *
 * `executionCapable` IS NOT AN AUTHORISATION.
 *   It records only that a secret of this type would be used to move money if
 *   execution were enabled. Whether it IS enabled is a separate, server-side
 *   feature flag (`PROPDAO_EXECUTION_ENABLED`) evaluated at the moment of
 *   execution — see `src/services/propdao/executionPolicy.ts`. A provider
 *   being `executionCapable` never enables anything on its own.
 */

import {
  CredentialProviderId,
  CredentialVault,
  MemoryCredentialRecordStore,
  registerCredentialProvider,
} from './CredentialVault';
import { CredentialRecordRepository, PersistenceLayer } from '../repositories';
import { isPlausibleOpenRouterKey, isPlausibleGroqKey, isPlausiblePropDaoKey, isPlausibleTelegramToken } from '../credentialValidation';

/* ------------------------------------------------------------------ */
/* Shape validation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Validates a candidate secret's FORMAT and returns the normalised value.
 *
 * Returns `undefined` for "blank, leave unchanged" and THROWS for
 * "present but wrong" — the distinction that lets the Settings UI show
 * "nothing to change" instead of "invalid key" when a user submits an
 * unrelated field.
 *
 * This never contacts the provider. Shape is a local, instant, offline check;
 * proving the key WORKS is a separate `test` action that does make a call.
 */
function requireFormat(
  value: string,
  label: string,
  plausible: (v: string) => boolean,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!plausible(trimmed)) {
    throw new Error(
      `${label} does not look like a valid ${label} key. Check for stray spaces or a truncated paste.`,
    );
  }
  return trimmed;
}

registerCredentialProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  executionCapable: false,
  normalise: (value) => requireFormat(value, 'OpenRouter', isPlausibleOpenRouterKey),
});

registerCredentialProvider({
  id: 'groq',
  label: 'Groq',
  executionCapable: false,
  normalise: (value) => requireFormat(value, 'Groq', isPlausibleGroqKey),
});

registerCredentialProvider({
  id: 'propdao',
  label: 'PropDAO',
  executionCapable: true,
  normalise: (value) => requireFormat(value, 'PropDAO', isPlausiblePropDaoKey),
});

registerCredentialProvider({
  id: 'telegram',
  label: 'Telegram',
  executionCapable: false,
  normalise: (value) => requireFormat(value, 'Telegram bot token', isPlausibleTelegramToken),
});

/**
 * A record store backed by the same `PersistenceLayer` the rest of the app
 * uses, so credentials land in whichever durable store is actually active
 * (Firestore in production) without any code path choosing differently.
 */
export class PersistenceCredentialRecordStore {
  constructor(private readonly repo: CredentialRecordRepository) {}

  async saveEncrypted(userId: string, provider: CredentialProviderId, envelope: string, updatedAt: string) {
    return this.repo.saveEncrypted(userId, provider, envelope, updatedAt);
  }
  async readEncrypted(userId: string, provider: CredentialProviderId) {
    return this.repo.readEncrypted(userId, provider);
  }
  async delete(userId: string, provider: CredentialProviderId) {
    return this.repo.delete(userId, provider);
  }
  async listEncrypted(userId: string) {
    const rows = await this.repo.listEncrypted(userId);
    // The store persists `provider` as an opaque string; the vault only ever
    // issues the four ids registered above. Anything else is not a credential
    // this build understands and must not be surfaced as one.
    return rows.filter((row): row is typeof row & { provider: CredentialProviderId } =>
      row.provider === 'openrouter' ||
      row.provider === 'groq' ||
      row.provider === 'propdao' ||
      row.provider === 'telegram');
  }
}

/**
 * Builds a vault over a persistence layer.
 *
 * `keyring` is an override used by tests to pin a known key. Production calls
 * omit it, and the vault resolves `CREDENTIAL_ENCRYPTION_KEY` itself.
 */
export function createCredentialVault(
  persistence: PersistenceLayer,
  keyring?: ConstructorParameters<typeof CredentialVault>[0]['keyring'],
): CredentialVault {
  return new CredentialVault({
    store: new PersistenceCredentialRecordStore(persistence.credentials),
    keyring,
  });
}

/** Convenience for tests and isolated components. */
export function createMemoryCredentialVault(keyring?: ConstructorParameters<typeof CredentialVault>[0]['keyring']): {
  vault: CredentialVault;
  store: MemoryCredentialRecordStore;
} {
  const store = new MemoryCredentialRecordStore();
  return { vault: new CredentialVault({ store, keyring }), store };
}