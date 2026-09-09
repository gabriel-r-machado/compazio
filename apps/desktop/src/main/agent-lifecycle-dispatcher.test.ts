import { describe, expect, it, vi } from "vitest";

import type { AgentLifecycleCanvasEvent, AgentLifecycleCommand } from "@forgedeck/schemas";

import {
  AgentLifecycleDispatcher,
  type AgentLifecycleDispatcherServices
} from "./agent-lifecycle-dispatcher";

function command(overrides: Partial<AgentLifecycleCommand> = {}): AgentLifecycleCommand {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-1",
    canvasId: "canvas-1",
    projectId: "00000000-0000-4000-8000-0000000000ff",
    targetNodeId: "reviewer",
    action: "remove",
    role: null,
    requestedByNodeId: "planner",
    status: "applying",
    idempotencyKey: "command-1",
    sessionId: "00000000-0000-4000-8000-0000000000aa",
    errorCode: null,
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides
  };
}

function canvasEvent(applied: AgentLifecycleCommand): AgentLifecycleCanvasEvent {
  return {
    command: applied,
    node: null,
    removedNodeId: applied.targetNodeId,
    canvasRevision: 2
  };
}

function harness(
  commands: AgentLifecycleCommand[],
  overrides: Partial<AgentLifecycleDispatcherServices> = {}
) {
  const order: string[] = [];
  const store = {
    claimNext: vi.fn(() => commands.shift() ?? null),
    apply: vi.fn((id: string) => {
      order.push("apply");
      return canvasEvent(command({ id }));
    }),
    markApplied: vi.fn(() => {
      order.push("markApplied");
    }),
    markFailed: vi.fn((_id: string, code: string) => {
      order.push(`markFailed:${code}`);
    })
  };
  const services = {
    store,
    stopAgent: vi.fn(async () => {
      order.push("stopAgent");
    }),
    restartAgent: vi.fn(async () => {
      order.push("restartAgent");
      return { id: "session-2" };
    }),
    releaseSessionContext: vi.fn(() => {
      order.push("releaseSessionContext");
    }),
    publish: vi.fn(() => {
      order.push("publish");
    }),
    ...overrides
  };
  return { dispatcher: new AgentLifecycleDispatcher(services), services, store, order };
}

describe("AgentLifecycleDispatcher", () => {
  it("stops the terminal before the node disappears, so no agent outlives its node", async () => {
    const { dispatcher, order } = harness([command()]);

    await dispatcher.drain();

    expect(order).toEqual([
      "stopAgent",
      "releaseSessionContext",
      "apply",
      "publish",
      "markApplied"
    ]);
  });

  it("restarts a reassigned agent after the new responsibility is recorded", async () => {
    const { dispatcher, order, services } = harness([
      command({
        action: "assign_role",
        role: {
          name: "Testador",
          responsibilities: "Escrever cobertura",
          constraints: "",
          expectedDeliverable: "",
          completionCriteria: ""
        }
      })
    ]);

    await dispatcher.drain();

    // Recorded and drawn first, then restarted: the process picks the role up from the canvas.
    expect(order).toEqual([
      "stopAgent",
      "releaseSessionContext",
      "apply",
      "publish",
      "restartAgent",
      "markApplied"
    ]);
    expect(services.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("never touches the canvas when the terminal could not be stopped", async () => {
    const { dispatcher, store, order } = harness([command()], {
      stopAgent: vi.fn(async () => {
        throw new Error("pty is wedged");
      })
    });

    await dispatcher.drain();

    expect(store.apply).not.toHaveBeenCalled();
    expect(order).toEqual(["markFailed:agent_stop_failed"]);
  });

  it("reports which half of a reassignment broke when the restart fails", async () => {
    const { dispatcher, store } = harness([command({ action: "assign_role" })], {
      restartAgent: vi.fn(async () => {
        throw new Error("agent is gone");
      })
    });

    await dispatcher.drain();

    // The role did land, so the error names the restart rather than claiming nothing happened.
    expect(store.apply).toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalledWith(expect.any(String), "agent_restart_failed");
    expect(store.markApplied).not.toHaveBeenCalled();
  });

  it("brings a restarted terminal back after stopping it", async () => {
    const { dispatcher, order, services } = harness([command({ action: "restart" })]);

    await dispatcher.drain();

    expect(order).toEqual([
      "stopAgent",
      "releaseSessionContext",
      "apply",
      "publish",
      "restartAgent",
      "markApplied"
    ]);
    expect(services.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("applies a command for an agent with no running terminal", async () => {
    const { dispatcher, services, store } = harness([command({ sessionId: null })]);

    await dispatcher.drain();

    expect(services.stopAgent).not.toHaveBeenCalled();
    expect(store.markApplied).toHaveBeenCalled();
  });

  it("applies commands one at a time, since two can target the same terminal", async () => {
    let concurrent = 0;
    let peak = 0;
    const { dispatcher } = harness(
      [
        command({ id: "00000000-0000-4000-8000-00000000000a" }),
        command({ id: "00000000-0000-4000-8000-00000000000b" })
      ],
      {
        stopAgent: vi.fn(async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await Promise.resolve();
          concurrent -= 1;
        })
      }
    );

    await dispatcher.drain();

    expect(peak).toBe(1);
  });
});
