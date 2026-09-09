import { canvasSnapshotSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type { AgentRuntimeCapability, CanvasSnapshot, WorkflowDraft } from "@forgedeck/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OrchestratorSessionService,
  WORKFLOW_COMPOSITION_TIMEOUTS,
  type OrchestratorLaunchRequest
} from "./orchestrator-session-service";

function capability(overrides: Partial<AgentRuntimeCapability>): AgentRuntimeCapability {
  return {
    runtimeId: "claude-code",
    provider: "claude-code",
    displayName: "Claude Code",
    installed: true,
    authenticated: true,
    enabled: true,
    supportsParallelSessions: true,
    maxConcurrentSessions: 4,
    activeSessions: 0,
    availableModels: [],
    capabilities: ["code", "interactive"],
    lastCheckedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  };
}

const claude = capability({ runtimeId: "claude-code", provider: "claude-code" });
const codex = capability({ runtimeId: "codex", provider: "codex", displayName: "Codex" });
const codexUnauthenticated = capability({
  runtimeId: "codex",
  provider: "codex",
  displayName: "Codex",
  authenticated: false
});

function emptyCanvas(): CanvasSnapshot {
  return canvasSnapshotSchema.parse({
    id: "canvas-1",
    title: "Canvas",
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    creationMode: "automatic",
    executionProfile: "balanced",
    nodes: [],
    edges: []
  });
}

function plannedDraft(): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "88888888-8888-4888-8888-888888888888",
    version: 0,
    workspaceId: "w1",
    sourceTerminalId: "planner",
    creationMode: "automatic",
    executionProfile: "balanced",
    state: "ready",
    title: "Landing page premium",
    objective: "criar uma landing page premium",
    nodes: [{ id: "implementation", title: "Implementar", role: "implementer" }],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z"
  });
}

class FakeLauncher {
  public readonly launched: OrchestratorLaunchRequest[] = [];
  public readonly writes: { sessionId: string; data: string }[] = [];
  public readonly cancellations: string[] = [];
  private counter = 0;

  launch(request: OrchestratorLaunchRequest): Promise<{ sessionId: string }> {
    this.launched.push(request);
    this.counter += 1;
    return Promise.resolve({ sessionId: `session-${this.counter}` });
  }

  write(sessionId: string, data: string): Promise<void> {
    this.writes.push({ sessionId, data });
    return Promise.resolve();
  }

  cancel(sessionId: string): Promise<void> {
    this.cancellations.push(sessionId);
    return Promise.resolve();
  }
}

function service(launcher: FakeLauncher, capabilities: readonly AgentRuntimeCapability[]) {
  return new OrchestratorSessionService({
    launcher,
    loadCapabilities: () => Promise.resolve(capabilities)
  });
}

describe("OrchestratorSessionService.start", () => {
  let launcher: FakeLauncher;
  beforeEach(() => {
    launcher = new FakeLauncher();
  });

  it("launches a real session for the chosen usable runtime and marks it orchestrator-capable", async () => {
    const svc = service(launcher, [claude]);
    const result = await svc.start({
      projectId: "p1",
      workspaceId: "w1",
      preferredRuntimeId: "claude-code"
    });
    expect(launcher.launched).toEqual([
      { projectId: "p1", workspaceId: "w1", adapterId: "claude-code" }
    ]);
    expect(result.runtimeId).toBe("claude-code");
    expect(result.state).toBe("orchestrator_starting");
    expect(svc.isOrchestratorSession(result.sessionId)).toBe(true);
  });

  it("auto-selects the strongest usable runtime when none is preferred", async () => {
    const svc = service(launcher, [codex, claude]);
    const result = await svc.start({ projectId: "p1", workspaceId: "w1" });
    expect(result.runtimeId).toBe("claude-code");
  });

  it("returns the same in-flight workspace composition on a repeated start", async () => {
    const svc = service(launcher, [claude]);
    const first = await svc.start({ projectId: "p1", workspaceId: "w1" });
    const second = await svc.start({ projectId: "p1", workspaceId: "w1" });

    expect(second.sessionId).toBe(first.sessionId);
    expect(launcher.launched).toHaveLength(1);
  });

  it("refuses to start when no runtime is installed and authenticated (§18.1)", async () => {
    const svc = service(launcher, [codexUnauthenticated]);
    await expect(svc.start({ projectId: "p1", workspaceId: "w1" })).rejects.toThrow(
      /no .*runtime|install|authenticat/i
    );
    expect(launcher.launched).toEqual([]);
  });

  it("refuses a preferred runtime that is not usable, instead of inventing it", async () => {
    const svc = service(launcher, [claude]);
    await expect(
      svc.start({ projectId: "p1", workspaceId: "w1", preferredRuntimeId: "codex" })
    ).rejects.toThrow(/codex/i);
    expect(launcher.launched).toEqual([]);
  });
});

describe("OrchestratorSessionService.sendObjective", () => {
  let launcher: FakeLauncher;
  beforeEach(() => {
    launcher = new FakeLauncher();
  });

  it("writes the primed prompt (skill + objective) to the real session", async () => {
    const svc = service(launcher, [claude]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "criar uma landing page premium",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });
    const write = launcher.writes.at(-1);
    expect(write?.sessionId).toBe(started.sessionId);
    expect(write?.data).toContain("criar uma landing page premium");
    expect(write?.data).toContain("COMPASSO_DRAFT:");
    expect(write?.data).toContain("Claude Code");
  });

  it("invariant 1: different objectives write different session input", async () => {
    const svc = service(launcher, [claude]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "landing page de vendas",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "corrigir bug de autenticação",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });
    expect(launcher.writes[0]?.data).not.toBe(launcher.writes[1]?.data);
  });

  it("invariant 3: never offers an unusable runtime to the session", async () => {
    const svc = service(launcher, [claude, codexUnauthenticated]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "objetivo",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });
    expect(launcher.writes.at(-1)?.data).not.toContain("Codex");
  });

  it("rejects sending to an unknown session", async () => {
    const svc = service(launcher, [claude]);
    await expect(
      svc.sendObjective({
        sessionId: "ghost",
        objective: "x",
        canvas: emptyCanvas(),
        executionProfile: "balanced"
      })
    ).rejects.toThrow(/session/i);
  });

  it("propagates the empty-objective guard from the prompt builder", async () => {
    const svc = service(launcher, [claude]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await expect(
      svc.sendObjective({
        sessionId: started.sessionId,
        objective: "   ",
        canvas: emptyCanvas(),
        executionProfile: "balanced"
      })
    ).rejects.toThrow(/objective/i);
  });

  it("uses the verified planning transport instead of waiting for interactive terminal prose", async () => {
    const compose = vi.fn().mockResolvedValue(plannedDraft());
    const svc = new OrchestratorSessionService({
      launcher,
      loadCapabilities: () => Promise.resolve([claude]),
      planner: { compose }
    });
    const received: WorkflowDraft[] = [];
    svc.onWorkflowDraft((_sessionId, draft) => {
      received.push(draft);
    });
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });

    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "criar uma landing page premium",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });

    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        runtimeId: "claude-code",
        objective: "criar uma landing page premium",
        canvas: emptyCanvas()
      })
    );
    expect(launcher.writes).toEqual([]);
    expect(received).toEqual([plannedDraft()]);
  });

  it("waits for a valid three-minute plan instead of failing at the former two-minute limit", async () => {
    vi.useFakeTimers();
    const compose = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<WorkflowDraft>((resolve) =>
            setTimeout(() => resolve(plannedDraft()), 3 * 60_000)
          )
      );
    const svc = new OrchestratorSessionService({
      launcher,
      loadCapabilities: () => Promise.resolve([claude]),
      planner: { compose }
    });
    const received: WorkflowDraft[] = [];
    svc.onWorkflowDraft((_sessionId, draft) => {
      received.push(draft);
    });
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    const planning = svc.sendObjective({
      sessionId: started.sessionId,
      objective: "criar uma landing page premium",
      canvas: emptyCanvas(),
      executionProfile: "balanced",
      reuseRecentPlan: true
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await planning;

    expect(compose).toHaveBeenCalledWith(expect.objectContaining({ reuseRecentPlan: true }));
    expect(received).toEqual([plannedDraft()]);
    expect(svc.getComposition(started.sessionId)?.status).not.toBe("failed");
    vi.useRealTimers();
  });
});

describe("OrchestratorSessionService composition lifecycle", () => {
  let launcher: FakeLauncher;

  beforeEach(() => {
    launcher = new FakeLauncher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails visibly when a terminal exits without a schema-valid workflow", async () => {
    const svc = service(launcher, [claude]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "criar uma landing page premium",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });

    svc.onTerminalState(started.sessionId, "succeeded");

    expect(svc.getComposition(started.sessionId)).toMatchObject({
      status: "failed",
      error: { code: "NO_VALID_WORKFLOW", retryable: true }
    });
  });

  it("times out a hanging composition, cancels its process and offers retry", async () => {
    vi.useFakeTimers();
    const svc = service(launcher, [claude]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "criar uma landing page premium",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });

    await vi.advanceTimersByTimeAsync(WORKFLOW_COMPOSITION_TIMEOUTS.composeWorkflow);

    expect(svc.getComposition(started.sessionId)).toMatchObject({
      status: "failed",
      error: { code: "COMPOSITION_TIMEOUT", retryable: true }
    });
    expect(launcher.cancellations).toContain(started.sessionId);
  });

  it("cancels an active composition exactly once and leaves a retryable terminal state", async () => {
    const svc = service(launcher, [claude]);
    const started = await svc.start({ projectId: "p1", workspaceId: "w1" });
    await svc.sendObjective({
      sessionId: started.sessionId,
      objective: "criar uma landing page premium",
      canvas: emptyCanvas(),
      executionProfile: "balanced"
    });

    await svc.cancel(started.sessionId);

    expect(launcher.cancellations).toEqual([started.sessionId]);
    expect(svc.getComposition(started.sessionId)).toMatchObject({ status: "cancelled" });
  });
});
