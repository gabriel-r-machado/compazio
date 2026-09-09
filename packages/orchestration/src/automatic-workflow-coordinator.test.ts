import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  orchestratorPlanSchema,
  type AutomaticWorkflowMode,
  type AutomaticWorkflowRequest,
  type OrchestratorPlanNode,
  type WorkflowDraft
} from "@forgedeck/schemas";

import {
  AutomaticWorkflowCoordinator,
  type AutomaticRunState,
  type NodeRunOutcome,
  type OrchestratorPort,
  type RemediationContext,
  type RunOutcome,
  type WorkflowRunPort
} from "./automatic-workflow-coordinator";
import { resolveAutomaticModeStrategy } from "./automatic-mode-strategy";
import { VerificationCoordinator, type CheckRunner } from "./verification-coordinator";
import { materializeWorkflowDraft } from "./workflow-materializer";

const PLAN = {
  title: "Auth",
  summary: "Implement Supabase auth, test it, fix until the build passes.",
  nodes: [
    {
      id: "impl",
      title: "Implement",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Implement Supabase auth in the web app.",
      allowedAreas: ["apps/web/src/auth"],
      acceptanceCriteria: ["Build passes"]
    },
    {
      id: "check",
      title: "Verify",
      role: "qa",
      adapter: "claude-code",
      prompt: "Run the tests and report failures.",
      dependsOn: ["impl"]
    }
  ]
};

const VALID_REMEDIATION = {
  action: "retry_node",
  targetNodeId: "impl",
  reason: "The build failed on a type error in the auth module.",
  updatedPrompt: "Fix the type error in the auth module. Do not undo valid work already done."
};

const CORRECTIVE_REMEDIATION = {
  action: "add_corrective_node",
  targetNodeId: "impl",
  reason: "The auth module needs a dedicated type-fix pass.",
  updatedPrompt: "Fix the auth types.",
  correctiveNode: {
    id: "fix-types",
    title: "Fix the auth types",
    role: "implementer",
    adapter: "claude-code",
    prompt: "Fix the type error the build reported in the auth module.",
    acceptanceCriteria: ["Build passes"]
  }
};

class FakeOrchestrator implements OrchestratorPort {
  public analyzeCalls = 0;
  public remediateCalls: RemediationContext[] = [];
  public constructor(
    private readonly planJson: unknown,
    private readonly remediationJson: unknown = VALID_REMEDIATION
  ) {}
  public async analyze(): Promise<unknown> {
    this.analyzeCalls += 1;
    return this.planJson;
  }
  public async remediate(context: RemediationContext): Promise<unknown> {
    this.remediateCalls.push(context);
    return this.remediationJson;
  }
}

/**
 * Scripted stand-in for the official run surface. Remediation starts the NEXT run of the lineage, so the
 * fake hands out run-1, run-2, … and records which run each call addressed.
 */
class FakeRunPort implements WorkflowRunPort {
  public startCalls: WorkflowDraft[] = [];
  public retryCalls: { runId: string; nodeId: string; updatedPrompt: string }[] = [];
  public correctiveCalls: { runId: string; node: OrchestratorPlanNode }[] = [];
  public cancelCalls: string[] = [];
  public awaitedRunIds: string[] = [];
  /** Runs before each awaited outcome is returned, to simulate what happens while the run executes. */
  public onAwait: (() => void) | undefined;
  private readonly queue: RunOutcome[];
  private last: RunOutcome | undefined;
  private started = 0;
  public constructor(outcomes: RunOutcome[]) {
    this.queue = [...outcomes];
  }
  public async materializeAndStart(draft: WorkflowDraft): Promise<{ runId: string }> {
    this.startCalls.push(draft);
    return { runId: this.nextRunId() };
  }
  public async awaitOutcome(runId: string): Promise<RunOutcome> {
    this.awaitedRunIds.push(runId);
    const next = this.queue.shift() ?? this.last;
    if (next === undefined) throw new Error("no outcome scripted");
    this.last = next;
    this.onAwait?.();
    return next;
  }
  public async retryNode(input: {
    runId: string;
    nodeId: string;
    updatedPrompt: string;
  }): Promise<{ runId: string }> {
    this.retryCalls.push(input);
    return { runId: this.nextRunId() };
  }
  public async addCorrectiveNode(input: {
    runId: string;
    node: OrchestratorPlanNode;
  }): Promise<{ runId: string }> {
    this.correctiveCalls.push(input);
    return { runId: this.nextRunId() };
  }
  public async cancel(runId: string): Promise<void> {
    this.cancelCalls.push(runId);
  }
  /** Total official runs this port handed out — the lineage length. */
  public get runCount(): number {
    return this.started;
  }
  private nextRunId(): string {
    this.started += 1;
    return `run-${this.started}`;
  }
}

const okCheckRunner: CheckRunner = {
  run: async (command) => ({ command, exitCode: 0, ok: true, summary: "ok" })
};

function makeCoordinator(
  orchestrator: OrchestratorPort,
  run: WorkflowRunPort,
  options: {
    checkRunner?: CheckRunner;
    requestApproval?: (approvals: readonly string[], draft: WorkflowDraft) => Promise<boolean>;
    clock?: () => number;
    persistState?: (state: AutomaticRunState) => void;
  } = {}
): AutomaticWorkflowCoordinator {
  return new AutomaticWorkflowCoordinator({
    orchestrator,
    run,
    verification: new VerificationCoordinator(options.checkRunner ?? okCheckRunner),
    ...(options.requestApproval === undefined ? {} : { requestApproval: options.requestApproval }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.persistState === undefined ? {} : { persistState: options.persistState })
  });
}

function request(
  mode: AutomaticWorkflowMode = "standard",
  overrides: Partial<AutomaticWorkflowRequest> = {}
): AutomaticWorkflowRequest {
  return {
    workspaceId: "ws-1",
    objective: "Add Supabase auth",
    mode,
    limits: AUTOMATIC_MODE_DEFAULT_LIMITS[mode],
    ...overrides
  };
}

function node(id: string, ok: boolean, attempts = 1): NodeRunOutcome {
  return { nodeId: id, structuralSuccess: ok, hasExpectedArtifacts: ok, attempts };
}

function outcome(nodes: NodeRunOutcome[]): RunOutcome {
  return {
    runId: "run-1",
    state: nodes.every((entry) => entry.structuralSuccess) ? "succeeded" : "failed",
    nodes
  };
}

describe("AutomaticWorkflowCoordinator", () => {
  it("1. an objective produces a valid WorkflowDraft", async () => {
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), new FakeRunPort([]));
    const composed = await coordinator.compose(request());
    expect(composed.status).toBe("composed");
    if (composed.status === "composed") {
      expect(composed.draft.creationMode).toBe("automatic");
      expect(composed.draft.nodes).toHaveLength(2);
    }
  });

  it("2. an invalid plan is rejected (no free text becomes a workflow)", async () => {
    const coordinator = makeCoordinator(new FakeOrchestrator("just build it"), new FakeRunPort([]));
    const result = await coordinator.run(request());
    expect(result.status).toBe("plan_rejected");
  });

  it("2b. a plan that cannot materialize is rejected before anything starts (cycle)", async () => {
    // The plan schema accepts this: every dependency exists and none is a self-loop. Only the official
    // materializer sees the cycle, so compose must be the one to reject it.
    const cyclic = {
      ...PLAN,
      nodes: [
        { ...PLAN.nodes[0], dependsOn: ["check"] },
        { ...PLAN.nodes[1], dependsOn: ["impl"] }
      ]
    };
    expect(orchestratorPlanSchema.safeParse(cyclic).success).toBe(true);
    const run = new FakeRunPort([]);
    const result = await makeCoordinator(new FakeOrchestrator(cyclic), run).run(request());
    expect(result.status).toBe("plan_rejected");
    expect(run.startCalls).toHaveLength(0);
  });

  it("2c. a plan over the mode's node budget is rejected", async () => {
    const oversized = {
      ...PLAN,
      nodes: Array.from({ length: 5 }, (_, index) => ({
        ...PLAN.nodes[0],
        id: `impl-${index}`,
        dependsOn: []
      }))
    };
    // economic budgets 4 nodes.
    const result = await makeCoordinator(new FakeOrchestrator(oversized), new FakeRunPort([])).run(
      request("economic")
    );
    expect(result.status).toBe("plan_rejected");
    if (result.status === "plan_rejected") expect(result.issues[0]).toContain("4-node budget");
  });

  it("3. the workflow materializes exactly one run (a clean session never starts a second)", async () => {
    const run = new FakeRunPort([outcome([node("impl", true), node("check", true)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    const result = await coordinator.run(request());
    expect(result.status).toBe("completed");
    expect(run.startCalls).toHaveLength(1);
    expect(run.runCount).toBe(1);
  });

  it("4. prompts are sent automatically (each node carries its prompt; no manual forwarding)", async () => {
    const run = new FakeRunPort([outcome([node("impl", true), node("check", true)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    await coordinator.run(request());
    const draft = run.startCalls[0];
    expect(draft?.nodes.every((entry) => entry.objective.length > 0)).toBe(true);
    expect(draft?.nodes.find((entry) => entry.id === "impl")?.objective).toContain("Supabase auth");
  });

  it("5. dependents receive official context (dependency becomes depends_on)", async () => {
    const run = new FakeRunPort([outcome([node("impl", true), node("check", true)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    await coordinator.run(request());
    const materialized = materializeWorkflowDraft(run.startCalls[0] as WorkflowDraft);
    expect(materialized.issues).toEqual([]);
    expect(materialized.workflow?.nodes.find((entry) => entry.id === "check")?.depends_on).toEqual([
      "impl"
    ]);
  });

  it("8+9+10+15. a failure yields a remediation, an official retry as the next run of the lineage, and a second valid result completes", async () => {
    const orchestrator = new FakeOrchestrator(PLAN);
    const run = new FakeRunPort([
      outcome([node("impl", false)]),
      outcome([node("impl", true), node("check", true)])
    ]);
    const coordinator = makeCoordinator(orchestrator, run);
    const result = await coordinator.run(request());
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.remediationCycles).toBe(1);
      // The session reports the last run of the lineage.
      expect(result.runId).toBe("run-2");
    }
    // The remediation was applied as an official retry of the failed node on the previous run...
    expect(orchestrator.remediateCalls).toHaveLength(1);
    expect(run.retryCalls).toEqual([
      { runId: "run-1", nodeId: "impl", updatedPrompt: VALID_REMEDIATION.updatedPrompt }
    ]);
    // ...which extended the lineage instead of re-materializing the draft, and the loop then waited on it.
    expect(run.startCalls).toHaveLength(1);
    expect(run.awaitedRunIds).toEqual(["run-1", "run-2"]);
  });

  it("8a. a node that failed in an earlier run stays open when a later run does not cover it", async () => {
    // Two nodes fail in run 1. The remediation run only covers `impl`, so `check` is simply absent from
    // its outcome — absence must never be read as success.
    const orchestrator = new FakeOrchestrator(PLAN);
    const run = new FakeRunPort([
      outcome([node("impl", false), node("check", false)]),
      outcome([node("impl", true)])
    ]);
    const coordinator = makeCoordinator(orchestrator, run, {
      persistState: () => undefined
    });
    const result = await coordinator.run(request("standard"));
    // `impl` was fixed, `check` is still open, so the session did not report completion.
    expect(result.status).not.toBe("completed");
    // The second remediation addressed the node that was still failing.
    expect(orchestrator.remediateCalls.map((call) => call.targetNodeId)).toEqual(["impl", "check"]);
  });

  it("8b. a remediation may add one official corrective node that depends on the failed node", async () => {
    const orchestrator = new FakeOrchestrator(PLAN, CORRECTIVE_REMEDIATION);
    const run = new FakeRunPort([
      outcome([node("impl", false)]),
      // The corrective node passed; the node it corrects still has no structural result of its own.
      outcome([node("impl", false), node("fix-types", true)])
    ]);
    const coordinator = makeCoordinator(orchestrator, run);
    const result = await coordinator.run(request());
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.remediationCycles).toBe(1);
    expect(run.correctiveCalls).toHaveLength(1);
    // The corrective node is added work: it runs after the node it corrects, and nothing was retried.
    expect(run.correctiveCalls[0]?.node.id).toBe("fix-types");
    expect(run.correctiveCalls[0]?.node.dependsOn).toEqual(["impl"]);
    expect(run.retryCalls).toHaveLength(0);
    // The corrective node arrived as the next run of the lineage; the draft was materialized only once.
    expect(run.startCalls).toHaveLength(1);
    expect(run.awaitedRunIds).toEqual(["run-1", "run-2"]);
  });

  it("8c. a remediation aimed at another node is refused (it could undo verified work)", async () => {
    const redirected = { ...VALID_REMEDIATION, targetNodeId: "check" };
    const orchestrator = new FakeOrchestrator(PLAN, redirected);
    const run = new FakeRunPort([outcome([node("impl", false), node("check", true)])]);
    const coordinator = makeCoordinator(orchestrator, run);
    const result = await coordinator.run(request());
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.reason).toBe("unrecoverable");
      expect(result.detail).toContain("check");
    }
    // The node that verified was never touched.
    expect(run.retryCalls).toHaveLength(0);
    expect(run.correctiveCalls).toHaveLength(0);
  });

  it("8d. a corrective node reusing an existing node id is refused", async () => {
    const colliding = {
      ...CORRECTIVE_REMEDIATION,
      correctiveNode: { ...CORRECTIVE_REMEDIATION.correctiveNode, id: "check" }
    };
    const run = new FakeRunPort([outcome([node("impl", false)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN, colliding), run);
    const result = await coordinator.run(request());
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toBe("unrecoverable");
    expect(run.correctiveCalls).toHaveLength(0);
  });

  it("11. the remediation-cycle limit ends the run", async () => {
    const run = new FakeRunPort([
      outcome([node("impl", false)]),
      outcome([node("impl", false)]),
      outcome([node("impl", false)])
    ]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    // economic allows a single remediation cycle.
    const result = await coordinator.run(request("economic"));
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toBe("remediation_exhausted");
  });

  it("11b. the per-node attempt limit ends the run", async () => {
    const run = new FakeRunPort([outcome([node("impl", false, 2)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    const result = await coordinator.run(request("standard"));
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toBe("attempts_exhausted");
  });

  it("12. human approval blocks only the nodes that need it", async () => {
    const planWithApproval = {
      ...PLAN,
      nodes: [{ ...PLAN.nodes[0], requiresHumanApproval: true }, PLAN.nodes[1]]
    };
    const run = new FakeRunPort([]);
    const coordinator = makeCoordinator(new FakeOrchestrator(planWithApproval), run);
    const result = await coordinator.run(request());
    expect(result.status).toBe("awaiting_approval");
    if (result.status === "awaiting_approval") expect(result.approvals).toEqual(["impl"]);
    // Nothing was started while approval is pending.
    expect(run.startCalls).toHaveLength(0);
  });

  it("12b. granting approval proceeds to a single run", async () => {
    const planWithApproval = {
      ...PLAN,
      nodes: [{ ...PLAN.nodes[0], requiresHumanApproval: true }, PLAN.nodes[1]]
    };
    const run = new FakeRunPort([outcome([node("impl", true), node("check", true)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(planWithApproval), run, {
      requestApproval: async () => true
    });
    const result = await coordinator.run(request());
    expect(result.status).toBe("completed");
    expect(run.startCalls).toHaveLength(1);
  });

  it("13. cancellation interrupts execution and cancels the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = new FakeRunPort([outcome([node("impl", true)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    const result = await coordinator.run(request(), { signal: controller.signal });
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toBe("cancelled");
    expect(run.cancelCalls).toEqual(["run-1"]);
  });

  it("13b. an abort raised while the outcome is awaited stops the run instead of remediating", async () => {
    const controller = new AbortController();
    const orchestrator = new FakeOrchestrator(PLAN);
    const run = new FakeRunPort([outcome([node("impl", false)])]);
    run.onAwait = () => controller.abort();
    const coordinator = makeCoordinator(orchestrator, run);
    const result = await coordinator.run(request(), { signal: controller.signal });
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toBe("cancelled");
    expect(run.cancelCalls).toEqual(["run-1"]);
    // No remediation was requested for a run the user cancelled.
    expect(orchestrator.remediateCalls).toHaveLength(0);
    expect(run.retryCalls).toHaveLength(0);
  });

  it("14. the run publishes resumable state on start and after each remediation cycle", async () => {
    const states: AutomaticRunState[] = [];
    const run = new FakeRunPort([
      outcome([node("impl", false)]),
      outcome([node("impl", true), node("check", true)])
    ]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run, {
      persistState: (state) => {
        states.push(state);
      }
    });
    const result = await coordinator.run(request());
    expect(result.status).toBe("completed");
    expect(states.map((state) => state.remediationCycle)).toEqual([0, 1]);
    // The published state is exactly what resume() needs, carrying the lineage so far.
    expect(states.map((state) => state.runIds)).toEqual([["run-1"], ["run-1", "run-2"]]);
    const resumable = states[1];
    expect(resumable?.plan.nodes.map((entry) => entry.id)).toEqual(["impl", "check"]);
    expect(resumable?.request.objective).toBe("Add Supabase auth");
  });

  it("14b. resuming from published state after a corrective node keeps that node in the plan", async () => {
    const states: AutomaticRunState[] = [];
    const firstRun = new FakeRunPort([outcome([node("impl", false)])]);
    const coordinator = makeCoordinator(
      new FakeOrchestrator(PLAN, CORRECTIVE_REMEDIATION),
      firstRun,
      {
        persistState: (state) => {
          states.push(state);
        }
      }
    );
    // economic allows a single cycle, so the run stops right after the corrective node was added.
    await coordinator.run(request("economic"));
    const resumable = states.at(-1);
    expect(resumable?.plan.nodes.map((entry) => entry.id)).toEqual(["impl", "check", "fix-types"]);
    expect(resumable?.corrections).toEqual([
      { failedNodeId: "impl", correctiveNodeId: "fix-types" }
    ]);
    // The lineage and the still-open failure are part of the persisted state.
    expect(resumable?.runIds).toEqual(["run-1", "run-2"]);
    expect(resumable?.unresolvedFailures?.map((entry) => entry.nodeId)).toEqual(["impl"]);

    const secondRun = new FakeRunPort([outcome([node("impl", false), node("fix-types", true)])]);
    const resumed = await makeCoordinator(
      new FakeOrchestrator(PLAN, CORRECTIVE_REMEDIATION),
      secondRun
    ).resume(resumable as AutomaticRunState);
    // The corrective node and its delegation survived the reload, so the session completes without
    // redoing valid work and without adding a second corrective node.
    expect(resumed.status).toBe("completed");
    expect(secondRun.startCalls).toHaveLength(0);
    expect(secondRun.correctiveCalls).toHaveLength(0);
    // Resume waited on the run the lineage already pointed at, never a fresh one.
    expect(secondRun.awaitedRunIds).toEqual(["run-2"]);
  });

  it("14+15. reload resumes the automatic run without a duplicate run or attempts", async () => {
    const run = new FakeRunPort([outcome([node("impl", true), node("check", true)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run);
    const plan = orchestratorPlanSchema.parse(PLAN);
    const result = await coordinator.resume({
      request: request(),
      plan,
      draftId: "11111111-1111-4111-8111-111111111111",
      runIds: ["run-1"],
      remediationCycle: 0,
      startedAtMs: Date.now()
    });
    expect(result.status).toBe("completed");
    // Resume never starts a new run: it waits on the run the lineage already points at.
    expect(run.startCalls).toHaveLength(0);
    expect(run.retryCalls).toHaveLength(0);
    expect(run.awaitedRunIds).toEqual(["run-1"]);
  });

  it("global timeout ends the run", async () => {
    const startedAtMs = 1_000;
    const run = new FakeRunPort([outcome([node("impl", false)])]);
    const coordinator = makeCoordinator(new FakeOrchestrator(PLAN), run, {
      clock: () => startedAtMs + AUTOMATIC_MODE_DEFAULT_LIMITS.economic.timeoutMs + 1
    });
    const plan = orchestratorPlanSchema.parse(PLAN);
    const result = await coordinator.resume({
      request: request("economic"),
      plan,
      draftId: "11111111-1111-4111-8111-111111111111",
      runIds: ["run-1"],
      remediationCycle: 0,
      startedAtMs
    });
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toBe("timeout");
    expect(run.cancelCalls).toEqual(["run-1"]);
  });
});

describe("resolveAutomaticModeStrategy", () => {
  it("16. the three modes resolve to different bounded limits", () => {
    const economic = resolveAutomaticModeStrategy("economic");
    const standard = resolveAutomaticModeStrategy("standard");
    const high = resolveAutomaticModeStrategy("high-performance");
    expect(economic.limits.maxRemediationCycles).toBe(1);
    expect(standard.limits.maxRemediationCycles).toBe(2);
    expect(high.limits.maxRemediationCycles).toBe(3);
    expect(economic.executionProfile).toBe("economy");
    expect(high.executionProfile).toBe("maximum");
    // Attempts stay within the global per-node retry ceiling (retries + 1 = 3).
    expect(high.limits.maxAttemptsPerNode).toBeLessThanOrEqual(3);
  });
});

describe("VerificationCoordinator", () => {
  it("6. approves a node backed by a valid structural result and passing checks", async () => {
    const verification = new VerificationCoordinator(okCheckRunner);
    const result = await verification.verifyNode({
      nodeId: "impl",
      structuralSuccess: true,
      hasExpectedArtifacts: true,
      acceptanceCriteria: ["Build passes"],
      verificationCommands: ["pnpm build"]
    });
    expect(result.passed).toBe(true);
    expect(result.sanitizedError).toBeNull();
  });

  it("7. rejects a node that only claimed done without a structural result", async () => {
    const verification = new VerificationCoordinator(okCheckRunner);
    const result = await verification.verifyNode({
      nodeId: "impl",
      structuralSuccess: false,
      hasExpectedArtifacts: false,
      acceptanceCriteria: ["Build passes"],
      verificationCommands: []
    });
    expect(result.passed).toBe(false);
    expect(result.unmetCriteria).toEqual(["Build passes"]);
    expect(result.sanitizedError).not.toBeNull();
  });

  it("7b. rejects a node whose verification command exits non-zero", async () => {
    const failingRunner: CheckRunner = {
      run: async (command) => ({ command, exitCode: 1, ok: false, summary: "1 test failed" })
    };
    const verification = new VerificationCoordinator(failingRunner);
    const result = await verification.verifyNode({
      nodeId: "impl",
      structuralSuccess: true,
      hasExpectedArtifacts: true,
      acceptanceCriteria: ["Tests pass"],
      verificationCommands: ["pnpm test"]
    });
    expect(result.passed).toBe(false);
    expect(result.sanitizedError).toContain("pnpm test");
  });
});
