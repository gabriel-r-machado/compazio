import { describe, expect, it, vi } from "vitest";

import type { CanvasHandoff } from "@forgedeck/schemas";

import {
  handleAwaitDestination,
  handleCancelDelivery,
  handleCreateDraft,
  handleDeliver,
  handleMarkSent
} from "./handoff-ipc";

describe("handoff IPC handlers", () => {
  it("rejects renderer-controlled process and path fields", () => {
    const service = serviceDouble();
    expect(() =>
      handleCreateDraft(service, {
        canvasId: "canvas-1",
        sourceNodeId: "source",
        targetNodeId: "target",
        edgeId: "edge-1",
        executable: "cmd.exe",
        args: ["/c", "whoami"],
        cwd: "C:/private"
      })
    ).toThrow();
    expect(service.createDraft).not.toHaveBeenCalled();
  });

  it("delivers with only handoff and target session identifiers", async () => {
    const service = serviceDouble();
    await expect(
      handleDeliver(service, {
        handoffId: "handoff-1",
        targetSessionId: "session-1",
        prompt: "untrusted"
      })
    ).rejects.toThrow();
    expect(service.deliver).not.toHaveBeenCalled();
  });

  it("allows only a handoff revision when waiting for an explicit destination", () => {
    const service = serviceDouble();
    handleAwaitDestination(service, { handoffId: "handoff-1", revision: 3 });
    expect(service.awaitDestination).toHaveBeenCalledWith({ handoffId: "handoff-1", revision: 3 });
  });

  it("keeps recovery actions typed and rejects additional renderer-controlled fields", () => {
    const service = serviceDouble();
    expect(() =>
      handleMarkSent(service, {
        handoffId: "handoff-1",
        revision: 3,
        deliveryAttemptId: "attempt-1",
        responsible: "system"
      })
    ).toThrow();
    expect(() =>
      handleCancelDelivery(service, {
        handoffId: "handoff-1",
        revision: 3,
        deleteHistory: true
      })
    ).toThrow();
    expect(service.markSent).not.toHaveBeenCalled();
    expect(service.cancelDelivery).not.toHaveBeenCalled();
  });
});

function serviceDouble() {
  const record: CanvasHandoff = {
    id: "handoff-1",
    canvasId: "canvas-1",
    projectId: "project-1",
    status: "awaiting_destination",
    revision: 3,
    mission: "Ship the reviewed change",
    source: { nodeId: "source", title: "Source", role: role("Source") },
    target: { nodeId: "target", title: "Target", role: role("Target") },
    edge: {
      edgeId: "edge-1",
      contract: {
        schemaVersion: "1.0",
        kind: "handoff",
        label: "Review",
        requiredEvidenceTypes: ["test"],
        handoffMode: "manual"
      }
    },
    content: {
      summary: "Approved package",
      completedWork: [],
      decisions: [],
      evidence: [],
      openQuestions: [],
      risks: []
    },
    error: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    readyAt: "2026-07-19T12:01:00.000Z",
    deliveredAt: null,
    deliveryAttempts: []
  };
  return {
    createDraft: vi.fn(() => record),
    updateDraft: vi.fn(() => record),
    markReady: vi.fn(() => record),
    deliver: vi.fn(async () => record),
    awaitDestination: vi.fn(() => record),
    retry: vi.fn(async () => record),
    markSent: vi.fn(() => record),
    cancelDelivery: vi.fn(() => record),
    list: vi.fn(() => []),
    listEvents: vi.fn(() => [])
  };
}

function role(name: string) {
  return {
    name,
    responsibilities: "Do the assigned work",
    constraints: "Stay in project",
    expectedDeliverable: "Reviewed package",
    completionCriteria: "Evidence is included"
  };
}
