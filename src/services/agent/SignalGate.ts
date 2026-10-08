import {
  TradeSignal,
  MarketThesis,
  MarketQuote,
  TradeDirection,
  OrderType,
} from '../../types';
import {
  ReasoningResult,
  EvidenceItem,
} from '../agent/contracts';
import { HardConstraints } from '../agent/SkillConstraints';

export interface GateValidationResult {
  approved: boolean;
  signal: TradeSignal;
  /** All deterministic rejection reasons (empty when approved). */
  reasons: string[];
  /** The gate parameters actually applied (for observability/audit). */
  appliedConstraints: {
    minRiskReward: number;
    minConfidence: number;
    minEvidence: number;
    requireInvalidation: boolean;
    limitOrdersOnly: boolean;
    noCounterTrend: boolean;
    maxSpreadPips: number;
  };
}

export interface GateInput {
  reasoningResult: ReasoningResult;
  thesis: MarketThesis;
  market: string;
  quote: MarketQuote;
  constraints: HardConstraints;
  goatId: string;
  userId: string;
}

const PLATFORM_MIN_CONFIDENCE = 70;
const PLATFORM_MIN_EVIDENCE = 2;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * DETERMINISTIC SIGNAL GATE
 * ==========================
 * Pure function. No I/O. The LLM does NOT decide whether a signal is allowed.
 *
 * Collects ALL violations (not fail-fast) so rejections are observable.
 * A rejected proposal becomes a clean NO_TRADE signal — never an exception.
 */
export class SignalGate {
  static validate(input: GateInput): GateValidationResult {
    const { reasoningResult, thesis, market, quote, constraints, goatId, userId } = input;
    const proposal = reasoningResult.proposal;

    const applied = {
      minRiskReward: constraints.minRiskReward,
      minConfidence: PLATFORM_MIN_CONFIDENCE,
      minEvidence: constraints.requireEvidence ? PLATFORM_MIN_EVIDENCE : 0,
      requireInvalidation: constraints.requireInvalidation,
      limitOrdersOnly: constraints.limitOrdersOnly,
      noCounterTrend: constraints.noCounterTrend,
      maxSpreadPips: constraints.maxSpreadPips,
    };

    const nowStr = new Date().toISOString();
    const signalId = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const baseSignal: Omit<TradeSignal, 'direction' | 'orderType' | 'status'> = {
      id: signalId,
      userId,
      goatId,
      thesisId: thesis.id,
      market,
      confidence: thesis.confidence,
      thesis: (thesis.summary || 'No thesis summary recorded.').slice(0, 2000),
      rationale: proposal.rationale ?? proposal.noTradeReason ?? 'No rationale provided.',
      confirmationRequired: proposal.confirmationRequired ?? 'Conditions unmet.',
      invalidation: proposal.invalidation ?? 'Signal requirements unmet.',
      supportingEvidence: reasoningResult.evidence
        .filter((e) => e.classification === 'SUPPORTING')
        .map((e) => e.observation),
      contradictoryEvidence: reasoningResult.evidence
        .filter((e) => e.classification === 'CONTRADICTORY')
        .map((e) => e.observation),
      createdAt: nowStr,
      updatedAt: nowStr,
    };

    const noTrade = (reasons: string[]): GateValidationResult => ({
      approved: false,
      reasons,
      appliedConstraints: applied,
      signal: {
        ...baseSignal,
        direction: 'NO_TRADE',
        orderType: 'MARKET',
        rationale: reasons.length
          ? `Deterministic gate rejected: ${reasons.join(' ')}`
          : baseSignal.rationale,
        status: 'NO_TRADE',
      },
    });

    // 1. The model already concluded NO_TRADE.
    if (proposal.decision !== 'ACTIONABLE') {
      return noTrade([
        proposal.noTradeReason
          ? `Model concluded NO_TRADE: ${proposal.noTradeReason}`
          : 'Model concluded NO_TRADE.',
      ]);
    }

    const reasons: string[] = [];
    const direction = proposal.direction;
    const orderType = proposal.orderType;
    const entry = proposal.entry;
    const stopLoss = proposal.stopLoss;
    const takeProfit = proposal.takeProfit;

    // 2. Structural validity (runtime-validated upstream, but never assume).
    if (direction !== 'LONG' && direction !== 'SHORT') {
      reasons.push(`Invalid direction "${String(direction)}" — must be LONG or SHORT.`);
    }
    if (orderType !== 'LIMIT' && orderType !== 'STOP' && orderType !== 'MARKET') {
      reasons.push(`Invalid order type "${String(orderType)}".`);
    }
    if (!isFiniteNumber(entry) || !isFiniteNumber(stopLoss) || !isFiniteNumber(takeProfit)) {
      reasons.push('Entry, stop loss and take profit must be finite numbers.');
    }

    // 3. Market consistency: proposal must target the market being evaluated
    //    (when the model specified one at all).
    if (proposal.market && proposal.market !== market) {
      reasons.push(`Proposal market "${proposal.market}" does not match evaluated market "${market}".`);
    }

    // 4. Spread constraint (evaluated against the live quote).
    if (constraints.maxSpreadPips > 0 && quote.spread > constraints.maxSpreadPips) {
      reasons.push(
        `Spread ${quote.spread} pips exceeds skill constraint SPREAD_UNDER_${constraints.maxSpreadPips}_PIPS.`,
      );
    }

    if (reasons.length > 0) {
      return noTrade(reasons);
    }

    // From here: direction/orderType/prices are valid non-null values.
    const dir = direction as TradeDirection;
    const oType = orderType as OrderType;
    const e = entry as number;
    const sl = stopLoss as number;
    const tp = takeProfit as number;

    // 5. Price relationships — LONG: stop < entry < target; SHORT: target < entry < stop.
    if (dir === 'LONG') {
      if (sl >= e) reasons.push(`Invalid LONG structure: stop (${sl}) must be strictly below entry (${e}).`);
      if (tp <= e) reasons.push(`Invalid LONG structure: target (${tp}) must be strictly above entry (${e}).`);
    } else {
      if (sl <= e) reasons.push(`Invalid SHORT structure: stop (${sl}) must be strictly above entry (${e}).`);
      if (tp >= e) reasons.push(`Invalid SHORT structure: target (${tp}) must be strictly below entry (${e}).`);
    }

    // 6. Risk/reward computed by the gate, never trusted from the model.
    const risk = Math.abs(e - sl);
    const reward = Math.abs(tp - e);
    if (risk <= 0) {
      reasons.push('Calculated risk is zero.');
    } else {
      const rr = reward / risk;
      if (rr < constraints.minRiskReward) {
        reasons.push(
          `Risk/reward 1:${rr.toFixed(2)} is below the required minimum 1:${constraints.minRiskReward.toFixed(2)}.`,
        );
      }
    }

    // 7. Hard constraints from skills.
    if (constraints.limitOrdersOnly && oType === 'MARKET') {
      reasons.push('LIMIT_ORDERS_ONLY constraint: MARKET orders are not allowed.');
    }
    if (constraints.noCounterTrend) {
      const bias = thesis.directionalHypothesis;
      const counterTrend =
        (bias === 'BULLISH' && dir === 'SHORT') || (bias === 'BEARISH' && dir === 'LONG');
      if (counterTrend) {
        reasons.push(
          `NO_COUNTER_TREND constraint: ${dir} proposal contradicts ${bias} thesis bias.`,
        );
      }
    }
    if (constraints.requireInvalidation && (!proposal.invalidation || proposal.invalidation.trim().length < 5)) {
      reasons.push('Skill constraint requires a concrete invalidation level or rule.');
    }

    // 8. Confidence (thesis-level, deterministic minimum).
    if (thesis.confidence < PLATFORM_MIN_CONFIDENCE) {
      reasons.push(
        `Thesis confidence (${thesis.confidence}%) is below the required minimum (${PLATFORM_MIN_CONFIDENCE}%).`,
      );
    }

    // 9. Evidence count (supporting items only).
    const supportingCount = reasoningResult.evidence.filter(
      (eItem: EvidenceItem) => eItem.classification === 'SUPPORTING',
    ).length;
    if (supportingCount < applied.minEvidence) {
      reasons.push(
        `Supporting evidence count (${supportingCount}) is below the required minimum (${applied.minEvidence}).`,
      );
    }

    if (reasons.length > 0) {
      return noTrade(reasons);
    }

    // --- Approved: normalize into a clean, actionable signal -------------
    const rrValue = reward / risk;
    const meta = { digits: countDigits(quote.mid) };

    const entryZone = proposal.entryZone ?? {
      low: roundTo(e * (1 - 0.0005), meta.digits),
      high: roundTo(e * (1 + 0.0005), meta.digits),
    };

    const approvedSignal: TradeSignal = {
      ...baseSignal,
      direction: dir,
      orderType: oType,
      entry: roundTo(e, meta.digits),
      entryZone: {
        low: roundTo(entryZone.low, meta.digits),
        high: roundTo(entryZone.high, meta.digits),
      },
      stopLoss: roundTo(sl, meta.digits),
      takeProfit: roundTo(tp, meta.digits),
      riskReward: `1:${rrValue.toFixed(1)}`,
      rationale: proposal.rationale ?? '',
      status: 'ACTIONABLE',
    };

    return {
      approved: true,
      reasons: [],
      appliedConstraints: applied,
      signal: approvedSignal,
    };
  }
}

function countDigits(price: number): number {
  const str = String(price);
  const dot = str.indexOf('.');
  return dot === -1 ? 2 : Math.min(8, str.length - dot - 1);
}
