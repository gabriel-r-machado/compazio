import { z } from "zod";

import {
  agentAdapterIdSchema,
  agentAssignmentPresetSchema,
  agentDescriptorSchema
} from "../agent-capability";
import { creationModeSchema, executionProfileSchema } from "../workflow-mode";
import {
  workflowDraftEventSchema,
  workflowDraftRejectionReasonSchema,
  workflowDraftSchema,
  workflowNodeDraftPatchSchema,
  workflowNodeFieldSchema
} from "../workflow-draft";

/**
 * Structured IPC surface for the Automatic Workflow Composer. There is intentionally no
 * "save the whole draft" channel: the renderer never owns draft state. Each channel is a specific
 * command that the main process validates, applies through the deterministic domain reducer,
 * persists as idempotent events, and answers with a structured result. The renderer only renders the
 * persisted draft it gets back.
 */
export const WORKFLOW_DRAFT_LOAD_CHANNEL = "workflow-draft:load" as const;
export const WORKFLOW_DRAFT_APPLY_ACTION_CHANNEL = "workflow-draft:apply-action" as const;
export const WORKFLOW_DRAFT_ANSWER_QUESTION_CHANNEL = "workflow-draft:answer-question" as const;
export const WORKFLOW_DRAFT_UPDATE_USER_FIELD_CHANNEL = "workflow-draft:update-user-field" as const;
export const WORKFLOW_DRAFT_LOCK_FIELD_CHANNEL = "workflow-draft:lock-field" as const;
export const WORKFLOW_DRAFT_APPROVE_CHANNEL = "workflow-draft:approve" as const;
/** Live agent catalog. Availability is observed on demand and never persisted as a workflow fact. */
export const WORKFLOW_AGENTS_LIST_CHANNEL = "workflow-agents:list" as const;
export const WORKFLOW_DRAFT_ASSIGN_AGENTS_CHANNEL = "workflow-draft:assign-agents" as const;

const identifierSchema = z.string().min(1).max(160);

export const workflowAgentsListResponseSchema = z
  .object({ agents: z.array(agentDescriptorSchema).max(32) })
  .strict();

/**
 * Sets who runs which node. `preset` records how the choice was made; `assignments` is the explicit
 * per-node decision. A preset is evaluated in the MAIN process against the live catalog — the
 * renderer never decides availability — and the user may still override any node afterwards.
 */
export const workflowDraftAssignAgentsRequestSchema = z
  .object({
    draftId: z.string().uuid(),
    preset: agentAssignmentPresetSchema,
    /** Explicit per-node overrides. Omitted when the preset should decide every node. */
    assignments: z
      .array(
        z
          .object({
            nodeId: identifierSchema,
            assignedAdapter: agentAdapterIdSchema.nullable()
          })
          .strict()
      )
      .max(200)
      .default([])
  })
  .strict();

export const workflowDraftLoadRequestSchema = z
  .object({ workspaceId: identifierSchema, draftId: z.string().uuid().optional() })
  .strict();
export const workflowDraftLoadResponseSchema = z
  .object({ draft: workflowDraftSchema.nullable() })
  .strict();

/**
 * Applies one orchestrator composition action captured from the terminal. `action` is intentionally
 * unknown here: the main process validates it against the composition protocol and, if it is
 * malformed, returns a structured `schema_invalid` rejection rather than failing IPC. When `draftId`
 * is absent the command must be `start_workflow_draft`, which mints a new draft for the terminal.
 */
export const workflowDraftApplyActionRequestSchema = z
  .object({
    workspaceId: identifierSchema,
    sourceTerminalId: identifierSchema,
    creationMode: creationModeSchema,
    executionProfile: executionProfileSchema,
    draftId: z.string().uuid().optional(),
    action: z.unknown()
  })
  .strict();

export const workflowDraftAnswerQuestionRequestSchema = z
  .object({
    draftId: z.string().uuid(),
    questionId: identifierSchema,
    answer: z.string().trim().max(4_000)
  })
  .strict();

export const workflowDraftUpdateUserFieldRequestSchema = z
  .object({
    draftId: z.string().uuid(),
    nodeId: identifierSchema,
    patch: workflowNodeDraftPatchSchema
  })
  .strict();

export const workflowDraftLockFieldRequestSchema = z
  .object({
    draftId: z.string().uuid(),
    nodeId: identifierSchema,
    field: workflowNodeFieldSchema.optional(),
    locked: z.boolean()
  })
  .strict();

export const workflowDraftApproveRequestSchema = z.object({ draftId: z.string().uuid() }).strict();

/**
 * Uniform structured result for every command. `applied` reflects the current persisted draft;
 * `rejected` explains why nothing changed (with the machine reason) so the terminal and UI can show
 * it; `needs_input` signals the orchestrator is waiting on the user; `ignored` is for benign no-ops
 * (e.g. an inspect action). `draft` is always the authoritative persisted state after the command.
 */
/** Terminal state of materialising an approved draft into an official run (increment A). */
export const workflowActivationStatusSchema = z.enum([
  "materialized",
  "started",
  "failed",
  "invalid"
]);

export const workflowActivationIssueSchema = z
  .object({
    code: z.string().max(64),
    nodeId: z.string().max(160).nullable(),
    message: z.string().max(2_000)
  })
  .strict();

/**
 * Result of approving+materialising a draft. `runId` is set once exactly one official run has been
 * created by the WorkflowRunRuntime; `invalid` carries the blocking materialisation issues and never
 * creates a run. The renderer uses `runId`/`workspaceId` to reconcile with the existing run overlay —
 * it never builds terminal state locally.
 */
export const workflowActivationResultSchema = z
  .object({
    activationId: z.string().uuid().nullable(),
    workflowId: z.string().max(200).nullable(),
    runId: z.string().max(200).nullable(),
    status: workflowActivationStatusSchema,
    issues: z.array(workflowActivationIssueSchema).max(200).default([])
  })
  .strict();

export const workflowDraftCommandResultSchema = z
  .object({
    status: z.enum(["applied", "rejected", "needs_input", "ignored"]),
    draft: workflowDraftSchema.nullable(),
    event: workflowDraftEventSchema.nullable().default(null),
    rejectionReason: workflowDraftRejectionReasonSchema.nullable().default(null),
    message: z.string().max(2_000).default(""),
    /** Present only on an approve that attempted materialisation. */
    activation: workflowActivationResultSchema.nullable().default(null)
  })
  .strict();

export type WorkflowDraftLoadRequest = z.infer<typeof workflowDraftLoadRequestSchema>;
export type WorkflowDraftLoadResponse = z.infer<typeof workflowDraftLoadResponseSchema>;
export type WorkflowDraftApplyActionRequest = z.infer<typeof workflowDraftApplyActionRequestSchema>;
export type WorkflowDraftAnswerQuestionRequest = z.infer<
  typeof workflowDraftAnswerQuestionRequestSchema
>;
export type WorkflowDraftUpdateUserFieldRequest = z.infer<
  typeof workflowDraftUpdateUserFieldRequestSchema
>;
export type WorkflowDraftLockFieldRequest = z.infer<typeof workflowDraftLockFieldRequestSchema>;
export type WorkflowDraftApproveRequest = z.infer<typeof workflowDraftApproveRequestSchema>;
export type WorkflowDraftCommandResult = z.infer<typeof workflowDraftCommandResultSchema>;
export type WorkflowAgentsListResponse = z.infer<typeof workflowAgentsListResponseSchema>;
export type WorkflowDraftAssignAgentsRequest = z.infer<
  typeof workflowDraftAssignAgentsRequestSchema
>;
export type WorkflowActivationStatus = z.infer<typeof workflowActivationStatusSchema>;
export type WorkflowActivationIssue = z.infer<typeof workflowActivationIssueSchema>;
export type WorkflowActivationResult = z.infer<typeof workflowActivationResultSchema>;
