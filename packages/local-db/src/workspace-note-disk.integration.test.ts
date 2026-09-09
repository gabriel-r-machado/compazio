import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceNoteStore } from "./workspace-note-store";
import { noteFilePath } from "./workspace-note-files";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("notes as real files", () => {
  it("writes a markdown file an agent can open, and keeps reading it as the truth", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename, { notesOnDisk: true });
    try {
      const note = store.create({
        workspaceId: fixture.workspaceId,
        title: "Briefing",
        content: "# Briefing\n\nEntregar o login.",
        createdByNodeId: null,
        idempotencyKey: "note-1"
      });

      const path = noteFilePath(fixture.projectRoot, note.id, note.title);
      expect(await readFile(path, "utf8")).toBe("# Briefing\n\nEntregar o login.");

      // The whole point: an agent edits the file with its own tools, and the product reads that.
      await writeFile(path, "# Briefing\n\nEntregar o login com 2FA.", "utf8");
      expect(store.readContent(note)).toBe("# Briefing\n\nEntregar o login com 2FA.");
    } finally {
      store.close();
    }
  });

  it("absorbs an outside edit before appending, instead of silently dropping it", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename, { notesOnDisk: true });
    try {
      const note = store.create({
        workspaceId: fixture.workspaceId,
        title: "Diário",
        content: "primeira entrada",
        createdByNodeId: null,
        idempotencyKey: "note-2"
      });
      const path = noteFilePath(fixture.projectRoot, note.id, note.title);
      await writeFile(path, "primeira entrada\nentrada escrita por fora", "utf8");

      const appended = store.append({
        workspaceId: fixture.workspaceId,
        noteId: note.id,
        content: "terceira entrada",
        appendedByNodeId: null,
        idempotencyKey: "append-1"
      });

      expect(appended.content).toBe("primeira entrada\nentrada escrita por fora\nterceira entrada");
      expect(await readFile(path, "utf8")).toBe(appended.content);
    } finally {
      store.close();
    }
  });

  it("replaces the whole document on write, and the file matches", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename, { notesOnDisk: true });
    try {
      const note = store.create({
        workspaceId: fixture.workspaceId,
        title: "Especificação",
        content: "rascunho",
        createdByNodeId: null,
        idempotencyKey: "note-3"
      });

      const written = store.write({
        workspaceId: fixture.workspaceId,
        noteId: note.id,
        content: "versão final",
        writtenByNodeId: null,
        idempotencyKey: "write-1"
      });

      expect(written.content).toBe("versão final");
      expect(await readFile(noteFilePath(fixture.projectRoot, note.id, note.title), "utf8")).toBe(
        "versão final"
      );
      expect(store.listEvents(note.id).map((event) => event.type)).toEqual([
        "note_created",
        "note_written"
      ]);
    } finally {
      store.close();
    }
  });

  it("projects an outside edit onto the stored mirror and the canvas node", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename, { notesOnDisk: true });
    try {
      const note = store.create({
        workspaceId: fixture.workspaceId,
        title: "Briefing",
        content: "original",
        createdByNodeId: null,
        idempotencyKey: "note-4"
      });
      await writeFile(
        noteFilePath(fixture.projectRoot, note.id, note.title),
        "reescrito por fora",
        "utf8"
      );

      const synced = store.syncFromDisk(note.id);

      expect(synced?.content).toBe("reescrito por fora");
      expect(synced?.revision).toBe(note.revision + 1);
      expect(canvasNodeContent(fixture.filename, note.nodeId)).toBe("reescrito por fora");
      // Nothing changed on disk since, so a second sync has nothing to report.
      expect(store.syncFromDisk(note.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps working as a plain SQLite note when the project keeps no files", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceNoteStore(fixture.filename);
    try {
      const note = store.create({
        workspaceId: fixture.workspaceId,
        title: "Briefing",
        content: "conteúdo",
        createdByNodeId: null,
        idempotencyKey: "note-5"
      });

      expect(store.readContent(note)).toBe("conteúdo");
      expect(store.syncFromDisk(note.id)).toBeNull();
    } finally {
      store.close();
    }
  });
});

function canvasNodeContent(filename: string, nodeId: string): string | undefined {
  const sqlite = new Database(filename, { readonly: true });
  try {
    const row = sqlite
      .prepare("SELECT data_json FROM canvas_nodes WHERE canvas_id = 'canvas-1' AND id = ?")
      .get(nodeId) as { readonly data_json: string } | undefined;
    if (row === undefined) return undefined;
    return (JSON.parse(row.data_json) as { readonly content?: string }).content;
  } finally {
    sqlite.close();
  }
}

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly projectRoot: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compazio-note-disk-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  const projectRoot = join(directory, "project");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Compazio', ?, ?, 'main', 'abc123', ?, ?)`
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
  } finally {
    sqlite.close();
  }
  return { filename, workspaceId, projectRoot };
}
