import { describe, expect, it, vi } from "vitest";

import type { WorkspaceNoteCanvasEvent } from "@forgedeck/schemas";

import { WorkspaceNoteDispatcher } from "./workspace-note-dispatcher";

describe("WorkspaceNoteDispatcher", () => {
  it("publishes durable canvas projections in order", async () => {
    const first = event("00000000-0000-4000-8000-000000000001", "note_created");
    const second = event("00000000-0000-4000-8000-000000000002", "note_appended");
    const store = {
      claimNextCanvasEvent: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second)
        .mockReturnValue(null),
      markCanvasEventPublished: vi.fn()
    };
    const publish = vi.fn();
    const dispatcher = new WorkspaceNoteDispatcher({ store, publish });

    expect(await dispatcher.drain()).toBe(2);
    expect(publish).toHaveBeenNthCalledWith(1, first);
    expect(publish).toHaveBeenNthCalledWith(2, second);
    expect(store.markCanvasEventPublished).toHaveBeenCalledWith(first.id);
    expect(store.markCanvasEventPublished).toHaveBeenCalledWith(second.id);
  });
});

function event(id: string, type: "note_created" | "note_appended"): WorkspaceNoteCanvasEvent {
  return {
    id,
    type,
    note: {
      id: "00000000-0000-4000-8000-000000000010",
      workspaceId: "workspace-1",
      canvasId: "canvas-1",
      projectId: "00000000-0000-4000-8000-000000000011",
      nodeId: "note-1",
      title: "Decisões",
      content: "Usar SQLite.",
      revision: type === "note_created" ? 1 : 2,
      createdByNodeId: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:01.000Z"
    },
    node: {
      id: "note-1",
      type: "note",
      position: { x: 160, y: 140 },
      width: 360,
      height: 220,
      data: {
        title: "Decisões",
        state: "idle",
        summary: "Usar SQLite.",
        content: "Usar SQLite.",
        retryMaxAttempts: 1,
        permissions: []
      }
    },
    canvasRevision: type === "note_created" ? 2 : 3
  };
}
