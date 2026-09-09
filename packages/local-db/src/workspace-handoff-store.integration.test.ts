import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceHandoffStore } from "./workspace-handoff-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceHandoffStore", () => {
  it("creates a draft from a persisted visual route without delivering it", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceHandoffStore(fixture.filename);
    try {
      const handoff = store.create({
        workspaceId: fixture.workspaceId,
        sourceNodeId: "author",
        targetNodeId: "reviewer",
        summary: "Implementation is ready for review.",
        artifact: null,
        createdByNodeId: null
      });

      expect(handoff).toMatchObject({
        status: "draft",
        content: { summary: "Implementation is ready for review." },
        source: { nodeId: "author" },
        target: { nodeId: "reviewer" }
      });
      expect(store.get(fixture.workspaceId, handoff.id).deliveryAttempts).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("requires create_handoffs when another agent creates the draft", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceHandoffStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          sourceNodeId: "author",
          targetNodeId: "reviewer",
          summary: "",
          artifact: null,
          createdByNodeId: "author"
        })
      ).toThrow("create_handoffs permission");
    } finally {
      store.close();
    }
  });

  it("prepares one workflow handoff draft from its sole persisted handoff route", async () => {
    const fixture = await createFixture();
    grantAuthorPermission(fixture.filename, "create_handoffs");
    const store = new SqliteWorkspaceHandoffStore(fixture.filename);
    try {
      const handoff = store.createWorkflowDraft({
        workspaceId: fixture.workspaceId,
        sourceNodeId: "author",
        summary: "Workflow run-1 prepared a handoff for human review."
      });

      expect(handoff).toMatchObject({
        status: "draft",
        source: { nodeId: "author" },
        target: { nodeId: "reviewer" }
      });
      expect(handoff.deliveryAttempts).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("requires approval permission and keeps reject, retry, cancel and history in one lifecycle", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceHandoffStore(fixture.filename);
    try {
      const draft = store.create({
        workspaceId: fixture.workspaceId,
        sourceNodeId: "author",
        targetNodeId: "reviewer",
        summary: "Implementation is ready for review.",
        artifact: null,
        createdByNodeId: null
      });
      expect(() =>
        store.approve({
          workspaceId: fixture.workspaceId,
          handoffId: draft.id,
          expectedRevision: draft.revision,
          actedByNodeId: "author",
          summary: null
        })
      ).toThrow("approve_deliveries permission");

      const rejected = store.reject({
        workspaceId: fixture.workspaceId,
        handoffId: draft.id,
        expectedRevision: draft.revision,
        actedByNodeId: null,
        reason: "Evidence is incomplete."
      });
      const retried = store.retry({
        workspaceId: fixture.workspaceId,
        handoffId: rejected.id,
        expectedRevision: rejected.revision,
        actedByNodeId: null
      });
      const approved = store.approve({
        workspaceId: fixture.workspaceId,
        handoffId: retried.id,
        expectedRevision: retried.revision,
        actedByNodeId: null,
        summary: "Reviewed and approved."
      });
      const cancelled = store.cancel({
        workspaceId: fixture.workspaceId,
        handoffId: approved.id,
        expectedRevision: approved.revision,
        actedByNodeId: null
      });

      expect(cancelled).toMatchObject({ status: "cancelled" });
      expect(
        store.listEvents(fixture.workspaceId, cancelled.id).map((event) => event.type)
      ).toEqual([
        "draft_created",
        "handoff_rejected",
        "retry_requested",
        "handoff_ready",
        "delivery_cancelled"
      ]);
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-workspace-handoff-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const role = {
    name: "Reviewer",
    responsibilities: "Review evidence",
    constraints: "Do not edit code",
    expectedDeliverable: "Review report",
    completionCriteria: "Evidence assessed"
  };
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, directory, directory, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES (?, 'Principal', 'Ship a reviewed change', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(canvasId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
      )
      .run(workspaceId, projectId, canvasId, now, now);
    for (const [id, title] of [
      ["author", "Author"],
      ["reviewer", "Reviewer"]
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO canvas_nodes (canvas_id, id, type, position_x, position_y, width, height, data_json)
           VALUES (?, ?, 'agent', 0, 0, 560, 380, ?)`
        )
        .run(
          canvasId,
          id,
          JSON.stringify({
            title,
            state: "idle",
            summary: "",
            adapterId: "codex",
            role,
            retryMaxAttempts: 1,
            permissions: []
          })
        );
    }
    sqlite
      .prepare(
        `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
         VALUES (?, 'handoff-edge', 'author', 'reviewer', ?)`
      )
      .run(
        canvasId,
        JSON.stringify({
          schemaVersion: "1.0",
          kind: "handoff",
          label: "Review",
          requiredEvidenceTypes: []
        })
      );
  } finally {
    sqlite.close();
  }
  return { filename, workspaceId };
}

function grantAuthorPermission(filename: string, permission: string): void {
  const sqlite = new Database(filename);
  try {
    const row = sqlite.prepare("SELECT data_json FROM canvas_nodes WHERE id = 'author'").get() as
      { readonly data_json: string } | undefined;
    if (row === undefined) throw new Error("Author node was not found");
    const data = JSON.parse(row.data_json) as { permissions: string[] };
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE id = 'author'")
      .run(JSON.stringify({ ...data, permissions: [...data.permissions, permission] }));
  } finally {
    sqlite.close();
  }
}
