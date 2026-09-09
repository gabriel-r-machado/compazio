import { z } from "zod";

/** Permissions understood by the local Policy Engine. Unknown canvas metadata is never a grant. */
export const agentPermissionSchema = z.enum([
  "send_messages",
  "create_notes",
  "publish_artifacts",
  "create_agents",
  /**
   * Closing another agent's terminal and reassigning its responsibility are separate grants from
   * creating one: an orchestrator that may recruit does not automatically get to dismiss or rewrite
   * the instructions of agents it did not create.
   */
  "remove_agents",
  "assign_roles",
  "connect_context",
  "create_handoffs",
  "approve_deliveries",
  "execute_tasks",
  "manage_worktrees",
  "merge_changes",
  // Kept for existing canvases created before the Policy Engine.
  "read_context"
]);

export const policyDecisionOutcomeSchema = z.enum(["allowed", "denied"]);
export const policyDecisionReasonSchema = z.enum([
  "local_user",
  "permission_granted",
  "workspace_not_found",
  "actor_not_found",
  "actor_not_agent_capable",
  "permission_missing"
]);

export const policyAuthorizationRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    actorNodeId: z.string().min(1).max(160).nullable(),
    permission: agentPermissionSchema
  })
  .strict();

export const policyDecisionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160).nullable(),
    actorNodeId: z.string().min(1).max(160).nullable(),
    permission: agentPermissionSchema,
    outcome: policyDecisionOutcomeSchema,
    reason: policyDecisionReasonSchema,
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type AgentPermission = z.infer<typeof agentPermissionSchema>;

/**
 * The powers a terminal needs to compose and run a team, and nothing beyond them.
 *
 * Notably absent: `execute_tasks`, `manage_worktrees`, `merge_changes`, `approve_deliveries`.
 * Coordinating a team is not the same as being allowed to ship its work, and an orchestrator that
 * could approve its own team's deliveries would be reviewing itself.
 *
 * Lives in the contract layer rather than in `@forgedeck/orchestration` because the renderer writes
 * this list onto a canvas node and the renderer cannot import that package — its scheduler pulls in
 * `node:crypto`. A duplicated copy would be free to drift from the one the Policy Engine enforces.
 */
export const ORCHESTRATOR_TEAM_PERMISSIONS: readonly AgentPermission[] = Object.freeze([
  "create_agents",
  "remove_agents",
  "assign_roles",
  "connect_context",
  "create_notes",
  "send_messages",
  "read_context"
]);

/**
 * Whether a canvas node's granted permissions make it the team's orchestrator.
 *
 * Deliberately derived from the permission list rather than stored as a second boolean beside it.
 * The Policy Engine authorizes every action against exactly this list, so a separate flag could only
 * ever disagree with it — and a terminal that *looks* like an orchestrator while every command it
 * runs is denied is worse than one that never claimed to be.
 *
 * `create_agents` is the defining power: recruiting is what separates coordinating a team from being
 * a member of one.
 */
export function grantsTeamOrchestration(permissions: readonly string[]): boolean {
  return permissions.includes("create_agents");
}
export type PolicyAuthorizationRequest = z.infer<typeof policyAuthorizationRequestSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type PolicyDecisionOutcome = z.infer<typeof policyDecisionOutcomeSchema>;
export type PolicyDecisionReason = z.infer<typeof policyDecisionReasonSchema>;
