import { z } from "zod";

import { canvasAgentRoleSchema } from "./ipc/canvas";

/**
 * Wire protocol for the orchestrator agent. A Claude/Codex terminal marked as the orchestrator
 * plans the work in natural language and emits one machine-readable action per line, wrapped between
 * these sentinels so the desktop can separate control actions from ordinary terminal chatter:
 *
 *   ⟦compasso:action⟧{"type":"spawn_agent","ref":"ui","adapter":"codex","title":"UI"}⟦/compasso⟧
 *
 * The desktop never trusts free-form output as state: only well-formed, schema-valid actions between
 * the sentinels are applied, and every action still passes the supervised-autonomy guardrail before
 * touching the canvas.
 */
export const ORCHESTRATOR_ACTION_OPEN = "⟦compasso:action⟧";
export const ORCHESTRATOR_ACTION_CLOSE = "⟦/compasso⟧";

const orchestratorRefSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Reference must be a short lowercase slug");

const orchestratorAdapterSchema = z.enum(["claude-code", "codex", "opencode", "shell"]);

const orchestratorConnectionKindSchema = z.enum(["handoff", "dependency", "context"]);

/** A team member the orchestrator wants created as its own terminal-backed agent node. */
export const orchestratorSpawnAgentSchema = z
  .object({
    type: z.literal("spawn_agent"),
    ref: orchestratorRefSchema,
    adapter: orchestratorAdapterSchema,
    title: z.string().trim().min(1).max(160),
    role: canvasAgentRoleSchema.optional(),
    task: z.string().trim().max(8_000).optional()
  })
  .strict();

export const orchestratorAddNoteSchema = z
  .object({
    type: z.literal("add_note"),
    ref: orchestratorRefSchema.optional(),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(20_000)
  })
  .strict();

export const orchestratorConnectSchema = z
  .object({
    type: z.literal("connect"),
    from: orchestratorRefSchema,
    to: orchestratorRefSchema,
    kind: orchestratorConnectionKindSchema.default("handoff")
  })
  .strict();

export const orchestratorAssignRoleSchema = z
  .object({
    type: z.literal("assign_role"),
    ref: orchestratorRefSchema,
    role: canvasAgentRoleSchema
  })
  .strict();

export const orchestratorCloseAgentSchema = z
  .object({
    type: z.literal("close_agent"),
    ref: orchestratorRefSchema,
    reason: z.string().trim().max(2_000).optional()
  })
  .strict();

export const orchestratorPauseSchema = z
  .object({
    type: z.literal("pause"),
    reason: z.string().trim().min(1).max(2_000)
  })
  .strict();

export const orchestratorCompleteSchema = z
  .object({
    type: z.literal("complete"),
    summary: z.string().trim().min(1).max(8_000)
  })
  .strict();

export const orchestratorActionSchema = z.discriminatedUnion("type", [
  orchestratorSpawnAgentSchema,
  orchestratorAddNoteSchema,
  orchestratorConnectSchema,
  orchestratorAssignRoleSchema,
  orchestratorCloseAgentSchema,
  orchestratorPauseSchema,
  orchestratorCompleteSchema
]);

export type OrchestratorAdapter = z.infer<typeof orchestratorAdapterSchema>;
export type OrchestratorConnectionKind = z.infer<typeof orchestratorConnectionKindSchema>;
export type OrchestratorAction = z.infer<typeof orchestratorActionSchema>;
export type OrchestratorActionType = OrchestratorAction["type"];
