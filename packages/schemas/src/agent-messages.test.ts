import { describe, expect, it } from "vitest";

import {
  agentMessageResponseSchema,
  agentMessageSchema,
  enqueueAgentMessageSchema,
  recordAgentResponseSchema
} from "./agent-messages";

describe("agent message schemas", () => {
  it("accepts a bounded local message request", () => {
    expect(
      enqueueAgentMessageSchema.parse({
        workspaceId: "workspace-1",
        recipientNodeId: "reviewer",
        senderNodeId: null,
        content: "Revise a autenticação.",
        idempotencyKey: "request-1"
      })
    ).toMatchObject({ recipientNodeId: "reviewer", senderNodeId: null });
  });

  it("rejects blank content and undeclared fields", () => {
    expect(() =>
      enqueueAgentMessageSchema.parse({
        workspaceId: "workspace-1",
        recipientNodeId: "reviewer",
        content: "   ",
        idempotencyKey: "request-1"
      })
    ).toThrow();
    expect(() =>
      enqueueAgentMessageSchema.parse({
        workspaceId: "workspace-1",
        recipientNodeId: "reviewer",
        content: "Review",
        idempotencyKey: "request-1",
        executeCommand: true
      })
    ).toThrow();
  });

  it("requires an auditable delivery state", () => {
    expect(() =>
      agentMessageSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        workspaceId: "workspace-1",
        projectId: "00000000-0000-4000-8000-000000000002",
        recipientNodeId: "reviewer",
        senderNodeId: null,
        content: "Review",
        status: "completed",
        idempotencyKey: "request-1",
        attempt: 0,
        sessionId: null,
        adapterId: null,
        errorCode: null,
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
        sentAt: null
      })
    ).toThrow();
  });

  it("validates a correlated response without treating it as task completion", () => {
    expect(
      recordAgentResponseSchema.parse({
        requestMessageId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "workspace-1",
        responderNodeId: "reviewer",
        content: "Encontrei dois problemas.",
        idempotencyKey: "response-1"
      })
    ).toMatchObject({ responderNodeId: "reviewer" });
    expect(
      agentMessageResponseSchema.parse({
        id: "00000000-0000-4000-8000-000000000002",
        requestMessageId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "workspace-1",
        projectId: "00000000-0000-4000-8000-000000000003",
        responderNodeId: "reviewer",
        content: "Encontrei dois problemas.",
        status: "recorded",
        idempotencyKey: "response-1",
        deliveryMessageId: null,
        createdAt: "2026-07-20T12:00:00.000Z"
      }).status
    ).toBe("recorded");
  });
});
