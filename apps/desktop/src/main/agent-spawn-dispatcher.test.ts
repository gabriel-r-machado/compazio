import { describe, expect, it, vi } from "vitest";

import type { AgentSpawn, AgentSpawnCanvasEvent } from "@forgedeck/schemas";

import { AgentSpawnDispatcher } from "./agent-spawn-dispatcher";

describe("AgentSpawnDispatcher", () => {
  it("materializes the node, starts the adapter and publishes both canvas states", async () => {
    const request = spawn();
    const store = {
      claimNext: vi.fn().mockReturnValueOnce(request).mockReturnValue(null),
      materializeNode: vi.fn().mockReturnValue(event("starting")),
      markRunning: vi.fn().mockReturnValue({
        spawn: { ...request, status: "running" },
        canvasEvent: event("running")
      }),
      markFailed: vi.fn()
    };
    const startAgent = vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000009" });
    const stopAgent = vi.fn();
    const publish = vi.fn();
    const dispatcher = new AgentSpawnDispatcher({ store, startAgent, stopAgent, publish });

    expect(await dispatcher.drain()).toBe(1);
    expect(store.materializeNode).toHaveBeenCalledWith(request.id);
    expect(startAgent).toHaveBeenCalledWith(request);
    expect(store.markRunning).toHaveBeenCalledWith(
      request.id,
      "00000000-0000-4000-8000-000000000009"
    );
    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it("keeps the canvas node failed when the adapter cannot launch", async () => {
    const request = spawn();
    const failedEvent = event("failed");
    const store = {
      claimNext: vi.fn().mockReturnValueOnce(request).mockReturnValue(null),
      materializeNode: vi.fn().mockReturnValue(event("starting")),
      markRunning: vi.fn(),
      markFailed: vi.fn().mockReturnValue({
        spawn: { ...request, status: "failed", errorCode: "agent_launch_failed" },
        canvasEvent: failedEvent
      })
    };
    const publish = vi.fn();
    const dispatcher = new AgentSpawnDispatcher({
      store,
      startAgent: vi.fn().mockRejectedValue(new Error("secret provider error")),
      stopAgent: vi.fn(),
      publish
    });

    expect(await dispatcher.drain()).toBe(1);
    expect(store.markFailed).toHaveBeenCalledWith(request.id, "agent_launch_failed");
    expect(publish).toHaveBeenLastCalledWith(failedEvent);
  });

  it("stops a launched session if its running state cannot be persisted", async () => {
    const request = spawn();
    const store = {
      claimNext: vi.fn().mockReturnValueOnce(request).mockReturnValue(null),
      materializeNode: vi.fn().mockReturnValue(event("starting")),
      markRunning: vi.fn().mockImplementation(() => {
        throw new Error("write failed");
      }),
      markFailed: vi.fn().mockReturnValue({
        spawn: { ...request, status: "failed", errorCode: "agent_launch_failed" },
        canvasEvent: event("failed")
      })
    };
    const stopAgent = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new AgentSpawnDispatcher({
      store,
      startAgent: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000009"
      }),
      stopAgent,
      publish: vi.fn()
    });

    await dispatcher.drain();

    expect(stopAgent).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000009");
    expect(store.markFailed).toHaveBeenCalled();
  });
});

function spawn(): AgentSpawn {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-1",
    canvasId: "canvas-1",
    projectId: "00000000-0000-4000-8000-000000000002",
    nodeId: "agent-00000000-0000-4000-8000-000000000003",
    adapterId: "codex",
    roleName: "tester",
    name: "qa-auth",
    requestedByNodeId: null,
    status: "spawning",
    idempotencyKey: "spawn-1",
    attempt: 1,
    sessionId: null,
    errorCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:01.000Z"
  };
}

function event(state: "starting" | "running" | "failed"): AgentSpawnCanvasEvent {
  const request = spawn();
  return {
    spawn: {
      ...request,
      status: state === "starting" ? "spawning" : state,
      errorCode: state === "failed" ? "agent_launch_failed" : null
    },
    node: {
      id: request.nodeId,
      type: "agent",
      position: { x: 160, y: 140 },
      width: 560,
      height: 380,
      data: {
        title: request.name,
        state,
        summary: "Spawned",
        adapterId: request.adapterId,
        retryMaxAttempts: 1,
        permissions: []
      }
    },
    canvasRevision: state === "starting" ? 2 : 3
  };
}
