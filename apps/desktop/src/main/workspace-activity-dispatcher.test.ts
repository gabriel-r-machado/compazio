import { describe, expect, it, vi } from "vitest";

import type { WorkspaceActivityEvent } from "@forgedeck/schemas";

import { WorkspaceActivityDispatcher } from "./workspace-activity-dispatcher";

describe("WorkspaceActivityDispatcher", () => {
  it("uses one observer, debounces changes, and stops cleanly", async () => {
    const prime = vi.fn();
    const pull = vi
      .fn<() => readonly WorkspaceActivityEvent[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([activity("message-1")])
      .mockReturnValue([]);
    const publish = vi.fn();
    const observers: (() => void)[] = [];
    const unsubscribe = vi.fn();
    const dispatcher = new WorkspaceActivityDispatcher(
      {
        store: { prime, pull },
        observe: (onChange) => {
          observers.push(onChange);
          return unsubscribe;
        },
        publish
      },
      60_000,
      1
    );

    dispatcher.start();
    dispatcher.start();
    expect(prime).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(1);
    expect(await dispatcher.drain()).toBe(1);
    expect(publish).toHaveBeenCalledWith(activity("message-1"));

    observers[0]?.();
    observers[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pull).toHaveBeenCalledTimes(3);

    dispatcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

function activity(id: string): WorkspaceActivityEvent {
  return {
    id,
    workspaceId: "workspace-1",
    canvasId: "canvas-1",
    subject: "message",
    subjectId: "message-1",
    agentNodeId: "reviewer",
    eventType: "message_queued",
    occurredAt: "2026-07-20T12:00:00.000Z"
  };
}
