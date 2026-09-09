import { z } from "zod";

import {
  permissionMapSchema,
  workflowSchema,
  workflowTemplateImportPreviewSchema
} from "@forgedeck/workflow";
import { compassoPackagePreviewSchema, compassoPackageSchema } from "../compasso-package";
import { contextSelectionModeSchema } from "../context-selection";

export const WORKFLOW_LIST_TEMPLATES_CHANNEL = "workflows:list-templates" as const;
export const WORKFLOW_DRY_RUN_CHANNEL = "workflows:dry-run" as const;
export const WORKFLOW_TEMPLATE_PREVIEW_IMPORT_CHANNEL =
  "workflows:template-preview-import" as const;
export const WORKFLOW_PACKAGE_EXPORT_CHANNEL = "workflows:package-export" as const;
export const WORKFLOW_PACKAGE_PREVIEW_IMPORT_CHANNEL = "workflows:package-preview-import" as const;
export const WORKFLOW_RUN_START_CHANNEL = "workflows:run-start" as const;
export const WORKFLOW_RUN_LIST_CHANNEL = "workflows:run-list" as const;
export const WORKFLOW_RUN_SHOW_CHANNEL = "workflows:run-show" as const;
export const WORKFLOW_RUN_GRAPH_CHANNEL = "workflows:run-graph" as const;
export const WORKFLOW_RUN_EVENTS_CHANNEL = "workflows:run-events" as const;
export const WORKFLOW_RUN_EVENT_CHANNEL = "workflows:run-event" as const;
export const WORKFLOW_RUN_PAUSE_CHANNEL = "workflows:run-pause" as const;
export const WORKFLOW_RUN_RESUME_CHANNEL = "workflows:run-resume" as const;
export const WORKFLOW_RUN_CANCEL_CHANNEL = "workflows:run-cancel" as const;
export const WORKFLOW_RUN_RETRY_CHANNEL = "workflows:run-retry" as const;
export const WORKFLOW_RUN_APPROVE_CHANNEL = "workflows:run-approve" as const;
export const WORKFLOW_RUN_REJECT_CHANNEL = "workflows:run-reject" as const;

export const workflowTemplateSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    nodeCount: z.number().int().positive(),
    requiresGitWorktree: z.boolean()
  })
  .strict();

export const workflowDryRunRequestSchema = z
  .object({
    workflow: workflowSchema,
    grantedPermissions: permissionMapSchema
  })
  .strict();

export const workflowDryRunResponseSchema = z
  .object({
    workflowId: z.string(),
    valid: z.boolean(),
    concurrency: z.number().int().positive(),
    order: z.array(z.string()),
    waves: z.array(z.array(z.string())),
    requestedPermissions: z.array(z.string()),
    issues: z.array(z.string())
  })
  .strict();

/** The payload is untrusted and intentionally parsed/sanitized only by the main process. */
export const workflowTemplateImportRequestSchema = z.object({ document: z.unknown() }).strict();
export { workflowTemplateImportPreviewSchema };

/** Raw package data is never trusted; the main process sanitizes it before returning a preview. */
export const compassoPackageRequestSchema = z.object({ package: z.unknown() }).strict();
export { compassoPackagePreviewSchema, compassoPackageSchema };

const workflowRunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(160);

const workflowExecutionCheckpointReferenceSchema = z
  .object({
    checkpointId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

/** Safe summary only; the complete effective context remains in the local immutable snapshot. */
export const workflowRunExecutionContextSchema = z
  .object({
    workspaceId: workflowRunIdSchema,
    agentNodeId: workflowRunIdSchema,
    task: z.string().trim().min(1).max(20_000),
    contractId: z.string().uuid().nullable(),
    profileVersion: z.number().int().positive(),
    missionVersion: z.number().int().positive().nullable(),
    memoryVersion: z.number().int().positive().nullable(),
    contractVersion: z.number().int().positive().nullable(),
    contextMode: contextSelectionModeSchema.optional(),
    contextSelectionSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    estimatedContextTokens: z.number().int().nonnegative().optional(),
    actualContextTokens: z.number().int().nonnegative().nullable().optional(),
    contextCostStatus: z.enum(["estimated", "reported"]).optional(),
    functionCheckpoint: workflowExecutionCheckpointReferenceSchema,
    deliveryCheckpoint: workflowExecutionCheckpointReferenceSchema.nullable()
  })
  .strict();

export const workflowRunStartRequestSchema = z
  .object({
    templateId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(160),
    workspaceId: workflowRunIdSchema,
    agentNodeId: workflowRunIdSchema,
    task: z.string().trim().min(1).max(20_000),
    contractId: z.string().uuid().optional(),
    contextMode: contextSelectionModeSchema.default("full"),
    dryRun: z.boolean().default(false)
  })
  .strict();

/** Result of a durable desktop request; a run id is assigned only by the local runtime. */
export const workflowRunCommandResponseSchema = z
  .object({
    commandId: z.string().uuid(),
    action: z.enum(["start", "pause", "resume", "cancel", "retry", "approve", "reject"]),
    status: z.literal("queued"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const workflowRunControlRequestSchema = z.object({ runId: workflowRunIdSchema }).strict();

export const workflowRunListRequestSchema = z
  .object({
    state: z
      .enum([
        "created",
        "running",
        "paused",
        "waiting",
        "succeeded",
        "failed",
        "cancelled",
        "interrupted"
      ])
      .optional(),
    limit: z.number().int().min(1).max(500).default(50)
  })
  .strict();

export const workflowRunApprovalRequestSchema = z
  .object({
    runId: workflowRunIdSchema,
    nodeId: workflowRunIdSchema,
    note: z.string().max(2_000).default("")
  })
  .strict();

export const workflowNodeRunSnapshotSchema = z
  .object({
    id: workflowRunIdSchema,
    runId: workflowRunIdSchema,
    nodeId: z.string().min(1),
    state: z.enum([
      "pending",
      "ready",
      "starting",
      "running",
      "waiting",
      "blocked",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "skipped"
    ]),
    // Pending nodes have not been claimed by the scheduler yet, so their first
    // attempt is represented as 0. This must round-trip through the renderer
    // contract or one fresh node makes the entire run history unreadable.
    attempt: z.number().int().nonnegative(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(1),
    evidence: z.array(z.unknown()),
    failureReason: z.string().nullable()
  })
  .strict();

/** Immutable retry/alternative provenance projected alongside a run; null for a first-class run. */
export const workflowRunLineageSchema = z
  .object({
    sourceRunId: z.string().min(1),
    nodeId: z.string().min(1).nullable(),
    scope: z.enum(["run", "node", "dependents"]),
    alternativeGroupId: z.string().min(1).nullable(),
    alternativeLabel: z.string().min(1).nullable()
  })
  .strict();

export const workflowRunSnapshotSchema = z
  .object({
    id: workflowRunIdSchema,
    workflowId: z.string().min(1).max(160),
    workflowVersion: z.literal("1.0"),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectivePermissions: permissionMapSchema,
    state: z.enum([
      "created",
      "running",
      "paused",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted"
    ]),
    dryRun: z.boolean(),
    concurrency: z.number().int().positive(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    executionContext: workflowRunExecutionContextSchema.nullable(),
    lineage: workflowRunLineageSchema.nullable().optional(),
    nodeRuns: z.array(workflowNodeRunSnapshotSchema),
    reportArtifact: z.unknown().nullable()
  })
  .strict();

/**
 * A deliberately narrow renderer projection of the immutable workflow definition. Command
 * specifications, resource locks and permissions remain runtime-private.
 */
export const workflowRunGraphNodeSchema = z
  .object({
    id: workflowRunIdSchema,
    type: z.enum([
      "agent",
      "shell",
      "human_approval",
      "quality_gate",
      "artifact",
      "handoff",
      "transform",
      "parallel_group",
      "subworkflow"
    ]),
    title: z.string().max(160).nullable(),
    dependsOn: z.array(workflowRunIdSchema)
  })
  .strict();

export const workflowRunGraphSchema = z
  .object({
    runId: workflowRunIdSchema,
    workflowId: z.string().min(1).max(160),
    nodes: z.array(workflowRunGraphNodeSchema).max(1_000)
  })
  .strict();

export const workflowRunEventSchema = z
  .object({
    id: workflowRunIdSchema,
    runId: workflowRunIdSchema,
    nodeRunId: workflowRunIdSchema.nullable(),
    // Dotted, lowercase event names; underscores are allowed for compound names like
    // `node.retry_scheduled` so the events channel round-trips every runtime event type.
    type: z
      .string()
      .regex(/^[a-z._]+$/)
      .max(80),
    timestamp: z.string().datetime(),
    schemaVersion: z.literal("1.0"),
    sequence: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown())
  })
  .strict();

export type WorkflowTemplateSummary = z.infer<typeof workflowTemplateSummarySchema>;
export type WorkflowDryRunRequest = z.infer<typeof workflowDryRunRequestSchema>;
export type WorkflowDryRunResponse = z.infer<typeof workflowDryRunResponseSchema>;
export type WorkflowTemplateImportRequest = z.infer<typeof workflowTemplateImportRequestSchema>;
export type WorkflowTemplateImportPreview = z.infer<typeof workflowTemplateImportPreviewSchema>;
export type CompassoPackageRequest = z.infer<typeof compassoPackageRequestSchema>;
export type WorkflowRunStartRequest = z.infer<typeof workflowRunStartRequestSchema>;
export type WorkflowRunCommandResponse = z.infer<typeof workflowRunCommandResponseSchema>;
export type WorkflowRunControlRequest = z.infer<typeof workflowRunControlRequestSchema>;
export type WorkflowRunApprovalRequest = z.infer<typeof workflowRunApprovalRequestSchema>;
export type WorkflowRunListRequest = z.input<typeof workflowRunListRequestSchema>;
export type WorkflowRunEvent = z.infer<typeof workflowRunEventSchema>;
export type WorkflowRunExecutionContextDto = z.infer<typeof workflowRunExecutionContextSchema>;
export type WorkflowRunSnapshotDto = z.infer<typeof workflowRunSnapshotSchema>;
export type WorkflowRunGraphDto = z.infer<typeof workflowRunGraphSchema>;
