import { describe, expect, test } from "bun:test";
import { isCTraderNumericId } from "../src/services/ctrader/CTraderOpenApiClient";

describe("cTrader numeric identifiers", () => {
  test("accepts account, asset and symbol IDs as decimal strings", () => {
    expect(isCTraderNumericId("123456")).toBe(true);
    expect(isCTraderNumericId("0")).toBe(true);
  });

  test("rejects empty, malformed and non-decimal IDs", () => {
    for (const value of ["", " ", "abc", "\\d123", "12.3", "-12", "12x"]) {
      expect(isCTraderNumericId(value)).toBe(false);
    }
  });
});
