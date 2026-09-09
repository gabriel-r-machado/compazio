import { workflowDraftSchema, workflowNodeDraftSchema, taskResultSchema } from "@forgedeck/schemas";
import type { TaskResult, WorkflowDraft, WorkflowEdgeDraft } from "@forgedeck/schemas";
import { beforeEach, describe, expect, it } from "vitest";

import { ActivationService, type WorkerDispatch } from "./activation-service";

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

class FakeLauncher {
  public readonly dispatched: WorkerDispatch[] = [];
  dispatch(input: WorkerDispatch): void {
    this.dispatched.push(input);
  }
}

function svc(launcher: FakeLauncher) {
  let n = 0;
  return new ActivationService({ launcher, newId: () => `d${(n += 1)}` });
}

function result(taskId: string, dispatchId: string, status: TaskResult["status"] = "completed") {
  return taskResultSchema.parse({
    taskId,
    dispatchId,
    status,
    summary: "s",
    completedAt: "2026-07-23T00:00:00.000Z"
  });
}

describe("ActivationService", () => {
  let launcher: FakeLauncher;
  beforeEach(() => {
    launcher = new FakeLauncher();
  });

  it("dispatches a handoff chain one step at a time as results arrive", () => {
    const service = svc(launcher);
    service.start(draft(["ux", "fe", "qa"], [edge("ux", "fe"), edge("fe", "qa")]), "balanced");
    expect(launcher.dispatched.map((d) => d.taskId)).toEqual(["ux"]);

    service.submitResult(result("ux", launcher.dispatched[0]?.dispatchId ?? ""));
    expect(launcher.dispatched.map((d) => d.taskId)).toEqual(["ux", "fe"]);

    service.submitResult(result("fe", launcher.dispatched[1]?.dispatchId ?? ""));
    const outcome = service.submitResult(result("qa", launcher.dispatched[2]?.dispatchId ?? ""));
    expect(outcome.done).toBe(true);
    expect(service.snapshot().completed.sort()).toEqual(["fe", "qa", "ux"]);
  });

  it("idle never completes a task (no result submitted)", () => {
    const service = svc(launcher);
    service.start(draft(["a", "b"]), "balanced");
    expect(service.snapshot().completed).toEqual([]);
    expect(service.snapshot().done).toBe(false);
  });

  it("respects the profile concurrency cap and fills a slot as one finishes", () => {
    const service = svc(launcher);
    // economy → maxConcurrentAgents 2
    service.start(draft(["a", "b", "c"]), "economy");
    expect(launcher.dispatched.map((d) => d.taskId)).toEqual(["a", "b"]);
    service.submitResult(result("a", launcher.dispatched[0]?.dispatchId ?? ""));
    expect(launcher.dispatched.map((d) => d.taskId)).toEqual(["a", "b", "c"]);
  });

  it("rejects a stale dispatch result and keeps the task running", () => {
    const service = svc(launcher);
    service.start(draft(["a"]), "balanced");
    const outcome = service.submitResult(result("a", "wrong-dispatch"));
    expect(outcome.status).toBe("rejected");
    expect(service.snapshot().running).toEqual(["a"]);
  });

  it("retries a failed task within the profile limit, then gives up", () => {
    const service = svc(launcher);
    // balanced → maxRetriesPerTask 2
    service.start(draft(["a"]), "balanced");
    service.submitResult(result("a", launcher.dispatched[0]?.dispatchId ?? "", "failed"));
    expect(launcher.dispatched).toHaveLength(2); // retry 1
    service.submitResult(result("a", launcher.dispatched[1]?.dispatchId ?? "", "failed"));
    expect(launcher.dispatched).toHaveLength(3); // retry 2
    service.submitResult(result("a", launcher.dispatched[2]?.dispatchId ?? "", "failed"));
    expect(launcher.dispatched).toHaveLength(3); // exhausted
    expect(service.snapshot().failed).toEqual(["a"]);
  });
});
