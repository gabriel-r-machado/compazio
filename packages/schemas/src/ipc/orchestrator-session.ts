import { z } from "zod";

import { compositionStateSchema } from "../composition-state";
import { executionProfileSchema } from "../workflow-mode";
import { canvasSnapshotSchema } from "./canvas";

/**
 * IPC surface for the real CLI orchestrator session (automatic mode). Unlike the deterministic
 * composer, these channels do not return a draft: starting spawns a real agent PTY, and sending the
 * objective writes it to that session. The draft then materializes asynchronously as the agent emits
 * composition actions, pushed to the renderer over {@link WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL}.
 */
export const ORCHESTRATOR_SESSION_START_CHANNEL = "orchestrator-session:start" as const;
export const ORCHESTRATOR_SESSION_SEND_OBJECTIVE_CHANNEL =
  "orchestrator-session:send-objective" as const;
export const ORCHESTRATOR_SESSION_CANCEL_CHANNEL = "orchestrator-session:cancel" as const;
/** Main → renderer push whenever a session mutates its draft, so ghost nodes refresh live. */
export const WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL = "workflow-draft:updated" as const;
/** Main → renderer push for every observable automatic-composition transition. */
export const ORCHESTRATOR_COMPOSITION_UPDATED_EVENT_CHANNEL =
  "orchestrator-session:composition-updated" as const;

const identifierSchema = z.string().min(1).max(160);

/**
 * A real composition is deliberately more precise than a boolean spinner. The desktop owns these
 * states; a CLI can propose a workflow but can never leave the UI in an unbounded loading state.
 */
export const workflowCompositionStatusSchema = z.enum([
  "idle",
  "validating",
  "connecting_agent",
  "composing",
  "validating_result",
  "ready_for_approval",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled"
]);
export type WorkflowCompositionStatus = z.infer<typeof workflowCompositionStatusSchema>;

export const workflowCompositionErrorSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(4_000),
    retryable: z.boolean()
  })
  .strict();
export type WorkflowCompositionError = z.infer<typeof workflowCompositionErrorSchema>;

export const workflowCompositionSchema = z
  .object({
    compositionId: z.string().uuid(),
    projectId: identifierSchema,
    workspaceId: identifierSchema,
    sessionId: identifierSchema.nullable(),
    status: workflowCompositionStatusSchema,
    currentStage: z.string().min(1).max(240),
    startedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    timeoutAt: z.string().datetime({ offset: true }).nullable(),
    error: workflowCompositionErrorSchema.nullable()
  })
  .strict();
export type WorkflowComposition = z.infer<typeof workflowCompositionSchema>;

export const orchestratorSessionStartRequestSchema = z
  .object({
    projectId: identifierSchema,
    workspaceId: identifierSchema,
    executionProfile: executionProfileSchema,
    /** The user's runtime choice; the strongest usable runtime is auto-selected when absent. */
    preferredRuntimeId: z.string().min(1).max(64).optional()
  })
  .strict();

export const orchestratorSessionStartResponseSchema = z
  .object({
    sessionId: identifierSchema,
    runtimeId: identifierSchema,
    state: compositionStateSchema
  })
  .strict();

export const orchestratorSessionSendObjectiveRequestSchema = z
  .object({
    sessionId: identifierSchema,
    objective: z.string().trim().min(1).max(8_000),
    executionProfile: executionProfileSchema,
    /** The live canvas so the agent produces a delta, not a blind rebuild. */
    canvas: canvasSnapshotSchema,
    /**
     * A retry may reuse an identical, unstarted plan that finished just after the UI deadline. Normal
     * composition never opts in, so asking for the same objective later still creates a fresh plan.
     */
    reuseRecentPlan: z.boolean().optional()
  })
  .strict();

export const orchestratorSessionSendObjectiveResponseSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const orchestratorSessionCancelRequestSchema = z
  .object({ sessionId: identifierSchema })
  .strict();

export const orchestratorSessionCancelResponseSchema = workflowCompositionSchema;

export type OrchestratorSessionStartRequest = z.infer<typeof orchestratorSessionStartRequestSchema>;
export type OrchestratorSessionStartResponse = z.infer<
  typeof orchestratorSessionStartResponseSchema
>;
export type OrchestratorSessionSendObjectiveRequest = z.infer<
  typeof orchestratorSessionSendObjectiveRequestSchema
>;
export type OrchestratorSessionSendObjectiveResponse = z.infer<
  typeof orchestratorSessionSendObjectiveResponseSchema
>;
export type OrchestratorSessionCancelRequest = z.infer<
  typeof orchestratorSessionCancelRequestSchema
>;
export type OrchestratorSessionCancelResponse = z.infer<
  typeof orchestratorSessionCancelResponseSchema
>;
