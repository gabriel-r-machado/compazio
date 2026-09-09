import { z } from "zod";

export const agentMessageStatusSchema = z.enum([
  "queued",
  "delivering",
  "sent",
  "failed",
  "delivery_unknown",
  "cancelled"
]);

export const agentMessageEventTypeSchema = z.enum([
  "message_queued",
  "delivery_started",
  "message_sent",
  "delivery_failed",
  "delivery_interrupted",
  "response_recorded",
  "message_cancelled",
  "retry_requested"
]);

export const agentMessageContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1024);

export const enqueueAgentMessageSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    recipientNodeId: z.string().min(1).max(160),
    senderNodeId: z.string().min(1).max(160).nullable().default(null),
    content: agentMessageContentSchema,
    idempotencyKey: z.string().min(1).max(200),
    /**
     * The sender is blocked on this request and will read the answer as its own command output, so
     * recording the response must not also enqueue a delivery into the sender's terminal.
     */
    awaitedBySender: z.boolean().default(false)
  })
  .strict();

export const agentMessageSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    projectId: z.string().uuid(),
    recipientNodeId: z.string().min(1).max(160),
    senderNodeId: z.string().min(1).max(160).nullable(),
    content: agentMessageContentSchema,
    status: agentMessageStatusSchema,
    idempotencyKey: z.string().min(1).max(200),
    attempt: z.number().int().nonnegative(),
    sessionId: z.string().uuid().nullable(),
    adapterId: z.string().min(1).max(160).nullable(),
    errorCode: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    sentAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict();

export const recordAgentResponseSchema = z
  .object({
    requestMessageId: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    responderNodeId: z.string().min(1).max(160),
    content: agentMessageContentSchema,
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

export const agentMessageResponseSchema = z
  .object({
    id: z.string().uuid(),
    requestMessageId: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    projectId: z.string().uuid(),
    responderNodeId: z.string().min(1).max(160),
    content: agentMessageContentSchema,
    status: z.enum(["recorded", "queued_to_sender"]),
    idempotencyKey: z.string().min(1).max(200),
    deliveryMessageId: z.string().uuid().nullable(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type AgentMessageStatus = z.infer<typeof agentMessageStatusSchema>;
export type AgentMessageEventType = z.infer<typeof agentMessageEventTypeSchema>;
export type EnqueueAgentMessage = z.infer<typeof enqueueAgentMessageSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type RecordAgentResponse = z.infer<typeof recordAgentResponseSchema>;
export type AgentMessageResponse = z.infer<typeof agentMessageResponseSchema>;
