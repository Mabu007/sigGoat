import { z } from 'zod';

// The provider-facing shape is intentionally narrow. The canonical parser and
// SignalGate still validate semantic rules after this structural boundary.
const bias = z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']);
const maybeNumber = z.number().nullable();
const maybeString = z.string().nullable();

export const ReasoningWireSchema = z.object({
  investigation: z.object({
    summary: z.string(), marketView: z.string(), newsReport: z.string(),
  }).strict(),
  thesis: z.object({
    directionalBias: bias, summary: z.string(), confidence: z.number().min(0).max(100),
    invalidation: z.string(), observationPlan: z.string(),
    trackers: z.array(z.object({
      description: z.string(),
      type: z.enum(['PRICE_LEVEL', 'STRUCTURE', 'SPREAD', 'TIME_WINDOW', 'INDICATOR', 'BREAKOUT', 'RSI_THRESHOLD', 'EMA_CROSS', 'SESSION_BOUNDARY']),
      indicator: z.enum(['RSI', 'EMA', 'SMA', 'ATR', 'MACD', 'MACD_HISTOGRAM', 'SWING_HIGH', 'SWING_LOW', 'SESSION_HIGH', 'SESSION_LOW']).nullable(),
      period: maybeNumber, targetValue: maybeNumber,
      fastPeriod: maybeNumber, slowPeriod: maybeNumber,
      session: z.enum(['ASIAN', 'LONDON', 'NEW_YORK']).nullable(),
      rangeLow: maybeNumber, rangeHigh: maybeNumber,
      operator: z.enum(['GREATER_THAN', 'LESS_THAN', 'CROSS_ABOVE', 'CROSS_BELOW', 'WITHIN_RANGE']).nullable(),
    }).strict()),
  }).strict(),
  proposal: z.object({
    decision: z.enum(['ACTIONABLE', 'NO_TRADE']), triggerSequence: z.array(z.string()),
    direction: z.enum(['LONG', 'SHORT']).nullable(), orderType: z.enum(['LIMIT', 'STOP', 'MARKET']).nullable(),
    market: maybeString, entry: maybeNumber,
    entryZone: z.object({ low: z.number(), high: z.number() }).strict().nullable(),
    stopLoss: maybeNumber, takeProfit: maybeNumber, riskReward: maybeNumber,
    confidence: maybeNumber, rationale: maybeString, confirmationRequired: maybeString,
    invalidation: maybeString, noTradeReason: maybeString,
  }).strict(),
  evidence: z.array(z.object({
    source: z.string(), market: z.string(), timeframe: z.string(), observation: z.string(),
    bias, classification: z.enum(['SUPPORTING', 'CONTRADICTORY']),
  }).strict()),
}).strict();

export const reasoningJsonSchema = z.toJSONSchema(ReasoningWireSchema, { target: 'draft-7' });
