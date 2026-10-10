/**
 * CREDENTIAL VAULT
 * ================
 * The single server-side entry point for user-supplied secrets.
 *
 * Every integration — OpenRouter, Groq, PropDAO, Telegram — saves and reads
 * its secret HERE. An integration that hand-rolls its own storage is the
 * failure mode this module exists to prevent, so `registerCredentialProvider`
 * is the only supported way to add one.
 *
 * DESIGN RULES ENFORCED HERE
 *
 *  1. THE CALLER NEVER SUPPLIES THE USER ID AS AUTHORITY.
 *     `CredentialVault` methods take a `userId` that the HTTP layer has
 *     already derived from a verified Firebase token (`req.user.uid`). The
 *     vault itself has no notion of a request, so it cannot be tricked into
 *     reading another user's key by a body field. Routes must pass
 *     `requireUser(req).uid`, never `req.body.userId`.
 *
 *  2. SECRETS GO IN, STATUS COMES OUT.
 *     `saveCredential` returns void. `getCredentialStatus` returns only
 *     {configured, updatedAt, maskedHint, keyId}. There is deliberately no
 *     route that returns a decrypted secret to a browser; the only readers
 *     are server-side call sites that need to call the provider itself.
 *
 *  3. FAIL CLOSED, NEVER SILENTLY DOWNGRADE.
 *     With no master key configured, `save` throws
 *     `ENCRYPTION_NOT_CONFIGURED` and `get` throws the same. Falling back to
 *     plaintext would look identical to success in the UI while leaving keys
 *     in the clear on disk.
 *
 *  4. LOGGING IS NOT THE CALLER'S JOB.
 *     `redactSecrets` is applied to every value before it reaches a log
 *     line, an audit record or a stored provider response.
 */

import {
  MasterKeyring,
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  envelopeNeedsRotation,
  loadMasterKeyringFromEnv,
  maskSecret,
  rotateEnvelope,
} from './secretCrypto';
import { redactSecrets } from './redaction';

/** Ids are stable strings: they are persisted inside every envelope. */
export type CredentialProviderId =
  | 'openrouter'
  | 'groq'
  | 'propdao'
  | 'telegram';

export interface CredentialProviderDescriptor {
  id: CredentialProviderId;
  /** Shown in Settings. */
  label: string;
  /** Shape-only validation run BEFORE any encryption or storage. */
  normalise?: (value: string) => string | undefined;
  /**
   * Whether this secret authorises MONEY MOVEMENT.
   *
   * Execution paths check this and additionally check a server-side feature
   * flag. Storing a key is never the same permission as trading with it.
   */
  executionCapable: boolean;
}

const PROVIDERS = new Map<CredentialProviderId, CredentialProviderDescriptor>();

export function registerCredentialProvider(descriptor: CredentialProviderDescriptor): void {
  PROVIDERS.set(descriptor.id, descriptor);
}

export function describeCredentialProvider(id: CredentialProviderId): CredentialProviderDescriptor | undefined {
  return PROVIDERS.get(id);
}

export function listCredentialProviders(): CredentialProviderDescriptor[] {
  return [...PROVIDERS.values()];
}

/** What a client is allowed to know about a stored credential. */
export interface CredentialStatus {
  provider: CredentialProviderId;
  configured: boolean;
  /** When the secret was last written. ISO-8601. */
  updatedAt?: string;
  /** e.g. "sk-o••••3f2a (73 chars)". Never the secret itself. */
  maskedHint?: string;
  /** Id of the master key the record is encrypted under. Drives rotation. */
  keyId?: string;
  /** True when the record was written under a non-active key. */
  needsRotation?: boolean;
  /** Server-side capability flags, never secrets. */
  executionCapable: boolean;
}

/**
 * The storage port. Deliberately narrow: put/get/delete/list per user.
 *
 * There is no "return every record for every user" method, because there is
 * no caller that needs one and every such method is a mass-disclosure waiting
 * to happen. Rotation walks a single user's records instead.
 */
export interface CredentialRecordStore {
  saveEncrypted(userId: string, provider: CredentialProviderId, envelope: string, updatedAt: string): Promise<void>;
  readEncrypted(userId: string, provider: CredentialProviderId): Promise<{ envelope: string; updatedAt: string } | null>;
  delete(userId: string, provider: CredentialProviderId): Promise<void>;
  /** Every stored (provider, envelope) pair for ONE user. */
  listEncrypted(userId: string): Promise<Array<{ provider: CredentialProviderId; envelope: string; updatedAt: string }>>;
}

export class CredentialVaultError extends Error {
  readonly code: SecretCryptoError['code'] | 'UNKNOWN_PROVIDER';

  constructor(code: CredentialVaultError['code'], message: string) {
    super(message);
    this.name = 'CredentialVaultError';
    this.code = code;
  }
}

export interface CredentialVaultOptions {
  store: CredentialRecordStore;
  /** Overrides `loadMasterKeyringFromEnv`. Tests inject a fixed key. */
  keyring?: MasterKeyring | null;
}

export class CredentialVault {
  private readonly store: CredentialRecordStore;
  private readonly keyringOverride: MasterKeyring | null | undefined;

  constructor(options: CredentialVaultOptions) {
    this.store = options.store;
    this.keyringOverride = options.keyring;
  }

  /**
   * Resolves the keyring.
   *
   * Cached per vault instance so a request does not re-parse the key on every
   * field access. `resetKeyringCache` exists for tests and for a runtime that
   * reloads its secret store.
   */
  private keyring(): MasterKeyring {
    const ring =
      this.keyringOverride !== undefined
        ? this.keyringOverride
        : loadMasterKeyringFromEnv();

    if (!ring) {
      throw new CredentialVaultError(
        'ENCRYPTION_NOT_CONFIGURED',
        'Credential storage is unavailable: CREDENTIAL_ENCRYPTION_KEY is not set on the server. ' +
          'Credentials cannot be saved until a 32-byte master key is configured.',
      );
    }
    return ring;
  }

  isConfigured(): boolean {
    try {
      this.keyring();
      return true;
    } catch {
      return false;
    }
  }

  private assertProvider(provider: CredentialProviderId): CredentialProviderDescriptor {
    const descriptor = PROVIDERS.get(provider);
    if (!descriptor) {
      throw new CredentialVaultError(
        'UNKNOWN_PROVIDER',
        `Unknown credential provider "${String(provider)}".`,
      );
    }
    return descriptor;
  }

  /**
   * Encrypts and stores a secret.
   *
   * Returns void on purpose: no route should ever have a value to echo back.
   * `undefined` CLEARS the credential, matching the long-standing settings
   * semantics where an absent field means "leave unchanged" and an explicit
   * null means "remove".
   */
  async saveCredential(
    userId: string,
    provider: CredentialProviderId,
    secret: string | undefined | null,
  ): Promise<void> {
    const descriptor = this.assertProvider(provider);

    if (secret === undefined || secret === null) {
      await this.store.delete(userId, provider);
      return;
    }

    const normalised = descriptor.normalise
      ? descriptor.normalise(secret)
      : secret.trim() || undefined;

    if (!normalised) {
      await this.store.delete(userId, provider);
      return;
    }

    const envelope = encryptSecret(normalised, this.keyring());
    await this.store.saveEncrypted(userId, provider, envelope, new Date().toISOString());
  }

  /**
   * Decrypts a secret for SERVER-SIDE use.
   *
   * Never call this from a route handler whose result reaches the client. The
   * callers are `reasoningGateway` (to call OpenRouter) and the PropDAO
   * adapter (to call PropDAO) — both of which then make an outbound request
   * and return provider data, not the key.
   */
  async getCredential(
    userId: string,
    provider: CredentialProviderId,
  ): Promise<string | undefined> {
    this.assertProvider(provider);
    const record = await this.store.readEncrypted(userId, provider);
    if (!record) return undefined;

    try {
      return decryptSecret(record.envelope, this.keyring()).plaintext;
    } catch (error) {
      if (error instanceof SecretCryptoError) {
        throw new CredentialVaultError(error.code, error.message);
      }
      throw error;
    }
  }

  async deleteCredential(userId: string, provider: CredentialProviderId): Promise<void> {
    this.assertProvider(provider);
    await this.store.delete(userId, provider);
  }

  async hasCredential(userId: string, provider: CredentialProviderId): Promise<boolean> {
    this.assertProvider(provider);
    const record = await this.store.readEncrypted(userId, provider);
    return record !== null;
  }

  /**
   * Status for the Settings UI.
   *
   * The masked hint is produced by decrypting IN MEMORY to reveal only the
   * first/last four characters, then discarding. That is a deliberate,
   * bounded read of the plaintext: it never leaves this function, and it is
   * the only reason the UI can show "which key is this" without the secret
   * being retrievable by the browser.
   */
  async getCredentialStatus(
    userId: string,
    provider: CredentialProviderId,
  ): Promise<CredentialStatus> {
    const descriptor = this.assertProvider(provider);
    const record = await this.store.readEncrypted(userId, provider);

    if (!record) {
      return { provider, configured: false, executionCapable: descriptor.executionCapable };
    }

    const keyId = record.envelope.split('.')[1];

    let maskedHint: string | undefined;
    try {
      const { plaintext } = decryptSecret(record.envelope, this.keyring());
      maskedHint = maskSecret(plaintext);
    } catch {
      // Stored but unreadable (wrong/absent key, or corrupted). Report it as
      // configured-but-broken rather than "not configured", so the user is
      // told to RE-ENTER instead of being confused about a key they saved.
      maskedHint = 'unreadable — please re-enter';
    }

    return {
      provider,
      configured: true,
      updatedAt: record.updatedAt,
      maskedHint,
      keyId,
      needsRotation: this.safeNeedsRotation(record.envelope),
      executionCapable: descriptor.executionCapable,
    };
  }

  private safeNeedsRotation(envelope: string): boolean {
    try {
      return envelopeNeedsRotation(envelope, this.keyring());
    } catch {
      return false;
    }
  }

  /**
   * Rotates every stored credential of ONE user under the active key.
   *
   * This is the operational half of key rotation: records keep decrypting
   * under the old key until each is rewritten, and `needsRotation` in the
   * status tells the operator exactly how much is left to do. It is
   * deliberately per-user and idempotent, so it can be run repeatedly.
   */
  async rotateUserCredentials(
    userId: string,
  ): Promise<{ rotated: number; failed: number; errors: Array<{ provider: CredentialProviderId; code: string }> }> {
    const ring = this.keyring();
    const records = await this.store.listEncrypted(userId);

    let rotated = 0;
    let failed = 0;
    const errors: Array<{ provider: CredentialProviderId; code: string }> = [];

    for (const record of records) {
      if (!envelopeNeedsRotation(record.envelope, ring)) continue;
      try {
        await this.store.saveEncrypted(
          userId,
          record.provider,
          rotateEnvelope(record.envelope, ring),
          new Date().toISOString(),
        );
        rotated += 1;
      } catch (error) {
        failed += 1;
        errors.push({
          provider: record.provider,
          code: error instanceof SecretCryptoError ? error.code : 'UNKNOWN',
        });
      }
    }

    return { rotated, failed, errors };
  }

  /**
   * Imports a LEGACY plaintext secret into the vault and removes the original.
   *
   * Used by the one-shot migration for the plaintext OpenRouter/Groq keys the
   * previous build wrote into `keys.openRouter` / `keys.groq`. The plaintext
   * is only touched when a master key is available — without one, the caller
   * must leave the legacy value alone and ask the user to re-enter it, because
   * "migrate by not migrating" is still better than "migrate by dropping".
   *
   * Returns `'migrated' | 'already-vaulted' | 'no-key' | 'failed'`.
   */
  async migrateLegacyPlaintext(
    userId: string,
    provider: CredentialProviderId,
    legacyPlaintext: string | undefined,
  ): Promise<'migrated' | 'already-vaulted' | 'no-key' | 'failed'> {
    if (!legacyPlaintext || legacyPlaintext.trim().length === 0) return 'no-key';
    if (await this.hasCredential(userId, provider)) return 'already-vaulted';
    if (!this.isConfigured()) return 'no-key';

    try {
      await this.saveCredential(userId, provider, legacyPlaintext);
      return 'migrated';
    } catch {
      return 'failed';
    }
  }
}

/**
 * A vault whose storage is a plain in-memory map.
 *
 * Used by tests and by the ephemeral serverless path where no durable store is
 * reachable. NEVER wire this to a production `createApp()`: it would silently
 * drop every key on cold start.
 */
export class MemoryCredentialRecordStore implements CredentialRecordStore {
  private readonly records = new Map<string, Map<CredentialProviderId, { envelope: string; updatedAt: string }>>();

  private bucket(userId: string) {
    let entry = this.records.get(userId);
    if (!entry) {
      entry = new Map();
      this.records.set(userId, entry);
    }
    return entry;
  }

  async saveEncrypted(userId: string, provider: CredentialProviderId, envelope: string, updatedAt: string) {
    this.bucket(userId).set(provider, { envelope, updatedAt });
  }

  async readEncrypted(userId: string, provider: CredentialProviderId) {
    return this.records.get(userId)?.get(provider) ?? null;
  }

  async delete(userId: string, provider: CredentialProviderId) {
    this.records.get(userId)?.delete(provider);
  }

  async listEncrypted(userId: string) {
    const entry = this.records.get(userId);
    if (!entry) return [];
    return [...entry.entries()].map(([provider, value]) => ({ provider, ...value }));
  }

  /** Test helper: the raw envelopes, for asserting at-rest encryption. */
  rawEnvelopes(userId: string): Record<string, string> {
    const entry = this.records.get(userId);
    const out: Record<string, string> = {};
    if (entry) {
      for (const [provider, value] of entry.entries()) out[provider] = value.envelope;
    }
    return out;
  }

  /** Test helper: plant a value without going through encryption. */
  seedRaw(userId: string, provider: CredentialProviderId, envelope: string, updatedAt = new Date().toISOString()): void {
    this.bucket(userId).set(provider, { envelope, updatedAt });
  }
}

export { redactSecrets, maskSecret };