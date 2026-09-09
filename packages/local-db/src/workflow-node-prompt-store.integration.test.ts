import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkflowNodePromptStore } from "./workflow-node-prompt-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("SqliteWorkflowNodePromptStore", () => {
  it("persists prompts by official run/node and never rewrites what a run used", async () => {
    const directory = await mkdtemp(join(tmpdir(), "Compazio workflow prompts "));
    directories.push(directory);
    const filename = join(directory, "prompts.db");
    runLocalMigrations({ filename, backupBeforeMigration: false });
    seedWorkflowRun(filename, "run-1");
    const store = new SqliteWorkflowNodePromptStore(filename);
    try {
      store.putMany("run-1", [
        { nodeId: "planner", prompt: "Planeje a missão." },
        { nodeId: "codex", prompt: "Implemente o plano." }
      ]);
      store.putMany("run-1", [{ nodeId: "codex", prompt: "PROMPT ALTERADO" }]);

      expect(store.getNodePrompt("run-1", "planner")).toBe("Planeje a missão.");
      expect(store.getNodePrompt("run-1", "codex")).toBe("Implemente o plano.");
      expect(store.getNodePrompt("run-1", "missing")).toBeNull();
    } finally {
      store.close();
    }
  });
});

function seedWorkflowRun(filename: string, runId: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-26T00:00:00.000Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, workflow_version, workflow_hash, input_hash,
            workflow_snapshot_json, effective_permissions_json, state, dry_run,
            concurrency, started_at, ended_at, report_artifact_id, created_at, updated_at)
         VALUES (?, 'manual-team', '1.0', ?, ?, '{}', '{}', 'created', 0, 1,
                 NULL, NULL, NULL, ?, ?)`
      )
      .run(runId, "a".repeat(64), "b".repeat(64), now, now);
  } finally {
    sqlite.close();
  }
}
