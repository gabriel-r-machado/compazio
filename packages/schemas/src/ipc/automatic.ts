import { z } from "zod";

import { agentAdapterIdSchema } from "../agent-capability";
import { automaticWorkflowModeSchema } from "../automatic-workflow";

/**
 * The renderer's only door into automatic mode. Every request is validated here before any handler runs,
 * and every response is a small projection: the renderer never receives a store handle, a SQLite row, a
 * runtime object, an adapter, a workflow definition or a full prompt. It sends an objective and a budget
 * mode; the main process owns everything else.
 */

export const AUTOMATIC_CREATE_CHANNEL = "automatic:create" as const;
export const AUTOMATIC_START_CHANNEL = "automatic:start" as const;
export const AUTOMATIC_SHOW_CHANNEL = "automatic:show" as const;
export const AUTOMATIC_LIST_CHANNEL = "automatic:list" as const;
export const AUTOMATIC_PAUSE_CHANNEL = "automatic:pause" as const;
export const AUTOMATIC_RESUME_CHANNEL = "automatic:resume" as const;
export const AUTOMATIC_CANCEL_CHANNEL = "automatic:cancel" as const;
export const AUTOMATIC_APPROVE_CHANNEL = "automatic:approve" as const;
export const AUTOMATIC_REJECT_CHANNEL = "automatic:reject" as const;
/** Lists the agents that could write a plan, and whether each one can right now. */
export const AUTOMATIC_ORCHESTRATORS_CHANNEL = "automatic:orchestrators" as const;
/** Push channel: an automatic session changed and the renderer should re-read the snapshot. */
export const AUTOMATIC_EVENT_CHANNEL = "automatic:event" as const;

const automaticRunIdSchema = z.string().uuid();
const workspaceIdSchema = z.string().min(1).max(160);

export const automaticCreateRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    objective: z.string().trim().min(1).max(8_000),
    mode: automaticWorkflowModeSchema,
    /**
     * WHO WRITES THE PLAN. Deliberately separate from the per-node `assignedAdapter`, which decides who
     * EXECUTES each node: choosing a planner never moves an executor, and the budget preset never
     * silently changes the planner. Absent means the product default.
     */
    orchestratorAdapter: agentAdapterIdSchema.optional(),
    /** Extra acceptance criteria the user typed; the plan must satisfy them. */
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(32).default([])
  })
  .strict();
export type AutomaticCreateRequest = z.infer<typeof automaticCreateRequestSchema>;

/** One selectable planner, as the picker renders it. Availability is asked for, never persisted. */
export const automaticOrchestratorOptionSchema = z
  .object({
    id: agentAdapterIdSchema,
    displayName: z.string().min(1).max(80),
    /** False when this build has no planning port for the agent at all. */
    supportsPlanning: z.boolean(),
    available: z.boolean(),
    version: z.string().max(160).nullable(),
    /** Why it cannot be chosen right now; shown instead of silently falling back to another planner. */
    unavailableReason: z.string().max(2_000).nullable(),
    /**
     * Whether a session planned by this agent can also remediate a failed node automatically. When
     * false the session stops at the first verification failure with a stated reason — it never hands
     * the remediation to a different agent.
     */
    supportsRemediation: z.boolean()
  })
  .strict();
export type AutomaticOrchestratorOption = z.infer<typeof automaticOrchestratorOptionSchema>;

export const automaticOrchestratorListResponseSchema = z
  .object({ orchestrators: z.array(automaticOrchestratorOptionSchema).max(16) })
  .strict();
export type AutomaticOrchestratorListResponse = z.infer<
  typeof automaticOrchestratorListResponseSchema
>;

export const automaticRunRefSchema = z.object({ automaticRunId: automaticRunIdSchema }).strict();
export type AutomaticRunRef = z.infer<typeof automaticRunRefSchema>;

export const automaticListRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema.optional(),
    limit: z.number().int().min(1).max(200).optional()
  })
  .strict();
export type AutomaticListRequest = z.infer<typeof automaticListRequestSchema>;

export const automaticApprovalDecisionRequestSchema = z
  .object({
    automaticRunId: automaticRunIdSchema,
    nodeId: z.string().min(1).max(160),
    /** Binds the decision to the exact action presented; a different action has a different value. */
    actionFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type AutomaticApprovalDecisionRequest = z.infer<
  typeof automaticApprovalDecisionRequestSchema
>;

export const automaticRunStatusSchema = z.enum([
  "planning",
  "awaiting_approval",
  "running",
  "completed",
  "stopped",
  "rejected"
]);
export type AutomaticRunStatusDto = z.infer<typeof automaticRunStatusSchema>;

/** What is left of the product-fixed budget, so the user can see the loop is bounded. */
export const automaticRemainingLimitsSchema = z
  .object({
    remediationCyclesUsed: z.number().int().min(0),
    remediationCyclesTotal: z.number().int().min(0),
    maxAttemptsPerNode: z.number().int().min(1),
    maxWorkflowNodes: z.number().int().min(1),
    timeoutMs: z.number().int().min(0)
  })
  .strict();

/** One plan node as the canvas needs it. The full prompt is deliberately NOT part of this projection. */
export const automaticPlanNodeSummarySchema = z
  .object({
    nodeId: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    role: z.string().max(160),
    dependsOn: z.array(z.string().min(1).max(160)).max(64),
    operationRisk: z.enum(["safe", "caution", "destructive"]),
    requiresHumanApproval: z.boolean(),
    /** Present once the node has a verdict in the lineage. */
    verified: z.boolean().nullable()
  })
  .strict();

export const automaticPendingApprovalSchema = z
  .object({
    nodeId: z.string().min(1).max(160),
    actionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Short, sanitized reason the action needs a human; never a full prompt. */
    reason: z.string().max(2_000)
  })
  .strict();

/**
 * Who planned this session, and under what conditions. It is written once, at planning time, and read
 * back on reload — a reload shows the planner without ever planning again. It carries no credential and
 * no CLI-private configuration, and availability is deliberately NOT part of it: availability is
 * momentary runtime state, never a persisted truth.
 */
export const orchestratorProvenanceSchema = z
  .object({
    /** Null means a legacy session with no recorded planner: unknown, never inferred. */
    adapter: agentAdapterIdSchema.nullable(),
    /** The planner CLI's own reported version at planning time. */
    version: z.string().max(160).nullable(),
    plannedAt: z.string().nullable(),
    /** The budget preset in force when the plan was written. */
    strategy: automaticWorkflowModeSchema.nullable(),
    /**
     * sha256 of the canonical plan the orchestrator produced. It belongs to that GENERATION and never
     * changes afterwards: editing which agent executes a node does not rewrite what was planned.
     */
    planHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    /**
     * sha256 of the current revision — the exact draft that would be materialized, including every
     * per-node choice the user made. It moves when the user edits an assignment; the plan hash does not.
     */
    draftHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    /** The revision that was actually materialized, recorded at start. Null until the session starts. */
    materializedDraftHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    supportsRemediation: z.boolean(),
    /** Sanitized structured planning diagnostics worth keeping; never a prompt or file content. */
    diagnostics: z.array(z.string().max(2_000)).max(32).default([])
  })
  .strict();
export type OrchestratorProvenanceDto = z.infer<typeof orchestratorProvenanceSchema>;

export const automaticRunSnapshotSchema = z
  .object({
    automaticRunId: automaticRunIdSchema,
    workspaceId: workspaceIdSchema,
    objective: z.string().max(8_000),
    mode: automaticWorkflowModeSchema,
    status: automaticRunStatusSchema,
    /** Short plan summary shown in the canvas panel. */
    planTitle: z.string().max(160).nullable(),
    planSummary: z.string().max(4_000).nullable(),
    nodes: z.array(automaticPlanNodeSummarySchema).max(50),
    /** The lineage of official runs; the last is current. The inspector opens these. */
    runIds: z.array(z.string().min(1).max(160)).max(64),
    currentRunId: z.string().min(1).max(160).nullable(),
    limits: automaticRemainingLimitsSchema,
    pendingApprovals: z.array(automaticPendingApprovalSchema).max(50),
    stopReason: z.string().max(160).nullable(),
    /** Sanitized, human-readable outcome; never raw terminal output. */
    result: z.string().max(4_000).nullable(),
    /** Why a plan was refused, when it was. */
    issues: z.array(z.string().max(2_000)).max(64),
    /**
     * Who wrote this plan, recorded at planning time. Null for a session persisted before planners
     * became selectable: that is reported as unknown, never guessed from the node adapters.
     */
    orchestrator: orchestratorProvenanceSchema.nullable(),
    /**
     * True when something the PLAN depends on changed — the objective, the planner, the strategy, the
     * limits or the workspace. The existing plan is kept and shown as out of date; replanning is an
     * explicit action, never automatic.
     */
    planStale: z.boolean().default(false),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();
export type AutomaticRunSnapshotDto = z.infer<typeof automaticRunSnapshotSchema>;

export const automaticListResponseSchema = z
  .object({ runs: z.array(automaticRunSnapshotSchema).max(200) })
  .strict();
export type AutomaticListResponse = z.infer<typeof automaticListResponseSchema>;

/** Official automatic-mode event names. Events invalidate; the snapshot stays the source of truth. */
export const automaticEventTypeSchema = z.enum([
  "automatic.created",
  "planning.started",
  "planning.completed",
  "planning.rejected",
  "workflow.started",
  "verification.started",
  "verification.failed",
  "remediation.planned",
  "remediation.started",
  "corrective_node.added",
  "approval.required",
  "automatic.completed",
  "automatic.stopped"
]);
export type AutomaticEventType = z.infer<typeof automaticEventTypeSchema>;

export const automaticEventSchema = z
  .object({
    type: automaticEventTypeSchema,
    automaticRunId: automaticRunIdSchema,
    workspaceId: workspaceIdSchema,
    /** The official run the event refers to, when it refers to one. */
    runId: z.string().min(1).max(160).nullable(),
    nodeId: z.string().min(1).max(160).nullable(),
    /** Compact, sanitized detail. Never a prompt, a path, a command or raw output. */
    detail: z.string().max(2_000),
    at: z.string()
  })
  .strict();
export type AutomaticEvent = z.infer<typeof automaticEventSchema>;
