/**
 * MARKETS
 * =======
 * Browse, filter and search every instrument the provider actually lists.
 *
 * WHAT THIS SCREEN REFUSES TO SHOW
 *   Anything Hyperliquid does not publish. There is no 24h high/low column
 *   (the provider has no such endpoint), no spread where the book is empty,
 *   and no change where `prevDayPx` is absent. Those cells render as "—"
 *   rather than 0.00.
 *
 * THE FOUR CATEGORIES ARE VENUE-BACKED, NOT ASSUMED
 *   Currencies, Commodities, Indices and Crypto all exist on Hyperliquid —
 *   but the first three are populated by a specific HIP-3 deployer market
 *   (`xyz`), not by the default perp dex. The category list is rendered from
 *   what discovery actually returned, so a category with no instruments is
 *   not offered.
 *
 * SEARCH REACHES BEYOND THE DEFAULT UNIVERSE
 *   The Markets list shows the tracked majors. Search queries the provider's
 *   full discovered universe, so a listed-but-untracked instrument (an
 *   equity, a thin commodity) is reachable without adding it to the permanent
 *   polling set.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CandlestickChart,
  CircleSlash,
  Loader2,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { useMarket } from '../../context/MarketContext';
import { TradingViewLightweightChart } from '../TradingViewLightweightChart';
import type { MarketCategory } from '../../types';

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

interface DiscoveredMarket {
  symbol: string;
  name: string;
  category: string;
  deployment: 'native' | 'hip3';
  dex: string;
  tracked: boolean;
  delisted: boolean;
}

/** The four product categories, in display order. */
const CATEGORY_LABELS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'currencies', label: 'Currencies' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'indices', label: 'Indices' },
];

const UI_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** A value the provider did not return. Never a zero. */
function Missing({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-fg-subtle" title={reason}>
      <CircleSlash size={10} aria-hidden="true" />
      <span className="sr-only">Not available: {reason}</span>
      <span aria-hidden="true">—</span>
    </span>
  );
}

function formatPrice(value: number | undefined, digits: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(digits, 4),
    maximumFractionDigits: Math.max(digits, 2),
  });
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function QuotesView() {
  const { symbols, quotes, loading, quotesError, fetchCandles, refreshQuotes } = useMarket();

  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DiscoveredMarket[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [detailSymbol, setDetailSymbol] = useState<string | null>(null);

  /* ---- Provider discovery ---- */

  const [discovered, setDiscovered] = useState<DiscoveredMarket[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const loadDiscovery = useCallback(async () => {
    try {
      const response = await fetch('/api/markets/search', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('search unavailable');
      const body = await response.json();
      setDiscovered(Array.isArray(body.markets) ? body.markets : []);
      setDiscoveryError(null);
    } catch {
      // The tracked list below still works; only the full search is degraded.
      setDiscoveryError('Full instrument search is unavailable right now.');
    }
  }, []);

  useEffect(() => {
    void loadDiscovery();
  }, [loadDiscovery]);

  /* ---- Debounced server-side search ---- */

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/markets/search?q=${encodeURIComponent(trimmed)}`,
          { headers: { Accept: 'application/json' } },
        );
        const body = response.ok ? await response.json() : null;
        if (!cancelled) setSearchResults(Array.isArray(body?.markets) ? body.markets : []);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  /* ---- Filtering ---- */

  const metaBySymbol = useMemo(() => {
    const map = new Map<string, DiscoveredMarket>();
    for (const market of discovered) map.set(market.symbol, market);
    return map;
  }, [discovered]);

  const list = useMemo(() => {
    // Search results take over entirely when the user is typing, so a search
    // never silently narrows to the tracked universe.
    const base = searchResults ?? discovered.filter((m) => !m.delisted);
    const filtered = category === 'all' ? base : base.filter((m) => m.category === category);
    // Majors first, then alphabetically.
    return [...filtered].sort((a, b) => {
      if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [discovered, searchResults, category]);

  const availableCategories = useMemo(() => {
    const present = new Set(discovered.filter((m) => !m.delisted).map((m) => m.category));
    return CATEGORY_LABELS.filter((c) => c.id === 'all' || present.has(c.id));
  }, [discovered]);

  /* ---- Detail ---- */

  if (detailSymbol) {
    return (
      <MarketDetail
        symbol={detailSymbol}
        meta={metaBySymbol.get(detailSymbol)}
        quotes={quotes}
        fetchCandles={fetchCandles}
        onBack={() => setDetailSymbol(null)}
        onRefresh={refreshQuotes}
      />
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Markets</h1>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            Live instruments from Hyperliquid. {list.length} shown.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void refreshQuotes();
            void loadDiscovery();
          }}
          className="btn btn-secondary"
        >
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
      </header>

      {/* Search */}
      <div className="relative">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search all instruments — try GOLD, EUR, NIFTY, BTC…"
          aria-label="Search instruments"
          className="input !pl-9 !pr-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle hover:text-fg"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-1.5">
        {availableCategories.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setCategory(item.id)}
            aria-pressed={category === item.id}
            className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
              category === item.id
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg'
            }`}
          >
            {item.label}
          </button>
        ))}
        {searching && <Loader2 size={13} className="ml-1 animate-spin self-center text-fg-subtle" aria-hidden="true" />}
      </div>

      {(quotesError || discoveryError) && (
        <div className="panel border-warning/40 p-3 text-[12px] text-fg-muted">
          {quotesError ?? discoveryError}
        </div>
      )}

      {/* List */}
      {list.length === 0 ? (
        <div className="panel p-8 text-center">
          <CandlestickChart size={20} className="mx-auto text-fg-subtle" aria-hidden="true" />
          <p className="mt-2 text-[13px] font-medium text-fg">
            {query ? 'No instruments match that search' : 'No instruments available'}
          </p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-fg-muted">
            {query
              ? 'FundAGoat only lists instruments Hyperliquid actually offers. Try a different ticker.'
              : 'The market list could not be loaded. Refresh to try again.'}
          </p>
        </div>
      ) : (
        <div className="panel divide-y divide-line overflow-hidden">
          {list.map((market) => {
            const quote = quotes[market.symbol];
            const digits = symbols.find((s) => s.symbol === market.symbol)?.digits ?? 2;
            const up = quote?.change24hProvided !== false && (quote?.change24h ?? 0) > 0;
            const down = quote?.change24hProvided !== false && (quote?.change24h ?? 0) < 0;
            const live = quote !== undefined && quote.mid > 0;

            return (
              <button
                key={market.symbol}
                type="button"
                onClick={() => setDetailSymbol(market.symbol)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-[13px] font-medium text-fg">
                    <span className="font-mono">{market.symbol}</span>
                    <span className="truncate text-[11px] font-normal text-fg-subtle">{market.name}</span>
                    {market.deployment === 'hip3' && (
                      <span className="badge badge-info shrink-0" title={`Deployed on the ${market.dex} perp dex`}>
                        HIP-3
                      </span>
                    )}
                  </p>
                </div>

                <p className="w-28 shrink-0 text-right font-mono text-[13px] font-medium text-fg">
                  {live ? formatPrice(quote.mid, digits) : <Missing reason="No live price for this market" />}
                </p>

                <p
                  className={`flex w-24 shrink-0 items-center justify-end gap-1 font-mono text-[12px] ${
                    up ? 'text-positive' : down ? 'text-negative' : 'text-fg-subtle'
                  }`}
                >
                  {up ? <TrendingUp size={12} aria-hidden="true" /> : down ? <TrendingDown size={12} aria-hidden="true" /> : null}
                  {quote && quote.change24hProvided !== false ? `${quote.change24hPct.toFixed(2)}%` : <Missing reason="No 24h reference price" />}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function MarketDetail({
  symbol,
  meta,
  quotes,
  fetchCandles,
  onBack,
  onRefresh,
}: {
  symbol: string;
  meta?: DiscoveredMarket;
  quotes: Record<string, any>;
  fetchCandles: (symbol: string, timeframe: string, count?: number) => Promise<any[]>;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const quote = quotes[symbol];
  const [timeframe, setTimeframe] = useState<string>('5m');
  const [candles, setCandles] = useState<any[] | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [loadingChart, setLoadingChart] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingChart(true);
    setChartError(null);
    fetchCandles(symbol, timeframe, 120)
      .then((data) => {
        if (!cancelled) setCandles(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCandles([]);
          setChartError(error instanceof Error ? error.message : 'Could not load candles.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingChart(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, fetchCandles]);

  const digits = 4;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="btn btn-ghost !px-2" aria-label="Back to markets">
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-lg font-semibold tracking-tight text-fg">{symbol}</h1>
          {meta && (
            <p className="text-[12px] text-fg-muted">
              {meta.name} · {meta.deployment === 'hip3' ? `${meta.dex} (HIP-3)` : 'Hyperliquid perp'}
            </p>
          )}
        </div>
        <button type="button" onClick={onRefresh} className="btn btn-secondary" aria-label="Refresh quote">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>

      {/* Quote */}
      <div className="flex flex-wrap items-baseline gap-4">
        <p className="font-mono text-3xl font-semibold tracking-tight text-fg">
          {quote && quote.mid > 0 ? formatPrice(quote.mid, digits) : <Missing reason="No live price" />}
        </p>
        {quote && quote.change24hProvided !== false && (
          <p className={`font-mono text-sm ${quote.change24h >= 0 ? 'text-positive' : 'text-negative'}`}>
            {quote.change24h >= 0 ? '+' : ''}
            {quote.change24h.toFixed(2)} ({quote.change24hPct.toFixed(2)}%)
          </p>
        )}
      </div>

      {/* Stats — only what the provider publishes */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat
          label="Bid"
          value={quote?.bidProvided ? formatPrice(quote.bid, digits) : null}
          missing="The order book is empty, or this market has no two-sided quote"
        />
        <Stat
          label="Ask"
          value={quote?.askProvided ? formatPrice(quote.ask, digits) : null}
          missing="The order book is empty, or this market has no two-sided quote"
        />
        <Stat
          label="24h volume"
          value={quote?.volume24h ? `$${quote.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : null}
          missing="Hyperliquid did not report 24h volume for this market"
        />
        <Stat
          label="24h range"
          value={null}
          missing="Hyperliquid publishes no 24h high/low endpoint. Use the chart instead."
        />
      </div>

      {/* Chart */}
      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="flex gap-1">
            {UI_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setTimeframe(tf)}
                aria-pressed={timeframe === tf}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  timeframe === tf ? 'bg-accent-soft text-accent-text' : 'text-fg-subtle hover:text-fg'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="relative h-[340px] bg-sunken">
          {loadingChart && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/60">
              <Loader2 size={18} className="animate-spin text-fg-subtle" aria-hidden="true" />
            </div>
          )}
          {!loadingChart && (candles?.length ?? 0) === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
              <CircleSlash size={18} className="text-fg-subtle" aria-hidden="true" />
              <p className="text-[13px] font-medium text-fg">No candle history</p>
              <p className="max-w-sm text-[12px] text-fg-muted">
                {chartError ??
                  'Hyperliquid has no candles for this market and timeframe. It may be newly listed or thinly traded.'}
              </p>
            </div>
          ) : (
            <TradingViewLightweightChart
              candles={candles ?? []}
              activeQuote={quote}
              timeframe={timeframe}
              symbol={symbol}
              digits={digits}
            />
          )}
        </div>
      </div>

      {/* Instrument facts */}
      <div className="panel divide-y divide-line">
        <Row label="Symbol" value={symbol} mono />
        {meta && <Row label="Category" value={meta.category} />}
        {meta && <Row label="Deployment" value={meta.deployment === 'hip3' ? `HIP-3 · ${meta.dex}` : 'Native perp'} />}
        {quote?.maxLeverage !== undefined && quote?.maxLeverage !== null && (
          <Row label="Max leverage" value={`${quote.maxLeverage}×`} mono />
        )}
        {quote?.fundingRate !== undefined && quote?.fundingRate !== null && (
          <Row label="Funding rate" value={`${(quote.fundingRate * 100).toFixed(4)}%`} mono />
        )}
        <Row label="Source" value="Hyperliquid" />
      </div>
    </div>
  );
}

function Stat({ label, value, missing }: { label: string; value: string | null; missing: string }) {
  return (
    <div className="stat" title={value === null ? missing : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value === null ? <Missing reason={missing} /> : value}</div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-[12px] text-fg-muted">{label}</span>
      <span className={`text-[12px] font-medium text-fg ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}