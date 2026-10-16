import type { TradingProvider } from "../../types";

export interface TradingProviderRegistration {
  id: TradingProvider;
  label: string;
  marketDataAdapter: "hyperliquid" | "ctrader" | null;
  executionAdapter: "propdao" | "ctrader" | null;
  ready: boolean;
  unavailableReason?: string;
}

/**
 * Central capability registry for trading venues.
 *
 * A provider is marked ready only when its market-data AND execution paths are
 * both wired. cTrader credentials alone do not make the integration ready.
 * Hyperliquid currently uses Hyperliquid market data and the existing PropDAO
 * execution adapter; cTrader has its own OAuth, quote/candle and order adapters.
 * Runtime execution remains gated by CTRADER_EXECUTION_ENABLED and per-order
 * broker-data/risk checks.
 */
export const TRADING_PROVIDER_REGISTRY: Readonly<Record<TradingProvider, TradingProviderRegistration>> = {
  hyperliquid: {
    id: "hyperliquid",
    label: "Hyperliquid + PropDAO",
    marketDataAdapter: "hyperliquid",
    executionAdapter: "propdao",
    ready: true,
  },
  ctrader: {
    id: "ctrader",
    label: "cTrader",
    marketDataAdapter: "ctrader",
    executionAdapter: "ctrader",
    ready: true,
  },
};

export function getTradingProviderRegistration(provider: TradingProvider): TradingProviderRegistration {
  return TRADING_PROVIDER_REGISTRY[provider];
}

export function isTradingProviderReady(provider: TradingProvider): boolean {
  return TRADING_PROVIDER_REGISTRY[provider].ready;
}
