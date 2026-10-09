export type MarketCategory =
  | 'forex'
  | 'commodities'
  | 'indices';

/**
 * Where market data came from.
 *
 * PAPER data is deterministic simulated data and must never be presented
 * as live market data.
 */
export type DataMode =
  | 'PAPER'
  | 'LIVE';

/**
 * Supported chart / reasoning timeframes.
 */
export type Timeframe =
  | '1m'
  | '5m'
  | '15m'
  | '1h'
  | '4h'
  | '1D';

export const TIMEFRAMES: readonly Timeframe[] = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1D',
] as const;

export interface MarketSymbol {
  symbol: string;
  name: string;
  category: MarketCategory;
  baseCurrency: string;
  quoteCurrency: string;
  pipSize: number;
  digits: number;
  minSpread: number;
}

export interface MarketQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  change24h: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  timestamp: number;

  /**
   * True when the price is real but NOT current — e.g. a forex market closed
   * over the weekend. A stale quote must never be treated as a live reading.
   */
  stale?: boolean;

  /** Provider market state: 'open' | 'closed' | 'unknown'. */
  marketState?: string;

  /** Seconds since the provider's last actual quote. */
  quoteAgeSeconds?: number;
}

/**
 * OHLCV candle.
 *
 * `time` is epoch milliseconds throughout the application.
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Runtime state of a GOAT.
 *
 * There is deliberately no RUNNING or ERROR status.
 * Errors are represented through `lastError` while the GOAT returns
 * to a recoverable WATCHING state.
 */
export type GoatStatus =
  | 'ACTIVE'
  | 'WATCHING'
  | 'DORMANT'
  | 'INVESTIGATING'
  | 'PAUSED';

/**
 * Trade direction.
 *
 * Never overload this with market bias or order type.
 */
export type TradeDirection =
  | 'LONG'
  | 'SHORT';

/**
 * Execution / entry order type.
 */
export type OrderType =
  | 'LIMIT'
  | 'STOP'
  | 'MARKET';

/**
 * Market directional bias.
 *
 * This is a market view, not an instruction to trade.
 */
export type MarketBias =
  | 'BULLISH'
  | 'BEARISH'
  | 'NEUTRAL';

/**
 * Final reasoning decision.
 */
export type ReasoningDecision =
  | 'ACTIONABLE'
  | 'NO_TRADE';

/**
 * Kept as a compatibility alias for existing code that refers to
 * signal type separately from order type.
 */
export type SignalType = OrderType;

/**
 * Canonical tracker condition types.
 */
export type TrackerConditionType =
  | 'PRICE_LEVEL'
  | 'STRUCTURE'
  | 'SPREAD'
  | 'TIME_WINDOW'
  | 'INDICATOR'
  | 'BREAKOUT'
  | 'RSI_THRESHOLD'
  | 'EMA_CROSS'
  | 'SESSION_BOUNDARY';

export const TRACKER_CONDITION_TYPES: readonly TrackerConditionType[] = [
  'PRICE_LEVEL',
  'STRUCTURE',
  'SPREAD',
  'TIME_WINDOW',
  'INDICATOR',
  'BREAKOUT',
  'RSI_THRESHOLD',
  'EMA_CROSS',
  'SESSION_BOUNDARY',
] as const;

/**
 * Canonical tracker operators.
 */
export type TrackerOperator =
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'CROSS_ABOVE'
  | 'CROSS_BELOW'
  | 'WITHIN_RANGE';

export const TRACKER_OPERATORS: readonly TrackerOperator[] = [
  'GREATER_THAN',
  'LESS_THAN',
  'CROSS_ABOVE',
  'CROSS_BELOW',
  'WITHIN_RANGE',
] as const;

export type IndicatorType =
  | 'RSI'
  | 'EMA'
  | 'SMA'
  | 'ATR'
  | 'MACD'
  | 'MACD_HISTOGRAM'
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  /**
   * Price itself, as a condition target.
   *
   * The overwhelmingly common tracker is "price crosses X". Without a PRICE
   * member in the union that condition has no representation and the runtime
   * falls back to PRICE implicitly.
   */
  | 'PRICE';

export const INDICATOR_TYPES: readonly IndicatorType[] = [
  'RSI',
  'EMA',
  'SMA',
  'ATR',
  'MACD',
  'MACD_HISTOGRAM',
  'SWING_HIGH',
  'SWING_LOW',
  'SESSION_HIGH',
  'SESSION_LOW',
  'PRICE',
] as const;

export type TradingSession =
  | 'LONDON'
  | 'NEW_YORK'
  | 'ASIAN';

export interface TrackerIndicatorParams {
  indicator: IndicatorType;
  period?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  session?: TradingSession;
  threshold?: number;
}

/**
 * How often a GOAT is allowed to run AI reasoning.
 *
 * - INTERVAL : every N minutes (5 / 15 / 60 / 240 …).
 * - TIMES    : at explicit local wall-clock times, e.g. ['08:30','13:00'].
 * - MANUAL   : only when the user asks (chat / wake button).
 * - TRACKERS : deterministic tracker polling only; no scheduled LLM spend.
 */
export type GoatScheduleMode =
  | 'INTERVAL'
  | 'TIMES'
  | 'MANUAL'
  | 'TRACKERS';

export interface GoatSchedule {
  mode: GoatScheduleMode;
  /** Minutes between reasoning runs. Only used when mode === 'INTERVAL'. */
  intervalMinutes?: number;
  /** Local 'HH:MM' wall-clock times. Only used when mode === 'TIMES'. */
  times?: string[];
}

export const SCHEDULE_PRESETS: ReadonlyArray<{
  label: string;
  minutes: number;
}> = [
  { label: 'Every 5 minutes', minutes: 5 },
  { label: 'Every 15 minutes', minutes: 15 },
  { label: 'Every 30 minutes', minutes: 30 },
  { label: 'Every hour', minutes: 60 },
  { label: 'Every 4 hours', minutes: 240 },
  { label: 'Trackers only (no AI spend)', minutes: 0 },
  { label: 'Manual only', minutes: -1 },
] as const;

export const DEFAULT_GOAT_SCHEDULE: GoatSchedule = {
  mode: 'INTERVAL',
  intervalMinutes: 60,
};

export interface TrackerCondition {
  id: string;
  description: string;
  type: TrackerConditionType;
  market: string;
  targetValue?: number;
  operator?: TrackerOperator;
  indicatorParams?: TrackerIndicatorParams;
  currentCalculatedValue?: number;
  formulaDescription?: string;
  isTriggered: boolean;
  triggeredAt?: number;
}

export interface TradingSkill {
  id: string;
  userId: string;
  name: string;
  description: string;
  methodology: string;
  constraints: string;
  preferredTimeframes: string[];
  requiredEvidence: string;
  invalidationRules: string;
  rawMarkdown?: string;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SignalGoat {
  id: string;
  userId: string;
  name: string;
  goal: string;
  markets: string[];
  skillIds: string[];
  model: string;
  status: GoatStatus;
  /** When this GOAT is allowed to spend AI tokens. See GoatSchedule. */
  schedule?: GoatSchedule;
  /**
   * User-selected MARKET TRACKING timeframe — the cadence at which this GOAT's
   * trackers are observed. Does not restrict what the AI may reason about.
   * See TRACKING_TIMEFRAMES in services/market-data/trackingTimeframes.
   */
  timeframe?: '1m' | '5m' | '15m' | '1h' | '4h';
  activeThesisId?: string;
  lastWakeReason?: string;
  lastWakeTime?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketThesis {
  id: string;
  userId: string;
  goatId: string;
  market: string;

  /**
   * Current directional market hypothesis.
   * This is intentionally separate from TradeDirection.
   */
  directionalHypothesis: MarketBias;

  /** Human-readable summary of the hypothesis. */
  summary?: string;

  /**
   * Plain-language STATE of the asset(s) at the time of this analysis:
   * trend, momentum, structure, volatility, where price sits relative to
   * key levels. This is what the user reads first.
   */
  assetState?: string;

  /**
   * The PLAN built from that state: the ordered conditions that must hold
   * before a trade idea becomes valid. Every step is a wait-for, not a
   * "buy now".
   */
  tradePlan?: string[];

  supportingEvidence: string[];
  contradictoryEvidence?: string[];

  /**
   * Timeframe on which the thesis is primarily evaluated.
   */
  relevantTimeframe: string;

  /**
   * Human-readable conditions required before the thesis becomes actionable.
   */
  confirmationConditions: string[];

  /**
   * Conditions that invalidate the thesis.
   */
  invalidationConditions: string[];

  observationPlan?: string;

  trackers: TrackerCondition[];

  /**
   * Confidence expressed as a percentage from 0 to 100.
   */
  confidence: number;

  status:
    | 'FORMULATING'
    | 'TRACKING'
    | 'CONFIRMED'
    | 'INVALIDATED'
    | 'EXPIRED';

  invalidationReason?: string;

  createdAt: string;
  updatedAt: string;
}

export type WakeTriggerType =
  | 'TRACKER_TRIGGERED'
  | 'SESSION_OPEN'
  | 'SCHEDULED'
  | 'MANUAL_REEVALUATE'
  | 'PRICE_SPIKE';

export type WakeDecisionResult =
  | 'SIGNAL_PRODUCED'
  | 'NO_TRADE'
  | 'THESIS_UPDATED'
  | 'INVALIDATED'
  | 'ERROR';

export interface WakeEvent {
  id: string;
  goatId: string;
  timestamp: number;
  reason: string;
  market: string;
  triggerType: WakeTriggerType;
  evidenceSnapshot: string;
  decisionResult: WakeDecisionResult;
  details: string;
  calculatedContext?: Record<string, unknown>;
}

export interface TradeSignal {
  id: string;
  userId: string;
  goatId: string;
  thesisId: string;
  market: string;

  /**
   * NO_TRADE is represented at the signal layer so the UI/API can
   * consistently expose the latest decision without inventing an order.
   */
  direction: TradeDirection | 'NO_TRADE';

  orderType: OrderType;

  entry?: number;
  entryZone?: {
    low: number;
    high: number;
  };

  stopLoss?: number;
  takeProfit?: number;

  /**
   * Stored as a display/API value.
   * Deterministic execution validation should calculate RR itself.
   */
  riskReward?: string;

  /**
   * Confidence expressed as a percentage from 0 to 100.
   */
  confidence: number;

  thesis: string;
  rationale: string;
  confirmationRequired: string;
  invalidation: string;

  supportingEvidence: string[];
  contradictoryEvidence?: string[];

  createdAt: string;
  expiresAt?: string;

  status:
    | 'ACTIONABLE'
    | 'INVALIDATED'
    | 'EXPIRED'
    | 'NO_TRADE';

  updatedAt: string;
}

export type ReviewSession =
  | 'LONDON_OPEN'
  | 'NEW_YORK_OPEN'
  | 'ASIAN_OPEN'
  | 'PERIODIC';

export interface GoatRuntimeState {
  goatId: string;
  status: GoatStatus;

  currentThesis: MarketThesis | null;
  trackers: TrackerCondition[];

  lastWakeEvent: WakeEvent | null;
  recentWakeEvents: WakeEvent[];

  latestSignal: TradeSignal | null;

  dormancyReason: string;
  nextWatchingCondition: string;

  lastReviewSession?: ReviewSession;
  nextScheduledReview?: string;

  /**
   * Generation identifier used to prevent stale async work from
   * mutating newer runtime state.
   */
  generationId: string;

  lastEvaluatedAt: number;
  isEvaluating: boolean;

  consecutiveFailures: number;
  lastError?: string;

  dataSource: DataMode;

  /**
   * AI = reasoning was executed through an available AI credential.
   * DEMO = deterministic/demo reasoning path.
   */
  reasoningMode: 'AI' | 'DEMO';
}

export interface BacktestTrade {
  id: string;
  timestamp: number;
  market: string;
  direction: TradeDirection;
  orderType: OrderType;

  plannedEntry: number;
  entryPrice?: number;

  stopLoss: number;
  takeProfit: number;

  exitPrice?: number;
  exitTime?: number;

  pnlPips: number;
  pnlPct: number;

  outcome:
    | 'WIN'
    | 'LOSS'
    | 'UNFILLED'
    | 'INVALIDATED_BEFORE_FILL'
    | 'EXPIRED';

  riskReward: number;

  thesis: string;
  reason: string;

  executionPath?: string[];
}

export interface BacktestResult {
  id: string;
  goatId: string;
  goatName: string;
  market: string;
  period: string;
  dataSource: DataMode;

  totalSignals: number;
  filledSignals: number;
  unfilledSignals: number;
  invalidatedSignals: number;
  expiredSignals: number;

  winningSignals: number;
  losingSignals: number;

  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  averageRR: number;
  netPips: number;
  netDollarPnl: number;
  averageWin: number;
  averageLoss: number;

  ambiguityPolicy: string;

  equityCurve: {
    time: number;
    equity: number;
  }[];

  trades: BacktestTrade[];

  createdAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;

  telegramChatId?: string;
  telegramUsername?: string;
  telegramNotificationsEnabled?: boolean;

  createdAt: string;
  updatedAt: string;
}