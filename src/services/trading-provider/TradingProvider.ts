import {
  DEFAULT_TRADING_PROVIDER,
  type FundGoat,
  type TradingProvider,
  type UserProfile,
} from "../../types";

/**
 * Resolve a user's app-level default.
 *
 * A user who has not saved a preference gets the new cTrader-first default.
 * This is only the default for newly created GOATs; it does not rewrite
 * existing GOAT records.
 */
export function resolveUserTradingProvider(
  profile: Pick<UserProfile, "tradingProvider"> | null | undefined,
): TradingProvider {
  return isTradingProvider(profile?.tradingProvider)
    ? profile.tradingProvider
    : DEFAULT_TRADING_PROVIDER;
}

/**
 * Resolve the immutable venue identity of a GOAT.
 *
 * Older persisted GOATs have no tradingProvider field. They deliberately
 * remain on Hyperliquid so this migration cannot silently change their market
 * symbols or send an existing workflow to a different execution venue.
 */
export function resolveGoatTradingProvider(
  goat: Pick<FundGoat, "tradingProvider">,
): TradingProvider {
  return isTradingProvider(goat.tradingProvider)
    ? goat.tradingProvider
    : "hyperliquid";
}

/** Validate provider values at API/persistence boundaries. */
export function isTradingProvider(value: unknown): value is TradingProvider {
  return value === "ctrader" || value === "hyperliquid";
}

/** Canonicalise untrusted input without silently accepting unknown venues. */
export function parseTradingProvider(value: unknown): TradingProvider | null {
  return isTradingProvider(value) ? value : null;
}
