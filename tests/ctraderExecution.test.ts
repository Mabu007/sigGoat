import { describe, expect, test } from "bun:test";
import { CTraderTradeExecutionService } from "../src/services/ctrader/CTraderTradeExecutionService";
import type { CTraderOpenApiClient } from "../src/services/ctrader/CTraderOpenApiClient";

const unusedClient = {} as CTraderOpenApiClient;
const validIntent = {
  symbol: "EURUSD",
  side: "BUY" as const,
  qty: 1,
  entry: 1.08,
  stopLoss: 1.07,
  takeProfit: 1.10,
  intentId: "sirgoat_test_123",
};

describe("cTrader execution safeguards", () => {
  test("blocks order preflight when the server execution flag is off", async () => {
    const service = new CTraderTradeExecutionService(unusedClient, false);
    const result = await service.preflight(validIntent);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/CTRADER_EXECUTION_ENABLED/);
  });

  test("rejects an invalid order side before calling the broker", async () => {
    const service = new CTraderTradeExecutionService(unusedClient, true);
    const result = await service.preflight({ ...validIntent, side: "HOLD" as "BUY" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/BUY or SELL/);
  });
});
