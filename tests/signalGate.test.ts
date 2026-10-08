import { describe, test, expect } from 'bun:test';
import { SignalGate } from '../src/services/agent/SignalGate';
import { parseReasoningResult } from '../src/services/agent/contracts';
import { aggregateHardConstraints } from '../src/services/agent/SkillConstraints';
import { MarketThesis, MarketQuote, TradingSkill } from '../src/types';

const QUOTE: MarketQuote = {
  symbol: 'EUR/USD',
  bid: 1.0844,
  ask: 1.0846,
  mid: 1.0845,
  spread: 1.0,
  change24h: 0.0021,
  change24hPct: 0.19,
  high24h: 1.0890,
  low24h: 1.0801,
  timestamp: Date.now(),
};

function makeThesis(over: Partial<MarketThesis> = {}): MarketThesis {
  return {
    id: 'ths_1',
    userId: 'u1',
    goatId: 'g1',
    market: 'EUR/USD',
    directionalHypothesis: 'BULLISH',
    summary: 'Bullish continuation after sweep.',
    supportingEvidence: ['HH', 'Sweep rejection'],
    relevantTimeframe: '1h',
    confirmationConditions: [],
    invalidationConditions: ['Close below 1.0800'],
    observationPlan: 'Watch demand.',
    trackers: [],
    confidence: 85,
    status: 'TRACKING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const VALID_RESULT = parseReasoningResult({
  investigation: { summary: 'Bullish.' },
  thesis: { directionalBias: 'BULLISH', summary: 'Continuation.', confidence: 85, invalidation: 'Close below 1.0800.', trackers: [] },
  proposal: {
    decision: 'ACTIONABLE',
    triggerSequence: ['EMA(20) crosses above 1.0840', 'price holds above 1.0840 on a 15m close'],
    direction: 'LONG',
    orderType: 'LIMIT',
    market: 'EUR/USD',
    entry: 1.0845,
    stopLoss: 1.0820,
    takeProfit: 1.0920,
    rationale: 'Demand retest.',
    confirmationRequired: '15m close above entry.',
    invalidation: 'Close below 1.0800.',
  },
  evidence: [
    { source: 'STRUCTURE', market: 'EUR/USD', observation: 'HH established.', classification: 'SUPPORTING' },
    { source: 'RSI_14', market: 'EUR/USD', observation: 'RSI recovering.', classification: 'SUPPORTING' },
  ],
});

const DEFAULT_SKILLS: TradingSkill[] = [];

function gate(result = VALID_RESULT, thesis = makeThesis(), constraints = aggregateHardConstraints(DEFAULT_SKILLS)) {
  return SignalGate.validate({
    reasoningResult: result,
    thesis,
    market: 'EUR/USD',
    quote: QUOTE,
    constraints,
    goatId: 'g1',
    userId: 'u1',
  });
}

describe('SignalGate', () => {
  test('approves a valid LONG LIMIT setup and recomputes R:R itself', () => {
    const result = gate();
    expect(result.approved).toBe(true);
    expect(result.signal.direction).toBe('LONG');
    expect(result.signal.orderType).toBe('LIMIT');
    expect(result.signal.status).toBe('ACTIONABLE');
    // actual rr = (1.0920-1.0845)/(1.0845-1.0820) = 3.0
    expect(result.signal.riskReward).toBe('1:3.0');
    expect(result.signal.entryZone).toBeDefined();
  });

  test('rejects when gate-computed R:R is below the skill minimum — even if the model claims otherwise', () => {
    // entry 1.0845, sl 1.0840, tp 1.0850 -> rr 1.0 (model says nothing different; gate computes)
    const tightResult = parseReasoningResult({
      ...JSON.parse(JSON.stringify(VALID_RESULT)),
      proposal: {
        ...VALID_RESULT.proposal,
        stopLoss: 1.084,
        takeProfit: 1.085,
      },
    });
    const strictSkills = [
      {
        id: 's', userId: 'system', name: 'Strict', description: '', methodology: '',
        constraints: 'MINIMUM_RR_2_TO_1', preferredTimeframes: ['1h'], requiredEvidence: '', invalidationRules: '',
        createdAt: '', updatedAt: '',
      },
    ] as TradingSkill[];
    const result = gate(tightResult, makeThesis(), aggregateHardConstraints(strictSkills));
    expect(result.approved).toBe(false);
    expect(result.signal.status).toBe('NO_TRADE');
    expect(result.reasons.join()).toContain('below the required minimum');
  });

  test('enforces LIMIT_ORDERS_ONLY: rejects MARKET orders', () => {
    const marketResult = parseReasoningResult({
      ...JSON.parse(JSON.stringify(VALID_RESULT)),
      proposal: { ...VALID_RESULT.proposal, orderType: 'MARKET' },
    });
    const skills = [
      {
        id: 's', userId: 'system', name: 'LOO', description: '', methodology: '',
        constraints: 'LIMIT_ORDERS_ONLY', preferredTimeframes: ['1h'], requiredEvidence: '', invalidationRules: '',
        createdAt: '', updatedAt: '',
      },
    ] as TradingSkill[];
    const result = gate(marketResult, makeThesis(), aggregateHardConstraints(skills));
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toContain('LIMIT_ORDERS_ONLY');
  });

  test('enforces NO_COUNTER_TREND against thesis bias', () => {
    const shortResult = parseReasoningResult({
      ...JSON.parse(JSON.stringify(VALID_RESULT)),
      thesis: { ...VALID_RESULT.thesis, directionalBias: 'BEARISH' },
      proposal: {
        ...VALID_RESULT.proposal,
        direction: 'SHORT',
        entry: 1.0850,
        stopLoss: 1.0875,
        takeProfit: 1.0800,
        rationale: 'Counter trend test.',
      },
      evidence: [
        { source: 'STRUCTURE', market: 'EUR/USD', observation: 'LH established.', classification: 'SUPPORTING' },
        { source: 'RSI_14', market: 'EUR/USD', observation: 'RSI rolling over.', classification: 'SUPPORTING' },
      ],
    });
    const skills = [
      {
        id: 's', userId: 'system', name: 'NCT', description: '', methodology: '',
        constraints: 'NO_COUNTER_TREND', preferredTimeframes: ['1h'], requiredEvidence: '', invalidationRules: '',
        createdAt: '', updatedAt: '',
      },
    ] as TradingSkill[];
    const result = gate(shortResult, makeThesis({ directionalHypothesis: 'BULLISH' }), aggregateHardConstraints(skills));
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toContain('NO_COUNTER_TREND');
  });

  test('enforces SPREAD_UNDER_X_PIPS against the actual quote', () => {
    const skills = [
      {
        id: 's', userId: 'system', name: 'Spread', description: '', methodology: '',
        constraints: 'SPREAD_UNDER_0_5_PIPS', preferredTimeframes: ['1h'], requiredEvidence: '', invalidationRules: '',
        createdAt: '', updatedAt: '',
      },
    ] as TradingSkill[];
    const result = gate(VALID_RESULT, makeThesis(), aggregateHardConstraints(skills));
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toContain('Spread');
  });

  test('rejects low-confidence thesis (platform floor 70)', () => {
    const result = gate(VALID_RESULT, makeThesis({ confidence: 55 }));
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toContain('confidence');
  });

  test('rejects when supporting evidence is below minimum', () => {
    const weakResult = parseReasoningResult({
      ...JSON.parse(JSON.stringify(VALID_RESULT)),
      evidence: [{ source: 'STRUCTURE', market: 'EUR/USD', observation: 'One item only.', classification: 'SUPPORTING' }],
    });
    const result = gate(weakResult);
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toContain('evidence');
  });

  test('NO_TRADE model decisions pass through with noTradeReason', () => {
    const noTrade = parseReasoningResult({
      investigation: { summary: 'Mixed.' },
      thesis: { directionalBias: 'NEUTRAL', summary: 'No edge.', confidence: 40, trackers: [] },
      proposal: { decision: 'NO_TRADE', noTradeReason: 'Not enough confluence.' },
      evidence: [],
    });
    const result = gate(noTrade);
    expect(result.approved).toBe(false);
    expect(result.signal.status).toBe('NO_TRADE');
    expect(result.reasons[0]).toContain('Not enough confluence');
  });

  test('SHORT price-structure violations are caught deterministically', () => {
    const badShort = parseReasoningResult({
      ...JSON.parse(JSON.stringify(VALID_RESULT)),
      proposal: {
        ...VALID_RESULT.proposal,
        direction: 'SHORT',
        entry: 1.0850,
        stopLoss: 1.0830, // stop below entry on a SHORT = invalid
        takeProfit: 1.0860,
        rationale: 'Broken structure test.',
        invalidation: 'Above 1.0880.',
      },
      evidence: [
        { source: 'STRUCTURE', market: 'EUR/USD', observation: 'LH.', classification: 'SUPPORTING' },
        { source: 'RSI_14', market: 'EUR/USD', observation: 'Rolling over.', classification: 'SUPPORTING' },
      ],
    });
    const result = gate(badShort, makeThesis({ directionalHypothesis: 'BEARISH' }));
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toContain('SHORT');
  });

  test('approves a valid SHORT LIMIT setup and recomputes its R:R itself', () => {
    const shortResult = parseReasoningResult({
      investigation: { summary: 'Bearish rejection from supply.' },
      thesis: { directionalBias: 'BEARISH', summary: 'Lower high into supply.', confidence: 82, invalidation: 'Close above 1.0880.', trackers: [] },
      proposal: {
        decision: 'ACTIONABLE',
        triggerSequence: ['EMA(20) crosses below 1.0880', 'supply retest confirmed on a 15m close'],
        direction: 'SHORT',
        orderType: 'LIMIT',
        market: 'EUR/USD',
        entry: 1.0860,
        stopLoss: 1.0880,
        takeProfit: 1.0810,
        rationale: 'Supply retest.',
        confirmationRequired: '15m rejection at supply.',
        invalidation: 'Close above 1.0880.',
      },
      evidence: [
        { source: 'STRUCTURE', market: 'EUR/USD', observation: 'Lower high formed.', classification: 'SUPPORTING' },
        { source: 'RSI_14', market: 'EUR/USD', observation: 'RSI rejecting 65.', classification: 'SUPPORTING' },
      ],
    });
    const result = gate(shortResult, makeThesis({ directionalHypothesis: 'BEARISH' }));
    expect(result.approved).toBe(true);
    expect(result.signal.direction).toBe('SHORT');
    expect(result.signal.orderType).toBe('LIMIT');
    expect(result.signal.status).toBe('ACTIONABLE');
    // rr = (1.0860-1.0810)/(1.0880-1.0860) = 2.5, computed by the gate
    expect(result.signal.riskReward).toBe('1:2.5');
  });

  test('rejects an ACTIONABLE proposal with missing invalidation when the skill requires it', () => {
    const parsed = parseReasoningResult(JSON.parse(JSON.stringify(VALID_RESULT)));
    // Simulate an upstream path that failed to carry invalidation through:
    const stripped = { ...parsed, proposal: { ...parsed.proposal, invalidation: undefined } };
    const result = gate(stripped);
    expect(result.approved).toBe(false);
    expect(result.reasons.join()).toMatch(/invalidation/i);
  });
});
