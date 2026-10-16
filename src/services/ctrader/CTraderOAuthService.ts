import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CTraderTokenBundle {
  accessToken: string;
  refreshToken: string;
  tokenType: "bearer";
  expiresAt: number;
  permissionScope?: number;
}

export interface CTraderAccount {
  ctidTraderAccountId: string;
  isLive: boolean;
  traderLogin?: string;
  brokerTitleShort?: string;
}

type TokenResponse = {
  accessToken?: unknown;
  refreshToken?: unknown;
  tokenType?: unknown;
  expiresIn?: unknown;
  errorCode?: unknown;
  description?: unknown;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`cTrader is not configured: missing server environment variable ${name}.`);
  return value;
}

export function getCTraderConfig() {
  return {
    clientId: requiredEnv("CTRADER_CLIENT_ID"),
    clientSecret: requiredEnv("CTRADER_SECRET"),
    redirectUri: requiredEnv("CTRADER_REDIRECT_URI"),
  };
}

function signState(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Stateless, signed OAuth state works across serverless instances and is bound to a verified app user. */
export function createCTraderOAuthState(userId: string, secret: string, now = Date.now()): string {
  if (!userId.trim()) throw new Error("Cannot start cTrader authorization without an authenticated user.");
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: now, nonce: randomBytes(16).toString("base64url") })).toString("base64url");
  return `${payload}.${signState(payload, secret)}`;
}

export function verifyCTraderOAuthState(state: string, secret: string, now = Date.now()): { userId: string } {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) throw new Error("Invalid cTrader OAuth state.");
  const expected = signState(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid cTrader OAuth state signature.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Invalid cTrader OAuth state payload."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid cTrader OAuth state payload.");
  const p = parsed as { uid?: unknown; iat?: unknown; nonce?: unknown };
  if (typeof p.uid !== "string" || !p.uid || typeof p.iat !== "number" || typeof p.nonce !== "string") throw new Error("Invalid cTrader OAuth state payload.");
  if (p.iat > now + 30_000 || now - p.iat > 10 * 60_000) throw new Error("cTrader authorization expired. Start the connection again.");
  return { userId: p.uid };
}

export function buildCTraderAuthorizationUrl(userId: string): string {
  const config = getCTraderConfig();
  const state = createCTraderOAuthState(userId, config.clientSecret);
  const url = new URL("https://id.ctrader.com/my/settings/openapi/grantingaccess/");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "trading");
  url.searchParams.set("product", "web");
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestToken(params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<CTraderTokenBundle> {
  const config = getCTraderConfig();
  const url = new URL("https://openapi.ctrader.com/apps/token");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("client_secret", config.clientSecret);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { method, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`cTrader token endpoint returned HTTP ${response.status}.`);
  const body = await response.json() as TokenResponse;
  if (body.errorCode || typeof body.accessToken !== "string" || !body.accessToken || typeof body.refreshToken !== "string" || !body.refreshToken || typeof body.expiresIn !== "number" || !Number.isFinite(body.expiresIn) || body.expiresIn <= 0) {
    throw new Error("cTrader rejected token authorization. Reconnect the account and verify the app credentials and redirect URI.");
  }
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    tokenType: "bearer",
    expiresAt: Date.now() + Math.max(60, body.expiresIn) * 1000,
  };
}

export function exchangeCTraderAuthorizationCode(code: string): Promise<CTraderTokenBundle> {
  const config = getCTraderConfig();
  return requestToken({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }, "GET");
}

export function refreshCTraderToken(refreshToken: string): Promise<CTraderTokenBundle> {
  if (!refreshToken) throw new Error("cTrader refresh token is missing. Reconnect the account.");
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken }, "POST");
}

export async function resolveValidCTraderToken(
  raw: string | undefined,
  save: (bundle: CTraderTokenBundle) => Promise<void>,
  now = Date.now(),
): Promise<CTraderTokenBundle> {
  if (!raw) throw new Error("Connect your cTrader account in Settings first.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Stored cTrader credentials are unreadable. Reconnect your cTrader account."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Stored cTrader credentials are invalid. Reconnect your cTrader account.");
  const token = parsed as Partial<CTraderTokenBundle>;
  if (typeof token.accessToken !== "string" || typeof token.refreshToken !== "string") throw new Error("Stored cTrader credentials are incomplete. Reconnect your cTrader account.");
  if (typeof token.expiresAt === "number" && token.expiresAt > now + 60_000) return token as CTraderTokenBundle;
  const refreshed = await refreshCTraderToken(token.refreshToken);
  await save(refreshed);
  return refreshed;
}
