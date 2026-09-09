import { z } from "zod";

import { autonomyConfigSchema, defaultAutonomyConfig } from "@forgedeck/workflow";

import { agentPermissionSchema } from "./policy";

export const autonomyLevelSchema = z.enum(["assisted", "supervised", "autonomous"]);
export const orchestrationProposalStatusSchema = z.enum(["draft", "approved", "rejected"]);
export const orchestrationProposalEventTypeSchema = z.enum([
  "created",
  "updated",
  "approved",
  "rejected",
  "execution_requested"
]);

const orchestrationProposalDraftBaseSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    objective: z.string().trim().min(1).max(8_000),
    understanding: z.string().trim().min(1).max(8_000),
    questions: z.array(z.string().trim().min(1).max(2_000)).max(32),
    requiredMaterials: z.array(z.string().trim().min(1).max(2_000)).max(64),
    suggestedTeam: z
      .array(
        z.object({ nodeId: z.string().min(1).max(160), role: z.string().min(1).max(160) }).strict()
      )
      .max(32),
    workflowTemplateId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(160)
      .nullable(),
    executionAgentNodeId: z.string().min(1).max(160).nullable().default(null),
    dependencies: z
      .array(z.tuple([z.string().min(1).max(160), z.string().min(1).max(160)]))
      .max(128),
    requestedPermissions: z.array(agentPermissionSchema).max(16),
    gates: z.array(z.string().trim().min(1).max(160)).max(32),
    risks: z.array(z.string().trim().min(1).max(2_000)).max(32),
    estimatedCost: z.string().trim().min(1).max(160).nullable(),
    estimatedDuration: z.string().trim().min(1).max(160).nullable(),
    autonomyLevel: autonomyLevelSchema,
    // Supervised-autonomy limits for this reviewed workflow. Optional with conservative defaults so
    // proposals created before batch E4 keep parsing without any migration.
    autonomy: autonomyConfigSchema.default(defaultAutonomyConfig)
  })
  .strict();

export const orchestrationProposalDraftSchema = orchestrationProposalDraftBaseSchema.superRefine(
  validateProposalDependencies
);

export const orchestrationProposalSchema = orchestrationProposalDraftBaseSchema
  .extend({
    id: z.string().uuid(),
    status: orchestrationProposalStatusSchema,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
    createdBy: z.literal("local-user"),
    reviewedBy: z.literal("local-user").nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict()
  .superRefine(validateProposalDependencies);

export const orchestrationProposalEventSchema = z
  .object({
    id: z.string().uuid(),
    proposalId: z.string().uuid(),
    sequence: z.number().int().positive(),
    type: orchestrationProposalEventTypeSchema,
    actor: z.literal("local-user"),
    details: z.string().max(2_000).nullable(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;
export type OrchestrationProposalDraft = z.infer<typeof orchestrationProposalDraftSchema>;
export type OrchestrationProposal = z.infer<typeof orchestrationProposalSchema>;
export type OrchestrationProposalEvent = z.infer<typeof orchestrationProposalEventSchema>;
export type OrchestrationProposalEventType = z.infer<typeof orchestrationProposalEventTypeSchema>;

function validateProposalDependencies(
  proposal: { readonly dependencies: readonly (readonly [string, string])[] },
  context: z.RefinementCtx
): void {
  const outgoing = new Map<string, string[]>();
  for (const [source, target] of proposal.dependencies) {
    if (source === target) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Proposal dependencies cannot contain self loops",
        path: ["dependencies"]
      });
      return;
    }
    const targets = outgoing.get(source) ?? [];
    targets.push(target);
    outgoing.set(source, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of outgoing.get(node) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  if ([...outgoing.keys()].some(visit)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Proposal dependencies must form a DAG",
      path: ["dependencies"]
    });
  }
}
