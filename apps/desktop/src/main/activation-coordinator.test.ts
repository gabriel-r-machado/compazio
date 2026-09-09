import type { WorkerDispatch, WorkflowRunSnapshot } from "@forgedeck/orchestration";
import { workflowDraftSchema, workflowNodeDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft, WorkflowEdgeDraft } from "@forgedeck/schemas";
import { beforeEach, describe, expect, it } from "vitest";

import { ActivationCoordinator } from "./activation-coordinator";
import type {
  MaterializedWorkflowRunInput,
  WorkflowActivationLedger
} from "./activation-coordinator";

const RESULT_OPEN = "⟦compasso:result⟧";
const RESULT_CLOSE = "⟦/compasso⟧";

function node(id: string) {
  return workflowNodeDraftSchema.parse({
    id,
    title: id,
    role: "implementer",
    runtimeRequirement: { resolvedRuntimeId: "claude-code" }
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
    nodes: nodes.map(node),
    edges,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z"
  });
}

function resultEnvelope(taskId: string, dispatchId: string, status = "completed"): string {
  return (
    RESULT_OPEN +
    JSON.stringify({
      taskId,
      dispatchId,
      status,
      summary: "done",
      completedAt: "2026-07-23T00:00:00.000Z"
    }) +
    RESULT_CLOSE
  );
}

describe("ActivationCoordinator", () => {
  let dispatches: WorkerDispatch[];
  let coordinator: ActivationCoordinator;
  let doneCalls: number;

  beforeEach(() => {
    dispatches = [];
    doneCalls = 0;
    let n = 0;
    coordinator = new ActivationCoordinator({
      onDispatch: (dispatch) => dispatches.push(dispatch),
      newId: () => `d${(n += 1)}`,
      onDone: () => {
        doneCalls += 1;
      }
    });
  });

  it("advances a handoff chain as workers report structured results", () => {
    coordinator.activate(draft(["ux", "fe"], [edge("ux", "fe")]), "balanced");
    expect(dispatches.map((d) => d.taskId)).toEqual(["ux"]);

    // Main spawned a PTY for ux → binds the session, then the worker emits its result.
    const ux = dispatches[0];
    coordinator.bindWorkerSession("ux", "session-ux");
    coordinator.ingest(
      "session-ux",
      `trabalhando...\n${resultEnvelope("ux", ux?.dispatchId ?? "")}`
    );
    expect(dispatches.map((d) => d.taskId)).toEqual(["ux", "fe"]);

    const fe = dispatches[1];
    coordinator.bindWorkerSession("fe", "session-fe");
    coordinator.ingest("session-fe", resultEnvelope("fe", fe?.dispatchId ?? ""));
    expect(doneCalls).toBe(1);
    expect(coordinator.snapshot().done).toBe(true);
  });

  it("idle output never completes a task", () => {
    coordinator.activate(draft(["a"]), "balanced");
    coordinator.bindWorkerSession("a", "session-a");
    coordinator.ingest("session-a", "só logs, nada de resultado estruturado\n");
    expect(coordinator.snapshot().completed).toEqual([]);
    expect(coordinator.snapshot().done).toBe(false);
  });

  it("ignores output from an unbound session", () => {
    coordinator.activate(draft(["a"]), "balanced");
    coordinator.ingest("ghost", resultEnvelope("a", dispatches[0]?.dispatchId ?? ""));
    expect(coordinator.snapshot().completed).toEqual([]);
  });

  it("a stale result does not complete the task", () => {
    coordinator.activate(draft(["a"]), "balanced");
    coordinator.bindWorkerSession("a", "session-a");
    coordinator.ingest("session-a", resultEnvelope("a", "wrong-dispatch"));
    expect(coordinator.snapshot().running).toEqual(["a"]);
  });
});

interface LedgerRecord {
  activationId: string;
  workflowId: string;
  runId: string | null;
  workspaceId: string;
}

class FakeLedger implements WorkflowActivationLedger {
  public readonly byKey = new Map<string, LedgerRecord>();
  private readonly byId = new Map<string, LedgerRecord>();
  private counter = 0;

  getByDraft(draftId: string, draftVersion: number): LedgerRecord | null {
    return this.byKey.get(`${draftId}:${draftVersion}`) ?? null;
  }
  ensureIntent(input: {
    draftId: string;
    draftVersion: number;
    workspaceId: string;
    workflowId: string;
    definitionSha256: string;
  }): LedgerRecord {
    const key = `${input.draftId}:${input.draftVersion}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const record: LedgerRecord = {
      activationId: `act-${(this.counter += 1)}`,
      workflowId: input.workflowId,
      runId: null,
      workspaceId: input.workspaceId
    };
    this.byKey.set(key, record);
    this.byId.set(record.activationId, record);
    return record;
  }
  attachRun(activationId: string, runId: string): unknown {
    const record = this.byId.get(activationId);
    if (record === undefined) throw new Error("unknown activation");
    if (record.runId !== null && record.runId !== runId) throw new Error("already has a run");
    record.runId = runId;
    return record;
  }
  markFailed(): void {
    /* tests do not assert failure marking */
  }
}

function fakeSnapshot(id: string): WorkflowRunSnapshot {
  return { id } as unknown as WorkflowRunSnapshot;
}

describe("ActivationCoordinator.materialize", () => {
  let ledger: FakeLedger;
  let starts: MaterializedWorkflowRunInput[];
  let runSeq: number;

  function make(resolveProjectRoot: (workspaceId: string) => string | null = () => "/repo") {
    ledger = new FakeLedger();
    starts = [];
    runSeq = 0;
    return new ActivationCoordinator({
      onDispatch: () => undefined,
      newId: () => "unused",
      materialization: {
        ledger,
        resolveProjectRoot,
        starter: {
          startMaterializedWorkflow: async (input) => {
            starts.push(input);
            return fakeSnapshot(`run-${(runSeq += 1)}`);
          }
        }
      }
    });
  }

  it("materializes a valid draft and starts exactly one run", async () => {
    const coordinator = make();
    const result = await coordinator.materialize(draft(["ux", "fe"], [edge("ux", "fe")]));
    expect(result.status).toBe("started");
    expect(result.runId).toBe("run-1");
    expect(starts).toHaveLength(1);
    // The official definition preserves the workflowNodeIds and the workspace target.
    expect(starts[0]?.workflow.nodes.map((entry) => entry.id)).toEqual(["ux", "fe"]);
    expect(starts[0]?.workspaceId).toBe("w1");
    expect(starts[0]?.agentNodeId).toBe("ux");
  });

  it("is idempotent: a repeated approval returns the same run without starting a second", async () => {
    const coordinator = make();
    const first = await coordinator.materialize(draft(["ux"]));
    const second = await coordinator.materialize(draft(["ux"]));
    expect(second.runId).toBe(first.runId);
    expect(starts).toHaveLength(1);
  });

  it("resumes a recorded activation with no run by creating only the run", async () => {
    const coordinator = make();
    // Simulate a crash after the intent was recorded but before the run was created.
    ledger.ensureIntent({
      draftId: "22222222-2222-4222-8222-222222222222",
      draftVersion: 1,
      workspaceId: "w1",
      workflowId: "draft-22222222-2222-4222-8222-222222222222",
      definitionSha256: "a".repeat(64)
    });
    const result = await coordinator.materialize(draft(["ux"]));
    expect(result.status).toBe("started");
    expect(starts).toHaveLength(1);
  });

  it("blocks an invalid draft without starting a run", async () => {
    const coordinator = make();
    const bad = draft(["ux"]);
    const unbound: WorkflowDraft = {
      ...bad,
      nodes: bad.nodes.map((entry) => ({
        ...entry,
        runtimeRequirement: { ...entry.runtimeRequirement, resolvedRuntimeId: null }
      }))
    };
    const result = await coordinator.materialize(unbound);
    expect(result.status).toBe("invalid");
    expect(result.runId).toBeNull();
    expect(starts).toHaveLength(0);
  });

  it("fails without a run when the project is unavailable", async () => {
    const coordinator = make(() => null);
    const result = await coordinator.materialize(draft(["ux"]));
    expect(result.status).toBe("failed");
    expect(result.runId).toBeNull();
    expect(starts).toHaveLength(0);
  });
});
