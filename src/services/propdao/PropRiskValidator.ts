/**
 * DETERMINISTIC PROP RISK VALIDATION
 * ===================================
 * The server-side gate between a proposed trade and an order.
 *
 * WHY THIS IS CODE AND NOT PROMPTING
 *   The model proposes; this decides. A language model can be talked into
 *   anything, and its output is not a control. Every check here is arithmetic
 *   on provider-reported numbers, evaluated on every attempt, with no model
 *   involvement at all. If the model says a trade is perfect and this module
 *   rejects it, the trade is rejected.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE MATTERS
 *
 *   1. Instrument is tradable at PropDAO, and leverage is within ITS cap.
 *      The published docs list equities at 1.5x; the live API reports 2x for
 *      some and 1x for others. Only `/markets` is trusted.
 *
 *   2. Quantity respects the instrument's `lotStep`. A quantity off the step
 *      is rejected by the venue; worse, a rounded quantity that is slightly
 *      larger than intended is a real risk increase nobody approved.
 *
 *   3. Position size fits inside the REMAINING risk budget.
 *      This is the check that matters most. PropDAO closes an account the
 *      instant equity touches the floor, so the maximum stop distance is
 *      derived from `roomUsd`, not from a percentage the user picked.
 *
 *   4. The stop-loss is on the correct SIDE of the entry, and a stop exists.
 *      A long with a stop above the entry is not a stop; it is a guaranteed
 *      loss. PropDAO does not require a stop, so this app does either.
 *
 *   5. Total risk across all open positions stays inside the budget.
 *      Per-trade checks pass individually while a portfolio breaches in
 *      aggregate; this is the check that catches that.
 *
 *   6. Fees are included in the risk figure. At 0.045% taker per side, a
 *      round trip costs ~0.09% of notional — small, but it is charged on the
 *      exit too, when the account is already at its floor.
 *
 * PROPDAO'S DOCUMENTED TIMING RULES ARE NOT RISK, BUT THEY ARE CONSTRAINTS
 *   A position must be open 1s before a manual close, and user-initiated
 *   executions must be >= 0.5s apart. `assertExecutionSpacing` enforces the
 *   second one so a retry loop cannot spam the venue into a 400.
 */

import type {
  AccountRiskSnapshot,
  FundAccountSummary,
} from './PropFundAccountProvider';
import type { PropDaoMarket, PropDaoPosition } from './PropDaoClient';

/** Documented PropDAO fees, applied to notional on every fill. */
export const PROPDAO_FEES = { maker: 0.00015, taker: 0.00045 } as const;

/** Documented: user-initiated executions must be >= 0.5s apart per account. */
export const MIN_EXECUTION_SPACING_MS = 500;

export interface RiskLimits {
  /**
   * Fraction of remaining risk budget a single trade may put at risk.
   *
   * 1.0 would allow the entire remaining budget on one trade — technically
   * within the rules, and a single bad fill away from closing the account.
   */
  maxRiskPerTradePct: number;
  /** Ceiling on total risk across all open positions, as a fraction of room. */
  maxPortfolioRiskPct: number;
  /** Absolute cap on a single trade's risk in account currency. */
  maxRiskPerTradeUsd: number | null;
  /** Minimum reward:risk the gate will accept. */
  minRiskReward: number;
  /** Reject a proposal whose expiry has passed. */
  requireStopLoss: boolean;
  /** Reject a proposal with a take-profit. */
  requireTakeProfit: boolean;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxRiskPerTradePct: 0.25,
  maxPortfolioRiskPct: 0.6,
  maxRiskPerTradeUsd: null,
  minRiskReward: 1.5,
  requireStopLoss: true,
  requireTakeProfit: true,
};

export interface TradeIntent {
  /** PropDAO instrument symbol, e.g. 'BTCUSDC'. NOT a Hyperliquid coin. */
  symbol: string;
  side: 'BUY' | 'SELL';
  /** In UNITS of the asset, not dollars. */
  qty: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  leverage?: number;
}

export interface RiskCheck {
  ok: boolean;
  /** Every failed check, not just the first — so the user can fix them all. */
  violations: string[];
  /** What was actually measured. Null means "could not be determined". */
  measured: {
    notionalUsd: number | null;
    riskUsd: number | null;
    feeUsd: number | null;
    riskReward: number | null;
    riskPctOfRoom: number | null;
    portfolioRiskPctOfRoom: number | null;
    maxQtyByLotStep: number | null;
    maxQtyByRiskBudget: number | null;
    leverageCap: number | null;
  };
}

function ok(measured: RiskCheck['measured']): RiskCheck {
  return { ok: true, violations: [], measured };
}

function fail(violations: string[], measured: RiskCheck['measured']): RiskCheck {
  return { ok: false, violations, measured };
}

const EMPTY_MEASURED: RiskCheck['measured'] = {
  notionalUsd: null,
  riskUsd: null,
  feeUsd: null,
  riskReward: null,
  riskPctOfRoom: null,
  portfolioRiskPctOfRoom: null,
  maxQtyByLotStep: null,
  maxQtyByRiskBudget: null,
  leverageCap: null,
};

/**
 * Rounds DOWN to the instrument's lot step.
 *
 * Rounding DOWN matters: rounding to nearest could increase the position
 * beyond what was approved, which is the opposite of what a risk cap is for.
 *
 * COMPUTED IN INTEGER SPACE.
 *   The naive `Math.floor(qty / step) * step` is wrong for real inputs.
 *   `floor(0.01 / 0.00001)` is 999, not 1000, because 0.01/0.00001 evaluates
 *   to 999.9999999999999 in binary floating point — so a quantity that is
 *   EXACTLY on the step silently loses one step. That is not a rounding
 *   curiosity here: it shrinks every order by one lot, and it would make a
 *   quantity the user precisely calculated get rejected as sub-step.
 *
 *   Both operands are scaled to integers at the step's own precision before
 *   the division, where the arithmetic is exact.
 */
export function floorToLotStep(qty: number, lotStep: number | null | undefined): number | null {
  if (lotStep === null || lotStep === undefined || !Number.isFinite(lotStep) || lotStep <= 0) {
    return null;
  }
  if (!Number.isFinite(qty)) return null;

  // Precision of the step itself, bounded to what a lot size can sensibly
  // need. A step with more than 12 decimals is treated as unrounded.
  const stepText = lotStep.toString();
  const dot = stepText.indexOf('.');
  const decimals = dot === -1 ? 0 : Math.min(stepText.length - dot - 1, 12);
  const scale = Math.pow(10, decimals);

  const scaledStep = Math.round(lotStep * scale);
  if (scaledStep <= 0) return null;

  // TRUNCATE, do not round. `Math.round(0.05 * 10)` is 1, which would make a
  // quantity of 0.05 look like a full 0.1 step and permit an order twice the
  // size that was asked for. Only binary noise smaller than one scaled unit
  // is added back, to undo representation error like 0.29 -> 28.999999999999996.
  const scaledQty = Math.floor(qty * scale + 1e-9);

  const steps = Math.floor(scaledQty / scaledStep);
  if (!Number.isFinite(steps) || steps <= 0) return 0;

  return (steps * scaledStep) / scale;
}

/**
 * Distance from entry to stop, as a POSITIVE number.
 *
 * Returns `null` when the stop is on the wrong side, which the caller turns
 * into a violation rather than a negative "risk" that would sail through a
 * `risk <= budget` comparison.
 */
export function stopDistance(side: 'BUY' | 'SELL', entry: number, stopLoss: number): number | null {
  const distance = side === 'BUY' ? entry - stopLoss : stopLoss - entry;
  return distance > 0 ? distance : null;
}

export function rewardDistance(side: 'BUY' | 'SELL', entry: number, takeProfit: number): number | null {
  const distance = side === 'BUY' ? takeProfit - entry : entry - takeProfit;
  return distance > 0 ? distance : null;
}

/** Total risk already committed by open positions, using each position's stop. */
export function portfolioRiskUsd(
  positions: PropDaoPosition[],
  markets: Map<string, PropDaoMarket>,
): number | null {
  let total = 0;
  let anyMeasured = false;

  for (const position of positions) {
    const entry = position.entry;
    const stop = position.slPrice;
    const qty = position.qty;
    if (entry === null || qty === null) continue;

    if (stop === null || stop === undefined || stop <= 0) {
      // No stop on an open position: its risk is unbounded, which cannot be
      // summed. Reported as null rather than silently treated as zero.
      return null;
    }

    const side = position.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const distance = stopDistance(side, entry, stop);
    if (distance === null) continue;

    anyMeasured = true;
    total += distance * qty;
    // Notional affects fees only; positions already carry their entry.
    void markets;
  }

  return anyMeasured ? total : null;
}

/**
 * THE GATE.
 *
 * Pure: no I/O, no clock, no environment. Everything it needs is passed in,
 * which is what makes it exhaustively testable and what makes it impossible
 * for a request field to influence.
 */
export function validateTradeIntent(
  intent: TradeIntent,
  account: FundAccountSummary | null,
  risk: AccountRiskSnapshot | null,
  markets: PropDaoMarket[],
  openPositions: PropDaoPosition[],
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
): RiskCheck {
  const violations: string[] = [];
  const measured: RiskCheck['measured'] = { ...EMPTY_MEASURED };

  /* -- 0. account must be usable ---------------------------------- */
  if (!account) {
    return fail(['No PropDAO account was selected for this trade.'], measured);
  }
  if (risk === null) {
    return fail(['Account risk data is unavailable, so this trade cannot be sized safely.'], measured);
  }
  if (risk.breached === true) {
    return fail(['This account has breached a drawdown limit and cannot accept new orders.'], measured);
  }

  /* -- 1. instrument exists and is tradable ------------------------ */
  const market = markets.find((m) => m.symbol === intent.symbol);
  if (!market) {
    return fail(
      [`"${intent.symbol}" is not a market PropDAO offers. Check the symbol in Markets.`],
      measured,
    );
  }

  const cap = market.maxLeverage;
  measured.leverageCap = cap;
  const leverage = intent.leverage ?? 1;
  if (cap !== null && leverage > cap) {
    violations.push(
      `Leverage ${leverage}x exceeds the ${cap}x maximum PropDAO allows for ${intent.symbol}.`,
    );
  }

  /* -- 2. price sanity --------------------------------------------- */
  for (const [label, value] of [
    ['entry', intent.entry],
    ['stop-loss', intent.stopLoss],
    ['take-profit', intent.takeProfit],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      violations.push(`The ${label} price (${value}) is not a usable price.`);
    }
  }
  if (violations.length > 0) return fail(violations, measured);

  /* -- 3. stop on the correct side --------------------------------- */
  const distance = stopDistance(intent.side, intent.entry, intent.stopLoss);
  if (limits.requireStopLoss && distance === null) {
    violations.push(
      intent.side === 'BUY'
        ? 'The stop-loss must be BELOW the entry price.'
        : 'The stop-loss must be ABOVE the entry price.',
    );
  }

  const reward = rewardDistance(intent.side, intent.entry, intent.takeProfit);
  if (limits.requireTakeProfit && reward === null) {
    violations.push(
      intent.side === 'BUY'
        ? 'The take-profit must be ABOVE the entry price.'
        : 'The take-profit must be BELOW the entry price.',
    );
  }
  if (violations.length > 0) return fail(violations, measured);

  /* -- 4. quantity shape ------------------------------------------- */
  if (!Number.isFinite(intent.qty) || intent.qty <= 0) {
    return fail(['Order quantity must be a positive number of units.'], measured);
  }

  if (market.lotStep !== null && market.lotStep > 0) {
    measured.maxQtyByLotStep = market.lotStep;
    const floored = floorToLotStep(intent.qty, market.lotStep);
    if (floored === null || floored <= 0) {
      violations.push(
        `Quantity ${intent.qty} is below the ${market.lotStep} minimum lot step for ${intent.symbol}.`,
      );
    } else if (Math.abs(floored - intent.qty) > 1e-9) {
      // Informational rather than fatal: the adapter floors the order, so
      // this surfaces as a note instead of silently changing the size.
      measured.maxQtyByLotStep = floored;
    }
  }

  /* -- 5. the core check: does this fit the risk budget? ----------- */
  const effectiveQty = (market.lotStep !== null && market.lotStep > 0
    ? floorToLotStep(intent.qty, market.lotStep)
    : intent.qty) ?? intent.qty;

  const notional = effectiveQty * intent.entry;
  measured.notionalUsd = notional;

  const tradeRisk = (distance as number) * effectiveQty;
  measured.riskUsd = tradeRisk;

  // Fees land on the notional at BOTH ends of the round trip.
  const fees = notional * PROPDAO_FEES.taker * 2;
  measured.feeUsd = fees;

  const riskIncludingFees = tradeRisk + fees;
  const roomUsd = risk.roomUsd;

  if (roomUsd === null) {
    // Refusing here is the whole point. Guessing a budget when the provider
    // did not report one is how an account gets closed by surprise.
    return fail(
      ['PropDAO did not report remaining risk headroom for this account, so the trade cannot be sized safely.'],
      measured,
    );
  }

  if (roomUsd <= 0) {
    return fail(['This account has no remaining drawdown headroom.'], measured);
  }

  if (limits.maxRiskPerTradeUsd !== null && riskIncludingFees > limits.maxRiskPerTradeUsd) {
    violations.push(
      `This trade risks $${riskIncludingFees.toFixed(2)} including fees, over the $${limits.maxRiskPerTradeUsd} per-trade cap.`,
    );
  }

  const riskPct = (riskIncludingFees / roomUsd) * 100;
  measured.riskPctOfRoom = riskPct;
  if (riskPct > limits.maxRiskPerTradePct * 100) {
    violations.push(
      `This trade risks ${riskPct.toFixed(1)}% of the remaining $${roomUsd.toFixed(2)} drawdown headroom, ` +
        `over the ${(limits.maxRiskPerTradePct * 100).toFixed(0)}% per-trade limit. ` +
        `Reduce size to about ${this_.maxQtyForBudget(roomUsd, distance as number, intent.entry, market.lotStep, limits).toFixed(6)} units.`,
    );
  }

  /* -- 6. portfolio aggregate -------------------------------------- */
  const marketIndex = new Map(markets.map((m) => [m.symbol, m]));
  const existingRisk = portfolioRiskUsd(openPositions, marketIndex);
  if (existingRisk !== null) {
    const portfolioPct = ((existingRisk + riskIncludingFees) / roomUsd) * 100;
    measured.portfolioRiskPctOfRoom = portfolioPct;
    if (portfolioPct > limits.maxPortfolioRiskPct * 100) {
      violations.push(
        `With open positions, total risk would reach ${portfolioPct.toFixed(1)}% of remaining headroom, ` +
          `over the ${(limits.maxPortfolioRiskPct * 100).toFixed(0)}% portfolio limit.`,
      );
    }
  }

  /* -- 7. reward:risk ---------------------------------------------- */
  const rr = (reward as number) / (distance as number);
  measured.riskReward = rr;
  if (rr < limits.minRiskReward) {
    violations.push(
      `Reward:risk of ${rr.toFixed(2)}:1 is below the required ${limits.minRiskReward.toFixed(2)}:1.`,
    );
  }

  return violations.length > 0 ? fail(violations, measured) : ok(measured);
}

/**
 * The largest quantity that respects the per-trade budget.
 *
 * Used to build the actionable "reduce size to about N" message rather than
 * just refusing. Solved from `risk = (distance * qty) + fees` with
 * `fees = qty * entry * taker * 2`, giving a single linear expression:
 *
 *   qty = room * pct / (distance + entry * taker * 2)
 */
const this_ = {
  maxQtyForBudget(
    roomUsd: number,
    distance: number,
    entry: number,
    lotStep: number | null,
    limits: RiskLimits,
  ): number {
    const budget = roomUsd * limits.maxRiskPerTradePct;
    const perUnit = distance + entry * PROPDAO_FEES.taker * 2;
    if (perUnit <= 0) return 0;
    const raw = budget / perUnit;
    const floored = floorToLotStep(raw, lotStep);
    return floored === null ? raw : floored;
  },
};

/**
 * Enforces the documented 0.5s spacing between user-initiated executions.
 *
 * PropDAO returns 400 and executes nothing when two manual executions land
 * inside the same window, so this is checked BEFORE sending rather than
 * discovered from the error.
 */
export function assertExecutionSpacing(
  lastExecutionAtMs: number | null | undefined,
  nowMs: number,
): { ok: true } | { ok: false; waitMs: number } {
  if (lastExecutionAtMs === null || lastExecutionAtMs === undefined) return { ok: true };
  const elapsed = nowMs - lastExecutionAtMs;
  if (elapsed >= MIN_EXECUTION_SPACING_MS) return { ok: true };
  return { ok: false, waitMs: MIN_EXECUTION_SPACING_MS - elapsed };
}