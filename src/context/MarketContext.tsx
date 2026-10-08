import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  MarketQuote,
  MarketSymbol,
  Candle,
} from '../types';

interface MarketContextType {
  quotes: Record<string, MarketQuote>;
  symbols: MarketSymbol[];

  activeSymbol: string;
  setActiveSymbol: (symbol: string) => void;

  activeQuote: MarketQuote | undefined;

  /**
   * True while the initial market bootstrap is running.
   */
  loading: boolean;

  /**
   * True when the latest quote refresh failed.
   * Existing good quotes are preserved.
   */
  quotesError: string | null;

  /**
   * True when symbol loading failed.
   */
  symbolsError: string | null;

  /**
   * Fetch historical candles for a market/timeframe.
   */
  fetchCandles: (
    symbol: string,
    timeframe: string,
    count?: number
  ) => Promise<Candle[]>;

  /**
   * Immediately refresh all current quotes.
   */
  refreshQuotes: () => Promise<void>;

  /**
   * Whether a quote exists and is recent enough to be considered fresh.
   */
  isQuoteFresh: (
    symbol: string,
    maxAgeMs?: number
  ) => boolean;
}

const MarketContext = createContext<MarketContextType | undefined>(
  undefined
);

const QUOTE_REFRESH_INTERVAL_MS = 3000;
const DEFAULT_QUOTE_MAX_AGE_MS = 10_000;
const DEFAULT_CANDLE_COUNT = 60;

const isMarketQuote = (value: unknown): value is MarketQuote => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const quote = value as Partial<MarketQuote>;

  return (
    typeof quote.symbol === 'string' &&
    typeof quote.bid === 'number' &&
    typeof quote.ask === 'number' &&
    typeof quote.mid === 'number' &&
    typeof quote.spread === 'number' &&
    typeof quote.change24h === 'number' &&
    typeof quote.change24hPct === 'number' &&
    typeof quote.high24h === 'number' &&
    typeof quote.low24h === 'number' &&
    typeof quote.timestamp === 'number'
  );
};

const isMarketSymbol = (value: unknown): value is MarketSymbol => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const symbol = value as Partial<MarketSymbol>;

  return (
    typeof symbol.symbol === 'string' &&
    typeof symbol.name === 'string' &&
    typeof symbol.category === 'string' &&
    typeof symbol.baseCurrency === 'string' &&
    typeof symbol.quoteCurrency === 'string' &&
    typeof symbol.pipSize === 'number' &&
    typeof symbol.digits === 'number' &&
    typeof symbol.minSpread === 'number'
  );
};

const isCandle = (value: unknown): value is Candle => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candle = value as Partial<Candle>;

  return (
    typeof candle.time === 'number' &&
    typeof candle.open === 'number' &&
    typeof candle.high === 'number' &&
    typeof candle.low === 'number' &&
    typeof candle.close === 'number' &&
    typeof candle.volume === 'number'
  );
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
};

export const MarketProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [quotes, setQuotes] = useState<Record<string, MarketQuote>>({});
  const [symbols, setSymbols] = useState<MarketSymbol[]>([]);

  const [activeSymbol, setActiveSymbolState] =
    useState<string>('EUR/USD');

  const [loading, setLoading] = useState(true);

  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);

  /**
   * Prevent overlapping quote requests.
   *
   * Without this, a slow request can still be running when the next
   * 3-second interval fires.
   */
  const quotesRequestInFlight = useRef(false);

  /**
   * AbortController for the currently running quote request.
   */
  const quotesAbortController = useRef<AbortController | null>(null);

  /**
   * AbortController for symbol loading.
   */
  const symbolsAbortController = useRef<AbortController | null>(null);

  /**
   * Used to prevent state updates after unmount.
   */
  const mountedRef = useRef(true);

  const setActiveSymbol = useCallback((symbol: string) => {
    if (!symbol) {
      return;
    }

    setActiveSymbolState(symbol);
  }, []);

  /**
   * Load the available market universe.
   */
  const fetchSymbols = useCallback(async () => {
    symbolsAbortController.current?.abort();

    const controller = new AbortController();
    symbolsAbortController.current = controller;

    try {
      setSymbolsError(null);

      const response = await fetch('/api/markets/symbols', {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Market symbols request failed (${response.status})`
        );
      }

      const data: unknown = await response.json();

      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray((data as { symbols?: unknown }).symbols)
      ) {
        throw new Error('Invalid market symbols response.');
      }

      const rawSymbols = (data as { symbols: unknown[] }).symbols;

      const validSymbols = rawSymbols.filter(isMarketSymbol);

      if (validSymbols.length !== rawSymbols.length) {
        console.warn(
          'Some market symbols were rejected because their response shape was invalid.'
        );
      }

      if (mountedRef.current) {
        setSymbols(validSymbols);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      console.warn('Market symbols fetch error:', error);

      if (mountedRef.current) {
        setSymbolsError(
          getErrorMessage(
            error,
            'Unable to load market symbols.'
          )
        );
      }
    }
  }, []);

  /**
   * Fetch all current market quotes.
   *
   * Existing quotes are intentionally preserved if the request fails.
   * A temporary network/API failure should not make the UI suddenly
   * display an empty market.
   */
  const refreshQuotes = useCallback(async () => {
    if (quotesRequestInFlight.current) {
      return;
    }

    quotesRequestInFlight.current = true;

    quotesAbortController.current?.abort();

    const controller = new AbortController();
    quotesAbortController.current = controller;

    try {
      const response = await fetch('/api/markets/quotes', {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Market quotes request failed (${response.status})`
        );
      }

      const data: unknown = await response.json();

      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray((data as { quotes?: unknown }).quotes)
      ) {
        throw new Error('Invalid market quotes response.');
      }

      const rawQuotes = (data as { quotes: unknown[] }).quotes;

      const mapped: Record<string, MarketQuote> = {};

      for (const rawQuote of rawQuotes) {
        if (!isMarketQuote(rawQuote)) {
          continue;
        }

        /**
         * Reject impossible quote data.
         *
         * We don't want malformed backend data poisoning the UI.
         */
        if (
          !Number.isFinite(rawQuote.bid) ||
          !Number.isFinite(rawQuote.ask) ||
          !Number.isFinite(rawQuote.mid) ||
          rawQuote.bid <= 0 ||
          rawQuote.ask <= 0 ||
          rawQuote.mid <= 0
        ) {
          continue;
        }

        mapped[rawQuote.symbol] = rawQuote;
      }

      if (mountedRef.current) {
        /**
         * Only replace the cache with a successful response.
         * A failed request never clears existing good data.
         */
        setQuotes(mapped);
        setQuotesError(null);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      console.warn('Market quotes refresh error:', error);

      if (mountedRef.current) {
        setQuotesError(
          getErrorMessage(
            error,
            'Unable to refresh market quotes.'
          )
        );
      }
    } finally {
      quotesRequestInFlight.current = false;

      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  /**
   * Fetch historical candles.
   *
   * Unlike quote polling, candles are explicitly requested by consumers,
   * so we don't cache them globally here.
   */
  const fetchCandles = useCallback(
    async (
      symbol: string,
      timeframe: string,
      count: number = DEFAULT_CANDLE_COUNT
    ): Promise<Candle[]> => {
      if (!symbol) {
        throw new Error('Market symbol is required.');
      }

      if (!timeframe) {
        throw new Error('Timeframe is required.');
      }

      const safeCount = Math.min(
        Math.max(Math.floor(count), 1),
        1000
      );

      const params = new URLSearchParams({
        symbol,
        timeframe,
        count: String(safeCount),
      });

      try {
        const response = await fetch(
          `/api/markets/candles?${params.toString()}`,
          {
            headers: {
              Accept: 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(
            `Market candles request failed (${response.status})`
          );
        }

        const data: unknown = await response.json();

        if (
          !data ||
          typeof data !== 'object' ||
          !Array.isArray((data as { candles?: unknown }).candles)
        ) {
          throw new Error('Invalid market candles response.');
        }

        const rawCandles = (
          data as { candles: unknown[] }
        ).candles;

        return rawCandles.filter(isCandle);
      } catch (error) {
        console.error('Market candles fetch error:', error);

        /**
         * Candle failures are exceptional for the caller.
         * Returning [] hides the distinction between:
         *
         *   "there are no candles"
         *
         * and
         *
         *   "the API failed."
         */
        throw new Error(
          getErrorMessage(
            error,
            'Unable to load market candles.'
          )
        );
      }
    },
    []
  );

  /**
   * Determines whether a quote is sufficiently recent to be considered
   * fresh/live by the UI.
   *
   * This is intentionally based on the quote's server timestamp rather
   * than the time React received it.
   */
  const isQuoteFresh = useCallback(
    (
      symbol: string,
      maxAgeMs: number = DEFAULT_QUOTE_MAX_AGE_MS
    ): boolean => {
      const quote = quotes[symbol];

      if (!quote) {
        return false;
      }

      if (!Number.isFinite(quote.timestamp)) {
        return false;
      }

      const age = Date.now() - quote.timestamp;

      /**
       * A small amount of future clock skew is tolerated.
       */
      return age <= maxAgeMs && age >= -5_000;
    },
    [quotes]
  );

  /**
   * Initial market bootstrap + quote polling.
   */
  useEffect(() => {
    mountedRef.current = true;

    const bootstrap = async () => {
      await Promise.allSettled([
        fetchSymbols(),
        refreshQuotes(),
      ]);

      if (mountedRef.current) {
        setLoading(false);
      }
    };

    void bootstrap();

    const interval = window.setInterval(() => {
      void refreshQuotes();
    }, QUOTE_REFRESH_INTERVAL_MS);

    return () => {
      mountedRef.current = false;

      window.clearInterval(interval);

      symbolsAbortController.current?.abort();
      quotesAbortController.current?.abort();
    };
  }, [fetchSymbols, refreshQuotes]);

  const activeQuote = quotes[activeSymbol];

  /**
   * Memoising this prevents consumers from receiving a new context value
   * object every render when none of the market state has changed.
   */
  const contextValue = useMemo<MarketContextType>(
    () => ({
      quotes,
      symbols,
      activeSymbol,
      setActiveSymbol,
      activeQuote,
      loading,
      quotesError,
      symbolsError,
      fetchCandles,
      refreshQuotes,
      isQuoteFresh,
    }),
    [
      quotes,
      symbols,
      activeSymbol,
      setActiveSymbol,
      activeQuote,
      loading,
      quotesError,
      symbolsError,
      fetchCandles,
      refreshQuotes,
      isQuoteFresh,
    ]
  );

  return (
    <MarketContext.Provider value={contextValue}>
      {children}
    </MarketContext.Provider>
  );
};

export const useMarket = (): MarketContextType => {
  const context = useContext(MarketContext);

  if (!context) {
    throw new Error(
      'useMarket must be used within a MarketProvider'
    );
  }

  return context;
};
