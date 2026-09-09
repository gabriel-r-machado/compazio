import { workflowDraftSchema, workflowNodeDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft, WorkflowEdgeDraft } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { planActivation } from "./activation-planner";

function node(id: string, resolved: string | null = "claude-code") {
  return workflowNodeDraftSchema.parse({
    id,
    title: id,
    role: "implementer",
    runtimeRequirement: { resolvedRuntimeId: resolved }
  });
}

function edge(from: string, to: string): WorkflowEdgeDraft {
  return {
    id: `${from}__${to}`,
    sourceNodeId: from,
    targetNodeId: to,
    type: "handoff",
    contract: { requiredArtifacts: [], requiredEvidence: [], completionCondition: "" }
  };
}

function draft(nodes: string[], edges: WorkflowEdgeDraft[] = []): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "22222222-2222-4222-8222-222222222222",
    version: 1,
    workspaceId: "w1",
    sourceTerminalId: "s1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "T",
    objective: "obj",
    state: "approved",
    nodes: nodes.map((id) => node(id)),
    edges,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z"
  });
}

describe("planActivation", () => {
  it("dispatches only dependency-free nodes first (handoff chain order)", () => {
    const plan = planActivation({
      draft: draft(["ux", "fe", "qa"], [edge("ux", "fe"), edge("fe", "qa")]),
      maxConcurrentAgents: 3
    });
    expect(plan.ready).toEqual(["ux"]);
    expect(plan.blocked).toEqual(["fe", "qa"]);
    expect(plan.done).toBe(false);
  });

  it("unblocks the next node once its predecessor completes", () => {
    const plan = planActivation({
      draft: draft(["ux", "fe", "qa"], [edge("ux", "fe"), edge("fe", "qa")]),
      maxConcurrentAgents: 3,
      completedNodeIds: ["ux"]
    });
    expect(plan.ready).toEqual(["fe"]);
  });

  it("caps the batch by free concurrency slots", () => {
    const plan = planActivation({
      draft: draft(["a", "b", "c", "d"]),
      maxConcurrentAgents: 2,
      runningNodeIds: []
    });
    expect(plan.ready).toEqual(["a", "b"]);
  });

  it("accounts for already-running nodes when counting slots", () => {
    const plan = planActivation({
      draft: draft(["a", "b", "c"]),
      maxConcurrentAgents: 2,
      runningNodeIds: ["a"]
    });
    expect(plan.ready).toEqual(["b"]);
  });

  it("never dispatches a node without a resolved runtime", () => {
    const custom = draft(["a"]);
    const withUnresolved = workflowDraftSchema.parse({
      ...custom,
      nodes: [node("a", null)]
    });
    const plan = planActivation({ draft: withUnresolved, maxConcurrentAgents: 3 });
    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toEqual(["a"]);
  });

  it("reports done when all nodes are completed", () => {
    const plan = planActivation({
      draft: draft(["a", "b"]),
      maxConcurrentAgents: 3,
      completedNodeIds: ["a", "b"]
    });
    expect(plan.ready).toEqual([]);
    expect(plan.done).toBe(true);
  });
});
