import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { defaultAutonomyConfig } from "@forgedeck/schemas";

import { runLocalMigrations } from "./migrate";
import { SqliteSupervisedAutonomyStore } from "./supervised-autonomy-store";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

async function createStore(): Promise<{ store: SqliteSupervisedAutonomyStore; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-autonomy-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  seedWorkspace(filename, directory);
  let sequence = 0;
  const store = new SqliteSupervisedAutonomyStore(
    filename,
    () => `00000000-0000-4000-8000-0000000000${String((sequence += 1)).padStart(2, "0")}`,
    () => new Date("2026-07-21T12:00:00.000Z")
  );
  return { store, filename };
}

describe("SqliteSupervisedAutonomyStore", () => {
  it("records every allow and stop decision immutably with sanitized context", async () => {
    const { store, filename } = await createStore();
    try {
      const allowed = store.assess({
        workspaceId: "workspace-1",
        runId: "run-1",
        proposalId: null,
        actor: "runtime",
        action: "spawn_agent",
        config: defaultAutonomyConfig,
        state: { concurrentAgents: 1, spawnedAgents: 2 }
      });
      expect(allowed).toMatchObject({ outcome: "allow", rule: "within_supervised_scope" });
      const stopped = store.assess({
        workspaceId: "workspace-1",
        runId: "run-1",
        proposalId: null,
        actor: "runtime",
        action: "retry_node",
        config: defaultAutonomyConfig,
        state: { nodeAttempts: 2 }
      });
      expect(stopped).toMatchObject({ outcome: "stop", rule: "retry_limit" });
      const decisions = store.listDecisions("workspace-1");
      expect(decisions).toHaveLength(2);
      expect(decisions[0]?.context.state.nodeAttempts).toBe(2);
      expect(decisions[0]?.context.config.maxRetriesPerNode).toBe(2);
      const sqlite = new Database(filename, { readonly: true });
      try {
        const row = sqlite
          .prepare("SELECT context_json FROM autonomy_decisions WHERE id = ?")
          .get(stopped.id) as { readonly context_json: string };
        expect(row.context_json).not.toContain("C:\\");
        expect(row.context_json).not.toContain("/home/");
      } finally {
        sqlite.close();
      }
    } finally {
      store.close();
    }
  });

  it("persists the kill switch and lets it override a stale caller state", async () => {
    const { store } = await createStore();
    try {
      expect(store.isKillSwitchEngaged("workspace-1")).toBe(false);
      store.engageKillSwitch("workspace-1");
      expect(store.isKillSwitchEngaged("workspace-1")).toBe(true);
      // The caller believes the switch is off; the durable flag must still stop the action.
      const decision = store.assess({
        workspaceId: "workspace-1",
        actor: "runtime",
        action: "continue_approved_step",
        config: defaultAutonomyConfig,
        state: { killSwitchEngaged: false }
      });
      expect(decision).toMatchObject({ outcome: "stop", rule: "kill_switch" });
      store.releaseKillSwitch("workspace-1");
      expect(store.isKillSwitchEngaged("workspace-1")).toBe(false);
      const resumed = store.assess({
        workspaceId: "workspace-1",
        actor: "runtime",
        action: "continue_approved_step",
        config: defaultAutonomyConfig,
        state: {}
      });
      expect(resumed.outcome).toBe("allow");
    } finally {
      store.close();
    }
  });

  it("survives a reopen without duplicating or losing decisions", async () => {
    const { store, filename } = await createStore();
    store.assess({
      workspaceId: "workspace-1",
      actor: "runtime",
      action: "release_lease",
      config: defaultAutonomyConfig,
      state: {}
    });
    store.engageKillSwitch("workspace-1");
    store.close();
    const reopened = new SqliteSupervisedAutonomyStore(filename);
    try {
      expect(reopened.listDecisions("workspace-1")).toHaveLength(1);
      expect(reopened.isKillSwitchEngaged("workspace-1")).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("terminates only agents idle past the budget and audits each idle decision", async () => {
    const { store } = await createStore();
    try {
      const terminated = store.sweepIdleAgents({
        workspaceId: "workspace-1",
        runId: "run-1",
        config: { ...defaultAutonomyConfig, maxIdleMinutes: 10 },
        agents: [
          { nodeId: "planner", idleMinutes: 4 },
          { nodeId: "coder", idleMinutes: 12 },
          { nodeId: "reviewer", idleMinutes: 10 }
        ]
      });
      expect(terminated).toEqual(["coder", "reviewer"]);
      const decisions = store.listDecisions("workspace-1");
      expect(decisions).toHaveLength(2);
      expect(decisions.every((decision) => decision.action === "terminate_idle_agent")).toBe(true);
      expect(decisions.every((decision) => decision.outcome === "allow")).toBe(true);
      expect(decisions.map((decision) => decision.actor).sort()).toEqual(["coder", "reviewer"]);
    } finally {
      store.close();
    }
  });

  it("defers the idle loop to the durable kill switch instead of acting behind it", async () => {
    const { store } = await createStore();
    try {
      store.engageKillSwitch("workspace-1");
      const terminated = store.sweepIdleAgents({
        workspaceId: "workspace-1",
        config: defaultAutonomyConfig,
        agents: [{ nodeId: "idle", idleMinutes: 30 }]
      });
      // The kill switch stops the loop; the recorded decision proves the deferral.
      expect(terminated).toEqual([]);
      const decisions = store.listDecisions("workspace-1");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        action: "terminate_idle_agent",
        outcome: "stop",
        rule: "kill_switch"
      });
    } finally {
      store.close();
    }
  });

  it("rejects unknown workspaces and out-of-range limits", async () => {
    const { store } = await createStore();
    try {
      expect(() =>
        store.assess({
          workspaceId: "missing",
          actor: "runtime",
          action: "spawn_agent",
          config: defaultAutonomyConfig,
          state: {}
        })
      ).toThrow("workspace was not found");
      expect(() => store.listDecisions("workspace-1", 0)).toThrow("between 1 and 500");
    } finally {
      store.close();
    }
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at) VALUES ('project-1', 'Compasso', ?, ?, 'main', 'abc', ?, ?)"
      )
      .run(root, root, now, now);
    sqlite
      .prepare(
        "INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at) VALUES ('canvas-1', 'Main', '', 1, '{}', ?, ?)"
      )
      .run(now, now);
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at) VALUES ('workspace-1', 'project-1', 'canvas-1', 'Main', 0, 1, ?, ?)"
      )
      .run(now, now);
  } finally {
    sqlite.close();
  }
}
