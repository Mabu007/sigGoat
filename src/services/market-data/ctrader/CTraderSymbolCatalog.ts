/**
 * cTrader SYMBOL CATALOGUE
 * ========================
 * A static, curated list of assets cTrader venues list, so the asset picker
 * can offer real cTrader instruments BEFORE a broker is connected.
 *
 * WHY THIS EXISTS
 *   cTrader's OpenAPI scopes `SymbolsList` to a single
 *   `ctidTraderAccountId`, and `AccountAuth` requires an OAuth access token.
 *   That means the authoritative catalogue is genuinely unreachable without a
 *   granted account -- and it must stay per-broker, because different brokers
 *   expose different instruments. So this list is the BROKER-INDEPENDENT
 *   baseline: what the picker offers before connection, and the shape the
 *   picker falls back to when the live list cannot be fetched.
 *
 *   It is never used to price anything. Live quotes still come from the
 *   account-scoped adapter; this only decides which assets a team may be
 *   configured for and what to call them.
 *
 * Naming follows cTrader's convention: concatenated, no separator
 * (`EURUSD`, `XAUUSD`, `US500`). Do NOT reformat these to `EUR/USD` -- the
 * runtime, market-state store and execution service all key on the exact
 * symbol string.
 */

import type { MarketSymbol } from '../../../types';

export interface CTraderCatalogEntry {
  symbol: string;
  name: string;
  category: MarketSymbol['category'];
  baseCurrency: string;
  quoteCurrency: string;
  /** Sensible starting price for the simulated feed. */
  referencePrice: number;
  digits: number;
  pipSize: number;
}

const forex = (symbol: string, name: string, base: string, referencePrice: number, digits = 5): CTraderCatalogEntry => ({
  symbol, name, category: 'forex', baseCurrency: base, quoteCurrency: 'USD', referencePrice, digits, pipSize: digits === 5 ? 0.0001 : 0.01,
});

const index = (symbol: string, name: string, referencePrice: number, digits = 2): CTraderCatalogEntry => ({
  symbol, name, category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', referencePrice, digits, pipSize: digits === 2 ? 0.1 : 1,
});

const commodity = (symbol: string, name: string, base: string, referencePrice: number, digits = 2): CTraderCatalogEntry => ({
  symbol, name, category: 'commodities', baseCurrency: base, quoteCurrency: 'USD', referencePrice, digits, pipSize: 0.01,
});

/** The majors a trader actually reaches for first. */
export const CTRADER_CATALOG: CTraderCatalogEntry[] = [
  // ---- FX majors & crosses ----
  forex('EURUSD', 'Euro / US Dollar', 'EUR', 1.0862),
  forex('GBPUSD', 'British Pound / US Dollar', 'GBP', 1.2945),
  forex('USDJPY', 'US Dollar / Japanese Yen', 'USD', 152.42, 3),
  forex('USDCHF', 'US Dollar / Swiss Franc', 'USD', 0.8654),
  forex('AUDUSD', 'Australian Dollar / US Dollar', 'AUD', 0.6583),
  forex('USDCAD', 'US Dollar / Canadian Dollar', 'USD', 1.3872),
  forex('NZDUSD', 'New Zealand Dollar / US Dollar', 'NZD', 0.6012),
  forex('EURGBP', 'Euro / British Pound', 'EUR', 0.8391),
  forex('EURJPY', 'Euro / Japanese Yen', 'EUR', 165.62, 3),
  forex('GBPJPY', 'British Pound / Japanese Yen', 'GBP', 197.34, 3),

  // ---- Metals ----
  commodity('XAUUSD', 'Gold / US Dollar', 'XAU', 2742.6),
  commodity('XAGUSD', 'Silver / US Dollar', 'XAG', 32.85),
  commodity('XAUEUR', 'Gold / Euro', 'XAU', 2524.1),
  commodity('XPTUSD', 'Platinum / US Dollar', 'XPT', 968.4),
  commodity('XPDUSD', 'Palladium / US Dollar', 'XPD', 1012.7),

  // ---- Energy ----
  commodity('USOIL', 'Crude Oil WTI (USD)', 'WTI', 70.8),
  commodity('UKOIL', 'Brent Crude Oil (USD)', 'BRENT', 74.3),

  // ---- Indices ----
  index('US500', 'S&P 500 Index', 5864.2),
  index('NAS100', 'Nasdaq 100 Index', 20380.5),
  index('US30', 'Dow Jones 30 Index', 42810, 1),
  index('DE40', 'Germany DAX 40 Index', 19480),
  index('UK100', 'UK FTSE 100 Index', 8294),
  index('JP225', 'Japan Nikkei 225 Index', 40120, 1),
  index('AUS200', 'Australia ASX 200 Index', 8291),

  // ---- Crypto ----
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', category: 'crypto', baseCurrency: 'BTC', quoteCurrency: 'USD', referencePrice: 96840, digits: 2, pipSize: 0.1 },
  { symbol: 'ETHUSD', name: 'Ethereum / US Dollar', category: 'crypto', baseCurrency: 'ETH', quoteCurrency: 'USD', referencePrice: 3421.5, digits: 2, pipSize: 0.1 },
  { symbol: 'SOLUSD', name: 'Solana / US Dollar', category: 'crypto', baseCurrency: 'SOL', quoteCurrency: 'USD', referencePrice: 214.8, digits: 2, pipSize: 0.1 },
  { symbol: 'XRPUSD', name: 'XRP / US Dollar', category: 'crypto', baseCurrency: 'XRP', quoteCurrency: 'USD', referencePrice: 2.284, digits: 4, pipSize: 0.0001 },
];

export const CTRADER_SYMBOLS: MarketSymbol[] = CTRADER_CATALOG.map(entry => ({
  symbol: entry.symbol,
  name: entry.name,
  category: entry.category,
  baseCurrency: entry.baseCurrency,
  quoteCurrency: entry.quoteCurrency,
  pipSize: entry.pipSize,
  digits: entry.digits,
  minSpread: 0,
}));

export const CTRADER_REFERENCE_PRICES: Record<string, number> = Object.fromEntries(
  CTRADER_CATALOG.map(entry => [entry.symbol, entry.referencePrice]),
);

export function isCTraderCatalogSymbol(symbol: string): boolean {
  return Object.prototype.hasOwnProperty.call(CTRADER_REFERENCE_PRICES, symbol.toUpperCase());
}