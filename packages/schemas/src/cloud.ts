import { z } from "zod";

const ansiEscapeCharacter = String.fromCodePoint(27);
const ansiBellCharacter = String.fromCodePoint(7);
const ansiEscapeSequencePattern = new RegExp(
  `${ansiEscapeCharacter}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${ansiBellCharacter}]*(?:${ansiBellCharacter}|${ansiEscapeCharacter}\\\\))`,
  "g"
);
const absolutePathPattern =
  /(?:^|[\s"'`(])(?:[a-z]:[\\/]|\/(?:users|home|etc|var|tmp|mnt|opt|private)\/|\\\\[^\\/\s]+)/im;
const codeOrDiffPattern = /(?:^```|^diff --git |^@@ |^\+\+\+ |^--- )/m;
const opaqueReferenceSchema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 reference.");
const safeTextSchema = z
  .string()
  .max(2000)
  .refine(
    (value) =>
      !(
        absolutePathPattern.test(value) ||
        codeOrDiffPattern.test(value) ||
        value.includes(ansiEscapeCharacter) ||
        /(?:\bBearer\s+|FORGEDECK_(?:TEST_)?SECRET_|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=])/i.test(
          value
        )
      ),
    "Cloud text contains terminal control data or a secret-like value."
  );
const safeProjectDisplayNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (value) => !absolutePathPattern.test(value),
    "Cloud project names must not include absolute paths."
  );

export const cloudRunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled"
]);

export const cloudEventTypeSchema = z.enum([
  "run.started",
  "node.status_changed",
  "run.completed",
  "run.summary_updated"
]);

export const cloudProjectSummarySchema = z
  .object({
    localRef: opaqueReferenceSchema,
    displayName: safeProjectDisplayNameSchema
  })
  .strict();

export const cloudRunSummarySchema = z
  .object({
    localRef: opaqueReferenceSchema,
    workflowId: z.string().min(1).max(120).nullable(),
    adapterId: z.string().min(1).max(120).nullable(),
    status: cloudRunStatusSchema,
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    summary: safeTextSchema.nullable()
  })
  .strict();

export const cloudRunEventPayloadSchema = z
  .object({
    nodeRef: opaqueReferenceSchema.nullable(),
    nodeStatus: cloudRunStatusSchema.nullable(),
    retryCount: z.number().int().nonnegative().nullable()
  })
  .strict();

export const cloudSyncEventSchema = z
  .object({
    eventKey: opaqueReferenceSchema,
    type: cloudEventTypeSchema,
    occurredAt: z.string().datetime({ offset: true }),
    project: cloudProjectSummarySchema,
    run: cloudRunSummarySchema,
    payload: cloudRunEventPayloadSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.type === "node.status_changed" && event.payload.nodeRef === null) {
      context.addIssue({
        code: "custom",
        message: "node.status_changed requires an opaque node reference.",
        path: ["payload", "nodeRef"]
      });
    }

    if (event.type === "run.completed" && event.run.completedAt === null) {
      context.addIssue({
        code: "custom",
        message: "run.completed requires completedAt.",
        path: ["run", "completedAt"]
      });
    }
  });

export const cloudSyncBatchSchema = z
  .object({
    organizationId: z.string().uuid(),
    deviceId: z.string().uuid().nullable(),
    events: z.array(cloudSyncEventSchema).min(1).max(50)
  })
  .strict();

export const entitlementSourceSchema = z.enum(["community", "subscription", "grace"]);
export const subscriptionStatusSchema = z.enum([
  "inactive",
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired"
]);

const capabilityEntitlementsObjectSchema = z
  .object({
    cloudSync: z.boolean(),
    mobileMonitor: z.boolean(),
    privateTemplates: z.boolean(),
    teamMembers: z.number().int().positive(),
    cloudHistoryDays: z.number().int().nonnegative(),
    source: entitlementSourceSchema
  })
  .strict();

export const capabilityEntitlementsSchema = capabilityEntitlementsObjectSchema.readonly();

export const entitlementSnapshotSchema = capabilityEntitlementsObjectSchema
  .extend({
    organizationId: z.string().uuid(),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .readonly();

export const cloudSyncDeliveryResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    entitlement: entitlementSnapshotSchema
  })
  .strict();

export const organizationCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
  })
  .strict();

export const organizationMembershipChangeSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(["admin", "member", "viewer"])
  })
  .strict();

export const deviceRegistrationSchema = z
  .object({
    organizationId: z.string().uuid().nullable(),
    displayName: z.string().min(1).max(120),
    platform: z.enum(["win32", "darwin", "linux"]),
    appVersion: z.string().min(1).max(80),
    publicKey: z.string().max(2048).nullable()
  })
  .strict();

export const accountDeletionRequestSchema = z
  .object({
    confirmation: z.literal("DELETE")
  })
  .strict();

export const billingPlanSchema = z.enum(["pro", "team"]);

export const billingCheckoutRequestSchema = z
  .object({
    organizationId: z.string().uuid(),
    plan: billingPlanSchema
  })
  .strict();

export const billingCancelRequestSchema = z
  .object({
    organizationId: z.string().uuid()
  })
  .strict();

export type CloudEventType = z.infer<typeof cloudEventTypeSchema>;
export type CloudProjectSummary = z.infer<typeof cloudProjectSummarySchema>;
export type CloudRunSummary = z.infer<typeof cloudRunSummarySchema>;
export type CloudSyncEvent = z.infer<typeof cloudSyncEventSchema>;
export type CloudSyncBatch = z.infer<typeof cloudSyncBatchSchema>;
export type CloudSyncDeliveryResponse = z.infer<typeof cloudSyncDeliveryResponseSchema>;
export type CapabilityEntitlements = z.infer<typeof capabilityEntitlementsSchema>;
export type EntitlementSnapshot = z.infer<typeof entitlementSnapshotSchema>;
export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;
export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;
export type OrganizationCreate = z.infer<typeof organizationCreateSchema>;
export type OrganizationMembershipChange = z.infer<typeof organizationMembershipChangeSchema>;
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export type BillingPlan = z.infer<typeof billingPlanSchema>;
export type BillingCheckoutRequest = z.infer<typeof billingCheckoutRequestSchema>;
export type BillingCancelRequest = z.infer<typeof billingCancelRequestSchema>;

export function sanitizeCloudSummary(value: string): string {
  const redacted = value
    .replace(ansiEscapeSequencePattern, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:ghp|github_pat|sk)[_-][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bFORGEDECK_(?:TEST_)?SECRET_[A-Za-z0-9_-]+\s*=\s*[^\s,;}\r\n]+/g, "[REDACTED]")
    .replace(/\bFORGEDECK_(?:TEST_)?SECRET_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /(\b[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|secret|password)[A-Za-z0-9_]*\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi,
      "$1[REDACTED]"
    );

  return redacted.slice(0, 2000);
}
