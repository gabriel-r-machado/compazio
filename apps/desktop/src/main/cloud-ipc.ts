import type { IpcMain } from "electron";

import {
  CLOUD_SYNC_CONFIGURE_CHANNEL,
  CLOUD_SYNC_DISCONNECT_CHANNEL,
  CLOUD_SYNC_NOW_CHANNEL,
  CLOUD_SYNC_QUEUE_RUN_SUMMARY_CHANNEL,
  CLOUD_SYNC_STATUS_CHANNEL,
  cloudSyncConfigureRequestSchema,
  cloudSyncQueueRunSummaryRequestSchema,
  cloudSyncQueueRunSummaryResponseSchema,
  cloudSyncStatusSchema
} from "@forgedeck/schemas";

import type { CloudSyncService } from "./cloud-sync";

export function registerCloudSyncIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  service: CloudSyncService
): void {
  ipc.removeHandler(CLOUD_SYNC_STATUS_CHANNEL);
  ipc.handle(CLOUD_SYNC_STATUS_CHANNEL, () => cloudSyncStatusSchema.parse(service.status()));

  ipc.removeHandler(CLOUD_SYNC_CONFIGURE_CHANNEL);
  ipc.handle(CLOUD_SYNC_CONFIGURE_CHANNEL, (_event, payload: unknown) =>
    cloudSyncStatusSchema.parse(service.configure(cloudSyncConfigureRequestSchema.parse(payload)))
  );

  ipc.removeHandler(CLOUD_SYNC_QUEUE_RUN_SUMMARY_CHANNEL);
  ipc.handle(CLOUD_SYNC_QUEUE_RUN_SUMMARY_CHANNEL, (_event, payload: unknown) => {
    const request = cloudSyncQueueRunSummaryRequestSchema.parse(payload);
    return cloudSyncQueueRunSummaryResponseSchema.parse({
      queued: service.queueRunSummary(request.event)
    });
  });

  ipc.removeHandler(CLOUD_SYNC_NOW_CHANNEL);
  ipc.handle(CLOUD_SYNC_NOW_CHANNEL, async () =>
    cloudSyncStatusSchema.parse(await service.syncNow())
  );

  ipc.removeHandler(CLOUD_SYNC_DISCONNECT_CHANNEL);
  ipc.handle(CLOUD_SYNC_DISCONNECT_CHANNEL, () =>
    cloudSyncStatusSchema.parse(service.disconnect())
  );
}
