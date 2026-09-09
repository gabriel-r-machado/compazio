import { describe, expect, it, vi } from "vitest";

import type { WorkspaceArtifactCanvasEvent } from "@forgedeck/schemas";

import { WorkspaceArtifactDispatcher } from "./workspace-artifact-dispatcher";

describe("WorkspaceArtifactDispatcher", () => {
  it("publishes durable artifact canvas projections in order", async () => {
    const first = event("00000000-0000-4000-8000-000000000001");
    const second = event("00000000-0000-4000-8000-000000000002");
    const store = {
      claimNextCanvasEvent: vi
        .fn<() => WorkspaceArtifactCanvasEvent | null>()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second)
        .mockReturnValue(null),
      markCanvasEventPublished: vi.fn()
    };
    const publish = vi.fn();
    const dispatcher = new WorkspaceArtifactDispatcher({ store, publish });

    expect(await dispatcher.drain()).toBe(2);
    expect(publish).toHaveBeenNthCalledWith(1, first);
    expect(publish).toHaveBeenNthCalledWith(2, second);
    expect(store.markCanvasEventPublished).toHaveBeenCalledWith(first.id);
    expect(store.markCanvasEventPublished).toHaveBeenCalledWith(second.id);
  });
});

function event(id: string): WorkspaceArtifactCanvasEvent {
  return {
    id,
    type: "artifact_published",
    workspaceId: "workspace-1",
    canvasId: "canvas-1",
    artifact: {
      id: "00000000-0000-4000-8000-000000000010",
      workspaceId: "workspace-1",
      projectId: "00000000-0000-4000-8000-000000000011",
      kind: "test-report",
      sourceRelativePath: "reports/test.json",
      relativePath: ".forgedeck/artifacts/report/test.json",
      filename: "test.json",
      sha256: "a".repeat(64),
      byteSize: 12,
      mediaType: "application/json",
      publishedByNodeId: null,
      createdAt: "2026-07-20T12:00:00.000Z"
    },
    node: {
      id: "artifact-00000000-0000-4000-8000-000000000010",
      type: "artifact",
      position: { x: 160, y: 140 },
      data: {
        title: "test.json",
        state: "idle",
        summary: "Artifact",
        artifact: {
          artifactId: "00000000-0000-4000-8000-000000000010",
          kind: "test-report",
          relativePath: ".forgedeck/artifacts/report/test.json",
          filename: "test.json",
          sha256: "a".repeat(64),
          byteSize: 12,
          mediaType: "application/json"
        },
        retryMaxAttempts: 1,
        permissions: []
      }
    },
    canvasRevision: 2
  };
}
