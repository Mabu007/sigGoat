import { describe, test, expect } from 'bun:test';
import { parseReasoningResult, ReasoningValidationError, seededRandom, hashString } from '../src/services/agent/contracts';

const VALID_ACTIONABLE = {
  investigation: { summary: 'Structure is bullish on 1h.' },
  thesis: {
    directionalBias: 'BULLISH',
    summary: 'Bullish continuation after liquidity sweep.',
    confidence: 85,
    invalidation: 'Close below 1.0800 invalidates.',
    observationPlan: 'Watch 1.0845 demand.',
    trackers: [
      { description: 'Price above 1.0845', type: 'PRICE_LEVEL', targetValue: 1.0845, operator: 'GREATER_THAN' },
    ],
  },
  proposal: {
    decision: 'ACTIONABLE',
    triggerSequence: ['EMA(20) crosses above 1.0840', 'price holds above 1.0840 on a 15m close'],
    direction: 'LONG',
    orderType: 'LIMIT',
    market: 'EUR/USD',
    entry: 1.0845,
    stopLoss: 1.082,
    takeProfit: 1.092,
    confidence: 85,
    rationale: 'Demand zone retest after sweep.',
    confirmationRequired: 'Close above 1.0845 on 15m.',
    invalidation: 'Close below 1.0800.',
  },
  evidence: [
    { source: 'STRUCTURE', market: 'EUR/USD', observation: 'Higher high established.', classification: 'SUPPORTING' },
    { source: 'RSI_14', market: 'EUR/USD', observation: 'RSI recovering from 40.', classification: 'SUPPORTING' },
  ],
};

const VALID_NO_TRADE = {
  investigation: { summary: 'Mixed structure.' },
  thesis: { directionalBias: 'NEUTRAL', summary: 'No edge.', confidence: 30, trackers: [] },
  proposal: { decision: 'NO_TRADE', noTradeReason: 'Evidence insufficient.' },
  evidence: [],
};

describe('parseReasoningResult', () => {
  test('accepts a fully valid canonical ACTIONABLE result', () => {
    const result = parseReasoningResult(VALID_ACTIONABLE);
    expect(result.proposal.decision).toBe('ACTIONABLE');
    expect(result.proposal.direction).toBe('LONG');
    expect(result.proposal.orderType).toBe('LIMIT');
    expect(result.thesis.trackers.length).toBe(1);
    expect(result.evidence.length).toBe(2);
  });

  test('accepts a valid NO_TRADE result', () => {
    const result = parseReasoningResult(VALID_NO_TRADE);
    expect(result.proposal.decision).toBe('NO_TRADE');
    expect(result.proposal.noTradeReason).toContain('insufficient');
  });

  test('rejects overloaded direction (BULLISH) — bias is not direction', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, direction: 'BULLISH' },
    };
    expect(() => parseReasoningResult(bad)).toThrow(ReasoningValidationError);
  });

  test('rejects overloaded orderType (BUY_LIMIT) — order type is LIMIT/STOP/MARKET', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, orderType: 'BUY_LIMIT' },
    };
    expect(() => parseReasoningResult(bad)).toThrow(ReasoningValidationError);
  });

  test('rejects ACTIONABLE missing stopLoss', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, stopLoss: undefined },
    };
    try {
      parseReasoningResult(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReasoningValidationError);
      expect((err as ReasoningValidationError).issues.join()).toContain('stopLoss');
    }
  });

  test('rejects NO_TRADE without noTradeReason', () => {
    const bad = {
      ...VALID_NO_TRADE,
      proposal: { decision: 'NO_TRADE' },
    };
    expect(() => parseReasoningResult(bad)).toThrow(/noTradeReason/);
  });

  test('collects MULTIPLE issues in one pass, not fail-fast', () => {
    const bad = {
      investigation: { summary: '' },
      thesis: { directionalBias: 'SIDEWAYS', summary: 'x', confidence: 150, trackers: [] },
      proposal: { decision: 'ACTIONABLE' },
      evidence: [],
    };
    try {
      parseReasoningResult(bad);
      expect.unreachable();
    } catch (err) {
      const issues = (err as ReasoningValidationError).issues;
      expect(issues.length).toBeGreaterThan(2);
      expect(issues.some((i) => i.includes('directionalBias'))).toBe(true);
      expect(issues.some((i) => i.includes('confidence'))).toBe(true);
      expect(issues.some((i) => i.includes('proposal'))).toBe(true);
    }
  });

  test('rejects non-object input entirely', () => {
    expect(() => parseReasoningResult('hello')).toThrow(ReasoningValidationError);
    expect(() => parseReasoningResult(null)).toThrow(ReasoningValidationError);
    expect(() => parseReasoningResult([1, 2])).toThrow(ReasoningValidationError);
  });

  test('accepts numeric strings for prices (models often quote numbers as strings)', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, entry: '1.0845', stopLoss: '1.0820', takeProfit: '1.0920' },
    };
    const result = parseReasoningResult(bad);
    expect(result.proposal.entry).toBe(1.0845);
  });

  test('rejects NaN/Infinity prices', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, entry: Number.POSITIVE_INFINITY },
    };
    expect(() => parseReasoningResult(bad)).toThrow(ReasoningValidationError);
  });

  test('rejects a response missing the thesis section entirely', () => {
    const { thesis: _thesis, ...withoutThesis } = VALID_ACTIONABLE;
    try {
      parseReasoningResult(withoutThesis);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReasoningValidationError);
      const issues = (err as ReasoningValidationError).issues;
      expect(issues.some((i) => i.includes('thesis'))).toBe(true);
    }
  });

  test('rejects a response missing the investigation section entirely', () => {
    const { investigation: _inv, ...withoutInvestigation } = VALID_ACTIONABLE;
    try {
      parseReasoningResult(withoutInvestigation);
      expect.unreachable();
    } catch (err) {
      const issues = (err as ReasoningValidationError).issues;
      expect(issues.some((i) => i.includes('investigation'))).toBe(true);
    }
  });

  test('rejects a malformed proposal with an invalid decision enum', () => {
    const bad = {
      ...VALID_NO_TRADE,
      proposal: { decision: 'MAYBE', noTradeReason: 'unclear' },
    };
    try {
      parseReasoningResult(bad);
      expect.unreachable();
    } catch (err) {
      const issues = (err as ReasoningValidationError).issues;
      expect(issues.some((i) => i.includes('proposal.decision'))).toBe(true);
    }
  });

  test('rejects a proposal that is not an object', () => {
    const bad = { ...VALID_NO_TRADE, proposal: 'just a string' };
    expect(() => parseReasoningResult(bad)).toThrow(ReasoningValidationError);
  });
});

describe('shared deterministic utilities', () => {
  test('seededRandom is deterministic and in [0,1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      const va = a();
      expect(b()).toBe(va);
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });

  test('hashString is stable', () => {
    expect(hashString('signalgoat')).toBe(hashString('signalgoat'));
    expect(hashString('signalgoat')).not.toBe(hashString('signalgoatx'));
  });
});
