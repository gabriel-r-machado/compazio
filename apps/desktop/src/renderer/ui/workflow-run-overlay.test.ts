import { describe, expect, it } from "vitest";

import type { WorkflowRunGraphDto, WorkflowRunSnapshotDto } from "@forgedeck/schemas";

import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";
import { buildCanvasEdgeRunOverlay, buildCanvasRunOverlay } from "./workflow-run-overlay";
import { projectWorkflowRunToCanvas } from "./workflow-run-projection";
import type { ProjectedWorkflowRun } from "./workflow-run-projection";

const HASH = "a".repeat(64);

function graph(): WorkflowRunGraphDto {
  return {
    runId: "run-1",
    workflowId: "vertical-slice-reference",
    nodes: [
      { id: "planner", type: "agent", title: "Plan", dependsOn: [] },
      { id: "executor", type: "agent", title: "Execute", dependsOn: ["planner"] }
    ]
  };
}

function nodeRun(
  nodeId: string,
  state: WorkflowRunSnapshotDto["nodeRuns"][number]["state"],
  overrides: Partial<WorkflowRunSnapshotDto["nodeRuns"][number]> = {}
): WorkflowRunSnapshotDto["nodeRuns"][number] {
  return {
    id: `${nodeId}-run`,
    runId: "run-1",
    nodeId,
    state,
    attempt: 1,
    inputHash: HASH,
    idempotencyKey: `${nodeId}-key`,
    evidence: [],
    failureReason: null,
    ...overrides
  };
}

function snapshot(nodeRuns: WorkflowRunSnapshotDto["nodeRuns"]): WorkflowRunSnapshotDto {
  return {
    id: "run-1",
    workflowId: "vertical-slice-reference",
    workflowVersion: "1.0",
    workflowHash: HASH,
    inputHash: HASH,
    effectivePermissions: {},
    state: "running",
    dryRun: false,
    concurrency: 1,
    startedAt: "2026-07-24T12:00:00.000Z",
    endedAt: null,
    executionContext: null,
    nodeRuns,
    reportArtifact: null
  };
}

function canvasNode(id: string, data: Partial<ForgeFlowNode["data"]> = {}): ForgeFlowNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      title: id,
      state: "idle",
      summary: "",
      retryMaxAttempts: 1,
      permissions: [],
      ...data
    }
  };
}

function canvasEdge(id: string, source: string, target: string): ForgeFlowEdge {
  return {
    id,
    type: "contract",
    source,
    target,
    data: { schemaVersion: "1.0", kind: "dependency", label: "", requiredEvidenceTypes: [] }
  };
}

/** Evidence marking that `dependent` consumed `dependency`'s artifact by official id/hash. */
function consumedEvidence(dependency: string, artifactId: string) {
  return {
    id: `consumed-${dependency}`,
    type: "artifact",
    artifact_id: artifactId,
    metadata: { consumedArtifactId: artifactId, sha256: HASH }
  };
}

describe("buildCanvasRunOverlay", () => {
  it("binds a reconciled configured agent by its exact stable canvas id", () => {
    const reconciled = projectWorkflowRunToCanvas(snapshot([nodeRun("agent-codex", "running")]), {
      runId: "run-1",
      workflowId: "draft-workflow",
      nodes: [{ id: "agent-codex", type: "agent", title: "Codex", dependsOn: [] }]
    });
    const overlay = buildCanvasRunOverlay(reconciled, [
      canvasNode("agent-codex"),
      canvasNode("unrelated")
    ]);
    expect(overlay.get("agent-codex")?.nodeId).toBe("agent-codex");
    expect(overlay.has("unrelated")).toBe(false);
  });

  it("maps official run states onto real canvas nodes by workflowNodeId", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "succeeded"), nodeRun("executor", "running")]),
      graph()
    );
    const overlay = buildCanvasRunOverlay(projection, [
      canvasNode("canvas-a", { workflowNodeId: "planner" }),
      canvasNode("canvas-b", { workflowNodeId: "executor" })
    ]);

    expect(overlay.get("canvas-a")?.runtimeState).toBe("succeeded");
    expect(overlay.get("canvas-a")?.officialState).toBe("succeeded");
    expect(overlay.get("canvas-b")?.runtimeState).toBe("running");
    expect(overlay.size).toBe(2);
  });

  it("shows run state on a materialized node, whatever lifecycle label it carries", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "running")]),
      graph()
    );

    // The overlay used to skip anything labelled draft/configured. The canvas no longer draws
    // projections, so every node is real — and a node the team reconciler marked "configured" is
    // exactly the running terminal whose state the person needs to see.
    const overlay = buildCanvasRunOverlay(projection, [
      canvasNode("planner-terminal", { workflowNodeId: "planner", lifecycle: "configured" })
    ]);

    expect(overlay.get("planner-terminal")?.runtimeState).toBe("running");
  });

  it("skips nodes without a workflowNodeId or without a matching run node", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "running")]),
      graph()
    );
    const overlay = buildCanvasRunOverlay(projection, [
      canvasNode("plain-note"),
      canvasNode("unmatched", { workflowNodeId: "does-not-exist" })
    ]);

    expect(overlay.size).toBe(0);
  });

  it("returns an empty overlay when there is no run", () => {
    const idle: ProjectedWorkflowRun = projectWorkflowRunToCanvas(null, null);
    const overlay = buildCanvasRunOverlay(idle, [
      canvasNode("canvas-a", { workflowNodeId: "planner" })
    ]);

    expect(overlay.size).toBe(0);
  });

  it("surfaces retry and interrupted-recovery flags from the snapshot", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "running", { attempt: 2 }), nodeRun("executor", "interrupted")]),
      graph()
    );
    const overlay = buildCanvasRunOverlay(projection, [
      canvasNode("canvas-a", { workflowNodeId: "planner" }),
      canvasNode("canvas-b", { workflowNodeId: "executor" })
    ]);

    expect(overlay.get("canvas-a")?.isRetrying).toBe(true);
    expect(overlay.get("canvas-a")?.runtimeState).toBe("retrying");
    expect(overlay.get("canvas-b")?.isRecovered).toBe(true);
    expect(overlay.get("canvas-b")?.runtimeState).toBe("cancelled");
  });

  it("resolves the correct official node for a canvas selection, with its own evidence", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([
        nodeRun("planner", "succeeded", { attempt: 2, evidence: [] }),
        nodeRun("executor", "running", {
          evidence: [consumedEvidence("planner", "art-planner")]
        })
      ]),
      graph()
    );
    const overlay = buildCanvasRunOverlay(projection, [
      canvasNode("card-a", { workflowNodeId: "planner" }),
      canvasNode("card-b", { workflowNodeId: "executor" })
    ]);

    // Selecting card-b must resolve the executor's node, not the planner's.
    const selected = overlay.get("card-b");
    expect(selected?.nodeId).toBe("executor");
    expect(selected?.attempt).toBe(1);
    expect(selected?.consumedArtifacts.map((artifact) => artifact.artifactId)).toEqual([
      "art-planner"
    ]);
    // And the planner keeps its own attempt count.
    expect(overlay.get("card-a")?.attempt).toBe(2);
  });
});

describe("buildCanvasEdgeRunOverlay", () => {
  const nodes = [
    canvasNode("card-a", { workflowNodeId: "planner" }),
    canvasNode("card-b", { workflowNodeId: "executor" })
  ];
  const edges = [canvasEdge("edge-1", "card-a", "card-b")];

  it("marks a satisfied but unconsumed dependency edge as context-available", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "succeeded"), nodeRun("executor", "running")]),
      graph()
    );
    const overlay = buildCanvasEdgeRunOverlay(projection, nodes, edges);
    expect(overlay.get("edge-1")).toBe("context-available");
  });

  it("marks a consumed dependency edge as context-consumed", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([
        nodeRun("planner", "succeeded"),
        nodeRun("executor", "running", {
          evidence: [consumedEvidence("planner", "art-planner")]
        })
      ]),
      graph()
    );
    const overlay = buildCanvasEdgeRunOverlay(projection, nodes, edges);
    expect(overlay.get("edge-1")).toBe("context-consumed");
  });

  it("marks an edge blocked by a failed dependency", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "failed"), nodeRun("executor", "blocked")]),
      graph()
    );
    const overlay = buildCanvasEdgeRunOverlay(projection, nodes, edges);
    expect(overlay.get("edge-1")).toBe("blocked-by-failure");
  });

  it("marks an edge blocked by a cancelled dependency", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "cancelled"), nodeRun("executor", "blocked")]),
      graph()
    );
    const overlay = buildCanvasEdgeRunOverlay(projection, nodes, edges);
    expect(overlay.get("edge-1")).toBe("blocked-by-cancellation");
  });

  it("gives no state to an edge whose nodes are not bound to the run", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "succeeded"), nodeRun("executor", "running")]),
      graph()
    );
    const overlay = buildCanvasEdgeRunOverlay(
      projection,
      [canvasNode("plain-a"), canvasNode("plain-b")],
      [canvasEdge("edge-x", "plain-a", "plain-b")]
    );
    expect(overlay.size).toBe(0);
  });

  it("gives no edge state when there is no run", () => {
    const idle: ProjectedWorkflowRun = projectWorkflowRunToCanvas(null, null);
    expect(buildCanvasEdgeRunOverlay(idle, nodes, edges).size).toBe(0);
  });
});

describe("overlay is a pure projection preserved across a reload", () => {
  it("produces identical node and edge overlays from an equivalent recovered snapshot", () => {
    const nodes = [
      canvasNode("card-a", { workflowNodeId: "planner" }),
      canvasNode("card-b", { workflowNodeId: "executor" })
    ];
    const edges = [canvasEdge("edge-1", "card-a", "card-b")];
    const build = () => {
      // A fresh snapshot object, as a reload would rehydrate from SQLite — same data, new instances.
      const projection = projectWorkflowRunToCanvas(
        snapshot([
          nodeRun("planner", "succeeded", { attempt: 2 }),
          nodeRun("executor", "running", {
            evidence: [consumedEvidence("planner", "art-planner")]
          })
        ]),
        graph()
      );
      return {
        nodeStates: [...buildCanvasRunOverlay(projection, nodes)].map(
          ([id, node]) => [id, node.runtimeState, node.attempt] as const
        ),
        edgeStates: [...buildCanvasEdgeRunOverlay(projection, nodes, edges)]
      };
    };

    const before = build();
    const after = build();
    expect(after.nodeStates).toEqual(before.nodeStates);
    expect(after.edgeStates).toEqual(before.edgeStates);
    expect(before.nodeStates).toEqual([
      ["card-a", "succeeded", 2],
      ["card-b", "running", 1]
    ]);
    expect(before.edgeStates).toEqual([["edge-1", "context-consumed"]]);
  });
});
