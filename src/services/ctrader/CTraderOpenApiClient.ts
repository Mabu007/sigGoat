import type { CTraderAccount, CTraderTokenBundle } from "./CTraderOAuthService";

export interface CTraderSymbol {
  symbolId: string;
  symbolName: string;
  enabled?: boolean;
  digits: number;
  pipPosition: number;
  minVolume?: number;
  maxVolume?: number;
  stepVolume?: number;
  commissionType?: number;
  preciseTradingCommissionRate?: number;
  preciseMinCommission?: number;
  lotSize?: number;
}

export interface CTraderQuoteEvent {
  symbolId: string;
  bid?: number;
  ask?: number;
  sessionClose?: number;
  timestamp?: number;
}

export interface CTraderTrendbar {
  volume?: number;
  low?: number;
  deltaOpen?: number;
  deltaClose?: number;
  deltaHigh?: number;
  utcTimestampInMinutes?: number;
}

type OpenApiMessage = { clientMsgId?: string; payloadType?: number; payload?: Record<string, unknown> };

/** cTrader account, asset and symbol identifiers are decimal strings. */
export function isCTraderNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Convert human instrument units to ProtoOA volume cents (units × 100). */
export function cTraderVolumeCents(units: number): number {
  if (!Number.isFinite(units) || units <= 0) throw new Error("Order quantity must be a finite positive number.");
  const volumeCents = Math.round(units * 100);
  if (!Number.isSafeInteger(volumeCents) || volumeCents <= 0 || Math.abs(volumeCents / 100 - units) > 1e-7) {
    throw new Error("Order quantity cannot be represented in cTrader 0.01-unit volume precision.");
  }
  return volumeCents;
}

const RESPONSE_ERROR = 2142;
const APP_AUTH_REQ = 2100;
const APP_AUTH_RES = 2101;
const ACCOUNT_AUTH_REQ = 2102;
const ACCOUNT_AUTH_RES = 2103;
const NEW_ORDER_REQ = 2106;
const SYMBOLS_LIST_REQ = 2114;
const SYMBOLS_LIST_RES = 2115;
const SYMBOL_BY_ID_REQ = 2116;
const SYMBOL_BY_ID_RES = 2117;
const SUBSCRIBE_SPOTS_REQ = 2127;
const SUBSCRIBE_SPOTS_RES = 2128;
const SPOT_EVENT = 2131;
const GET_TRENDBARS_REQ = 2137;
const GET_TRENDBARS_RES = 2138;
const GET_ACCOUNTS_REQ = 2149;
const GET_ACCOUNTS_RES = 2150;
const ASSET_LIST_REQ = 2112;
const ASSET_LIST_RES = 2113;
const TRADER_REQ = 2121;
const TRADER_RES = 2122;
const RECONCILE_REQ = 2124;
const RECONCILE_RES = 2125;

function id(): string {
  return `sirgoat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function payloadArray<T>(payload: Record<string, unknown> | undefined, key: string): T[] {
  const value = payload?.[key];
  return Array.isArray(value) ? value as T[] : [];
}

/**
 * cTrader Open API JSON transport. Each operation owns and closes its socket,
 * which is safe for serverless execution and never shares one user's tokens
 * with another request. The official JSON protocol uses payloadType + payload.
 */
export class CTraderOpenApiClient {
  constructor(
    private readonly token: CTraderTokenBundle,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly accountId?: string,
    private readonly isLive = false,
    private readonly timeoutMs = 12_000,
  ) {}

  private endpoint(): string {
    return this.isLive ? "wss://live.ctraderapi.com:5036" : "wss://demo.ctraderapi.com:5036";
  }

  private async withSocket<T>(work: (socket: WebSocket) => Promise<T>): Promise<T> {
    const socket = new WebSocket(this.endpoint());
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out connecting to cTrader Open API.")), this.timeoutMs);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to cTrader Open API.")); }, { once: true });
      });
      await this.request(socket, APP_AUTH_REQ, APP_AUTH_RES, { clientId: this.clientId, clientSecret: this.clientSecret });
      if (this.accountId) {
        await this.request(socket, ACCOUNT_AUTH_REQ, ACCOUNT_AUTH_RES, {
          ctidTraderAccountId: this.accountId,
          accessToken: this.token.accessToken,
        });
      }
      return await work(socket);
    } finally {
      try { socket.close(); } catch { /* already closed */ }
    }
  }

  private async request(
    socket: WebSocket,
    requestType: number,
    responseType: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const clientMsgId = id();
    return this.waitFor(socket, (message) =>
      (message.payloadType === responseType && (!message.clientMsgId || message.clientMsgId === clientMsgId)) ||
      (message.payloadType === RESPONSE_ERROR && (!message.clientMsgId || message.clientMsgId === clientMsgId)),
      () => socket.send(JSON.stringify({ clientMsgId, payloadType: requestType, payload })),
    );
  }

  private async waitFor(
    socket: WebSocket,
    matches: (message: OpenApiMessage) => boolean,
    send: () => void,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener("message", onMessage);
        reject(new Error("Timed out waiting for cTrader Open API response."));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
      };
      const onMessage = (event: MessageEvent) => {
        let message: OpenApiMessage;
        try { message = JSON.parse(String(event.data)) as OpenApiMessage; } catch { return; }
        if (!matches(message)) return;
        cleanup();
        if (message.payloadType === RESPONSE_ERROR) {
          const payload = message.payload ?? {};
          reject(new Error(`cTrader Open API error ${String(payload.errorCode ?? "UNKNOWN")}: ${String(payload.description ?? "request rejected")}`));
          return;
        }
        resolve(message.payload ?? {});
      };
      socket.addEventListener("message", onMessage);
      try { send(); } catch (error) { cleanup(); reject(error); }
    });
  }

  async authenticateAccount(): Promise<void> {
    if (!this.accountId) throw new Error("A cTrader account ID is required for account authentication.");
    await this.withSocket(async () => undefined);
  }

  async listAccounts(): Promise<CTraderAccount[]> {
    const accountList = await this.withSocket(async (socket) => {
      const payload = await this.request(socket, GET_ACCOUNTS_REQ, GET_ACCOUNTS_RES, { accessToken: this.token.accessToken });
      const objects = payloadArray<Record<string, unknown>>(payload, "ctidTraderAccount");
      if (objects.length && objects.every((account) => typeof account.isLive === "boolean")) {
        return { accounts: objects.map((account) => ({
          ctidTraderAccountId: String(account.ctidTraderAccountId ?? ""),
          isLive: account.isLive === true,
          ...(number(account.traderLogin) !== undefined ? { traderLogin: String(account.traderLogin) } : {}),
          ...(typeof account.brokerTitleShort === "string" ? { brokerTitleShort: account.brokerTitleShort } : {}),
        })).filter((account) => isCTraderNumericId(account.ctidTraderAccountId)), ids: [] as string[] };
      }
      const repeated = payload.ctidTraderAccountId;
      const ids = Array.isArray(repeated)
        ? repeated.map((value) => String(value))
        : objects.map((account) => String(account.ctidTraderAccountId ?? ""));
      return { accounts: [] as CTraderAccount[], ids: ids.filter((value) => isCTraderNumericId(value)) };
    });
    if (accountList.accounts.length) return accountList.accounts;
    const accounts: CTraderAccount[] = [];
    for (const ctidTraderAccountId of [...new Set(accountList.ids)]) {
      // The official account-list response returns IDs, not an isLive flag.
      // Determine environment by authenticating against each official endpoint.
      try {
        await new CTraderOpenApiClient(this.token, this.clientId, this.clientSecret, ctidTraderAccountId, false, this.timeoutMs).authenticateAccount();
        accounts.push({ ctidTraderAccountId, isLive: false });
        continue;
      } catch {
        // Try live only after demo authentication fails.
      }
      try {
        await new CTraderOpenApiClient(this.token, this.clientId, this.clientSecret, ctidTraderAccountId, true, this.timeoutMs).authenticateAccount();
        accounts.push({ ctidTraderAccountId, isLive: true });
      } catch {
        // If neither endpoint verifies access, fail closed and omit the account.
      }
    }
    return accounts;
  }

  async getAccountDetails(): Promise<{ balance: number; moneyDigits: number; depositAssetId: string; accessRights: number | null; isLimitedRisk: boolean }> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    return this.withSocket(async (socket) => {
      const payload = await this.request(socket, TRADER_REQ, TRADER_RES, { ctidTraderAccountId: this.accountId });
      const trader = payload.trader && typeof payload.trader === "object" ? payload.trader as Record<string, unknown> : payload;
      const rawBalance = number(trader.balance);
      const moneyDigits = number(trader.moneyDigits);
      const depositAssetId = trader.depositAssetId;
      if (rawBalance === undefined || moneyDigits === undefined || typeof depositAssetId !== "string" && typeof depositAssetId !== "number") {
        throw new Error("cTrader did not provide complete account balance/currency details; order execution is blocked.");
      }
      return {
        balance: rawBalance / (10 ** moneyDigits),
        moneyDigits,
        depositAssetId: String(depositAssetId),
        accessRights: number(trader.accessRights) ?? null,
        isLimitedRisk: trader.isLimitedRisk === true,
      };
    });
  }

  async getAssets(): Promise<Array<{ assetId: string; name: string; displayName?: string }>> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    return this.withSocket(async (socket) => {
      const payload = await this.request(socket, ASSET_LIST_REQ, ASSET_LIST_RES, { ctidTraderAccountId: this.accountId });
      return payloadArray<Record<string, unknown>>(payload, "asset")
        .map((asset) => ({
          assetId: String(asset.assetId ?? ""),
          name: String(asset.name ?? ""),
          ...(typeof asset.displayName === "string" ? { displayName: asset.displayName } : {}),
        }))
        .filter((asset) => isCTraderNumericId(asset.assetId) && asset.name);
    });
  }

  async reconcile(): Promise<{ positions: Array<Record<string, unknown>>; orders: Array<Record<string, unknown>> }> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    return this.withSocket(async (socket) => {
      const payload = await this.request(socket, RECONCILE_REQ, RECONCILE_RES, { ctidTraderAccountId: this.accountId });
      return {
        positions: payloadArray<Record<string, unknown>>(payload, "position"),
        orders: payloadArray<Record<string, unknown>>(payload, "order"),
      };
    });
  }

  async getSymbols(): Promise<CTraderSymbol[]> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    return this.withSocket(async (socket) => {
      const payload = await this.request(socket, SYMBOLS_LIST_REQ, SYMBOLS_LIST_RES, {
        ctidTraderAccountId: this.accountId,
        includeArchivedSymbols: false,
      });
      const lightSymbols = payloadArray<Record<string, unknown>>(payload, "symbol")
        .map((symbol) => ({
          symbolId: String(symbol.symbolId ?? ""),
          symbolName: String(symbol.symbolName ?? ""),
          enabled: symbol.enabled !== false,
        }))
        .filter((symbol) => isCTraderNumericId(symbol.symbolId) && symbol.symbolName && symbol.enabled);
      const complete: CTraderSymbol[] = [];
      // SymbolsList returns light symbols; it is not authoritative for digits,
      // volume limits, or commissions. Fetch full broker metadata in bounded
      // batches and never invent defaults for missing trading constraints.
      for (let offset = 0; offset < lightSymbols.length; offset += 100) {
        const batch = lightSymbols.slice(offset, offset + 100);
        const details = await this.request(socket, SYMBOL_BY_ID_REQ, SYMBOL_BY_ID_RES, {
          ctidTraderAccountId: this.accountId,
          symbolId: batch.map((symbol) => symbol.symbolId),
        });
        const detailById = new Map(payloadArray<Record<string, unknown>>(details, "symbol")
          .map((symbol) => [String(symbol.symbolId ?? ""), symbol]));
        for (const light of batch) {
          const symbol = detailById.get(light.symbolId);
          if (!symbol) continue;
          const digits = number(symbol.digits);
          const pipPosition = number(symbol.pipPosition);
          if (digits === undefined || pipPosition === undefined || digits < 0 || pipPosition < 0) continue;
          complete.push({
            ...light,
            digits,
            pipPosition,
            ...(number(symbol.minVolume) !== undefined ? { minVolume: number(symbol.minVolume) } : {}),
            ...(number(symbol.maxVolume) !== undefined ? { maxVolume: number(symbol.maxVolume) } : {}),
            ...(number(symbol.stepVolume) !== undefined ? { stepVolume: number(symbol.stepVolume) } : {}),
            ...(number(symbol.commissionType) !== undefined ? { commissionType: number(symbol.commissionType) } : {}),
            ...(number(symbol.preciseTradingCommissionRate) !== undefined ? { preciseTradingCommissionRate: number(symbol.preciseTradingCommissionRate) } : {}),
            ...(number(symbol.preciseMinCommission) !== undefined ? { preciseMinCommission: number(symbol.preciseMinCommission) } : {}),
            ...(number(symbol.lotSize) !== undefined ? { lotSize: number(symbol.lotSize) } : {}),
          });
        }
      }
      return complete;
    });
  }

  async getQuote(symbol: CTraderSymbol): Promise<CTraderQuoteEvent> {
    const quotes = await this.getQuotes([symbol]);
    const quote = quotes.get(symbol.symbolId);
    if (!quote) throw new Error(`cTrader did not return a spot event for "${symbol.symbolName}".`);
    return quote;
  }

  async getQuotes(symbols: CTraderSymbol[]): Promise<Map<string, CTraderQuoteEvent>> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    if (!symbols.length) return new Map();
    const wanted = new Set(symbols.map((symbol) => symbol.symbolId));
    return this.withSocket(async (socket) => {
      await this.request(socket, SUBSCRIBE_SPOTS_REQ, SUBSCRIBE_SPOTS_RES, {
        ctidTraderAccountId: this.accountId,
        symbolId: symbols.map((symbol) => symbol.symbolId),
        subscribeToSpotTimestamp: true,
      });
      return new Promise<Map<string, CTraderQuoteEvent>>((resolve, reject) => {
        const results = new Map<string, CTraderQuoteEvent>();
        const timer = setTimeout(() => {
          // Some broker symbols do not tick while their market is closed. Return
          // only provider-confirmed spot events rather than failing the whole batch.
          cleanup();
          resolve(results);
        }, Math.min(this.timeoutMs, 4_000));
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
        };
        const onMessage = (event: MessageEvent) => {
          let message: OpenApiMessage;
          try { message = JSON.parse(String(event.data)) as OpenApiMessage; } catch { return; }
          if (message.payloadType !== SPOT_EVENT || !message.payload) return;
          const symbolId = String(message.payload.symbolId ?? "");
          if (!wanted.has(symbolId) || results.has(symbolId)) return;
          const bid = number(message.payload.bid);
          const ask = number(message.payload.ask);
          const sessionClose = number(message.payload.sessionClose);
          const timestamp = number(message.payload.timestamp);
          results.set(symbolId, {
            symbolId,
            ...(bid !== undefined ? { bid: bid / 100_000 } : {}),
            ...(ask !== undefined ? { ask: ask / 100_000 } : {}),
            ...(sessionClose !== undefined ? { sessionClose: sessionClose / 100_000 } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          });
          if (results.size === wanted.size) {
            cleanup();
            resolve(results);
          }
        };
        socket.addEventListener("message", onMessage);
      });
    });
  }

  async getCandles(symbol: CTraderSymbol, timeframe: string, count = 200): Promise<CTraderTrendbar[]> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    const periods: Record<string, number> = { "1m": 1, "5m": 5, "15m": 7, "1h": 9, "4h": 10, "1D": 12, "1d": 12 };
    const period = periods[timeframe];
    if (!period) throw new Error(`cTrader does not support the requested timeframe "${timeframe}".`);
    const boundedCount = Math.max(1, Math.min(500, Math.floor(count)));
    const durationMs = ({ 1: 60_000, 5: 300_000, 7: 900_000, 9: 3_600_000, 10: 14_400_000, 12: 86_400_000 } as Record<number, number>)[period];
    const toTimestamp = Date.now();
    return this.withSocket(async (socket) => {
      const payload = await this.request(socket, GET_TRENDBARS_REQ, GET_TRENDBARS_RES, {
        ctidTraderAccountId: this.accountId,
        symbolId: symbol.symbolId,
        period,
        count: boundedCount,
        fromTimestamp: toTimestamp - boundedCount * durationMs,
        toTimestamp,
      });
      return payloadArray<Record<string, unknown>>(payload, "trendbar").map((bar) => ({
        volume: number(bar.volume),
        low: number(bar.low),
        deltaOpen: number(bar.deltaOpen),
        deltaClose: number(bar.deltaClose),
        deltaHigh: number(bar.deltaHigh),
        utcTimestampInMinutes: number(bar.utcTimestampInMinutes),
      }));
    });
  }

  async placeOrder(input: {
    symbol: CTraderSymbol;
    side: "BUY" | "SELL";
    volumeUnits: number;
    orderType: "MARKET" | "LIMIT";
    limitPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    clientOrderId: string;
  }): Promise<{ status: "accepted" | "rejected" | "unknown" | "not_submitted"; accepted: boolean; orderId?: string; executionType?: number; requestedVolumeCents: number; message: string }> {
    if (!this.accountId) throw new Error("Select a cTrader trading account in Settings first.");
    if (!Number.isFinite(input.volumeUnits) || input.volumeUnits <= 0) throw new Error("Order quantity must be positive.");
    if (input.orderType === "LIMIT" && (!Number.isFinite(input.limitPrice) || (input.limitPrice ?? 0) <= 0)) throw new Error("A valid limit price is required for a limit order.");
    if (!input.clientOrderId || input.clientOrderId.length > 50 || !/^[A-Za-z0-9_-]+$/.test(input.clientOrderId)) throw new Error("cTrader clientOrderId must be 1-50 alphanumeric, underscore or hyphen characters.");
    // ProtoOA volume is cents: 1,000 units = 100,000. Keep qty in units for risk math.
    const requestedVolumeCents = cTraderVolumeCents(input.volumeUnits);
    if ((input.stopLoss !== undefined && (!Number.isFinite(input.stopLoss) || input.stopLoss <= 0)) || (input.takeProfit !== undefined && (!Number.isFinite(input.takeProfit) || input.takeProfit <= 0))) throw new Error("Protective stop-loss and take-profit prices must be finite positive values.");
    try {
      return await this.withSocket(async (socket) => {
      const clientMsgId = id();
      const clientOrderId = input.clientOrderId;
      let payload: Record<string, unknown>;
      try {
        payload = await this.waitFor(socket, (message) => {
          if (message.payloadType === 2126) {
            const order = message.payload?.order && typeof message.payload.order === "object" ? message.payload.order as Record<string, unknown> : {};
            return String(order.clientOrderId ?? message.payload?.clientOrderId ?? "") === clientOrderId;
          }
          if (message.payloadType === 2132) {
            const body = message.payload ?? {};
            const order = body.order && typeof body.order === "object" ? body.order as Record<string, unknown> : {};
            return message.clientMsgId === clientMsgId || String(order.clientOrderId ?? body.clientOrderId ?? "") === clientOrderId;
          }
          return message.payloadType === RESPONSE_ERROR && (!message.clientMsgId || message.clientMsgId === clientMsgId);
        }, () => socket.send(JSON.stringify({
          clientMsgId, payloadType: NEW_ORDER_REQ,
          payload: { ctidTraderAccountId: this.accountId, symbolId: input.symbol.symbolId, orderType: input.orderType === "LIMIT" ? 2 : 1, tradeSide: input.side === "BUY" ? 1 : 2, volume: requestedVolumeCents, ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}), ...(input.stopLoss !== undefined ? { stopLoss: input.stopLoss } : {}), ...(input.takeProfit !== undefined ? { takeProfit: input.takeProfit } : {}), clientOrderId, label: "SIRGOAT", comment: "Submitted by SIRGOAT" },
        })));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown cTrader response failure.";
        if (/cTrader Open API error \d+:/i.test(message)) return { status: "rejected", accepted: false, requestedVolumeCents, message: "cTrader rejected the order: " + message };
        return { status: "unknown", accepted: false, requestedVolumeCents, message: "cTrader order status is unknown. Check cTrader orders for client order ID " + clientOrderId + " before retrying; SIRGOAT did not automatically resubmit." };
      }
      const executionType = number(payload.executionType);
      const order = payload.order && typeof payload.order === "object" ? payload.order as Record<string, unknown> : {};
      const orderIdValue = number(order.orderId) ?? number(payload.orderId);
      const orderId = orderIdValue !== undefined ? String(orderIdValue) : undefined;
      if (payload.errorCode || (payload.description && executionType === undefined)) return { status: "rejected", accepted: false, ...(orderId ? { orderId } : {}), requestedVolumeCents, message: "cTrader rejected the order: " + String(payload.description ?? payload.errorCode) };
      if (executionType === 7) return { status: "rejected", accepted: false, ...(orderId ? { orderId } : {}), executionType, requestedVolumeCents, message: "cTrader rejected the order during validation" + (payload.description ? ": " + String(payload.description) : ".") };
      if (executionType !== 2 && executionType !== 3 && executionType !== 11) return { status: "unknown", accepted: false, ...(orderId ? { orderId } : {}), ...(executionType !== undefined ? { executionType } : {}), requestedVolumeCents, message: "cTrader returned an unrecognized execution status. Inspect the broker order list before retrying." };
      if (!orderId) return { status: "unknown", accepted: false, executionType, requestedVolumeCents, message: "cTrader reported an order event without an order ID. Inspect the broker order list by client order ID before retrying." };
      return { status: "accepted", accepted: true, orderId, executionType, requestedVolumeCents, message: executionType === 3 ? "cTrader confirmed the order filled; protective levels must still be verified against broker state." : executionType === 11 ? "cTrader confirmed a partial fill; protective levels must still be verified against broker state." : "cTrader accepted the order; fill and protective levels must still be verified against broker state." };
    });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cTrader connection failure.";
      return {
        status: "not_submitted",
        accepted: false,
        requestedVolumeCents,
        message: "cTrader connection or account authorization failed before an order response could be received. No order was submitted by this request: " + message,
      };
    }
  }
}
