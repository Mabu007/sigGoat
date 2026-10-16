import { describe, expect, test } from "bun:test";
import { createCTraderOAuthState, verifyCTraderOAuthState } from "../src/services/ctrader/CTraderOAuthService";

describe("cTrader OAuth state", () => {
  test("binds the callback to the authenticated user and accepts a fresh signed state", () => {
    const state = createCTraderOAuthState("firebase-user-123", "test-client-secret", 1_800_000_000_000);
    expect(verifyCTraderOAuthState(state, "test-client-secret", 1_800_000_001_000)).toEqual({
      userId: "firebase-user-123",
    });
  });

  test("rejects a tampered state and a state signed with a different secret", () => {
    const state = createCTraderOAuthState("firebase-user-123", "secret-a", 1_800_000_000_000);
    const [payload, signature] = state.split(".");
    expect(() => verifyCTraderOAuthState(payload + "." + signature.slice(0, -1) + "x", "secret-a", 1_800_000_001_000)).toThrow(/signature/i);
    expect(() => verifyCTraderOAuthState(state, "secret-b", 1_800_000_001_000)).toThrow(/signature/i);
  });

  test("rejects expired state and state from the future", () => {
    const now = 1_800_000_000_000;
    const expired = createCTraderOAuthState("firebase-user-123", "secret", now - 600_001);
    const future = createCTraderOAuthState("firebase-user-123", "secret", now + 30_001);
    expect(() => verifyCTraderOAuthState(expired, "secret", now)).toThrow(/expired/i);
    expect(() => verifyCTraderOAuthState(future, "secret", now)).toThrow(/expired/i);
  });
});
