import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteAppSettingsRepository } from "./app-settings-repository";
import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceRepository } from "./workspace-repository";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceRepository", () => {
  it("isolates canvases and preserves open state, order and titles", async () => {
    const filename = await createDatabase();
    const ids = ["workspace-a", "workspace-b"];
    const repository = new SqliteWorkspaceRepository(
      filename,
      () => new Date("2026-07-17T12:00:00.000Z"),
      () => ids.shift() ?? "unexpected"
    );

    try {
      const first = repository.create({ projectId: "project-a", title: "API" });
      const second = repository.create({ projectId: "project-b" });

      expect(first.canvasId).toBe("workspace-workspace-a");
      expect(second.canvasId).toBe("workspace-workspace-b");
      expect(first.canvasId).not.toBe(second.canvasId);
      expect(second.title).toBe("Website");
      expect(repository.setOpen(first.id, false).isOpen).toBe(false);
      expect(repository.rename(second.id, "Product site").title).toBe("Product site");
      expect(repository.reorder([second.id, first.id]).map((entry) => entry.id)).toEqual([
        second.id,
        first.id
      ]);
    } finally {
      repository.close();
    }
  });

  it("adopts the legacy default canvas once without deleting it", async () => {
    const filename = await createDatabase(true);
    const repository = new SqliteWorkspaceRepository(
      filename,
      () => new Date("2026-07-17T12:00:00.000Z"),
      () => "legacy-workspace"
    );

    try {
      const first = repository.create({
        projectId: "project-a",
        title: "Recovered",
        legacyCanvasId: "default"
      });
      const repeated = repository.create({
        projectId: "project-a",
        legacyCanvasId: "default"
      });
      expect(first.id).toBe("legacy-workspace");
      expect(repeated.id).toBe(first.id);
      expect(repository.list()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it("rejects missing projects and invalid reorder payloads", async () => {
    const filename = await createDatabase();
    const repository = new SqliteWorkspaceRepository(filename, undefined, () => "workspace-a");

    try {
      expect(() => repository.create({ projectId: "missing" })).toThrow(
        "Workspace project does not exist"
      );
      repository.create({ projectId: "project-a" });
      expect(() => repository.reorder([])).toThrow(
        "Workspace order must contain every workspace exactly once"
      );
    } finally {
      repository.close();
    }
  });
});

describe("SqliteAppSettingsRepository", () => {
  it("defaults to Portuguese and dark appearance, then persists supported settings", async () => {
    const filename = await createDatabase();
    const settings = new SqliteAppSettingsRepository(
      filename,
      () => new Date("2026-07-17T12:00:00.000Z")
    );

    try {
      expect(settings.getLocale()).toBe("pt-BR");
      expect(settings.getTheme()).toBe("dark");
      settings.setLocale("en");
      settings.setTheme("light");
      settings.setActiveWorkspaceId("workspace-a");
      expect(settings.getLocale()).toBe("en");
      expect(settings.getTheme()).toBe("light");
      expect(settings.getActiveWorkspaceId()).toBe("workspace-a");
      settings.setActiveWorkspaceId(null);
      expect(settings.getActiveWorkspaceId()).toBeNull();
    } finally {
      settings.close();
    }
  });
});

async function createDatabase(withLegacyCanvas = false): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forgedeck-workspaces-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "workspaces.db");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  try {
    const insertProject = sqlite.prepare(
      `INSERT INTO projects
        (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', '0123456789abcdef', ?, ?)`
    );
    insertProject.run("project-a", "API", "C:/API", "c:/api", now, now);
    insertProject.run("project-b", "Website", "C:/Website", "c:/website", now, now);
    if (withLegacyCanvas) {
      sqlite
        .prepare(
          `INSERT INTO canvases (id, title, revision, viewport_json, created_at, updated_at)
           VALUES ('default', 'Legacy', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
        )
        .run(now, now);
    }
  } finally {
    sqlite.close();
  }
  return filename;
}
