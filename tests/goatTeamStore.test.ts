import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GoatTeamStore, type GoatTeam } from "../src/server/GoatTeamStore";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTeam(ownerUserId: string, id = "team-1"): GoatTeam {
  return {
    id, ownerUserId, name: "Test team", memberGoatIds: ["goat-a", "goat-b"],
    coordinationMode: "CONSENSUS", status: "DRAFT",
    createdAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:00.000Z",
  };
}

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "sirgoat-team-test-"));
  dirs.push(dir);
  return new GoatTeamStore({ filePath: path.join(dir, "teams.json") });
}

describe("GoatTeamStore ownership", () => {
  test("a team is only readable/listed/deletable by its owner", async () => {
    const store = makeStore();
    await store.create(makeTeam("owner-a"));
    expect((await store.getForUser("team-1", "owner-a"))?.ownerUserId).toBe("owner-a");
    expect(await store.getForUser("team-1", "owner-b")).toBeNull();
    expect(await store.listForUser("owner-b")).toEqual([]);
    expect(await store.deleteForUser("team-1", "owner-b")).toBe(false);
    expect((await store.getForUser("team-1", "owner-a"))?.id).toBe("team-1");
  });

  test("team records survive store recreation and duplicate IDs are rejected", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sirgoat-team-persist-"));
    dirs.push(dir);
    const filePath = path.join(dir, "teams.json");
    const first = new GoatTeamStore({ filePath });
    await first.create(makeTeam("owner-a"));
    const second = new GoatTeamStore({ filePath });
    expect((await second.listForUser("owner-a")).map(team => team.id)).toEqual(["team-1"]);
    await expect(second.create(makeTeam("owner-a"))).rejects.toThrow("GOAT_TEAM_ALREADY_EXISTS");
  });
});
