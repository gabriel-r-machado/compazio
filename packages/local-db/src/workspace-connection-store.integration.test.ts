import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceConnectionStore } from "./workspace-connection-store";
import { SqliteWorkspaceContextStore } from "./workspace-context-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceConnectionStore", () => {
  it("creates one canonical context edge, audits it, and projects the same edge to the canvas", async () => {
    const fixture = await createFixture();
    const connections = new SqliteWorkspaceConnectionStore(fixture.filename);
    const context = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const event = connections.create(createInput(fixture.workspaceId));

      expect(event).toMatchObject({
        type: "connection_created",
        workspaceId: fixture.workspaceId,
        canvasId: fixture.canvasId,
        connection: {
          connectionId: event.edge.id,
          sourceNodeId: "note-requirements",
          targetNodeId: "reviewer",
          type: "context",
          permission: "connect_context"
        },
        edge: {
          id: event.connection.connectionId,
          source: "note-requirements",
          target: "reviewer",
          contract: { kind: "context", label: "Context" }
        },
        canvasRevision: 2
      });
      expect(connections.list(fixture.workspaceId)).toEqual([event.connection]);
      expect(connections.claimNextCanvasEvent()).toEqual(event);
      connections.markCanvasEventPublished(event.id);
      expect(connections.claimNextCanvasEvent()).toBeNull();
      expect(
        context.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: null
        }).sources
      ).toEqual([expect.objectContaining({ nodeId: "note-requirements", edgeId: event.edge.id })]);
    } finally {
      context.close();
      connections.close();
    }
  });

  it("resolves IDs or unambiguous names and rejects missing and ambiguous entities", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    try {
      expect(store.resolveNode(fixture.workspaceId, "Requirements")).toMatchObject({
        nodeId: "note-requirements"
      });
      expect(() => store.resolveNode(fixture.workspaceId, "missing")).toThrow("entity not found");
      fixture.insertNode("note-requirements-copy", "note", "Requirements");
      expect(() => store.resolveNode(fixture.workspaceId, "Requirements")).toThrow("ambiguous");
      expect(() =>
        store.create({ ...createInput(fixture.workspaceId), sourceNodeId: "missing" })
      ).toThrow("source was not found");
      expect(() =>
        store.create({ ...createInput(fixture.workspaceId), targetNodeId: "missing" })
      ).toThrow("target was not found");
    } finally {
      store.close();
    }
  });

  it("rejects self-loops, duplicate routes, and dependency or handoff cycles", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          ...createInput(fixture.workspaceId),
          sourceNodeId: "task-a",
          targetNodeId: "task-a",
          type: "dependency"
        })
      ).toThrow("must differ");
      const first = store.create({
        ...createInput(fixture.workspaceId),
        sourceNodeId: "task-a",
        targetNodeId: "task-b",
        type: "dependency",
        label: null,
        idempotencyKey: "task-a-task-b"
      });
      const duplicate = store.create({
        ...createInput(fixture.workspaceId),
        sourceNodeId: "task-a",
        targetNodeId: "task-b",
        type: "dependency",
        label: null,
        idempotencyKey: "task-a-task-b-again"
      });
      expect(duplicate).toEqual(first);
      expect(connectionsInDatabase(fixture.filename)).toHaveLength(1);
      expect(() =>
        store.create({
          ...createInput(fixture.workspaceId),
          sourceNodeId: "task-b",
          targetNodeId: "task-a",
          type: "handoff",
          label: null,
          idempotencyKey: "task-b-task-a"
        })
      ).toThrow("workflow cycle");
    } finally {
      store.close();
    }
  });

  it("requires connect_context for an agent without allowing it to grant access to another agent", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    try {
      expect(() =>
        store.create({ ...createInput(fixture.workspaceId), createdByNodeId: "reviewer" })
      ).toThrow("connect_context permission");
      fixture.setPermissions("reviewer", ["connect_context"]);
      expect(() =>
        store.create({
          ...createInput(fixture.workspaceId),
          createdByNodeId: "reviewer",
          targetNodeId: "qa",
          idempotencyKey: "reviewer-grants-qa"
        })
      ).toThrow("only connect context to itself");
      expect(() =>
        store.create({
          ...createInput(fixture.workspaceId),
          createdByNodeId: "qa",
          idempotencyKey: "qa-without-permission"
        })
      ).toThrow("connect_context permission");
    } finally {
      store.close();
    }
  });

  it("is idempotent, enforces optimistic concurrency, removes durably, and survives reload", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    const context = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const first = store.create({
        ...createInput(fixture.workspaceId),
        expectedCanvasRevision: 1,
        idempotencyKey: "requirements-reviewer"
      });
      expect(
        store.create({
          ...createInput(fixture.workspaceId),
          expectedCanvasRevision: 1,
          idempotencyKey: "requirements-reviewer"
        })
      ).toEqual(first);
      expect(() =>
        store.create({
          ...createInput(fixture.workspaceId),
          sourceNodeId: "task-a",
          targetNodeId: "task-b",
          type: "dependency",
          label: null,
          expectedCanvasRevision: 1,
          idempotencyKey: "stale-write"
        })
      ).toThrow("revision conflict");
      const removed = store.remove({
        workspaceId: fixture.workspaceId,
        connectionId: first.connection.connectionId,
        removedByNodeId: null,
        expectedCanvasRevision: 2,
        idempotencyKey: "remove-requirements-reviewer"
      });
      expect(removed).toMatchObject({
        type: "connection_removed",
        edge: { id: first.edge.id },
        canvasRevision: 3
      });
      expect(store.list(fixture.workspaceId)).toEqual([]);
      expect(
        context.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: null
        }).sources
      ).toEqual([]);
      expect(store.claimNextCanvasEvent()).toEqual(first);
      store.markCanvasEventPublished(first.id);
      expect(store.claimNextCanvasEvent()).toEqual(removed);
      store.markCanvasEventPublished(removed.id);
    } finally {
      context.close();
      store.close();
    }

    const reloaded = new SqliteWorkspaceConnectionStore(fixture.filename);
    try {
      expect(reloaded.list(fixture.workspaceId)).toEqual([]);
      expect(() => reloaded.show(fixture.workspaceId, "missing")).toThrow("not found");
    } finally {
      reloaded.close();
    }
  });

  it("lets a note anchor another note, so material can be organised as a tree", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    const context = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      fixture.insertNode("note-rules", "note", "Regras");
      fixture.setPermissions("reviewer", ["connect_context"]);
      store.create(createInput(fixture.workspaceId));
      // Wiring a note behind another grants nobody anything new: the chain still only reaches
      // whoever the anchor note already reaches, so an agent may draw it.
      store.create({
        ...createInput(fixture.workspaceId),
        sourceNodeId: "note-rules",
        targetNodeId: "note-requirements",
        createdByNodeId: "reviewer",
        idempotencyKey: "rules-requirements"
      });

      expect(
        context
          .resolve({
            workspaceId: fixture.workspaceId,
            agentNodeId: "reviewer",
            requesterNodeId: null
          })
          .sources.map((source) => source.nodeId)
      ).toEqual(["note-requirements", "note-rules"]);
    } finally {
      context.close();
      store.close();
    }
  });

  it("still refuses an agent granting context to another agent", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    try {
      fixture.setPermissions("reviewer", ["connect_context"]);
      expect(() =>
        store.create({
          ...createInput(fixture.workspaceId),
          targetNodeId: "qa",
          createdByNodeId: "reviewer",
          idempotencyKey: "widen-another-agent"
        })
      ).toThrow("only connect context to itself");
    } finally {
      store.close();
    }
  });

  it("exposes material connected to an agent, and never a reviewed handoff or a gate", async () => {
    const fixture = await createFixture();
    // A plain "depends on" edge drawn from a material is a context grant: the canvas offered that
    // edge before an explicit context kind existed, and a material wired into an agent is material
    // the agent is meant to read. `handoff` and `approval` carry their own distinct meaning — a
    // reviewed delivery and a gate — so neither grants context implicitly.
    fixture.insertEdge("edge-private-dependency", "note-private", "reviewer", "dependency");
    fixture.insertNode("note-handoff", "note", "Handoff");
    fixture.insertNode("note-approval", "note", "Approval");
    fixture.insertEdge("edge-private-handoff", "note-handoff", "reviewer", "handoff");
    fixture.insertEdge("edge-private-approval", "note-approval", "reviewer", "approval");
    const store = new SqliteWorkspaceConnectionStore(fixture.filename);
    const context = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      store.create(createInput(fixture.workspaceId));
      expect(
        context
          .resolve({
            workspaceId: fixture.workspaceId,
            agentNodeId: "reviewer",
            requesterNodeId: null
          })
          .sources.map((source) => source.nodeId)
          .sort()
      ).toEqual(["note-private", "note-requirements"]);
      fixture.setPermissions("qa", ["read_context"]);
      expect(
        context.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "qa",
          requesterNodeId: "qa"
        }).sources
      ).toEqual([]);
      expect(() =>
        context.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: "qa"
        })
      ).toThrow("only read context connected to itself");
    } finally {
      context.close();
      store.close();
    }
  });
});

function createInput(workspaceId: string) {
  return {
    workspaceId,
    sourceNodeId: "note-requirements",
    targetNodeId: "reviewer",
    type: "context" as const,
    label: null,
    createdByNodeId: null,
    idempotencyKey: "requirements-reviewer",
    expectedCanvasRevision: null
  };
}

function connectionsInDatabase(filename: string): readonly { readonly id: string }[] {
  const sqlite = new Database(filename, { readonly: true });
  try {
    return sqlite.prepare("SELECT id FROM canvas_edges WHERE canvas_id = 'canvas-1'").all() as {
      readonly id: string;
    }[];
  } finally {
    sqlite.close();
  }
}

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly canvasId: string;
  readonly setPermissions: (nodeId: string, permissions: readonly string[]) => void;
  readonly insertNode: (id: string, type: string, title: string) => void;
  readonly insertEdge: (
    id: string,
    sourceNodeId: string,
    targetNodeId: string,
    kind: string
  ) => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-workspace-connection-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
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
         VALUES (?, 'Principal', 'Review requirements', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(canvasId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
      )
      .run(workspaceId, projectId, canvasId, now, now);
    insertNode(sqlite, canvasId, "reviewer", "agent", "Reviewer");
    insertNode(sqlite, canvasId, "qa", "agent", "QA");
    insertNode(
      sqlite,
      canvasId,
      "note-requirements",
      "note",
      "Requirements",
      "Review requirements."
    );
    insertNode(sqlite, canvasId, "note-private", "note", "Private", "Private source.");
    insertNode(sqlite, canvasId, "task-a", "task", "Task A");
    insertNode(sqlite, canvasId, "task-b", "task", "Task B");
  } finally {
    sqlite.close();
  }
  return {
    filename,
    workspaceId,
    canvasId,
    setPermissions: (nodeId, permissions) => {
      const database = new Database(filename);
      try {
        const node = database
          .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
          .get(canvasId, nodeId) as { readonly data_json: string } | undefined;
        if (node === undefined) throw new Error("Fixture node was not found");
        database
          .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
          .run(
            JSON.stringify({ ...(JSON.parse(node.data_json) as object), permissions }),
            canvasId,
            nodeId
          );
      } finally {
        database.close();
      }
    },
    insertNode: (id, type, title) => {
      const database = new Database(filename);
      try {
        insertNode(database, canvasId, id, type, title);
      } finally {
        database.close();
      }
    },
    insertEdge: (id, sourceNodeId, targetNodeId, kind) => {
      const database = new Database(filename);
      try {
        database
          .prepare(
            `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            canvasId,
            id,
            sourceNodeId,
            targetNodeId,
            JSON.stringify({ schemaVersion: "1.0", kind, label: kind, requiredEvidenceTypes: [] })
          );
      } finally {
        database.close();
      }
    }
  };
}

function insertNode(
  sqlite: Database.Database,
  canvasId: string,
  id: string,
  type: string,
  title: string,
  content = ""
): void {
  const data = {
    title,
    state: "idle",
    summary: content,
    ...(type === "note" ? { content } : {}),
    ...(type === "agent" ? { adapterId: "codex" } : {}),
    retryMaxAttempts: 1,
    permissions: []
  };
  sqlite
    .prepare(
      `INSERT INTO canvas_nodes (canvas_id, id, type, position_x, position_y, width, height, data_json)
       VALUES (?, ?, ?, 0, 0, 360, 220, ?)`
    )
    .run(canvasId, id, type, JSON.stringify(data));
}
