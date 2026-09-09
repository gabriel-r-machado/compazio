import { z } from "zod";

import { capabilityEntitlementsSchema, cloudSyncEventSchema } from "../cloud";

export const CLOUD_SYNC_STATUS_CHANNEL = "cloud-sync:status" as const;
export const CLOUD_SYNC_CONFIGURE_CHANNEL = "cloud-sync:configure" as const;
export const CLOUD_SYNC_NOW_CHANNEL = "cloud-sync:sync-now" as const;
export const CLOUD_SYNC_DISCONNECT_CHANNEL = "cloud-sync:disconnect" as const;
export const CLOUD_SYNC_QUEUE_RUN_SUMMARY_CHANNEL = "cloud-sync:queue-run-summary" as const;

export const cloudSyncConfigureRequestSchema = z
  .object({
    enabled: z.boolean(),
    organizationId: z.string().uuid().nullable(),
    deviceName: z.string().min(1).max(120),
    accessToken: z.string().min(20).max(8192).nullable()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.enabled && (input.organizationId === null || input.accessToken === null)) {
      context.addIssue({
        code: "custom",
        message: "Enabling cloud sync requires an organization and access token."
      });
    }
  });

export const cloudSyncStatusSchema = z
  .object({
    available: z.boolean(),
    enabled: z.boolean(),
    configured: z.boolean(),
    organizationId: z.string().uuid().nullable(),
    queued: z.number().int().nonnegative(),
    lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
    lastErrorCode: z.string().max(80).nullable(),
    entitlement: capabilityEntitlementsSchema
  })
  .strict();

export const cloudSyncQueueRunSummaryRequestSchema = z
  .object({
    event: cloudSyncEventSchema
  })
  .strict();

export const cloudSyncQueueRunSummaryResponseSchema = z
  .object({
    queued: z.boolean()
  })
  .strict();

export type CloudSyncConfigureRequest = z.infer<typeof cloudSyncConfigureRequestSchema>;
export type CloudSyncStatus = z.infer<typeof cloudSyncStatusSchema>;
export type CloudSyncQueueRunSummaryRequest = z.infer<typeof cloudSyncQueueRunSummaryRequestSchema>;
export type CloudSyncQueueRunSummaryResponse = z.infer<
  typeof cloudSyncQueueRunSummaryResponseSchema
>;
