import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteAgentSpawnStore } from "./agent-spawn-store";
import { runLocalMigrations } from "./migrate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteAgentSpawnStore", () => {
  it("creates an idempotent request, materializes the node and records a running session", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentSpawnStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const input = {
        workspaceId: fixture.workspaceId,
        adapterId: "codex" as const,
        roleName: "tester",
        name: "qa-auth",
        requestedByNodeId: null,
        idempotencyKey: "spawn-1"
      };
      const created = store.create(input);
      expect(store.create(input).id).toBe(created.id);
      expect(created).toMatchObject({ status: "queued", attempt: 0, name: "qa-auth" });

      const claimed = store.claimNext();
      expect(claimed).toMatchObject({ id: created.id, status: "spawning", attempt: 1 });
      const materialized = store.materializeNode(created.id);
      expect(materialized).toMatchObject({
        spawn: { id: created.id, status: "spawning" },
        node: { id: created.nodeId, type: "agent", data: { state: "starting" } },
        canvasRevision: 2
      });

      insertSession(fixture, "00000000-0000-4000-8000-000000000099");
      const running = store.markRunning(created.id, "00000000-0000-4000-8000-000000000099");
      expect(running).toMatchObject({
        spawn: { status: "running", sessionId: "00000000-0000-4000-8000-000000000099" },
        canvasEvent: { node: { data: { state: "running" } }, canvasRevision: 3 }
      });
      expect(store.listEvents(created.id).map((event) => event.type)).toEqual([
        "spawn_queued",
        "spawn_started",
        "node_created",
        "agent_running"
      ]);
    } finally {
      store.close();
    }
  });

  it("requires create_agents when another agent requests the spawn", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentSpawnStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          adapterId: "claude-code",
          roleName: "reviewer",
          name: "reviewer-2",
          requestedByNodeId: "orchestrator",
          idempotencyKey: "spawn-denied"
        })
      ).toThrow("create_agents permission");

      grantCreateAgents(fixture.filename, fixture.canvasId);
      expect(
        store.create({
          workspaceId: fixture.workspaceId,
          adapterId: "claude-code",
          roleName: "reviewer",
          name: "reviewer-2",
          requestedByNodeId: "orchestrator",
          idempotencyKey: "spawn-allowed"
        })
      ).toMatchObject({ status: "queued", requestedByNodeId: "orchestrator" });
    } finally {
      store.close();
    }
  });

  it("keeps a materialized node visible as failed when launch fails", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentSpawnStore(fixture.filename);
    try {
      const spawn = store.create({
        workspaceId: fixture.workspaceId,
        adapterId: "codex",
        roleName: "tester",
        name: "qa-failure",
        requestedByNodeId: null,
        idempotencyKey: "spawn-failure"
      });
      store.claimNext();
      store.materializeNode(spawn.id);
      const failed = store.markFailed(spawn.id, "agent_launch_failed");
      expect(failed).toMatchObject({
        spawn: { status: "failed", errorCode: "agent_launch_failed" },
        canvasEvent: { node: { data: { state: "failed" } } }
      });
    } finally {
      store.close();
    }
  });

  it("requires an explicit retry after recovery and restarts the existing canvas node", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentSpawnStore(fixture.filename, { now: clock() });
    try {
      const spawn = store.create({
        workspaceId: fixture.workspaceId,
        adapterId: "codex",
        roleName: "tester",
        name: "qa-recovery",
        requestedByNodeId: null,
        idempotencyKey: "spawn-recovery"
      });
      store.claimNext();
      store.materializeNode(spawn.id);
      expect(store.recoverInterrupted()).toBe(1);
      expect(store.get(spawn.id)).toMatchObject({ status: "interrupted", attempt: 1 });
      expect(() => store.retry(spawn.id, "orchestrator")).toThrow("create_agents permission");
      expect(() => store.claimNext()).not.toThrow();
      expect(store.claimNext()).toBeNull();

      const retried = store.retry(spawn.id);
      expect(retried).toMatchObject({ status: "queued", attempt: 1, sessionId: null });
      const claimed = store.claimNext();
      expect(claimed).toMatchObject({ status: "spawning", attempt: 2 });
      const restarted = store.materializeNode(spawn.id);
      expect(restarted).toMatchObject({
        node: { id: spawn.nodeId, data: { state: "starting" } },
        canvasRevision: 4
      });
      expect(store.listEvents(spawn.id).map((event) => event.type)).toEqual([
        "spawn_queued",
        "spawn_started",
        "node_created",
        "spawn_interrupted",
        "spawn_retry_requested",
        "spawn_started",
        "node_restarted"
      ]);
      expect(() => store.retry(spawn.id)).toThrow("not eligible for manual retry");
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly canvasId: string;
  readonly projectRoot: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-agent-spawn-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
  const projectRoot = join(directory, "project");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  sqlite
    .prepare(
      `INSERT INTO projects
       (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
       VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
    )
    .run(projectId, projectRoot, projectRoot, now, now);
  sqlite
    .prepare(
      `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
       VALUES (?, 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
    )
    .run(canvasId, now, now);
  sqlite
    .prepare(
      `INSERT INTO workspaces
       (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
       VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
    )
    .run(workspaceId, projectId, canvasId, now, now);
  sqlite
    .prepare(
      `INSERT INTO canvas_nodes
       (canvas_id, id, type, position_x, position_y, width, height, data_json)
       VALUES (?, 'orchestrator', 'agent', 0, 0, 560, 380, ?)`
    )
    .run(
      canvasId,
      JSON.stringify({
        title: "Orchestrator",
        state: "running",
        summary: "",
        adapterId: "codex",
        retryMaxAttempts: 1,
        permissions: []
      })
    );
  sqlite.close();
  return { filename, projectId, workspaceId, canvasId, projectRoot };
}

function insertSession(
  fixture: { readonly filename: string; readonly projectRoot: string },
  sessionId: string
): void {
  const sqlite = new Database(fixture.filename);
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO runtime_sessions
         (id, adapter_id, state, cwd, process_id, started_at, updated_at, ended_at,
          exit_code, exit_signal, interruption_reason)
         VALUES (?, 'codex', 'running', ?, 123, ?, ?, NULL, NULL, NULL, NULL)`
      )
      .run(sessionId, fixture.projectRoot, now, now);
  } finally {
    sqlite.close();
  }
}

function grantCreateAgents(filename: string, canvasId: string): void {
  const sqlite = new Database(filename);
  try {
    const row = sqlite
      .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = 'orchestrator'")
      .get(canvasId) as { readonly data_json: string };
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = 'orchestrator'")
      .run(JSON.stringify({ ...data, permissions: ["create_agents"] }), canvasId);
  } finally {
    sqlite.close();
  }
}

function sequentialIds(): () => string {
  let sequence = 10;
  return () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`;
}

function clock(): () => Date {
  let timestamp = Date.parse("2026-07-20T12:00:00.000Z");
  return () => new Date(timestamp++);
}
