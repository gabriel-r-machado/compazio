import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { artifactMemorySchema, workspaceAgentContextSchema } from "@forgedeck/schemas";

import { runLocalMigrations } from "./migrate";
import { SqliteContextSelectionStore } from "./context-selection-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("SqliteContextSelectionStore", () => {
  it("indexes chunk metadata, selects reproducibly by mode, and invalidates cache on a source hash", async () => {
    const filename = await databaseFile();
    const store = new SqliteContextSelectionStore(filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const context = contextPack();
      const memories = [artifactMemorySchema.parse(artifactMemory())];
      const full = store.select({
        workspaceId: "workspace-1",
        agentNodeId: "agent-1",
        mode: "full",
        context,
        artifactMemories: memories
      });
      expect(full.cacheHit).toBe(false);
      expect(full.snapshot.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceNodeId: "required-note", included: true }),
          expect.objectContaining({ sourceNodeId: "relevant-text", included: true }),
          expect.objectContaining({ sourceNodeId: "optional-page", included: true }),
          expect.objectContaining({
            sourceNodeId: "artifact-source",
            inclusion: "required",
            included: true
          }),
          expect.objectContaining({
            sourceNodeId: "never-drawing",
            included: false,
            reason: "excluded_by_never_policy"
          })
        ])
      );
      expect(full.snapshot.metrics).toMatchObject({
        actualTokens: null,
        costStatus: "estimated",
        actualCostMicros: null
      });

      const repeated = store.select({
        workspaceId: "workspace-1",
        agentNodeId: "agent-1",
        mode: "full",
        context,
        artifactMemories: memories
      });
      expect(repeated.cacheHit).toBe(true);
      expect(repeated.snapshot).toEqual(full.snapshot);

      const intelligent = store.select({
        workspaceId: "workspace-1",
        agentNodeId: "agent-1",
        mode: "intelligent",
        context,
        artifactMemories: memories
      });
      expect(intelligent.snapshot.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceNodeId: "optional-page",
            included: false,
            reason: "excluded_by_intelligent_budget"
          })
        ])
      );

      const economical = store.select({
        workspaceId: "workspace-1",
        agentNodeId: "agent-1",
        mode: "economical",
        context,
        artifactMemories: memories
      });
      expect(economical.snapshot.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceNodeId: "required-note", included: true }),
          expect.objectContaining({ sourceNodeId: "artifact-source", included: true }),
          expect.objectContaining({
            sourceNodeId: "relevant-text",
            included: false,
            reason: "excluded_by_economical_budget"
          }),
          expect.objectContaining({
            sourceNodeId: "optional-page",
            included: false,
            reason: "excluded_by_economical_mode"
          })
        ])
      );

      const changed = workspaceAgentContextSchema.parse({
        ...context,
        sources: context.sources.map((source) =>
          source.nodeId === "required-note"
            ? { ...source, content: "Changed reviewed decision." }
            : source
        )
      });
      const invalidated = store.select({
        workspaceId: "workspace-1",
        agentNodeId: "agent-1",
        mode: "full",
        context: changed,
        artifactMemories: memories
      });
      expect(invalidated.cacheHit).toBe(false);
      expect(invalidated.snapshot.sourceIndexSha256).not.toBe(full.snapshot.sourceIndexSha256);

      const sqlite = new Database(filename, { readonly: true });
      try {
        expect(
          sqlite.prepare("SELECT COUNT(*) AS count FROM context_source_indexes").get()
        ).toMatchObject({ count: 6 });
        expect(
          sqlite.prepare("SELECT COUNT(*) AS count FROM context_index_chunks").get()
        ).toMatchObject({ count: expect.any(Number) });
        expect(
          sqlite.prepare("SELECT COUNT(*) AS count FROM context_selection_caches").get()
        ).toMatchObject({ count: 4 });
      } finally {
        sqlite.close();
      }
    } finally {
      store.close();
    }
  });
});

async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-context-selection-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  try {
    const timestamp = Date.parse("2026-07-21T12:00:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000001', 'Compasso', 'C:/project', 'C:/project', 'main', 'head', ?, ?)`
      )
      .run(timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-1', 'Canvas', '', 0, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES ('workspace-1', '00000000-0000-4000-8000-000000000001', 'canvas-1', 'Workspace', 0, 1, ?, ?)`
      )
      .run(timestamp, timestamp);
  } finally {
    sqlite.close();
  }
  return filename;
}

function contextPack() {
  return workspaceAgentContextSchema.parse({
    workspaceId: "workspace-1",
    agentNodeId: "agent-1",
    mission: "Deliver safely",
    sources: [
      source("required-note", "required", "Keep the implementation local."),
      source("relevant-text", "relevant", "r".repeat(20_000)),
      source("optional-page", "optional", "o".repeat(30_000)),
      source("never-drawing", "never", "Never send this sketch."),
      {
        nodeId: "artifact-source",
        title: "Report",
        kind: "artifact",
        inclusion: "optional",
        artifact: {
          id: "00000000-0000-4000-8000-000000000010",
          kind: "report",
          relativePath: ".forgedeck/artifacts/report.json",
          filename: "report.json",
          sha256: "a".repeat(64),
          byteSize: 1_024,
          mediaType: "application/json"
        },
        edgeId: "edge-artifact",
        contract: contract()
      }
    ]
  });
}

function source(
  nodeId: string,
  inclusion: "required" | "relevant" | "optional" | "never",
  content: string
) {
  return {
    nodeId,
    title: nodeId,
    kind: "note",
    content,
    inclusion,
    edgeId: `edge-${nodeId}`,
    contract: contract()
  };
}

function contract() {
  return { schemaVersion: "1.0", kind: "context", label: "", requiredEvidenceTypes: [] };
}

function artifactMemory() {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    workspaceId: "workspace-1",
    artifactId: "00000000-0000-4000-8000-000000000010",
    version: 1,
    origin: "published",
    sha256: "a".repeat(64),
    relationships: [],
    relevance: "required",
    status: "active",
    restoredFromVersion: null,
    createdBy: "local-user",
    createdAt: "2026-07-21T12:00:00.000Z"
  };
}

function sequentialIds() {
  let next = 1;
  return () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`;
}

function clock() {
  let time = Date.parse("2026-07-21T12:00:00.000Z");
  return () => new Date(time++);
}
