import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceActivityStore } from "./workspace-activity-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceActivityStore", () => {
  it("emits new redacted message and handoff activity once after its watermark", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-activity-"));
    directories.push(directory);
    const filename = join(directory, "activity.db");
    runLocalMigrations({ filename });
    seedWorkspace(filename);

    const store = new SqliteWorkspaceActivityStore(filename);
    try {
      store.prime();
      appendActivity(filename);
      const events = store.pull();
      expect(events).toEqual([
        expect.objectContaining({
          id: "message:message-event-2",
          workspaceId: "workspace-1",
          canvasId: "canvas-1",
          subject: "message",
          subjectId: "message-1",
          agentNodeId: "reviewer",
          eventType: "message_sent"
        }),
        expect.objectContaining({
          id: "handoff:handoff-event-1",
          subject: "handoff",
          subjectId: "handoff-1",
          agentNodeId: "reviewer",
          eventType: "handoff_ready"
        })
      ]);
      expect(JSON.stringify(events)).not.toContain("private content");
      expect(store.pull()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

function seedWorkspace(filename: string): void {
  const at = Date.parse("2026-07-20T12:00:00.000Z");
  const sqlite = new Database(filename);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES ('project-1', 'Activity', 'C:/activity', 'C:/activity', 'main', 'HEAD', ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-1', 'Activity', '', 0, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO workspaces
         (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES ('workspace-1', 'project-1', 'canvas-1', 'Activity', 0, 1, ?, ?)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO agent_messages
         (id, workspace_id, project_id, recipient_node_id, sender_node_id, content, status,
          idempotency_key, attempt, session_id, adapter_id, error_code, created_at, updated_at, sent_at)
         VALUES ('message-1', 'workspace-1', 'project-1', 'reviewer', NULL, 'private content', 'queued',
          'message-key', 0, NULL, NULL, NULL, ?, ?, NULL)`
      )
      .run(at, at);
    sqlite
      .prepare(
        `INSERT INTO agent_message_events (id, message_id, sequence, type, detail_json, created_at)
         VALUES ('message-event-1', 'message-1', 1, 'message_queued', '{}', ?)`
      )
      .run(at);
  } finally {
    sqlite.close();
  }
}

function appendActivity(filename: string): void {
  const at = Date.parse("2026-07-20T12:01:00.000Z");
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO agent_message_events (id, message_id, sequence, type, detail_json, created_at)
         VALUES ('message-event-2', 'message-1', 2, 'message_sent', '{}', ?)`
      )
      .run(at);
    sqlite
      .prepare(
        `INSERT INTO canvas_handoffs
         (id, canvas_id, project_id, status, revision, mission, source_json, target_json, edge_json,
          content_json, error, created_at, updated_at, ready_at, delivered_at)
         VALUES ('handoff-1', 'canvas-1', 'project-1', 'ready', 1, 'Mission', '{"nodeId":"author"}',
          '{"nodeId":"reviewer"}', '{}', '{}', NULL, ?, ?, ?, NULL)`
      )
      .run(at, at, at);
    sqlite
      .prepare(
        `INSERT INTO canvas_handoff_events
         (id, handoff_id, sequence, type, from_status, to_status, error, delivery_attempt_id,
          responsible, created_at)
         VALUES ('handoff-event-1', 'handoff-1', 1, 'handoff_ready', 'draft', 'ready', NULL, NULL,
          'local_user', ?)`
      )
      .run(at + 1);
  } finally {
    sqlite.close();
  }
}
