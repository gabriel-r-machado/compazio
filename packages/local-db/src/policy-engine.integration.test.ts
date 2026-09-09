import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqlitePolicyEngine } from "./policy-engine";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqlitePolicyEngine", () => {
  it("denies by default, audits both outcomes, and never mutates agent permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-policy-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "policy.db");
    runLocalMigrations({ filename });
    const fixture = seedWorkspace(filename);
    const policy = new SqlitePolicyEngine(filename);
    try {
      expect(() =>
        policy.assertAllowed({
          workspaceId: fixture.workspaceId,
          actorNodeId: fixture.agentNodeId,
          permission: "create_notes"
        })
      ).toThrow("create_notes permission");
      expect(policy.list(fixture.workspaceId)).toEqual([
        expect.objectContaining({
          actorNodeId: fixture.agentNodeId,
          permission: "create_notes",
          outcome: "denied",
          reason: "permission_missing"
        })
      ]);

      const before = readNodeData(filename, fixture.canvasId, fixture.agentNodeId);
      expect(() =>
        policy.assertAllowed({
          workspaceId: fixture.workspaceId,
          actorNodeId: fixture.agentNodeId,
          permission: "manage_worktrees"
        })
      ).toThrow("manage_worktrees permission");
      expect(readNodeData(filename, fixture.canvasId, fixture.agentNodeId)).toEqual(before);

      grantPermission(filename, fixture.canvasId, fixture.agentNodeId, "create_notes");
      expect(
        policy.assertAllowed({
          workspaceId: fixture.workspaceId,
          actorNodeId: fixture.agentNodeId,
          permission: "create_notes"
        })
      ).toMatchObject({ outcome: "allowed", reason: "permission_granted" });
      expect(
        policy.assertAllowed({
          workspaceId: fixture.workspaceId,
          actorNodeId: null,
          permission: "approve_deliveries"
        })
      ).toMatchObject({ outcome: "allowed", reason: "local_user" });
    } finally {
      policy.close();
    }
  });
});

function seedWorkspace(filename: string): {
  readonly workspaceId: string;
  readonly canvasId: string;
  readonly agentNodeId: string;
} {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-policy";
  const canvasId = "canvas-policy";
  const agentNodeId = "agent-policy";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Policy', 'C:/policy', 'C:/policy', 'main', 'HEAD', ?, ?)`
      )
      .run(projectId, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES (?, 'Policy', '', 0, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(canvasId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces
         (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, ?, 'Policy', 0, 1, ?, ?)`
      )
      .run(workspaceId, projectId, canvasId, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, ?, 'agent', 0, 0, NULL, NULL, ?)`
      )
      .run(canvasId, agentNodeId, JSON.stringify(agentData([])));
  } finally {
    sqlite.close();
  }
  return { workspaceId, canvasId, agentNodeId };
}

function grantPermission(
  filename: string,
  canvasId: string,
  nodeId: string,
  permission: string
): void {
  const sqlite = new Database(filename);
  try {
    const data = readNodeDataFrom(sqlite, canvasId, nodeId);
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
      .run(
        JSON.stringify({ ...data, permissions: [...data.permissions, permission] }),
        canvasId,
        nodeId
      );
  } finally {
    sqlite.close();
  }
}

function readNodeData(filename: string, canvasId: string, nodeId: string): Record<string, unknown> {
  const sqlite = new Database(filename, { readonly: true });
  try {
    return readNodeDataFrom(sqlite, canvasId, nodeId);
  } finally {
    sqlite.close();
  }
}

function readNodeDataFrom(
  sqlite: Database.Database,
  canvasId: string,
  nodeId: string
): { readonly permissions: readonly string[] } & Record<string, unknown> {
  const row = sqlite
    .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
    .get(canvasId, nodeId) as { readonly data_json: string } | undefined;
  if (row === undefined) throw new Error("Agent node is missing");
  return JSON.parse(row.data_json) as { readonly permissions: readonly string[] } & Record<
    string,
    unknown
  >;
}

function agentData(permissions: readonly string[]): Record<string, unknown> {
  return {
    title: "Policy agent",
    state: "idle",
    summary: "",
    adapterId: "codex",
    retryMaxAttempts: 1,
    permissions
  };
}
