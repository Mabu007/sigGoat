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
  /**
   * A MALFORMED PROPOSAL IS DOWNGRADED, NEVER EXECUTED.
   *
   * The proposal is the only part of a model result that can become an
   * order, so a proposal the validator does not accept is replaced with a
   * NO_TRADE that records WHY it was refused. The result is still returned
   * — the investigation and the thesis may be perfectly good — but it can
   * no longer be acted on.
   *
   * The INVESTIGATION and the THESIS are different: a malformed one means
   * the model produced fiction, and a result built on fiction is rejected
   * whole rather than patched into something that looks authoritative.
   */
  function expectRefusedProposal(
    result: ReturnType<typeof parseReasoningResult>,
    issueFragment: string,
  ): void {
    expect(result.proposal.decision).toBe('NO_TRADE');
    expect(String(result.proposal.noTradeReason)).toContain(issueFragment);
    // Nothing that could reach an order survives the downgrade.
    expect(result.proposal.direction).toBeUndefined();
    expect(result.proposal.entry).toBeUndefined();
    expect(result.proposal.stopLoss).toBeUndefined();
    expect(result.proposal.triggerSequence ?? []).toEqual([]);
  }

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

  test('refuses an overloaded direction (BULLISH) — bias is not direction', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, direction: 'BULLISH' },
    };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'direction');
  });

  test('refuses an overloaded orderType (BUY_LIMIT) — order type is LIMIT/STOP/MARKET', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, orderType: 'BUY_LIMIT' },
    };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'orderType');
  });

  test('refuses an ACTIONABLE proposal that is missing its stopLoss', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, stopLoss: undefined },
    };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'stopLoss');
  });

  test('refuses a NO_TRADE that does not say why', () => {
    const bad = {
      ...VALID_NO_TRADE,
      proposal: { decision: 'NO_TRADE' },
    };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'noTradeReason');
  });

  test('a malformed THESIS rejects the whole result, not just the proposal', () => {
    // The thesis is the reasoning. A thesis with an impossible bias and an
    // impossible confidence is fiction, and a result built on fiction is
    // refused WHOLE rather than patched into something that looks
    // authoritative.
    const bad = {
      investigation: { summary: '' },
      thesis: { directionalBias: 'SIDEWAYS', summary: 'x', confidence: 150, trackers: [] },
      proposal: { decision: 'ACTIONABLE' },
      evidence: [],
    };
    let thrown: unknown;
    try {
      parseReasoningResult(bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReasoningValidationError);
    const issues = (thrown as ReasoningValidationError).issues.join();
    expect(issues).toContain('malformed');
    expect(issues).toContain('thesis');
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

  test('refuses NaN/Infinity prices', () => {
    const bad = {
      ...VALID_ACTIONABLE,
      proposal: { ...VALID_ACTIONABLE.proposal, entry: Number.POSITIVE_INFINITY },
    };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'entry');
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

  test('refuses a malformed proposal with an invalid decision enum', () => {
    const bad = {
      ...VALID_NO_TRADE,
      proposal: { decision: 'MAYBE', noTradeReason: 'unclear' },
    };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'proposal.decision');
  });

  test('refuses a proposal that is not an object', () => {
    const bad = { ...VALID_NO_TRADE, proposal: 'just a string' };
    const result = parseReasoningResult(bad);
    expectRefusedProposal(result, 'proposal');
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
