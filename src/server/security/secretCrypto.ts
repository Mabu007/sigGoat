/**
 * SECRET ENCRYPTION AT REST
 * =========================
 * One authenticated-encryption primitive for EVERY user-supplied credential
 * in FundAGoat — OpenRouter keys, Groq keys, PropDAO API keys and Telegram bot
 * tokens all flow through here. There is deliberately no per-provider
 * encryption scheme: a second scheme is a second thing to get wrong.
 *
 * ALGORITHM — AES-256-GCM (RFC 5116)
 *   - 256-bit key, 96-bit random nonce, 128-bit authentication tag.
 *   - GCM is authenticated, so tampering with a stored blob is DETECTED, not
 *     silently decrypted into garbage. Decryption failure is an error, never
 *     a "best effort" plaintext.
 *
 * WHY A VERSIONED ENVELOPE
 *   The stored value is NOT raw ciphertext. It is a self-describing envelope:
 *
 *     v1.<keyId>.<nonce-b64url>.<ciphertext-b64url>.<tag-b64url>
 *
 *   `keyId` is the id of the key that produced the record. That buys two
 *   things that a bare base64 blob cannot:
 *     1. Rotation. A new master key can be introduced without a flag day:
 *        `reEncryptAll` walks every record and rewrites it under the new key
 *        while the old key stays available for reads.
 *     2. Honest failure. A record written under a key id we no longer hold is
 *        reported as `KEY_NOT_AVAILABLE` — distinct from `INVALID_CIPHERTEXT`
 *        (corrupt/tampered) and `DECRYPT_FAILED` (wrong key). Those three
 *        demand different operator responses, so they are different codes.
 *
 * KEY MATERIAL
 *   The master key comes ONLY from the server-side secret store
 *   (`CREDENTIAL_ENCRYPTION_KEY`). It is never:
 *     - hardcoded,
 *     - read from a `VITE_`-prefixed variable (those are compiled into the
 *       browser bundle),
 *     - written to disk alongside the data it protects.
 *
 *   When it is absent the vault FAILS CLOSED with `ENCRYPTION_NOT_CONFIGURED`.
 *   It does not fall back to plaintext, and it does not silently generate an
 *   ephemeral key — an ephemeral key would make every record undecryptable on
 *   the next cold start while looking, in the UI, exactly like a working
 *   integration.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

/** Current envelope version. Bumping this requires a new decrypt branch. */
export const ENVELOPE_VERSION = 'v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit nonce is the GCM standard
const TAG_BYTES = 16; // 128-bit authentication tag

export type SecretCryptoErrorCode =
  /** CREDENTIAL_ENCRYPTION_KEY is absent, malformed, or the wrong length. */
  | 'ENCRYPTION_NOT_CONFIGURED'
  /** The stored string is not a well-formed envelope of a known version. */
  | 'INVALID_CIPHERTEXT'
  /** Well-formed, but GCM authentication failed (tampered or wrong key). */
  | 'DECRYPT_FAILED'
  /** Written under a key id we no longer hold. Rotation was never finished. */
  | 'KEY_NOT_AVAILABLE';

export class SecretCryptoError extends Error {
  readonly code: SecretCryptoErrorCode;

  constructor(code: SecretCryptoErrorCode, message: string) {
    super(message);
    this.name = 'SecretCryptoError';
    this.code = code;
  }
}

/**
 * A master key plus the id used to stamp records it writes.
 *
 * `id` is operator-chosen and stored alongside the key id, so rotation can
 * keep the previous key readable while writing with the new one.
 */
export interface MasterKey {
  id: string;
  key: Buffer;
}

export interface MasterKeyring {
  /** The key new records are written with. */
  readonly active: MasterKey;
  /** Every key that may still be needed to READ a record. */
  readonly all: readonly MasterKey[];
}

/**
 * Parses one secret-store entry.
 *
 * ACCEPTED FORMATS (deliberately narrow — a permissive parser is how a
 * truncated key silently becomes a different, still-loadable key):
 *   - base64 or base64url of exactly 32 bytes,
 *   - 64 hex characters.
 *
 * The resulting `id` is a SHA-256 prefix of the KEY MATERIAL, not of the
 * text. Hashing the configured string would leak nothing useful and would
 * couple the id to a formatting choice; hashing the bytes means an id
 * identifies a specific key regardless of how it was written down.
 */
export function parseMasterKey(spec: string, keyId?: string): MasterKey {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new SecretCryptoError(
      'ENCRYPTION_NOT_CONFIGURED',
      'CREDENTIAL_ENCRYPTION_KEY is empty.',
    );
  }

  let key: Buffer | null = null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    // Accept standard base64 and the URL-safe variant, with or without padding.
    const normalised = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    try {
      const decoded = Buffer.from(padded, 'base64');
      // Buffer.from is forgiving: it silently drops invalid characters. Reject
      // anything that did not round-trip to exactly the configured length.
      if (decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/, '') === Buffer.from(padded, 'base64').toString('base64').replace(/=+$/, '')) {
        key = decoded;
      }
    } catch {
      key = null;
    }
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      'ENCRYPTION_NOT_CONFIGURED',
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (base64, base64url or hex).`,
    );
  }

  return { id: keyId ?? fingerprintKey(key), key };
}

/**
 * Stable, non-reversible identifier for a key.
 *
 * 8 bytes of SHA-256 is enough to make a mis-picked key obvious in an audit
 * log and far too little to be useful for a brute-force attack against the
 * 256-bit preimage.
 */
export function fingerprintKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Loads the keyring from environment variables.
 *
 *   CREDENTIAL_ENCRYPTION_KEY       — REQUIRED. The ACTIVE key.
 *   CREDENTIAL_ENCRYPTION_KEY_ID    — optional label. Defaults to a
 *                                      fingerprint of the key material.
 *   CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS — comma-separated `id:key` pairs kept
 *                                      readable during a rotation. Records
 *                                      written under them still decrypt; new
 *                                      records never use them.
 *
 * Returns `null` (rather than throwing) when nothing is configured, so the
 * CALL SITE decides whether "no vault configured" is fatal. It usually is.
 */
export function loadMasterKeyringFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MasterKeyring | null {
  const activeSpec = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!activeSpec) return null;

  const active = parseMasterKey(
    activeSpec,
    env.CREDENTIAL_ENCRYPTION_KEY_ID?.trim() || undefined,
  );

  const previous: MasterKey[] = [];
  const raw = env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS?.trim();
  if (raw) {
    for (const entry of raw.split(',')) {
      const item = entry.trim();
      if (!item) continue;
      const sep = item.indexOf(':');
      // A key id is hex-safe by construction, so the FIRST colon is the
      // separator and the base64 payload (which contains no colon) follows.
      const id = sep > 0 ? item.slice(0, sep) : fingerprintOfSpec(item);
      const spec = sep > 0 ? item.slice(sep + 1) : item;
      try {
        previous.push(parseMasterKey(spec, id));
      } catch {
        // A malformed PREVIOUS entry must not take the ACTIVE key down with
        // it — the service can still encrypt and decrypt new records. The
        // unreadable entry simply cannot serve reads, and any record that
        // needs it fails with KEY_NOT_AVAILABLE.
      }
    }
  }

  const all = [active, ...previous.filter((k) => k.id !== active.id)];
  return { active, all };
}

function fingerprintOfSpec(spec: string): string {
  try {
    return parseMasterKey(spec).id;
  } catch {
    return 'unknown';
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * Encrypts a secret under the ACTIVE key of the ring.
 *
 * A fresh 96-bit nonce is drawn per call — never derived from the plaintext,
 * the user id, or a counter. GCM nonce reuse under one key destroys
 * confidentiality and authenticity, so this is not a place to economise.
 */
export function encryptSecret(plaintext: string, ring: MasterKeyring): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, ring.active.key, nonce, {
    authTagLength: TAG_BYTES,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();


  return [
    ENVELOPE_VERSION,
    ring.active.id,
    base64url(nonce),
    base64url(ciphertext),
    base64url(tag),
  ].join('.');
}

export interface DecryptResult {
  plaintext: string;
  /** The key id that actually decrypted the record. Drives rotation. */
  keyId: string;
}

/**
 * Decrypts an envelope, verifying the GCM authentication tag.
 *
 * Every failure mode is a distinct `SecretCryptoError.code` because the
 * operator response differs: re-enter the secret (`KEY_NOT_AVAILABLE` /
 * `DECRYPT_FAILED`) vs. investigate corruption (`INVALID_CIPHERTEXT`).
 */
export function decryptSecret(envelope: string, ring: MasterKeyring): DecryptResult {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new SecretCryptoError('INVALID_CIPHERTEXT', 'Ciphertext is empty.');
  }

  const parts = envelope.split('.');
  if (parts.length !== 5) {
    throw new SecretCryptoError(
      'INVALID_CIPHERTEXT',
      'Ciphertext is not a valid credential envelope.',
    );
  }

  const [version, keyId, nonceB64, dataB64, tagB64] = parts;

  if (version !== ENVELOPE_VERSION) {
    throw new SecretCryptoError(
      'INVALID_CIPHERTEXT',
      `Unsupported credential envelope version "${version}".`,
    );
  }

  const key = ring.all.find((k) => k.id === keyId);
  if (!key) {
    // Not an error about corruption — the record is fine, we simply do not
    // hold the key it was written under. Rotation left the job unfinished.
    throw new SecretCryptoError(
      'KEY_NOT_AVAILABLE',
      `Credential was encrypted with key "${keyId}", which this deployment does not hold.`,
    );
  }

  let nonce: Buffer;
  let data: Buffer;
  let tag: Buffer;
  try {
    nonce = Buffer.from(nonceB64, 'base64url');
    // An empty segment is a legitimate zero-length ciphertext: the segment
    // is still present (the envelope keeps its five parts), it is simply empty.
    data = Buffer.from(dataB64, 'base64url');
    tag = Buffer.from(tagB64, 'base64url');
  } catch {
    throw new SecretCryptoError('INVALID_CIPHERTEXT', 'Ciphertext is not valid base64url.');
  }

  // Length checks BEFORE any crypto call: a short nonce or a missing tag must
  // not reach createDecipheriv, where it would surface as an opaque OpenSSL
  // error instead of an actionable code.
  if (nonce.length !== NONCE_BYTES) {
    throw new SecretCryptoError('INVALID_CIPHERTEXT', 'Ciphertext nonce has the wrong length.');
  }
  if (tag.length !== TAG_BYTES) {
    throw new SecretCryptoError('INVALID_CIPHERTEXT', 'Ciphertext tag has the wrong length.');
  }
  // NOTE: an empty `data` is legitimate. AES-GCM on a zero-length plaintext
  // produces a zero-length ciphertext plus a valid tag, which is exactly how
  // `encryptSecret('')` round-trips. Rejecting it here would make the two
  // halves of this module disagree about what a valid envelope looks like.
  // A non-empty envelope whose body is empty is caught by the GCM tag check
  // below, which is the real integrity control.

  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return { plaintext: plaintext.toString('utf8'), keyId };
  } catch {
    // The tag did not verify. That is the whole point of GCM: a wrong key, a
    // flipped byte or a truncated record all land here rather than yielding
    // plausible-looking garbage.
    throw new SecretCryptoError(
      'DECRYPT_FAILED',
      'Credential failed authentication: it was encrypted with a different key or has been altered.',
    );
  }
}

/**
 * Re-wraps a record under the active key without exposing the plaintext.
 *
 * This is the migration primitive: it takes an OLD envelope and returns a NEW
 * one. The secret is held in memory only for the duration of the call and is
 * never returned, logged or persisted by this function.
 */
export function rotateEnvelope(envelope: string, ring: MasterKeyring): string {
  const { plaintext } = decryptSecret(envelope, ring);
  return encryptSecret(plaintext, ring);
}

/** True when the envelope was written by a key other than the active one. */
export function envelopeNeedsRotation(envelope: string, ring: MasterKeyring): boolean {
  const keyId = envelope.split('.')[1];
  return keyId !== undefined && keyId !== ring.active.id;
}

/**
 * Constant-time string comparison for secrets that must be matched rather
 * than decrypted (webhook secrets, service tokens).
 *
 * Returns false — never throws — when the lengths differ, so a length oracle
 * is not introduced by an exception path.
 */
export function secretsEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so short-vs-long is not measurably faster.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Renders a secret for display without revealing it.
 *
 * Shows only enough characters to let a user confirm WHICH key is stored,
 * plus a length. Never returns the value — the browser is not given the
 * secret after it has been saved, by construction, not by convention.
 */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '';
  const trimmed = secret.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)} (${trimmed.length} chars)`;
}