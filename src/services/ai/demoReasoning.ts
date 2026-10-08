/**
 * DEMO REASONING (no credential configured)
 * =========================================
 * When a user has no OpenRouter key, the GOAT must still behave honestly:
 * it returns a deterministic NO_TRADE result that states no AI model is
 * connected. It NEVER fabricates analysis, prices, or a market view.
 *
 * The runtime labels this mode as `reasoningMode: 'DEMO'` (see
 * GoatDurableObject), and the UI renders a "DEMO MODE" badge, so a DEMO
 * result can never be mistaken for real model output.
 */

import { ReasoningResult } from '../agent/contracts';
import { GoatReasoningContext } from './OpenRouterClient';

export const DEMO_NO_TRADE_REASON =
  'NO_TRADE (DEMO): no AI model key is configured, so no market hypothesis was generated.';

export const DEMO_CHAT_ANSWER =
  'DEMO MODE — no AI model key is configured, so I cannot analyse anything right now. ' +
  'Add your OpenRouter API key in Settings → AI Reasoning Engine, save it, and I will ' +
  'answer from your actual GOAT state. Until then I will not guess at the market.';

export function buildDemoReasoningResult(context: GoatReasoningContext): ReasoningResult {
  const quote = context.quote;
  const observed =
    quote === undefined
      ? 'No quote was supplied.'
      : `Last observed ${context.market} mid ${quote.mid} (${context.dataSource} data).`;

  return {
    investigation: {
      summary:
        `DEMO mode: no AI model key is configured for this account, so no analysis was performed. ` +
        `${observed}`,
    },
    thesis: {
      directionalBias: 'NEUTRAL',
      summary: 'DEMO mode — no thesis was generated because no AI model is connected.',
      confidence: 0,
      trackers: [],
    },
    proposal: {
      decision: 'NO_TRADE',
      noTradeReason: DEMO_NO_TRADE_REASON,
    },
    evidence: [],
  };
}
