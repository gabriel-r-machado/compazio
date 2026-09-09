import { describe, expect, it } from "vitest";

import { workflowSchema } from "@forgedeck/workflow";

import type {
  AutonomyGate,
  AutonomyGateDecision,
  AutonomyGateRequest,
  NodeExecutionResult,
  WorkflowNodeExecutor
} from "./contracts";
import { InMemoryArtifactRegistry, InMemoryRunStore } from "./memory-ports";
import { DeterministicScheduler } from "./scheduler";

const success = (id: string): NodeExecutionResult => ({
  success: true,
  evidence: [{ id: `ev-${id}`, type: "test", summary: "ok", metadata: {} }],
  output: {}
});

const failure: NodeExecutionResult = {
  success: false,
  reason: "process_exit_nonzero",
  message: "boom",
  evidence: []
};

/** Records every gate request and answers per action from a programmable script. */
class RecordingGate implements AutonomyGate {
  public readonly requests: AutonomyGateRequest[] = [];
  public constructor(
    private readonly script: Partial<
      Record<AutonomyGateRequest["action"], AutonomyGateDecision | AutonomyGateDecision[]>
    > = {}
  ) {}
  public async assess(request: AutonomyGateRequest): Promise<AutonomyGateDecision> {
    this.requests.push(request);
    const scripted = this.script[request.action];
    if (Array.isArray(scripted)) return scripted.shift() ?? { outcome: "allow", rule: "default" };
    return scripted ?? { outcome: "allow", rule: "default" };
  }
}

const agentWorkflow = () =>
  workflowSchema.parse({
    schema_version: "1.0",
    id: "autonomy-test",
    name: "Autonomy test",
    concurrency: 1,
    permissions: { process: true },
    nodes: [
      {
        id: "build",
        type: "agent",
        permissions: { process: true },
        retry: { max_attempts: 3, backoff_ms: 0, retry_on: ["process_exit_nonzero"] }
      }
    ]
  });

function schedulerWith(executor: WorkflowNodeExecutor) {
  return new DeterministicScheduler(
    executor,
    new InMemoryRunStore(),
    new InMemoryArtifactRegistry(),
    {
      sleep: async () => undefined
    }
  );
}

describe("scheduler supervised-autonomy wiring", () => {
  it("never consults the gate for assisted or manual runs", async () => {
    const gate = new RecordingGate();
    const scheduler = schedulerWith({ execute: async (node) => success(node.id) });
    const result = await scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true }
    }).completion;
    expect(result.state).toBe("succeeded");
    expect(gate.requests).toHaveLength(0);
  });

  it("assesses continue and spawn before an agent node and proceeds on allow", async () => {
    const gate = new RecordingGate();
    const scheduler = schedulerWith({ execute: async (node) => success(node.id) });
    const result = await scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    }).completion;
    expect(result.state).toBe("succeeded");
    expect(gate.requests.map((request) => request.action)).toEqual([
      "continue_approved_step",
      "spawn_agent"
    ]);
    expect(gate.requests[1]?.state.spawnedAgents).toBe(0);
  });

  it("blocks the node and cancels the run when the kill switch stops a step", async () => {
    const gate = new RecordingGate({
      continue_approved_step: { outcome: "stop", rule: "kill_switch" }
    });
    const scheduler = schedulerWith({ execute: async (node) => success(node.id) });
    const result = await scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    }).completion;
    expect(result.state).toBe("cancelled");
    expect(result.nodeRuns[0]?.state).toBe("blocked");
    // The kill switch is respected immediately: spawn is never assessed after the stop.
    expect(gate.requests.map((request) => request.action)).toEqual(["continue_approved_step"]);
  });

  it("blocks a spawn over quota without executing the agent", async () => {
    const gate = new RecordingGate({ spawn_agent: { outcome: "stop", rule: "spawn_limit" } });
    let executed = 0;
    const scheduler = schedulerWith({
      execute: async (node) => {
        executed += 1;
        return success(node.id);
      }
    });
    const result = await scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    }).completion;
    expect(result.state).toBe("failed");
    expect(result.nodeRuns[0]?.state).toBe("failed");
    expect(result.nodeRuns[0]?.failureReason).toBe("permission_denied");
    expect(executed).toBe(0);
  });

  it("stops an automatic retry once the guardrail denies it, leaving the node failed", async () => {
    const gate = new RecordingGate({ retry_node: { outcome: "stop", rule: "retry_limit" } });
    let attempts = 0;
    const scheduler = schedulerWith({
      execute: async () => {
        attempts += 1;
        return failure;
      }
    });
    const result = await scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    }).completion;
    expect(result.state).toBe("failed");
    // First attempt runs; the guardrail blocks the retry, so the node does not attempt again.
    expect(attempts).toBe(1);
    expect(gate.requests.filter((request) => request.action === "retry_node")).toHaveLength(1);
    expect(gate.requests.at(-1)?.state.nodeAttempts).toBe(1);
  });

  it("allows retries the guardrail permits, up to the node cap", async () => {
    const gate = new RecordingGate({ retry_node: { outcome: "allow", rule: "within_scope" } });
    let attempts = 0;
    const scheduler = schedulerWith({
      execute: async () => {
        attempts += 1;
        return attempts >= 3 ? success("build") : failure;
      }
    });
    const result = await scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    }).completion;
    expect(result.state).toBe("succeeded");
    expect(attempts).toBe(3);
    expect(gate.requests.filter((request) => request.action === "retry_node")).toHaveLength(2);
  });

  it("waits for a human decision when a spawn requires approval and proceeds once granted", async () => {
    const gate = new RecordingGate({
      spawn_agent: { outcome: "require_approval", rule: "not_preauthorized" }
    });
    let executed = false;
    const scheduler = schedulerWith({
      execute: async (node) => {
        executed = true;
        return success(node.id);
      }
    });
    const handle = scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    });
    await waitFor(() => scheduler.getRun(handle.runId).nodeRuns[0]?.state === "waiting");
    expect(executed).toBe(false);
    await scheduler.resolveApproval(handle.runId, "build", { approved: true, note: "ok" });
    const result = await handle.completion;
    expect(result.state).toBe("succeeded");
    expect(executed).toBe(true);
  });

  it("fails the node when a required approval is denied", async () => {
    const gate = new RecordingGate({
      spawn_agent: { outcome: "require_approval", rule: "not_preauthorized" }
    });
    let executed = false;
    const scheduler = schedulerWith({
      execute: async (node) => {
        executed = true;
        return success(node.id);
      }
    });
    const handle = scheduler.start({
      workflow: agentWorkflow(),
      grantedPermissions: { process: true },
      autonomy: { mode: "autonomous", gate }
    });
    await waitFor(() => scheduler.getRun(handle.runId).nodeRuns[0]?.state === "waiting");
    await scheduler.resolveApproval(handle.runId, "build", { approved: false, note: "no" });
    const result = await handle.completion;
    expect(result.state).toBe("failed");
    expect(result.nodeRuns[0]?.failureReason).toBe("approval_denied");
    expect(executed).toBe(false);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not met in time");
}
