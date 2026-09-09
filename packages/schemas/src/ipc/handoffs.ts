import { z } from "zod";

import { canvasAgentRoleSchema, edgeContractSchema } from "./canvas";

export const HANDOFF_CREATE_DRAFT_CHANNEL = "handoffs:create-draft" as const;
export const HANDOFF_UPDATE_DRAFT_CHANNEL = "handoffs:update-draft" as const;
export const HANDOFF_MARK_READY_CHANNEL = "handoffs:mark-ready" as const;
export const HANDOFF_DELIVER_CHANNEL = "handoffs:deliver" as const;
export const HANDOFF_AWAIT_DESTINATION_CHANNEL = "handoffs:await-destination" as const;
export const HANDOFF_RETRY_CHANNEL = "handoffs:retry" as const;
export const HANDOFF_MARK_SENT_CHANNEL = "handoffs:mark-sent" as const;
export const HANDOFF_CANCEL_DELIVERY_CHANNEL = "handoffs:cancel-delivery" as const;
export const HANDOFF_LIST_CHANNEL = "handoffs:list" as const;
export const HANDOFF_LIST_EVENTS_CHANNEL = "handoffs:list-events" as const;

const boundedIdSchema = z.string().min(1).max(160);
const handoffTextItemSchema = z.string().min(1).max(2_000);

export const canvasHandoffStatusSchema = z.enum([
  "draft",
  "ready",
  "awaiting_destination",
  "submitting",
  "written_to_terminal",
  "submitted_to_agent",
  "delivering",
  "delivered",
  "rejected",
  "failed",
  "delivery_unknown",
  "cancelled"
]);

export const canvasHandoffEventTypeSchema = z.enum([
  "draft_created",
  "draft_updated",
  "handoff_ready",
  "handoff_rejected",
  "destination_unavailable",
  "delivery_attempt_started",
  "delivery_started",
  "written_to_terminal",
  "submitted_to_agent",
  "response_detected",
  "delivered",
  "delivery_failed",
  "delivery_unknown",
  "retry_requested",
  "delivery_cancelled",
  "delivery_marked_sent",
  "destination_retargeted"
]);

export const canvasHandoffDeliveryAttemptStatusSchema = z.enum([
  "submitting",
  "written_to_terminal",
  "submitted_to_agent",
  "response_detected",
  "failed",
  "delivery_unknown",
  "cancelled",
  "manually_marked_sent"
]);

export const canvasHandoffDeliveryAttemptSchema = z
  .object({
    id: boundedIdSchema,
    handoffId: boundedIdSchema,
    sequence: z.number().int().positive(),
    targetSessionId: boundedIdSchema.nullable(),
    adapterId: z.string().min(1).max(80).nullable(),
    status: canvasHandoffDeliveryAttemptStatusSchema,
    confirmation: z.enum(["response_detected", "manual_marked_sent"]).nullable(),
    error: z.string().max(2_000).nullable(),
    responsible: z.enum(["system", "local_user"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const handoffEvidenceSchema = z
  .object({
    label: z.string().min(1).max(160),
    detail: z.string().min(1).max(2_000)
  })
  .strict();

export const handoffDraftContentSchema = z
  .object({
    summary: z.string().max(8_000).default(""),
    completedWork: z.array(handoffTextItemSchema).max(32).default([]),
    decisions: z.array(handoffTextItemSchema).max(32).default([]),
    evidence: z.array(handoffEvidenceSchema).max(32).default([]),
    openQuestions: z.array(handoffTextItemSchema).max(32).default([]),
    risks: z.array(handoffTextItemSchema).max(32).default([])
  })
  .strict();

export const handoffApprovedContentSchema = handoffDraftContentSchema.extend({
  summary: z.string().trim().min(1).max(8_000)
});

export const handoffNodeSnapshotSchema = z
  .object({
    nodeId: boundedIdSchema,
    title: z.string().min(1).max(160),
    role: canvasAgentRoleSchema
  })
  .strict();

export const handoffEdgeSnapshotSchema = z
  .object({
    edgeId: boundedIdSchema,
    contract: edgeContractSchema
  })
  .strict();

export const canvasHandoffSchema = z
  .object({
    id: boundedIdSchema,
    canvasId: boundedIdSchema,
    projectId: boundedIdSchema,
    status: canvasHandoffStatusSchema,
    revision: z.number().int().positive(),
    mission: z.string().min(1).max(20_000),
    source: handoffNodeSnapshotSchema,
    target: handoffNodeSnapshotSchema,
    edge: handoffEdgeSnapshotSchema,
    content: handoffDraftContentSchema,
    error: z.string().max(2_000).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    readyAt: z.string().datetime({ offset: true }).nullable(),
    deliveredAt: z.string().datetime({ offset: true }).nullable(),
    deliveryAttempts: z.array(canvasHandoffDeliveryAttemptSchema).max(200).default([])
  })
  .strict();

export const canvasHandoffEventSchema = z
  .object({
    id: boundedIdSchema,
    handoffId: boundedIdSchema,
    sequence: z.number().int().positive(),
    type: canvasHandoffEventTypeSchema,
    fromStatus: canvasHandoffStatusSchema.nullable(),
    toStatus: canvasHandoffStatusSchema,
    error: z.string().max(2_000).nullable(),
    deliveryAttemptId: boundedIdSchema.nullable().default(null),
    responsible: z.enum(["system", "local_user"]).default("system"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const handoffCreateDraftRequestSchema = z
  .object({
    canvasId: boundedIdSchema,
    sourceNodeId: boundedIdSchema,
    targetNodeId: boundedIdSchema,
    edgeId: boundedIdSchema
  })
  .strict();

export const handoffUpdateDraftRequestSchema = z
  .object({
    handoffId: boundedIdSchema,
    revision: z.number().int().positive(),
    content: handoffDraftContentSchema
  })
  .strict();

export const handoffMarkReadyRequestSchema = z
  .object({
    handoffId: boundedIdSchema,
    revision: z.number().int().positive(),
    content: handoffApprovedContentSchema
  })
  .strict();

export const handoffDeliverRequestSchema = z
  .object({
    handoffId: boundedIdSchema,
    targetSessionId: boundedIdSchema
  })
  .strict();

export const handoffAwaitDestinationRequestSchema = z
  .object({
    handoffId: boundedIdSchema,
    revision: z.number().int().positive()
  })
  .strict();

export const handoffRetryRequestSchema = handoffDeliverRequestSchema.extend({
  revision: z.number().int().positive()
});

export const handoffMarkSentRequestSchema = z
  .object({
    handoffId: boundedIdSchema,
    revision: z.number().int().positive(),
    deliveryAttemptId: boundedIdSchema
  })
  .strict();

export const handoffCancelDeliveryRequestSchema = z
  .object({
    handoffId: boundedIdSchema,
    revision: z.number().int().positive()
  })
  .strict();

export const handoffListRequestSchema = z
  .object({
    canvasId: boundedIdSchema,
    limit: z.number().int().min(1).max(200).default(50)
  })
  .strict();

export const handoffListEventsRequestSchema = z
  .object({
    handoffId: boundedIdSchema
  })
  .strict();

const allowedTransitions: Readonly<Record<CanvasHandoffStatus, readonly CanvasHandoffStatus[]>> = {
  draft: ["ready", "rejected"],
  ready: ["awaiting_destination", "submitting", "cancelled"],
  awaiting_destination: ["ready", "cancelled"],
  submitting: ["written_to_terminal", "failed", "delivery_unknown"],
  written_to_terminal: ["submitted_to_agent", "failed", "delivery_unknown"],
  submitted_to_agent: ["delivered", "failed", "delivery_unknown"],
  delivering: ["delivery_unknown"],
  delivered: [],
  rejected: ["draft"],
  failed: ["ready", "cancelled"],
  delivery_unknown: ["ready", "delivered", "cancelled"],
  cancelled: ["ready"]
};

export function canTransitionCanvasHandoff(
  from: CanvasHandoffStatus,
  to: CanvasHandoffStatus
): boolean {
  return allowedTransitions[from].includes(to);
}

export type CanvasHandoffStatus = z.infer<typeof canvasHandoffStatusSchema>;
export type CanvasHandoffEventType = z.infer<typeof canvasHandoffEventTypeSchema>;
export type CanvasHandoffDeliveryAttempt = z.infer<typeof canvasHandoffDeliveryAttemptSchema>;
export type CanvasHandoffDeliveryAttemptStatus = z.infer<
  typeof canvasHandoffDeliveryAttemptStatusSchema
>;
export type HandoffEvidence = z.infer<typeof handoffEvidenceSchema>;
export type HandoffDraftContent = z.infer<typeof handoffDraftContentSchema>;
export type HandoffApprovedContent = z.infer<typeof handoffApprovedContentSchema>;
export type HandoffNodeSnapshot = z.infer<typeof handoffNodeSnapshotSchema>;
export type HandoffEdgeSnapshot = z.infer<typeof handoffEdgeSnapshotSchema>;
export type CanvasHandoff = z.infer<typeof canvasHandoffSchema>;
export type CanvasHandoffEvent = z.infer<typeof canvasHandoffEventSchema>;
export type HandoffCreateDraftRequest = z.infer<typeof handoffCreateDraftRequestSchema>;
export type HandoffUpdateDraftRequest = z.infer<typeof handoffUpdateDraftRequestSchema>;
export type HandoffMarkReadyRequest = z.infer<typeof handoffMarkReadyRequestSchema>;
export type HandoffDeliverRequest = z.infer<typeof handoffDeliverRequestSchema>;
export type HandoffAwaitDestinationRequest = z.infer<typeof handoffAwaitDestinationRequestSchema>;
export type HandoffRetryRequest = z.infer<typeof handoffRetryRequestSchema>;
export type HandoffMarkSentRequest = z.infer<typeof handoffMarkSentRequestSchema>;
export type HandoffCancelDeliveryRequest = z.infer<typeof handoffCancelDeliveryRequestSchema>;
export type HandoffListRequest = z.infer<typeof handoffListRequestSchema>;
export type HandoffListEventsRequest = z.infer<typeof handoffListEventsRequestSchema>;
