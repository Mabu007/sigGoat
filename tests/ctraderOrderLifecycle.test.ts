import { describe, expect, test } from "bun:test";
import { CTraderTradeExecutionService } from "../src/services/ctrader/CTraderTradeExecutionService";
import { cTraderVolumeCents, type CTraderOpenApiClient, type CTraderSymbol } from "../src/services/ctrader/CTraderOpenApiClient";

const symbol: CTraderSymbol = {
  symbolId: "1",
  symbolName: "EURUSD",
  enabled: true,
  digits: 5,
  pipPosition: 4,
  minVolume: 1_000,
  maxVolume: 100_000_000,
  stepVolume: 1_000,
  commissionType: 1,
  preciseTradingCommissionRate: 5_000_000,
  preciseMinCommission: 0,
  lotSize: 10_000_000,
};
const intent = {
  symbol: "EURUSD",
  side: "BUY" as const,
  qty: 1_000,
  entry: 1.07,
  stopLoss: 1.06,
  takeProfit: 1.09,
  intentId: "sirgoat_demo_123",
};

function fakeClient(options: {
  order?: Record<string, unknown>;
  placeOrderResult?: Record<string, unknown>;
} = {}) {
  let reconcileCalls = 0;
  let placeCalls = 0;
  const order = options.order;
  const client = {
    getAccountDetails: async () => ({ balance: 10_000, moneyDigits: 2, depositAssetId: "1", accessRights: 0, isLimitedRisk: false }),
    getAssets: async () => [{ assetId: "1", name: "USD" }],
    getSymbols: async () => [symbol],
    reconcile: async () => {
      reconcileCalls += 1;
      return { positions: [], orders: reconcileCalls === 1 ? [] : order ? [order] : [] };
    },
    getQuote: async () => ({ symbolId: "1", bid: 1.0799, ask: 1.08, timestamp: Date.now() }),
    placeOrder: async () => {
      placeCalls += 1;
      return options.placeOrderResult ?? { status: "accepted", accepted: true, orderId: "456", executionType: 2, requestedVolumeCents: 100_000, message: "accepted" };
    },
    getReconcileCalls: () => reconcileCalls,
    getPlaceCalls: () => placeCalls,
  };
  return client;
}

describe("cTrader order lifecycle", () => {
  test("converts human units to cTrader protocol volume cents", () => {
    expect(cTraderVolumeCents(1)).toBe(100);
    expect(cTraderVolumeCents(1_000)).toBe(100_000);
    expect(cTraderVolumeCents(0.01)).toBe(1);
    expect(() => cTraderVolumeCents(0)).toThrow();
    expect(() => cTraderVolumeCents(-1)).toThrow();
    expect(() => cTraderVolumeCents(1.001)).toThrow(/0.01-unit/);
  });

  test("reports completion only after broker reconciliation confirms both protective levels", async () => {
    const client = fakeClient({ order: {
      orderId: "456",
      clientOrderId: intent.intentId,
      orderStatus: 1,
      stopLoss: intent.stopLoss,
      takeProfit: intent.takeProfit,
      limitPrice: intent.entry,
      tradeData: { symbolId: "1", volume: 100_000, tradeSide: 1 },
    } });
    const executor = new CTraderTradeExecutionService(client as unknown as CTraderOpenApiClient, true);
    const result = await executor.execute(intent);
    expect(result.status).toBe("accepted");
    expect(result.accepted).toBe(true);
    expect(result.protectionVerified).toBe(true);
    expect(result.message).toMatch(/confirmed.*attached/);
    expect(client.getPlaceCalls()).toBe(1);
  });

  test("does not report success when broker state lacks the requested stop or target", async () => {
    const client = fakeClient({ order: {
      orderId: "456",
      clientOrderId: intent.intentId,
      orderStatus: 1,
      stopLoss: intent.stopLoss,
      takeProfit: null,
      limitPrice: intent.entry,
      tradeData: { symbolId: "1", volume: 100_000, tradeSide: 1 },
    } });
    const executor = new CTraderTradeExecutionService(client as unknown as CTraderOpenApiClient, true);
    const result = await executor.execute(intent);
    expect(result.status).toBe("protection_unconfirmed");
    expect(result.accepted).toBe(true);
    expect(result.protectionVerified).toBe(false);
    expect(result.message).toMatch(/Do not retry/);
    expect(client.getPlaceCalls()).toBe(1);
  });

  test("keeps ambiguous broker outcomes distinct from definite rejection", async () => {
    const rejectedClient = fakeClient({ placeOrderResult: {
      status: "rejected", accepted: false, requestedVolumeCents: 100_000, message: "broker rejected",
    } });
    const rejected = await new CTraderTradeExecutionService(rejectedClient as unknown as CTraderOpenApiClient, true).execute(intent);
    expect(rejected.status).toBe("rejected");
    expect(rejected.accepted).toBe(false);
    expect(rejectedClient.getPlaceCalls()).toBe(1);

    const unknownClient = fakeClient({ placeOrderResult: {
      status: "unknown", accepted: false, requestedVolumeCents: 100_000, message: "status unknown; do not retry",
    } });
    const unknown = await new CTraderTradeExecutionService(unknownClient as unknown as CTraderOpenApiClient, true).execute(intent);
    expect(unknown.status).toBe("unknown");
    expect(unknown.accepted).toBe(false);
    expect(unknown.message).toMatch(/do not retry/i);
    expect(unknownClient.getPlaceCalls()).toBe(1);
  });
});
