import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteExecutionContextStore } from "./execution-context-store";
import { SqliteWorkspaceContractStore } from "./workspace-contract-store";
import { SqliteWorkspaceGovernanceStore } from "./workspace-governance-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteExecutionContextStore", () => {
  it("builds complete packs and preserves the effective context in immutable checkpoints", async () => {
    const fixture = await createFixture();
    const governance = new SqliteWorkspaceGovernanceStore(fixture.filename, { now: clock() });
    const contracts = new SqliteWorkspaceContractStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    const contract = contracts.createDeliveryContract({
      workspaceId: fixture.workspaceId,
      sourceNodeId: "author",
      targetNodeId: "reviewer",
      inputs: ["Implementation"],
      outputs: ["Review report"],
      completionCriteria: ["Tests pass"],
      declaredEvidence: [{ kind: "test", reference: "pnpm test" }],
      limits: { maxAttempts: 1, maxContextBytes: 64 * 1024 }
    });
    governance.setMission({
      workspaceId: fixture.workspaceId,
      objective: "Ship a reviewed change",
      scope: ["review"],
      decisions: ["Use SQLite"],
      constraints: ["Local only"],
      progress: "Ready for review",
      blockers: []
    });
    governance.setWorkspaceMemory({
      workspaceId: fixture.workspaceId,
      stack: ["TypeScript", "SQLite"],
      architecture: "Local-first",
      patterns: ["append-only"],
      commands: ["pnpm test"],
      conventions: ["No paths in IPC"],
      technicalDecisions: ["SQLite persists context"]
    });
    governance.close();
    contracts.close();

    const store = new SqliteExecutionContextStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const built = store.build({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        task: "Review the implementation",
        contractId: contract.id
      });
      expect(built).toMatchObject({
        task: "Review the implementation",
        profile: { nodeId: "reviewer", version: 1 },
        mission: { objective: "Ship a reviewed change", version: 1 },
        memory: { version: 1, stack: ["TypeScript", "SQLite"] },
        connectedContext: {
          sources: expect.arrayContaining([
            expect.objectContaining({ nodeId: "note-review", content: "Keep the review scoped." }),
            expect.objectContaining({ nodeId: "artifact-review" })
          ])
        },
        artifactMemories: [
          expect.objectContaining({
            artifactId: fixture.artifactId,
            sha256: "a".repeat(64),
            relevance: "relevant"
          })
        ],
        contextSelection: expect.objectContaining({
          mode: "full",
          entries: expect.arrayContaining([
            expect.objectContaining({ sourceNodeId: "note-review", included: true }),
            expect.objectContaining({ sourceNodeId: "artifact-review", included: true })
          ]),
          metrics: expect.objectContaining({ actualTokens: null, costStatus: "estimated" })
        }),
        previousHandoff: { id: "handoff-delivered", status: "delivered" },
        deliveryContract: { id: contract.id, version: 1, state: "draft" }
      });

      const checkpoint = store.checkpoint({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        type: "function",
        task: "Review the implementation",
        contractId: contract.id
      });
      expect(checkpoint.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(checkpoint.snapshot.context.memory?.version).toBe(1);
      expect(checkpoint.snapshot.context.contextSelection?.selectionSha256).toMatch(
        /^[a-f0-9]{64}$/
      );
      expect(checkpoint.snapshot.context.deliveryContract?.revisionId).toBe(contract.revisionId);

      const updater = new SqliteWorkspaceGovernanceStore(fixture.filename, { now: clock() });
      updater.setWorkspaceMemory({
        workspaceId: fixture.workspaceId,
        stack: ["Updated stack"],
        architecture: "Changed after checkpoint",
        patterns: [],
        commands: [],
        conventions: [],
        technicalDecisions: []
      });
      updater.close();

      expect(
        store.build({
          workspaceId: fixture.workspaceId,
          agentNodeId: "reviewer",
          task: "Review the implementation",
          contractId: contract.id
        }).memory?.version
      ).toBe(2);
      expect(store.getCheckpoint(fixture.workspaceId, checkpoint.id)).toEqual(checkpoint);
      expect(store.listCheckpoints(fixture.workspaceId, "reviewer")).toEqual([checkpoint]);

      const deliveryCheckpoint = store.checkpoint({
        workspaceId: fixture.workspaceId,
        agentNodeId: "reviewer",
        type: "delivery",
        task: "Verify the delivery",
        contractId: contract.id
      });
      expect(deliveryCheckpoint.type).toBe("delivery");
    } finally {
      store.close();
    }

    const reloaded = new SqliteExecutionContextStore(fixture.filename);
    try {
      expect(reloaded.listCheckpoints(fixture.workspaceId)).toHaveLength(2);
      expect(() =>
        reloaded.build({
          workspaceId: fixture.workspaceId,
          agentNodeId: "author",
          task: "Incorrect contract target",
          contractId: contract.id
        })
      ).toThrow("target must match");
    } finally {
      reloaded.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly artifactId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-execution-context-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const artifactId = "00000000-0000-4000-8000-000000000010";
  const timestamp = Date.parse("2026-07-20T12:00:00.000Z");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, directory, directory, timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES (?, 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(canvasId, timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO workspaces
         (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
      )
      .run(workspaceId, projectId, canvasId, timestamp, timestamp);
    insertAgent(sqlite, canvasId, "author", "Author");
    insertAgent(sqlite, canvasId, "reviewer", "Reviewer");
    insertNote(sqlite, canvasId, "note-review", "Review notes", "Keep the review scoped.");
    sqlite
      .prepare(
        `INSERT INTO workspace_artifacts
         (id, workspace_id, project_id, kind, source_relative_path, relative_path, filename,
          sha256, byte_size, media_type, published_by_node_id, idempotency_key, created_at)
         VALUES (?, ?, ?, 'review', 'reports/review.json', ?, 'review.json', ?, 18,
                 'application/json', NULL, 'artifact-review-1', ?)`
      )
      .run(
        artifactId,
        workspaceId,
        projectId,
        ".forgedeck/artifacts/report/review.json",
        "a".repeat(64),
        timestamp
      );
    sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, 'artifact-review', 'artifact', 0, 0, 360, 180, ?)`
      )
      .run(
        canvasId,
        JSON.stringify({
          title: "review.json",
          state: "idle",
          summary: "Published review",
          artifact: {
            artifactId,
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
    insertContextEdge(sqlite, canvasId, "edge-note-review", "note-review", "reviewer");
    insertContextEdge(sqlite, canvasId, "edge-artifact-review", "artifact-review", "reviewer");
    insertDeliveredHandoff(sqlite, canvasId, projectId, timestamp);
  } finally {
    sqlite.close();
  }
  return { filename, workspaceId, artifactId };
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
        role: role(title),
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
       VALUES (?, ?, 'note', 0, 0, 360, 180, ?)`
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

function insertContextEdge(
  sqlite: Database.Database,
  canvasId: string,
  id: string,
  sourceNodeId: string,
  targetNodeId: string
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
        kind: "context",
        label: "Context",
        requiredEvidenceTypes: []
      })
    );
}

function insertDeliveredHandoff(
  sqlite: Database.Database,
  canvasId: string,
  projectId: string,
  timestamp: number
): void {
  sqlite
    .prepare(
      `INSERT INTO canvas_handoffs
       (id, canvas_id, project_id, status, revision, mission, source_json, target_json, edge_json,
        content_json, error, created_at, updated_at, ready_at, delivered_at)
       VALUES ('handoff-delivered', ?, ?, 'delivered', 1, 'Ship a reviewed change', ?, ?, ?, ?, NULL,
               ?, ?, ?, ?)`
    )
    .run(
      canvasId,
      projectId,
      JSON.stringify({ nodeId: "author", title: "Author", role: role("Author") }),
      JSON.stringify({ nodeId: "reviewer", title: "Reviewer", role: role("Reviewer") }),
      JSON.stringify({
        edgeId: "edge-handoff",
        contract: { schemaVersion: "1.0", kind: "handoff", requiredEvidenceTypes: [] }
      }),
      JSON.stringify({
        summary: "Implementation is ready for review.",
        completedWork: ["Implementation"],
        decisions: [],
        evidence: [],
        openQuestions: [],
        risks: []
      }),
      timestamp,
      timestamp,
      timestamp,
      timestamp
    );
}

function role(name: string): Record<string, string> {
  return {
    name,
    responsibilities: "Deliver evidence",
    constraints: "Stay scoped",
    expectedDeliverable: "Report",
    completionCriteria: "Reviewed"
  };
}

function sequentialIds(): () => string {
  let sequence = 100;
  return () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`;
}

function clock(): () => Date {
  let timestamp = Date.parse("2026-07-20T12:00:00.000Z");
  return () => new Date(timestamp++);
}
