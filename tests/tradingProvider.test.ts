import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRADING_PROVIDER,
  resolveGoatTradingProvider,
  resolveUserTradingProvider,
  parseTradingProvider,
  isTradingProvider,
} from "../src/services/trading-provider/TradingProvider";
import type { FundGoat, UserProfile } from "../src/types";

describe("trading provider resolution", () => {
  test("new users default to cTrader unless they saved a valid preference", () => {
    expect(DEFAULT_TRADING_PROVIDER).toBe("ctrader");
    expect(resolveUserTradingProvider(null)).toBe("ctrader");
    expect(resolveUserTradingProvider({ tradingProvider: "hyperliquid" } as UserProfile)).toBe("hyperliquid");
    expect(resolveUserTradingProvider({ tradingProvider: "ctrader" } as UserProfile)).toBe("ctrader");
  });

  test("legacy GOATs without a provider remain pinned to Hyperliquid", () => {
    expect(resolveGoatTradingProvider({ id: "legacy" } as FundGoat)).toBe("hyperliquid");
    expect(resolveGoatTradingProvider({ id: "new", tradingProvider: "ctrader" } as FundGoat)).toBe("ctrader");
    expect(resolveGoatTradingProvider({ id: "saved", tradingProvider: "hyperliquid" } as FundGoat)).toBe("hyperliquid");
  });

  test("rejects unknown provider values instead of silently routing them", () => {
    expect(isTradingProvider("ctrader")).toBe(true);
    expect(isTradingProvider("hyperliquid")).toBe(true);
    expect(isTradingProvider("propdao")).toBe(false);
    expect(parseTradingProvider("ctrader")).toBe("ctrader");
    expect(parseTradingProvider("hyperliquid")).toBe("hyperliquid");
    expect(parseTradingProvider("other")).toBeNull();
    expect(parseTradingProvider(undefined)).toBeNull();
  });
});
