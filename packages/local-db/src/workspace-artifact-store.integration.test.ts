import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceArtifactStore } from "./workspace-artifact-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceArtifactStore", () => {
  it("publishes an immutable project-local artifact with metadata and an event", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.projectRoot, "test-report.json"), '{"passed":true}\n', "utf8");
    const store = new SqliteWorkspaceArtifactStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const published = store.publish({
        workspaceId: fixture.workspaceId,
        sourcePath: "test-report.json",
        kind: "test-report",
        publishedByNodeId: null,
        idempotencyKey: "artifact-publish-1"
      });

      expect(published).toMatchObject({
        kind: "test-report",
        sourceRelativePath: "test-report.json",
        filename: "test-report.json",
        byteSize: 16,
        mediaType: "application/json"
      });
      expect(await readProjectFile(fixture.projectRoot, published.relativePath)).toBe(
        '{"passed":true}\n'
      );
      expect(store.resolve(fixture.workspaceId, "test-report.json").id).toBe(published.id);
      const sqlite = new Database(fixture.filename, { readonly: true });
      try {
        expect(
          sqlite
            .prepare(
              `SELECT origin, sha256, relevance, status FROM artifact_memories
               WHERE workspace_id = ? AND artifact_id = ?`
            )
            .get(fixture.workspaceId, published.id)
        ).toEqual({
          origin: "test-report.json",
          sha256: published.sha256,
          relevance: "relevant",
          status: "active"
        });
      } finally {
        sqlite.close();
      }
      expect(store.listEvents(published.id)).toMatchObject([{ type: "artifact_published" }]);
      const event = store.claimNextCanvasEvent();
      expect(event).toMatchObject({
        type: "artifact_published",
        workspaceId: fixture.workspaceId,
        canvasId: fixture.canvasId,
        artifact: { id: published.id },
        node: {
          id: `artifact-${published.id}`,
          type: "artifact",
          data: {
            artifact: {
              artifactId: published.id,
              relativePath: published.relativePath,
              sha256: published.sha256
            }
          }
        },
        canvasRevision: 2
      });
      if (event === null) throw new Error("Expected artifact canvas event");
      store.markCanvasEventPublished(event.id);
      expect(store.claimNextCanvasEvent()).toBeNull();

      await writeFile(join(fixture.projectRoot, "test-report.json"), '{"passed":false}\n', "utf8");
      expect(await readProjectFile(fixture.projectRoot, published.relativePath)).toBe(
        '{"passed":true}\n'
      );
    } finally {
      store.close();
    }
  });

  it("requires publish_artifacts for a structural agent publisher", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.projectRoot, "review.md"), "Ready for review\n", "utf8");
    const store = new SqliteWorkspaceArtifactStore(fixture.filename);
    try {
      expect(() =>
        store.publish({
          workspaceId: fixture.workspaceId,
          sourcePath: "review.md",
          kind: "review",
          publishedByNodeId: "reviewer",
          idempotencyKey: "artifact-denied"
        })
      ).toThrow("publish_artifacts permission");

      grantPublishArtifacts(fixture.filename, fixture.canvasId);
      expect(
        store.publish({
          workspaceId: fixture.workspaceId,
          sourcePath: "review.md",
          kind: "review",
          publishedByNodeId: "reviewer",
          idempotencyKey: "artifact-allowed"
        })
      ).toMatchObject({ publishedByNodeId: "reviewer" });
    } finally {
      store.close();
    }
  });

  it("refuses a source outside the workspace project", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.directory, "outside.txt");
    await writeFile(outside, "private\n", "utf8");
    const store = new SqliteWorkspaceArtifactStore(fixture.filename);
    try {
      expect(() =>
        store.publish({
          workspaceId: fixture.workspaceId,
          sourcePath: outside,
          kind: "file",
          publishedByNodeId: null,
          idempotencyKey: "artifact-outside"
        })
      ).toThrow("inside the project root");
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly directory: string;
  readonly filename: string;
  readonly projectRoot: string;
  readonly workspaceId: string;
  readonly canvasId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-workspace-artifact-"));
  temporaryDirectories.push(directory);
  const projectRoot = join(directory, "project");
  const filename = join(directory, "local.db");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  await mkdir(projectRoot);
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
    sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, 'reviewer', 'agent', 0, 0, 560, 380, ?)`
      )
      .run(
        canvasId,
        JSON.stringify({
          title: "Reviewer",
          state: "idle",
          summary: "",
          adapterId: "codex",
          retryMaxAttempts: 1,
          permissions: []
        })
      );
  } finally {
    sqlite.close();
  }
  return { directory, filename, projectRoot, workspaceId, canvasId };
}

async function readProjectFile(projectRoot: string, relativePath: string): Promise<string> {
  return readFile(join(projectRoot, relativePath), "utf8");
}

function grantPublishArtifacts(filename: string, canvasId: string): void {
  const sqlite = new Database(filename);
  try {
    const row = sqlite
      .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = 'reviewer'")
      .get(canvasId) as { readonly data_json: string };
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = 'reviewer'")
      .run(JSON.stringify({ ...data, permissions: ["publish_artifacts"] }), canvasId);
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
