import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConnectionCanvasEvent } from "@forgedeck/schemas";

import { WorkspaceConnectionDispatcher } from "./workspace-connection-dispatcher";

describe("WorkspaceConnectionDispatcher", () => {
  it("publishes each durable canvas edge projection in order", async () => {
    const first = event("00000000-0000-4000-8000-000000000001", "edge-1");
    const second = event("00000000-0000-4000-8000-000000000002", "edge-2");
    const store = {
      claimNextCanvasEvent: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second)
        .mockReturnValue(null),
      markCanvasEventPublished: vi.fn()
    };
    const publish = vi.fn();
    const dispatcher = new WorkspaceConnectionDispatcher({ store, publish });

    expect(await dispatcher.drain()).toBe(2);
    expect(publish).toHaveBeenNthCalledWith(1, first);
    expect(publish).toHaveBeenNthCalledWith(2, second);
    expect(store.markCanvasEventPublished).toHaveBeenNthCalledWith(1, first.id);
    expect(store.markCanvasEventPublished).toHaveBeenNthCalledWith(2, second.id);
  });
});

function event(id: string, edgeId: string): WorkspaceConnectionCanvasEvent {
  return {
    id,
    type: "connection_created",
    workspaceId: "workspace-1",
    canvasId: "canvas-1",
    connection: {
      connectionId: edgeId,
      canvasId: "canvas-1",
      sourceNodeId: "note-1",
      targetNodeId: "agent-1",
      type: "context",
      permission: "connect_context",
      label: "Context",
      createdBy: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      revision: 2
    },
    edge: {
      id: edgeId,
      source: "note-1",
      target: "agent-1",
      contract: {
        schemaVersion: "1.0",
        kind: "context",
        label: "Context",
        requiredEvidenceTypes: []
      }
    },
    actorNodeId: null,
    canvasRevision: 2
  };
}
