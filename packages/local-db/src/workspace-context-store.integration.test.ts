import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceContextStore } from "./workspace-context-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceContextStore", () => {
  it("follows a chain of notes, so one connection hands over the whole tree", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const context = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      });

      // Only `note-direct` is wired to the reviewer; `note-transitive` is wired to `note-direct`.
      // Both arrive, in the order the chain is walked, so the anchor note comes first.
      expect(context.sources.map((source) => source.nodeId)).toEqual([
        "note-direct",
        "note-transitive"
      ]);
      expect(context.sources[0]).toEqual({
        nodeId: "note-direct",
        title: "Decisões",
        kind: "note",
        content: "Use SQLite local.",
        inclusion: "relevant",
        edgeId: "edge-direct",
        contract: {
          schemaVersion: "1.0",
          kind: "context",
          label: "Contexto de revisão",
          requiredEvidenceTypes: []
        }
      });
      // A chained material carries the edge that connects it to its parent, not to the agent.
      expect(context.sources[1]).toMatchObject({
        nodeId: "note-transitive",
        edgeId: "edge-transitive"
      });
      // Another agent's material is still none of this agent's business.
      expect(context.sources.map((source) => source.nodeId)).not.toContain("note-qa");
    } finally {
      store.close();
    }
  });

  it("terminates on a chain the canvas drew as a cycle", async () => {
    const fixture = await createFixture();
    fixture.connectNoteCycle();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const context = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      });

      expect(context.sources.map((source) => source.nodeId).sort()).toEqual([
        "note-direct",
        "note-transitive"
      ]);
    } finally {
      store.close();
    }
  });

  it("requires read_context for an agent and never lets it read another agent's context", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      expect(() =>
        store.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: "reviewer"
        })
      ).toThrow("read_context permission");

      fixture.setPermissions("reviewer", ["read_context"]);
      expect(() =>
        store.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "qa",
          requesterNodeId: "reviewer"
        })
      ).toThrow("only read context connected to itself");
    } finally {
      store.close();
    }
  });

  it("returns only immutable metadata for a directly connected published artifact", async () => {
    const fixture = await createFixture();
    fixture.connectArtifact();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const sources = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      }).sources;
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "artifact-report",
            artifact: expect.objectContaining({
              id: "00000000-0000-4000-8000-000000000010",
              filename: "review.json",
              relativePath: ".forgedeck/artifacts/report/review.json",
              sha256: "a".repeat(64)
            })
          })
        ])
      );
      expect(
        sources.find((source) => source.nodeId === "artifact-report")?.content
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("returns a typed context source only through its direct context connection", async () => {
    const fixture = await createFixture();
    fixture.connectTextSource();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const sources = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      }).sources;
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "text-direct",
            kind: "text",
            content: "Use the approved interface contract.",
            reference: { kind: "text" },
            edgeId: "edge-text-direct"
          })
        ])
      );
      expect(sources.find((source) => source.nodeId === "note-qa")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("treats a plain 'depends on' edge from a material into an agent as context too", async () => {
    const fixture = await createFixture();
    fixture.connectLegacyDependencyNote();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const sources = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      }).sources;
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "note-legacy",
            kind: "note",
            content: "Conteúdo legado.",
            contract: expect.objectContaining({ kind: "dependency" })
          })
        ])
      );
    } finally {
      store.close();
    }
  });

  it("still excludes handoff and approval edges from implicit context", async () => {
    const fixture = await createFixture();
    fixture.connectNonContextKinds();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const sources = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      }).sources;
      expect(sources.find((source) => source.nodeId === "note-handoff")).toBeUndefined();
      expect(sources.find((source) => source.nodeId === "note-approval")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("propagates inline image bytes for a connected image context source", async () => {
    const fixture = await createFixture();
    fixture.connectImageSource();
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      const sources = store.resolve({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        requesterNodeId: null
      }).sources;
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "image-direct",
            kind: "image",
            reference: {
              kind: "image",
              filename: "photo.png",
              mediaType: "image/png",
              previewDataUri: "data:image/png;base64,AAAA"
            }
          })
        ])
      );
    } finally {
      store.close();
    }
  });

  it("excludes a source marked never unless a selection audit explicitly requests it", async () => {
    const fixture = await createFixture();
    fixture.setContextInclusion("note-direct", "never");
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      expect(
        store.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: null
        }).sources
      ).toEqual([]);
      expect(
        store.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: null,
          includeNever: true
        }).sources
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: "note-direct", inclusion: "never" })
        ])
      );
    } finally {
      store.close();
    }
  });

  it("carries the agent's own responsibility, and reports none when it has none", async () => {
    const fixture = await createFixture();
    fixture.setRole("reviewer", {
      name: "Revisor",
      responsibilities: "Revisar cada diff",
      constraints: "Nunca faz merge",
      expectedDeliverable: "Lista de regressões",
      completionCriteria: "Todo arquivo alterado revisado"
    });
    const store = new SqliteWorkspaceContextStore(fixture.filename);
    try {
      expect(
        store.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          requesterNodeId: null
        }).role
      ).toEqual({
        name: "Revisor",
        responsibilities: "Revisar cada diff",
        constraints: "Nunca faz merge",
        expectedDeliverable: "Lista de regressões",
        completionCriteria: "Todo arquivo alterado revisado"
      });
      // No role on the canvas means no role in the context: never a substituted default.
      expect(
        store.resolve({
          workspaceId: fixture.workspaceId,
          agentNodeId: "qa",
          requesterNodeId: null
        }).role
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly setPermissions: (nodeId: string, permissions: readonly string[]) => void;
  readonly setRole: (nodeId: string, role: Record<string, string>) => void;
  readonly setContextInclusion: (
    nodeId: string,
    inclusion: "required" | "relevant" | "optional" | "never"
  ) => void;
  readonly connectArtifact: () => void;
  readonly connectTextSource: () => void;
  readonly connectLegacyDependencyNote: () => void;
  readonly connectNoteCycle: () => void;
  readonly connectNonContextKinds: () => void;
  readonly connectImageSource: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-workspace-context-"));
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
         VALUES (?, 'Principal', 'Ship a reviewed change', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(canvasId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
      )
      .run(workspaceId, projectId, canvasId, now, now);
    insertAgent(sqlite, canvasId, "reviewer", "Reviewer");
    insertAgent(sqlite, canvasId, "qa", "QA");
    insertNote(sqlite, canvasId, "note-direct", "Decisões", "Use SQLite local.");
    insertNote(sqlite, canvasId, "note-transitive", "Origem", "Chega pela cadeia de notas.");
    insertNote(sqlite, canvasId, "note-qa", "QA", "Não deve chegar ao reviewer.");
    insertEdge(sqlite, canvasId, "edge-direct", "note-direct", "reviewer", "Contexto de revisão");
    insertEdge(
      sqlite,
      canvasId,
      "edge-transitive",
      "note-transitive",
      "note-direct",
      "Rascunho",
      "dependency"
    );
    insertEdge(sqlite, canvasId, "edge-qa", "note-qa", "qa", "Contexto de QA");
  } finally {
    sqlite.close();
  }

  return {
    filename,
    workspaceId,
    setPermissions: (nodeId, permissions) => {
      const database = new Database(filename);
      try {
        const row = database
          .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
          .get(canvasId, nodeId) as { readonly data_json: string } | undefined;
        if (row === undefined) throw new Error("Fixture agent was not found");
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        database
          .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
          .run(JSON.stringify({ ...data, permissions }), canvasId, nodeId);
      } finally {
        database.close();
      }
    },
    setRole: (nodeId, role) => {
      const database = new Database(filename);
      try {
        const row = database
          .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
          .get(canvasId, nodeId) as { readonly data_json: string } | undefined;
        if (row === undefined) throw new Error("Fixture agent was not found");
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        database
          .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
          .run(JSON.stringify({ ...data, role }), canvasId, nodeId);
      } finally {
        database.close();
      }
    },
    setContextInclusion: (nodeId, inclusion) => {
      const database = new Database(filename);
      try {
        const row = database
          .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
          .get(canvasId, nodeId) as { readonly data_json: string } | undefined;
        if (row === undefined) throw new Error("Fixture context source was not found");
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        database
          .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
          .run(JSON.stringify({ ...data, contextInclusion: inclusion }), canvasId, nodeId);
      } finally {
        database.close();
      }
    },
    connectArtifact: () => {
      const database = new Database(filename);
      try {
        database
          .prepare(
            `INSERT INTO workspace_artifacts
             (id, workspace_id, project_id, kind, source_relative_path, relative_path, filename,
              sha256, byte_size, media_type, published_by_node_id, idempotency_key, created_at)
             VALUES (?, ?, ?, 'review', 'reports/review.json', ?, 'review.json', ?, 18,
                     'application/json', NULL, 'artifact-report-1', ?)`
          )
          .run(
            "00000000-0000-4000-8000-000000000010",
            workspaceId,
            projectId,
            ".forgedeck/artifacts/report/review.json",
            "a".repeat(64),
            now + 1
          );
        database
          .prepare(
            `INSERT INTO canvas_nodes
             (canvas_id, id, type, position_x, position_y, width, height, data_json)
             VALUES (?, 'artifact-report', 'artifact', 100, 100, 360, 180, ?)`
          )
          .run(
            canvasId,
            JSON.stringify({
              title: "review.json",
              state: "idle",
              summary: "Published review",
              artifact: {
                artifactId: "00000000-0000-4000-8000-000000000010",
                kind: "review",
                relativePath: ".forgedeck/artifacts/report/review.json",
                filename: "review.json",
                sha256: "a".repeat(64),
                byteSize: 18,
                mediaType: "application/json"
              },
              retryMaxAttempts: 1,
              permissions: []
            })
          );
        insertEdge(database, canvasId, "edge-artifact", "artifact-report", "reviewer", "Artifact");
      } finally {
        database.close();
      }
    },
    connectTextSource: () => {
      const database = new Database(filename);
      try {
        insertContextSource(database, canvasId, "text-direct", "text", "Approved contract", {
          kind: "text",
          content: "Use the approved interface contract."
        });
        insertEdge(
          database,
          canvasId,
          "edge-text-direct",
          "text-direct",
          "reviewer",
          "Text context"
        );
      } finally {
        database.close();
      }
    },
    connectNoteCycle: () => {
      const database = new Database(filename);
      try {
        database
          .prepare(
            `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
             VALUES (?, 'edge-cycle', 'note-direct', 'note-transitive', ?)`
          )
          .run(
            canvasId,
            JSON.stringify({
              schemaVersion: "1.0",
              kind: "context",
              label: "ciclo",
              requiredEvidenceTypes: []
            })
          );
      } finally {
        database.close();
      }
    },
    connectLegacyDependencyNote: () => {
      const database = new Database(filename);
      try {
        insertNote(database, canvasId, "note-legacy", "Legado", "Conteúdo legado.");
        insertEdge(
          database,
          canvasId,
          "edge-legacy",
          "note-legacy",
          "reviewer",
          "depends on",
          "dependency"
        );
      } finally {
        database.close();
      }
    },
    connectNonContextKinds: () => {
      const database = new Database(filename);
      try {
        insertNote(database, canvasId, "note-handoff", "Handoff", "Não deve chegar via handoff.");
        insertEdge(
          database,
          canvasId,
          "edge-handoff",
          "note-handoff",
          "reviewer",
          "handoff",
          "handoff"
        );
        insertNote(database, canvasId, "note-approval", "Approval", "Não deve chegar via gate.");
        insertEdge(
          database,
          canvasId,
          "edge-approval",
          "note-approval",
          "reviewer",
          "approval",
          "approval"
        );
      } finally {
        database.close();
      }
    },
    connectImageSource: () => {
      const database = new Database(filename);
      try {
        insertContextSource(database, canvasId, "image-direct", "image", "Foto do produto", {
          kind: "image",
          filename: "photo.png",
          mediaType: "image/png",
          previewDataUri: "data:image/png;base64,AAAA"
        });
        insertEdge(database, canvasId, "edge-image-direct", "image-direct", "reviewer", "Image");
      } finally {
        database.close();
      }
    }
  };
}

function insertAgent(sqlite: Database.Database, canvasId: string, id: string, title: string): void {
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
        retryMaxAttempts: 1,
        permissions: []
      })
    );
}

function insertNote(
  sqlite: Database.Database,
  canvasId: string,
  id: string,
  title: string,
  content: string
): void {
  sqlite
    .prepare(
      `INSERT INTO canvas_nodes (canvas_id, id, type, position_x, position_y, width, height, data_json)
       VALUES (?, ?, 'note', 0, 0, 360, 220, ?)`
    )
    .run(
      canvasId,
      id,
      JSON.stringify({
        title,
        state: "idle",
        summary: "",
        content,
        retryMaxAttempts: 1,
        permissions: []
      })
    );
}

function insertContextSource(
  sqlite: Database.Database,
  canvasId: string,
  id: string,
  type: "text" | "link" | "file" | "folder" | "image" | "drawing" | "page",
  title: string,
  contextSource: Record<string, unknown>
): void {
  sqlite
    .prepare(
      `INSERT INTO canvas_nodes (canvas_id, id, type, position_x, position_y, width, height, data_json)
       VALUES (?, ?, ?, 0, 0, 360, 220, ?)`
    )
    .run(
      canvasId,
      id,
      type,
      JSON.stringify({
        title,
        state: "idle",
        summary: "",
        contextSource,
        retryMaxAttempts: 1,
        permissions: []
      })
    );
}

function insertEdge(
  sqlite: Database.Database,
  canvasId: string,
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  label: string,
  kind = "context"
): void {
  sqlite
    .prepare(
      `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      canvasId,
      id,
      sourceNodeId,
      targetNodeId,
      JSON.stringify({
        schemaVersion: "1.0",
        kind,
        label,
        requiredEvidenceTypes: []
      })
    );
}
