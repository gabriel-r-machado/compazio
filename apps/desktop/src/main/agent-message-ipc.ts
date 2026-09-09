import type { IpcMain } from "electron";

import type { SqliteAgentMessageStore } from "@forgedeck/local-db";
import {
  AGENT_MESSAGES_CANCEL_CHANNEL,
  AGENT_MESSAGES_LIST_CONVERSATIONS_CHANNEL,
  AGENT_MESSAGES_LIST_INBOX_CHANNEL,
  AGENT_MESSAGES_RETRY_CHANNEL,
  agentConversationsRequestSchema,
  agentConversationsResponseSchema,
  agentMessageControlRequestSchema,
  agentMessageInboxRequestSchema,
  agentMessageSchema
} from "@forgedeck/schemas";

type AgentMessageApi = Pick<
  SqliteAgentMessageStore,
  "cancel" | "get" | "listConversations" | "listInbox" | "retry"
>;

export function registerAgentMessageIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  store: AgentMessageApi
): void {
  register(ipc, AGENT_MESSAGES_LIST_INBOX_CHANNEL, (payload) => handleListInbox(store, payload));
  register(ipc, AGENT_MESSAGES_CANCEL_CHANNEL, (payload) => handleCancel(store, payload));
  register(ipc, AGENT_MESSAGES_RETRY_CHANNEL, (payload) => handleRetry(store, payload));
  register(ipc, AGENT_MESSAGES_LIST_CONVERSATIONS_CHANNEL, (payload) =>
    handleListConversations(store, payload)
  );
}

/** State only: the canvas draws that work was asked for and whether it came back, never the text. */
export function handleListConversations(
  store: Pick<SqliteAgentMessageStore, "listConversations">,
  payload: unknown
) {
  const request = agentConversationsRequestSchema.parse(payload);
  return agentConversationsResponseSchema.parse(store.listConversations(request.workspaceId));
}

export function handleListInbox(
  store: Pick<SqliteAgentMessageStore, "listInbox">,
  payload: unknown
) {
  const request = agentMessageInboxRequestSchema.parse(payload);
  return agentMessageSchema
    .array()
    .parse(store.listInbox(request.workspaceId, request.agentNodeId, request.limit));
}

export function handleCancel(store: AgentMessageApi, payload: unknown) {
  const request = agentMessageControlRequestSchema.parse(payload);
  requireWorkspaceMessage(store, request.workspaceId, request.messageId);
  return agentMessageSchema.parse(store.cancel(request.messageId));
}

export function handleRetry(store: AgentMessageApi, payload: unknown) {
  const request = agentMessageControlRequestSchema.parse(payload);
  requireWorkspaceMessage(store, request.workspaceId, request.messageId);
  return agentMessageSchema.parse(store.retry(request.messageId));
}

function requireWorkspaceMessage(
  store: Pick<SqliteAgentMessageStore, "get">,
  workspaceId: string,
  messageId: string
): void {
  const message = store.get(messageId);
  if (message === null || message.workspaceId !== workspaceId) {
    throw new Error("Agent message does not belong to this workspace");
  }
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => unknown
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}
