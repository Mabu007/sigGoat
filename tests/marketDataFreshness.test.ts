import { describe, expect, test } from "bun:test";
import { MarketStateStore } from "../src/services/market-data/MarketStateStore";
import type { MarketDataProvider } from "../src/services/market-data/MarketDataProvider";
import type { MarketQuote } from "../src/types";

function storeFor(quote: Partial<MarketQuote>, dataMode: "LIVE" | "PAPER" = "LIVE") {
  const provider = {
    name: "test-provider",
    dataMode,
    getSymbols: async () => [],
    getQuote: async () => ({
      symbol: "BTC",
      mid: 100,
      timestamp: Date.now(),
      stale: false,
      quoteAgeSeconds: 0,
      ...quote,
    } as unknown as MarketQuote),
    getQuotes: async () => [],
    getCandles: async () => [],
    getMarketMetadata: () => undefined,
    subscribeQuotes: () => () => undefined,
  } as unknown as MarketDataProvider;

  return new MarketStateStore(provider, {
    ttlMs: 1_000,
    now: () => Date.now(),
    log: () => undefined,
  });
}

describe("MarketStateStore live quote freshness", () => {
  test("does not publish provider-marked stale prices as LIVE", async () => {
    const store = storeFor({ stale: true });
    const snapshot = await store.getState("BTC");
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.latestPrice).toBeNull();
  });

  test("fails closed when a LIVE provider omits quote age", async () => {
    const store = storeFor({ quoteAgeSeconds: undefined });
    const snapshot = await store.getState("BTC");
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.latestPrice).toBeNull();
  });

  test("fails closed when quote age exceeds the market-state TTL", async () => {
    const store = storeFor({ quoteAgeSeconds: 2 });
    const snapshot = await store.getState("BTC");
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.latestPrice).toBeNull();
  });

  test("accepts a positive fresh quote from a LIVE provider", async () => {
    const store = storeFor({ quoteAgeSeconds: 0.1, mid: 100 });
    const snapshot = await store.getState("BTC");
    expect(snapshot.status).toBe("LIVE");
    expect(snapshot.latestPrice).toBe(100);
  });

  test("does not treat an invalid zero price as a live quote", async () => {
    const store = storeFor({ mid: 0 });
    const snapshot = await store.getState("BTC");
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.latestPrice).toBeNull();
  });
});
