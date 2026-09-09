import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { workflowDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft } from "@forgedeck/schemas";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkflowDraftStore } from "./workflow-draft-store";
import type { WorkflowDraftEventInput } from "./workflow-draft-store";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "22222222-2222-4222-8222-222222222222",
    version: 1,
    workspaceId: "workspace-1",
    sourceTerminalId: "term-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Landing page",
    objective: "Build a tested landing page",
    state: "composing",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    ...overrides
  });
}

function event(type: WorkflowDraftEventInput["type"]): WorkflowDraftEventInput {
  return { type, actor: "orchestrator", summary: "", rejectionReason: null };
}

describe("SqliteWorkflowDraftStore", () => {
  it("persists a draft and restores it exactly after a reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-draft-"));
    directories.push(directory);
    const filename = join(directory, "local.db");
    runLocalMigrations({ filename });
    seedWorkspace(filename, directory);

    let clock = 0;
    const store = new SqliteWorkflowDraftStore(
      filename,
      () => `00000000-0000-4000-8000-00000000000${(clock += 1)}`,
      () => new Date("2026-07-22T12:00:00.000Z")
    );
    try {
      const started = store.persist(draft(), [
        event("workflow.draft.started"),
        event("workflow.context.indexed")
      ]);
      expect(started.draft.state).toBe("composing");
      expect(started.lastEvent?.type).toBe("workflow.context.indexed");

      // A ghost node lands on the draft; the reload must bring it back verbatim.
      const withNode = draft({
        version: 2,
        nodes: workflowDraftSchema.parse({
          ...draft(),
          nodes: [{ id: "impl", title: "Implementer", role: "implementer" }]
        }).nodes,
        updatedAt: "2026-07-22T12:05:00.000Z"
      });
      store.persist(withNode, [event("workflow.node.draft_created")]);

      const reloaded = store.getById("22222222-2222-4222-8222-222222222222");
      expect(reloaded?.version).toBe(2);
      expect(reloaded?.nodes[0]?.id).toBe("impl");
      expect(reloaded?.nodes[0]?.lifecycle).toBe("draft");

      const byTerminal = store.getLatestForTerminal("workspace-1", "term-1");
      expect(byTerminal?.id).toBe("22222222-2222-4222-8222-222222222222");
      const byWorkspace = store.getLatestForWorkspace("workspace-1");
      expect(byWorkspace?.nodes[0]?.id).toBe("impl");
    } finally {
      store.close();
    }
  });

  it("appends events with a monotonic sequence and unique ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-draft-events-"));
    directories.push(directory);
    const filename = join(directory, "local.db");
    runLocalMigrations({ filename });
    seedWorkspace(filename, directory);

    let clock = 0;
    const store = new SqliteWorkflowDraftStore(
      filename,
      () => `00000000-0000-4000-8000-00000000000${(clock += 1)}`,
      () => new Date("2026-07-22T12:00:00.000Z")
    );
    try {
      store.persist(draft(), [event("workflow.draft.started")]);
      store.persist(draft({ version: 2, state: "ready" }), [event("workflow.draft.ready")]);
      store.persist(draft({ version: 3, state: "approved" }), [event("workflow.approved")]);

      const events = store.listEvents("22222222-2222-4222-8222-222222222222");
      expect(events.map((entry) => entry.type)).toEqual([
        "workflow.draft.started",
        "workflow.draft.ready",
        "workflow.approved"
      ]);
      expect(events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      expect(new Set(events.map((entry) => entry.id)).size).toBe(3);

      // The snapshot is authoritative: the reloaded state reflects the last persisted draft, not a
      // replay of events, so events can never duplicate nodes on reload.
      expect(store.getById("22222222-2222-4222-8222-222222222222")?.state).toBe("approved");
    } finally {
      store.close();
    }
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-22T12:00:00.000Z");
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
