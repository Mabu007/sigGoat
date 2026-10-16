import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { GoatTeamStore, type GoatTeam } from "../src/server/GoatTeamStore";
import { assessGoatTeamMarket } from "../src/server/GoatTeamCoordination";
import { GoatWorkflowStore, type GoatWorkflowRun } from "../src/server/GoatWorkflowStore";

const tempDirs: string[] = [];
function tempFile(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sirgoat-regression-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTeam(overrides: Partial<GoatTeam> = {}): GoatTeam {
  return {
    id: "team-1",
    ownerUserId: "user-a",
    name: "Test team",
    memberGoatIds: ["goat-a", "goat-b"],
    coordinationMode: "CONSENSUS",
    status: "DRAFT",
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("GOAT team coordination and ownership", () => {
  test("consensus waits for every member and only becomes ready for matching LONG/SHORT signals", () => {
    const team = makeTeam();
    expect(assessGoatTeamMarket(team, "BTC", new Map([
      ["goat-a", { id: "s1", direction: "LONG", status: "ACTIONABLE" }],
    ])).outcome).toBe("WAITING_FOR_ALL_MEMBERS");

    expect(assessGoatTeamMarket(team, "BTC", new Map([
      ["goat-a", { id: "s1", direction: "LONG", status: "ACTIONABLE" }],
      ["goat-b", { id: "s2", direction: "LONG", status: "ACTIONABLE" }],
    ])).outcome).toBe("CONSENSUS_READY");

    expect(assessGoatTeamMarket(team, "BTC", new Map([
      ["goat-a", { id: "s1", direction: "LONG", status: "ACTIONABLE" }],
      ["goat-b", { id: "s2", direction: "SHORT", status: "ACTIONABLE" }],
    ])).outcome).toBe("NO_CONSENSUS");
  });

  test("lead review reports conflicts and never authorizes execution", () => {
    const team = makeTeam({ coordinationMode: "LEAD_REVIEW", leadGoatId: "goat-a" });
    const result = assessGoatTeamMarket(team, "BTC", new Map([
      ["goat-a", { id: "s1", direction: "LONG", status: "ACTIONABLE" }],
      ["goat-b", { id: "s2", direction: "SHORT", status: "ACTIONABLE" }],
    ]));
    expect(result.outcome).toBe("REVIEW_CONFLICT");
    expect(result.votes).toHaveLength(2);
    expect(result).not.toHaveProperty("executionAllowed");
  });

  test("team records and deletion are scoped to their owner", async () => {
    const store = new GoatTeamStore({ filePath: tempFile("teams.json") });
    await store.create(makeTeam());
    expect(await store.getForUser("team-1", "user-b")).toBeNull();
    expect(await store.listForUser("user-b")).toEqual([]);
    expect(await store.deleteForUser("team-1", "user-b")).toBe(false);
    expect(await store.getForUser("team-1", "user-a")).not.toBeNull();
  });
});

describe("durable workflow execution idempotency and ownership", () => {
  test("a repeated execution intent cannot be claimed twice or reused for a different order shape", async () => {
    const store = new GoatWorkflowStore({
      filePath: tempFile("workflows.json"),
      now: () => "2026-10-16T10:00:00.000Z",
    });
    const intent = {
      id: "intent-1",
      signalId: "signal-1",
      goatId: "goat-a",
      userId: "user-a",
      provider: "ctrader",
      fingerprint: "order-shape-a",
    };
    expect((await store.claimExecution(intent)).claimed).toBe(true);
    const duplicate = await store.claimExecution(intent);
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.conflict).toBe(false);
    const conflicting = await store.claimExecution({ ...intent, fingerprint: "order-shape-b" });
    expect(conflicting.claimed).toBe(false);
    expect(conflicting.conflict).toBe(true);
  });

  test("approval resolution requires the matching owner and GOAT", async () => {
    const store = new GoatWorkflowStore({
      filePath: tempFile("approval.json"),
      now: () => "2026-10-16T10:00:00.000Z",
    });
    const run: GoatWorkflowRun = {
      id: "run-1",
      goatId: "goat-a",
      userId: "user-a",
      eventId: "event-1",
      generationId: "generation-1",
      market: "BTC",
      triggerType: "MANUAL",
      stage: "waiting_approval",
      status: "WAITING_APPROVAL",
      signalId: "signal-1",
      createdAt: "2026-10-16T09:00:00.000Z",
      updatedAt: "2026-10-16T09:00:00.000Z",
    };
    expect(await store.createRun(run)).toBe(true);
    expect(await store.resolveApproval("signal-1", "user-b", "goat-a", "ACCEPTED")).toBeNull();
    expect(await store.resolveApproval("signal-1", "user-a", "goat-b", "ACCEPTED")).toBeNull();
    expect((await store.resolveApproval("signal-1", "user-a", "goat-a", "ACCEPTED"))?.status).toBe("APPROVED");
  });
});
