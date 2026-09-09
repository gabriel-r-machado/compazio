import { describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@forgedeck/schemas";

import {
  handleCancel,
  handleListConversations,
  handleListInbox,
  handleRetry
} from "./agent-message-ipc";

describe("agent message IPC handlers", () => {
  it("lists only the selected agent inbox through a bounded typed request", () => {
    const store = storeDouble();

    expect(
      handleListInbox(store, { workspaceId: "workspace-1", agentNodeId: "reviewer", limit: 20 })
    ).toEqual([message()]);
    expect(store.listInbox).toHaveBeenCalledWith("workspace-1", "reviewer", 20);
    expect(() =>
      handleListInbox(store, {
        workspaceId: "workspace-1",
        agentNodeId: "reviewer",
        path: "C:/private"
      })
    ).toThrow();
  });

  it("keeps cancellation and retry scoped to the current workspace", () => {
    const store = storeDouble();
    expect(() =>
      handleCancel(store, {
        workspaceId: "another-workspace",
        messageId: message().id
      })
    ).toThrow("does not belong");
    expect(store.cancel).not.toHaveBeenCalled();

    expect(handleRetry(store, { workspaceId: "workspace-1", messageId: message().id })).toEqual(
      message()
    );
    expect(store.retry).toHaveBeenCalledWith(message().id);
  });

  it("exposes conversation state to the canvas without any message content", () => {
    const store = storeDouble();

    const conversations = handleListConversations(store, { workspaceId: "workspace-1" });

    expect(conversations).toEqual([
      {
        senderNodeId: "planner",
        recipientNodeId: "reviewer",
        state: "awaiting-response",
        attempt: 1,
        updatedAt: "2026-07-27T12:00:00.000Z"
      }
    ]);
    // The schema is strict, so an implementation that started leaking text would fail here.
    expect(JSON.stringify(conversations)).not.toContain("Review the change.");
    expect(() =>
      handleListConversations(store, { workspaceId: "workspace-1", limit: 5 })
    ).toThrow();
  });
});

function storeDouble() {
  const current = message();
  return {
    listInbox: vi.fn(() => [current]),
    get: vi.fn(() => current),
    cancel: vi.fn(() => current),
    retry: vi.fn(() => current),
    listConversations: vi.fn(() => [
      {
        senderNodeId: "planner",
        recipientNodeId: "reviewer",
        state: "awaiting-response" as const,
        attempt: 1,
        updatedAt: "2026-07-27T12:00:00.000Z"
      }
    ])
  };
}

function message(): AgentMessage {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-1",
    projectId: "00000000-0000-4000-8000-000000000002",
    recipientNodeId: "reviewer",
    senderNodeId: null,
    content: "Review the change.",
    status: "queued",
    idempotencyKey: "message-1",
    attempt: 0,
    sessionId: null,
    adapterId: null,
    errorCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    sentAt: null
  };
}
