import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteCloudSyncStore } from "./cloud-sync-store";

const directories: string[] = [];
const reference = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteCloudSyncStore", () => {
  it("persists an idempotent sanitized outbox without storing a plaintext credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-cloud-sync-"));
    directories.push(directory);
    const filename = join(directory, "cloud-sync.db");
    runLocalMigrations({ filename });
    const store = new SqliteCloudSyncStore(filename);

    try {
      store.configure({
        enabled: true,
        organizationId: "11111111-1111-4111-8111-111111111111",
        deviceName: "Developer workstation"
      });
      const event = {
        eventKey: reference,
        type: "run.completed" as const,
        occurredAt: "2026-07-15T15:00:00.000Z",
        project: { localRef: "b".repeat(64), displayName: "Selected project" },
        run: {
          localRef: "c".repeat(64),
          workflowId: "bug-fix",
          adapterId: "shell",
          status: "completed" as const,
          startedAt: "2026-07-15T14:59:00.000Z",
          completedAt: "2026-07-15T15:00:00.000Z",
          durationMs: 60000,
          summary: "All checks passed."
        },
        payload: { nodeRef: null, nodeStatus: null, retryCount: 0 }
      };

      expect(store.enqueue(event)).toBe(true);
      expect(store.enqueue(event)).toBe(false);
      expect(store.getState()).toMatchObject({ enabled: true, queued: 1, lastErrorCode: null });
      store.setEncryptedCredential("safe-storage-ciphertext-only");
      expect(store.getEncryptedCredential()).toBe("safe-storage-ciphertext-only");
      store.markFailed([event.eventKey], "network failure: timeout");
      expect(store.getState().lastErrorCode).toBe("network_failure__timeout");
      store.markDelivered([event.eventKey], new Date("2026-07-15T15:01:00.000Z"));
      expect(store.getState()).toMatchObject({ queued: 0, lastErrorCode: null });
    } finally {
      store.close();
    }
  });
});
