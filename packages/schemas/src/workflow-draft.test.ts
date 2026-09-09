import { describe, expect, it } from "vitest";

import { EXECUTION_PROFILE_CONFIG, coerceLegacyExecutionProfile } from "./workflow-mode";
import {
  workflowDraftSchema,
  workflowNodeDraftSchema,
  workflowNodeDraftPatchSchema
} from "./workflow-draft";

function baseDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    version: 0,
    workspaceId: "ws-1",
    sourceTerminalId: "term-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    state: "composing",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides
  };
}

describe("execution profile presets", () => {
  it("matches the exact spec values for each profile", () => {
    expect(EXECUTION_PROFILE_CONFIG.economy.defaultParallelism).toBe(1);
    expect(EXECUTION_PROFILE_CONFIG.economy.duplicateRoleReduction).toBe(true);
    expect(EXECUTION_PROFILE_CONFIG.balanced.maxParallelism).toBe(3);
    expect(EXECUTION_PROFILE_CONFIG.balanced.reviewDepth).toBe("standard");
    expect(EXECUTION_PROFILE_CONFIG.maximum.maxParallelism).toBe(8);
    expect(EXECUTION_PROFILE_CONFIG.maximum.reviewDepth).toBe("independent_cross_review");
  });

  it("coerces the legacy token toggle into a modern profile", () => {
    expect(coerceLegacyExecutionProfile("economico")).toBe("economy");
    expect(coerceLegacyExecutionProfile("completo")).toBe("balanced");
    expect(coerceLegacyExecutionProfile("maximum")).toBe("maximum");
    expect(coerceLegacyExecutionProfile("nonsense")).toBe("balanced");
  });
});

describe("workflowNodeDraftSchema", () => {
  it("fills abstract defaults and leaves the runtime unresolved", () => {
    const node = workflowNodeDraftSchema.parse({
      id: "impl",
      title: "Implementer",
      role: "implementer"
    });
    expect(node.lifecycle).toBe("draft");
    expect(node.generatedByOrchestrator).toBe(true);
    expect(node.runtimeRequirement.strategy).toBe("auto");
    expect(node.runtimeRequirement.resolvedRuntimeId).toBeNull();
  });

  it("accepts a partial patch with only present fields", () => {
    const patch = workflowNodeDraftPatchSchema.parse({ objective: "Ship the page" });
    expect(patch).toEqual({ objective: "Ship the page" });
  });
});

describe("workflowDraftSchema", () => {
  it("parses an empty composing draft with defaults", () => {
    const draft = workflowDraftSchema.parse(baseDraft());
    expect(draft.nodes).toEqual([]);
    expect(draft.blockers).toEqual([]);
    expect(draft.rootContext.prompt).toBe("");
  });

  it("rejects an edge that references a missing node", () => {
    const result = workflowDraftSchema.safeParse(
      baseDraft({
        nodes: [{ id: "a", title: "A", role: "planner" }],
        edges: [{ id: "e1", sourceNodeId: "a", targetNodeId: "ghost", type: "handoff" }]
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a self-looping edge", () => {
    const result = workflowDraftSchema.safeParse(
      baseDraft({
        nodes: [{ id: "a", title: "A", role: "planner" }],
        edges: [{ id: "e1", sourceNodeId: "a", targetNodeId: "a", type: "handoff" }]
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects an approval gate that references a missing node", () => {
    const result = workflowDraftSchema.safeParse(
      baseDraft({
        nodes: [{ id: "a", title: "A", role: "planner" }],
        approvalGates: [{ id: "g1", nodeId: "ghost" }]
      })
    );
    expect(result.success).toBe(false);
  });
});
