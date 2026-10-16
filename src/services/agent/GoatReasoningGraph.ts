/**
 * Phase 1 GOAT reasoning graph.
 *
 * LangGraph owns the orchestration boundary; the existing user-scoped
 * ReasoningGateway remains the only way to invoke a model. Trading decisions,
 * SignalGate, provider selection and execution stay in their existing owners.
 *
 * This first graph deliberately has no checkpointing: its state is short-lived
 * and contains no credentials. Durable checkpoints and resumable workflows are
 * a later phase, after a persistence strategy is selected.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { parseReasoningResult, type ReasoningResult } from "../agent/contracts";
import type { GoatReasoningContext } from "../ai/OpenRouterClient";
import type { AiProvider } from "../../server/reasoningGateway";

export interface GoatReasoningGraphInput {
  context: GoatReasoningContext;
  model: string;
  provider?: AiProvider;
  evaluate: (
    context: GoatReasoningContext,
    model: string,
    provider?: AiProvider,
  ) => Promise<ReasoningResult>;
}

const GoatReasoningGraphState = Annotation.Root({
  context: Annotation<GoatReasoningContext>(),
  model: Annotation<string>(),
  result: Annotation<ReasoningResult | undefined>({
    reducer: (_current, next) => next,
    default: () => undefined,
  }),
  stages: Annotation<string[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
});

/**
 * Routes a single GOAT review through explicit prepare -> reason -> validate
 * nodes. The provider callback is captured by the graph builder rather than
 * stored in graph state, keeping credentials and executable functions out of
 * graph state, checkpoints and activity payloads.
 */
export async function runGoatReasoningGraph(
  input: GoatReasoningGraphInput,
): Promise<ReasoningResult> {
  const prepareContext = async (state: typeof GoatReasoningGraphState.State) => {
    const { context, model } = state;
    if (
      !context ||
      typeof context.userId !== "string" ||
      context.userId.length === 0 ||
      typeof context.goatId !== "string" ||
      context.goatId.length === 0 ||
      typeof context.market !== "string" ||
      context.market.length === 0 ||
      typeof model !== "string" ||
      model.length === 0
    ) {
      throw new Error("GOAT_REASONING_GRAPH_INVALID_INPUT: user, GOAT, market and model are required.");
    }
    return { stages: ["context_prepared"] };
  };

  const invokeReasoning = async (state: typeof GoatReasoningGraphState.State) => {
    const result = await input.evaluate(state.context, state.model, input.provider);
    return { result, stages: [...state.stages, "reasoning_completed"] };
  };

  const validateContract = async (state: typeof GoatReasoningGraphState.State) => {
    if (!state.result) {
      throw new Error("GOAT_REASONING_GRAPH_MISSING_RESULT: reasoning produced no result.");
    }
    // Re-parse even though provider clients currently validate their output.
    // This keeps the graph boundary safe if another provider is added later.
    const result = parseReasoningResult(state.result);
    return { result, stages: [...state.stages, "contract_validated"] };
  };

  const graph = new StateGraph(GoatReasoningGraphState)
    .addNode("prepare_context", prepareContext)
    .addNode("reason", invokeReasoning)
    .addNode("validate_contract", validateContract)
    .addEdge(START, "prepare_context")
    .addEdge("prepare_context", "reason")
    .addEdge("reason", "validate_contract")
    .addEdge("validate_contract", END)
    .compile();

  const finalState = await graph.invoke({
    context: input.context,
    model: input.model,
    stages: [],
  });

  if (!finalState.result) {
    throw new Error("GOAT_REASONING_GRAPH_EMPTY_OUTPUT: graph completed without a validated result.");
  }
  return finalState.result;
}
