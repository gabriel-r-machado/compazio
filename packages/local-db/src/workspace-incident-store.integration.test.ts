import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceIncidentStore } from "./workspace-incident-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceIncidentStore", () => {
  it("reads failures from the top every time, so a reload never loses one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-incidents-"));
    directories.push(directory);
    const filename = join(directory, "incidents.db");
    runLocalMigrations({ filename });
    seed(filename);

    const store = new SqliteWorkspaceIncidentStore(filename);
    try {
      const first = store.list({ workspaceId: "workspace-1", limit: 50 });
      // Newest first, and every source of failure in one list.
      expect(first.incidents.map((incident) => incident.kind)).toEqual([
        "spawn_failed",
        "message_failed",
        "lifecycle_failed",
        "policy_denied"
      ]);

      const denial = first.incidents.at(-1);
      expect(denial).toMatchObject({
        id: "policy:decision-denied",
        kind: "policy_denied",
        severity: "error",
        nodeId: "planner",
        actorNodeId: "planner",
        // The permission that was missing is the entire point: it is what tells you which box to tick.
        detail: "create_agents",
        context: "permission_missing"
      });

      // A second store — the same thing a reopened app does — sees exactly the same list. This is the
      // difference from the activity cursor, which primes a watermark and would report nothing here.
      const reopened = new SqliteWorkspaceIncidentStore(filename);
      try {
        expect(reopened.list({ workspaceId: "workspace-1", limit: 50 }).incidents).toEqual(
          first.incidents
        );
      } finally {
        reopened.close();
      }

      // An allowed decision is not a failure and must not appear.
      expect(first.incidents.map((incident) => incident.id)).not.toContain(
        "policy:decision-allowed"
      );
      // Another workspace's failures never leak into this one.
      expect(store.list({ workspaceId: "workspace-2", limit: 50 }).incidents).toEqual([]);
      // The limit is respected and keeps the newest, not the oldest.
      expect(store.list({ workspaceId: "workspace-1", limit: 1 }).incidents).toEqual([
        first.incidents[0]
      ]);
    } finally {
      store.close();
    }
  });
});

function seed(filename: string): void {
  const at = Date.parse("2026-07-20T12:00:00.000Z");
  const sqlite = new Database(filename);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES ('project-1', 'Incidents', 'C:/incidents', 'C:/incidents', 'main', 'HEAD', ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-1', 'Incidents', '', 0, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO workspaces
         (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES ('workspace-1', 'project-1', 'canvas-1', 'Incidents', 0, 1, ?, ?)`
      )
      .run(at, at);

    const decision = sqlite.prepare(
      `INSERT INTO policy_decisions
       (id, workspace_id, canvas_id, actor_node_id, permission, outcome, reason, created_at)
       VALUES (?, 'workspace-1', 'canvas-1', ?, ?, ?, ?, ?)`
    );
    decision.run(
      "decision-denied",
      "planner",
      "create_agents",
      "denied",
      "permission_missing",
      at + 1_000
    );
    decision.run(
      "decision-allowed",
      "planner",
      "read_context",
      "allowed",
      "permission_granted",
      at + 1_500
    );

    sqlite
      .prepare(
        `INSERT INTO agent_lifecycle_commands
         (id, workspace_id, canvas_id, project_id, target_node_id, action, role_json,
          requested_by_node_id, status, idempotency_key, session_id, error_code, created_at, updated_at)
         VALUES ('command-1', 'workspace-1', 'canvas-1', 'project-1', 'reviewer', 'assign_role', NULL,
          'planner', 'failed', 'command-key', NULL, 'agent_restart_failed', ?, ?)`
      )
      .run(at, at + 2_000);

    sqlite
      .prepare(
        `INSERT INTO agent_messages
         (id, workspace_id, project_id, recipient_node_id, sender_node_id, content, status,
          idempotency_key, attempt, session_id, adapter_id, error_code, created_at, updated_at, sent_at)
         VALUES ('message-1', 'workspace-1', 'project-1', 'reviewer', 'planner', 'private content',
          'failed', 'message-key', 1, NULL, NULL, 'recipient_inactive', ?, ?, NULL)`
      )
      .run(at, at + 3_000);

    sqlite
      .prepare(
        `INSERT INTO agent_spawns
         (id, workspace_id, canvas_id, project_id, node_id, adapter_id, role_name, name,
          normalized_name, requested_by_node_id, status, idempotency_key, attempt, session_id,
          error_code, created_at, updated_at)
         VALUES ('spawn-1', 'workspace-1', 'canvas-1', 'project-1', 'tester', 'codex', 'Testador',
          'qa-auth', 'qa-auth', 'planner', 'failed', 'spawn-key', 1, NULL, 'adapter_unavailable', ?, ?)`
      )
      .run(at + 4_000, at + 4_000);
  } finally {
    sqlite.close();
  }
}
