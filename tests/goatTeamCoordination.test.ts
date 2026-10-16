import { describe, expect, test } from "bun:test";
import { assessGoatTeamMarket } from "../src/server/GoatTeamCoordination";
import type { GoatTeam } from "../src/server/GoatTeamStore";

const team = (mode: GoatTeam["coordinationMode"], leadGoatId?: string): Pick<GoatTeam, "coordinationMode" | "memberGoatIds" | "leadGoatId"> => ({
  coordinationMode: mode,
  memberGoatIds: ["goat-a", "goat-b", "goat-c"],
  ...(leadGoatId ? { leadGoatId } : {}),
});

const signal = (direction: string, id = direction) => ({
  id, direction, confidence: 0.8, status: "ACTIONABLE", createdAt: "2026-10-16T10:00:00.000Z",
});

describe("GOAT team coordination assessment", () => {
  test("consensus is ready only when every member has the same actionable direction", () => {
    const ready = assessGoatTeamMarket(team("CONSENSUS"), "BTC", new Map([
      ["goat-a", signal("LONG", "a")], ["goat-b", signal("LONG", "b")], ["goat-c", signal("LONG", "c")],
    ]));
    expect(ready.outcome).toBe("CONSENSUS_READY");

    const waiting = assessGoatTeamMarket(team("CONSENSUS"), "BTC", new Map([
      ["goat-a", signal("LONG", "a")], ["goat-b", signal("LONG", "b")],
    ]));
    expect(waiting.outcome).toBe("WAITING_FOR_ALL_MEMBERS");

    const conflict = assessGoatTeamMarket(team("CONSENSUS"), "BTC", new Map([
      ["goat-a", signal("LONG", "a")], ["goat-b", signal("SHORT", "b")], ["goat-c", signal("LONG", "c")],
    ]));
    expect(conflict.outcome).toBe("NO_CONSENSUS");
  });

  test("lead review detects missing lead signal and opposing member signals", () => {
    expect(assessGoatTeamMarket(team("LEAD_REVIEW", "goat-a"), "BTC", new Map()).outcome).toBe("LEAD_SIGNAL_MISSING");
    const conflict = assessGoatTeamMarket(team("LEAD_REVIEW", "goat-a"), "BTC", new Map([
      ["goat-a", signal("LONG", "a")], ["goat-b", signal("SHORT", "b")],
    ]));
    expect(conflict.outcome).toBe("REVIEW_CONFLICT");
  });

  test("team assessment is informational and does not expose an execution permission", () => {
    const result = assessGoatTeamMarket(team("INDEPENDENT"), "BTC", new Map());
    expect(result.outcome).toBe("INDEPENDENT_SIGNALS");
    expect(result).not.toHaveProperty("executionAllowed");
    expect(result).not.toHaveProperty("order");
  });
});
