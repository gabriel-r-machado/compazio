import { z } from "zod";

import {
  autonomyActionKindSchema,
  autonomyConfigSchema,
  autonomyDecisionOutcomeSchema,
  autonomyDecisionRuleSchema,
  autonomyRuntimeStateSchema
} from "@forgedeck/workflow";

export const autonomyActorSchema = z.string().min(1).max(160);

/**
 * Immutable audit record of one supervised-autonomy decision (batch E4). The context carries only
 * the sanitized quota configuration and numeric/boolean runtime state that produced the decision —
 * never a path, command, executable, prompt or SQL.
 */
export const recordedAutonomyDecisionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    runId: z.string().min(1).max(160).nullable(),
    proposalId: z.string().uuid().nullable(),
    actor: autonomyActorSchema,
    action: autonomyActionKindSchema,
    outcome: autonomyDecisionOutcomeSchema,
    rule: autonomyDecisionRuleSchema,
    context: z.object({
      config: autonomyConfigSchema,
      state: autonomyRuntimeStateSchema
    }),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type RecordedAutonomyDecision = z.infer<typeof recordedAutonomyDecisionSchema>;
