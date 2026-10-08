import { describe, test, expect } from 'bun:test';
import { aggregateHardConstraints } from '../src/services/agent/SkillConstraints';
import { TradingSkill } from '../src/types';

function skill(name: string, constraints: string, rawMarkdown?: string): TradingSkill {
  return {
    id: `skill_${name}`,
    userId: 'system',
    name,
    description: '',
    methodology: '',
    constraints,
    preferredTimeframes: ['1h'],
    requiredEvidence: '',
    invalidationRules: '',
    rawMarkdown,
    createdAt: '',
    updatedAt: '',
  };
}

describe('aggregateHardConstraints', () => {
  test('parses MINIMUM_RR_2_TO_1 into a numeric floor of 2.0', () => {
    const c = aggregateHardConstraints([skill('rr', 'MINIMUM_RR_2_TO_1')]);
    expect(c.minRiskReward).toBe(2);
    expect(c.enforcedTokens).toContain('MINIMUM_RR_2_TO_1');
  });

  test('keeps the strictest minimum when multiple R:R tokens exist', () => {
    const c = aggregateHardConstraints([skill('rr', 'MINIMUM_RR_2_TO_1\nMINIMUM_RR_3_TO_1')]);
    expect(c.minRiskReward).toBe(3);
  });

  test('LIMIT_ORDERS_ONLY sets the flag', () => {
    const c = aggregateHardConstraints([skill('loo', 'LIMIT_ORDERS_ONLY')]);
    expect(c.limitOrdersOnly).toBe(true);
  });

  test('NO_COUNTER_TREND and NO_COUNTER_TREND_WITHOUT_CHOCH both set the flag', () => {
    expect(aggregateHardConstraints([skill('a', 'NO_COUNTER_TREND')]).noCounterTrend).toBe(true);
    expect(aggregateHardConstraints([skill('b', 'NO_COUNTER_TREND_WITHOUT_CHOCH')]).noCounterTrend).toBe(true);
  });

  test('REQUIRE_* flags are enforced', () => {
    const c = aggregateHardConstraints([skill('r', 'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE')]);
    expect(c.requireInvalidation).toBe(true);
    expect(c.requireEvidence).toBe(true);
  });

  test('SPREAD_UNDER_2_PIPS parses to maxSpreadPips 2 (underscores as decimals work too)', () => {
    expect(aggregateHardConstraints([skill('s1', 'SPREAD_UNDER_2_PIPS')]).maxSpreadPips).toBe(2);
    expect(aggregateHardConstraints([skill('s2', 'SPREAD_UNDER_1_5_PIPS')]).maxSpreadPips).toBe(1.5);
  });

  test('tightest spread constraint wins across skills', () => {
    const c = aggregateHardConstraints([
      skill('a', 'SPREAD_UNDER_5_PIPS'),
      skill('b', 'SPREAD_UNDER_2_PIPS'),
    ]);
    expect(c.maxSpreadPips).toBe(2);
  });

  test('constraint tokens inside rawMarkdown ## Constraints sections are honoured', () => {
    const md = `# Skill\n\n## Constraints\nLIMIT_ORDERS_ONLY\nMINIMUM_RR_2_TO_1\n`;
    const c = aggregateHardConstraints([skill('md', '', md)]);
    expect(c.limitOrdersOnly).toBe(true);
    expect(c.minRiskReward).toBe(2);
  });

  test('random UPPERCASE prose does not corrupt constraints', () => {
    const c = aggregateHardConstraints([skill('x', 'Disregard lagging momentum oscillators. WAIT_FOR_REJECTION_CONFIRMATION')]);
    // WAIT_FOR_REJECTION_CONFIRMATION is a soft instruction, not an enforced token.
    expect(c.enforcedTokens.length).toBe(0);
    expect(c.limitOrdersOnly).toBe(false);
  });

  test('default constraints apply when a skill has no hard tokens', () => {
    const c = aggregateHardConstraints([skill('plain', 'Just be sensible.')]);
    expect(c.minRiskReward).toBe(1.4);
    expect(c.requireInvalidation).toBe(true);
    expect(c.limitOrdersOnly).toBe(false);
  });
});
