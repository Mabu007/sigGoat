import { describe, expect, test } from "bun:test";
import { runGoatReasoningGraph } from "../src/services/agent/GoatReasoningGraph";
import type { GoatReasoningContext } from "../src/services/ai/OpenRouterClient";
import type { ReasoningResult } from "../src/services/agent/contracts";

describe("GOAT reasoning graph", () => {
  test("rejects incomplete context before invoking the reasoning provider", async () => {
    let providerCalled = false;

    await expect(
      runGoatReasoningGraph({
        context: {} as GoatReasoningContext,
        model: "test-model",
        evaluate: async () => {
          providerCalled = true;
          return {} as ReasoningResult;
        },
      }),
    ).rejects.toThrow("GOAT_REASONING_GRAPH_INVALID_INPUT");

    expect(providerCalled).toBe(false);
  });
});
