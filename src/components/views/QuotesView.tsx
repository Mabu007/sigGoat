import React, { useEffect, useMemo, useState } from 'react';
import { useMarket } from '../../context/MarketContext';
import { Candle, MarketCategory } from '../../types';
import { TradingViewLightweightChart } from '../TradingViewLightweightChart';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Clock3,
  Highlighter,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

const SUPPORTED_TIMEFRAMES = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1D',
] as const;

type Timeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

type CategoryFilter = 'all' | MarketCategory;

export const QuotesView: React.FC = () => {
  const {
    quotes,
    symbols,
    activeSymbol,
    setActiveSymbol,
    activeQuote,
    fetchCandles,
    refreshQuotes,
  } = useMarket();

  const [categoryFilter, setCategoryFilter] =
    useState<CategoryFilter>('all');

  const [timeframe, setTimeframe] =
    useState<Timeframe>('5m');

  const [candles, setCandles] =
    useState<Candle[]>([]);

  const [loadingChart, setLoadingChart] =
    useState(false);

  /*
   * This is the navigation state.
   *
   * null = market overview / quote grid
   * symbol = market detail screen
   */
  const [detailSymbol, setDetailSymbol] =
    useState<string | null>(null);

  const detailQuote = detailSymbol
    ? quotes[detailSymbol]
    : null;

  const detailSymbolMeta = detailSymbol
    ? symbols.find(
        symbol => symbol.symbol === detailSymbol
      )
    : null;

  /* ---------------------------------------------------------------------- */
  /* Market overview                                                         */
  /* ---------------------------------------------------------------------- */

  const filteredSymbols = useMemo(
    () =>
      symbols.filter(symbol =>
        categoryFilter === 'all'
          ? true
          : symbol.category === categoryFilter
      ),
    [symbols, categoryFilter]
  );

  /* ---------------------------------------------------------------------- */
  /* Open market detail                                                      */
  /* ---------------------------------------------------------------------- */

  const openMarket = (symbol: string) => {
    setActiveSymbol(symbol);
    setDetailSymbol(symbol);
    setCandles([]);
  };

  /* ---------------------------------------------------------------------- */
  /* Back to market overview                                                 */
  /* ---------------------------------------------------------------------- */

  const closeMarket = () => {
    setDetailSymbol(null);
    setCandles([]);
  };

  /* ---------------------------------------------------------------------- */
  /* Chart data                                                              */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!detailSymbol) {
      return;
    }

    let cancelled = false;

    const loadCandles = async () => {
      setLoadingChart(true);

      try {
        const data = await fetchCandles(
          detailSymbol,
          timeframe,
          120
        );

        if (!cancelled) {
          setCandles(data);
        }
      } catch (error) {
        console.error(
          'Failed to load market chart:',
          error
        );

        if (!cancelled) {
          setCandles([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingChart(false);
        }
      }
    };

    void loadCandles();

    return () => {
      cancelled = true;
    };
  }, [
    detailSymbol,
    timeframe,
    fetchCandles,
  ]);

  /* ---------------------------------------------------------------------- */
  /* Detail screen                                                           */
  /* ---------------------------------------------------------------------- */

  if (detailSymbol && detailSymbolMeta) {
    const quote = detailQuote;

    const changePct =
      quote?.change24hPct ?? 0;

    const positive = changePct >= 0;

    return (
      <div className="pb-20">
        {/* ================================================================ */}
        {/* DETAIL HEADER                                                     */}
        {/* ================================================================ */}

        <div className="flex items-center justify-between mb-5">
          <button
            type="button"
            onClick={closeMarket}
            className="flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-slate-100 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Markets
          </button>

          <button
            type="button"
            onClick={() => void refreshQuotes()}
            className="w-9 h-9 rounded-xl bg-[#0c0f17] border border-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 hover:border-slate-700 transition-colors"
            title="Refresh market data"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* ================================================================ */}
        {/* MARKET IDENTITY                                                   */}
        {/* ================================================================ */}

        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wider font-bold text-amber-400">
              {detailSymbolMeta.category}
            </span>

            <span className="text-slate-700">
              /
            </span>

            <span className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-bold text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-100">
                {detailSymbol}
              </h1>

              <p className="text-xs text-slate-500 mt-1">
                {detailSymbolMeta.name}
              </p>
            </div>

            <div className="sm:text-right">
              <div className="text-2xl sm:text-3xl font-bold font-mono tracking-tight text-slate-100">
                {quote
                  ? quote.mid.toFixed(
                      detailSymbolMeta.digits
                    )
                  : '...'}
              </div>

              <div
                className={`flex items-center sm:justify-end gap-1 mt-1 text-xs font-mono font-bold ${
                  positive
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {positive ? (
                  <ArrowUp className="w-3 h-3" />
                ) : (
                  <ArrowDown className="w-3 h-3" />
                )}

                {positive ? '+' : ''}
                {changePct.toFixed(2)}%
                <span className="text-slate-600 font-normal ml-1">
                  24h
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/* QUOTE SNAPSHOT                                                    */}
        {/* ================================================================ */}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5">
          <MarketStat
            label="Bid"
            value={
              quote
                ? quote.bid.toFixed(
                    detailSymbolMeta.digits
                  )
                : '...'
            }
          />

          <MarketStat
            label="Ask"
            value={
              quote
                ? quote.ask.toFixed(
                    detailSymbolMeta.digits
                  )
                : '...'
            }
          />

          <MarketStat
            label="Spread"
            value={
              quote
                ? `${quote.spread}p`
                : `${detailSymbolMeta.minSpread}p`
            }
            accent
          />

          <MarketStat
            label="24h Range"
            value={
              quote
                ? `${quote.low24h.toFixed(
                    detailSymbolMeta.digits
                  )} – ${quote.high24h.toFixed(
                    detailSymbolMeta.digits
                  )}`
                : '...'
            }
          />
        </div>

        {/* ================================================================ */}
        {/* CHART                                                             */}
        {/* ================================================================ */}

        <section className="bg-[#0c0f17] border border-slate-800 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 p-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-slate-500" />

              <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                Price
              </span>
            </div>

            <div className="flex items-center gap-0.5 bg-slate-900 border border-slate-800 rounded-xl p-1 overflow-x-auto">
              {SUPPORTED_TIMEFRAMES.map(tf => (
                <button
                  key={tf}
                  type="button"
                  onClick={() =>
                    setTimeframe(tf)
                  }
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-mono font-semibold transition-colors ${
                    timeframe === tf
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-500 hover:text-slate-200'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          <div className="relative h-[380px] sm:h-[480px] bg-[#090c12]">
            {loadingChart && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
                <div className="flex items-center gap-2 text-xs text-amber-400 font-mono">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Loading {timeframe} data...
                </div>
              </div>
            )}

            <TradingViewLightweightChart
              candles={candles}
              activeQuote={quote || null}
              timeframe={timeframe}
              symbol={detailSymbol}
              digits={
                detailSymbolMeta.digits
              }
            />
          </div>
        </section>

        {/* ================================================================ */}
        {/* MARKET DATA                                                       */}
        {/* ================================================================ */}

        <section className="mt-5">
          <SectionTitle
            icon={
              <TrendingUp className="w-4 h-4" />
            }
            title="Market Data"
          />

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            <DataRow
              label="24h High"
              value={
                quote
                  ? quote.high24h.toFixed(
                      detailSymbolMeta.digits
                    )
                  : '...'
              }
            />

            <DataRow
              label="24h Low"
              value={
                quote
                  ? quote.low24h.toFixed(
                      detailSymbolMeta.digits
                    )
                  : '...'
              }
            />

            <DataRow
              label="24h Change"
              value={
                quote
                  ? `${positive ? '+' : ''}${quote.change24hPct.toFixed(
                      2
                    )}%`
                  : '...'
              }
              positive={positive}
            />

            <DataRow
              label="Bid"
              value={
                quote
                  ? quote.bid.toFixed(
                      detailSymbolMeta.digits
                    )
                  : '...'
              }
            />

            <DataRow
              label="Ask"
              value={
                quote
                  ? quote.ask.toFixed(
                      detailSymbolMeta.digits
                    )
                  : '...'
              }
            />

            <DataRow
              label="Spread"
              value={
                quote
                  ? `${quote.spread} pips`
                  : '...'
              }
            />
          </div>
        </section>

        {/* ================================================================ */}
        {/* INSTRUMENT INFORMATION                                             */}
        {/* ================================================================ */}

        <section className="mt-5">
          <SectionTitle
            icon={
              <Highlighter className="w-4 h-4" />
            }
            title="Instrument"
          />

          <div className="bg-[#0c0f17] border border-slate-800 rounded-2xl divide-y divide-slate-800">
            <InfoRow
              label="Market"
              value={detailSymbol}
            />

            <InfoRow
              label="Category"
              value={capitalize(
                detailSymbolMeta.category
              )}
            />

            <InfoRow
              label="Base Currency"
              value={
                detailSymbolMeta.baseCurrency ||
                '—'
              }
            />

            <InfoRow
              label="Quote Currency"
              value={
                detailSymbolMeta.quoteCurrency ||
                '—'
              }
            />

            <InfoRow
              label="Price Precision"
              value={`${detailSymbolMeta.digits} decimals`}
            />

            <InfoRow
              label="Pip Size"
              value={String(
                detailSymbolMeta.pipSize
              )}
            />
          </div>
        </section>

        {/* ================================================================ */}
        {/* LAST UPDATE                                                       */}
        {/* ================================================================ */}

        <div className="flex items-center justify-center gap-2 mt-5 text-[10px] text-slate-600">
          <Clock3 className="w-3 h-3" />

          {quote?.timestamp
            ? `Market data updated ${formatTimestamp(
                quote.timestamp
              )}`
            : 'Waiting for market data'}
        </div>

        {/* ================================================================ */}
        {/* RELATED MARKETS                                                   */}
        {/* ================================================================ */}

        <section className="mt-6">
          <SectionTitle
            icon={
              <TrendingDown className="w-4 h-4" />
            }
            title="More Markets"
          />

          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {symbols
              .filter(
                symbol =>
                  symbol.symbol !==
                    detailSymbol &&
                  symbol.category ===
                    detailSymbolMeta.category
              )
              .slice(0, 6)
              .map(symbol => {
                const relatedQuote =
                  quotes[symbol.symbol];

                const relatedChange =
                  relatedQuote?.change24hPct ?? 0;

                return (
                  <button
                    key={symbol.symbol}
                    type="button"
                    onClick={() =>
                      openMarket(
                        symbol.symbol
                      )
                    }
                    className="shrink-0 min-w-[145px] bg-[#0c0f17] border border-slate-800 hover:border-slate-700 rounded-xl p-3 text-left transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200">
                        {symbol.symbol}
                      </span>

                      <span
                        className={`text-[9px] font-mono font-bold ${
                          relatedChange >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {relatedChange >= 0
                          ? '+'
                          : ''}
                        {relatedChange.toFixed(
                          2
                        )}
                        %
                      </span>
                    </div>

                    <div className="text-sm font-mono font-semibold text-slate-300 mt-2">
                      {relatedQuote
                        ? relatedQuote.mid.toFixed(
                            symbol.digits
                          )
                        : '...'}
                    </div>
                  </button>
                );
              })}
          </div>
        </section>
      </div>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* QUOTE GRID                                                              */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="space-y-5 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-amber-400" />

            <h1 className="text-lg font-bold text-slate-100">
              Markets
            </h1>

            <span className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-bold text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          </div>

          <p className="text-xs text-slate-500 mt-1">
            Scan the market. Tap an instrument for details.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void refreshQuotes()}
          className="w-9 h-9 rounded-xl bg-[#0c0f17] border border-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 hover:border-slate-700 transition-colors"
          title="Refresh quotes"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Category filters */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
        {(
          [
            'all',
            'forex',
            'commodities',
            'indices',
          ] as const
        ).map(category => (
          <button
            key={category}
            type="button"
            onClick={() =>
              setCategoryFilter(category)
            }
            className={`shrink-0 px-3.5 py-2 rounded-xl text-[11px] font-semibold capitalize transition-all ${
              categoryFilter === category
                ? 'bg-amber-500 text-slate-950'
                : 'bg-[#0c0f17] border border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {category}
          </button>
        ))}
      </div>

      {/* Quote cards */}
      <section>
        <div className="flex items-center justify-between px-1 mb-3">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Live Quotes
            </span>

            <span className="ml-2 text-[10px] text-slate-700 font-mono">
              {filteredSymbols.length}
            </span>
          </div>

          <span className="text-[10px] text-slate-600">
            Tap to inspect
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {filteredSymbols.map(symbol => {
            const quote =
              quotes[symbol.symbol];

            const change =
              quote?.change24hPct ?? 0;

            const positive = change >= 0;

            return (
              <button
                key={symbol.symbol}
                type="button"
                onClick={() =>
                  openMarket(symbol.symbol)
                }
                className="group relative text-left rounded-2xl border border-slate-800 bg-[#0c0f17] hover:bg-[#0e121b] hover:border-slate-700 p-4 transition-all duration-150"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-slate-100">
                      {symbol.symbol}
                    </div>

                    <div className="text-[10px] text-slate-600 mt-0.5">
                      {symbol.name}
                    </div>
                  </div>

                  <div
                    className={`flex items-center gap-0.5 text-[11px] font-mono font-bold ${
                      positive
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                    }`}
                  >
                    {positive ? (
                      <ArrowUp className="w-3 h-3" />
                    ) : (
                      <ArrowDown className="w-3 h-3" />
                    )}

                    {positive ? '+' : ''}
                    {change.toFixed(2)}%
                  </div>
                </div>

                <div className="mt-4">
                  <div className="text-xl font-bold font-mono tracking-tight text-slate-100">
                    {quote
                      ? quote.mid.toFixed(
                          symbol.digits
                        )
                      : '...'}
                  </div>
                </div>

                <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-800/70">
                  <span className="text-[9px] uppercase tracking-wider text-slate-600">
                    {symbol.category}
                  </span>

                  <span className="text-[10px] font-mono text-slate-500">
                    {quote
                      ? `Spread ${quote.spread}p`
                      : `Spread ${symbol.minSpread}p`}
                  </span>
                </div>

                <div className="absolute right-3 bottom-3 text-[9px] text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  View →
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};

/* ========================================================================== */
/* Small UI Components                                                        */
/* ========================================================================== */

interface MarketStatProps {
  label: string;
  value: string;
  accent?: boolean;
}

const MarketStat: React.FC<MarketStatProps> = ({
  label,
  value,
  accent = false,
}) => (
  <div className="bg-[#0c0f17] border border-slate-800 rounded-xl p-3">
    <div className="text-[9px] uppercase tracking-wider text-slate-600">
      {label}
    </div>

    <div
      className={`text-xs sm:text-sm font-mono font-semibold mt-1 truncate ${
        accent
          ? 'text-amber-400'
          : 'text-slate-200'
      }`}
    >
      {value}
    </div>
  </div>
);

interface DataRowProps {
  label: string;
  value: string;
  positive?: boolean;
}

const DataRow: React.FC<DataRowProps> = ({
  label,
  value,
  positive,
}) => (
  <div className="bg-[#0c0f17] border border-slate-800 rounded-xl p-3">
    <div className="text-[9px] uppercase tracking-wider text-slate-600">
      {label}
    </div>

    <div
      className={`text-sm font-mono font-semibold mt-1 ${
        positive === true
          ? 'text-emerald-400'
          : positive === false
            ? 'text-rose-400'
            : 'text-slate-200'
      }`}
    >
      {value}
    </div>
  </div>
);

interface InfoRowProps {
  label: string;
  value: string;
}

const InfoRow: React.FC<InfoRowProps> = ({
  label,
  value,
}) => (
  <div className="flex items-center justify-between gap-4 px-4 py-3">
    <span className="text-xs text-slate-500">
      {label}
    </span>

    <span className="text-xs font-mono font-medium text-slate-200 text-right">
      {value}
    </span>
  </div>
);

interface SectionTitleProps {
  icon: React.ReactNode;
  title: string;
}

const SectionTitle: React.FC<
  SectionTitleProps
> = ({ icon, title }) => (
  <div className="flex items-center gap-2 px-1 mb-3">
    <span className="text-slate-500">
      {icon}
    </span>

    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
      {title}
    </span>
  </div>
);

/* ========================================================================== */
/* Utilities                                                                  */
/* ========================================================================== */

function capitalize(value: string): string {
  if (!value) return value;

  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}

function formatTimestamp(
  timestamp: number
): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return 'recently';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}