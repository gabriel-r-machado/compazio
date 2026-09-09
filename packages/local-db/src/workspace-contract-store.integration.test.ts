import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceContractStore } from "./workspace-contract-store";
import { SqliteWorkspaceArtifactFeedbackStore } from "./workspace-artifact-feedback-store";
import { SqliteWorkspaceImpactStore } from "./workspace-impact-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceContractStore", () => {
  it("versions artifact metadata without changing its immutable hash", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceContractStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const first = store.getArtifactMemory(fixture.workspaceId, fixture.artifactId);
      expect(first).toMatchObject({
        version: 1,
        origin: "reports/test.json",
        sha256: "a".repeat(64),
        relevance: "relevant",
        status: "active"
      });
      const second = store.setArtifactMemory({
        workspaceId: fixture.workspaceId,
        artifactId: fixture.artifactId,
        relationships: [{ artifactId: fixture.relatedArtifactId, kind: "supports" }],
        relevance: "required",
        status: "active"
      });
      expect(second).toMatchObject({
        version: 2,
        sha256: "a".repeat(64),
        relationships: [{ artifactId: fixture.relatedArtifactId, kind: "supports" }]
      });
      expect(
        store
          .listArtifactMemories(fixture.workspaceId, fixture.artifactId)
          .map((memory) => memory.version)
      ).toEqual([2, 1]);
      expect(
        store.compareArtifactMemories({
          workspaceId: fixture.workspaceId,
          artifactId: fixture.artifactId,
          baseVersion: 1,
          targetVersion: 2
        })
      ).toMatchObject({
        addedRelationships: [{ artifactId: fixture.relatedArtifactId, kind: "supports" }],
        removedRelationships: [],
        relevance: { from: "relevant", to: "required" },
        status: null
      });
      expect(() =>
        store.compareArtifactMemories({
          workspaceId: fixture.workspaceId,
          artifactId: fixture.artifactId,
          baseVersion: 2,
          targetVersion: 2
        })
      ).toThrow("versions must differ");
      const restored = store.restoreArtifactMemory({
        workspaceId: fixture.workspaceId,
        artifactId: fixture.artifactId,
        sourceVersion: 1
      });
      expect(restored).toMatchObject({
        version: 3,
        relationships: [],
        relevance: "relevant",
        status: "active",
        restoredFromVersion: 1
      });
      expect(
        store.restoreArtifactMemory({
          workspaceId: fixture.workspaceId,
          artifactId: fixture.artifactId,
          sourceVersion: 1
        })
      ).toEqual(restored);
      expect(() =>
        store.setArtifactMemory({
          workspaceId: fixture.workspaceId,
          artifactId: fixture.artifactId,
          relationships: [{ artifactId: fixture.artifactId, kind: "supports" }],
          relevance: "required",
          status: "active"
        })
      ).toThrow("cannot reference itself");
    } finally {
      store.close();
    }
  });

  it("keeps declared and manually verified delivery evidence in separate contract versions", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceContractStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const created = store.createDeliveryContract({
        workspaceId: fixture.workspaceId,
        sourceNodeId: "author",
        targetNodeId: "reviewer",
        inputs: ["Implementation"],
        outputs: ["Review report"],
        completionCriteria: ["Tests pass"],
        declaredEvidence: [{ kind: "test", reference: "pnpm test" }],
        limits: { maxAttempts: 1, maxContextBytes: 64 * 1024 }
      });
      expect(created).toMatchObject({ version: 1, state: "draft", verifiedEvidence: [] });

      const verified = store.verifyDeliveryContract({
        workspaceId: fixture.workspaceId,
        contractId: created.id,
        verifiedEvidence: [{ kind: "artifact", reference: fixture.artifactId }]
      });
      expect(verified).toMatchObject({
        id: created.id,
        version: 2,
        state: "verified",
        verifiedEvidence: [{ kind: "artifact", reference: fixture.artifactId }]
      });
      expect(verified.revisionId).not.toBe(created.revisionId);
      expect(store.getDeliveryContract(fixture.workspaceId, created.id)).toEqual(verified);
      expect(store.listDeliveryContracts(fixture.workspaceId)).toEqual([verified]);
      expect(() =>
        store.verifyDeliveryContract({
          workspaceId: fixture.workspaceId,
          contractId: created.id,
          verifiedEvidence: [{ kind: "test", reference: "pnpm test" }]
        })
      ).toThrow("no longer eligible");
    } finally {
      store.close();
    }
  });

  it("links local feedback to an existing immutable artifact-memory revision", async () => {
    const fixture = await createFixture();
    const contracts = new SqliteWorkspaceContractStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    const feedback = new SqliteWorkspaceArtifactFeedbackStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const memory = contracts.getArtifactMemory(fixture.workspaceId, fixture.artifactId);
      const created = feedback.create({
        workspaceId: fixture.workspaceId,
        artifactId: fixture.artifactId,
        artifactVersion: memory.version,
        content: "Add a regression test"
      });
      expect(created).toMatchObject({
        artifactVersion: 1,
        content: "Add a regression test",
        createdBy: "local-user"
      });
      expect(feedback.list(fixture.workspaceId, fixture.artifactId, 1)).toEqual([created]);
      expect(() =>
        feedback.create({
          workspaceId: fixture.workspaceId,
          artifactId: fixture.artifactId,
          artifactVersion: 2,
          content: "This revision does not exist"
        })
      ).toThrow("version was not found");
    } finally {
      feedback.close();
      contracts.close();
    }
  });

  it("builds a path-free impact graph from current artifact-memory revisions", async () => {
    const fixture = await createFixture();
    const contracts = new SqliteWorkspaceContractStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    const impacts = new SqliteWorkspaceImpactStore(fixture.filename);
    try {
      contracts.getArtifactMemory(fixture.workspaceId, fixture.artifactId);
      contracts.getArtifactMemory(fixture.workspaceId, fixture.relatedArtifactId);
      contracts.setArtifactMemory({
        workspaceId: fixture.workspaceId,
        artifactId: fixture.relatedArtifactId,
        relationships: [{ artifactId: fixture.artifactId, kind: "derived_from" }],
        relevance: "required",
        status: "active"
      });

      const impact = impacts.getArtifactImpact(fixture.workspaceId, fixture.artifactId);
      expect(impact.rootArtifactId).toBe(fixture.artifactId);
      expect(impact.nodes).toHaveLength(2);
      expect(impact.edges).toEqual([
        {
          sourceArtifactId: fixture.relatedArtifactId,
          targetArtifactId: fixture.artifactId,
          kind: "derived_from"
        }
      ]);
      expect(impact.affectedArtifactIds).toEqual([fixture.relatedArtifactId]);
      expect(JSON.stringify(impact)).not.toContain("reports/");
      expect(JSON.stringify(impact)).not.toContain(".forgedeck");
    } finally {
      impacts.close();
      contracts.close();
    }
  });

  it("backfills version-one memory for artifacts present before the impact migration", async () => {
    const fixture = await createFixture();
    const sqlite = new Database(fixture.filename);
    try {
      sqlite.exec(
        await readFile(
          new URL("../drizzle/0035_backfill_artifact_memories.sql", import.meta.url),
          "utf8"
        )
      );
    } finally {
      sqlite.close();
    }

    const migrated = new Database(fixture.filename, { readonly: true });
    try {
      expect(
        migrated
          .prepare(
            `SELECT artifact_id, version, relationships_json, relevance, status
             FROM artifact_memories WHERE workspace_id = ? ORDER BY artifact_id`
          )
          .all(fixture.workspaceId)
      ).toEqual([
        {
          artifact_id: fixture.artifactId,
          version: 1,
          relationships_json: "[]",
          relevance: "relevant",
          status: "active"
        },
        {
          artifact_id: fixture.relatedArtifactId,
          version: 1,
          relationships_json: "[]",
          relevance: "relevant",
          status: "active"
        }
      ]);
    } finally {
      migrated.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly relatedArtifactId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-contracts-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const artifactId = "00000000-0000-4000-8000-000000000010";
  const relatedArtifactId = "00000000-0000-4000-8000-000000000011";
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
    for (const nodeId of ["author", "reviewer"]) {
      sqlite
        .prepare(
          `INSERT INTO canvas_nodes
           (canvas_id, id, type, position_x, position_y, width, height, data_json)
           VALUES (?, ?, 'agent', 0, 0, 560, 380, ?)`
        )
        .run(canvasId, nodeId, JSON.stringify(agentData(nodeId)));
    }
    for (const [id, path, hash] of [
      [artifactId, "reports/test.json", "a".repeat(64)],
      [relatedArtifactId, "reports/review.json", "b".repeat(64)]
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO workspace_artifacts
           (id, workspace_id, project_id, kind, source_relative_path, relative_path, filename,
            sha256, byte_size, media_type, published_by_node_id, idempotency_key, created_at)
           VALUES (?, ?, ?, 'report', ?, ?, 'report.json', ?, 1, 'application/json', NULL, ?, ?)`
        )
        .run(
          id,
          workspaceId,
          projectId,
          path,
          `.forgedeck/artifacts/${id}/report.json`,
          hash,
          id,
          timestamp
        );
    }
  } finally {
    sqlite.close();
  }
  return { filename, workspaceId, artifactId, relatedArtifactId };
}

function agentData(name: string): Record<string, unknown> {
  return {
    title: name,
    state: "idle",
    summary: "",
    adapterId: "codex",
    role: {
      name,
      responsibilities: "Deliver evidence",
      constraints: "Stay scoped",
      expectedDeliverable: "Report",
      completionCriteria: "Reviewed"
    },
    retryMaxAttempts: 1,
    permissions: []
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
