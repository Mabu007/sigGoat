/**
 * FIREBASE ID TOKEN VERIFICATION AT THE EDGE
 * ==========================================
 * A WebSocket connection is authorized by a Firebase ID token. The Worker
 * verifies that token ITSELF, before the socket opens, so an unauthenticated
 * caller never reaches a room.
 *
 * WHAT IS CHECKED
 * ---------------
 *   - the RS256 signature, against Google's published signing certificates
 *   - `aud`  == the Firebase project id
 *   - `iss`  == https://securetoken.google.com/<project id>
 *   - `exp`  in the future
 *   - `sub`  present (this is the Firebase uid)
 *
 * A token that fails any of these is rejected. The issuer, the audience and
 * the expiry are all checked, because a valid signature alone only proves
 * that SOME Firebase project signed the token.
 *
 * The certificate list is cached in memory for an hour, which is far below
 * Google's rotation window.
 */

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

interface Certificate {
  kid: string;
  pem: string;
  key: CryptoKey | null;
}

let certificates: Certificate[] = [];
let certificatesFetchedAt = 0;
const CERTIFICATE_TTL_MS = 60 * 60 * 1000;

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  name?: string;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function loadCertificates(): Promise<Certificate[]> {
  if (certificates.length > 0 && Date.now() - certificatesFetchedAt < CERTIFICATE_TTL_MS) {
    return certificates;
  }
  const response = await fetch(CERT_URL);
  if (!response.ok) {
    throw new Error(`Could not load Firebase signing certificates (${response.status}).`);
  }
  const payload = (await response.json()) as Record<string, string>;
  const loaded: Certificate[] = [];
  for (const [kid, pem] of Object.entries(payload)) {
    loaded.push({ kid, pem, key: null });
  }
  certificates = loaded;
  certificatesFetchedAt = Date.now();
  return certificates;
}

async function keyFor(certificate: Certificate): Promise<CryptoKey> {
  if (certificate.key) return certificate.key;
  const key = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(certificate.pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  certificate.key = key;
  return key;
}

interface TokenPayload {
  aud?: string;
  iss?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

/**
 * Verifies a Firebase ID token.
 *
 * Returns the identity when the token is good, and null when it is not.
 * Never throws: a bad token is an expected input, not an exceptional one.
 */
export async function verifyFirebaseIdToken(
  token: string,
  projectId: string | undefined,
): Promise<FirebaseIdentity | null> {
  if (!token || !projectId) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; kid?: string };
  let payload: TokenPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart)));
  } catch {
    return null;
  }

  if (header.alg !== "RS256") return null;

  try {
    const list = await loadCertificates();
    const certificate =
      list.find((candidate) => candidate.kid === header.kid) ?? list[0];
    if (!certificate) return null;

    const key = await keyFor(certificate);
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = base64UrlToBytes(signaturePart) as unknown as BufferSource;
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      signed,
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) return null;
  if (payload.iat && payload.iat > now + 60) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub) return null;

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}
