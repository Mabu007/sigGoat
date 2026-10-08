import { MarketSymbol, MarketQuote, Candle, DataMode } from '../../types';

export type { MarketSymbol, MarketQuote, Candle, DataMode };

export interface MarketDataProvider {
  readonly name: string;
  /**
   * Declares whether this provider serves REAL market data or a PAPER
   * (simulated) feed. The API surfaces this to the UI so synthetic prices
   * can never masquerade as live prices.
   */
  readonly dataMode: DataMode;
  getSymbols(): Promise<MarketSymbol[]>;
  getQuote(symbol: string): Promise<MarketQuote>;
  getQuotes(symbols: string[]): Promise<MarketQuote[]>;
  getCandles(symbol: string, timeframe: string, count?: number): Promise<Candle[]>;
  getMarketMetadata(symbol: string): MarketSymbol | undefined;
  subscribeQuotes(symbols: string[], callback: (quote: MarketQuote) => void): () => void;
}

export class MarketDataUnavailableError extends Error {
  readonly symbol?: string;
  constructor(message: string, symbol?: string) {
    super(message);
    this.name = 'MarketDataUnavailableError';
    this.symbol = symbol;
  }
}
