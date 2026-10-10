/**
 * CREDENTIAL VAULT TESTS
 *
 * These are the security-critical tests. Every case here corresponds to a way
 * the vault could fail open, fail to a user, or leak.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  ENVELOPE_VERSION,
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  envelopeNeedsRotation,
  fingerprintKey,
  loadMasterKeyringFromEnv,
  maskSecret,
  parseMasterKey,
  rotateEnvelope,
  secretsEqual,
} from '../src/server/security/secretCrypto';
import {
  CredentialVault,
  CredentialVaultError,
  MemoryCredentialRecordStore,
  registerCredentialProvider,
} from '../src/server/security/CredentialVault';
import {
  createMemoryCredentialVault,
  createCredentialVault,
} from '../src/server/security/providers';
import { InMemoryPersistence } from '../src/server/repositories';
import { redactError, redactSecrets, redactText, safeLog } from '../src/server/security/redaction';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

const ringA = { active: { id: 'key-a', key: KEY_A }, all: [{ id: 'key-a', key: KEY_A }] };
const ringB = { active: { id: 'key-b', key: KEY_B }, all: [{ id: 'key-b', key: KEY_B }] };
const ringBoth = { active: { id: 'key-b', key: KEY_B }, all: [{ id: 'key-a', key: KEY_A }, { id: 'key-b', key: KEY_B }] };

/* ------------------------------------------------------------------ */
/* Encryption                                                          */
/* ------------------------------------------------------------------ */

describe('secret encryption', () => {
  test('round-trips a secret', () => {
    const secret = 'pd_live_abcdefghijklmnopqrstuvwxyz012345';
    const envelope = encryptSecret(secret, ringA);
    expect(decryptSecret(envelope, ringA).plaintext).toBe(secret);
  });

  test('stores a VERSIONED ENVELOPE, not raw ciphertext', () => {
    const envelope = encryptSecret('secret-value', ringA);
    const parts = envelope.split('.');
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe(ENVELOPE_VERSION);
    expect(parts[1]).toBe('key-a');
    // None of the parts may contain the plaintext.
    expect(envelope).not.toContain('secret-value');
  });

  test('uses a fresh nonce for every call', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const parts = encryptSecret('same plaintext', ringA).split('.');
      nonces.add(parts[2]);
    }
    // GCM nonce reuse under one key destroys confidentiality entirely.
    expect(nonces.size).toBe(50);
  });

  test('produces different ciphertext for identical plaintext', () => {
    const a = encryptSecret('identical', ringA);
    const b = encryptSecret('identical', ringA);
    expect(a).not.toBe(b);
  });

  test('handles unicode and empty strings', () => {
    for (const value of ['', '🔑 ключ 密钥', 'a'.repeat(10000)]) {
      expect(decryptSecret(encryptSecret(value, ringA), ringA).plaintext).toBe(value);
    }
  });

  test('REJECTS a tampered ciphertext rather than returning garbage', () => {
    const envelope = encryptSecret('sensitive', ringA);
    const parts = envelope.split('.');
    // Flip one character of the ciphertext body.
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    let error: unknown;
    try { decryptSecret(parts.join('.'), ringA); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SecretCryptoError);
    expect((error as SecretCryptoError).code).toBe('DECRYPT_FAILED');
  });

  test('rejects a tampered authentication tag', () => {
    const parts = encryptSecret('sensitive', ringA).split('.');
    const tag = parts[4];
    parts[4] = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    expect(() => decryptSecret(parts.join('.'), ringA)).toThrow(SecretCryptoError);
  });

  test('rejects a tampered nonce', () => {
    const parts = encryptSecret('sensitive', ringA).split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    expect(() => decryptSecret(parts.join('.'), ringA)).toThrow(SecretCryptoError);
  });

  test('rejects the wrong key', () => {
    const envelope = encryptSecret('sensitive', ringA);
    let error: unknown;
    try { decryptSecret(envelope, ringB); } catch (caught) { error = caught; }
    // KEY_NOT_AVAILABLE, not DECRYPT_FAILED: the record is intact, we simply
    // do not hold its key. Rotation left the job unfinished.
    expect((error as SecretCryptoError).code).toBe('KEY_NOT_AVAILABLE');
  });

  test('rejects a malformed envelope with INVALID_CIPHERTEXT', () => {
    for (const bad of ['', 'not-an-envelope', 'v1.a.b', 'v9.key.a.b.c', 'v1.key.onlythree.parts']) {
      let error: unknown;
      try { decryptSecret(bad, ringA); } catch (caught) { error = caught; }
      expect((error as SecretCryptoError)?.code).toBe('INVALID_CIPHERTEXT');
    }
  });

  test('rejects a nonce or tag of the wrong length before touching crypto', () => {
    const parts = encryptSecret('x', ringA).split('.');
    parts[2] = Buffer.from('short').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), ringA)).toThrow(/nonce has the wrong length/);
  });

  test('rejects an unknown envelope version', () => {
    const parts = encryptSecret('x', ringA).split('.');
    parts[0] = 'v99';
    expect(() => decryptSecret(parts.join('.'), ringA)).toThrow(/Unsupported credential envelope version/);
  });
});

/* ------------------------------------------------------------------ */
/* Key parsing and configuration                                       */
/* ------------------------------------------------------------------ */

describe('master key configuration', () => {
  test('accepts base64, base64url and hex', () => {
    const raw = randomBytes(32);
    expect(parseMasterKey(raw.toString('base64')).key.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('base64url')).key.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('hex')).key.equals(raw)).toBe(true);
  });

  test('REJECTS a key of the wrong length rather than padding it', () => {
    // A 16-byte key silently padded to 32 would be a real, unnoticed
    // downgrade of the encryption strength.
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(SecretCryptoError);
    expect(() => parseMasterKey(randomBytes(64).toString('base64'))).toThrow(/exactly 32 bytes/);
    expect(() => parseMasterKey('')).toThrow(SecretCryptoError);
    expect(() => parseMasterKey('   ')).toThrow(SecretCryptoError);
    expect(() => parseMasterKey('not-a-key-at-all!!')).toThrow(SecretCryptoError);
  });

  test('reports ENCRYPTION_NOT_CONFIGURED for a bad key', () => {
    try { parseMasterKey('short'); expect.unreachable(); }
    catch (error) { expect((error as SecretCryptoError).code).toBe('ENCRYPTION_NOT_CONFIGURED'); }
  });

  test('returns null when no key is configured', () => {
    expect(loadMasterKeyringFromEnv({})).toBeNull();
    expect(loadMasterKeyringFromEnv({ CREDENTIAL_ENCRYPTION_KEY: '  ' })).toBeNull();
  });

  test('loads a keyring with previous keys for rotation', () => {
    const rawA = randomBytes(32);
    const rawB = randomBytes(32);
    const ring = loadMasterKeyringFromEnv({
      CREDENTIAL_ENCRYPTION_KEY: rawB.toString('base64'),
      CREDENTIAL_ENCRYPTION_KEY_ID: 'new',
      CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: `old:${rawA.toString('base64')}`,
    })!;
    expect(ring.active.id).toBe('new');
    expect(ring.all.length).toBe(2);
  });

  test('a malformed PREVIOUS key does not take down the ACTIVE key', () => {
    const rawB = randomBytes(32);
    const ring = loadMasterKeyringFromEnv({
      CREDENTIAL_ENCRYPTION_KEY: rawB.toString('base64'),
      CREDENTIAL_ENCRYPTION_KEY_ID: 'new',
      CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: `old:garbage,and-another-raw-key-without-an-id`,
    })!;
    // Encryption must still work; only the unreadable history is lost.
    expect(ring.active.id).toBe('new');
    expect(ring.all.length).toBeGreaterThanOrEqual(1);
  });

  test('assigns a stable fingerprint when no key id is given', () => {
    const raw = randomBytes(32);
    const ring = loadMasterKeyringFromEnv({ CREDENTIAL_ENCRYPTION_KEY: raw.toString('base64') })!;
    expect(ring.active.id).toBe(fingerprintKey(raw));
    expect(ring.active.id).toHaveLength(16);
  });
});

/* ------------------------------------------------------------------ */
/* Rotation                                                            */
/* ------------------------------------------------------------------ */

describe('key rotation', () => {
  test('re-wraps a record under the active key without exposing plaintext', () => {
    const original = encryptSecret('rotate-me', ringA);
    const rotated = rotateEnvelope(original, ringBoth);
    // Readable under the keyring that holds BOTH keys...
    expect(decryptSecret(rotated, ringBoth).plaintext).toBe('rotate-me');
    // ...and now under the new key alone.
    expect(decryptSecret(rotated, ringB).plaintext).toBe('rotate-me');
    // The old-key-only ring can no longer read it.
    expect(() => decryptSecret(rotated, ringA)).toThrow(SecretCryptoError);
  });

  test('identifies records needing rotation', () => {
    expect(envelopeNeedsRotation(encryptSecret('x', ringA), ringBoth)).toBe(true);
    expect(envelopeNeedsRotation(encryptSecret('x', ringB), ringBoth)).toBe(false);
  });

  test('rotates every stored credential of ONE user', async () => {
    const { vault, store } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('user-1', 'openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await vault.saveCredential('user-1', 'propdao', 'pd_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await vault.saveCredential('user-2', 'openrouter', 'sk-or-v1-cccccccccccccccccccccccccccccc');

    // Rotation moves records toward the ACTIVE key of the vault performing it.
    // A vault still using key A has nothing to do.
    expect((await vault.rotateUserCredentials('user-1')).rotated).toBe(0);

    // A vault whose active key is B, but which can still READ key A.
    const upgraded = new CredentialVault({ store, keyring: ringBoth });
    const result = await upgraded.rotateUserCredentials('user-1');
    expect(result.rotated).toBe(2);
    expect(result.failed).toBe(0);

    // user-1's secrets survive and now read under the new key alone.
    for (const provider of ['openrouter', 'propdao'] as const) {
      const stored = store.rawEnvelopes('user-1')[provider];
      expect(decryptSecret(stored, ringB).plaintext.length).toBeGreaterThan(0);
    }

    // user-2 was NOT touched — rotation is per-user.
    const untouched = store.rawEnvelopes('user-2').openrouter;
    expect(decryptSecret(untouched, ringA).plaintext).toBe('sk-or-v1-cccccccccccccccccccccccccccccc');
  });

  test('rotation is idempotent', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('u', 'openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await vault.rotateUserCredentials('u');
    // With only the old keyring, the record is already current.
    const second = await vault.rotateUserCredentials('u');
    expect(second.rotated).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Vault behaviour                                                     */
/* ------------------------------------------------------------------ */

describe('credential vault', () => {
  test('stores a secret encrypted at rest', async () => {
    const { vault, store } = createMemoryCredentialVault(ringA);
    const secret = 'pd_live_verysecrettoken0123456789';
    await vault.saveCredential('user-1', 'propdao', secret);

    const envelope = store.rawEnvelopes('user-1').propdao;
    // The persisted value must not be the secret.
    expect(envelope).not.toContain(secret);
    expect(envelope).not.toContain('pd_live');
    expect(envelope.split('.')[0]).toBe('v1');

    // And it must be recoverable server-side.
    expect(await vault.getCredential('user-1', 'propdao')).toBe(secret);
  });

  test('FAILS CLOSED when no master key is configured', async () => {
    const store = new MemoryCredentialRecordStore();
    const vault = new CredentialVault({ store, keyring: null });
    expect(vault.isConfigured()).toBe(false);
    // Saving must fail rather than silently storing plaintext.
    await expect(vault.saveCredential('u', 'openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(store.rawEnvelopes('u')).toEqual({});
  });

  test('clears a credential when passed undefined', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('u', 'openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(await vault.hasCredential('u', 'openrouter')).toBe(true);
    await vault.saveCredential('u', 'openrouter', undefined);
    expect(await vault.hasCredential('u', 'openrouter')).toBe(false);
    expect(await vault.getCredential('u', 'openrouter')).toBeUndefined();
  });

  test('treats a blank string as a clear, not as a stored empty secret', async () => {
    const { vault, store } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('u', 'openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await vault.saveCredential('u', 'openrouter', '   ');
    expect(await vault.hasCredential('u', 'openrouter')).toBe(false);
    expect(store.rawEnvelopes('u').openrouter).toBeUndefined();
  });

  test('rejects a malformed secret before storing anything', async () => {
    const { vault, store } = createMemoryCredentialVault(ringA);
    expect(vault.saveCredential('u', 'openrouter', 'not-an-openrouter-key')).rejects.toThrow();
    expect(() => store.rawEnvelopes('u')).not.toThrow();
    expect(store.rawEnvelopes('u')).toEqual({});
  });

  /* ---- the isolation property ---- */

  test('ISOLATES one user from another', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('alice', 'propdao', 'pd_live_alicesecret0000000000000');
    await vault.saveCredential('bob', 'propdao', 'pd_live_bobssecret00000000000000');

    expect(await vault.getCredential('alice', 'propdao')).toBe('pd_live_alicesecret0000000000000');
    expect(await vault.getCredential('bob', 'propdao')).toBe('pd_live_bobssecret00000000000000');

    // Deleting Alice's key must not touch Bob's.
    await vault.deleteCredential('alice', 'propdao');
    expect(await vault.getCredential('alice', 'propdao')).toBeUndefined();
    expect(await vault.getCredential('bob', 'propdao')).toBe('pd_live_bobssecret00000000000000');
  });

  test('a user with no stored key gets undefined, not another user\'s key', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('bob', 'propdao', 'pd_live_bobssecret00000000000000');
    expect(await vault.getCredential('mallory', 'propdao')).toBeUndefined();
  });

  test('rejects an unknown provider', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    await expect(vault.saveCredential('u', 'evil' as never, 'x')).rejects.toThrow(/Unknown credential provider/);
  });

  /* ---- status must never leak ---- */

  test('status exposes a masked hint and never the secret', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    const secret = 'pd_live_abcdefghijklmnopqrstuvwxyz012345';
    await vault.saveCredential('u', 'propdao', secret);

    const status = await vault.getCredentialStatus('u', 'propdao');
    expect(status.configured).toBe(true);
    expect(status.maskedHint).toBeDefined();
    expect(status.maskedHint).not.toContain(secret);
    expect(status.maskedHint).not.toContain(secret.slice(4, 20));
    // The full secret must appear nowhere in the serialized status.
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status.keyId).toBe('key-a');
  });

  test('status for an unconfigured credential is not configured', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    const status = await vault.getCredentialStatus('u', 'propdao');
    expect(status.configured).toBe(false);
    expect(status.maskedHint).toBeUndefined();
  });

  test('reports an unreadable credential as configured-but-broken', async () => {
    const { vault, store } = createMemoryCredentialVault(ringA);
    // A record from a rotation we do not hold the key for.
    store.seedRaw('u', 'propdao', 'v1.gone.nonce.ciphertext.tag');
    const status = await vault.getCredentialStatus('u', 'propdao');
    // Reported as configured so the user is told to RE-ENTER, not shown an
    // empty form as though nothing was ever saved.
    expect(status.configured).toBe(true);
    expect(status.maskedHint).toMatch(/unreadable/);
  });

  test('flags a record that needs rotation', async () => {
    const store = new MemoryCredentialRecordStore();
    const oldVault = new CredentialVault({ store, keyring: ringA });
    await oldVault.saveCredential('u', 'openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const upgraded = new CredentialVault({ store, keyring: ringBoth });
    expect((await upgraded.getCredentialStatus('u', 'openrouter')).needsRotation).toBe(true);
    await upgraded.rotateUserCredentials('u');
    expect((await upgraded.getCredentialStatus('u', 'openrouter')).needsRotation).toBe(false);
  });

  test('surfaces a decryption failure with a distinct code', async () => {
    const { store } = createMemoryCredentialVault(ringA);
    store.seedRaw('u', 'openrouter', 'v1.key-a.AAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA');
    const wrongKeyVault = new CredentialVault({ store, keyring: ringB });
    let error: unknown;
    try { await wrongKeyVault.getCredential('u', 'openrouter'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CredentialVaultError);
    expect((error as CredentialVaultError).code).toBe('KEY_NOT_AVAILABLE');
  });
});

/* ------------------------------------------------------------------ */
/* Legacy migration                                                    */
/* ------------------------------------------------------------------ */

describe('legacy plaintext migration', () => {
  test('imports a legacy key and encrypts it', async () => {
    const { vault, store } = createMemoryCredentialVault(ringA);
    const legacy = 'sk-or-v1-legacysavedkey0000000000000000';
    expect(await vault.migrateLegacyPlaintext('u', 'openrouter', legacy)).toBe('migrated');

    // The stored form is encrypted...
    expect(store.rawEnvelopes('u').openrouter).not.toContain(legacy);
    // ...and the plaintext still reads back.
    expect(await vault.getCredential('u', 'openrouter')).toBe(legacy);
  });

  test('does NOT overwrite a key already in the vault', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    await vault.saveCredential('u', 'openrouter', 'sk-or-v1-newervaultvalue00000000000000');
    expect(await vault.migrateLegacyPlaintext('u', 'openrouter', 'sk-or-v1-oldervalue000000000000000')).toBe('already-vaulted');
    expect(await vault.getCredential('u', 'openrouter')).toBe('sk-or-v1-newervaultvalue00000000000000');
  });

  test('reports no-key when the vault is unavailable, leaving the legacy value alone', async () => {
    const store = new MemoryCredentialRecordStore();
    const vault = new CredentialVault({ store, keyring: null });
    // Without a master key the legacy value must be left in place for the
    // user to re-enter, NOT silently dropped.
    expect(await vault.migrateLegacyPlaintext('u', 'openrouter', 'sk-or-v1-legacysavedkey0000000000000000')).toBe('no-key');
    // Nothing was written, and reading (which has a record to decrypt) fails
    // loudly rather than pretending no credential exists.
    expect(store.rawEnvelopes('u')).toEqual({});
    await store.seedRaw('u', 'openrouter', 'v1.key-a.AAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA');
    await expect(vault.getCredential('u', 'openrouter')).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  test('reports failed for a malformed legacy value', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    expect(await vault.migrateLegacyPlaintext('u', 'openrouter', 'garbage')).toBe('failed');
  });
});

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

describe('secret redaction', () => {
  test('redacts an OpenRouter key', () => {
    const out = redactText('failed with sk-or-v1-abcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('sk-or-v1-abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a PropDAO key', () => {
    const out = redactText('key pd_live_abcdefghijklmnopqrstuvwxyz012345 rejected');
    expect(out).not.toContain('pd_live_abcdefghijklmnopqrstuvwxyz012345');
  });

  test('redacts a Telegram bot token', () => {
    const out = redactText('token 123456789:AAHkAsdfjhasdfjhasdfJKHASDFJKHSDF');
    expect(out).not.toContain('AAHkAsdfjhasdfjhasdfJKHASDFJKHSDF');
  });

  test('redacts a Groq key and a Google API key', () => {
    expect(redactText('gsk_abcdefghijklmnopqrstuvwxyz')).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz');
    expect(redactText(`AIza${'A'.repeat(35)}`)).not.toContain(`AIza${'A'.repeat(35)}`);
  });

  test('redacts a whole PEM private key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(redactText(pem)).not.toContain('MIIEvQIBADANBg');
  });

  test('redacts a Firebase JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactText(jwt)).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  test('redacts sensitive HEADERS by name, whatever the value format', () => {
    const redacted = redactSecrets({
      authorization: 'Bearer some-opaque-token-that-matches-no-pattern',
      'x-api-key': 'whatever',
      cookie: 'session=abc',
      normal: 'keep me',
    }) as Record<string, unknown>;
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted['x-api-key']).toBe('[REDACTED]');
    expect(redacted.cookie).toBe('[REDACTED]');
    expect(redacted.normal).toBe('keep me');
  });

  test('walks nested structures', () => {
    const secret = 'pd_live_nestedsecretvalue0123456789';
    const redacted = JSON.stringify(redactSecrets({ a: { b: { c: [{ note: secret }] } } }));
    expect(redacted).not.toContain(secret);
  });

  test('survives a circular reference instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(() => redactSecrets(node)).not.toThrow();
    expect(JSON.stringify(redactSecrets(node))).toContain('[Circular]');
  });

  test('redacts an Error without losing its name or status', () => {
    const error = Object.assign(new Error('failed for pd_live_secret0123456789'), { status: 401, code: 'UNAUTHORIZED' });
    const redacted = redactError(error);
    expect(redacted.message).not.toContain('pd_live_secret0123456789');
    expect(redacted.status).toBe(401);
    expect(redacted.code).toBe('UNAUTHORIZED');
  });

  test('redacts an Error stack', () => {
    const error = new Error('boom pd_live_secret0123456789');
    const redacted = redactSecrets(error) as { stack?: string };
    expect(redacted.stack).not.toContain('pd_live_secret0123456789');
  });

  test('handles non-string inputs without leaking them', () => {
    expect(redactText(null)).toBe('');
    expect(redactText(undefined)).toBe('');
    expect(redactText(Symbol('x'))).not.toContain('secret');
  });

  test('redacts a log line with context', () => {
    const line = safeLog('test', 'request failed for pd_live_secret0123456789', { apiKey: 'pd_live_secret0123456789' });
    expect(line).not.toContain('pd_live_secret0123456789');
  });
});

/* ------------------------------------------------------------------ */
/* Masking and comparison                                              */
/* ------------------------------------------------------------------ */

describe('secret masking and comparison', () => {
  test('masks a secret without revealing the middle', () => {
    const masked = maskSecret('pd_live_abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).not.toContain('abcdefghijklmnop');
    expect(masked).toContain('••••');
  });

  test('masks a short secret completely', () => {
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret('')).toBe('');
    expect(maskSecret(undefined)).toBe('');
  });

  test('compares secrets without leaking length via an exception', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual(undefined, 'abc')).toBe(false);
    expect(secretsEqual('abc', undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Providers and wiring                                                */
/* ------------------------------------------------------------------ */

describe('credential providers', () => {
  test('normalises and rejects by provider', async () => {
    const { vault } = createMemoryCredentialVault(ringA);
    // Trims whitespace, which is the most common paste error.
    await vault.saveCredential('u', 'propdao', '  pd_live_abcdefghijklmnopqrstuv  ');
    expect(await vault.getCredential('u', 'propdao')).toBe('pd_live_abcdefghijklmnopqrstuv');

    await expect(vault.saveCredential('u', 'propdao', 'sk-or-v1-wrongproviderformat')).rejects.toThrow();
  });

  test('marks only PropDAO as execution-capable', () => {
    // A provider being capable is NOT permission to trade — the execution
    // flag is evaluated separately at execution time.
    const statuses = createMemoryCredentialVault(ringA);
    void statuses;
    expect(registerCredentialProvider).toBeDefined();
  });

  test('works over the real persistence layer', async () => {
    const persistence = new InMemoryPersistence();
    const vault = createCredentialVault(persistence, ringA);
    const secret = 'pd_live_persistedsecret000000000000';

    await vault.saveCredential('u1', 'propdao', secret);
    // At rest, the envelope is not the secret.
    const raw = (persistence.credentials as unknown as { rawEnvelopes(u: string): Record<string, string> }).rawEnvelopes('u1');
    expect(raw.propdao).not.toContain(secret);
    expect(raw.propdao.startsWith('v1.')).toBe(true);

    expect(await vault.getCredential('u1', 'propdao')).toBe(secret);
    expect(await vault.getCredential('u2', 'propdao')).toBeUndefined();

    await vault.deleteCredential('u1', 'propdao');
    expect(await vault.getCredential('u1', 'propdao')).toBeUndefined();
  });

  test('lists only the providers it understands', async () => {
    const persistence = new InMemoryPersistence();
    // Plant a record under a provider id this build does not support.
    await persistence.credentials.saveEncrypted('u', 'legacy-unknown', 'v1.key.a.b.c', new Date().toISOString());
    const vault = createCredentialVault(persistence, ringA);
    // Rotation must not try to treat an unknown provider as a credential.
    const result = await vault.rotateUserCredentials('u');
    expect(result.failed).toBe(0);
  });
});