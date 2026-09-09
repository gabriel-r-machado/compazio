import { z } from "zod";

import { canvasAgentRoleSchema, canvasNodeSchema } from "./ipc/canvas";

/**
 * Durable requests to change an agent that already exists on the canvas: close its terminal, or give
 * it a different responsibility.
 *
 * They are a queue rather than a direct call for the same reason spawning is: the CLI runs in its own
 * short-lived process and cannot end a PTY or restart an agent. Only the desktop runtime owns
 * processes, so a request is recorded, claimed by the runtime, and its outcome persisted — which also
 * means a request survives the app being closed mid-flight instead of vanishing.
 */

export const AGENT_LIFECYCLE_EVENT_CHANNEL = "agent-lifecycle:event" as const;

/**
 * `restart` brings a terminal back under the identity it already had. It is separate from removing
 * and creating one because the node, its responsibility, its position and its connections are what
 * make it the same teammate; recreating would lose all of that.
 */
export const agentLifecycleActionSchema = z.enum(["remove", "assign_role", "restart"]);
export const agentLifecycleStatusSchema = z.enum([
  "queued",
  "applying",
  "applied",
  "failed",
  "interrupted"
]);
export const agentLifecycleEventTypeSchema = z.enum([
  "command_queued",
  "command_started",
  "session_stopped",
  "node_removed",
  "role_assigned",
  "agent_restarted",
  "command_applied",
  "command_failed",
  "command_interrupted"
]);

export const createAgentLifecycleCommandSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    targetNodeId: z.string().min(1).max(160),
    action: agentLifecycleActionSchema,
    /** Required for `assign_role`, refused for `remove`. */
    role: canvasAgentRoleSchema.nullable().default(null),
    requestedByNodeId: z.string().min(1).max(160).nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict()
  .superRefine((command, context) => {
    if (command.action === "assign_role" && command.role === null) {
      context.addIssue({ code: "custom", message: "assign_role requires a role" });
    }
    if (command.action !== "assign_role" && command.role !== null) {
      context.addIssue({ code: "custom", message: `${command.action} does not accept a role` });
    }
  });

export const agentLifecycleCommandSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    projectId: z.string().uuid(),
    targetNodeId: z.string().min(1).max(160),
    action: agentLifecycleActionSchema,
    role: canvasAgentRoleSchema.nullable(),
    requestedByNodeId: z.string().min(1).max(160).nullable(),
    status: agentLifecycleStatusSchema,
    idempotencyKey: z.string().min(1).max(200),
    sessionId: z.string().uuid().nullable(),
    errorCode: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

/**
 * What the canvas needs to reflect an applied command. `node` is absent for a removal — the node is
 * gone — and present for a reassignment, carrying the same position, name and connections it had.
 */
export const agentLifecycleCanvasEventSchema = z
  .object({
    command: agentLifecycleCommandSchema,
    node: canvasNodeSchema.nullable(),
    removedNodeId: z.string().min(1).max(160).nullable(),
    canvasRevision: z.number().int().positive()
  })
  .strict();

export type AgentLifecycleAction = z.infer<typeof agentLifecycleActionSchema>;
export type AgentLifecycleStatus = z.infer<typeof agentLifecycleStatusSchema>;
export type AgentLifecycleEventType = z.infer<typeof agentLifecycleEventTypeSchema>;
export type CreateAgentLifecycleCommand = z.infer<typeof createAgentLifecycleCommandSchema>;
export type AgentLifecycleCommand = z.infer<typeof agentLifecycleCommandSchema>;
export type AgentLifecycleCanvasEvent = z.infer<typeof agentLifecycleCanvasEventSchema>;
