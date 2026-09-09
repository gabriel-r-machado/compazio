import { describe, expect, it, vi } from "vitest";

import type { AgentAdapter } from "@forgedeck/agent-sdk";
import type { AgentMessage as StoredAgentMessage } from "@forgedeck/schemas";

import { AgentMessageDispatcher } from "./agent-message-dispatcher";

describe("AgentMessageDispatcher", () => {
  it("sends a claimed message through its adapter and records success", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const markSent = vi.fn();
    const message = storedMessage();
    const dispatcher = new AgentMessageDispatcher({
      store: {
        claimNext: vi.fn().mockReturnValueOnce(message).mockReturnValueOnce(null),
        markSent,
        markFailed: vi.fn()
      },
      adapters: { get: () => ({ sendMessage }) as unknown as AgentAdapter },
      terminal: { write: vi.fn(), cancel: vi.fn(), forceKill: vi.fn() }
    });

    expect(await dispatcher.drain()).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ write: expect.any(Function) }),
      {
        id: message.id,
        content: expect.stringContaining(
          `respond_with: compasso respond ${message.id} --from reviewer`
        )
      }
    );
    expect(markSent).toHaveBeenCalledWith(message.id);
  });

  it("refuses to write a queued message into a plain shell", async () => {
    const markFailed = vi.fn();
    const shellMessage = { ...storedMessage(), adapterId: "shell" };
    const sendMessage = vi.fn();
    const dispatcher = new AgentMessageDispatcher({
      store: {
        claimNext: vi.fn().mockReturnValueOnce(shellMessage).mockReturnValueOnce(null),
        markSent: vi.fn(),
        markFailed
      },
      adapters: { get: () => ({ sendMessage }) as unknown as AgentAdapter },
      terminal: { write: vi.fn(), cancel: vi.fn(), forceKill: vi.fn() }
    });

    expect(await dispatcher.drain()).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(shellMessage.id, "recipient_not_agent");
  });

  it("records a bounded error code without retrying automatically", async () => {
    const markFailed = vi.fn();
    const dispatcher = new AgentMessageDispatcher({
      store: {
        claimNext: vi.fn().mockReturnValueOnce(storedMessage()).mockReturnValueOnce(null),
        markSent: vi.fn(),
        markFailed
      },
      adapters: {
        get: () =>
          ({
            sendMessage: vi.fn(async () => {
              throw new Error("secret terminal output");
            })
          }) as unknown as AgentAdapter
      },
      terminal: { write: vi.fn(), cancel: vi.fn(), forceKill: vi.fn() }
    });

    expect(await dispatcher.drain()).toBe(1);
    expect(markFailed).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000003",
      "agent_bridge_send_failed"
    );
  });

  it("limits concurrent deliveries within one project", async () => {
    const first = storedMessage();
    const second = { ...storedMessage(), id: "00000000-0000-4000-8000-000000000004" };
    const completions: (() => void)[] = [];
    const sendMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve);
        })
    );
    const dispatcher = new AgentMessageDispatcher({
      store: {
        claimNext: vi
          .fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second)
          .mockReturnValue(null),
        markSent: vi.fn(),
        markFailed: vi.fn()
      },
      adapters: { get: () => ({ sendMessage }) as unknown as AgentAdapter },
      terminal: { write: vi.fn(), cancel: vi.fn(), forceKill: vi.fn() },
      maxConcurrentDeliveries: 2
    });

    const draining = dispatcher.drain();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    completions.forEach((complete) => complete());
    expect(await draining).toBe(2);
  });
});

function storedMessage(): StoredAgentMessage {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    workspaceId: "workspace-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    recipientNodeId: "reviewer",
    senderNodeId: null,
    content: "Revise a autenticação.",
    status: "delivering",
    idempotencyKey: "request-1",
    attempt: 1,
    sessionId: "00000000-0000-4000-8000-000000000002",
    adapterId: "codex",
    errorCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:01.000Z",
    sentAt: null
  };
}
