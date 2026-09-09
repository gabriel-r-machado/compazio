import { describe, expect, it } from "vitest";

import {
  automaticApprovalFingerprint,
  type AutomaticApprovalRecord,
  type AutomaticRunRecord,
  type SqliteAutomaticRunStore
} from "@forgedeck/local-db";
import type {
  AgentAdapterId,
  AutomaticEvent,
  AutomaticEventType,
  WorkflowDraft
} from "@forgedeck/schemas";
import type { CheckRunner, OrchestratorPort, RunOutcome } from "@forgedeck/orchestration";

import { AutomaticModeService, type OrchestratorSelection } from "./automatic-mode-service";
import type { DesktopWorkflowRunPort } from "./desktop-workflow-run-port";

/**
 * Everything here is scripted: no Claude, no process, no SQLite. The point is the SESSION behaviour â€”
 * approval gating, persistence, resume-on-boot and the events â€” not the pieces already covered elsewhere.
 */

const SAFE_PLAN = {
  title: "Auth",
  summary: "Implement auth and verify it.",
  nodes: [
    {
      id: "impl",
      title: "Implement",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Implement Supabase auth.",
      acceptanceCriteria: ["Build passes"]
    }
  ]
};

const RISKY_PLAN = {
  ...SAFE_PLAN,
  nodes: [{ ...SAFE_PLAN.nodes[0], id: "migrate", operationRisk: "destructive" }]
};

/** An in-memory stand-in with the same contract as the SQLite store. */
class MemoryStore {
  public records = new Map<string, AutomaticRunRecord>();
  public approvals: AutomaticApprovalRecord[] = [];
  public prompts: { runId: string; nodeId: string; prompt: string }[] = [];
  private sequence = 0;

  public create(input: {
    workspaceId: string;
    objective: string;
    mode: string;
    draftId: string;
    state: unknown;
  }): AutomaticRunRecord {
    this.sequence += 1;
    const id = `00000000-0000-4000-8000-00000000000${this.sequence}`;
    const record: AutomaticRunRecord = {
      automaticRunId: id,
      workspaceId: input.workspaceId,
      objective: input.objective,
      mode: input.mode,
      status: "planning",
      draftId: input.draftId,
      currentRunId: null,
      remediationCycle: 0,
      stopReason: null,
      result: null,
      state: input.state,
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z"
    };
    this.records.set(id, record);
    return record;
  }

  public save(input: {
    automaticRunId: string;
    status: AutomaticRunRecord["status"];
    currentRunId?: string | null;
    remediationCycle: number;
    stopReason?: string | null;
    result?: string | null;
    state: unknown;
  }): AutomaticRunRecord {
    const current = this.records.get(input.automaticRunId);
    if (current === undefined) throw new Error("Automatic run was not found");
    const updated: AutomaticRunRecord = {
      ...current,
      status: input.status,
      currentRunId: input.currentRunId === undefined ? current.currentRunId : input.currentRunId,
      remediationCycle: input.remediationCycle,
      stopReason: input.stopReason ?? null,
      result: input.result ?? null,
      state: input.state
    };
    this.records.set(input.automaticRunId, updated);
    return updated;
  }

  public get(id: string): AutomaticRunRecord | null {
    return this.records.get(id) ?? null;
  }

  public list(): readonly AutomaticRunRecord[] {
    return [...this.records.values()];
  }

  public listResumable(): readonly AutomaticRunRecord[] {
    return this.list().filter(
      (record) => record.status === "running" || record.status === "awaiting_approval"
    );
  }

  public requireApproval(input: {
    automaticRunId: string;
    nodeId: string;
    actionFingerprint: string;
  }): AutomaticApprovalRecord {
    const existing = this.getApproval(input);
    if (existing !== null) return existing;
    const record: AutomaticApprovalRecord = {
      approvalId: `approval-${this.approvals.length + 1}`,
      ...input,
      decision: "pending",
      createdAt: "2026-07-25T00:00:00.000Z",
      decidedAt: null
    };
    this.approvals.push(record);
    return record;
  }

  public decideApproval(input: {
    automaticRunId: string;
    nodeId: string;
    actionFingerprint: string;
    decision: "approved" | "rejected";
  }): AutomaticApprovalRecord {
    const index = this.approvals.findIndex(
      (approval) =>
        approval.automaticRunId === input.automaticRunId &&
        approval.nodeId === input.nodeId &&
        approval.actionFingerprint === input.actionFingerprint
    );
    if (index === -1) throw new Error("Automatic approval was not requested");
    const existing = this.approvals[index] as AutomaticApprovalRecord;
    // Idempotent: a decision already taken is never flipped.
    if (existing.decision !== "pending") return existing;
    const updated = {
      ...existing,
      decision: input.decision,
      decidedAt: "2026-07-25T00:00:01.000Z"
    };
    this.approvals[index] = updated;
    return updated;
  }

  public getApproval(input: {
    automaticRunId: string;
    nodeId: string;
    actionFingerprint: string;
  }): AutomaticApprovalRecord | null {
    return (
      this.approvals.find(
        (approval) =>
          approval.automaticRunId === input.automaticRunId &&
          approval.nodeId === input.nodeId &&
          approval.actionFingerprint === input.actionFingerprint
      ) ?? null
    );
  }

  public listApprovals(automaticRunId: string): readonly AutomaticApprovalRecord[] {
    return this.approvals.filter((approval) => approval.automaticRunId === automaticRunId);
  }

  public putNodePrompt(
    _automaticRunId: string,
    prompt: { runId: string; nodeId: string; cycle: number; prompt: string }
  ): void {
    this.prompts.push(prompt);
  }
}

class FakeOrchestrator implements OrchestratorPort {
  public analyzeCalls = 0;
  public constructor(private readonly plan: unknown) {}
  public async analyze(): Promise<unknown> {
    this.analyzeCalls += 1;
    return this.plan;
  }
  public async remediate(): Promise<unknown> {
    return {
      action: "retry_node",
      targetNodeId: "impl",
      reason: "It failed.",
      updatedPrompt: "Fix it."
    };
  }
}

/** Stands in for the run port; records what the session asked the runtime to do. */
class FakePort {
  public starts = 0;
  /** Every draft the session asked to materialize — the revision under test. */
  public materialized: WorkflowDraft[] = [];
  public failMaterialization = false;
  public cancelled: string[] = [];
  public paused: string[] = [];
  public resumed: string[] = [];
  public awaited: string[] = [];
  public constructor(private readonly outcomes: RunOutcome[]) {}
  public async materializeAndStart(draft: WorkflowDraft): Promise<{ runId: string }> {
    if (this.failMaterialization) throw new Error("The draft could not be materialized.");
    this.materialized.push(draft);
    this.starts += 1;
    return { runId: `run-${this.starts}` };
  }
  public async awaitOutcome(runId: string): Promise<RunOutcome> {
    this.awaited.push(runId);
    const next = this.outcomes.shift();
    if (next === undefined) {
      return { runId, state: "succeeded", nodes: [] };
    }
    return { ...next, runId };
  }
  public async retryNode(): Promise<{ runId: string }> {
    this.starts += 1;
    return { runId: `run-${this.starts}` };
  }
  public async addCorrectiveNode(): Promise<{ runId: string }> {
    this.starts += 1;
    return { runId: `run-${this.starts}` };
  }
  public async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
  public async pause(runId: string): Promise<void> {
    this.paused.push(runId);
  }
  public async resumeRun(runId: string): Promise<void> {
    this.resumed.push(runId);
  }
}

const okChecks: CheckRunner = {
  run: async (command) => ({ command, exitCode: 0, ok: true, summary: "ok" })
};

function makeService(
  plan: unknown,
  outcomes: RunOutcome[] = [],
  extra: {
    readonly orchestrators?: OrchestratorSelection;
    readonly defaultOrchestrator?: AgentAdapterId;
    readonly store?: MemoryStore;
  } = {}
): {
  service: AutomaticModeService;
  store: MemoryStore;
  port: FakePort;
  events: AutomaticEvent[];
  orchestrator: FakeOrchestrator;
} {
  const store = extra.store ?? new MemoryStore();
  const port = new FakePort(outcomes);
  const events: AutomaticEvent[] = [];
  const orchestrator = new FakeOrchestrator(plan);
  const service = new AutomaticModeService({
    store: store as unknown as SqliteAutomaticRunStore,
    orchestrator,
    ...(extra.orchestrators === undefined ? {} : { orchestrators: extra.orchestrators }),
    ...(extra.defaultOrchestrator === undefined
      ? {}
      : { defaultOrchestrator: extra.defaultOrchestrator }),
    createRunPort: () => port as unknown as DesktopWorkflowRunPort,
    checkRunner: okChecks,
    publish: (event) => events.push(event)
  });
  return { service, store, port, events, orchestrator };
}

/**
 * A scripted planner selection: two planners, one of them unavailable on demand. It records how many
 * times each planner was actually asked to plan, which is what proves a reload does not re-plan.
 */
function selectionHarness(
  plan: unknown,
  options: { readonly codexAvailable?: boolean } = {}
): {
  readonly selection: OrchestratorSelection;
  readonly planners: Record<AgentAdapterId | string, FakeOrchestrator>;
} {
  const planners: Record<string, FakeOrchestrator> = {
    "claude-code": new FakeOrchestrator(plan),
    codex: new FakeOrchestrator(plan)
  };
  return {
    planners,
    selection: {
      list: async () => [
        {
          id: "claude-code",
          displayName: "Claude Code",
          supportsPlanning: true,
          available: true,
          version: "claude 2.1.220",
          unavailableReason: null,
          supportsRemediation: true
        },
        {
          id: "codex",
          displayName: "Codex",
          supportsPlanning: true,
          available: options.codexAvailable !== false,
          version: options.codexAvailable === false ? null : "codex-cli 0.144.6",
          unavailableReason:
            options.codexAvailable === false ? "Codex is not installed on this machine." : null,
          supportsRemediation: false
        },
        {
          id: "opencode",
          displayName: "OpenCode",
          supportsPlanning: false,
          available: false,
          version: null,
          unavailableReason: "Planning with opencode is not implemented in this version.",
          supportsRemediation: false
        }
      ],
      resolve: (id) => {
        const planner = planners[id];
        if (planner === undefined) return null;
        return {
          port: planner,
          supportsRemediation: id === "claude-code",
          version: () => (id === "codex" ? "codex-cli 0.144.6" : "claude 2.1.220"),
          planHash: () => null
        };
      }
    }
  };
}

function types(events: readonly AutomaticEvent[]): readonly AutomaticEventType[] {
  return events.map((event) => event.type);
}

const objective = {
  workspaceId: "ws-1",
  objective: "Add Supabase auth",
  mode: "standard" as const,
  acceptanceCriteria: []
};

describe("AutomaticModeService", () => {
  it("a safe plan starts automatically, with no approval to give", async () => {
    const { service, port, events } = makeService(SAFE_PLAN, [
      { runId: "run-1", state: "succeeded", nodes: [] }
    ]);
    const created = await service.create(objective);
    expect(created.status).toBe("planning");
    expect(created.pendingApprovals).toEqual([]);
    expect(created.planTitle).toBe("Auth");

    await service.start(created.automaticRunId);
    await service.waitForIdle();
    // The run was materialized exactly once, without any human step in between.
    expect(port.starts).toBe(1);
    expect(types(events)).toContain("automatic.created");
    expect(types(events)).toContain("planning.started");
    expect(types(events)).toContain("planning.completed");
    expect(types(events)).toContain("workflow.started");
  });

  it("a risky plan asks for approval and starts nothing until it is given", async () => {
    const { service, port, events } = makeService(RISKY_PLAN, [
      { runId: "run-1", state: "succeeded", nodes: [] }
    ]);
    const created = await service.create(objective);
    expect(created.status).toBe("awaiting_approval");
    expect(created.pendingApprovals.map((entry) => entry.nodeId)).toEqual(["migrate"]);
    expect(types(events)).toContain("approval.required");

    // Starting while a decision is outstanding must not run anything.
    const blocked = await service.start(created.automaticRunId);
    expect(blocked.status).toBe("awaiting_approval");
    expect(port.starts).toBe(0);

    const approval = created.pendingApprovals[0];
    const released = await service.decide({
      automaticRunId: created.automaticRunId,
      nodeId: approval?.nodeId ?? "",
      actionFingerprint: approval?.actionFingerprint ?? "",
      decision: "approved"
    });
    expect(released.pendingApprovals).toEqual([]);
    await service.waitForIdle();
    // Approving the last outstanding action releases the start, and only then does a run exist.
    expect(port.starts).toBe(1);
  });

  it("an approval is bound to one action and cannot authorize a different one", async () => {
    const { service, store } = makeService(RISKY_PLAN);
    const created = await service.create(objective);
    const approval = created.pendingApprovals[0];
    const other = automaticApprovalFingerprint({
      nodeId: "migrate",
      prompt: "Something else entirely.",
      operationRisk: "destructive",
      operation: "Implement"
    });
    expect(other).not.toBe(approval?.actionFingerprint);
    // The other action was never requested, so no decision can be recorded for it.
    expect(() =>
      store.decideApproval({
        automaticRunId: created.automaticRunId,
        nodeId: "migrate",
        actionFingerprint: other,
        decision: "approved"
      })
    ).toThrow(/not requested/u);
  });

  it("rejecting an approval stops the session without running anything", async () => {
    const { service, port, events } = makeService(RISKY_PLAN);
    const created = await service.create(objective);
    const approval = created.pendingApprovals[0];
    const stopped = await service.decide({
      automaticRunId: created.automaticRunId,
      nodeId: approval?.nodeId ?? "",
      actionFingerprint: approval?.actionFingerprint ?? "",
      decision: "rejected"
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("approval_rejected");
    expect(port.starts).toBe(0);
    expect(types(events)).toContain("automatic.stopped");
  });

  it("a rejected plan never reaches a run and reports why", async () => {
    const { service, port, events } = makeService("just build it");
    const created = await service.create(objective);
    expect(created.status).toBe("rejected");
    expect(created.issues.length).toBeGreaterThan(0);
    expect(port.starts).toBe(0);
    expect(types(events)).toContain("planning.rejected");
  });

  it("pause persists so a reload does not silently continue, and resume returns to running", async () => {
    const { service, store } = makeService(SAFE_PLAN, [
      { runId: "run-1", state: "succeeded", nodes: [] }
    ]);
    const created = await service.create(objective);
    await service.start(created.automaticRunId);
    await service.waitForIdle();
    const paused = await service.pause(created.automaticRunId);
    expect(paused.stopReason).toBe("paused");
    // The pause is in the store, not only in memory.
    expect(store.get(created.automaticRunId)?.stopReason).toBe("paused");

    const resumed = await service.resume(created.automaticRunId);
    expect(resumed.status).toBe("running");
    expect(store.get(created.automaticRunId)?.stopReason).toBeNull();
  });

  it("cancelling stops the session and cancels the official run", async () => {
    const { service, events } = makeService(SAFE_PLAN, [
      {
        runId: "run-1",
        state: "failed",
        nodes: [
          { nodeId: "impl", structuralSuccess: false, hasExpectedArtifacts: false, attempts: 1 }
        ]
      }
    ]);
    const created = await service.create(objective);
    await service.start(created.automaticRunId);
    await service.waitForIdle();
    const cancelled = await service.cancel(created.automaticRunId);
    expect(cancelled.status).toBe("stopped");
    expect(cancelled.stopReason).toBe("cancelled");
    expect(types(events)).toContain("automatic.stopped");
  });

  it("resume-on-boot re-drives an interrupted session without re-planning or a new first run", async () => {
    const { service, store, port, orchestrator } = makeService(SAFE_PLAN, [
      { runId: "run-1", state: "succeeded", nodes: [] }
    ]);
    const created = await service.create(objective);
    await service.start(created.automaticRunId);
    await service.waitForIdle();
    const planningCalls = orchestrator.analyzeCalls;
    const startsAfterFirstRun = port.starts;
    // Simulate the app stopping mid-flight: the session is running and owns run-1.
    const record = store.get(created.automaticRunId);
    store.save({
      automaticRunId: created.automaticRunId,
      status: "running",
      currentRunId: "run-1",
      remediationCycle: 0,
      state: record?.state
    });

    const resumed = await service.resumeInterrupted("ws-1");
    expect(resumed).toEqual([created.automaticRunId]);
    // No second analysis and no second materialization: the lineage was picked up where it stood.
    expect(orchestrator.analyzeCalls).toBe(planningCalls);
    expect(port.starts).toBe(startsAfterFirstRun);
    // It waited on the run the lineage already named.
    expect(port.awaited).toContain("run-1");
  });

  it("resume-on-boot skips a session that has no run yet or still needs a decision", async () => {
    const { service, port } = makeService(RISKY_PLAN);
    await service.create(objective);
    // Awaiting approval and with no run: not eligible, so nothing is driven.
    expect(await service.resumeInterrupted("ws-1")).toEqual([]);
    expect(port.starts).toBe(0);
  });

  it("projects the remaining budget and never leaks a prompt to the renderer", async () => {
    const { service } = makeService(SAFE_PLAN);
    const created = await service.create(objective);
    expect(created.limits.remediationCyclesTotal).toBe(2);
    expect(created.limits.maxWorkflowNodes).toBe(8);
    expect(created.limits.remediationCyclesUsed).toBe(0);
    // The projection carries titles and roles, never the generated prompt text.
    expect(JSON.stringify(created)).not.toContain("Implement Supabase auth.");
  });
});

/**
 * WHO PLANS is chosen once, recorded once, and read back forever after. It is never re-chosen on a
 * reload, never inferred from the node adapters, and never swapped for a planner that happens to be
 * installed â€” an unavailable choice blocks planning with its own reason instead.
 */
describe("AutomaticModeService orchestrator selection", () => {
  it("records who planned, with version, strategy and plan hash", async () => {
    const harness = selectionHarness(SAFE_PLAN);
    const { service } = makeService(SAFE_PLAN, [], {
      orchestrators: harness.selection,
      defaultOrchestrator: "claude-code"
    });
    const created = await service.create({
      workspaceId: "ws-1",
      objective: "Add auth",
      mode: "standard",
      acceptanceCriteria: [],
      orchestratorAdapter: "codex"
    });
    expect(created.orchestrator).toMatchObject({
      adapter: "codex",
      version: "codex-cli 0.144.6",
      strategy: "standard",
      supportsRemediation: false
    });
    expect(created.orchestrator?.planHash).toMatch(/^[a-f0-9]{64}$/u);
    // The chosen planner is the one that planned; the other was never asked.
    expect(harness.planners["codex"]?.analyzeCalls).toBe(1);
    expect(harness.planners["claude-code"]?.analyzeCalls).toBe(0);
  });

  it("21/22. a reload shows the planner without ever planning again", async () => {
    const harness = selectionHarness(SAFE_PLAN);
    const store = new MemoryStore();
    const first = makeService(SAFE_PLAN, [], {
      orchestrators: harness.selection,
      defaultOrchestrator: "claude-code",
      store
    });
    const created = await first.service.create({
      workspaceId: "ws-1",
      objective: "Add auth",
      mode: "standard",
      acceptanceCriteria: [],
      orchestratorAdapter: "codex"
    });
    const plannedBefore = harness.planners["codex"]?.analyzeCalls ?? 0;

    // A fresh service over the SAME persistence: this is the reload.
    const second = makeService(SAFE_PLAN, [], {
      orchestrators: harness.selection,
      defaultOrchestrator: "claude-code",
      store
    });
    const reloaded = second.service.show(created.automaticRunId);
    expect(reloaded.orchestrator?.adapter).toBe("codex");
    expect(reloaded.orchestrator?.version).toBe("codex-cli 0.144.6");
    expect(reloaded.planTitle).toBe(created.planTitle);
    // Nothing planned again: the count did not move.
    expect(harness.planners["codex"]?.analyzeCalls).toBe(plannedBefore);
    expect(harness.planners["claude-code"]?.analyzeCalls).toBe(0);
  });

  it("blocks planning when the chosen planner is unavailable, without falling back", async () => {
    const harness = selectionHarness(SAFE_PLAN, { codexAvailable: false });
    const { service } = makeService(SAFE_PLAN, [], {
      orchestrators: harness.selection,
      defaultOrchestrator: "claude-code"
    });
    const created = await service.create({
      workspaceId: "ws-1",
      objective: "Add auth",
      mode: "standard",
      acceptanceCriteria: [],
      orchestratorAdapter: "codex"
    });
    expect(created.status).toBe("rejected");
    expect(created.stopReason).toBe("planner_unavailable");
    expect(created.result).toContain("Codex is not installed");
    // No planner was asked to plan: not the unavailable one, and certainly not another one.
    expect(harness.planners["codex"]?.analyzeCalls).toBe(0);
    expect(harness.planners["claude-code"]?.analyzeCalls).toBe(0);
    expect(created.orchestrator?.adapter).toBe("codex");
  });

  it("refuses a planner this version does not implement, and names why", async () => {
    const harness = selectionHarness(SAFE_PLAN);
    const { service } = makeService(SAFE_PLAN, [], { orchestrators: harness.selection });
    const created = await service.create({
      workspaceId: "ws-1",
      objective: "Add auth",
      mode: "standard",
      acceptanceCriteria: [],
      orchestratorAdapter: "opencode"
    });
    expect(created.status).toBe("rejected");
    expect(created.result).toContain("not implemented");
    expect(harness.planners["claude-code"]?.analyzeCalls).toBe(0);
  });

  it("11. the budget preset never changes the chosen planner", async () => {
    const harness = selectionHarness(SAFE_PLAN);
    const { service } = makeService(SAFE_PLAN, [], {
      orchestrators: harness.selection,
      defaultOrchestrator: "claude-code"
    });
    for (const mode of ["economic", "standard", "high-performance"] as const) {
      const created = await service.create({
        workspaceId: "ws-1",
        objective: `Add auth in ${mode}`,
        mode,
        acceptanceCriteria: [],
        orchestratorAdapter: "codex"
      });
      expect(created.orchestrator?.adapter).toBe("codex");
      expect(created.orchestrator?.strategy).toBe(mode);
    }
    expect(harness.planners["claude-code"]?.analyzeCalls).toBe(0);
  });

  it("26. a session recorded before planners were selectable stays readable, as unknown", () => {
    const store = new MemoryStore();
    const legacy = store.create({
      workspaceId: "ws-1",
      objective: "Legacy objective",
      mode: "standard",
      draftId: "draft-1",
      // Exactly the shape earlier versions persisted: a plan and a request, and no planner at all.
      state: {
        request: {
          workspaceId: "ws-1",
          objective: "Legacy objective",
          mode: "standard",
          limits: {
            maxWorkflowNodes: 8,
            maxRemediationCycles: 2,
            maxAttemptsPerNode: 2,
            timeoutMs: 2_700_000
          }
        },
        // Persisted plans are schema-parsed, so the defaults are present on disk.
        plan: {
          ...SAFE_PLAN,
          assumptions: [],
          needsHumanApproval: false,
          nodes: SAFE_PLAN.nodes.map((node) => ({
            ...node,
            dependsOn: [],
            allowedAreas: [],
            expectedArtifacts: [],
            verificationCommands: [],
            operationRisk: "safe",
            requiresHumanApproval: false
          }))
        },
        draftId: "draft-1",
        runIds: ["run-1"],
        remediationCycle: 0,
        startedAtMs: 0
      }
    });
    const { service } = makeService(SAFE_PLAN, [], {
      orchestrators: selectionHarness(SAFE_PLAN).selection,
      defaultOrchestrator: "claude-code",
      store
    });
    const snapshot = service.show(legacy.automaticRunId);
    // Readable, with its plan intact â€” and honestly unknown, never inferred from the node adapters.
    expect(snapshot.planTitle).toBe("Auth");
    expect(snapshot.nodes.map((node) => node.nodeId)).toEqual(["impl"]);
    expect(snapshot.orchestrator).toBeNull();
  });
});

/**
 * The orchestrator is called once per planning REVIEW — never again by starting. Before this, create()
 * composed the plan the human saw and start() composed a second time before materializing: two paid
 * turns, and a real risk of running a plan nobody approved.
 */
describe("AutomaticModeService plan lifecycle", () => {
  /** A planner that would answer differently every time, so a second call cannot hide. */
  class DriftingOrchestrator implements OrchestratorPort {
    public analyzeCalls = 0;
    public async analyze(): Promise<unknown> {
      this.analyzeCalls += 1;
      return {
        ...SAFE_PLAN,
        title: `Auth ${String(this.analyzeCalls)}`
      };
    }
    public async remediate(): Promise<unknown> {
      return { action: "retry_node", targetNodeId: "impl", reason: "x", updatedPrompt: "y" };
    }
  }

  function lifecycle(
    outcomes: RunOutcome[] = [],
    store = new MemoryStore(),
    now?: () => Date
  ): {
    readonly service: AutomaticModeService;
    readonly store: MemoryStore;
    readonly port: FakePort;
    readonly planner: DriftingOrchestrator;
  } {
    const port = new FakePort(outcomes);
    const planner = new DriftingOrchestrator();
    const service = new AutomaticModeService({
      store: store as unknown as SqliteAutomaticRunStore,
      orchestrator: planner,
      defaultOrchestrator: "claude-code",
      createRunPort: () => port as unknown as DesktopWorkflowRunPort,
      checkRunner: okChecks,
      publish: () => undefined,
      ...(now === undefined ? {} : { now })
    });
    return { service, store, port, planner };
  }

  async function created(service: AutomaticModeService) {
    return service.create({
      workspaceId: "ws-1",
      objective: "Add auth",
      mode: "standard",
      acceptanceCriteria: []
    });
  }

  it("1/2/3/5. create plans once, and start plans zero times", async () => {
    const harness = lifecycle();
    const session = await created(harness.service);
    expect(harness.planner.analyzeCalls).toBe(1);

    await harness.service.start(session.automaticRunId);
    await harness.service.waitForIdle();
    // The drifting planner would have produced a different plan on a second call; it was never asked.
    expect(harness.planner.analyzeCalls).toBe(1);
    expect(harness.service.show(session.automaticRunId).planTitle).toBe("Auth 1");
  });

  it("recovers an identical recent unstarted draft only for an explicit retry", async () => {
    // The age window is measured against a pinned clock, so this proves the recovery rule rather
    // than how far the wall clock has drifted from the store fixture's timestamps.
    const harness = lifecycle([], new MemoryStore(), () => new Date("2026-07-25T01:00:00.000Z"));
    const session = await created(harness.service);
    const original = harness.service.draft(session.automaticRunId);

    const recovered = harness.service.recoverRecentDraft({
      workspaceId: "ws-1",
      objective: "Add auth",
      mode: "standard",
      orchestratorAdapter: "claude-code",
      maxAgeMs: 2 * 24 * 60 * 60_000
    });
    const differentObjective = harness.service.recoverRecentDraft({
      workspaceId: "ws-1",
      objective: "Build billing",
      mode: "standard",
      orchestratorAdapter: "claude-code",
      maxAgeMs: 2 * 24 * 60 * 60_000
    });

    expect(recovered?.id).toBe(original?.id);
    expect(differentObjective).toBeNull();
    expect(harness.planner.analyzeCalls).toBe(1);
  });

  it("4/6. start materializes exactly the plan create returned, hash included", async () => {
    const harness = lifecycle();
    const session = await created(harness.service);
    const planHash = session.orchestrator?.planHash;
    expect(planHash).toMatch(/^[a-f0-9]{64}$/u);

    await harness.service.start(session.automaticRunId);
    await harness.service.waitForIdle();
    const after = harness.service.show(session.automaticRunId);
    expect(after.planTitle).toBe(session.planTitle);
    expect(after.orchestrator?.planHash).toBe(planHash);
    expect(after.orchestrator?.materializedDraftHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.planner.analyzeCalls).toBe(1);
  });

  it("7/8. changing an assignment moves the draft hash, never the plan hash", async () => {
    const harness = lifecycle();
    const session = await created(harness.service);
    const before = session.orchestrator;

    const revised = harness.service.updateAssignments({
      automaticRunId: session.automaticRunId,
      assignments: { impl: "codex" }
    });
    expect(revised.orchestrator?.planHash).toBe(before?.planHash);
    expect(revised.orchestrator?.draftHash).not.toBe(before?.draftHash);
    // The revision carries the new executor, and no planning happened to get there.
    expect(harness.planner.analyzeCalls).toBe(1);

    await harness.service.start(session.automaticRunId);
    await harness.service.waitForIdle();
    expect(harness.port.materialized[0]?.nodes[0]?.agentAssignment?.assignedAdapter).toBe("codex");
    expect(harness.planner.analyzeCalls).toBe(1);
  });

  it("9/10/11/12. a planning input change marks the plan stale and start refuses", async () => {
    const harness = lifecycle();
    const session = await created(harness.service);
    const stale = harness.service.invalidatePlan({
      automaticRunId: session.automaticRunId,
      reason: "The objective changed."
    });
    expect(stale.planStale).toBe(true);

    const blocked = await harness.service.start(session.automaticRunId);
    expect(blocked.stopReason).toBe("plan_stale");
    expect(harness.port.starts).toBe(0);
    // Nothing was regenerated on its own: replanning stays an explicit decision.
    expect(harness.planner.analyzeCalls).toBe(1);
  });

  it("13. a reload followed by start does not replan", async () => {
    const store = new MemoryStore();
    const first = lifecycle([], store);
    const session = await created(first.service);
    expect(first.planner.analyzeCalls).toBe(1);

    // A fresh service over the SAME persistence: this is the reload.
    const second = lifecycle([], store);
    await second.service.start(session.automaticRunId);
    await second.service.waitForIdle();
    expect(second.planner.analyzeCalls).toBe(0);
    expect(first.planner.analyzeCalls).toBe(1);
    expect(second.port.starts).toBe(1);
  });

  it("14/15. repeated and concurrent starts create at most one run", async () => {
    const harness = lifecycle();
    const session = await created(harness.service);
    await Promise.all([
      harness.service.start(session.automaticRunId),
      harness.service.start(session.automaticRunId),
      harness.service.start(session.automaticRunId)
    ]);
    await harness.service.waitForIdle();
    await harness.service.start(session.automaticRunId);
    await harness.service.waitForIdle();
    expect(harness.port.starts).toBe(1);
    expect(harness.planner.analyzeCalls).toBe(1);
  });

  it("16/17. a materialization or executor failure never calls the planner", async () => {
    const failing = lifecycle([{ runId: "run-1", state: "failed", nodes: [] }]);
    const session = await created(failing.service);
    await failing.service.start(session.automaticRunId);
    await failing.service.waitForIdle();
    expect(failing.planner.analyzeCalls).toBe(1);

    const broken = lifecycle();
    broken.port.failMaterialization = true;
    const second = await created(broken.service);
    await broken.service.start(second.automaticRunId);
    await broken.service.waitForIdle();
    expect(broken.planner.analyzeCalls).toBe(1);
    expect(broken.service.show(second.automaticRunId).status).toBe("stopped");
  });

  it("18. a session persisted before revisions were stored still starts its own plan", async () => {
    const harness = lifecycle();
    const legacy = harness.store.create({
      workspaceId: "ws-1",
      objective: "Legacy objective",
      mode: "standard",
      draftId: "",
      state: {
        request: {
          workspaceId: "ws-1",
          objective: "Legacy objective",
          mode: "standard",
          limits: {
            maxWorkflowNodes: 8,
            maxRemediationCycles: 2,
            maxAttemptsPerNode: 2,
            timeoutMs: 2_700_000
          }
        },
        plan: {
          ...SAFE_PLAN,
          assumptions: [],
          needsHumanApproval: false,
          nodes: SAFE_PLAN.nodes.map((node) => ({
            ...node,
            dependsOn: [],
            allowedAreas: [],
            expectedArtifacts: [],
            verificationCommands: [],
            operationRisk: "safe",
            requiresHumanApproval: false
          }))
        },
        draftId: "",
        runIds: [],
        remediationCycle: 0,
        startedAtMs: 0
      }
    });
    await harness.service.start(legacy.automaticRunId);
    await harness.service.waitForIdle();
    // It ran, from its own stored plan, without a planning call of any kind.
    expect(harness.port.starts).toBe(1);
    expect(harness.planner.analyzeCalls).toBe(0);
  });
});
