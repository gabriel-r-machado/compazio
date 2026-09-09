import { canvasSnapshotSchema } from "@forgedeck/schemas";
import type { CanvasSnapshot } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { OrchestratorDraftDriver } from "./orchestrator-draft-driver";
import { registerOrchestratorSessionIpc } from "./orchestrator-session-ipc";
import { OrchestratorSessionService } from "./orchestrator-session-service";

const claude = {
  runtimeId: "claude-code",
  provider: "claude-code" as const,
  displayName: "Claude Code",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsParallelSessions: true,
  maxConcurrentSessions: 4,
  activeSessions: 0,
  availableModels: [],
  capabilities: ["code"],
  lastCheckedAt: "2026-07-23T00:00:00.000Z"
};

function canvas(): CanvasSnapshot {
  return canvasSnapshotSchema.parse({
    id: "c1",
    title: "Canvas",
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    creationMode: "automatic",
    executionProfile: "balanced",
    nodes: [],
    edges: []
  });
}

class FakeIpc {
  public readonly handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  handle(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown
  ): void {
    this.handlers.set(channel, (payload) =>
      Promise.resolve(handler({} as Electron.IpcMainInvokeEvent, payload))
    );
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  invoke(channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`No handler for ${channel}`);
    return handler(payload);
  }
}

class FakeLauncher {
  public readonly writes: { sessionId: string; data: string }[] = [];
  launch(): Promise<{ sessionId: string }> {
    return Promise.resolve({ sessionId: "session-1" });
  }
  write(sessionId: string, data: string): Promise<void> {
    this.writes.push({ sessionId, data });
    return Promise.resolve();
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

describe("registerOrchestratorSessionIpc", () => {
  function setup() {
    const launcher = new FakeLauncher();
    const service = new OrchestratorSessionService({
      launcher,
      loadCapabilities: () => Promise.resolve([claude])
    });
    const driver = new OrchestratorDraftDriver({
      store: {
        getById: () => null,
        getLatestForTerminal: () => null,
        persist: (draft) => ({ draft, lastEvent: null })
      },
      loadCapabilities: () => Promise.resolve([claude])
    });
    const ipc = new FakeIpc();
    registerOrchestratorSessionIpc(ipc, { service, driver, publishComposition: () => undefined });
    return { ipc, launcher, driver, service };
  }

  it("start launches a session and attaches the draft driver to it", async () => {
    const { ipc, driver } = setup();
    const response = await ipc.invoke("orchestrator-session:start", {
      projectId: "p1",
      workspaceId: "w1",
      executionProfile: "balanced",
      preferredRuntimeId: "claude-code"
    });
    expect(response).toMatchObject({
      sessionId: "session-1",
      runtimeId: "claude-code",
      state: "orchestrator_starting"
    });
    expect(driver.isAttached("session-1")).toBe(true);
  });

  it("send-objective writes the primed prompt to the session", async () => {
    const { ipc, launcher } = setup();
    await ipc.invoke("orchestrator-session:start", {
      projectId: "p1",
      workspaceId: "w1",
      executionProfile: "balanced"
    });
    const response = await ipc.invoke("orchestrator-session:send-objective", {
      sessionId: "session-1",
      objective: "criar uma landing page",
      executionProfile: "balanced",
      canvas: canvas()
    });
    expect(response).toEqual({ accepted: true });
    expect(launcher.writes.at(-1)?.data).toContain("criar uma landing page");
  });

  it("cancels the attached terminal composition through the typed IPC boundary", async () => {
    const { ipc, driver } = setup();
    await ipc.invoke("orchestrator-session:start", {
      projectId: "p1",
      workspaceId: "w1",
      executionProfile: "balanced"
    });

    const response = await ipc.invoke("orchestrator-session:cancel", { sessionId: "session-1" });

    expect(response).toMatchObject({ status: "cancelled", sessionId: "session-1" });
    expect(driver.isAttached("session-1")).toBe(false);
  });

  it("rejects an unusable preferred runtime through the channel", async () => {
    const { ipc } = setup();
    await expect(
      ipc.invoke("orchestrator-session:start", {
        projectId: "p1",
        workspaceId: "w1",
        executionProfile: "balanced",
        preferredRuntimeId: "codex"
      })
    ).rejects.toThrow(/codex/i);
  });
});
