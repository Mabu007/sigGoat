import { describe, expect, test } from 'bun:test';
import { STARTER_ROBOTS } from '../src/server/robots/starterRobots';
import { validateStrategyDefinition } from '../src/services/strategy/schema';

describe('platform starter robots', () => {
  test('ships three distinct public, immutable strategies', () => {
    expect(STARTER_ROBOTS).toHaveLength(3);
    expect(new Set(STARTER_ROBOTS.map(item => item.robot.slug)).size).toBe(3);
    expect(new Set(STARTER_ROBOTS.map(item => item.definition.market.instrument)).size).toBe(3);
    for (const item of STARTER_ROBOTS) {
      expect(item.robot.visibility).toBe('PUBLIC');
      expect(item.robot.ownerUserId).toBe('signalgoat_system');
      expect(item.definition.execution.mode).toBe('PAPER');
      expect(item.definition.risk.sizing.mode).toBe('PERCENT_RISK');
      if (item.definition.risk.sizing.mode === 'PERCENT_RISK') expect(item.definition.risk.sizing.percent).toBeLessThanOrEqual(1);
      expect(item.definition.risk.takeProfitPercent).toBeGreaterThan(item.definition.risk.stopLossPercent);
      expect(validateStrategyDefinition(item.definition).success).toBe(true);
    }
  });

  test('covers sweep, retest and sequential structure logic', () => {
    const serialized = JSON.stringify(STARTER_ROBOTS.map(item => item.definition.entry.condition));
    expect(serialized).toContain('BULLISH_SWEEP');
    expect(serialized).toContain('BREAKOUT_RETEST_LOW');
    expect(serialized).toContain('sequence');
    expect(serialized).toContain('BREAKOUT_RETEST_HIGH');
  });
});
