import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkflowActivationStore } from "./workflow-activation-store";
import type { CreateWorkflowActivationInput } from "./workflow-activation-store";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

const HASH = "a".repeat(64);

function intent(
  overrides: Partial<CreateWorkflowActivationInput> = {}
): CreateWorkflowActivationInput {
  return {
    draftId: "33333333-3333-4333-8333-333333333333",
    draftVersion: 3,
    workspaceId: "workspace-1",
    workflowId: "draft-33333333-3333-4333-8333-333333333333",
    definitionSha256: HASH,
    ...overrides
  };
}

async function freshStore(): Promise<{
  store: SqliteWorkflowActivationStore;
  filename: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-activation-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  seedWorkspace(filename, directory);
  let clock = 0;
  const store = new SqliteWorkflowActivationStore(
    filename,
    () => `00000000-0000-4000-8000-00000000000${(clock += 1)}`,
    () => new Date("2026-07-24T12:00:00.000Z")
  );
  return { store, filename };
}

describe("SqliteWorkflowActivationStore", () => {
  it("is idempotent: the same draft revision yields one activation", async () => {
    const { store } = await freshStore();
    try {
      const first = store.ensureIntent(intent());
      const second = store.ensureIntent(intent());
      expect(second.activationId).toBe(first.activationId);
    } finally {
      store.close();
    }
  });

  it("attaches exactly one run and reports it by workspace", async () => {
    const { store } = await freshStore();
    try {
      const activation = store.ensureIntent(intent());
      expect(activation.runId).toBeNull();
      const started = store.attachRun(activation.activationId, "run-1");
      expect(started.runId).toBe("run-1");
      expect(started.status).toBe("started");

      // Re-attaching the same run is a no-op; a different run is refused.
      expect(store.attachRun(activation.activationId, "run-1").runId).toBe("run-1");
      expect(() => store.attachRun(activation.activationId, "run-2")).toThrow();

      const latest = store.getLatestStartedForWorkspace("workspace-1");
      expect(latest?.runId).toBe("run-1");
    } finally {
      store.close();
    }
  });

  it("recovers the association after a reload (new store over the same file)", async () => {
    const { store, filename } = await freshStore();
    let runId: string;
    try {
      const activation = store.ensureIntent(intent());
      store.attachRun(activation.activationId, "run-42");
      runId = "run-42";
    } finally {
      store.close();
    }
    const reopened = new SqliteWorkflowActivationStore(filename);
    try {
      const recovered = reopened.getByDraft(intent().draftId, intent().draftVersion);
      expect(recovered?.runId).toBe(runId);
      expect(reopened.getLatestStartedForWorkspace("workspace-1")?.runId).toBe(runId);
    } finally {
      reopened.close();
    }
  });

  it("keeps distinct activations for different draft revisions", async () => {
    const { store } = await freshStore();
    try {
      const v3 = store.ensureIntent(intent({ draftVersion: 3 }));
      const v4 = store.ensureIntent(intent({ draftVersion: 4 }));
      expect(v4.activationId).not.toBe(v3.activationId);
    } finally {
      store.close();
    }
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-24T12:00:00.000Z");
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
