import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteAgentLifecycleStore } from "./agent-lifecycle-store";
import { runLocalMigrations } from "./migrate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

const role = {
  name: "Testador",
  responsibilities: "Escrever cobertura",
  constraints: "Nunca faz merge",
  expectedDeliverable: "Suíte verde",
  completionCriteria: "Todo caminho novo coberto"
};

describe("SqliteAgentLifecycleStore", () => {
  it("removes the node and every edge that pointed at it", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      const command = store.create({
        workspaceId: fixture.workspaceId,
        targetNodeId: "reviewer",
        action: "remove",
        role: null,
        requestedByNodeId: "planner",
        idempotencyKey: "remove-1"
      });
      expect(command.status).toBe("queued");
      expect(store.claimNext()).toMatchObject({ id: command.id, status: "applying" });

      const event = store.apply(command.id);

      expect(event.removedNodeId).toBe("reviewer");
      expect(event.node).toBeNull();
      expect(nodeIds(fixture.filename)).toEqual(["planner", "briefing"]);
      // A connection left pointing at a node that no longer exists would be a broken canvas.
      expect(edgeIds(fixture.filename)).toEqual([]);
      expect(store.markApplied(command.id).command.status).toBe("applied");
    } finally {
      store.close();
    }
  });

  it("reassigns a responsibility while keeping the same teammate in place", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      const command = store.create({
        workspaceId: fixture.workspaceId,
        targetNodeId: "reviewer",
        action: "assign_role",
        role,
        requestedByNodeId: "planner",
        idempotencyKey: "assign-1"
      });
      store.claimNext();

      const event = store.apply(command.id);

      expect(event.node?.data.role).toEqual(role);
      // Position, size, name and connections are what make it the same teammate, not a new one.
      expect(event.node?.position).toEqual({ x: 40, y: 80 });
      expect(event.node?.data.title).toBe("Revisor");
      expect(edgeIds(fixture.filename)).toEqual(["edge-1"]);
    } finally {
      store.close();
    }
  });

  it("records which session the runtime must stop, read when the command is claimed", async () => {
    const fixture = await createFixture();
    bindSession(fixture, "00000000-0000-4000-8000-0000000000aa");
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      store.create({
        workspaceId: fixture.workspaceId,
        targetNodeId: "reviewer",
        action: "remove",
        role: null,
        requestedByNodeId: "planner",
        idempotencyKey: "remove-session"
      });

      expect(store.claimNext()?.sessionId).toBe("00000000-0000-4000-8000-0000000000aa");
    } finally {
      store.close();
    }
  });

  it("restarts a terminal without touching what makes it the same teammate", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      const command = store.create({
        workspaceId: fixture.workspaceId,
        targetNodeId: "reviewer",
        action: "restart",
        role: null,
        requestedByNodeId: "planner",
        idempotencyKey: "restart-1"
      });
      store.claimNext();

      const event = store.apply(command.id);

      // Node, role, position and connections are untouched: only the process is replaced.
      expect(event.node?.id).toBe("reviewer");
      expect(event.node?.position).toEqual({ x: 40, y: 80 });
      expect(event.removedNodeId).toBeNull();
      expect(edgeIds(fixture.filename)).toEqual(["edge-1"]);
      expect(nodeIds(fixture.filename)).toContain("reviewer");
    } finally {
      store.close();
    }
  });

  it("refuses a restart carrying a role, which would be a silent reassignment", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          targetNodeId: "reviewer",
          action: "restart",
          role,
          requestedByNodeId: "planner",
          idempotencyKey: "restart-with-role"
        })
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("refuses an agent closing its own terminal", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          targetNodeId: "planner",
          action: "remove",
          role: null,
          requestedByNodeId: "planner",
          idempotencyKey: "self-remove"
        })
      ).toThrow("its own terminal");
    } finally {
      store.close();
    }
  });

  it("requires the matching permission for each action", async () => {
    const fixture = await createFixture();
    setPermissions(fixture, "planner", ["remove_agents"]);
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      // Recruiting and dismissing are one grant; rewriting another agent's instructions is another.
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          targetNodeId: "reviewer",
          action: "assign_role",
          role,
          requestedByNodeId: "planner",
          idempotencyKey: "assign-denied"
        })
      ).toThrow("assign_roles");
      expect(
        store.create({
          workspaceId: fixture.workspaceId,
          targetNodeId: "reviewer",
          action: "remove",
          role: null,
          requestedByNodeId: "planner",
          idempotencyKey: "remove-allowed"
        }).status
      ).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("is idempotent per key and refuses a key reused for a different request", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      const input = {
        workspaceId: fixture.workspaceId,
        targetNodeId: "reviewer",
        action: "remove" as const,
        role: null,
        requestedByNodeId: "planner",
        idempotencyKey: "shared-key"
      };
      expect(store.create(input).id).toBe(store.create(input).id);
      expect(() => store.create({ ...input, targetNodeId: "briefing" })).toThrow();
    } finally {
      store.close();
    }
  });

  it("marks a command left in flight as interrupted instead of replaying it", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      const command = store.create({
        workspaceId: fixture.workspaceId,
        targetNodeId: "reviewer",
        action: "remove",
        role: null,
        requestedByNodeId: "planner",
        idempotencyKey: "interrupted"
      });
      store.claimNext();

      expect(store.recoverInterrupted()).toBe(1);

      // Replaying could close a terminal the user has since reopened, so a person decides.
      expect(store.get(command.id)?.status).toBe("interrupted");
      expect(store.claimNext()).toBeNull();
      expect(nodeIds(fixture.filename)).toContain("reviewer");
    } finally {
      store.close();
    }
  });

  it("refuses a target that is not an agent terminal", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentLifecycleStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          targetNodeId: "briefing",
          action: "remove",
          role: null,
          requestedByNodeId: "planner",
          idempotencyKey: "note-target"
        })
      ).toThrow("must be an agent terminal");
    } finally {
      store.close();
    }
  });
});

function nodeIds(filename: string): readonly string[] {
  const sqlite = new Database(filename, { readonly: true });
  try {
    return (
      sqlite
        .prepare("SELECT id FROM canvas_nodes WHERE canvas_id = 'canvas-1' ORDER BY rowid")
        .all() as {
        readonly id: string;
      }[]
    ).map((row) => row.id);
  } finally {
    sqlite.close();
  }
}

function edgeIds(filename: string): readonly string[] {
  const sqlite = new Database(filename, { readonly: true });
  try {
    return (
      sqlite
        .prepare("SELECT id FROM canvas_edges WHERE canvas_id = 'canvas-1' ORDER BY rowid")
        .all() as {
        readonly id: string;
      }[]
    ).map((row) => row.id);
  } finally {
    sqlite.close();
  }
}

function setPermissions(
  fixture: { readonly filename: string },
  nodeId: string,
  permissions: readonly string[]
): void {
  const sqlite = new Database(fixture.filename);
  try {
    const row = sqlite
      .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = 'canvas-1' AND id = ?")
      .get(nodeId) as { readonly data_json: string } | undefined;
    if (row === undefined) throw new Error("Fixture node was not found");
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = 'canvas-1' AND id = ?")
      .run(JSON.stringify({ ...(JSON.parse(row.data_json) as object), permissions }), nodeId);
  } finally {
    sqlite.close();
  }
}

function bindSession(
  fixture: { readonly filename: string; readonly projectId: string; readonly projectRoot: string },
  sessionId: string
): void {
  const sqlite = new Database(fixture.filename);
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO runtime_sessions (id, adapter_id, state, cwd, process_id, started_at, updated_at)
         VALUES (?, 'codex', 'running', ?, 4242, ?, ?)`
      )
      .run(sessionId, fixture.projectRoot, now, now);
    sqlite
      .prepare(
        `INSERT INTO agent_endpoints
           (workspace_id, canvas_id, node_id, project_id, session_id, adapter_id, state, updated_at)
         VALUES ('workspace-1', 'canvas-1', 'reviewer', ?, ?, 'codex', 'online', ?)`
      )
      .run(fixture.projectId, sessionId, now);
  } finally {
    sqlite.close();
  }
}

async function createFixture(): Promise<{
  readonly filename: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly projectRoot: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-agent-lifecycle-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
  const projectRoot = join(directory, "project");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  try {
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
    insertNode(sqlite, canvasId, "planner", "agent", "Planejador", "claude-code", 0, 0);
    insertNode(sqlite, canvasId, "reviewer", "agent", "Revisor", "codex", 40, 80);
    insertNode(sqlite, canvasId, "briefing", "note", "Briefing", undefined, 200, 0);
    sqlite
      .prepare(
        `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
         VALUES (?, 'edge-1', 'briefing', 'reviewer', ?)`
      )
      .run(
        canvasId,
        JSON.stringify({
          schemaVersion: "1.0",
          kind: "context",
          label: "context",
          requiredEvidenceTypes: []
        })
      );
  } finally {
    sqlite.close();
  }
  return { filename, projectId, workspaceId, projectRoot };
}

function insertNode(
  sqlite: Database.Database,
  canvasId: string,
  id: string,
  type: string,
  title: string,
  adapterId: string | undefined,
  x: number,
  y: number
): void {
  sqlite
    .prepare(
      `INSERT INTO canvas_nodes (canvas_id, id, type, position_x, position_y, width, height, data_json)
       VALUES (?, ?, ?, ?, ?, 560, 380, ?)`
    )
    .run(
      canvasId,
      id,
      type,
      x,
      y,
      JSON.stringify({
        title,
        state: "idle",
        ...(adapterId === undefined
          ? {}
          : { adapterId, permissions: ["remove_agents", "assign_roles"] })
      })
    );
}
