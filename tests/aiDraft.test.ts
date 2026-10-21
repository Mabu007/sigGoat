import { describe, test, expect } from 'bun:test';
import { draftStrategy } from '../src/services/strategy/aiDrafting';
import {
  buildAiDraftPrompt,
  buildFallbackDraft,
  draftGaps,
  draftToDefinition,
  draftToEditorModel,
  parseAiDraft,
  type AiDraft,
} from '../src/services/strategy/aiDraft';

/**
 * AI DRAFTING
 * ===========
 *
 * The model is an external service, so what is tested here is everything
 * this repository is responsible for: the prompt carries the real catalog,
 * the answer is validated against a strict schema, an incomplete draft stays
 * incomplete, a broken answer produces a clearly labelled fallback, and a
 * missing provider produces an honest error instead of a made up strategy.
 *
 * The five natural-language examples from the specification are covered
 * below with the answers a model would give for them.
 */

const run = (answer: string, prompt = 'Look for liquidity sweeps and buy.') => draftStrategy({
  prompt,
  hasProvider: async () => true,
  pickModel: async () => 'test/model',
  provider: async () => 'openrouter',
  askModel: async () => answer,
});

/** A model answer, wrapped the way a provider would wrap it. */
const asAnswer = (draft: Record<string, unknown>) => `Here is your draft:\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``;

describe('the prompt', () => {
  test('carries the whole indicator catalog and the price-action vocabulary', () => {
    const prompt = buildAiDraftPrompt('Buy when RSI crosses above 30.');
    expect(prompt).toContain('RSI — Relative Strength Index (RSI)');
    expect(prompt).toContain('MACD — Moving Average Convergence Divergence (MACD)');
    expect(prompt).toContain('BULLISH_SWEEP');
    expect(prompt).toContain('sequence');
    expect(prompt).toContain('Buy when RSI crosses above 30.');
  });
});

describe('example A — a complete request', () => {
  const prompt = 'Buy BTC on the 15-minute chart when RSI 14 crosses above 30 and price is above EMA 200. Stop loss 1%, take profit 2%.';
  const answer = asAnswer({
    status: 'READY',
    name: 'BTC RSI recovery',
    description: prompt,
    direction: 'LONG',
    market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '15m' },
    indicators: [
      { ref: 'rsi', key: 'RSI', params: { period: 14 } },
      { ref: 'ema', key: 'EMA', params: { period: 200 } },
    ],
    entry: {
      type: 'all',
      conditions: [
        { type: 'comparison', left: { kind: 'indicator', indicator: 'rsi' }, operator: 'CROSS_ABOVE', right: { kind: 'constant', value: 30 } },
        { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'GT', right: { kind: 'indicator', indicator: 'ema' } },
      ],
    },
    exit: null,
    risk: { sizingMode: 'PERCENT_RISK', sizingValue: 1, stopLossPercent: 1, takeProfitPercent: 2 },
    missingFields: [],
    ambiguities: [],
    unsupported: [],
    assumptions: [],
  });

  test('becomes a complete, executable strategy', async () => {
    const outcome = await run(answer, prompt);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.draft.status).toBe('READY');
    expect(outcome.gaps.length).toBe(0);

    const result = draftToDefinition(outcome.draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(result.errors).toEqual([]);
    const definition = result.definition!;
    expect(definition.market.instrument).toBe('BTC');
    expect(definition.market.timeframe).toBe('15m');
    expect(definition.entry.direction).toBe('LONG');
    expect(definition.indicators.map(item => `${item.type}:${item.params.period}`)).toEqual(['RSI:14', 'EMA:200']);
    expect(definition.entry.condition.type).toBe('all');
    expect(definition.risk.stopLossPercent).toBe(1);
    expect(definition.risk.takeProfitPercent).toBe(2);
  });
});

describe('example B — a temporal relationship', () => {
  const prompt = 'Sell gold when there is a bearish liquidity sweep followed by a bearish engulfing.';
  const answer = asAnswer({
    status: 'NEEDS_INPUT',
    direction: 'SHORT',
    market: { provider: 'hyperliquid', instrument: 'GOLD', timeframe: null },
    indicators: [],
    entry: {
      type: 'sequence',
      steps: [
        { type: 'price_action', pattern: 'BEARISH_SWEEP', params: { lookback: 20 } },
        { type: 'price_action', pattern: 'BEARISH_ENGULFING', params: {} },
      ],
      maxGapCandles: 5,
    },
    exit: null,
    risk: { stopLossPercent: 1, takeProfitPercent: 2, sizingMode: 'PERCENT_RISK', sizingValue: 1 },
    missingFields: ['market.timeframe'],
    ambiguities: [],
    unsupported: [],
    assumptions: [{ field: 'entry.maxGapCandles', value: '5', reason: 'The request did not say how far apart the two candles may be.' }],
  });

  test('keeps the "followed by" relationship instead of turning it into AND', async () => {
    const outcome = await run(answer, prompt);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    // The user fills the missing timeframe in the editor, and only then can
    // the draft become an executable strategy.
    const incomplete = draftToDefinition(outcome.draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(incomplete.definition).toBeUndefined();
    const result = draftToDefinition(outcome.draft, { strategyId: 'draft_strategy', versionId: 'draft_version', defaults: { timeframe: '1h' } });
    expect(result.errors).toEqual([]);
    const condition = result.definition!.entry.condition;
    expect(condition.type).toBe('sequence');
    if (condition.type !== 'sequence') return;
    expect(condition.steps).toHaveLength(2);
    expect(condition.steps[0].type).toBe('price_action');
    expect(condition.maxGapCandles).toBe(5);
  });

  test('the missing timeframe is reported instead of guessed', async () => {
    const outcome = await run(answer, prompt);
    if (outcome.status !== 'ok') return;
    const fields = outcome.gaps.map(gap => gap.field);
    expect(fields).toContain('market.timeframe');
    const result = draftToDefinition(outcome.draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(result.errors).toContain('The timeframe is still missing.');
    expect(result.definition).toBeUndefined();
  });
});

describe('example C — a request with an unresolved interpretation', () => {
  const prompt = 'Buy when the MACD histogram crosses above zero and the Bollinger Bands are expanding.';
  const answer = asAnswer({
    status: 'NEEDS_INPUT',
    direction: 'LONG',
    market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '1h' },
    indicators: [
      { ref: 'macd', key: 'MACD', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, output: 'histogram' },
    ],
    entry: {
      type: 'all',
      conditions: [
        { type: 'comparison', left: { kind: 'indicator', indicator: 'macd', output: 'histogram' }, operator: 'CROSS_ABOVE', right: { kind: 'constant', value: 0 } },
      ],
    },
    exit: null,
    risk: { sizingMode: 'PERCENT_RISK', sizingValue: 1, stopLossPercent: 1, takeProfitPercent: 2 },
    missingFields: ['entry.conditions.1'],
    ambiguities: ['"Bollinger Bands are expanding" was read as the Bollinger Band Width rising. Confirm the reading.'],
    unsupported: [],
    assumptions: [],
  });

  test('translates the crossover and keeps the expansion open for review', async () => {
    const outcome = await run(answer, prompt);
    if (outcome.status !== 'ok') return;
    expect(outcome.draft.ambiguities.length).toBe(1);
    const condition = outcome.draft.entry!;
    expect(condition.type).toBe('all');
    if (condition.type !== 'all') return;
    const comparison = condition.conditions[0];
    expect(comparison.type).toBe('comparison');
    if (comparison.type !== 'comparison') return;
    expect(comparison.left).toEqual({ kind: 'indicator', indicator: 'macd', output: 'histogram' });
    expect(comparison.operator).toBe('CROSS_ABOVE');
    // The unresolved reading is not silently turned into a rule.
    expect(condition.conditions).toHaveLength(1);
  });
});

describe('example D — a request that has no mathematical definition', () => {
  const prompt = 'Trade when smart money enters the market.';

  test('returns an editable draft with an ambiguity instead of inventing a rule', async () => {
    const answer = asAnswer({
      status: 'NEEDS_INPUT',
      direction: null,
      market: { provider: 'hyperliquid', instrument: null, timeframe: null },
      indicators: [],
      entry: null,
      exit: null,
      risk: {},
      missingFields: ['market.instrument', 'market.timeframe', 'direction', 'entry', 'risk.stopLossPercent', 'risk.takeProfitPercent', 'risk.sizing'],
      ambiguities: ['"Smart money enters the market" needs a measurable condition before it can be run. A volume spike, a liquidity sweep or a break of structure would each be a different strategy.'],
      unsupported: [],
      assumptions: [],
    });
    const outcome = await run(answer, prompt);
    if (outcome.status !== 'ok') return;
    expect(outcome.draft.entry).toBeNull();
    expect(outcome.draft.ambiguities.length).toBe(1);
    expect(outcome.draft.ambiguities[0]).toContain('measurable condition');
    const fields = outcome.gaps.map(gap => gap.field);
    expect(fields).toContain('entry');
    expect(fields).toContain('market.instrument');
    const result = draftToDefinition(outcome.draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(result.definition).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('example E — a breakout with a volume filter', () => {
  const prompt = 'Buy after a breakout above the previous 20 candles high, provided the volume is 1.5 times its 20-period average.';

  test('translates the breakout and the volume condition', async () => {
    const answer = asAnswer({
      status: 'READY',
      direction: 'LONG',
      market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '15m' },
      indicators: [],
      entry: {
        type: 'all',
        conditions: [
          { type: 'price_action', pattern: 'BREAKOUT_HIGH', params: { lookback: 20, requireVolumeConfirmation: true, volumeMultiplier: 1.5, volumePeriod: 20 } },
        ],
      },
      exit: null,
      risk: { sizingMode: 'PERCENT_RISK', sizingValue: 1, stopLossPercent: 1, takeProfitPercent: 2 },
      missingFields: [],
      ambiguities: [],
      unsupported: [],
      assumptions: [],
    });
    const outcome = await run(answer, prompt);
    if (outcome.status !== 'ok') return;
    const result = draftToDefinition(outcome.draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(result.errors).toEqual([]);
    const condition = result.definition!.entry.condition;
    if (condition.type !== 'all') throw new Error('expected a group');
    const action = condition.conditions[0];
    if (action.type !== 'price_action') throw new Error('expected a price action');
    expect(action.pattern).toBe('BREAKOUT_HIGH');
    expect(action.params.lookback).toBe(20);
    expect(action.params.requireVolumeConfirmation).toBe(true);
    expect(action.params.volumeMultiplier).toBe(1.5);
    expect(action.params.volumePeriod).toBe(20);
  });
});

describe('missing information', () => {
  test('a draft without an instrument, a timeframe or a risk plan lists every gap', () => {
    const draft: AiDraft = {
      status: 'NEEDS_INPUT',
      source: 'ai',
      name: null,
      description: '',
      direction: 'LONG',
      market: { provider: 'hyperliquid', instrument: null, timeframe: null },
      indicators: [],
      entry: { type: 'price_action', pattern: 'BULLISH_SWEEP', params: { lookback: null } },
      exit: null,
      risk: { sizingMode: null, sizingValue: null, stopLossPercent: null, takeProfitPercent: null, maxExposurePercent: null, maxTradesPerDay: null, cooldownCandles: null, maxDailyLossPercent: null },
      missingFields: [],
      ambiguities: [],
      unsupported: [],
      assumptions: [],
      prompt: 'Look for liquidity sweeps and buy.',
    };
    const gaps = draftGaps(draft).map(gap => gap.field);
    expect(gaps).toContain('market.instrument');
    expect(gaps).toContain('market.timeframe');
    expect(gaps).toContain('risk.stopLossPercent');
    expect(gaps).toContain('risk.takeProfitPercent');
    expect(gaps).toContain('risk.sizing');
    expect(gaps).toContain('entry.params.lookback');

    const result = draftToDefinition(draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(result.definition).toBeUndefined();
    expect(result.errors).toContain('The market is still missing.');
    expect(result.errors).toContain('The stop loss is still missing.');
  });

  test('a draft that names an unsupported indicator is reported, not silently dropped', () => {
    const draft: AiDraft = {
      status: 'NEEDS_INPUT',
      source: 'ai',
      name: null,
      description: '',
      direction: 'LONG',
      market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '1h' },
      indicators: [{ ref: 'x', key: 'SUPER_OSCILLATOR', params: {}, output: null }],
      entry: null,
      exit: null,
      risk: { sizingMode: 'PERCENT_RISK', sizingValue: 1, stopLossPercent: 1, takeProfitPercent: 2, maxExposurePercent: null, maxTradesPerDay: null, cooldownCandles: null, maxDailyLossPercent: null },
      missingFields: [],
      ambiguities: [],
      unsupported: ['The Super Oscillator is not available.'],
      assumptions: [],
      prompt: 'Use the super oscillator.',
    };
    const gaps = draftGaps(draft).map(gap => gap.field);
    expect(gaps).toContain('indicators.x.key');
    const result = draftToDefinition(draft, { strategyId: 'draft_strategy', versionId: 'draft_version' });
    expect(result.definition).toBeUndefined();
  });

  test('an unsupported temporal relationship is kept as an unsupported note', () => {
    const draft: AiDraft = {
      status: 'NEEDS_INPUT',
      source: 'ai',
      name: null,
      description: '',
      direction: 'LONG',
      market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '1h' },
      indicators: [],
      entry: null,
      exit: null,
      risk: { sizingMode: 'PERCENT_RISK', sizingValue: 1, stopLossPercent: 1, takeProfitPercent: 2, maxExposurePercent: null, maxTradesPerDay: null, cooldownCandles: null, maxDailyLossPercent: null },
      missingFields: [],
      ambiguities: [],
      unsupported: ['A condition that is only true after three other conditions, in any order, is not supported.'],
      assumptions: [],
      prompt: 'Trade only after three confirmations, in any order.',
    };
    expect(draft.unsupported.length).toBe(1);
    const model = draftToEditorModel(draft, 'x');
    expect(model.gaps.map(gap => gap.field)).toContain('entry');
  });
});

describe('broken model answers', () => {
  test('an answer that is not JSON is reported and never becomes a strategy', () => {
    const parsed = parseAiDraft('I think you should buy when the market looks good.');
    expect(parsed.draft).toBeUndefined();
    expect(parsed.error).toBeTruthy();
  });

  test('an answer that is JSON but not a draft is rejected by the schema', () => {
    const parsed = parseAiDraft(JSON.stringify({ status: 'READY', entry: { type: 'comparison' }, unexpected: true }));
    expect(parsed.draft).toBeUndefined();
    expect(parsed.error).toContain('did not match the expected shape');
  });

  test('a broken answer produces a clearly labelled fallback, not a fabricated strategy', async () => {
    const outcome = await run('this is not json at all', 'Look for liquidity sweeps and buy.');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.draft.source).toBe('pattern-fallback');
    expect(outcome.warnings.length).toBeGreaterThan(0);
    expect(outcome.draft.entry?.type).toBe('price_action');
    // The fallback never invents a market, a timeframe or a risk plan.
    expect(outcome.draft.market.instrument).toBeNull();
    expect(outcome.draft.market.timeframe).toBeNull();
    expect(outcome.draft.risk.stopLossPercent).toBeNull();
  });

  test('a provider timeout produces a labelled fallback and a warning', async () => {
    const outcome = await draftStrategy({
      prompt: 'Look for liquidity sweeps and buy.',
      hasProvider: async () => true,
      pickModel: async () => 'test/model',
      provider: async () => 'openrouter',
      askModel: async () => { throw new Error('The AI provider did not answer in time.'); },
      timeoutMs: 50,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.warnings[0]).toContain('did not answer in time');
    expect(outcome.draft.source).toBe('pattern-fallback');
  });

  test('a provider that is not configured keeps the prompt and explains itself', async () => {
    const outcome = await draftStrategy({
      prompt: 'Look for liquidity sweeps and buy.',
      hasProvider: async () => false,
      pickModel: async () => null,
      provider: async () => 'openrouter',
      askModel: async () => 'never called',
    });
    expect(outcome.status).toBe('provider_unavailable');
    if (outcome.status !== 'provider_unavailable') return;
    expect(outcome.prompt).toBe('Look for liquidity sweeps and buy.');
    expect(outcome.message.toLowerCase()).toContain('manual robot creation remains available');
  });

  test('a provider with no usable model is reported honestly', async () => {
    const outcome = await draftStrategy({
      prompt: 'Look for liquidity sweeps and buy.',
      hasProvider: async () => true,
      pickModel: async () => null,
      provider: async () => 'openrouter',
      askModel: async () => 'never called',
    });
    expect(outcome.status).toBe('model_unavailable');
  });

  test('a prompt that is too short is refused before any model is called', async () => {
    let called = false;
    const outcome = await draftStrategy({
      prompt: 'buy',
      hasProvider: async () => true,
      pickModel: async () => 'test/model',
      provider: async () => 'openrouter',
      askModel: async () => { called = true; return '{}'; },
    });
    expect(outcome.status).toBe('invalid_prompt');
    expect(called).toBe(false);
  });
});

describe('the editor model', () => {
  test('an incomplete draft opens in the editor with its gaps visible', () => {
    const draft: AiDraft = {
      status: 'NEEDS_INPUT',
      source: 'ai',
      name: 'Sweep buyer',
      description: 'Buys sweeps',
      direction: 'LONG',
      market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: null },
      indicators: [{ ref: 'rsi', key: 'RSI', params: { period: 14 }, output: null }],
      entry: { type: 'price_action', pattern: 'BULLISH_SWEEP', params: { lookback: null } },
      exit: null,
      risk: { sizingMode: null, sizingValue: null, stopLossPercent: 1, takeProfitPercent: null, maxExposurePercent: null, maxTradesPerDay: null, cooldownCandles: null, maxDailyLossPercent: null },
      missingFields: [],
      ambiguities: [],
      unsupported: [],
      assumptions: [],
      prompt: 'Buy RSI sweeps on BTC',
    };
    const model = draftToEditorModel(draft, 'Buy RSI sweeps on BTC');
    expect(model.name).toBe('Sweep buyer');
    expect(model.instrument).toBe('BTC');
    expect(model.indicators).toHaveLength(1);
    expect(model.indicators[0].id).toMatch(/^ind_1_/);
    expect(model.indicators[0].type).toBe('RSI');
    expect(model.indicators[0].params.period).toBe(14);
    expect(model.gaps.map(gap => gap.field)).toContain('market.timeframe');
    expect(model.gaps.map(gap => gap.field)).toContain('entry.params.lookback');
    // The fields the model filled in are marked as provided.
    expect(model.provided).toContain('market.instrument');
    expect(model.provided).toContain('risk.stopLossPercent');
    expect(model.provided).not.toContain('market.timeframe');
  });

  test('the fallback draft is honest about what it recognised', () => {
    const draft = buildFallbackDraft('Look for liquidity sweeps and buy.');
    expect(draft.source).toBe('pattern-fallback');
    expect(draft.status).toBe('NEEDS_INPUT');
    expect(draft.direction).toBe('LONG');
    expect(draft.entry?.type).toBe('price_action');
    expect(draft.ambiguities.length).toBe(1);
    expect(draft.market.instrument).toBeNull();
  });

  test('the fallback does not pretend to understand an unrelated request', () => {
    const draft = buildFallbackDraft('Make me a sandwich and a strategy for the moon.');
    expect(draft.entry).toBeNull();
    expect(draft.ambiguities[0]).toContain('could not be matched');
  });
});
