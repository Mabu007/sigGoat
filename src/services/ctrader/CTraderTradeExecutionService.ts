import { CTraderOpenApiClient, type CTraderSymbol } from "./CTraderOpenApiClient";

export interface CTraderTradeIntent {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  intentId: string;
}

export interface CTraderRiskCheck {
  ok: boolean;
  violations: string[];
  measured: {
    equityUsd: number | null;
    proposedRiskUsd: number | null;
    portfolioRiskUsd: number | null;
    proposedRiskPctOfEquity: number | null;
    portfolioRiskPctOfEquity: number | null;
    commissionReserveUsd: number | null;
  };
}

type TradeDetails = Record<string, unknown>;

function n(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function record(value: unknown): TradeDetails | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as TradeDetails : null;
}

function usdQuoteSymbol(name: string): boolean {
  const compact = name.toUpperCase().replace(/[\/_-]/g, "");
  return compact.endsWith("USD") && compact.length >= 6;
}

/**
 * Commission calculations are based only on cTrader's explicit symbol
 * metadata. If the broker does not return enough commission data, execution
 * fails closed rather than assuming that trading is free.
 */
function roundTripCommission(symbol: CTraderSymbol, volumeCents: number, qty: number, price: number): number | null {
  const type = symbol.commissionType;
  const rateRaw = symbol.preciseTradingCommissionRate;
  if (type === undefined || rateRaw === undefined || !Number.isFinite(rateRaw) || rateRaw < 0) return null;
  const rate = rateRaw / 100_000_000;
  const notional = qty * price;
  let oneSide: number;
  if (type === 1) {
    // USD per million USD traded.
    oneSide = notional * rate / 1_000_000;
  } else if (type === 2 || type === 4) {
    // USD per lot or quote currency per lot; accepted only for USD-quoted symbols.
    if (symbol.lotSize === undefined || symbol.lotSize <= 0) return null;
    oneSide = volumeCents / symbol.lotSize * rate;
  } else if (type === 3) {
    // Percentage-of-value rate is scaled by 10^5, with percentage points.
    oneSide = notional * rateRaw / 10_000_000;
  } else {
    return null;
  }
  const minimum = symbol.preciseMinCommission === undefined ? 0 : symbol.preciseMinCommission / 100_000_000;
  return Math.max(oneSide, minimum) * 2;
}

function activePositionRisk(
  item: TradeDetails,
  bySymbolId: Map<string, CTraderSymbol>,
): { risk: number; pnl: number } | null {
  const trade = record(item.tradeData);
  if (!trade) return null;
  const symbol = bySymbolId.get(String(trade.symbolId ?? ""));
  const volume = n(trade.volume);
  const side = n(trade.tradeSide);
  const entry = n(item.price);
  const stop = n(item.stopLoss);
  if (!symbol || !usdQuoteSymbol(symbol.symbolName) || volume === null || volume <= 0 || side === null || (side !== 1 && side !== 2) || entry === null || entry <= 0 || stop === null || stop <= 0) return null;
  const qty = volume / 100;
  if (qty <= 0) return null;
  const risk = Math.abs(entry - stop) * qty;
  return { risk, pnl: 0 };
}

export class CTraderTradeExecutionService {
  constructor(
    private readonly client: CTraderOpenApiClient,
    private readonly executionEnabled = process.env.CTRADER_EXECUTION_ENABLED === "true",
  ) {}

  async preflight(intent: CTraderTradeIntent): Promise<CTraderRiskCheck> {
    const violations: string[] = [];
    const empty: CTraderRiskCheck["measured"] = {
      equityUsd: null,
      proposedRiskUsd: null,
      portfolioRiskUsd: null,
      proposedRiskPctOfEquity: null,
      portfolioRiskPctOfEquity: null,
      commissionReserveUsd: null,
    };
    const blocked = (reason: string): CTraderRiskCheck => ({ ok: false, violations: [...violations, reason], measured: empty });

    if (!this.executionEnabled) return blocked("cTrader order execution is disabled by the server. Set CTRADER_EXECUTION_ENABLED=true only after validating the demo environment.");
    if (intent.side !== "BUY" && intent.side !== "SELL") return blocked("The order side must be BUY or SELL.");
    if (!intent.symbol || !intent.symbol.trim()) return blocked("An exact cTrader symbol is required.");
    if (!intent.intentId || !/^[A-Za-z0-9_-]{8,50}$/.test(intent.intentId)) return blocked("A valid cTrader client order ID of 8–50 alphanumeric, underscore or hyphen characters is required for audit and reconciliation.");
    if (!Number.isFinite(intent.qty) || intent.qty <= 0 || ![intent.entry, intent.stopLoss, intent.takeProfit].every((v) => Number.isFinite(v) && v > 0)) return blocked("Quantity, entry, stop-loss and take-profit must be finite positive numbers.");
    if (intent.side === "BUY" ? !(intent.stopLoss < intent.entry && intent.takeProfit > intent.entry) : !(intent.stopLoss > intent.entry && intent.takeProfit < intent.entry)) return blocked("Stop-loss and take-profit are on the wrong side of the entry.");
    const riskDistance = Math.abs(intent.entry - intent.stopLoss);
    const rewardDistance = Math.abs(intent.takeProfit - intent.entry);
    if (riskDistance <= 0 || rewardDistance / riskDistance < 1.5) return blocked("The proposal must have a reward-to-risk ratio of at least 1.5.");

    const [account, assets, symbols, reconciled] = await Promise.all([
      this.client.getAccountDetails(),
      this.client.getAssets(),
      this.client.getSymbols(),
      this.client.reconcile(),
    ]);
    if (account.accessRights !== 0) return blocked("The selected cTrader account does not report FULL_ACCESS. No order was sent.");
    if (account.isLimitedRisk) return blocked("This cTrader account uses limited-risk execution rules that require guaranteed-stop-loss and relative SL/TP fields. This adapter does not yet submit those fields, so execution is blocked rather than sending an incompatible order.");
    const depositAsset = assets.find((asset) => asset.assetId === account.depositAssetId);
    if (!depositAsset || depositAsset.name.toUpperCase() !== "USD") return blocked("Risk controls currently require the cTrader account's deposit currency to be USD; this account's currency could not be verified as USD.");
    const symbol = symbols.find((item) => item.symbolName === intent.symbol);
    if (!symbol) return blocked(`cTrader does not list the exact symbol "${intent.symbol}" on the selected account.`);
    if (symbol.enabled === false) return blocked("The selected cTrader symbol is disabled for trading.");
    if (!usdQuoteSymbol(symbol.symbolName)) return blocked("Risk controls currently support only exact USD-quoted instruments. No cross-currency conversion is inferred.");
    if (symbol.minVolume === undefined || symbol.maxVolume === undefined || symbol.stepVolume === undefined || symbol.stepVolume <= 0) return blocked("cTrader did not provide complete min/max/step volume constraints for this symbol.");
    const volumeCents = Math.round(intent.qty * 100);
    if (Math.abs(volumeCents - intent.qty * 100) > 1e-7) return blocked("The requested quantity exceeds cTrader's volume precision.");
    if (volumeCents < symbol.minVolume || volumeCents > symbol.maxVolume || volumeCents % symbol.stepVolume !== 0) return blocked("The requested quantity violates cTrader's reported minimum, maximum or step volume.");

    const quote = await this.client.getQuote(symbol);
    const bid = n(quote.bid), ask = n(quote.ask), timestamp = n(quote.timestamp);
    if (bid === null || ask === null || timestamp === null || ask < bid || timestamp > Date.now() + 5_000 || Date.now() - timestamp > 30_000) return blocked("A fresh, valid cTrader bid/ask quote is required immediately before execution.");
    if (intent.side === "BUY" && intent.entry >= ask || intent.side === "SELL" && intent.entry <= bid) return blocked("The requested limit price is marketable against the current quote; review the price before submitting.");
    if (intent.side === "BUY" && (intent.stopLoss >= bid || intent.takeProfit <= ask) || intent.side === "SELL" && (intent.stopLoss <= ask || intent.takeProfit >= bid)) return blocked("The current bid/ask has already crossed or invalidated the proposed stop-loss or take-profit. Request a fresh proposal.");

    const commission = roundTripCommission(symbol, volumeCents, intent.qty, intent.entry);
    if (commission === null) return blocked("The broker did not provide supported commission metadata. Execution is blocked rather than assuming zero fees.");
    const proposedRisk = riskDistance * intent.qty + commission;
    const bySymbolId = new Map(symbols.map((item) => [item.symbolId, item]));
    let portfolioRisk = 0;
    let unrealisedPnl = 0;
    for (const position of reconciled.positions) {
      if (n(position.positionStatus) !== 1) continue;
      const trade = record(position.tradeData);
      const risk = activePositionRisk(position, bySymbolId);
      if (!trade || !risk) return blocked("An existing cTrader position has missing stop, size, price or symbol data. Portfolio risk cannot be measured safely.");
      const native = bySymbolId.get(String(trade.symbolId));
      if (!native) return blocked("An existing cTrader position references a symbol that is no longer listed.");
      const existingQuote = await this.client.getQuote(native);
      const existingBid = n(existingQuote.bid), existingAsk = n(existingQuote.ask);
      const openPrice = n(position.price);
      const volume = n(trade.volume);
      const side = n(trade.tradeSide);
      if (existingBid === null || existingAsk === null || openPrice === null || volume === null || side === null || !usdQuoteSymbol(native.symbolName)) return blocked("An existing cTrader position has insufficient live data to estimate portfolio risk.");
      const currentMid = (existingBid + existingAsk) / 2;
      const qty = volume / 100;
      unrealisedPnl += (side === 1 ? currentMid - openPrice : openPrice - currentMid) * qty;
      const existingCommission = roundTripCommission(native, volume, qty, openPrice);
      if (existingCommission === null) return blocked("Commission metadata is missing for an existing cTrader position.");
      portfolioRisk += risk.risk + existingCommission;
    }
    for (const order of reconciled.orders) {
      if (n(order.orderStatus) !== 1) continue;
      const trade = record(order.tradeData);
      const native = trade ? bySymbolId.get(String(trade.symbolId ?? "")) : undefined;
      const volume = trade ? n(trade.volume) : null;
      const entry = n(order.limitPrice) ?? n(order.stopPrice);
      const stop = n(order.stopLoss);
      if (!native || !trade || !usdQuoteSymbol(native.symbolName) || volume === null || volume <= 0 || entry === null || entry <= 0 || stop === null || stop <= 0) return blocked("An existing pending cTrader order has missing protective levels or symbol data. Portfolio risk cannot be measured safely.");
      const qty = volume / 100;
      const pendingCommission = roundTripCommission(native, volume, qty, entry);
      if (pendingCommission === null) return blocked("Commission metadata is missing for an existing pending cTrader order.");
      portfolioRisk += Math.abs(entry - stop) * qty + pendingCommission;
    }

    const equity = account.balance + unrealisedPnl;
    if (!Number.isFinite(equity) || equity <= 0) return blocked("The selected cTrader account has no positive, verifiable equity.");
    const maxSingleRisk = equity * 0.01;
    const maxPortfolioRisk = equity * 0.02;
    const proposedRiskPct = proposedRisk / equity * 100;
    const portfolioRiskPct = (portfolioRisk + proposedRisk) / equity * 100;
    if (proposedRisk > maxSingleRisk) violations.push("Proposed stop-loss risk including estimated round-trip commission exceeds 1% of current account equity.");
    if (portfolioRisk + proposedRisk > maxPortfolioRisk) violations.push("Total open, pending and proposed risk would exceed 2% of current account equity.");
    return {
      ok: violations.length === 0,
      violations,
      measured: {
        equityUsd: equity,
        proposedRiskUsd: proposedRisk,
        portfolioRiskUsd: portfolioRisk + proposedRisk,
        proposedRiskPctOfEquity: proposedRiskPct,
        portfolioRiskPctOfEquity: portfolioRiskPct,
        commissionReserveUsd: commission,
      },
    };
  }

  async execute(intent: CTraderTradeIntent): Promise<{
    status: "blocked" | "rejected" | "inactive" | "unknown" | "accepted" | "protection_unconfirmed";
    accepted: boolean;
    orderId?: string;
    quantityUnits?: number;
    protocolVolumeCents?: number;
    message: string;
    protectionVerified?: boolean;
  }> {
    const risk = await this.preflight(intent);
    if (!risk.ok) return { status: "blocked", accepted: false, message: risk.violations.join(" ") };
    const symbols = await this.client.getSymbols();
    const symbol = symbols.find((item) => item.symbolName === intent.symbol);
    if (!symbol) return { status: "blocked", accepted: false, message: "The exact cTrader symbol is no longer available. No order was sent." };
    try {
      const outcome = await this.client.placeOrder({
        symbol,
        side: intent.side,
        volumeUnits: intent.qty,
        orderType: "LIMIT",
        limitPrice: intent.entry,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        clientOrderId: intent.intentId,
      });
      if (!outcome.accepted) return {
        status: outcome.status === "rejected" ? "rejected" : outcome.status === "not_submitted" ? "blocked" : "unknown",
        accepted: false,
        ...(outcome.orderId ? { orderId: outcome.orderId } : {}),
        message: outcome.message,
      };

      // An acceptance event only confirms broker validation; it does not prove
      // that the persisted pending order has the intended SL/TP. Reconcile
      // against broker state before reporting the lifecycle as complete.
      let orders: Array<Record<string, unknown>>;
      try {
        const reconciled = await this.client.reconcile();
        orders = reconciled.orders;
      } catch {
        return {
          status: "protection_unconfirmed",
          accepted: true,
          orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
          message: "cTrader accepted the order, but SIRGOAT could not verify its persisted protective stop and target. Do not submit it again. Inspect order " + outcome.orderId + " in cTrader immediately.",
          protectionVerified: false,
        };
      }
      const brokerOrder = orders.find((order) =>
        String(order.clientOrderId ?? "") === intent.intentId ||
        (outcome.orderId && String(order.orderId ?? "") === outcome.orderId),
      );
      if (!brokerOrder) {
        return {
          status: "protection_unconfirmed",
          accepted: true,
          orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
          message: "cTrader accepted the order, but it was not found in the immediate broker reconciliation. Its status and protective levels are unconfirmed. Do not retry; inspect order " + outcome.orderId + " in cTrader.",
          protectionVerified: false,
        };
      }
      const brokerStatus = n(brokerOrder.orderStatus);
      if (brokerStatus === 3) {
        return {
          status: "rejected",
          accepted: false,
          orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
          message: "cTrader's reconciled order state is REJECTED. No retry was attempted; review the broker's rejection details.",
          protectionVerified: false,
        };
      }
      if (brokerStatus === 4 || brokerStatus === 5) {
        return {
          status: "inactive",
          accepted: false,
          orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
          message: brokerStatus === 4
            ? "cTrader reports that order " + outcome.orderId + " has EXPIRED and is no longer active. Review the broker state before creating a new intent."
            : "cTrader reports that order " + outcome.orderId + " has been CANCELLED and is no longer active. Review the broker state before creating a new intent.",
          protectionVerified: false,
        };
      }
      if (brokerStatus !== 1 && brokerStatus !== 2) {
        return {
          status: "protection_unconfirmed",
          accepted: true,
          orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
          message: "cTrader returned an unrecognized or missing order status for order " + outcome.orderId + ". Do not retry; inspect the order and protective levels in cTrader.",
          protectionVerified: false,
        };
      }
      const brokerTrade = record(brokerOrder.tradeData);
      const brokerVolumeCents = brokerTrade ? n(brokerTrade.volume) : null;
      const brokerSymbolId = brokerTrade ? String(brokerTrade.symbolId ?? "") : "";
      const brokerSide = brokerTrade ? n(brokerTrade.tradeSide) : null;
      const brokerLimitPrice = n(brokerOrder.limitPrice);
      const priceTolerance = Math.max(1e-10, 0.5 * Math.pow(10, -symbol.digits));
      const orderMatches = brokerVolumeCents === outcome.requestedVolumeCents &&
        brokerSymbolId === symbol.symbolId &&
        brokerSide === (intent.side === "BUY" ? 1 : 2) &&
        brokerLimitPrice !== null &&
        Math.abs(brokerLimitPrice - intent.entry) <= priceTolerance;
      const actualStop = n(brokerOrder.stopLoss);
      const actualTarget = n(brokerOrder.takeProfit);
      const stopMatches = actualStop !== null && Math.abs(actualStop - intent.stopLoss) <= priceTolerance;
      const targetMatches = actualTarget !== null && Math.abs(actualTarget - intent.takeProfit) <= priceTolerance;
      if (!orderMatches || !stopMatches || !targetMatches) {
        return {
          status: "protection_unconfirmed",
          accepted: true,
          orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
          message: "cTrader accepted order " + outcome.orderId + " but the broker's persisted symbol, side, volume, limit price, stop-loss or take-profit did not match the request. Do not retry. Inspect or cancel the order in cTrader before allowing it to fill.",
          protectionVerified: false,
        };
      }
      return {
        status: "accepted",
        accepted: true,
        orderId: outcome.orderId,
        quantityUnits: intent.qty,
        protocolVolumeCents: outcome.requestedVolumeCents,
        message: "cTrader accepted order " + outcome.orderId + " and broker reconciliation confirmed the requested stop-loss and take-profit are attached.",
        protectionVerified: true,
      };
    } catch {
      return { status: "unknown", accepted: false, message: "cTrader order status is unknown because the response was not confirmed. Check cTrader orders before retrying; SIRGOAT did not automatically resubmit." };
    }
  }
}
