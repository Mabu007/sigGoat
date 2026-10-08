import React, { useState } from 'react';
import { useGoat } from '../../context/GoatContext';
import { useAuth } from '../../context/AuthContext';
import { useMarket } from '../../context/MarketContext';
import { BacktestResult, BacktestTrade } from '../../types';
import {
  History,
  Play,
  RefreshCw,
  Target,
  ChevronRight,
  X,
  TrendingUp,
  TrendingDown,
  Activity,
  ShieldCheck,
  AlertTriangle,
  Clock,
} from 'lucide-react';

export const BacktestView: React.FC = () => {
  const { goats, activeGoat } = useGoat();
  const { getApiAuthHeaders } = useAuth();
  const { symbols } = useMarket();

  const [selectedGoatId, setSelectedGoatId] = useState<string>(
    activeGoat?.id || goats[0]?.id || ''
  );
  const [selectedMarket, setSelectedMarket] = useState<string>('EUR/USD');
  const [selectedPeriod, setSelectedPeriod] =
    useState<'24h' | '7d' | '30d' | '90d'>('7d');
  const [startingBalance, setStartingBalance] = useState<number>(10000);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [inspectedTrade, setInspectedTrade] =
    useState<BacktestTrade | null>(null);

  const currentGoat =
    goats.find(g => g.id === selectedGoatId) || goats[0];

  const handleRunBacktest = async () => {
    if (!currentGoat) return;

    setIsRunning(true);
    setErrorMsg('');

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getApiAuthHeaders()) },
        body: JSON.stringify({
          goatId: currentGoat.id,
          market: selectedMarket,
          period: selectedPeriod,
          startingBalance,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || 'BACKTEST_FAILED');
      }

      const data = await res.json();
      setResult(data.result);
    } catch (err) {
      setErrorMsg(
        err instanceof Error && err.message !== 'BACKTEST_FAILED'
          ? `Backtest failed: ${err.message}`
          : 'We could not complete this backtest. Please check your selection and try again.'
      );
    } finally {
      setIsRunning(false);
    }
  };

  const equityPoints = result?.equityCurve || [];

  const minEquity = equityPoints.length
    ? Math.min(...equityPoints.map(p => p.equity))
    : startingBalance * 0.9;

  const maxEquity = equityPoints.length
    ? Math.max(...equityPoints.map(p => p.equity))
    : startingBalance * 1.1;

  const equityRange = maxEquity - minEquity || 100;
  const chartHeight = 180;
  const chartWidth = 600;

  const getEquityY = (value: number) =>
    chartHeight -
    ((value - minEquity) / equityRange) * (chartHeight - 30) -
    15;

  const formatMoney = (value: number) =>
    `$${Math.abs(value).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;

  return (
    <div className="space-y-6 pb-20">
      {/* HEADER */}
      <div>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <History className="w-4 h-4 text-amber-400" />
          </div>

          <div>
            <h1 className="text-lg font-bold text-slate-100">
              Backtest your GOAT
            </h1>

            <p className="text-xs text-slate-400 mt-0.5">
              Replay your GOAT's signals against historical market conditions.
            </p>
          </div>
        </div>
      </div>

      {/* CONFIGURATION */}
      <section className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Backtest setup
          </h2>

          <p className="text-[11px] text-slate-500 mt-1">
            Choose a GOAT, market, period and starting balance.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* GOAT */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">
              GOAT
            </label>

            <select
              value={selectedGoatId}
              onChange={e => setSelectedGoatId(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500/50"
            >
              {goats.length === 0 && (
                <option value="">No GOATs available</option>
              )}

              {goats.map(goat => (
                <option key={goat.id} value={goat.id}>
                  {goat.name}
                </option>
              ))}
            </select>
          </div>

          {/* MARKET */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">
              Market
            </label>

            <select
              value={selectedMarket}
              onChange={e => setSelectedMarket(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500/50"
            >
              {symbols.map(symbol => (
                <option key={symbol.symbol} value={symbol.symbol}>
                  {symbol.symbol} — {symbol.name}
                </option>
              ))}
            </select>
          </div>

          {/* PERIOD */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">
              Historical period
            </label>

            <div className="grid grid-cols-4 gap-1 bg-slate-900 border border-slate-800 p-1 rounded-xl">
              {(['24h', '7d', '30d', '90d'] as const).map(period => (
                <button
                  key={period}
                  type="button"
                  onClick={() => setSelectedPeriod(period)}
                  className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                    selectedPeriod === period
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {period}
                </button>
              ))}
            </div>
          </div>

          {/* BALANCE */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">
              Starting balance
            </label>

            <input
              type="number"
              min="1"
              value={startingBalance}
              onChange={e =>
                setStartingBalance(Number(e.target.value) || 10000)
              }
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-200 font-mono focus:outline-none focus:border-amber-500/50"
            />
          </div>
        </div>

        {errorMsg && (
          <div className="mt-4 flex items-start gap-2 text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-xl">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <button
            onClick={handleRunBacktest}
            disabled={isRunning || !currentGoat}
            className="w-full sm:w-auto flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-bold text-sm py-2.5 px-6 rounded-xl transition-colors shadow-md"
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Running backtest…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                Run Backtest
              </>
            )}
          </button>

          <span className="text-[10px] text-slate-500">
            Historical replay uses only information available at each point in time.
          </span>
        </div>
      </section>

      {/* EMPTY STATE */}
      {!result && !isRunning && (
        <section className="bg-slate-900/40 border border-slate-800 rounded-2xl p-8 sm:p-12 text-center">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Activity className="w-5 h-5 text-amber-400" />
          </div>

          <h2 className="text-sm font-bold text-slate-200 mt-4">
            See how your GOAT would have performed
          </h2>

          <p className="text-xs text-slate-500 max-w-md mx-auto mt-1.5">
            Run a historical replay to see the signals your GOAT generated,
            which setups filled, and how the strategy performed over time.
          </p>
        </section>
      )}

      {/* RESULTS */}
      {result && (
        <div className="space-y-5">
          {/* RESULT HEADER */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-amber-400 flex items-center gap-2">
                Backtest results
                {result.dataSource === 'PAPER' && (
                  <span className="text-[10px] font-mono normal-case px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                    PAPER DATA · simulated feed
                  </span>
                )}
              </p>

              <h2 className="text-base font-bold text-slate-100 mt-1">
                {currentGoat?.name || 'GOAT'} · {selectedMarket}
              </h2>

              <p className="text-[11px] text-slate-500 mt-0.5">
                {selectedPeriod} historical replay · Starting balance{' '}
                {formatMoney(startingBalance)}
              </p>
            </div>
          </div>

          {/* PRIMARY METRICS */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard
              label="Signals"
              value={String(result.totalSignals)}
              icon={<Activity className="w-3.5 h-3.5" />}
            />

            <MetricCard
              label="Filled"
              value={String(result.filledSignals)}
              icon={<Target className="w-3.5 h-3.5" />}
            />

            <MetricCard
              label="Win Rate"
              value={`${result.winRate}%`}
              valueClass="text-emerald-400"
            />

            <MetricCard
              label="Net P/L"
              value={`${result.netDollarPnl >= 0 ? '+' : '-'}${formatMoney(
                result.netDollarPnl
              )}`}
              valueClass={
                result.netDollarPnl >= 0
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }
            />

            <MetricCard
              label="Profit Factor"
              value={String(result.profitFactor)}
              valueClass="text-amber-300"
            />

            <MetricCard
              label="Max Drawdown"
              value={`-${result.maxDrawdown}%`}
              valueClass="text-rose-400"
            />
          </div>

          {/* SIGNAL RESULTS */}
          <section className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-200">
                  Signal results
                </h3>

                <p className="text-[10px] text-slate-500 mt-0.5">
                  What happened to the setups your GOAT identified.
                </p>
              </div>

              <span className="text-[10px] font-mono text-slate-500 whitespace-nowrap">
                {result.totalSignals} found
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
              <ResultStat
                label="Filled"
                value={result.filledSignals}
                description="Entry price was reached"
                icon={<Target className="w-3.5 h-3.5" />}
              />

              <ResultStat
                label="Invalidated"
                value={result.invalidatedSignals}
                description="Setup failed before entry"
                icon={<ShieldCheck className="w-3.5 h-3.5" />}
              />

              <ResultStat
                label="Expired"
                value={result.expiredSignals}
                description="Entry was never reached"
                icon={<Clock className="w-3.5 h-3.5" />}
              />

              <ResultStat
                label="Avg Win / Loss"
                value={`${formatMoney(result.averageWin)} / -${formatMoney(
                  result.averageLoss
                )}`}
                description="Per filled setup"
                compact
              />
            </div>
          </section>

          {/* EQUITY CURVE */}
          <section className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-200">
                  Equity curve
                </h3>

                <p className="text-[10px] text-slate-500 mt-0.5">
                  Simulated balance over the backtest period.
                </p>
              </div>

              <div className="text-xs font-mono font-bold text-amber-400">
                Final:{' '}
                {formatMoney(
                  equityPoints[equityPoints.length - 1]?.equity ??
                    startingBalance
                )}
              </div>
            </div>

            <div className="w-full h-[180px] bg-slate-950/70 rounded-xl border border-slate-800/80 p-2 overflow-hidden">
              <svg
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                className="w-full h-full"
                preserveAspectRatio="none"
                role="img"
                aria-label="Backtest equity curve"
              >
                <line
                  x1="0"
                  y1={getEquityY(startingBalance)}
                  x2={chartWidth}
                  y2={getEquityY(startingBalance)}
                  stroke="#334155"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />

                {equityPoints.length > 0 && (
                  <polyline
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={equityPoints
                      .map((point, index) => {
                        const x =
                          (index /
                            Math.max(equityPoints.length - 1, 1)) *
                            (chartWidth - 20) +
                          10;

                        const y = getEquityY(point.equity);

                        return `${x},${y}`;
                      })
                      .join(' ')}
                  />
                )}
              </svg>
            </div>

            <div className="flex justify-between text-[9px] text-slate-600 font-mono mt-1">
              <span>Start</span>
              <span>Time</span>
              <span>End</span>
            </div>
          </section>

          {/* TRADE HISTORY */}
          <section className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 border-b border-slate-800/80 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-200">
                  Signal history
                </h3>

                <p className="text-[10px] text-slate-500 mt-0.5">
                  Select a signal to inspect the setup and outcome.
                </p>
              </div>

              <span className="text-[10px] text-slate-500">
                {result.trades.length} records
              </span>
            </div>

            <div className="space-y-2 mt-3">
              {result.trades.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500">
                  No signals were generated during this period.
                </div>
              ) : (
                result.trades.map(trade => (
                  <button
                    key={trade.id}
                    type="button"
                    onClick={() => setInspectedTrade(trade)}
                    className="w-full text-left flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800 hover:border-amber-500/40 transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <SignalTypeBadge
                          orderType={trade.orderType}
                          direction={trade.direction}
                        />

                        <span className="text-[10px] font-mono text-slate-500">
                          R:R 1:{trade.riskReward}
                        </span>
                      </div>

                      <div className="text-xs font-mono text-slate-300 mt-1.5">
                        Entry{' '}
                        <strong className="text-slate-100">
                          {trade.plannedEntry}
                        </strong>
                        <span className="text-slate-600 mx-1.5">·</span>
                        SL{' '}
                        <span className="text-rose-400">
                          {trade.stopLoss}
                        </span>
                        <span className="text-slate-600 mx-1.5">·</span>
                        TP{' '}
                        <span className="text-emerald-400">
                          {trade.takeProfit}
                        </span>
                      </div>

                      <p className="text-[10px] text-slate-500 mt-1 line-clamp-1">
                        {trade.thesis}
                      </p>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0">
                      <OutcomeBadge
                        outcome={trade.outcome}
                        pnlPips={trade.pnlPips}
                      />

                      <ChevronRight className="w-4 h-4 text-slate-600" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* METHODOLOGY */}
          <details className="bg-slate-900/30 border border-slate-800 rounded-2xl">
            <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold text-slate-300">
              How this backtest works
            </summary>

            <div className="px-4 pb-4 text-[11px] leading-relaxed text-slate-500 space-y-2">
              <p>
                The replay advances through historical market data in
                chronological order. At each point, your GOAT only receives
                information that would have been available at that time.
              </p>

              <p>
                Conditional signals are tracked from creation through entry,
                invalidation, expiration, take profit or stop loss.
              </p>

              <p>
                When historical candle data cannot determine whether a target
                or stop was reached first inside the same candle, the
                backtest applies the configured conservative ambiguity policy.
              </p>
            </div>
          </details>
        </div>
      )}

      {/* SIGNAL DETAILS */}
      {inspectedTrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
          onClick={e => {
            if (e.target === e.currentTarget) {
              setInspectedTrade(null);
            }
          }}
        >
          <div className="bg-[#0c0f17] border border-slate-800 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-5">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <Target className="w-4 h-4 text-amber-400" />

                  <h3 className="text-sm font-bold text-slate-100">
                    Signal details
                  </h3>
                </div>

                <p className="text-[10px] text-slate-500 mt-1">
                  Historical replay at the moment this signal was generated.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setInspectedTrade(null)}
                className="text-slate-500 hover:text-slate-200 p-1 rounded-lg"
                aria-label="Close signal details"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 mt-4">
              {/* SIGNAL TYPE */}
              <div className="flex items-center justify-between gap-3">
                <SignalTypeBadge
                  orderType={inspectedTrade.orderType}
                  direction={inspectedTrade.direction}
                />

                <OutcomeBadge
                  outcome={inspectedTrade.outcome}
                  pnlPips={inspectedTrade.pnlPips}
                />
              </div>

              {/* THESIS */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
                  GOAT thesis
                </span>

                <p className="text-sm text-slate-200 font-medium mt-1 leading-relaxed">
                  {inspectedTrade.thesis}
                </p>
              </div>

              {/* PRICE PLAN */}
              <div className="grid grid-cols-3 gap-2">
                <DetailValue
                  label="Entry"
                  value={inspectedTrade.plannedEntry}
                />

                <DetailValue
                  label="Invalidation"
                  value={inspectedTrade.stopLoss}
                  valueClass="text-rose-400"
                />

                <DetailValue
                  label="Target"
                  value={inspectedTrade.takeProfit}
                  valueClass="text-emerald-400"
                />
              </div>

              {/* RISK */}
              <div className="grid grid-cols-2 gap-2">
                <DetailValue
                  label="Risk / reward"
                  value={`1:${inspectedTrade.riskReward}`}
                />

                <DetailValue
                  label="Outcome"
                  value={
                    inspectedTrade.pnlPips !== 0
                      ? `${inspectedTrade.pnlPips} pips`
                      : 'No P/L impact'
                  }
                />
              </div>

              {/* EXECUTION PATH */}
              {inspectedTrade.executionPath &&
                inspectedTrade.executionPath.length > 0 && (
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1.5">
                      What happened
                    </span>

                    <div className="space-y-1.5 bg-slate-900/70 p-3 rounded-xl border border-slate-800">
                      {inspectedTrade.executionPath.map((step, index) => (
                        <div
                          key={index}
                          className="flex items-start gap-2 text-[11px] text-slate-300"
                        >
                          <span className="text-amber-400 mt-0.5">•</span>
                          <span>{step}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>

            <div className="pt-4 mt-4 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setInspectedTrade(null)}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-semibold rounded-xl transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* PRESENTATIONAL COMPONENTS                                                   */
/* -------------------------------------------------------------------------- */

interface MetricCardProps {
  label: string;
  value: string;
  valueClass?: string;
  icon?: React.ReactNode;
}

const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  valueClass = 'text-slate-100',
  icon,
}) => (
  <div className="bg-[#0c0f17] border border-slate-800 rounded-2xl p-3.5">
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
      {icon}
      {label}
    </div>

    <div className={`text-xl font-bold font-mono mt-1.5 ${valueClass}`}>
      {value}
    </div>
  </div>
);

interface ResultStatProps {
  label: string;
  value: number | string;
  description: string;
  icon?: React.ReactNode;
  compact?: boolean;
}

const ResultStat: React.FC<ResultStatProps> = ({
  label,
  value,
  description,
  icon,
  compact,
}) => (
  <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800">
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-slate-500">
      {icon}
      {label}
    </div>

    <div
      className={`font-bold font-mono mt-1 ${
        compact ? 'text-sm text-slate-200' : 'text-base text-slate-100'
      }`}
    >
      {value}
    </div>

    <p className="text-[10px] text-slate-500 mt-0.5">
      {description}
    </p>
  </div>
);

interface SignalTypeBadgeProps {
  orderType: string;
  direction?: string;
}

const SignalTypeBadge: React.FC<SignalTypeBadgeProps> = ({
  orderType,
  direction,
}) => {
  const isLong = direction === 'LONG';

  return (
    <span
      className={`inline-flex items-center gap-1 font-bold font-mono text-[10px] px-2 py-1 rounded-lg border ${
        isLong
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
          : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
      }`}
    >
      {isLong ? (
        <TrendingUp className="w-3 h-3" />
      ) : (
        <TrendingDown className="w-3 h-3" />
      )}

      {orderType}
    </span>
  );
};

interface OutcomeBadgeProps {
  outcome: BacktestTrade['outcome'];
  pnlPips: number;
}

const OutcomeBadge: React.FC<OutcomeBadgeProps> = ({
  outcome,
  pnlPips,
}) => {
  if (outcome === 'WIN') {
    return (
      <span className="font-mono font-bold text-[10px] px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-400">
        WIN · +{pnlPips}p
      </span>
    );
  }

  if (outcome === 'LOSS') {
    return (
      <span className="font-mono font-bold text-[10px] px-2 py-1 rounded-lg bg-rose-500/10 text-rose-400">
        LOSS · {pnlPips}p
      </span>
    );
  }

  if (outcome === 'INVALIDATED_BEFORE_FILL') {
    return (
      <span className="font-mono font-bold text-[10px] px-2 py-1 rounded-lg bg-amber-500/10 text-amber-400">
        INVALIDATED
      </span>
    );
  }

  return (
    <span className="font-mono font-bold text-[10px] px-2 py-1 rounded-lg bg-slate-800 text-slate-400">
      EXPIRED
    </span>
  );
};

interface DetailValueProps {
  label: string;
  value: string | number;
  valueClass?: string;
}

const DetailValue: React.FC<DetailValueProps> = ({
  label,
  value,
  valueClass = 'text-slate-100',
}) => (
  <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800">
    <span className="text-[10px] uppercase font-bold text-slate-500 block">
      {label}
    </span>

    <span
      className={`font-mono font-bold text-sm mt-0.5 block ${valueClass}`}
    >
      {value}
    </span>
  </div>
);