import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  orchestratorPlanSchema,
  orchestratorPlanToDraft,
  type OrchestratorPlanNode,
  type WorkflowDraft
} from "@forgedeck/schemas";
import type { WorkflowRunSnapshot } from "@forgedeck/orchestration";
import { workflowSchema, type Workflow } from "@forgedeck/workflow";

import {
  DesktopWorkflowRunPort,
  type AutomaticActivationLedger,
  type AutomaticPromptWriter
} from "./desktop-workflow-run-port";
import type { WorkflowRunRuntime } from "./workflow-run-runtime";

const PLAN = orchestratorPlanSchema.parse({
  title: "Auth",
  summary: "Implement auth then verify it.",
  nodes: [
    {
      id: "impl",
      title: "Implement",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Implement Supabase auth in the web app.",
      expectedArtifacts: ["auth module"]
    },
    {
      id: "check",
      title: "Verify",
      role: "qa",
      adapter: "claude-code",
      prompt: "Run the tests.",
      dependsOn: ["impl"]
    }
  ]
});

function draft(): WorkflowDraft {
  return orchestratorPlanToDraft(PLAN, {
    workspaceId: "ws-1",
    objective: "Add Supabase auth",
    executionProfile: "balanced",
    sourceTerminalId: "auto:ws-1",
    now: "2026-07-25T00:00:00.000Z",
    draftId: "11111111-1111-4111-8111-111111111111"
  });
}

function snapshot(
  runId: string,
  nodes: readonly { nodeId: string; state: string; attempt?: number }[],
  state = "failed"
): WorkflowRunSnapshot {
  return {
    id: runId,
    state,
    nodeRuns: nodes.map((node) => ({
      id: `${runId}-${node.nodeId}`,
      runId,
      nodeId: node.nodeId,
      state: node.state,
      attempt: node.attempt ?? 1,
      evidence: []
    }))
  } as unknown as WorkflowRunSnapshot;
}

/** Records what the port asked the live runtime to do; it never re-implements the runtime. */
class FakeRuntime {
  public startedWorkflows: Workflow[] = [];
  public retries: { runId: string; selection: unknown }[] = [];
  public cancelled: string[] = [];
  public paused: string[] = [];
  private runs = 0;
  private readonly definitions = new Map<string, Workflow>();
  public constructor(private readonly outcomes: WorkflowRunSnapshot[]) {}

  public startMaterialized(input: {
    workflow: Workflow;
    prepareRun?: (runId: string) => Promise<void> | void;
  }): {
    runId: string;
    completion: Promise<WorkflowRunSnapshot>;
  } {
    this.startedWorkflows.push(input.workflow);
    const handle = this.handle(input.workflow);
    void input.prepareRun?.(handle.runId);
    return handle;
  }

  public retry(
    runId: string,
    _target: unknown,
    selection: unknown,
    prepareRun?: (runId: string) => Promise<void> | void
  ): { runId: string; completion: Promise<WorkflowRunSnapshot> } {
    this.retries.push({ runId, selection });
    const previous = this.definitions.get(runId);
    if (previous === undefined) throw new Error("unknown run");
    const handle = this.handle(previous);
    void prepareRun?.(handle.runId);
    return handle;
  }

  public definition(runId: string): Workflow {
    const workflow = this.definitions.get(runId);
    if (workflow === undefined) throw new Error("Workflow definition was not found");
    return workflow;
  }

  public show(runId: string): WorkflowRunSnapshot {
    return snapshot(runId, [], "interrupted");
  }

  public async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }

  public async pause(runId: string): Promise<void> {
    this.paused.push(runId);
  }

  public async resume(): Promise<void> {
    this.paused.pop();
  }

  private handle(workflow: Workflow): {
    runId: string;
    completion: Promise<WorkflowRunSnapshot>;
  } {
    this.runs += 1;
    const runId = `run-${this.runs}`;
    this.definitions.set(runId, workflow);
    const outcome = this.outcomes.shift() ?? snapshot(runId, [], "succeeded");
    return { runId, completion: Promise.resolve({ ...outcome, id: runId }) };
  }
}

class FakePrompts implements AutomaticPromptWriter {
  public written: { runId: string; nodeId: string; cycle: number; prompt: string }[] = [];
  public putNodePrompt(input: {
    runId: string;
    nodeId: string;
    cycle: number;
    prompt: string;
  }): void {
    // Mirrors the store: an existing (run, node) pair is never rewritten.
    if (this.written.some((e) => e.runId === input.runId && e.nodeId === input.nodeId)) return;
    this.written.push(input);
  }
}

class FakeLedger implements AutomaticActivationLedger {
  public attached: { activationId: string; runId: string }[] = [];
  public failed: string[] = [];
  private runId: string | null = null;
  public ensureIntent(): { activationId: string; runId: string | null } {
    return { activationId: "activation-1", runId: this.runId };
  }
  public attachRun(activationId: string, runId: string): void {
    this.attached.push({ activationId, runId });
    this.runId = runId;
  }
  public markFailed(activationId: string): void {
    this.failed.push(activationId);
  }
}

function makePort(
  runtime: FakeRuntime,
  options: { prompts?: FakePrompts; ledger?: FakeLedger; artifacts?: Set<string> } = {}
): {
  port: DesktopWorkflowRunPort;
  prompts: FakePrompts;
  ledger: FakeLedger;
} {
  const prompts = options.prompts ?? new FakePrompts();
  const ledger = options.ledger ?? new FakeLedger();
  const published = options.artifacts ?? new Set<string>(["run-1:impl", "run-2:impl"]);
  const port = new DesktopWorkflowRunPort({
    runtime: runtime as unknown as WorkflowRunRuntime,
    targets: { resolveTarget: () => ({ root: "/workspace" }) },
    prompts,
    activations: ledger,
    artifacts: {
      getNodeArtifact: (runId, nodeId) =>
        published.has(`${runId}:${nodeId}`) ? { id: `${runId}-${nodeId}` } : null
    },
    expectsArtifact: (nodeId) => nodeId === "impl",
    workspaceId: "ws-1"
  });
  return { port, prompts, ledger };
}

describe("DesktopWorkflowRunPort", () => {
  it("materializes the draft through the official materializer and starts one run", async () => {
    const runtime = new FakeRuntime([]);
    const { port, ledger } = makePort(runtime);
    const started = await port.materializeAndStart(draft());
    expect(started.runId).toBe("run-1");
    expect(runtime.startedWorkflows).toHaveLength(1);
    // The official definition carries the dependency, and no prompt (its schema cannot hold one).
    const workflow = runtime.startedWorkflows[0];
    expect(workflow?.nodes.map((node) => node.id)).toEqual(["impl", "check"]);
    expect(workflow?.nodes.find((node) => node.id === "check")?.depends_on).toEqual(["impl"]);
    expect(JSON.stringify(workflow)).not.toContain("Implement Supabase auth in the web app.");
    expect(ledger.attached).toEqual([{ activationId: "activation-1", runId: "run-1" }]);
  });

  it("delivers every node's full prompt out of band, keyed by run and node", async () => {
    const runtime = new FakeRuntime([]);
    const { port, prompts } = makePort(runtime);
    await port.materializeAndStart(draft());
    expect(prompts.written).toEqual([
      {
        runId: "run-1",
        nodeId: "impl",
        cycle: 0,
        prompt: "Implement Supabase auth in the web app."
      },
      { runId: "run-1", nodeId: "check", cycle: 0, prompt: "Run the tests." }
    ]);
  });

  it("is idempotent: a repeated materialization returns the run that already exists", async () => {
    const runtime = new FakeRuntime([]);
    const { port } = makePort(runtime);
    const first = await port.materializeAndStart(draft());
    const second = await port.materializeAndStart(draft());
    expect(second.runId).toBe(first.runId);
    // The second call started nothing: one draft revision can only ever have one first run.
    expect(runtime.startedWorkflows).toHaveLength(1);
  });

  it("reports structural success only when the node succeeded AND published its artifact", async () => {
    const runtime = new FakeRuntime([
      snapshot("run-1", [
        { nodeId: "impl", state: "succeeded" },
        { nodeId: "check", state: "succeeded" }
      ])
    ]);
    // `impl` declares an artifact but published none, so its success does not count.
    const { port } = makePort(runtime, { artifacts: new Set() });
    await port.materializeAndStart(draft());
    const outcome = await port.awaitOutcome("run-1");
    const impl = outcome.nodes.find((node) => node.nodeId === "impl");
    const check = outcome.nodes.find((node) => node.nodeId === "check");
    expect(impl?.hasExpectedArtifacts).toBe(false);
    expect(impl?.structuralSuccess).toBe(false);
    // `check` declares no artifact, so its own success stands.
    expect(check?.structuralSuccess).toBe(true);
  });

  it("retries a node as the next run of the lineage, over the dependents it releases", async () => {
    const runtime = new FakeRuntime([snapshot("run-1", [{ nodeId: "impl", state: "failed" }])]);
    const { port, prompts } = makePort(runtime);
    await port.materializeAndStart(draft());
    await port.awaitOutcome("run-1");
    const next = await port.retryNode({
      runId: "run-1",
      nodeId: "impl",
      updatedPrompt: "Fix the type error."
    });

    expect(next.runId).toBe("run-2");
    // The official retry mechanism was used, scoped so fixing the node re-runs what depended on it.
    expect(runtime.retries).toEqual([
      { runId: "run-1", selection: { nodeId: "impl", scope: "dependents" } }
    ]);
    // The draft was never re-materialized, and the corrected prompt belongs to the NEW run only.
    expect(runtime.startedWorkflows).toHaveLength(1);
    expect(prompts.written).toContainEqual({
      runId: "run-2",
      nodeId: "impl",
      cycle: 1,
      prompt: "Fix the type error."
    });
    expect(prompts.written).toContainEqual({
      runId: "run-1",
      nodeId: "impl",
      cycle: 0,
      prompt: "Implement Supabase auth in the web app."
    });
  });

  it("adds a corrective node to the next run without rewriting the previous definition", async () => {
    const runtime = new FakeRuntime([snapshot("run-1", [{ nodeId: "impl", state: "failed" }])]);
    const { port, prompts } = makePort(runtime);
    await port.materializeAndStart(draft());
    await port.awaitOutcome("run-1");
    const corrective: OrchestratorPlanNode = {
      id: "fix-types",
      title: "Fix the types",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Fix the failing types.",
      dependsOn: ["impl"],
      allowedAreas: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      verificationCommands: [],
      operationRisk: "safe",
      requiresHumanApproval: false
    };
    const next = await port.addCorrectiveNode({ runId: "run-1", node: corrective });

    expect(next.runId).toBe("run-2");
    const previous = runtime.definition("run-1");
    // History is intact: the first run's definition never gained the corrective node.
    expect(previous.nodes.map((node) => node.id)).toEqual(["impl", "check"]);
    const appended = runtime.definition("run-2");
    expect(appended.nodes.map((node) => node.id)).toEqual(["impl", "check", "fix-types"]);
    expect(appended.nodes.find((node) => node.id === "fix-types")?.depends_on).toEqual(["impl"]);
    expect(prompts.written).toContainEqual({
      runId: "run-2",
      nodeId: "fix-types",
      cycle: 1,
      prompt: "Fix the failing types."
    });
  });

  it("refuses a corrective node that reuses an id already in the definition", async () => {
    const runtime = new FakeRuntime([snapshot("run-1", [{ nodeId: "impl", state: "failed" }])]);
    const { port } = makePort(runtime);
    await port.materializeAndStart(draft());
    await expect(
      port.addCorrectiveNode({
        runId: "run-1",
        node: {
          id: "check",
          title: "Collides",
          role: "qa",
          adapter: "claude-code",
          prompt: "…",
          dependsOn: [],
          allowedAreas: [],
          expectedArtifacts: [],
          acceptanceCriteria: [],
          verificationCommands: [],
          operationRisk: "safe",
          requiresHumanApproval: false
        }
      })
    ).rejects.toThrow(/already exists/u);
  });

  it("delegates pause, cancel and snapshot to the live runtime", async () => {
    const runtime = new FakeRuntime([]);
    const { port } = makePort(runtime);
    await port.materializeAndStart(draft());
    await port.pause("run-1");
    await port.cancel("run-1");
    expect(runtime.paused).toEqual(["run-1"]);
    expect(runtime.cancelled).toEqual(["run-1"]);
    expect(port.snapshot("run-1").id).toBe("run-1");
  });

  it("reads the stored snapshot when the run predates this process (after a reload)", async () => {
    const runtime = new FakeRuntime([]);
    const { port } = makePort(runtime);
    // No handle exists for this run: the port must not invent a running state.
    const outcome = await port.awaitOutcome("run-9");
    expect(outcome.state).toBe("failed");
    expect(outcome.runId).toBe("run-9");
  });

  it("materializes a workflow the official schema accepts", async () => {
    const runtime = new FakeRuntime([]);
    const { port } = makePort(runtime);
    await port.materializeAndStart(draft());
    // Parsing again proves the port produced a definition the runtime contract accepts.
    expect(() => workflowSchema.parse(runtime.startedWorkflows[0])).not.toThrow();
  });
});

describe("automatic mode budget", () => {
  it("keeps the three modes distinct so the port inherits a bounded budget", () => {
    expect(AUTOMATIC_MODE_DEFAULT_LIMITS.economic.maxWorkflowNodes).toBeLessThan(
      AUTOMATIC_MODE_DEFAULT_LIMITS["high-performance"].maxWorkflowNodes
    );
  });
});
