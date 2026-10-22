import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReasoningResult } from '../src/services/agent/contracts';
import { ReasoningWireSchema, reasoningJsonSchema } from '../src/services/agent/reasoningWireSchema';
import { SignalGate } from '../src/services/agent/SignalGate';
import { aggregateHardConstraints } from '../src/services/agent/SkillConstraints';
import { GoatWorkflowStore, RobotRunAnalysisSchema } from '../src/server/GoatWorkflowStore';
import { NewsService } from '../src/services/news/NewsService';
import { OpenRouterClient } from '../src/services/ai/OpenRouterClient';

test('fractional model confidence becomes percentage points before deterministic gating', () => {
  const result = parseReasoningResult({
    investigation: { summary: 'Bullish demand retest.', marketView: 'Higher highs.' },
    thesis: { directionalBias: 'BULLISH', summary: 'Bullish.', confidence: 0.85, trackers: [], invalidation: 'Close below demand.' },
    proposal: { decision: 'ACTIONABLE', triggerSequence: ['15m close above demand'], direction: 'LONG', orderType: 'LIMIT', market: 'BTC', entry: 100, stopLoss: 98, takeProfit: 106, rationale: 'Demand holds.', invalidation: 'Close below 98.' },
    evidence: [{ source: 'STRUCTURE', market: 'BTC', observation: 'Higher high.', classification: 'SUPPORTING' }, { source: 'EMA', market: 'BTC', observation: 'Trend aligned.', classification: 'SUPPORTING' }],
  });
  assert.equal(result.thesis.confidence, 85);
  const now = new Date().toISOString();
  const gate = SignalGate.validate({ reasoningResult: result, thesis: { id: 't1', goatId: 'g1', userId: 'u1', market: 'BTC', directionalHypothesis: 'BULLISH', summary: 'Bullish.', supportingEvidence: [], relevantTimeframe: '1h', confirmationConditions: [], invalidationConditions: [], observationPlan: '', trackers: [], confidence: result.thesis.confidence, status: 'TRACKING', createdAt: now, updatedAt: now }, quote: { symbol: 'BTC', bid: 99.9, ask: 100.1, mid: 100, spread: 0.2, change24h: 0, change24hPct: 0, high24h: 101, low24h: 98, timestamp: Date.now() }, market: 'BTC', constraints: aggregateHardConstraints([]), goatId: 'g1', userId: 'u1' });
  assert.equal(gate.reasons.some(reason => reason.includes('confidence')), false);
});

test('Zod wire schema enforces required fields and generates strict JSON Schema', () => {
  assert.equal(ReasoningWireSchema.safeParse({ investigation: {}, thesis: {}, proposal: {}, evidence: [] }).success, false);
  assert.equal((reasoningJsonSchema as { additionalProperties?: boolean }).additionalProperties, false);
  assert.deepEqual((reasoningJsonSchema as { required?: string[] }).required, ['investigation', 'thesis', 'proposal', 'evidence']);
});

test('OpenRouter reasoning accepts a schema-conforming NO_TRADE with nullable levels', async () => {
  const client = new OpenRouterClient({ apiKey: 'sk-or-v1-offline-test-000000000000' });
  (client as unknown as { complete: unknown }).complete = async () => ({
    content: JSON.stringify({
      investigation: { summary: 'Market is mixed.', marketView: 'No break.', newsReport: 'No fresh relevant headlines.' },
      thesis: { directionalBias: 'NEUTRAL', summary: 'Wait.', confidence: 35, invalidation: 'New confirmed break.', observationPlan: 'Watch the close.', trackers: [] },
      proposal: { decision: 'NO_TRADE', triggerSequence: [], direction: null, orderType: null, market: 'BTC', entry: null, entryZone: null, stopLoss: null, takeProfit: null, riskReward: null, confidence: null, rationale: null, confirmationRequired: null, invalidation: null, noTradeReason: 'No confirmation.' },
      evidence: [],
    }), model: 'free/test:free', usage: { totalTokens: 70 }, requestId: 'request-1',
  });
  const result = await client.evaluateGoat({ userId: 'u', goatId: 'g', goatName: 'Robot', goatGoal: 'Analyze BTC', market: 'BTC', skills: [], activeThesis: null, dataSource: 'LIVE' } as never, 'free/test:free');
  assert.equal(result.result.proposal.decision, 'NO_TRADE');
  assert.equal(result.result.investigation.newsReport, 'No fresh relevant headlines.');
  assert.equal(result.model, 'free/test:free');
});

test('one validated run owns its public artifact, without storing arbitrary private fields', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'robot-run-'));
  try {
    const store = new GoatWorkflowStore({ filePath: join(folder, 'runs.json') });
    const now = new Date().toISOString();
    await store.createRun({ id: 'run_1', goatId: 'goat_1', userId: 'user_1', eventId: 'event_1', generationId: 'gen_1', market: 'BTC', triggerType: 'MANUAL_REEVALUATE', stage: 'reasoning_started', status: 'RUNNING', createdAt: now, updatedAt: now });
    const analysis = { summary: 'Waiting for confirmation.', marketView: 'Higher high.', bias: 'BULLISH', confidencePercent: 85, confirmation: ['Close above 100'], invalidation: ['Close below 98'], evidence: [], gate: { approved: false, reasons: ['No close yet'] }, news: { report: 'No fresh relevant headlines.', fetchedAt: Date.now(), headlines: [] }, data: { source: 'LIVE', reviewAt: Date.now() } } as const;
    assert.equal(RobotRunAnalysisSchema.safeParse({ ...analysis, privatePrompt: 'secret' }).success, false);
    await store.saveAnalysis('run_1', structuredClone(analysis) as never);
    assert.equal((await store.getRun('run_1'))?.analysis?.confidencePercent, 85);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('preferred sources are prioritized but other fresh news remains visible; stale news is excluded', async () => {
  const original = globalThis.fetch;
  const today = new Date().toUTCString();
  const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toUTCString();
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const preferred = String(input).includes('site%3A');
    const items = preferred
      ? `<item><title>Preferred headline</title><pubDate>${today}</pubDate><source>Preferred</source><link>https://example.com/one</link></item>`
      : `<item><title>General headline</title><pubDate>${today}</pubDate><source>General</source><link>https://example.com/two</link></item><item><title>Old headline</title><pubDate>${old}</pubDate><link>https://example.com/old</link></item>`;
    return new Response(`<rss><channel>${items}</channel></rss>`, { status: 200 });
  }, { preconnect: original.preconnect });
  try {
    const result = await new NewsService().getNews('BTC', false, ['example.com']);
    assert.deepEqual(result.headlines.map(item => item.title), ['Preferred headline', 'General headline']);
  } finally { globalThis.fetch = original; }
});
