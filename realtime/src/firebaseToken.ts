/**
 * FIREBASE ID TOKEN VERIFICATION AT THE EDGE
 * ==========================================
 * A WebSocket connection is authorized by a Firebase ID token. The Worker
 * verifies that token ITSELF, before the socket is accepted, so an
 * unauthenticated caller never reaches a room.
 *
 * WHAT IS CHECKED
 * ---------------
 *   - the RS256 signature, against Google's published signing keys
 *   - `aud`  == the Firebase project id
 *   - `iss`  == https://securetoken.google.com/<project id>
 *   - `exp`  in the future
 *   - `sub`  present (this is the Firebase uid)
 *
 * A token that fails any of these is rejected. The issuer, the audience and
 * the expiry are all checked, because a valid signature alone only proves
 * that SOME Firebase project signed the token.
 *
 * WHY THE JWK ENDPOINT AND NOT THE X.509 CERTS
 * --------------------------------------------
 * The certificate endpoint
 * (robot/v1/metadata/x509/securetoken@system.gserviceaccount.com) serves
 * X.509 CERTIFICATES, and a certificate's DER is not a SubjectPublicKeyInfo:
 * `importKey('spki', ...)` rejects it with "Invalid keyData". A certificate
 * has to be parsed to extract the public key, which needs an ASN.1 parser.
 *
 * The JWK endpoint
 * (service_accounts/v1/jwk/securetoken@system.gserviceaccount.com) serves
 * the SAME keys — the `kid` sets overlap exactly — already in the format
 * WebCrypto imports directly. No dependency, no parsing, and the key can be
 * matched to the token by `kid`.
 *
 * The key set is cached in memory for an hour, which is far below Google's
 * rotation window.
 */

const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const KEY_TTL_MS = 60 * 60 * 1000;

interface SigningKey extends JsonWebKey {
  kid?: string;
}

interface JsonWebKeySet {
  keys?: SigningKey[];
}

interface StoredKey {
  kid: string;
  jwk: SigningKey;
  key: CryptoKey | null;
}

let keyCache: StoredKey[] = [];
let keyCacheFetchedAt = 0;

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function loadKeys(): Promise<StoredKey[]> {
  if (keyCache.length > 0 && Date.now() - keyCacheFetchedAt < KEY_TTL_MS) {
    return keyCache;
  }
  const response = await fetch(JWK_URL);
  if (!response.ok) {
    throw new Error(`Could not load the Firebase signing keys (${response.status}).`);
  }
  const payload = (await response.json()) as JsonWebKeySet;
  const keys = (payload.keys ?? [])
    .filter((key) => key.kid && key.kty === "RSA" && key.alg === "RS256")
    .map((key) => ({ kid: key.kid as string, jwk: key, key: null }));
  if (keys.length === 0) {
    throw new Error("The Firebase signing key set was empty.");
  }
  keyCache = keys;
  keyCacheFetchedAt = Date.now();
  return keys;
}

async function cryptoKeyFor(stored: StoredKey): Promise<CryptoKey> {
  if (stored.key) return stored.key;
  const key = await crypto.subtle.importKey(
    "jwk",
    stored.jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  stored.key = key;
  return key;
}

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  name?: string;
}

interface TokenPayload {
  aud?: string;
  iss?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  name?: string;
}

/**
 * Verifies a Firebase ID token.
 *
 * Returns the identity when the token is good, and null when it is not.
 * Never throws: a bad token is an expected input, not an exceptional one.
 * The reason is logged (without the token) so an operator can see WHY a
 * connection was refused.
 */
export async function verifyFirebaseIdToken(
  token: string,
  projectId: string | undefined,
): Promise<FirebaseIdentity | null> {
  if (!token || !projectId) {
    console.warn("[auth] no token or no project id configured");
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    console.warn("[auth] the token is not a JWT");
    return null;
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; kid?: string };
  let payload: TokenPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart)));
  } catch {
    console.warn("[auth] the token header or payload is not JSON");
    return null;
  }

  if (header.alg !== "RS256") {
    console.warn(`[auth] unsupported token algorithm: ${header.alg}`);
    return null;
  }

  try {
    const list = await loadKeys();
    const stored =
      list.find((candidate) => candidate.kid === header.kid) ?? list[0];
    if (!stored) {
      console.warn("[auth] no signing key matched the token");
      return null;
    }
    const key = await cryptoKeyFor(stored);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(signaturePart) as unknown as BufferSource,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) {
      console.warn("[auth] the token signature did not verify");
      return null;
    }
  } catch (error) {
    console.warn(
      "[auth] the signing keys could not be used:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) {
    console.warn("[auth] the token has expired");
    return null;
  }
  if (payload.iat && payload.iat > now + 60) {
    console.warn("[auth] the token was issued in the future");
    return null;
  }
  if (payload.aud !== projectId) {
    console.warn(
      `[auth] the token audience does not match this project (expected ${projectId})`,
    );
    return null;
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    console.warn("[auth] the token issuer does not match this project");
    return null;
  }
  if (!payload.sub) {
    console.warn("[auth] the token carries no subject");
    return null;
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}
