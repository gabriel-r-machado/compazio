import { describe, expect, it, vi } from "vitest";

import type { AgentAdapter } from "@forgedeck/agent-sdk";
import type { CanvasHandoff, CanvasSnapshot } from "@forgedeck/schemas";

import { HandoffService } from "./handoff-service";

describe("HandoffService", () => {
  it("derives mission, roles and contract from the saved canvas and redacts them", () => {
    const fixture = createFixture();
    const service = new HandoffService(fixture.dependencies);

    service.createDraft({
      canvasId: "canvas-1",
      sourceNodeId: "source",
      targetNodeId: "target",
      edgeId: "edge-1"
    });

    expect(fixture.store.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        mission: "Deliver with token=[REDACTED]",
        source: expect.objectContaining({
          role: expect.objectContaining({ constraints: "api_key=[REDACTED]" })
        }),
        edge: expect.objectContaining({
          contract: expect.objectContaining({ handoffMode: "manual" })
        })
      })
    );
  });

  it("marks delivery only after the adapter submits and detects a response", async () => {
    const fixture = createFixture();
    const ready = handoff("ready", 3);
    fixture.store.get.mockReturnValue(ready);
    fixture.store.beginDelivery.mockReturnValue(handoff("submitting", 4, "attempt-1"));
    fixture.store.markWrittenToTerminal.mockReturnValue(
      handoff("written_to_terminal", 5, "attempt-1", "written_to_terminal")
    );
    fixture.store.markSubmittedToAgent.mockReturnValue(
      handoff("submitted_to_agent", 6, "attempt-1", "submitted_to_agent")
    );
    fixture.store.markDelivered.mockReturnValue(
      handoff("delivered", 7, "attempt-1", "response_detected")
    );
    fixture.adapter.submitReviewedHandoff.mockImplementation(async (control, payload) => {
      expect(payload).toContain("COMPASSO");
      await control.write("inserted payload");
      await control.reportPhase("written_to_terminal");
      await control.write("\r");
      await control.reportPhase("submitted_to_agent");
      expect(fixture.store.markDelivered).not.toHaveBeenCalled();
      return { confirmation: "response_detected", responseSequence: 12 };
    });
    const service = new HandoffService(fixture.dependencies);

    const result = await service.deliver({ handoffId: ready.id, targetSessionId: "session-1" });

    expect(result.status).toBe("delivered");
    expect(fixture.store.beginDelivery).toHaveBeenCalledWith(ready.id, ready.revision, {
      targetSessionId: "session-1",
      adapterId: "codex"
    });
    expect(fixture.store.markWrittenToTerminal).toHaveBeenCalledWith(ready.id, 4, "attempt-1");
    expect(fixture.store.markSubmittedToAgent).toHaveBeenCalledWith(ready.id, 5, "attempt-1");
    expect(fixture.store.markDelivered).toHaveBeenCalledWith(ready.id, 6, "attempt-1");
    expect(fixture.terminal.write.mock.calls.map((call) => call[1])).toEqual([
      "inserted payload",
      "\r"
    ]);
  });

  it("does not mark a package delivered when adapter submission fails", async () => {
    const fixture = createFixture();
    const ready = handoff("ready", 3);
    fixture.store.get.mockReturnValue(ready);
    fixture.store.beginDelivery.mockReturnValue(handoff("submitting", 4, "attempt-1"));
    fixture.store.markWrittenToTerminal.mockReturnValue(
      handoff("written_to_terminal", 5, "attempt-1", "written_to_terminal")
    );
    fixture.adapter.submitReviewedHandoff.mockImplementation(async (control) => {
      await control.write("inserted payload");
      await control.reportPhase("written_to_terminal");
      throw new Error("token=very-secret-value");
    });
    fixture.store.markFailed.mockReturnValue(handoff("failed", 6, "attempt-1", "failed"));
    const service = new HandoffService(fixture.dependencies);

    await expect(
      service.deliver({ handoffId: ready.id, targetSessionId: "session-1" })
    ).rejects.toThrow("token=[REDACTED]");

    expect(fixture.store.markDelivered).not.toHaveBeenCalled();
    expect(fixture.store.markFailed).toHaveBeenCalledWith(
      ready.id,
      5,
      "attempt-1",
      "token=[REDACTED]"
    );
  });

  it("keeps a submitted handoff recoverable when adapter confirmation times out", async () => {
    const fixture = createFixture();
    const ready = handoff("ready", 3);
    fixture.store.get.mockReturnValue(ready);
    fixture.store.beginDelivery.mockReturnValue(handoff("submitting", 4, "attempt-1"));
    fixture.store.markWrittenToTerminal.mockReturnValue(
      handoff("written_to_terminal", 5, "attempt-1", "written_to_terminal")
    );
    fixture.store.markSubmittedToAgent.mockReturnValue(
      handoff("submitted_to_agent", 6, "attempt-1", "submitted_to_agent")
    );
    fixture.adapter.submitReviewedHandoff.mockImplementation(async (control) => {
      await control.reportPhase("written_to_terminal");
      await control.reportPhase("submitted_to_agent");
      throw new Error("The adapter did not confirm a response after submitting the handoff");
    });
    fixture.store.markDeliveryUnknown.mockReturnValue(
      handoff("delivery_unknown", 7, "attempt-1", "delivery_unknown")
    );
    const service = new HandoffService(fixture.dependencies);

    await expect(
      service.deliver({ handoffId: ready.id, targetSessionId: "session-1" })
    ).rejects.toThrow("did not confirm");

    expect(fixture.store.markDeliveryUnknown).toHaveBeenCalledWith(
      ready.id,
      6,
      "attempt-1",
      "The adapter did not confirm a response after submitting the handoff"
    );
    expect(fixture.store.markFailed).not.toHaveBeenCalled();
  });

  it("blocks a double click while a single adapter submission is in flight", async () => {
    const fixture = createFixture();
    const ready = handoff("ready", 3);
    fixture.store.get.mockReturnValue(ready);
    fixture.store.beginDelivery.mockReturnValue(handoff("submitting", 4, "attempt-1"));
    fixture.store.markWrittenToTerminal.mockReturnValue(
      handoff("written_to_terminal", 5, "attempt-1", "written_to_terminal")
    );
    fixture.store.markSubmittedToAgent.mockReturnValue(
      handoff("submitted_to_agent", 6, "attempt-1", "submitted_to_agent")
    );
    fixture.store.markDelivered.mockReturnValue(
      handoff("delivered", 7, "attempt-1", "response_detected")
    );
    let resolveSubmission = (_value: {
      confirmation: "response_detected";
      responseSequence: number;
    }): void => {
      void _value;
      throw new Error("Submission resolver was not initialized");
    };
    fixture.adapter.submitReviewedHandoff.mockImplementation(async (control) => {
      await control.reportPhase("written_to_terminal");
      await control.reportPhase("submitted_to_agent");
      return new Promise((resolve) => {
        resolveSubmission = resolve;
      });
    });
    const service = new HandoffService(fixture.dependencies);

    const first = service.deliver({ handoffId: ready.id, targetSessionId: "session-1" });
    await expect(
      service.deliver({ handoffId: ready.id, targetSessionId: "session-1" })
    ).rejects.toThrow("already being submitted");
    resolveSubmission({ confirmation: "response_detected", responseSequence: 12 });
    await expect(first).resolves.toMatchObject({ status: "delivered" });
    expect(fixture.adapter.submitReviewedHandoff).toHaveBeenCalledTimes(1);
  });

  it("does not start delivery when the renderer names a session from another project", async () => {
    const fixture = createFixture();
    const ready = handoff("ready", 3);
    fixture.store.get.mockReturnValue(ready);
    fixture.sessions.get.mockReturnValue({ projectId: "other-project", adapterId: "codex" });
    const service = new HandoffService(fixture.dependencies);

    await expect(
      service.deliver({ handoffId: ready.id, targetSessionId: "session-1" })
    ).rejects.toThrow("different project");
    expect(fixture.store.beginDelivery).not.toHaveBeenCalled();
  });

  it("keeps an approved package awaiting an explicitly started destination session", async () => {
    const fixture = createFixture();
    const ready = handoff("ready", 3);
    fixture.store.get.mockReturnValue(ready);
    fixture.terminal.getSession.mockReturnValue({ state: "cancelled" });
    fixture.store.markAwaitingDestination.mockReturnValue(handoff("awaiting_destination", 4));
    const service = new HandoffService(fixture.dependencies);

    const result = await service.deliver({ handoffId: ready.id, targetSessionId: "session-1" });

    expect(result.status).toBe("awaiting_destination");
    expect(fixture.store.markAwaitingDestination).toHaveBeenCalledWith(
      ready.id,
      ready.revision,
      "Target terminal session is not active"
    );
    expect(fixture.adapter.submitReviewedHandoff).not.toHaveBeenCalled();
    expect(fixture.store.beginDelivery).not.toHaveBeenCalled();
  });

  it("records a local-user manual delivery decision only for delivery_unknown", () => {
    const fixture = createFixture();
    const unknown = handoff("delivery_unknown", 8, "attempt-2", "delivery_unknown");
    fixture.store.get.mockReturnValue(unknown);
    fixture.store.markSentManually.mockReturnValue(
      handoff("delivered", 9, "attempt-2", "manually_marked_sent")
    );
    const service = new HandoffService(fixture.dependencies);

    const result = service.markSent({
      handoffId: unknown.id,
      revision: unknown.revision,
      deliveryAttemptId: "attempt-2"
    });

    expect(result.status).toBe("delivered");
    expect(fixture.store.markSentManually).toHaveBeenCalledWith(
      unknown.id,
      unknown.revision,
      "attempt-2"
    );
  });

  it("cancels a recovery without deleting the reviewed package", () => {
    const fixture = createFixture();
    const unknown = handoff("delivery_unknown", 8, "attempt-2", "delivery_unknown");
    fixture.store.get.mockReturnValue(unknown);
    fixture.store.cancelDelivery.mockReturnValue(handoff("cancelled", 9, "attempt-2", "cancelled"));
    const service = new HandoffService(fixture.dependencies);

    const result = service.cancelDelivery({ handoffId: unknown.id, revision: unknown.revision });

    expect(result.content).toEqual(unknown.content);
    expect(fixture.store.cancelDelivery).toHaveBeenCalledWith(unknown.id, unknown.revision);
  });
});

function createFixture() {
  const store = {
    createDraft: vi.fn(() => handoff("draft", 1)),
    get: vi.fn((): CanvasHandoff | null => null),
    listByCanvas: vi.fn(() => []),
    listEvents: vi.fn(() => []),
    updateDraft: vi.fn(() => handoff("draft", 2)),
    markReady: vi.fn(() => handoff("ready", 3)),
    beginDelivery: vi.fn(() => handoff("submitting", 4, "attempt-1")),
    markWrittenToTerminal: vi.fn(() => handoff("written_to_terminal", 5, "attempt-1")),
    markSubmittedToAgent: vi.fn(() => handoff("submitted_to_agent", 6, "attempt-1")),
    markDelivered: vi.fn(() => handoff("delivered", 7, "attempt-1")),
    markAwaitingDestination: vi.fn(() => handoff("awaiting_destination", 4)),
    markSentManually: vi.fn(() => handoff("delivered", 7, "attempt-1", "manually_marked_sent")),
    cancelDelivery: vi.fn(() => handoff("cancelled", 7, "attempt-1", "cancelled")),
    markDeliveryUnknown: vi.fn(() =>
      handoff("delivery_unknown", 7, "attempt-1", "delivery_unknown")
    ),
    markFailed: vi.fn(() => handoff("failed", 5, "attempt-1")),
    requestRetry: vi.fn(() => handoff("ready", 6))
  };
  const sessions = {
    get: vi.fn(() => ({ projectId: "project-1", adapterId: "codex" as const }))
  };
  const terminal = {
    getSession: vi.fn(() => ({ state: "running" })),
    getBufferSnapshot: vi.fn(() => ({ data: "\u203a", sequence: 10 })),
    write: vi.fn(async (sessionId: string, data: string) => {
      void sessionId;
      void data;
    })
  };
  const policy = { assertAllowed: vi.fn() };
  const submitReviewedHandoff = vi.fn<AgentAdapter["submitReviewedHandoff"]>();
  const adapter: AgentAdapter & { readonly submitReviewedHandoff: typeof submitReviewedHandoff } = {
    manifest: {
      id: "codex",
      displayName: "Codex",
      version: "1",
      executables: ["codex"],
      platforms: ["win32"],
      capabilities: {
        interactive: true,
        nonInteractive: true,
        resume: true,
        structuredOutput: false,
        mcp: false,
        imageInput: false,
        messageQueue: false
      },
      permissions: []
    },
    detect: async () => ({ available: false, executable: null, version: null, issue: null }),
    validateAuth: async () => ({ authenticated: true, issue: null }),
    buildLaunch: async () => {
      throw new Error("not used");
    },
    parseOutput: (_chunk, state) => ({ outputs: [], state }),
    encodeMessage: (message) => message.content,
    sendMessage: async () => undefined,
    isReadyForReviewedHandoff: vi.fn(() => true),
    submitReviewedHandoff,
    requestStop: async () => undefined,
    forceKill: async () => undefined
  };
  return {
    store,
    sessions,
    terminal,
    adapter,
    dependencies: {
      store,
      canvases: { load: vi.fn(() => canvas()) },
      workspaces: {
        list: vi.fn(() => [{ id: "workspace-1", canvasId: "canvas-1", projectId: "project-1" }])
      },
      sessions,
      terminal,
      adapters: { get: vi.fn(() => adapter) },
      policy
    }
  };
}

function canvas(): CanvasSnapshot {
  return {
    id: "canvas-1",
    title: "Main",
    mission: "Deliver with token=very-secret-value",
    creationMode: "manual",
    executionProfile: "balanced",
    revision: 2,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "source",
        type: "agent",
        position: { x: 0, y: 0 },
        data: nodeData("Implementer", "api_key=very-secret-value")
      },
      {
        id: "target",
        type: "agent",
        position: { x: 400, y: 0 },
        data: nodeData("Reviewer", "Do not expand permissions")
      }
    ],
    edges: [
      {
        id: "edge-1",
        source: "source",
        target: "target",
        contract: {
          schemaVersion: "1.0",
          kind: "handoff",
          label: "Review",
          requiredEvidenceTypes: ["test"],
          handoffMode: "after-success",
          sourceDeliverable: "Implementation",
          targetInstruction: "Review it"
        }
      }
    ]
  };
}

function nodeData(title: string, constraints: string) {
  return {
    title,
    state: "idle" as const,
    summary: "",
    retryMaxAttempts: 1,
    permissions: [],
    role: role(title, constraints)
  };
}

function handoff(
  status: CanvasHandoff["status"],
  revision: number,
  attemptId?: string,
  attemptStatus: CanvasHandoff["deliveryAttempts"][number]["status"] = "submitting"
): CanvasHandoff {
  return {
    id: "handoff-1",
    canvasId: "canvas-1",
    projectId: "project-1",
    status,
    revision,
    mission: "Deliver the feature",
    source: { nodeId: "source", title: "Implementer", role: role("Implementer") },
    target: { nodeId: "target", title: "Reviewer", role: role("Reviewer") },
    edge: {
      edgeId: "edge-1",
      contract: {
        schemaVersion: "1.0",
        kind: "handoff",
        label: "Review",
        requiredEvidenceTypes: ["test"],
        handoffMode: "manual",
        sourceDeliverable: "Implementation",
        targetInstruction: "Review against the mission"
      }
    },
    content: {
      summary: "Completed FORGEDECK_TEST_SECRET_demo",
      completedWork: ["Implemented"],
      decisions: ["Kept IPC typed"],
      evidence: [{ label: "Tests", detail: "Passed" }],
      openQuestions: [],
      risks: []
    },
    error: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    readyAt: status === "draft" ? null : "2026-07-19T12:01:00.000Z",
    deliveredAt: status === "delivered" ? "2026-07-19T12:02:00.000Z" : null,
    deliveryAttempts:
      attemptId === undefined
        ? []
        : [
            {
              id: attemptId,
              handoffId: "handoff-1",
              sequence: 1,
              targetSessionId: "session-1",
              adapterId: "codex",
              status: attemptStatus,
              confirmation: attemptStatus === "response_detected" ? "response_detected" : null,
              error: null,
              responsible: "system",
              createdAt: "2026-07-19T12:01:00.000Z",
              updatedAt: "2026-07-19T12:01:00.000Z"
            }
          ]
  };
}

function role(name: string, constraints = "Do not expand permissions") {
  return {
    name,
    responsibilities: "Complete the role",
    constraints,
    expectedDeliverable: "Structured delivery",
    completionCriteria: "Evidence exists"
  };
}
