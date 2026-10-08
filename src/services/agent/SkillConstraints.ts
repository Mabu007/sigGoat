/**
 * HARD CONSTRAINTS — deterministic enforcement of skill-level rules.
 *
 * The LLM is *instructed* to follow methodology (soft constraints).
 * Hard constraints are enforced structurally by SignalGate and cannot be
 * overridden by the model, the client, or anything else at runtime.
 */

import { TradingSkill } from '../../types';

export interface HardConstraints {
  /** Minimum risk/reward ratio. Platform floor is 1.4; skills may raise it. */
  minRiskReward: number;
  /** Proposal must include a concrete invalidation level or rule. */
  requireInvalidation: boolean;
  /** At least 2 supporting evidence items required for ACTIONABLE. */
  requireEvidence: boolean;
  /** Only LIMIT (and STOP for breakout styles) pending orders allowed; MARKET rejected. */
  limitOrdersOnly: boolean;
  /** Only trade in the stated direction of the thesis bias; no counter-trend proposals. */
  noCounterTrend: boolean;
  /** Maximum allowed spread in pips (0 = no spread constraint). */
  maxSpreadPips: number;
  /** List of constraint tokens that produced these constraints (for observability). */
  enforcedTokens: string[];
}

export const PLATFORM_DEFAULT_CONSTRAINTS: HardConstraints = {
  minRiskReward: 1.4,
  requireInvalidation: true,
  requireEvidence: true,
  limitOrdersOnly: false,
  noCounterTrend: false,
  maxSpreadPips: 0,
  enforcedTokens: [],
};

export function aggregateHardConstraints(skills: TradingSkill[]): HardConstraints {
  const constraints: HardConstraints = {
    minRiskReward: PLATFORM_DEFAULT_CONSTRAINTS.minRiskReward,
    requireInvalidation: PLATFORM_DEFAULT_CONSTRAINTS.requireInvalidation,
    requireEvidence: PLATFORM_DEFAULT_CONSTRAINTS.requireEvidence,
    limitOrdersOnly: PLATFORM_DEFAULT_CONSTRAINTS.limitOrdersOnly,
    noCounterTrend: PLATFORM_DEFAULT_CONSTRAINTS.noCounterTrend,
    maxSpreadPips: PLATFORM_DEFAULT_CONSTRAINTS.maxSpreadPips,
    enforcedTokens: [],
  };

  const tokens: string[] = [];
  for (const skill of skills) {
    // constraints field plus the Constraints section of the pristine markdown
    const text = `${skill.constraints || ''}\n${extractConstraintsSection(skill.rawMarkdown)}`;
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
      tokens.push(match[0]);
    }
  }

  for (const token of tokens) {
    const upper = token.toUpperCase();
    const rrMatch = upper.match(/^MINIMUM_RR_(\d+)_TO_(\d+)$/);
    if (rrMatch) {
      const ratio = Number(rrMatch[1]) / Number(rrMatch[2]);
      if (Number.isFinite(ratio) && ratio > 0) {
        constraints.minRiskReward = Math.max(constraints.minRiskReward, ratio);
        constraints.enforcedTokens.push(token);
      }
      continue;
    }

    switch (upper) {
      case 'REQUIRE_INVALIDATION_BEFORE_TRADE':
        constraints.requireInvalidation = true;
        constraints.enforcedTokens.push(token);
        break;
      case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE':
        constraints.requireEvidence = true;
        constraints.enforcedTokens.push(token);
        break;
      case 'LIMIT_ORDERS_ONLY':
        constraints.limitOrdersOnly = true;
        constraints.enforcedTokens.push(token);
        break;
      case 'NO_COUNTER_TREND':
      case 'NO_COUNTER_TREND_WITHOUT_CHOCH':
        constraints.noCounterTrend = true;
        constraints.enforcedTokens.push(token);
        break;
      default:
        break;
    }

    const spreadMatch = upper.match(/^SPREAD_UNDER_(\d+(?:_\d+)*)_PIPS?$/);
    if (spreadMatch) {
      const pips = Number(spreadMatch[1].replace(/_/g, '.'));
      if (Number.isFinite(pips) && pips > 0) {
        constraints.maxSpreadPips = constraints.maxSpreadPips === 0 ? pips : Math.min(constraints.maxSpreadPips, pips);
        constraints.enforcedTokens.push(token);
      }
    }
  }

  return constraints;
}

function extractConstraintsSection(rawMarkdown?: string): string {
  if (!rawMarkdown) return '';
  const match = rawMarkdown.match(/##\s+Constraints[\s\S]*?(?=(?:##|$))/i);
  return match ? match[0] : '';
}
