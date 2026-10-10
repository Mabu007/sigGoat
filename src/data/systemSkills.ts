import { TradingSkill } from '../types';
import { DEFAULT_SKILLS } from './defaultSkills';

/** Ids of the original seeded built-ins, which are system-owned too. */
export const DEFAULT_SKILL_IDS = new Set(DEFAULT_SKILLS.map((s) => s.id));

/**
 * SYSTEM-OWNED SKILL CATALOGUE
 * =============================
 * Curated starting points a user can copy into their own library.
 *
 * SYSTEM OWNERSHIP IS ENFORCED, NOT JUST CONVENTION
 *
 * Every skill here has `userId: 'system'` and `isDefault: true`. The server
 * refuses writes to those records regardless of what the client sends, so a
 * user cannot edit a canonical template even by calling the API directly with
 * its id. Copying produces a NEW record owned by the caller; the template is
 * left untouched.
 *
 * SCOPE — WHAT A SKILL ACTUALLY DOES HERE
 *
 * A skill is PROMPT AND VALIDATION TEXT. It is assembled into the reasoning
 * context in `GoatDurableObject`, and its `constraints` are read by
 * `SkillConstraints` to gate proposals. There is no code-execution path for a
 * skill: nothing in this repository evaluates skill content as JavaScript, and
 * the catalogue deliberately contains no such field.
 *
 * That is why every entry below describes analysis DISCIPLINE rather than
 * claiming a capability. Each one corresponds to behaviour the runtime
 * actually implements:
 *
 *   - session awareness -> `SessionSchedule` / `SessionCalendar` classify the
 *     active session and its liquidity window;
 *   - volatility monitoring -> `calculateATR` / `calculateRSI` are computed as
 *     `deterministicIndicators` and passed to the model;
 *   - multi-timeframe confirmation -> tracking timeframes drive tracker
 *     observation cadence (`pollIntervalForTimeframe`);
 *   - risk-aware validation -> `SignalGate` requires entry, stop and target
 *     before an ACTIONABLE proposal is accepted;
 *   - event-driven monitoring -> `TrackerDirective` conditions are recomputed
 *     deterministically from candles, so a condition either fired or did not.
 *
 * NO PERFORMANCE CLAIMS
 *
 * Nothing here asserts profitability, win rate or historical return. These are
 * analysis frameworks to be judged on their own output.
 */

const SYSTEM_USER = 'system';

function skill(
  s: Omit<TradingSkill, 'userId' | 'isDefault' | 'createdAt' | 'updatedAt'>,
): TradingSkill {
  return {
    ...s,
    userId: SYSTEM_USER,
    isDefault: true,
    // Deterministic timestamps: a catalogue must not change between builds, or
    // every user copy would appear to drift.
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export const SYSTEM_SKILLS: TradingSkill[] = [
  skill({
    id: 'skill_session_liquidity',
    name: 'Session Liquidity Awareness',
    description:
      'Conditions analysis on when a market is most likely to move: distinguishes Asian, London and New York windows and refuses to treat a thin-book period as a real breakout.',
    methodology:
      'Classify the active session from UTC time and the instrument\'s trading zone. Weight structure observed during a thin session below structure observed across a session boundary, because a sweep that fills without follow-through is liquidity collection rather than distribution. Prefer setups whose confirmation window overlaps a high-liquidity session.',
    constraints:
      'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, Do not present a mid-session range as a session breakout.',
    preferredTimeframes: ['15m', '1h'],
    requiredEvidence:
      'A decisive close outside the prior session range, plus evidence the move held beyond the session boundary rather than immediately retracing.',
    invalidationRules:
      'Price returning fully inside the prior session range within the first hour of the next session invalidates the session-break thesis.',
  }),

  skill({
    id: 'skill_volatility_regime',
    name: 'Volatility Regime Monitoring',
    description:
      'Reads the prevailing volatility state from ATR and RSI before judging any setup, so a quiet market is not analysed with the same conviction as an expanding one.',
    methodology:
      'Use the supplied ATR(14) and RSI(14) values to classify the regime as compressed, normal or expanded. In a compressed regime, require a larger structural break before acting. In an expanded regime, discount single-candle signals and require a retest. State the regime explicitly in the thesis so the conclusion can be judged against it.',
    constraints:
      'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, Do not present a proposal without naming the volatility regime it assumes.',
    preferredTimeframes: ['15m', '1h', '4h'],
    requiredEvidence:
      'An ATR and RSI reading from the supplied deterministic indicators, plus a structural observation consistent with that regime.',
    invalidationRules:
      'A regime shift — ATR expanding by roughly half again, or RSI crossing back through 50 against the assumed direction — invalidates the regime-specific reasoning.',
  }),

  skill({
    id: 'skill_multi_timeframe_confirmation',
    name: 'Multi-Timeframe Confirmation',
    description:
      'Requires the tracking timeframe and the higher timeframe to agree before a directional proposal is made, and says plainly when they disagree.',
    methodology:
      'Compare the market\'s observed structure on the GOAT tracking timeframe with the higher-timeframe bias supplied in the context. Treat agreement as confirmation. Treat disagreement as a reason to reduce conviction, propose NO_TRADE, or narrow the entry zone rather than picking a side.',
    constraints:
      'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, Do not propose ACTIONABLE against the higher-timeframe bias without naming the conflict.',
    preferredTimeframes: ['15m', '1h', '4h'],
    requiredEvidence:
      'Explicit agreement or disagreement between the tracking-timeframe structure and the higher-timeframe bias.',
    invalidationRules:
      'A higher-timeframe structure break against the proposed direction invalidates the setup regardless of lower-timeframe confirmation.',
  }),

  skill({
    id: 'skill_risk_validated_setup',
    name: 'Risk-Aware Signal Validation',
    description:
      'Enforces that every actionable idea carries a concrete invalidation level and a stated reward-to-risk basis, so nothing is published that cannot be falsified.',
    methodology:
      'For every proposal, derive the invalidation level from structure rather than from an arbitrary percentage, and check it sits on the correct side of the entry. Compute reward-to-risk from the actual levels. If no defensible invalidation exists, the correct output is NO_TRADE — that is a valid and useful result, not a failure.',
    constraints:
      'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, No ACTIONABLE proposal without a concrete invalidation level.',
    preferredTimeframes: ['15m', '1h'],
    requiredEvidence:
      'A structural invalidation level, an entry, and a target, with the resulting risk-to-reward stated.',
    invalidationRules:
      'If the invalidation level cannot be justified from market structure, the proposal is downgraded to NO_TRADE.',
  }),

  skill({
    id: 'skill_event_driven_tracking',
    name: 'Event-Driven Monitoring',
    description:
      'Turns a thesis into observable conditions — indicator thresholds and crosses — that the runtime recomputes from candles and alerts on when they are met.',
    methodology:
      'Express the thesis as concrete tracker conditions with an indicator, a target value and an operator, rather than as prose. Each condition must be checkable against the supplied candles. Where a condition depends on something not present in the supplied market data, say so instead of asserting it fired.',
    constraints:
      'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, Do not claim a tracker fired unless the supplied state states it fired.',
    preferredTimeframes: ['1m', '5m', '15m'],
    requiredEvidence:
      'At least one deterministic tracker condition with an indicator and a numeric target.',
    invalidationRules:
      'When a tracked condition is invalidated before a signal is acted on, the thesis it supported no longer applies.',
  }),

  skill({
    id: 'skill_no_trade_discipline',
    name: 'No-Trade Discipline',
    description:
      'A deliberately conservative starting point: prefers NO_TRADE over a marginal idea, and requires the confirmation conditions to be met in order rather than in principle.',
    methodology:
      'Before proposing anything, list the conditions that must hold and check each against the supplied state. Propose ACTIONABLE only when every listed condition is currently satisfied. Otherwise return NO_TRADE with the unmet conditions named. Treat a high NO_TRADE rate as correct behaviour, not as a fault.',
    constraints: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, REQUIRE_INVALIDATION_BEFORE_TRADE.',
    preferredTimeframes: ['15m', '1h', '4h'],
    requiredEvidence:
      'An explicit list of conditions with each one marked satisfied or unmet.',
    invalidationRules:
      'Not applicable: this skill constrains when a trade is proposed, not the shape of the proposal.',
  }),
];

export const SYSTEM_SKILL_IDS = new Set(SYSTEM_SKILLS.map((s) => s.id));

/** True for a record that belongs to this catalogue rather than to a user. */
export function isSystemSkillId(id: string): boolean {
  return SYSTEM_SKILL_IDS.has(id);
}

/**
 * True for ANY system-owned skill id, including the original seeded set.
 *
 * Immutability checks must use this, not `isSystemSkillId`. The seeded skills in
 * `defaultSkills.ts` are a separate collection from the browseable catalogue
 * above, and a guard that only knew about the catalogue would report a
 * misleading 404 for a built-in it simply had never heard of.
 */
export function isSystemOwnedSkillId(id: string): boolean {
  return SYSTEM_SKILL_IDS.has(id) || DEFAULT_SKILL_IDS.has(id);
}