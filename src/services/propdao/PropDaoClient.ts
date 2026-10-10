/**
 * PROPDAO API CLIENT
 * =================
 * The only module that speaks HTTP to PropDAO.
 *
 * OFFICIAL DOCS (read before changing anything here)
 *   https://www.propdao.finance/docs
 *   https://www.propdao.finance/rules
 *   https://www.propdao.finance/terms
 *
 * VERIFIED ENDPOINTS (base `https://app.propdao.finance/api/v1`)
 *   GET    /health                                   no auth
 *   GET    /markets                                  no auth
 *   GET    /challenges                               no auth
 *   GET    /me                                       auth — identity
 *   GET    /accounts                                 auth — the caller's accounts
 *   GET    /accounts/:id                             auth — full state (HEAVY)
 *   GET    /accounts/:id/risk                        auth — equity/floor/room
 *   GET    /accounts/:id/positions                   auth
 *   GET    /accounts/:id/orders                      auth
 *   GET    /accounts/:id/trades                      auth — CLOSED trades
 *   POST   /accounts/:id/orders                      auth — place an order
 *   DELETE /accounts/:id/orders/:orderId             auth — cancel
 *   POST   /accounts/:id/positions/:pid/close        auth — close (optional %)
 *   PATCH  /accounts/:id/positions/:pid              auth — set/clear sl & tp
 *   DELETE /accounts/:id/twaps/:twapId               auth — stop a TWAP
 *
 * VERIFIED ABSENT (documented nowhere — must NOT be called)
 *   modify/amend an order      there is no PATCH on an order
 *   payouts                    "Payout is UI-only for now"
 *   webhooks                   no webhook endpoint exists
 *   a dedicated challenge-status endpoint; status comes from `/accounts`
 *
 * DOC/API MISMATCHES ALREADY OBSERVED (trust the LIVE response)
 *   The published examples are stale in ways that matter:
 *     - docs use `daily_loss`; live `/challenges` returns `daily_drawdown`
 *     - docs say 155 markets; live returned 145
 *     - docs say equities are 1.5x; live `/markets` reports 2x
 *   Every response is therefore parsed defensively and NOTHING is inferred
 *   from the documentation examples.
 *
 * DOCUMENTED RATE LIMITS: 300 reads/min and 60 orders/min PER KEY, in
 * separate buckets.
 *
 * DOCUMENTED EXECUTION TIMING RULES (these are hard constraints on retries):
 *   - a position must be open 1 second before it can be manually closed
 *   - user-initiated executions must be >= 0.5s apart, per account
 *   - violating either returns 400 and NOTHING is executed
 */

import { redactError, redactText } from '../../server/security/redaction';

const DOCS_BASE = 'https://app.propdao.finance/api/v1';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

/** Documented, per key. Separate buckets for reads and orders. */
export const PROPDAO_RATE_LIMITS = { readsPerMinute: 300, ordersPerMinute: 60 } as const;

export type PropDaoErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INVALID_RESPONSE';

/**
 * A classified provider error.
 *
 * Carries the STATUS (needed to classify) and a redacted message (needed to
 * show a user something useful) but never the response body, which is where
 * the API key would appear if it were ever echoed back.
 */
export class PropDaoError extends Error {
  readonly code: PropDaoErrorCode;
  readonly status?: number;
  /** Seconds to wait, from `Retry-After`, when rate limited. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: PropDaoErrorCode,
    message: string,
    status?: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PropDaoError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/* ------------------------------------------------------------------ */
/* Normalised response types                                           */
/* ------------------------------------------------------------------ */

export interface PropDaoIdentity {
  userId: string;
  loginKind?: string;
  apiKeyId?: string;
}

export interface PropDaoAccount {
  accountId: string;
  status: string | null;
  challengeId: string | null;
  purchaseDate: string | null;
  /** Raw challenge object, kept so rules can be read without a second call. */
  challenge: Record<string, unknown> | null;
}

/**
 * Account risk, mapped explicitly from the documented `/risk` payload.
 *
 * THE MAPPING IS DELIBERATE AND NARROW.
 *   The docs state `roomUsd = equity − floor` and `floor = max(maxFloor,
 *   dailyFloor)`. That is the ONLY arithmetic this adapter performs on
 *   provider figures, because it is the only arithmetic the provider
 *   documents. In particular `roomPct` is used AS GIVEN and never recomputed —
 *   if the provider changes how it derives the percentage, recomputing it here
 *   would produce a number that disagrees with the one that actually binds the
 *   account.
 */
export interface PropDaoRisk {
  equity: number | null;
  balance: number | null;
  /** The binding drawdown floor right now, in USD. */
  floor: number | null;
  /** Which floor binds: 'max' (static) or 'daily'. */
  floorKind: string | null;
  maxFloor: number | null;
  dailyFloor: number | null;
  /** equity - floor. The entire remaining risk budget, in USD. */
  roomUsd: number | null;
  /** Remaining risk budget as a percentage, as the provider reports it. */
  roomPct: number | null;
  /** True when a drawdown limit has been hit; the account is closed. */
  breached: boolean | null;
  openPositions: number | null;
}

export interface PropDaoPosition {
  id: string;
  symbol: string;
  /** 'BUY' or 'SELL', as the provider reports it. */
  side: string;
  qty: number | null;
  entry: number | null;
  leverage: number | null;
  notional: number | null;
  mark: number | null;
  unrealizedPnl: number | null;
  /** SL/TP are PRICES, not cash amounts. Named explicitly. */
  slPrice: number | null;
  tpPrice: number | null;
  openedAt: number | null;
}

export interface PropDaoOrder {
  id: string;
  symbol: string | null;
  side: string | null;
  qty: number | null;
  orderType: string | null;
  limitPrice: number | null;
  triggerPrice: number | null;
  status: string | null;
  createdAt: number | null;
}

export interface PropDaoTrade {
  id: string;
  symbol: string | null;
  side: string | null;
  qty: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pnl: number | null;
  fee: number | null;
  closedAt: number | null;
}

export interface PropDaoMarket {
  symbol: string;
  coin: string | null;
  dex: string | null;
  maxLeverage: number | null;
  lotStep: number | null;
  szDecimals: number | null;
}

export interface PropDaoChallengeRules {
  accountSize: number | null;
  profitTargetPct: number | null;
  maxDrawdownPct: number | null;
  dailyDrawdownPct: number | null;
  profitSplitPct: number | null;
  minTradingDays: number | null;
  minTradeSize: number | null;
  drawdownType: string | null;
}

export interface PropDaoOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  orderType?: 'market' | 'limit' | 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit' | 'scale' | 'twap';
  /**
   * Idempotency key. The same `intentId` always returns the same response and
   * never produces a second fill. REQUIRED for every write this app makes:
   * without it a timeout leaves no way to tell "did not execute" from
   * "executed and the response was lost".
   */
  intentId: string;
  leverage?: number;
  tif?: 'gtc' | 'ioc' | 'alo';
  reduceOnly?: boolean;
  limitPrice?: number;
  triggerPrice?: number;
  sl?: number;
  tp?: number;
}

export interface PropDaoExecutionResult {
  /** The provider's idempotency replay flag, when it reports one. */
  idempotentReplay: boolean;
  /** Raw outcome text, redacted. For the audit trail. */
  summary: string | null;
  orderId: string | null;
  status: string | null;
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A number field, or null. NEVER coerces to 0 for a missing value. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function millis(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : parsed;
}

/* ------------------------------------------------------------------ */
/* Parsers (exported so they can be tested against recorded payloads)  */
/* ------------------------------------------------------------------ */

export function parseIdentity(body: unknown): PropDaoIdentity | null {
  if (!isRecord(body)) return null;
  const userId = str(body.userId);
  if (!userId) return null;
  return { userId, loginKind: str(body.loginKind) ?? undefined, apiKeyId: str(body.apiKeyId) ?? undefined };
}

export function parseAccounts(body: unknown): PropDaoAccount[] {
  const list = isRecord(body) && Array.isArray(body.accounts) ? body.accounts : [];
  const out: PropDaoAccount[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const accountId = str(entry.account_id) ?? str(entry.accountId);
    if (!accountId) continue;
    out.push({
      accountId,
      status: str(entry.status),
      challengeId: str(entry.challenge_id) ?? str(entry.challengeId),
      purchaseDate: str(entry.purchase_date) ?? str(entry.purchaseDate),
      challenge: isRecord(entry.challenge) ? entry.challenge : null,
    });
  }
  return out;
}

export function parseRisk(body: unknown): PropDaoRisk | null {
  if (!isRecord(body)) return null;
  return {
    equity: num(body.equity),
    balance: num(body.balance),
    floor: num(body.floor),
    floorKind: str(body.floorKind),
    maxFloor: num(body.maxFloor),
    dailyFloor: num(body.dailyFloor),
    roomUsd: num(body.roomUsd),
    roomPct: num(body.roomPct),
    breached: bool(body.breached),
    openPositions: num(body.openPositions),
  };
}

export function parsePositions(body: unknown): PropDaoPosition[] {
  const list = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: PropDaoPosition[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    const symbol = str(entry.symbol);
    if (!id || !symbol) continue;
    out.push({
      id,
      symbol,
      side: str(entry.side) ?? 'UNKNOWN',
      qty: num(entry.qty),
      entry: num(entry.entry),
      leverage: num(entry.leverage),
      notional: num(entry.notional),
      mark: num(entry.mark),
      unrealizedPnl: num(entry.unrealizedPnl),
      // The provider sends BOTH `sl`/`tp` (cash) and `slPrice`/`tpPrice`
      // (price). Only the price variants are usable as a stop level, so the
      // cash figures are deliberately NOT mapped — using them would place a
      // stop at the wrong magnitude.
      slPrice: num(entry.slPrice),
      tpPrice: num(entry.tpPrice),
      openedAt: millis(entry.openedAt),
    });
  }
  return out;
}

export function parseOrders(body: unknown): PropDaoOrder[] {
  const list = isRecord(body) && Array.isArray(body.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.pendingOrders)
        ? body.pendingOrders
        : [];
  const out: PropDaoOrder[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id) ?? str(entry.orderId) ?? str(entry.order_id);
    if (!id) continue;
    out.push({
      id,
      symbol: str(entry.symbol),
      side: str(entry.side),
      qty: num(entry.qty) ?? num(entry.size),
      orderType: str(entry.orderType) ?? str(entry.order_type),
      limitPrice: num(entry.limitPrice) ?? num(entry.limit_price),
      triggerPrice: num(entry.triggerPrice) ?? num(entry.trigger_price),
      status: str(entry.status),
      createdAt: millis(entry.createdAt) ?? millis(entry.created_at),
    });
  }
  return out;
}

export function parseTrades(body: unknown): PropDaoTrade[] {
  const list = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: PropDaoTrade[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id) ?? str(entry.tradeId);
    if (!id) continue;
    out.push({
      id,
      symbol: str(entry.symbol),
      side: str(entry.side),
      qty: num(entry.qty),
      entryPrice: num(entry.entryPrice) ?? num(entry.entry),
      exitPrice: num(entry.exitPrice) ?? num(entry.exit),
      pnl: num(entry.pnl),
      fee: num(entry.fee),
      closedAt: millis(entry.closedAt) ?? millis(entry.closed_at),
    });
  }
  return out;
}

export function parseMarkets(body: unknown): PropDaoMarket[] {
  const list = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: PropDaoMarket[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const symbol = str(entry.symbol);
    if (!symbol) continue;
    out.push({
      symbol,
      coin: str(entry.coin),
      dex: str(entry.dex),
      // Trust the live value; the published examples are already stale.
      maxLeverage: num(entry.maxLeverage),
      lotStep: num(entry.lotStep),
      szDecimals: num(entry.szDecimals),
    });
  }
  return out;
}

/**
 * Challenge rules.
 *
 * READS BOTH FIELD NAMES. The documentation example uses `daily_loss`; the
 * live API returns `daily_drawdown`. Accepting only one would silently produce
 * a null daily limit on whichever shape the provider happens to send — and a
 * null daily limit is indistinguishable from "no daily limit", which is
 * exactly the kind of gap a risk check must not have.
 */
export function parseChallengeRules(body: unknown): PropDaoChallengeRules {
  // The rules object appears at the top level of a `/challenges` entry and
  // nested under `rules` or `challenge` on an account record. All three are
  // read so no caller has to know which shape it holds.
  const rules = isRecord(body)
    ? (isRecord(body.rules) ? body.rules : isRecord(body.challenge) ? body.challenge : body)
    : {};
  return {
    accountSize: num(rules.account_size) ?? num(rules.accountSize),
    profitTargetPct: num(rules.profit_target) ?? num(rules.profitTarget),
    maxDrawdownPct: num(rules.max_drawdown) ?? num(rules.maxDrawdown),
    dailyDrawdownPct: num(rules.daily_drawdown) ?? num(rules.daily_loss) ?? num(rules.dailyDrawdown),
    profitSplitPct: num(rules.profit_split) ?? num(rules.profitSplit),
    minTradingDays: num(rules.min_trading_days) ?? num(rules.minTradingDays),
    minTradeSize: num(rules.min_trade_size) ?? num(rules.minTradeSize),
    drawdownType: str(rules.drawdown_type) ?? str(rules.drawdownType),
  };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export interface PropDaoClientOptions {
  /** The caller's own API key. Never logged, never stored by this class. */
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export class PropDaoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

  constructor(options: PropDaoClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? process.env.PROPDAO_API_BASE_URL?.trim() ?? DOCS_BASE).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * Issues one request.
   *
   * RETRIES are limited to idemPOTENT reads. A write that timed out may well
   * have executed, so retrying it blindly risks a duplicate order — which is
   * exactly why every write this app makes carries an `intentId`.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<{ data: T; status: number; headers: Headers }> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= MAX_RETRIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            // The key goes in the Authorization header and NOWHERE ELSE. It
            // is not in the URL, so it cannot land in an access log.
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after') ?? '0');
          throw new PropDaoError(
            'RATE_LIMITED',
            'PropDAO rate limit reached. Back off and try again shortly.',
            429,
            Number.isFinite(retryAfter) ? retryAfter : undefined,
          );
        }

        if (response.status === 401) {
          throw new PropDaoError(
            'UNAUTHORIZED',
            'PropDAO rejected this API key. It may be invalid, revoked, or from another account.',
            401,
          );
        }

        if (response.status === 403) {
          throw new PropDaoError(
            'FORBIDDEN',
            'PropDAO refused this request. The account may be breached, or the operation is not permitted for it.',
            403,
          );
        }

        if (response.status === 404) {
          throw new PropDaoError('NOT_FOUND', 'PropDAO has no such resource.', 404);
        }

        if (response.status === 409) {
          throw new PropDaoError(
            'CONFLICT',
            'A previous request with the same intent is still executing. Reconcile before retrying.',
            409,
          );
        }

        if (!response.ok) {
          throw new PropDaoError(
            response.status >= 500 ? 'PROVIDER_ERROR' : 'BAD_REQUEST',
            `PropDAO responded ${response.status}.`,
            response.status,
          );
        }

        const text = await response.text();
        let data: unknown = null;
        if (text.length > 0) {
          try {
            data = JSON.parse(text);
          } catch {
            throw new PropDaoError('INVALID_RESPONSE', 'PropDAO returned a body that is not valid JSON.');
          }
        }

        return { data: data as T, status: response.status, headers: response.headers };
      } catch (error) {
        lastError = error;

        if (error instanceof PropDaoError) {
          // A definitive rejection is never retried; only transport failures
          // and 5xx are, and only for reads.
          const retryable = error.code === 'PROVIDER_ERROR' || error.code === 'NETWORK' || error.code === 'TIMEOUT';
          if (!retryable || method !== 'GET' || attempt >= MAX_RETRIES) throw error;
        } else if (method !== 'GET' || attempt >= MAX_RETRIES) {
          throw new PropDaoError('NETWORK', 'PropDAO could not be reached.');
        }

        // Exponential backoff. Bounded: three attempts, never more.
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        attempt += 1;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PropDaoError('NETWORK', 'PropDAO could not be reached.');
  }

  /* ---- read operations ---- */

  /** Connectivity + service health. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { data } = await this.request<unknown>('GET', '/health');
      const status = isRecord(data) ? str(data.status) : null;
      return { ok: status === 'ok', detail: status === 'ok' ? 'PropDAO API reachable.' : `PropDAO reported status "${status ?? 'unknown'}".` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'PropDAO is unreachable.' };
    }
  }

  /** Proves the key works. Used by the Settings "Test connection" action. */
  async identity(): Promise<PropDaoIdentity> {
    const { data } = await this.request<unknown>('GET', '/me');
    const identity = parseIdentity(data);
    if (!identity) {
      throw new PropDaoError('INVALID_RESPONSE', 'PropDAO did not return an identity for this key.');
    }
    return identity;
  }

  async accounts(): Promise<PropDaoAccount[]> {
    const { data } = await this.request<unknown>('GET', '/accounts');
    return parseAccounts(data);
  }

  async risk(accountId: string): Promise<PropDaoRisk> {
    const { data } = await this.request<unknown>('GET', `/accounts/${encodeURIComponent(accountId)}/risk`);
    const risk = parseRisk(data);
    if (!risk) {
      throw new PropDaoError('INVALID_RESPONSE', `PropDAO returned no risk data for account ${accountId}.`);
    }
    return risk;
  }

  async positions(accountId: string): Promise<PropDaoPosition[]> {
    const { data } = await this.request<unknown>('GET', `/accounts/${encodeURIComponent(accountId)}/positions`);
    return parsePositions(data);
  }

  async orders(accountId: string): Promise<PropDaoOrder[]> {
    const { data } = await this.request<unknown>('GET', `/accounts/${encodeURIComponent(accountId)}/orders`);
    return parseOrders(data);
  }

  async trades(accountId: string, limit = 100): Promise<PropDaoTrade[]> {
    const bounded = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
    const { data } = await this.request<unknown>('GET', `/accounts/${encodeURIComponent(accountId)}/trades?limit=${bounded}`);
    return parseTrades(data);
  }

  async markets(): Promise<PropDaoMarket[]> {
    const { data } = await this.request<unknown>('GET', '/markets');
    return parseMarkets(data);
  }

  async challenges(): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.request<unknown>('GET', '/challenges');
    return isRecord(data) && Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
  }

  /**
   * The full account document.
   *
   * The docs describe this as heavy and recommend `/risk`, `/positions` and
   * `/orders` in a loop. It exists for reconciliation, where one call that
   * describes everything is genuinely cheaper than three that do not.
   */
  async accountState(accountId: string): Promise<Record<string, unknown> | null> {
    const { data } = await this.request<unknown>('GET', `/accounts/${encodeURIComponent(accountId)}`);
    return isRecord(data) ? data : null;
  }

  /* ---- write operations ---- */

  /**
   * Places an order.
   *
   * `intentId` is mandatory and is the app's idempotency guarantee. A retry
   * with the same value replays the original response instead of filling
   * twice, which is what makes a timeout safe to recover from.
   */
  async placeOrder(accountId: string, order: PropDaoOrderRequest): Promise<PropDaoExecutionResult> {
    const body: Record<string, unknown> = {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      intentId: order.intentId,
    };
    if (order.orderType) body.orderType = order.orderType;
    if (order.leverage !== undefined) body.leverage = order.leverage;
    if (order.tif) body.tif = order.tif;
    if (order.reduceOnly !== undefined) body.reduceOnly = order.reduceOnly;
    if (order.limitPrice !== undefined) body.limitPrice = order.limitPrice;
    if (order.triggerPrice !== undefined) body.triggerPrice = order.triggerPrice;
    if (order.sl !== undefined) body.sl = order.sl;
    if (order.tp !== undefined) body.tp = order.tp;

    const { data, headers } = await this.request<unknown>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/orders`,
      body,
    );

    return {
      idempotentReplay: headers.get('x-idempotent-replay') === 'true',
      summary: isRecord(data) ? str(data.status) ?? null : null,
      orderId: isRecord(data) ? str(data.orderId) ?? str(data.id) ?? null : null,
      status: isRecord(data) ? str(data.status) ?? null : null,
    };
  }

  async cancelOrder(accountId: string, orderId: string): Promise<boolean> {
    await this.request<unknown>(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}`,
    );
    return true;
  }

  /**
   * Closes a position, optionally in part.
   *
   * `percent` is 0–1 and defaults to closing everything. Note the documented
   * rule that a position must be open for 1 second before a manual close;
   * the caller is responsible for respecting that.
   */
  async closePosition(accountId: string, positionId: string, percent?: number): Promise<boolean> {
    await this.request<unknown>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(positionId)}/close`,
      percent === undefined ? {} : { percent },
    );
    return true;
  }

  /** Sets or clears SL/TP by PRICE. `null` clears that leg. */
  async setPositionProtection(
    accountId: string,
    positionId: string,
    protection: { sl?: number | null; tp?: number | null },
  ): Promise<boolean> {
    await this.request<unknown>(
      'PATCH',
      `/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(positionId)}`,
      protection,
    );
    return true;
  }

  async stopTwap(accountId: string, twapId: string): Promise<boolean> {
    await this.request<unknown>(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/twaps/${encodeURIComponent(twapId)}`,
    );
    return true;
  }
}

/**
 * Maps an error to something safe to show a user.
 *
 * `NOT_FOUND` on an account is deliberately NOT rendered as "not found": the
 * API cannot distinguish "no such account" from "not your account", and
 * telling a user which one it was would confirm whether someone else's account
 * id exists.
 */
export function describePropDaoError(error: unknown): { message: string; code: string } {
  const safe = redactError(error);
  if (error instanceof PropDaoError) {
    switch (error.code) {
      case 'UNAUTHORIZED':
        return { code: error.code, message: 'PropDAO rejected this API key. Generate a new one in Settings → Developers, or check it has not been revoked.' };
      case 'FORBIDDEN':
        return { code: error.code, message: safe.message };
      case 'NOT_FOUND':
        return { code: error.code, message: 'That PropDAO account was not found on this key. Re-select it from your connected accounts.' };
      case 'RATE_LIMITED':
        return { code: error.code, message: 'PropDAO rate limit reached (300 reads/min, 60 orders/min per key). Wait a moment and retry.' };
      case 'CONFLICT':
        return { code: error.code, message: 'A previous request is still executing on this account. Reconciling before retrying.' };
      case 'TIMEOUT':
        return { code: error.code, message: 'PropDAO did not respond in time. The order may or may not have executed — reconcile before retrying.' };
      default:
        return { code: error.code, message: redactText(safe.message) };
    }
  }
  return { code: safe.code ?? 'UNKNOWN', message: redactText(safe.message) };
}