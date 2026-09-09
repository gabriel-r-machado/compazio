import { z } from "zod";

export const AGENT_MESSAGES_LIST_INBOX_CHANNEL = "agent-messages:list-inbox" as const;
export const AGENT_MESSAGES_CANCEL_CHANNEL = "agent-messages:cancel" as const;
export const AGENT_MESSAGES_RETRY_CHANNEL = "agent-messages:retry" as const;
export const AGENT_MESSAGES_LIST_CONVERSATIONS_CHANNEL =
  "agent-messages:list-conversations" as const;

const workspaceIdSchema = z.string().min(1).max(160);
const agentNodeIdSchema = z.string().min(1).max(160);

/**
 * Where the latest exchange between one pair of agents stands. This is the canvas's view of a
 * conversation and deliberately carries no content: an edge shows that work was asked for and
 * whether it came back, never what was said.
 *
 * `awaiting-response` covers both a queued and an already-written request, because from the canvas's
 * point of view they are the same situation — the answer has not arrived. A request written into a
 * terminal is not an answer, exactly as an idle terminal is not a completed task.
 */
export const agentConversationStateSchema = z.enum([
  "awaiting-response",
  "responded",
  "failed",
  "cancelled"
]);

export const agentConversationSchema = z
  .object({
    senderNodeId: agentNodeIdSchema,
    recipientNodeId: agentNodeIdSchema,
    state: agentConversationStateSchema,
    /** Attempts recorded for the latest request; surfaces a retried delivery without its content. */
    attempt: z.number().int().nonnegative(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const agentConversationsRequestSchema = z
  .object({ workspaceId: workspaceIdSchema })
  .strict();

export const agentConversationsResponseSchema = z.array(agentConversationSchema).max(2_000);

export const agentMessageInboxRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    agentNodeId: agentNodeIdSchema,
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();

export const agentMessageControlRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    messageId: z.string().uuid()
  })
  .strict();

/** Input accepts an omitted limit; parsing applies the safe default in the main process. */
export type AgentMessageInboxRequest = z.input<typeof agentMessageInboxRequestSchema>;
export type AgentMessageControlRequest = z.infer<typeof agentMessageControlRequestSchema>;
export type AgentConversationState = z.infer<typeof agentConversationStateSchema>;
export type AgentConversation = z.infer<typeof agentConversationSchema>;
export type AgentConversationsRequest = z.infer<typeof agentConversationsRequestSchema>;
