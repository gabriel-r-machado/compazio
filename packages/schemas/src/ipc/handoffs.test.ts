import { describe, expect, it } from "vitest";

import {
  canTransitionCanvasHandoff,
  canvasHandoffSchema,
  handoffCreateDraftRequestSchema,
  handoffMarkReadyRequestSchema,
  handoffRetryRequestSchema
} from "./handoffs";

describe("canvas handoff schemas", () => {
  it("requires a reviewed summary before handoff_ready", () => {
    const result = handoffMarkReadyRequestSchema.safeParse({
      handoffId: "handoff-1",
      revision: 1,
      content: { summary: "   " }
    });

    expect(result.success).toBe(false);
  });

  it("rejects raw terminal output and process fields at the public boundary", () => {
    expect(
      handoffCreateDraftRequestSchema.safeParse({
        canvasId: "canvas-1",
        sourceNodeId: "source",
        targetNodeId: "target",
        edgeId: "edge-1",
        executable: "powershell.exe",
        args: ["-Command", "Get-ChildItem"],
        cwd: "C:\\private",
        rawOutput: "SECRET=value"
      }).success
    ).toBe(false);
  });

  it("does not allow raw output inside a persisted handoff", () => {
    const result = canvasHandoffSchema.safeParse({
      id: "handoff-1",
      canvasId: "canvas-1",
      projectId: "project-1",
      status: "draft",
      revision: 1,
      mission: "Ship the reviewed change",
      source: { nodeId: "source", title: "Implementer", role: role("Implementer") },
      target: { nodeId: "target", title: "Reviewer", role: role("Reviewer") },
      edge: {
        edgeId: "edge-1",
        contract: { schemaVersion: "1.0", kind: "handoff", handoffMode: "manual" }
      },
      content: { summary: "Draft", rawOutput: "do not persist" },
      error: null,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      readyAt: null,
      deliveredAt: null
    });

    expect(result.success).toBe(false);
  });

  it("permits only explicit lifecycle transitions", () => {
    expect(canTransitionCanvasHandoff("draft", "ready")).toBe(true);
    expect(canTransitionCanvasHandoff("ready", "submitting")).toBe(true);
    expect(canTransitionCanvasHandoff("submitting", "written_to_terminal")).toBe(true);
    expect(canTransitionCanvasHandoff("written_to_terminal", "submitted_to_agent")).toBe(true);
    expect(canTransitionCanvasHandoff("submitted_to_agent", "delivered")).toBe(true);
    expect(canTransitionCanvasHandoff("draft", "rejected")).toBe(true);
    expect(canTransitionCanvasHandoff("rejected", "draft")).toBe(true);
    expect(canTransitionCanvasHandoff("delivering", "delivery_unknown")).toBe(true);
    expect(canTransitionCanvasHandoff("written_to_terminal", "delivered")).toBe(false);
    expect(canTransitionCanvasHandoff("draft", "delivered")).toBe(false);
    expect(canTransitionCanvasHandoff("delivered", "ready")).toBe(false);
  });

  it("requires an optimistic revision for an explicit retry", () => {
    expect(
      handoffRetryRequestSchema.safeParse({ handoffId: "handoff-1", targetSessionId: "session-1" })
        .success
    ).toBe(false);
  });
});

function role(name: string) {
  return {
    name,
    responsibilities: "Do the assigned work",
    constraints: "Stay within the approved project",
    expectedDeliverable: "A reviewed package",
    completionCriteria: "Evidence is present"
  };
}
