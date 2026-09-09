import { describe, expect, it } from "vitest";

import { workflowNodeRunSnapshotSchema, workflowRunEventSchema } from "./workflows";

describe("workflowRunEventSchema", () => {
  const base = {
    id: "run-1",
    runId: "run-1",
    nodeRunId: "planner-run",
    timestamp: "2026-07-24T12:00:00.000Z",
    schemaVersion: "1.0" as const,
    sequence: 1,
    payload: {}
  };

  it("accepts compound event names that use an underscore", () => {
    // node.retry_scheduled is emitted by the scheduler; the events channel must round-trip it.
    const parsed = workflowRunEventSchema.parse({ ...base, type: "node.retry_scheduled" });
    expect(parsed.type).toBe("node.retry_scheduled");
  });

  it("accepts the plain dotted event names", () => {
    for (const type of ["run.started", "node.succeeded", "approval.requested"]) {
      expect(workflowRunEventSchema.parse({ ...base, type }).type).toBe(type);
    }
  });

  it("rejects event names with unexpected characters", () => {
    expect(() => workflowRunEventSchema.parse({ ...base, type: "node.Retry" })).toThrow();
    expect(() => workflowRunEventSchema.parse({ ...base, type: "node retry" })).toThrow();
  });
});

describe("workflowNodeRunSnapshotSchema", () => {
  const base = {
    id: "node-run-1",
    runId: "run-1",
    nodeId: "planner",
    state: "pending" as const,
    inputHash: "0".repeat(64),
    idempotencyKey: "run-1:planner",
    evidence: [],
    failureReason: null
  };

  it("accepts attempt zero for a node that has not been scheduled yet", () => {
    expect(workflowNodeRunSnapshotSchema.parse({ ...base, attempt: 0 }).attempt).toBe(0);
  });

  it("rejects a negative scheduler attempt", () => {
    expect(() => workflowNodeRunSnapshotSchema.parse({ ...base, attempt: -1 })).toThrow();
  });
});
