import { z } from "zod";

import {
  agentAdapterIdSchema,
  agentAssignmentPresetSchema,
  workflowNodeAgentAssignmentSchema
} from "./agent-capability";
import {
  canvasNodeLifecycleSchema,
  creationModeSchema,
  executionProfileSchema,
  workflowNodeLockSchema
} from "./workflow-mode";

/**
 * Domain model for the Automatic Workflow Composer. A `WorkflowDraft` is the single source of truth
 * for a workflow while it is being composed and reviewed. It is produced by the orchestrator through
 * structured actions, mutated only by the deterministic domain reducer, persisted with an
 * append-only event log, and projected onto the canvas as ghost nodes. Nothing here starts a process
 * or touches project files — activation belongs to a later phase.
 */

/** Abstract team role. The composer assigns roles first and resolves runtimes separately. */
export const workflowRoleSchema = z.enum([
  "orchestrator",
  "planner",
  "researcher",
  "strategist",
  "designer",
  "implementer",
  "reviewer",
  "qa",
  "security",
  "custom"
]);
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;

export const workflowNodeInputSchema = z
  .object({
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).default("")
  })
  .strict();

export const workflowNodeOutputSchema = z
  .object({
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).default("")
  })
  .strict();

/**
 * How a node should be bound to a runtime. Composition keeps this abstract: `strategy: "auto"` lets
 * the resolver pick, `"fixed"` pins a runtime. `resolvedRuntimeId` stays null until a real Capability
 * Registry entry backs it — the composer never invents availability.
 */
export const workflowRuntimeRequirementSchema = z
  .object({
    strategy: z.enum(["auto", "fixed"]).default("auto"),
    fixedRuntimeId: z.string().min(1).max(160).optional(),
    preferredProviders: z.array(z.string().min(1).max(64)).max(8).default([]),
    requiredCapabilities: z.array(z.string().min(1).max(64)).max(16).default([]),
    resolvedRuntimeId: z.string().min(1).max(160).nullable().default(null),
    resolutionReason: z.string().max(2_000).nullable().default(null)
  })
  .strict();

export const workflowNodeExecutionSchema = z
  .object({
    canRunInParallel: z.boolean().default(false),
    estimatedComplexity: z.enum(["low", "medium", "high"]).default("medium"),
    maxRetries: z.number().int().min(0).max(10).optional(),
    requiresHumanApproval: z.boolean().default(false)
  })
  .strict();

export const workflowNodeContextPolicySchema = z
  .object({
    inheritRootContext: z.boolean().default(true),
    assetRefs: z.array(z.string().min(1).max(200)).max(64).default([]),
    includeFullConversation: z.boolean().default(false),
    includeUpstreamHandoffs: z.boolean().default(true)
  })
  .strict();

// This Zod version types `.default()` against the full object, so precompute each nested default by
// parsing an empty object (every inner field already carries its own default).
const runtimeRequirementDefault = workflowRuntimeRequirementSchema.parse({});
const nodeExecutionDefault = workflowNodeExecutionSchema.parse({});
const nodeContextPolicyDefault = workflowNodeContextPolicySchema.parse({});

export const workflowNodeDraftSchema = z
  .object({
    id: z.string().min(1).max(160),
    title: z.string().trim().min(1).max(160),
    role: workflowRoleSchema,
    objective: z.string().trim().max(8_000).default(""),
    responsibilities: z.array(z.string().trim().min(1).max(2_000)).max(32).default([]),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(32).default([]),
    inputs: z.array(workflowNodeInputSchema).max(32).default([]),
    expectedOutputs: z.array(workflowNodeOutputSchema).max(32).default([]),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(32).default([]),
    runtimeRequirement: workflowRuntimeRequirementSchema.default(runtimeRequirementDefault),
    /**
     * Which agent runs this node. Deliberately OPTIONAL: a draft persisted before the neutral agent
     * model existed must still open unchanged, and its assignment is derived deterministically from
     * the legacy runtime binding instead of being invented (see `resolveNodeAgentAssignment`).
     */
    agentAssignment: workflowNodeAgentAssignmentSchema.optional(),
    execution: workflowNodeExecutionSchema.default(nodeExecutionDefault),
    contextPolicy: workflowNodeContextPolicySchema.default(nodeContextPolicyDefault),
    lifecycle: canvasNodeLifecycleSchema.default("draft"),
    /** Whether the orchestrator generated this node (badge on the ghost node). */
    generatedByOrchestrator: z.boolean().default(true),
    lock: workflowNodeLockSchema.optional()
  })
  .strict();
export type WorkflowNodeDraft = z.infer<typeof workflowNodeDraftSchema>;

/**
 * A partial update to a node draft. Every field is optional; the reducer applies only the present
 * fields and rejects (never silently ignores) any that a user lock protects. Shared by the
 * orchestrator's `update_draft_node` action and the user's inline field edits so both paths validate
 * identically.
 */
export const workflowNodeDraftPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    role: workflowRoleSchema.optional(),
    objective: z.string().trim().max(8_000).optional(),
    responsibilities: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    inputs: z.array(workflowNodeInputSchema).max(32).optional(),
    expectedOutputs: z.array(workflowNodeOutputSchema).max(32).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    runtimeRequirement: workflowRuntimeRequirementSchema.optional(),
    agentAssignment: workflowNodeAgentAssignmentSchema.optional(),
    execution: workflowNodeExecutionSchema.optional(),
    contextPolicy: workflowNodeContextPolicySchema.optional()
  })
  .strict();
export type WorkflowNodeDraftPatch = z.infer<typeof workflowNodeDraftPatchSchema>;

/** The set of node-draft field names a user can lock/edit; matches {@link workflowNodeDraftPatchSchema}. */
export const workflowNodeFieldSchema = z.enum([
  "title",
  "role",
  "objective",
  "responsibilities",
  "constraints",
  "inputs",
  "expectedOutputs",
  "acceptanceCriteria",
  "runtimeRequirement",
  "agentAssignment",
  "execution",
  "contextPolicy"
]);
export type WorkflowNodeField = z.infer<typeof workflowNodeFieldSchema>;

export const workflowEdgeContractSchema = z
  .object({
    requiredArtifacts: z.array(z.string().trim().min(1).max(2_000)).max(32).default([]),
    requiredEvidence: z.array(z.string().trim().min(1).max(2_000)).max(32).default([]),
    completionCondition: z.string().trim().max(2_000).default("")
  })
  .strict();

const edgeContractDefault = workflowEdgeContractSchema.parse({});

export const workflowEdgeDraftSchema = z
  .object({
    id: z.string().min(1).max(160),
    sourceNodeId: z.string().min(1).max(160),
    targetNodeId: z.string().min(1).max(160),
    type: z.enum(["dependency", "handoff", "review", "approval", "feedback"]),
    contract: workflowEdgeContractSchema.default(edgeContractDefault)
  })
  .strict();
export type WorkflowEdgeDraft = z.infer<typeof workflowEdgeDraftSchema>;

/** A visible, editable assumption the orchestrator made when information was not critical. */
export const workflowAssumptionSchema = z
  .object({
    id: z.string().min(1).max(160),
    statement: z.string().trim().min(1).max(2_000),
    createdBy: z.enum(["orchestrator", "user"]).default("orchestrator")
  })
  .strict();
export type WorkflowAssumption = z.infer<typeof workflowAssumptionSchema>;

/**
 * An inline question the orchestrator asks in its own terminal when a missing answer would
 * significantly change the architecture, scope, audience, outcome, constraints or delivery format.
 */
export const workflowQuestionSchema = z
  .object({
    id: z.string().min(1).max(160),
    prompt: z.string().trim().min(1).max(4_000),
    responseKind: z.enum(["free_text", "single_select", "multi_select"]).default("free_text"),
    options: z.array(z.string().trim().min(1).max(500)).max(16).default([]),
    answer: z.string().trim().max(4_000).nullable().default(null),
    answeredAt: z.string().datetime({ offset: true }).nullable().default(null)
  })
  .strict();
export type WorkflowQuestion = z.infer<typeof workflowQuestionSchema>;

export const approvalGateSchema = z
  .object({
    id: z.string().min(1).max(160),
    nodeId: z.string().min(1).max(160),
    description: z.string().trim().max(2_000).default("")
  })
  .strict();
export type ApprovalGate = z.infer<typeof approvalGateSchema>;

/**
 * Everything attached to the orchestrator's root terminal. In this phase materials are registered,
 * referenced and associated to the draft only. There is no semantic indexing, chunk selection or
 * context economy yet — that is the ContextCompiler's job in a later phase.
 */
export const rootWorkflowContextSchema = z
  .object({
    prompt: z.string().max(20_000).default(""),
    noteRefs: z.array(z.string().min(1).max(200)).max(200).default([]),
    attachmentRefs: z.array(z.string().min(1).max(200)).max(200).default([]),
    repositoryRefs: z.array(z.string().min(1).max(200)).max(64).default([]),
    sharedConstraintRefs: z.array(z.string().min(1).max(200)).max(64).default([])
  })
  .strict();
export type RootWorkflowContext = z.infer<typeof rootWorkflowContextSchema>;

const rootWorkflowContextDefault = rootWorkflowContextSchema.parse({});

export const workflowDraftStateSchema = z.enum([
  "composing",
  "needs_input",
  "ready",
  "approved",
  "activating",
  "running",
  "completed",
  "failed",
  "cancelled"
]);
export type WorkflowDraftState = z.infer<typeof workflowDraftStateSchema>;

export const workflowDraftSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    workspaceId: z.string().min(1).max(160),
    sourceTerminalId: z.string().min(1).max(160),
    creationMode: creationModeSchema,
    executionProfile: executionProfileSchema,
    title: z.string().trim().max(160).default(""),
    objective: z.string().trim().max(8_000).default(""),
    /**
     * Which agent produced this plan. Null for a manually composed draft, or for one persisted before
     * orchestrators became selectable — it is recorded, never inferred.
     */
    orchestratorAdapter: agentAdapterIdSchema.nullable().default(null),
    /** The preset that last suggested assignments. Suggestions only; the user may override each node. */
    agentAssignmentPreset: agentAssignmentPresetSchema.default("manual"),
    rootContext: rootWorkflowContextSchema.default(rootWorkflowContextDefault),
    assumptions: z.array(workflowAssumptionSchema).max(64).default([]),
    questions: z.array(workflowQuestionSchema).max(64).default([]),
    nodes: z.array(workflowNodeDraftSchema).max(200).default([]),
    edges: z.array(workflowEdgeDraftSchema).max(400).default([]),
    approvalGates: z.array(approvalGateSchema).max(64).default([]),
    /** Human-readable reasons the draft cannot be approved yet (e.g. no compatible runtime). */
    blockers: z.array(z.string().trim().min(1).max(2_000)).max(64).default([]),
    state: workflowDraftStateSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((draft, context) => {
    const nodeIds = new Set(draft.nodes.map((node) => node.id));
    for (const edge of draft.edges) {
      if (edge.sourceNodeId === edge.targetNodeId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Draft edge ${edge.id} cannot be a self loop`,
          path: ["edges"]
        });
      }
      if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Draft edge ${edge.id} references a missing node`,
          path: ["edges"]
        });
      }
    }
    for (const gate of draft.approvalGates) {
      if (!nodeIds.has(gate.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Approval gate ${gate.id} references a missing node`,
          path: ["approvalGates"]
        });
      }
    }
  });
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;

/**
 * Deterministic reason the domain reducer rejected an action. Rejections are never silent: they are
 * persisted as an event and returned to the terminal/UI so the user sees why nothing changed.
 */
export const workflowDraftRejectionReasonSchema = z.enum([
  "locked_field",
  "unknown_node",
  "duplicate_node",
  "invalid_edge",
  "invalid_state",
  "runtime_unavailable",
  "schema_invalid"
]);
export type WorkflowDraftRejectionReason = z.infer<typeof workflowDraftRejectionReasonSchema>;

/** Persisted, replayable events. Handlers are idempotent so a reload reconstructs the draft. */
export const workflowDraftEventTypeSchema = z.enum([
  "workflow.draft.started",
  "workflow.context.indexed",
  "workflow.assumption.added",
  "workflow.question.requested",
  "workflow.question.answered",
  "workflow.node.draft_created",
  "workflow.node.draft_updated",
  "workflow.node.draft_removed",
  "workflow.node.locked",
  "workflow.edge.draft_created",
  "workflow.edge.draft_removed",
  // Agent selection is a decision about the DOCUMENT, taken before any run exists. It belongs to the
  // draft's own audit log — never to RunEventType, which records what an execution actually did.
  "workflow.orchestrator.selected",
  "workflow.node.adapter_assigned",
  "workflow.node.adapter_changed",
  "workflow.node.adapter_assignment_required",
  "workflow.draft.ready",
  "workflow.approved",
  "workflow.action.rejected",
  "workflow.cancelled"
]);
export type WorkflowDraftEventType = z.infer<typeof workflowDraftEventTypeSchema>;

export const workflowDraftEventSchema = z
  .object({
    id: z.string().uuid(),
    draftId: z.string().uuid(),
    sequence: z.number().int().positive(),
    type: workflowDraftEventTypeSchema,
    actor: z.enum(["orchestrator", "local-user", "system"]),
    /** Compact, human-readable detail; never the full node payload. */
    summary: z.string().max(4_000).default(""),
    rejectionReason: workflowDraftRejectionReasonSchema.nullable().default(null),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();
export type WorkflowDraftEvent = z.infer<typeof workflowDraftEventSchema>;
