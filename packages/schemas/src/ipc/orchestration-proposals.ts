import { z } from "zod";

import {
  orchestrationProposalDraftSchema,
  orchestrationProposalEventSchema,
  orchestrationProposalSchema
} from "../orchestration-proposal";

export const ORCHESTRATION_PROPOSAL_CREATE_CHANNEL = "orchestration-proposals:create" as const;
export const ORCHESTRATION_PROPOSAL_LIST_CHANNEL = "orchestration-proposals:list" as const;
export const ORCHESTRATION_PROPOSAL_SHOW_CHANNEL = "orchestration-proposals:show" as const;
export const ORCHESTRATION_PROPOSAL_EVENTS_CHANNEL = "orchestration-proposals:events" as const;
export const ORCHESTRATION_PROPOSAL_UPDATE_CHANNEL = "orchestration-proposals:update" as const;
export const ORCHESTRATION_PROPOSAL_APPROVE_CHANNEL = "orchestration-proposals:approve" as const;
export const ORCHESTRATION_PROPOSAL_REJECT_CHANNEL = "orchestration-proposals:reject" as const;
export const ORCHESTRATION_PROPOSAL_EXECUTE_CHANNEL = "orchestration-proposals:execute" as const;
export const ORCHESTRATION_PROPOSAL_PLANNING_OPTIONS_CHANNEL =
  "orchestration-proposals:planning-options" as const;

const identifierSchema = z.string().min(1).max(160);
const revisionSchema = z.number().int().positive();

export const orchestrationProposalCreateRequestSchema = orchestrationProposalDraftSchema;

export const orchestrationProposalListRequestSchema = z
  .object({
    workspaceId: identifierSchema,
    limit: z.number().int().min(1).max(200).default(50)
  })
  .strict();

export const orchestrationProposalReferenceRequestSchema = z
  .object({
    workspaceId: identifierSchema,
    proposalId: z.string().uuid()
  })
  .strict();

export const orchestrationProposalUpdateRequestSchema = orchestrationProposalReferenceRequestSchema
  .extend({
    revision: revisionSchema,
    draft: orchestrationProposalDraftSchema
  })
  .strict();

export const orchestrationProposalReviewRequestSchema = orchestrationProposalReferenceRequestSchema
  .extend({ revision: revisionSchema })
  .strict();

/** Explicit local-user confirmation to queue the one command allowed for an approved proposal. */
export const orchestrationProposalExecuteRequestSchema =
  orchestrationProposalReferenceRequestSchema;

export const orchestrationProposalPlanningOptionsRequestSchema = z
  .object({ workspaceId: identifierSchema })
  .strict();

export const orchestrationProposalListResponseSchema = orchestrationProposalSchema.array();
export const orchestrationProposalEventListResponseSchema =
  orchestrationProposalEventSchema.array();
export const orchestrationProposalExecutionResponseSchema = z
  .object({
    commandId: z.string().uuid(),
    status: z.enum(["queued", "applying", "applied", "failed"]),
    createdAt: z.string().datetime({ offset: true }),
    runId: z.string().min(1).max(160).nullable(),
    errorCode: z.string().min(1).max(80).nullable()
  })
  .strict();
export const orchestrationProposalPlanningOptionsResponseSchema = z
  .object({
    templates: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z0-9-]+$/)
              .max(160),
            name: z.string().min(1).max(160),
            requiresGitWorktree: z.boolean()
          })
          .strict()
      )
      .max(32),
    agents: z
      .array(
        z
          .object({
            nodeId: identifierSchema,
            name: z.string().min(1).max(160),
            roleName: z.string().min(1).max(160).nullable(),
            online: z.boolean()
          })
          .strict()
      )
      .max(64)
  })
  .strict();

export type OrchestrationProposalCreateRequest = z.infer<
  typeof orchestrationProposalCreateRequestSchema
>;
export type OrchestrationProposalListRequest = z.infer<
  typeof orchestrationProposalListRequestSchema
>;
export type OrchestrationProposalReferenceRequest = z.infer<
  typeof orchestrationProposalReferenceRequestSchema
>;
export type OrchestrationProposalUpdateRequest = z.infer<
  typeof orchestrationProposalUpdateRequestSchema
>;
export type OrchestrationProposalReviewRequest = z.infer<
  typeof orchestrationProposalReviewRequestSchema
>;
export type OrchestrationProposalExecuteRequest = z.infer<
  typeof orchestrationProposalExecuteRequestSchema
>;
export type OrchestrationProposalPlanningOptionsRequest = z.infer<
  typeof orchestrationProposalPlanningOptionsRequestSchema
>;
export type OrchestrationProposalExecutionResponse = z.infer<
  typeof orchestrationProposalExecutionResponseSchema
>;
export type OrchestrationProposalPlanningOptionsResponse = z.infer<
  typeof orchestrationProposalPlanningOptionsResponseSchema
>;
