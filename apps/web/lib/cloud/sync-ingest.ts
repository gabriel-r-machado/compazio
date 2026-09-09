import type { CloudSyncBatch, CloudSyncEvent } from "@forgedeck/schemas";

export interface CloudSyncIngestRepository {
  hasActiveDevice(deviceId: string, organizationId: string): Promise<boolean>;
  upsertProject(input: {
    readonly organizationId: string;
    readonly deviceId: string | null;
    readonly localRef: string;
    readonly displayName: string;
  }): Promise<string>;
  upsertRun(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly event: CloudSyncEvent;
  }): Promise<string>;
  insertEvent(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly event: CloudSyncEvent;
  }): Promise<void>;
}

export class CloudSyncIngestError extends Error {
  public constructor(public readonly code: "device_not_available" | "sync_write_failed") {
    super(code);
    this.name = "CloudSyncIngestError";
  }
}

export async function ingestCloudSyncBatch(
  repository: CloudSyncIngestRepository,
  batch: CloudSyncBatch
): Promise<{ readonly accepted: number }> {
  if (
    batch.deviceId !== null &&
    !(await repository.hasActiveDevice(batch.deviceId, batch.organizationId))
  ) {
    throw new CloudSyncIngestError("device_not_available");
  }

  for (const event of batch.events) {
    const projectId = await repository.upsertProject({
      organizationId: batch.organizationId,
      deviceId: batch.deviceId,
      localRef: event.project.localRef,
      displayName: event.project.displayName
    });
    const runId = await repository.upsertRun({
      organizationId: batch.organizationId,
      projectId,
      event
    });
    await repository.insertEvent({
      organizationId: batch.organizationId,
      runId,
      event
    });
  }

  return { accepted: batch.events.length };
}
