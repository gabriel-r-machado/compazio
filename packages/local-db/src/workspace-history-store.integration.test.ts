import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceHistoryStore } from "./workspace-history-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceHistoryStore", () => {
  it("merges every local workspace event family without returning raw content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-history-"));
    directories.push(directory);
    const filename = join(directory, "history.db");
    runLocalMigrations({ filename });
    seedHistory(filename, directory);

    const store = new SqliteWorkspaceHistoryStore(filename);
    try {
      const entries = store.list({ workspaceId: "workspace-1", limit: 100 });
      expect(entries.map((entry) => entry.kind)).toEqual(
        expect.arrayContaining([
          "message",
          "response",
          "note",
          "artifact",
          "connection",
          "approval",
          "failure",
          "retry",
          "runtime"
        ])
      );
      expect(JSON.stringify(entries)).not.toContain("secret message content");
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "retry", eventType: "retry_requested" }),
          expect.objectContaining({ kind: "approval", eventType: "handoff_rejected" })
        ])
      );
      expect(
        store.list({
          workspaceId: "workspace-1",
          agentNodeId: "reviewer",
          kind: "failure",
          state: "failed",
          since: "2026-07-20T00:00:00.000Z",
          until: "2026-07-21T00:00:00.000Z"
        })
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "failure",
            eventType: "delivery_failed",
            state: "failed"
          })
        ])
      );
    } finally {
      store.close();
    }
  });
});

function seedHistory(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const at = Date.parse("2026-07-20T12:00:00.000Z");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES ('project-1', 'History', ?, ?, 'main', 'abc', ?, ?)`
      )
      .run(root, root, at, at);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-1', 'Main', '', 1, '{}', ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES ('workspace-1', 'project-1', 'canvas-1', 'Main', 0, 1, ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO agent_messages (id, workspace_id, project_id, recipient_node_id, sender_node_id, content, status,
          idempotency_key, attempt, session_id, adapter_id, error_code, created_at, updated_at, sent_at)
         VALUES ('message-1', 'workspace-1', 'project-1', 'reviewer', NULL, 'secret message content', 'failed',
          'message-key', 1, NULL, 'codex', 'agent_bridge_send_failed', ?, ?, NULL)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO agent_message_events (id, message_id, sequence, type, detail_json, created_at)
         VALUES ('message-event-1', 'message-1', 1, 'message_queued', '{}', ?),
                ('message-event-2', 'message-1', 2, 'delivery_failed', '{}', ?),
                ('message-event-3', 'message-1', 3, 'retry_requested', '{}', ?)`
      )
      .run(at, at + 1, at + 2);
    sqlite
      .prepare(
        `INSERT INTO agent_message_responses (id, request_message_id, workspace_id, project_id, responder_node_id, content,
          status, idempotency_key, delivery_message_id, created_at)
         VALUES ('response-1', 'message-1', 'workspace-1', 'project-1', 'reviewer', 'private answer',
          'recorded', 'response-key', NULL, ?)`
      )
      .run(at + 2);
    sqlite
      .prepare(
        `INSERT INTO workspace_notes (id, workspace_id, canvas_id, project_id, node_id, title, content, revision,
          created_by_node_id, create_idempotency_key, created_at, updated_at)
         VALUES ('note-1', 'workspace-1', 'canvas-1', 'project-1', 'note-1', 'Decision', 'secret note', 1,
          'reviewer', 'note-key', ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO workspace_note_events (id, note_id, sequence, type, idempotency_key, content_hash, projection_state, created_at)
         VALUES ('note-event-1', 'note-1', 1, 'note_created', 'note-event-key', 'a', 'published', ?)`
      )
      .run(at + 3);
    sqlite
      .prepare(
        `INSERT INTO workspace_artifacts (id, workspace_id, project_id, kind, source_relative_path, relative_path, filename,
          sha256, byte_size, media_type, published_by_node_id, idempotency_key, created_at)
         VALUES ('artifact-1', 'workspace-1', 'project-1', 'report', 'safe.json', 'artifact.json', 'artifact.json',
          'b', 1, 'application/json', 'reviewer', 'artifact-key', ?)`
      )
      .run(at);
    sqlite
      .prepare(
        `INSERT INTO workspace_artifact_events (id, artifact_id, sequence, type, projection_state, created_at)
         VALUES ('artifact-event-1', 'artifact-1', 1, 'artifact_published', 'published', ?)`
      )
      .run(at + 4);
    sqlite
      .prepare(
        `INSERT INTO workspace_connection_events (id, workspace_id, canvas_id, edge_id, source_node_id, target_node_id,
          contract_json, event_type, actor_node_id, canvas_revision, idempotency_key, projection_state, created_at)
         VALUES ('connection-event-1', 'workspace-1', 'canvas-1', 'edge-1', 'note-1', 'reviewer',
          '{"kind":"context"}', 'connection_created', 'reviewer', 2, 'connection-key', 'published', ?)`
      )
      .run(at + 5);
    sqlite
      .prepare(
        `INSERT INTO canvas_handoffs (id, canvas_id, project_id, status, revision, mission, source_json, target_json,
          edge_json, content_json, error, created_at, updated_at, ready_at, delivered_at)
         VALUES ('handoff-1', 'canvas-1', 'project-1', 'failed', 1, 'Mission', '{"nodeId":"author"}',
          '{"nodeId":"reviewer"}', '{}', '{}', NULL, ?, ?, NULL, NULL)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO canvas_handoff_events (id, handoff_id, sequence, type, from_status, to_status, error, delivery_attempt_id, responsible, created_at)
         VALUES ('handoff-event-1', 'handoff-1', 1, 'handoff_ready', 'draft', 'ready', NULL, NULL, 'local_user', ?),
                ('handoff-event-2', 'handoff-1', 2, 'retry_requested', 'failed', 'ready', NULL, NULL, 'local_user', ?),
                ('handoff-event-3', 'handoff-1', 3, 'delivery_failed', 'ready', 'failed', 'failed', NULL, 'system', ?),
                ('handoff-event-4', 'handoff-1', 4, 'handoff_rejected', 'draft', 'rejected', 'Evidence is incomplete', NULL, 'local_user', ?)`
      )
      .run(at + 6, at + 7, at + 8, at + 9);
    sqlite
      .prepare(
        `INSERT INTO agent_spawns (id, workspace_id, canvas_id, project_id, node_id, adapter_id, role_name, name,
          normalized_name, requested_by_node_id, status, idempotency_key, attempt, session_id, error_code, created_at, updated_at)
         VALUES ('spawn-1', 'workspace-1', 'canvas-1', 'project-1', 'reviewer', 'codex', 'Reviewer', 'Reviewer',
          'reviewer', NULL, 'running', 'spawn-key', 1, NULL, NULL, ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO agent_spawn_events (id, spawn_id, sequence, type, detail_json, created_at)
         VALUES ('spawn-event-1', 'spawn-1', 1, 'agent_running', '{}', ?)`
      )
      .run(at + 9);
  } finally {
    sqlite.close();
  }
}
