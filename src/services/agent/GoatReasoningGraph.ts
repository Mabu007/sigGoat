/**
 * One bounded reasoning call. Durable scheduling and the run ledger are owned
 * by Firestore; a three-node in-memory LangGraph provided no resume behavior.
 * Keep this boundary explicit until conditional research warrants a real graph
 * with an intentional checkpointer and durable thread id.
 */
import { parseReasoningResult, type ReasoningResult } from './contracts';
import type { GoatReasoningContext } from '../ai/OpenRouterClient';
import type { AiProvider } from '../../server/reasoningGateway';

export interface GoatReasoningGraphInput {
  context: GoatReasoningContext;
  model: string;
  provider?: AiProvider;
  evaluate: (context: GoatReasoningContext, model: string, provider?: AiProvider) => Promise<ReasoningResult>;
  onStage?: (stage: string) => Promise<void> | void;
}

export async function runGoatReasoningGraph(input: GoatReasoningGraphInput): Promise<ReasoningResult> {
  const { context, model } = input;
  if (!context?.userId || !context.goatId || !context.market || !model) {
    throw new Error('GOAT_REASONING_GRAPH_INVALID_INPUT: user, GOAT, market and model are required.');
  }
  await input.onStage?.('context_prepared');
  const response = await input.evaluate(context, model, input.provider);
  await input.onStage?.('reasoning_completed');
  const result = parseReasoningResult(response);
  await input.onStage?.('contract_validated');
  return result;
}
