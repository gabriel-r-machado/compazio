import { describe, expect, it, vi } from "vitest";

import { workflowSchema } from "@forgedeck/workflow";
import type { Evidence, WorkflowNode } from "@forgedeck/workflow";

import type { NodeExecutionResult, WorkflowNodeExecutor } from "./contracts";
import { InMemoryArtifactRegistry, InMemoryRunStore } from "./memory-ports";
import { DeterministicScheduler } from "./scheduler";

const evidence = (id: string): Evidence => ({
  id,
  type: "test",
  summary: `Evidence ${id}`,
  metadata: {}
});

function testWorkflow(nodes: unknown[], concurrency = 2) {
  return workflowSchema.parse({
    schema_version: "1.0",
    id: "scheduler-test",
    name: "Scheduler test",
    concurrency,
    permissions: { process: true },
    nodes
  });
}

describe("deterministic scheduler", () => {
  it("respects concurrency and completes with evidence and a report", async () => {
    let active = 0;
    let maximumActive = 0;
    const executor: WorkflowNodeExecutor = {
      execute: async (node) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { success: true, evidence: [evidence(node.id)], output: {} };
      }
    };
    const store = new InMemoryRunStore();
    const artifacts = new InMemoryArtifactRegistry();
    const scheduler = new DeterministicScheduler(executor, store, artifacts);
    const handle = scheduler.start({
      workflow: testWorkflow([
        { id: "a", type: "shell", permissions: { process: true } },
        { id: "b", type: "shell", permissions: { process: true } },
        { id: "c", type: "artifact", depends_on: ["a", "b"] }
      ]),
      grantedPermissions: { process: true }
    });
    const result = await handle.completion;
    expect(result.state).toBe("succeeded");
    expect(maximumActive).toBe(2);
    expect(result.nodeRuns.every((node) => node.evidence.length > 0)).toBe(true);
    expect(result.reportArtifact?.type).toBe("run-report");
    expect(artifacts.reports).toHaveLength(1);
  });

  it("captures an immutable delivery checkpoint before finalizing a context-bound run", async () => {
    const store = new InMemoryRunStore();
    const artifacts = new InMemoryArtifactRegistry();
    const createDeliveryCheckpoint = vi.fn(async () => checkpointReference("delivery"));
    const scheduler = new DeterministicScheduler(successExecutor(), store, artifacts);

    const result = await scheduler.start({
      workflow: testWorkflow([{ id: "work", type: "shell", permissions: { process: true } }]),
      grantedPermissions: { process: true },
      executionContext: {
        context: {
          workspaceId: "workspace-1",
          agentNodeId: "reviewer",
          task: "Review the implementation",
          contractId: null,
          profileVersion: 1,
          missionVersion: 2,
          memoryVersion: 3,
          contractVersion: null,
          functionCheckpoint: checkpointReference("function"),
          deliveryCheckpoint: null
        },
        createDeliveryCheckpoint
      }
    }).completion;

    expect(createDeliveryCheckpoint).toHaveBeenCalledOnce();
    expect(result.executionContext).toMatchObject({
      agentNodeId: "reviewer",
      functionCheckpoint: { checkpointId: "function-checkpoint" },
      deliveryCheckpoint: { checkpointId: "delivery-checkpoint" }
    });
    expect(artifacts.reports[0]?.run.executionContext?.deliveryCheckpoint?.checkpointId).toBe(
      "delivery-checkpoint"
    );
  });

  it("serializes nodes that request the same resource lock", async () => {
    let active = 0;
    let maximumActive = 0;
    const executor: WorkflowNodeExecutor = {
      execute: async (node) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { success: true, evidence: [evidence(node.id)], output: {} };
      }
    };
    const scheduler = new DeterministicScheduler(
      executor,
      new InMemoryRunStore(),
      new InMemoryArtifactRegistry()
    );
    const result = await scheduler.start({
      workflow: testWorkflow([
        {
          id: "a",
          type: "shell",
          permissions: { process: true },
          resources: [{ type: "port", key: "3000" }]
        },
        {
          id: "b",
          type: "shell",
          permissions: { process: true },
          resources: [{ type: "port", key: "3000" }]
        }
      ]),
      grantedPermissions: { process: true }
    }).completion;
    expect(result.state).toBe("succeeded");
    expect(maximumActive).toBe(1);
  });

  it("pauses for approval and resumes only after a decision", async () => {
    const executor = successExecutor();
    const scheduler = new DeterministicScheduler(
      executor,
      new InMemoryRunStore(),
      new InMemoryArtifactRegistry()
    );
    const handle = scheduler.start({
      workflow: testWorkflow([
        { id: "approval", type: "human_approval" },
        { id: "after", type: "shell", depends_on: ["approval"], permissions: { process: true } }
      ]),
      grantedPermissions: { process: true }
    });
    await waitUntil(() => scheduler.getRun(handle.runId).state === "waiting");
    expect(
      scheduler.getRun(handle.runId).nodeRuns.find((node) => node.nodeId === "after")?.state
    ).toBe("pending");
    await scheduler.resolveApproval(handle.runId, "approval", { approved: true, note: "Reviewed" });
    expect((await handle.completion).state).toBe("succeeded");
  });

  it("retries only configured retry reasons", async () => {
    let attempts = 0;
    const executor: WorkflowNodeExecutor = {
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? { success: false, reason: "transient_error", message: "Retry", evidence: [] }
          : { success: true, evidence: [evidence("retry")], output: {} };
      }
    };
    const scheduler = new DeterministicScheduler(
      executor,
      new InMemoryRunStore(),
      new InMemoryArtifactRegistry(),
      { sleep: async () => Promise.resolve() }
    );
    const result = await scheduler.start({
      workflow: testWorkflow([
        {
          id: "flaky",
          type: "shell",
          permissions: { process: true },
          retry: { max_attempts: 2, backoff_ms: 1, retry_on: ["transient_error"] }
        }
      ]),
      grantedPermissions: { process: true }
    }).completion;
    expect(result.state).toBe("succeeded");
    expect(attempts).toBe(2);
  });

  it("pauses after active work and resumes only when explicitly requested", async () => {
    let releaseFirst: (() => void) | null = null;
    let firstStarted = false;
    let secondStarted = false;
    const executor: WorkflowNodeExecutor = {
      execute: async (node) => {
        if (node.id === "first") {
          firstStarted = true;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        } else {
          secondStarted = true;
        }
        return { success: true, evidence: [evidence(node.id)], output: {} };
      }
    };
    const scheduler = new DeterministicScheduler(
      executor,
      new InMemoryRunStore(),
      new InMemoryArtifactRegistry()
    );
    const handle = scheduler.start({
      workflow: testWorkflow([
        { id: "first", type: "shell", permissions: { process: true } },
        { id: "second", type: "shell", depends_on: ["first"], permissions: { process: true } }
      ]),
      grantedPermissions: { process: true }
    });
    await waitUntil(() => firstStarted);
    await scheduler.pause(handle.runId);
    expect(scheduler.getRun(handle.runId).state).toBe("paused");
    releaseFirst?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(secondStarted).toBe(false);
    await scheduler.resume(handle.runId);
    expect((await handle.completion).state).toBe("succeeded");
    expect(secondStarted).toBe(true);
  });

  it("cancels cooperatively, marks remaining nodes, and records a terminal cancellation", async () => {
    let started = false;
    const store = new InMemoryRunStore();
    const executor: WorkflowNodeExecutor = {
      execute: async (_node, context) => {
        started = true;
        await new Promise<void>((resolve) => {
          context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          success: false,
          reason: "transient_error",
          message: "Stopped by cancellation",
          evidence: []
        };
      }
    };
    const scheduler = new DeterministicScheduler(executor, store, new InMemoryArtifactRegistry());
    const handle = scheduler.start({
      workflow: testWorkflow([
        { id: "active", type: "shell", permissions: { process: true } },
        { id: "later", type: "artifact", depends_on: ["active"] }
      ]),
      grantedPermissions: { process: true }
    });
    await waitUntil(() => started);
    await scheduler.cancel(handle.runId);
    const result = await handle.completion;
    expect(result.state).toBe("cancelled");
    expect(result.nodeRuns.map((node) => node.state)).toEqual(["cancelled", "cancelled"]);
    expect(store.events.map((event) => event.type)).toContain("run.cancelled");
    expect(store.events.map((event) => event.type)).toContain("node.cancelled");
  });

  it("blocks dependents after failure and rejects success without evidence", async () => {
    const executor: WorkflowNodeExecutor = {
      execute: async (node) =>
        node.id === "empty"
          ? { success: true, evidence: [], output: {} }
          : { success: true, evidence: [evidence(node.id)], output: {} }
    };
    const store = new InMemoryRunStore();
    const scheduler = new DeterministicScheduler(executor, store, new InMemoryArtifactRegistry());
    const result = await scheduler.start({
      workflow: testWorkflow([
        { id: "empty", type: "shell", permissions: { process: true } },
        { id: "dependent", type: "artifact", depends_on: ["empty"] }
      ]),
      grantedPermissions: { process: true }
    }).completion;
    expect(result.state).toBe("failed");
    expect(result.nodeRuns.find((node) => node.nodeId === "empty")?.failureReason).toBe(
      "missing_evidence"
    );
    expect(result.nodeRuns.find((node) => node.nodeId === "dependent")?.state).toBe("blocked");
    expect(store.events.map((event) => event.type)).toContain("node.failed");
  });
});

function successExecutor(): WorkflowNodeExecutor {
  return {
    execute: async (node: WorkflowNode): Promise<NodeExecutionResult> => ({
      success: true,
      evidence: [evidence(node.id)],
      output: {}
    })
  };
}

function checkpointReference(prefix: string) {
  return {
    checkpointId: `${prefix}-checkpoint`,
    snapshotId: `${prefix}-snapshot`,
    sha256: "a".repeat(64),
    createdAt: "2026-07-21T12:00:00.000Z"
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for scheduler state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
