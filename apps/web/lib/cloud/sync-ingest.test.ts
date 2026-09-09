import { describe, expect, it } from "vitest";

import { cloudSyncBatchSchema } from "@forgedeck/schemas";

import { CloudSyncIngestError, ingestCloudSyncBatch } from "./sync-ingest";
import type { CloudSyncIngestRepository } from "./sync-ingest";

const organizationId = "9fa0ad3b-1adb-4433-8b44-587a80f2296f";
const deviceId = "570c0c9d-e1e8-4131-9d14-8f9b3b159d6f";
const reference = "a".repeat(64);

function createBatch() {
  return cloudSyncBatchSchema.parse({
    organizationId,
    deviceId,
    events: [
      {
        eventKey: "b".repeat(64),
        type: "run.completed",
        occurredAt: "2026-07-16T02:35:00.000Z",
        project: { localRef: reference, displayName: "Safe local project" },
        run: {
          localRef: "c".repeat(64),
          workflowId: "bugfix",
          adapterId: "fake-agent",
          status: "completed",
          startedAt: "2026-07-16T02:34:00.000Z",
          completedAt: "2026-07-16T02:35:00.000Z",
          durationMs: 60_000,
          summary: "Completed successfully"
        },
        payload: { nodeRef: null, nodeStatus: null, retryCount: 0 }
      }
    ]
  });
}

function createRepository(
  overrides: Partial<CloudSyncIngestRepository> = {}
): CloudSyncIngestRepository {
  return {
    hasActiveDevice: async () => true,
    upsertProject: async () => "project-id",
    upsertRun: async () => "run-id",
    insertEvent: async () => undefined,
    ...overrides
  };
}

describe("ingestCloudSyncBatch", () => {
  it("only passes validated summary fields to the repository", async () => {
    const received: string[] = [];
    const result = await ingestCloudSyncBatch(
      createRepository({
        upsertProject: async (input) => {
          received.push(input.displayName);
          return "project-id";
        },
        insertEvent: async (input) => {
          received.push(input.event.run.summary ?? "");
        }
      }),
      createBatch()
    );

    expect(result).toEqual({ accepted: 1 });
    expect(received).toEqual(["Safe local project", "Completed successfully"]);
  });

  it("rejects a device that is not visible through RLS", async () => {
    await expect(
      ingestCloudSyncBatch(createRepository({ hasActiveDevice: async () => false }), createBatch())
    ).rejects.toEqual(new CloudSyncIngestError("device_not_available"));
  });
});
