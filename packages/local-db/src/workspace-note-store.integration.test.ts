import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceNoteStore } from "./workspace-note-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceNoteStore", () => {
  it("creates, appends and publishes a durable note projection", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const created = store.create({
        workspaceId: fixture.workspaceId,
        title: "Decisões",
        content: "Usar SQLite.",
        createdByNodeId: null,
        idempotencyKey: "note-create-1"
      });
      expect(created).toMatchObject({ revision: 1, title: "Decisões" });
      expect(store.resolve(fixture.workspaceId, "Decisões").id).toBe(created.id);

      const appended = store.append({
        workspaceId: fixture.workspaceId,
        noteId: created.id,
        content: "Usar o runtime local.",
        appendedByNodeId: null,
        idempotencyKey: "note-append-1"
      });
      expect(appended).toMatchObject({
        revision: 2,
        content: "Usar SQLite.\nUsar o runtime local."
      });

      const firstEvent = store.claimNextCanvasEvent();
      expect(firstEvent).toMatchObject({
        type: "note_created",
        note: { id: created.id, revision: 2 },
        node: { data: { content: "Usar SQLite.\nUsar o runtime local." } },
        canvasRevision: 3
      });
      if (firstEvent === null) throw new Error("Expected first note event");
      store.markCanvasEventPublished(firstEvent.id);
      const secondEvent = store.claimNextCanvasEvent();
      expect(secondEvent).toMatchObject({ type: "note_appended", note: { revision: 2 } });
      if (secondEvent === null) throw new Error("Expected second note event");
      store.markCanvasEventPublished(secondEvent.id);
      expect(store.claimNextCanvasEvent()).toBeNull();
      expect(store.listEvents(created.id).map((event) => event.type)).toEqual([
        "note_created",
        "note_appended"
      ]);
    } finally {
      store.close();
    }
  });

  it("requires create_notes for a structural agent requester", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename);
    try {
      expect(() =>
        store.create({
          workspaceId: fixture.workspaceId,
          title: "Restringida",
          content: "",
          createdByNodeId: "reviewer",
          idempotencyKey: "note-denied"
        })
      ).toThrow("create_notes permission");

      grantCreateNotes(fixture.filename, fixture.canvasId);
      expect(
        store.create({
          workspaceId: fixture.workspaceId,
          title: "Liberada",
          content: "",
          createdByNodeId: "reviewer",
          idempotencyKey: "note-allowed"
        })
      ).toMatchObject({ createdByNodeId: "reviewer" });
    } finally {
      store.close();
    }
  });

  it("adopts an existing manual canvas note before appending through the CLI store", async () => {
    const fixture = await createFixture();
    insertManualNote(fixture.filename, fixture.canvasId);
    const store = new SqliteWorkspaceNoteStore(fixture.filename);
    try {
      const legacy = store.resolve(fixture.workspaceId, "Contexto");
      expect(legacy).toMatchObject({ content: "Primeira decisão" });
      expect(
        store.append({
          workspaceId: fixture.workspaceId,
          noteId: legacy.id,
          content: "Segunda decisão",
          appendedByNodeId: null,
          idempotencyKey: "legacy-append"
        })
      ).toMatchObject({ content: "Primeira decisão\nSegunda decisão", revision: 2 });
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly canvasId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-workspace-note-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
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
    .run(projectId, directory, directory, now, now);
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
  sqlite.close();
  return { filename, workspaceId, canvasId };
}

function insertManualNote(filename: string, canvasId: string): void {
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, 'manual-note', 'note', 100, 100, 360, 220, ?)`
      )
      .run(
        canvasId,
        JSON.stringify({
          title: "Contexto",
          state: "idle",
          summary: "Primeira decisão",
          content: "Primeira decisão",
          retryMaxAttempts: 1,
          permissions: []
        })
      );
  } finally {
    sqlite.close();
  }
}

function grantCreateNotes(filename: string, canvasId: string): void {
  const sqlite = new Database(filename);
  try {
    const row = sqlite
      .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = ? AND id = 'reviewer'")
      .get(canvasId) as { readonly data_json: string };
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = 'reviewer'")
      .run(JSON.stringify({ ...data, permissions: ["create_notes"] }), canvasId);
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
