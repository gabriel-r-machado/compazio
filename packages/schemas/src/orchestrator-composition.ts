import { z } from "zod";

import {
  workflowNodeContextPolicySchema,
  workflowNodeDraftPatchSchema,
  workflowNodeExecutionSchema,
  workflowNodeInputSchema,
  workflowNodeOutputSchema,
  workflowRoleSchema,
  workflowRuntimeRequirementSchema
} from "./workflow-draft";

/**
 * Wire protocol for the Automatic Workflow Composer. A terminal marked as orchestrator plans in
 * natural language and emits one machine-readable action per line, wrapped between the same sentinels
 * the live-drive protocol uses so the desktop can separate control actions from terminal chatter.
 *
 * Crucially, this protocol ONLY composes a draft: it can inspect, create/update/remove ghost nodes,
 * connect them, ask the user and record assumptions. It has NO ability to spawn agents, run commands
 * or touch files — that enforcement is by absence of capability, not by trusting the agent's text.
 * The desktop applies an action only after the domain reducer validates it; free-form output is never
 * treated as state.
 */
export const ORCHESTRATOR_COMPOSITION_OPEN = "⟦compasso:draft⟧";
export const ORCHESTRATOR_COMPOSITION_CLOSE = "⟦/compasso⟧";

/** Short, stable reference the orchestrator uses for a node; it doubles as the draft node id. */
export const compositionRefSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Reference must be a short lowercase slug");

const inspectWorkspaceContextSchema = z
  .object({ type: z.literal("inspect_workspace_context") })
  .strict();
const inspectAvailableRuntimesSchema = z
  .object({ type: z.literal("inspect_available_runtimes") })
  .strict();
const inspectAttachedMaterialsSchema = z
  .object({ type: z.literal("inspect_attached_materials") })
  .strict();

export const startWorkflowDraftSchema = z
  .object({
    type: z.literal("start_workflow_draft"),
    title: z.string().trim().max(160).optional(),
    objective: z.string().trim().min(1).max(8_000)
  })
  .strict();

export const addDraftNodeSchema = z
  .object({
    type: z.literal("add_draft_node"),
    ref: compositionRefSchema,
    title: z.string().trim().min(1).max(160),
    role: workflowRoleSchema,
    objective: z.string().trim().max(8_000).optional(),
    responsibilities: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    inputs: z.array(workflowNodeInputSchema).max(32).optional(),
    expectedOutputs: z.array(workflowNodeOutputSchema).max(32).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    runtimeRequirement: workflowRuntimeRequirementSchema.optional(),
    execution: workflowNodeExecutionSchema.optional(),
    contextPolicy: workflowNodeContextPolicySchema.optional()
  })
  .strict();

/** Every field is optional: the reducer only touches the ones present, and never a locked field. */
export const updateDraftNodeSchema = workflowNodeDraftPatchSchema
  .extend({
    type: z.literal("update_draft_node"),
    ref: compositionRefSchema
  })
  .strict();

export const removeDraftNodeSchema = z
  .object({ type: z.literal("remove_draft_node"), ref: compositionRefSchema })
  .strict();

export const connectDraftNodesSchema = z
  .object({
    type: z.literal("connect_draft_nodes"),
    from: compositionRefSchema,
    to: compositionRefSchema,
    edgeType: z
      .enum(["dependency", "handoff", "review", "approval", "feedback"])
      .default("handoff"),
    requiredArtifacts: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    requiredEvidence: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    completionCondition: z.string().trim().max(2_000).optional()
  })
  .strict();

export const disconnectDraftNodesSchema = z
  .object({
    type: z.literal("disconnect_draft_nodes"),
    from: compositionRefSchema,
    to: compositionRefSchema
  })
  .strict();

export const requestUserInputSchema = z
  .object({
    type: z.literal("request_user_input"),
    prompt: z.string().trim().min(1).max(4_000),
    responseKind: z.enum(["free_text", "single_select", "multi_select"]).default("free_text"),
    options: z.array(z.string().trim().min(1).max(500)).max(16).optional()
  })
  .strict();

export const addWorkflowAssumptionSchema = z
  .object({
    type: z.literal("add_workflow_assumption"),
    statement: z.string().trim().min(1).max(2_000)
  })
  .strict();

export const finalizeWorkflowDraftSchema = z
  .object({ type: z.literal("finalize_workflow_draft") })
  .strict();

export const orchestratorCompositionActionSchema = z.discriminatedUnion("type", [
  inspectWorkspaceContextSchema,
  inspectAvailableRuntimesSchema,
  inspectAttachedMaterialsSchema,
  startWorkflowDraftSchema,
  addDraftNodeSchema,
  updateDraftNodeSchema,
  removeDraftNodeSchema,
  connectDraftNodesSchema,
  disconnectDraftNodesSchema,
  requestUserInputSchema,
  addWorkflowAssumptionSchema,
  finalizeWorkflowDraftSchema
]);

export type OrchestratorCompositionAction = z.infer<typeof orchestratorCompositionActionSchema>;
export type OrchestratorCompositionActionType = OrchestratorCompositionAction["type"];
