import { describe, expect, it } from "vitest";

import type {
  WorkflowRunEvent,
  WorkflowRunGraphDto,
  WorkflowRunSnapshotDto
} from "@forgedeck/schemas";

import { projectWorkflowRunToCanvas, type ProjectedCanvasNode } from "./workflow-run-projection";

const HASH = "a".repeat(64);

function graph(): WorkflowRunGraphDto {
  return {
    runId: "run-1",
    workflowId: "vertical-slice-reference",
    nodes: [
      { id: "planner", type: "agent", title: "Plan", dependsOn: [] },
      { id: "executor", type: "agent", title: "Execute", dependsOn: ["planner"] },
      { id: "gate", type: "quality_gate", title: null, dependsOn: ["executor"] }
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

function snapshot(
  nodeRuns: WorkflowRunSnapshotDto["nodeRuns"],
  overrides: Partial<WorkflowRunSnapshotDto> = {}
): WorkflowRunSnapshotDto {
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
    reportArtifact: null,
    ...overrides
  };
}

describe("projectWorkflowRunToCanvas", () => {
  it("projects every declared node as idle when there is no run", () => {
    const projection = projectWorkflowRunToCanvas(null, graph());
    expect(projection.runId).toBeNull();
    expect(projection.runState).toBe("idle");
    expect(projection.nodes.map((node) => node.runtimeState)).toEqual(["idle", "idle", "idle"]);
    expect(projection.edges).toEqual([]);
  });

  it("projects a queued root and blocked dependents", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([
        nodeRun("planner", "ready"),
        nodeRun("executor", "pending"),
        nodeRun("gate", "pending")
      ]),
      graph()
    );
    expect(pick(projection, "planner").runtimeState).toBe("queued");
    expect(pick(projection, "executor").runtimeState).toBe("blocked");
    expect(pick(projection, "executor").blockingDependencies).toEqual(["planner"]);
    expect(pick(projection, "gate").blockingDependencies).toEqual(["executor"]);
  });

  it("projects a running node and derives timing/duration from events", () => {
    const events: WorkflowRunEvent[] = [
      runEvent("planner-run", "node.started", "2026-07-24T12:00:01.000Z", 1),
      runEvent("planner-run", "node.succeeded", "2026-07-24T12:00:03.000Z", 2)
    ];
    const projection = projectWorkflowRunToCanvas(
      snapshot([
        nodeRun("planner", "succeeded"),
        nodeRun("executor", "running"),
        nodeRun("gate", "pending")
      ]),
      graph(),
      events
    );
    expect(pick(projection, "executor").runtimeState).toBe("running");
    expect(pick(projection, "planner").startedAt).toBe("2026-07-24T12:00:01.000Z");
    expect(pick(projection, "planner").endedAt).toBe("2026-07-24T12:00:03.000Z");
    expect(pick(projection, "planner").durationMs).toBe(2000);
  });

  it("projects a retrying node from attempt and retry events", () => {
    const events: WorkflowRunEvent[] = [
      runEvent("planner-run", "node.retry_scheduled", "2026-07-24T12:00:02.000Z", 1)
    ];
    const projection = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "running", { attempt: 2 })]),
      {
        runId: "run-1",
        workflowId: "w",
        nodes: [{ id: "planner", type: "agent", title: "Plan", dependsOn: [] }]
      },
      events
    );
    const planner = pick(projection, "planner");
    expect(planner.runtimeState).toBe("retrying");
    expect(planner.isRetrying).toBe(true);
    expect(planner.attempt).toBe(2);
  });

  it("projects produced artifacts and consumed hashes with their source node", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([
        nodeRun("planner", "succeeded", {
          evidence: [
            {
              id: "published-planner",
              type: "artifact",
              summary: "published",
              metadata: { artifactId: "node-run-1-planner", sha256: HASH }
            }
          ]
        }),
        nodeRun("executor", "succeeded", {
          evidence: [
            {
              id: "consumed-planner",
              type: "artifact",
              summary: "consumed",
              metadata: { consumedArtifactId: "node-run-1-planner", sha256: HASH }
            },
            {
              id: "published-executor",
              type: "artifact",
              summary: "published",
              metadata: { artifactId: "node-run-1-executor", sha256: HASH }
            }
          ]
        }),
        nodeRun("gate", "succeeded")
      ]),
      graph()
    );
    expect(pick(projection, "planner").producedArtifacts).toEqual([
      { artifactId: "node-run-1-planner", sha256: HASH }
    ]);
    expect(pick(projection, "executor").consumedArtifacts).toEqual([
      { artifactId: "node-run-1-planner", sha256: HASH, fromNodeId: "planner" }
    ]);
    // The consumed edge reflects the official consumption, not decoration.
    const plannerToExecutor = projection.edges.find(
      (edge) => edge.from === "planner" && edge.to === "executor"
    );
    expect(plannerToExecutor?.state).toBe("context-consumed");
  });

  it("projects available (not yet consumed) context on the edge", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot([
        nodeRun("planner", "succeeded"),
        nodeRun("executor", "running"),
        nodeRun("gate", "pending")
      ]),
      graph()
    );
    const edge = projection.edges.find((item) => item.from === "planner" && item.to === "executor");
    expect(edge?.state).toBe("context-available");
  });

  it("projects a failed node and blocks its dependents' edges", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot(
        [
          nodeRun("planner", "failed", { failureReason: "process_exit_nonzero" }),
          nodeRun("executor", "pending"),
          nodeRun("gate", "pending")
        ],
        { state: "failed", endedAt: "2026-07-24T12:00:05.000Z" }
      ),
      graph()
    );
    expect(pick(projection, "planner").runtimeState).toBe("failed");
    expect(pick(projection, "planner").shortError).toBe("process_exit_nonzero");
    expect(pick(projection, "executor").runtimeState).toBe("blocked");
    const edge = projection.edges.find((item) => item.from === "planner" && item.to === "executor");
    expect(edge?.state).toBe("blocked-by-failure");
  });

  it("projects a cancelled node and cancellation-blocked edges", () => {
    const projection = projectWorkflowRunToCanvas(
      snapshot(
        [
          nodeRun("planner", "cancelled"),
          nodeRun("executor", "cancelled"),
          nodeRun("gate", "pending")
        ],
        { state: "cancelled" }
      ),
      graph()
    );
    expect(pick(projection, "planner").runtimeState).toBe("cancelled");
    const edge = projection.edges.find((item) => item.from === "planner" && item.to === "executor");
    expect(edge?.state).toBe("blocked-by-cancellation");
  });

  it("projects a succeeded run with report and flags recovered interruptions", () => {
    const succeeded = projectWorkflowRunToCanvas(
      snapshot(
        [
          nodeRun("planner", "succeeded"),
          nodeRun("executor", "succeeded"),
          nodeRun("gate", "succeeded")
        ],
        {
          state: "succeeded",
          reportArtifact: { id: "report-run-1" },
          endedAt: "2026-07-24T12:01:00.000Z"
        }
      ),
      graph()
    );
    expect(succeeded.runState).toBe("succeeded");
    expect(succeeded.hasReport).toBe(true);
    expect(succeeded.nodes.every((node) => node.runtimeState === "succeeded")).toBe(true);

    const interrupted = projectWorkflowRunToCanvas(
      snapshot([nodeRun("planner", "interrupted")], { state: "interrupted" }),
      {
        runId: "run-1",
        workflowId: "w",
        nodes: [{ id: "planner", type: "agent", title: null, dependsOn: [] }]
      }
    );
    expect(interrupted.nodes[0]?.runtimeState).toBe("cancelled");
    expect(interrupted.nodes[0]?.isRecovered).toBe(true);
  });

  it("recovers the same projection from a reopened snapshot (no run reconstruction)", () => {
    const persisted = snapshot(
      [
        nodeRun("planner", "succeeded", { attempt: 2 }),
        nodeRun("executor", "succeeded"),
        nodeRun("gate", "succeeded")
      ],
      { state: "succeeded", reportArtifact: { id: "report-run-1" } }
    );
    const first = projectWorkflowRunToCanvas(persisted, graph());
    const afterReload = projectWorkflowRunToCanvas(persisted, graph());
    expect(afterReload).toEqual(first);
    expect(pick(afterReload, "planner").attempt).toBe(2);
    expect(afterReload.runState).toBe("succeeded");
  });
});

function pick(
  projection: ReturnType<typeof projectWorkflowRunToCanvas>,
  nodeId: string
): ProjectedCanvasNode {
  const node = projection.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) throw new Error(`missing projected node: ${nodeId}`);
  return node;
}

function runEvent(
  nodeRunId: string,
  type: string,
  timestamp: string,
  sequence: number
): WorkflowRunEvent {
  return {
    id: `event-${sequence}`,
    runId: "run-1",
    nodeRunId,
    type,
    timestamp,
    schemaVersion: "1.0",
    sequence,
    payload: {}
  };
}
