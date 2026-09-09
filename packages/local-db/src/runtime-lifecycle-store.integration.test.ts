import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteRuntimeLifecycleStore } from "./runtime-lifecycle-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteRuntimeLifecycleStore", () => {
  it("queues and audits explicit control commands without exposing process details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-runtime-lifecycle-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "runtime.db");
    runLocalMigrations({ filename });
    const store = new SqliteRuntimeLifecycleStore(
      filename,
      () => new Date("2026-07-20T12:00:00.000Z")
    );
    try {
      expect(store.getStatus()).toMatchObject({ state: "stopped", revision: 0 });
      const command = store.request("pause");
      expect(store.claimNext()).toEqual(command);
      expect(store.recoverInterrupted()).toBe(1);
      expect(store.claimNext()).toBeNull();
      const next = store.request("pause");
      expect(store.claimNext()).toEqual(next);
      expect(store.markApplied(next, "paused")).toMatchObject({
        state: "paused",
        revision: 1,
        updatedBy: "compasso-cli"
      });
      expect(store.getStatus()).toMatchObject({ state: "paused", revision: 1 });
      expect(store.claimNext()).toBeNull();
    } finally {
      store.close();
    }
  });
});
