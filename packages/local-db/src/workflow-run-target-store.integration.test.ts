import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkflowRunTargetStore } from "./workflow-run-target-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteWorkflowRunTargetStore", () => {
  it("persists an opaque managed worktree binding and refuses it to change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-workflow-target-"));
    directories.push(directory);
    const filename = join(directory, "local.db");
    runLocalMigrations({ filename });
    seedWorkspace(filename, directory);

    const store = new SqliteWorkflowRunTargetStore(
      filename,
      () => new Date("2026-07-21T12:00:00Z")
    );
    try {
      const target = store.bind({
        runId: "run-1",
        workspaceId: "workspace-1",
        projectId: "00000000-0000-4000-8000-000000000001",
        agentNodeId: "reviewer",
        worktreeId: "worktree-1"
      });

      expect(target).toMatchObject({ worktreeId: "worktree-1" });
      expect(store.get("run-1")).toMatchObject({
        workspaceId: "workspace-1",
        agentNodeId: "reviewer",
        worktreeId: "worktree-1"
      });
      expect(() =>
        store.bind({
          runId: "run-1",
          workspaceId: "workspace-1",
          projectId: "00000000-0000-4000-8000-000000000001",
          agentNodeId: "reviewer",
          worktreeId: "worktree-2"
        })
      ).toThrow("immutable");
    } finally {
      store.close();
    }
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-21T12:00:00Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
          (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run("00000000-0000-4000-8000-000000000001", root, root, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-1', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES ('workspace-1', ?, 'canvas-1', 'Principal', 0, 1, ?, ?)`
      )
      .run("00000000-0000-4000-8000-000000000001", now, now);
  } finally {
    sqlite.close();
  }
}
