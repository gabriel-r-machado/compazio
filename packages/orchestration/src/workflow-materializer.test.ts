import { describe, expect, it } from "vitest";

import { workflowDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft } from "@forgedeck/schemas";

import { materializeWorkflowDraft, materializedWorkflowId } from "./workflow-materializer";

interface NodeInput {
  readonly id: string;
  readonly role?: string;
  readonly runtimeId?: string | null;
  readonly title?: string;
}

interface EdgeInput {
  readonly source: string;
  readonly target: string;
  readonly type?: WorkflowDraft["edges"][number]["type"];
}

const EDGE_CONTRACT = {
  requiredArtifacts: [],
  requiredEvidence: [],
  completionCondition: ""
} as const;

function draft(nodes: readonly NodeInput[], edges: readonly EdgeInput[] = []): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    version: 3,
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Landing page",
    objective: "Build a premium landing page",
    state: "approved",
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title ?? node.id,
      role: node.role ?? "implementer",
      runtimeRequirement: {
        resolvedRuntimeId: node.runtimeId === undefined ? "fake-agent" : node.runtimeId
      }
    })),
    edges: edges.map((edge, index) => ({
      id: `edge-${index}`,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      type: edge.type ?? "dependency"
    }))
  });
}

describe("materializeWorkflowDraft", () => {
  it("materializes a valid draft into an official workflow", () => {
    const result = materializeWorkflowDraft(
      draft(
        [
          { id: "planner", role: "planner" },
          { id: "implementer", role: "implementer" }
        ],
        [{ source: "planner", target: "implementer" }]
      )
    );
    expect(result.issues).toEqual([]);
    expect(result.workflow).not.toBeNull();
    expect(result.workflow?.id).toBe(
      materializedWorkflowId({ id: "11111111-1111-4111-8111-111111111111" })
    );
    expect(result.workflow?.nodes.map((node) => node.id)).toEqual(["planner", "implementer"]);
  });

  it("preserves the workflowNodeId as the official nodeId and the adapter/role", () => {
    const result = materializeWorkflowDraft(
      draft([{ id: "planner", role: "planner", runtimeId: "claude-code" }])
    );
    const node = result.workflow?.nodes[0];
    expect(node?.id).toBe("planner");
    expect(node?.type).toBe("agent");
    expect(node?.adapter).toBe("claude-code");
    expect(node?.role).toBe("planner");
  });

  it("preserves executable dependencies from dependency and handoff edges", () => {
    const result = materializeWorkflowDraft(
      draft(
        [{ id: "a" }, { id: "b" }, { id: "c" }],
        [
          { source: "a", target: "b", type: "dependency" },
          { source: "b", target: "c", type: "handoff" }
        ]
      )
    );
    const byId = new Map(result.workflow?.nodes.map((node) => [node.id, node]));
    expect(byId.get("b")?.depends_on).toEqual(["a"]);
    expect(byId.get("c")?.depends_on).toEqual(["b"]);
    expect(byId.get("a")?.depends_on).toEqual([]);
  });

  it("ignores non-executable edge types (feedback/review) as ordering dependencies", () => {
    const result = materializeWorkflowDraft(
      draft([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b", type: "feedback" }])
    );
    expect(result.workflow?.nodes.find((node) => node.id === "b")?.depends_on).toEqual([]);
  });

  it("blocks materialization when a node has no resolved runtime binding", () => {
    const result = materializeWorkflowDraft(draft([{ id: "planner", runtimeId: null }]));
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("missing_binding");
  });

  it("blocks materialization on an empty team", () => {
    const result = materializeWorkflowDraft(draft([]));
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("empty_workflow");
  });

  it("blocks materialization on an invalid node identifier", () => {
    const result = materializeWorkflowDraft(draft([{ id: "not valid" }]));
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_node_id");
  });

  it("blocks materialization on a dependency to a missing node", () => {
    // The draft schema rejects an edge to a missing node, so tamper the parsed draft directly to
    // prove the materializer's own guard (a corrupted persisted draft must never create a run).
    const base = draft([{ id: "a" }, { id: "b" }], [{ source: "b", target: "a" }]);
    const tampered: WorkflowDraft = {
      ...base,
      edges: [
        {
          id: "edge-x",
          sourceNodeId: "missing",
          targetNodeId: "a",
          type: "dependency",
          contract: EDGE_CONTRACT
        }
      ]
    };
    const materialized = materializeWorkflowDraft(tampered);
    expect(materialized.workflow).toBeNull();
    expect(materialized.issues.map((issue) => issue.code)).toContain("missing_dependency");
  });

  it("blocks materialization on a dependency cycle", () => {
    const base = draft([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b" }]);
    const cyclic: WorkflowDraft = {
      ...base,
      edges: [
        {
          id: "e1",
          sourceNodeId: "a",
          targetNodeId: "b",
          type: "dependency",
          contract: EDGE_CONTRACT
        },
        {
          id: "e2",
          sourceNodeId: "b",
          targetNodeId: "a",
          type: "dependency",
          contract: EDGE_CONTRACT
        }
      ]
    };
    const result = materializeWorkflowDraft(cyclic);
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("cycle_detected");
  });
});
