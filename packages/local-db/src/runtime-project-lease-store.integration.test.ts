import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteRuntimeProjectLeaseStore } from "./runtime-project-lease-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteRuntimeProjectLeaseStore", () => {
  it("allows one owner per project and does not release another runtime's lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-runtime-lease-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "runtime.db");
    runLocalMigrations({ filename });
    seedProject(filename, "project-1");

    const first = new SqliteRuntimeProjectLeaseStore(filename);
    const second = new SqliteRuntimeProjectLeaseStore(filename);
    try {
      expect(
        first.tryAcquire({
          projectId: "project-1",
          ownerId: "runtime-a",
          acquiredAt: "2026-07-20T12:00:00.000Z",
          heartbeatAt: "2026-07-20T12:00:00.000Z"
        })
      ).toBe(true);
      expect(
        second.tryAcquire({
          projectId: "project-1",
          ownerId: "runtime-b",
          acquiredAt: "2026-07-20T12:01:00.000Z",
          heartbeatAt: "2026-07-20T12:01:00.000Z"
        })
      ).toBe(false);
      expect(second.release("project-1", "runtime-b")).toBe(false);
      expect(first.get("project-1")).toMatchObject({ ownerId: "runtime-a" });
      expect(first.heartbeat("runtime-a", "2026-07-20T12:05:00.000Z")).toBe(1);
      expect(first.get("project-1")).toMatchObject({
        heartbeatAt: "2026-07-20T12:05:00.000Z"
      });
      expect(first.releaseAll("runtime-a")).toBe(1);
      expect(second.get("project-1")).toBeNull();
    } finally {
      first.close();
      second.close();
    }
  });

  it("reclaims only leases whose heartbeat is older than the recovery cutoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-runtime-lease-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "runtime.db");
    runLocalMigrations({ filename });
    seedProject(filename, "project-stale");
    seedProject(filename, "project-fresh");
    const store = new SqliteRuntimeProjectLeaseStore(filename);
    try {
      expect(
        store.tryAcquire({
          projectId: "project-stale",
          ownerId: "crashed-runtime",
          acquiredAt: "2026-07-20T11:00:00.000Z",
          heartbeatAt: "2026-07-20T11:00:00.000Z"
        })
      ).toBe(true);
      expect(
        store.tryAcquire({
          projectId: "project-fresh",
          ownerId: "active-runtime",
          acquiredAt: "2026-07-20T11:59:00.000Z",
          heartbeatAt: "2026-07-20T11:59:50.000Z"
        })
      ).toBe(true);

      expect(store.recoverStale("2026-07-20T11:59:30.000Z")).toBe(1);
      expect(store.get("project-stale")).toBeNull();
      expect(store.get("project-fresh")).toMatchObject({ ownerId: "active-runtime" });
    } finally {
      store.close();
    }
  });
});

function seedProject(filename: string, projectId: string): void {
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Runtime project', ?, ?, 'main', 'head', 0, 0)`
      )
      .run(projectId, `C:/runtime-project/${projectId}`, `C:/runtime-project/${projectId}`);
  } finally {
    sqlite.close();
  }
}
