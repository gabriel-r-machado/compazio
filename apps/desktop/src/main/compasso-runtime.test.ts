import { describe, expect, it, vi } from "vitest";

import {
  CompassoRuntime,
  RuntimeProjectConflictError,
  type CompassoRuntimeServices
} from "./compasso-runtime";

describe("CompassoRuntime", () => {
  it("coordinates one runtime lease per project and releases it on shutdown", () => {
    const leases = new Map<string, string>();
    const runtime = new CompassoRuntime({
      ...createServices(leases),
      instanceId: "runtime-a",
      now: () => new Date("2026-07-20T12:00:00.000Z")
    });

    runtime.acquireProject("project-1");
    runtime.acquireProject("project-1");
    expect(leases.get("project-1")).toBe("runtime-a");

    const competingRuntime = new CompassoRuntime({
      ...createServices(leases),
      instanceId: "runtime-b"
    });
    expect(() => competingRuntime.acquireProject("project-1")).toThrow(RuntimeProjectConflictError);

    runtime.start();
    runtime.dispose();
    expect(leases.has("project-1")).toBe(false);

    competingRuntime.acquireProject("project-1");
    expect(leases.get("project-1")).toBe("runtime-b");
  });

  it("keeps lifecycle transitions manual and cancels terminal sessions only on explicit commands", async () => {
    const lifecycle = {
      claimNext: () => null,
      markApplied: vi.fn(),
      markFailed: vi.fn(),
      recordSystemState: vi.fn()
    };
    const services = createServices(new Map());
    const terminal = services.terminal as unknown as { shutdown: ReturnType<typeof vi.fn> };
    terminal.shutdown = vi.fn().mockResolvedValue(undefined);
    const runtime = new CompassoRuntime({ ...services, lifecycle });

    runtime.start();
    runtime.pause();
    runtime.resume();
    await runtime.drain();
    await runtime.cancel();
    await runtime.shutdown();
    runtime.dispose();

    expect(terminal.shutdown).toHaveBeenCalledTimes(2);
    expect(lifecycle.recordSystemState).toHaveBeenCalledWith("pause", "paused");
    expect(lifecycle.recordSystemState).toHaveBeenCalledWith("drain", "draining");
    expect(lifecycle.recordSystemState).toHaveBeenCalledWith("cancel", "cancelled");
    expect(lifecycle.recordSystemState).toHaveBeenCalledWith("shutdown", "shutdown");
  });

  it("records the host shutdown after terminal teardown without a renderer dependency", () => {
    const lifecycle = {
      claimNext: () => null,
      markApplied: vi.fn(),
      markFailed: vi.fn(),
      recordSystemState: vi.fn()
    };
    const runtime = new CompassoRuntime({ ...createServices(new Map()), lifecycle });

    runtime.start();
    runtime.recordHostShutdown();
    runtime.dispose();

    expect(lifecycle.recordSystemState).toHaveBeenCalledWith(
      "shutdown",
      "shutdown",
      "desktop-runtime"
    );
  });
});

function createServices(leases: Map<string, string>): CompassoRuntimeServices {
  const terminal = {
    cancel: async () => undefined,
    shutdown: async () => undefined,
    write: async () => undefined,
    forceKill: async () => undefined
  };
  const emptyQueue = {
    claimNext: () => null
  };
  return {
    terminal,
    adapters: { get: () => ({}) },
    projectLeases: {
      tryAcquire: (input: { projectId: string; ownerId: string }) => {
        if (leases.has(input.projectId)) return false;
        leases.set(input.projectId, input.ownerId);
        return true;
      },
      get: (projectId: string) => {
        const ownerId = leases.get(projectId);
        return ownerId === undefined ? null : { ownerId };
      },
      release: (projectId: string, ownerId: string) => {
        if (leases.get(projectId) !== ownerId) return false;
        leases.delete(projectId);
        return true;
      },
      releaseAll: (ownerId: string) => {
        let released = 0;
        for (const [projectId, currentOwner] of leases) {
          if (currentOwner === ownerId) {
            leases.delete(projectId);
            released += 1;
          }
        }
        return released;
      }
    },
    agentMessages: emptyQueue,
    agentSpawns: {
      ...emptyQueue,
      materializeNode: () => ({}),
      markRunning: () => ({ spawn: {}, canvasEvent: null }),
      markFailed: () => ({ spawn: {}, canvasEvent: null })
    },
    agentLifecycle: {
      ...emptyQueue,
      apply: () => ({}),
      markApplied: () => undefined,
      markFailed: () => undefined
    },
    artifacts: {
      claimNextCanvasEvent: () => null,
      markCanvasEventPublished: () => undefined
    },
    notes: {
      claimNextCanvasEvent: () => null,
      markCanvasEventPublished: () => undefined
    },
    connections: {
      claimNextCanvasEvent: () => null,
      markCanvasEventPublished: () => undefined
    },
    activity: { prime: () => undefined, pull: () => [] },
    observeActivity: () => () => undefined,
    startAgent: async () => ({ id: "session-1" }),
    restartAgent: async () => ({ id: "session-1" }),
    publishAgentSpawn: () => undefined,
    publishAgentLifecycle: () => undefined,
    publishArtifact: () => undefined,
    publishNote: () => undefined,
    publishConnection: () => undefined,
    publishActivity: () => undefined
  } as unknown as CompassoRuntimeServices;
}
