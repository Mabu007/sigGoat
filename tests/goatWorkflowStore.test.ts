import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GoatWorkflowStore, type GoatWorkflowRun } from "../src/server/GoatWorkflowStore";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "sirgoat-workflow-test-"));
  dirs.push(dir);
  let tick = 0;
  return new GoatWorkflowStore({ filePath: path.join(dir, "workflow.json"), now: () => new Date(Date.UTC(2026, 9, 16, 10, 0, tick++)).toISOString() });
}

function makeRun(): GoatWorkflowRun {
  return {
    id: "run-1", goatId: "goat-a", userId: "owner-a", eventId: "event-1", generationId: "generation-1",
    market: "BTC", triggerType: "MANUAL", stage: "prepare", status: "WAITING_APPROVAL",
    signalId: "signal-1", createdAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:00.000Z",
  };
}

const intent = (fingerprint: string) => ({
  id: "execution-1", signalId: "signal-1", goatId: "goat-a", userId: "owner-a", provider: "ctrader", fingerprint,
});

describe("GoatWorkflowStore", () => {
  test("duplicate run creation is idempotent and activity is durable", async () => {
    const store = makeStore();
    expect(await store.createRun(makeRun())).toBe(true);
    expect(await store.createRun(makeRun())).toBe(false);
    const activities = await store.listActivities("goat-a");
    expect(activities.map(item => item.type)).toContain("WORKFLOW_STARTED");
  });

  test("execution claims cannot be repeated or reused for a different order shape", async () => {
    const store = makeStore();
    const first = await store.claimExecution(intent("order-shape-a"));
    const duplicate = await store.claimExecution(intent("order-shape-a"));
    const conflict = await store.claimExecution(intent("order-shape-b"));
    expect(first.claimed).toBe(true);
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.conflict).toBe(false);
    expect(conflict.claimed).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.intent.fingerprint).toBe("order-shape-a");
  });

  test("approval resolution is scoped to both user and GOAT", async () => {
    const store = makeStore();
    await store.createRun(makeRun());
    expect(await store.resolveApproval("signal-1", "other-user", "goat-a", "ACCEPTED")).toBeNull();
    expect(await store.resolveApproval("signal-1", "owner-a", "other-goat", "ACCEPTED")).toBeNull();
    expect((await store.resolveApproval("signal-1", "owner-a", "goat-a", "ACCEPTED"))?.status).toBe("APPROVED");
    expect((await store.resolveApproval("signal-1", "owner-a", "goat-a", "ACCEPTED"))?.status).toBe("APPROVED");
  });
});
