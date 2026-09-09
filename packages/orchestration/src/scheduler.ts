import { createHash } from "node:crypto";

import type { Evidence, PermissionMap, Workflow, WorkflowNode } from "@forgedeck/workflow";
import { createDryRunPlan, validateWorkflowDag, workflowSchema } from "@forgedeck/workflow";

import type {
  ApprovalDecision,
  ArtifactRegistry,
  AutonomyGateAction,
  AutonomyGateDecision,
  NodeExecutionResult,
  NodeFailureReason,
  NodeRunSnapshot,
  RunEvent,
  RunEventType,
  RunState,
  RunStore,
  ResourceLockManager,
  SchedulerRunAutonomy,
  SchedulerStartInput,
  WorkflowNodeExecutor,
  WorkflowRunExecutionContext,
  WorkflowRunExecutionContextLifecycle,
  WorkflowRunHandle,
  WorkflowRunSnapshot
} from "./contracts";
import { InMemoryResourceLockManager } from "./memory-ports";

interface SchedulerOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly lockManager?: ResourceLockManager;
}

interface MutableNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  state: NodeRunSnapshot["state"];
  attempt: number;
  inputHash: string;
  idempotencyKey: string;
  evidence: Evidence[];
  failureReason: NodeFailureReason | null;
}

interface MutableRun {
  readonly id: string;
  readonly workflow: Workflow;
  readonly dryRun: boolean;
  readonly grantedPermissions: PermissionMap;
  state: RunState;
  startedAt: string | null;
  endedAt: string | null;
  readonly nodes: Map<string, MutableNodeRun>;
  readonly events: RunEvent[];
  readonly abortController: AbortController;
  pauseRequested: boolean;
  cancelRequested: boolean;
  /** Set by {@link DeterministicScheduler.close}: the host is going away, so the run is interrupted. */
  shutdownRequested: boolean;
  /** Set once the run entered its terminal commit; a shutdown must wait for it instead of interrupting it. */
  finalizing: boolean;
  resumeWaiters: (() => void)[];
  reportArtifact: WorkflowRunSnapshot["reportArtifact"];
  readonly lineage: Exclude<WorkflowRunSnapshot["lineage"], undefined>;
  executionContext: WorkflowRunExecutionContext | null;
  readonly executionContextLifecycle: WorkflowRunExecutionContextLifecycle | null;
  workflowHash: string;
  inputHash: string;
  eventSequence: number;
  /** Present only for supervised/autonomous runs; the scheduler consults it before automatic actions. */
  readonly autonomy: SchedulerRunAutonomy | null;
  readonly prepareRun: ((runId: string) => Promise<void> | void) | null;
  readonly agentNodeIds: ReadonlySet<string>;
  spawnedAgents: number;
}

interface PendingApproval {
  readonly runId: string;
  readonly nodeId: string;
  readonly resolve: (decision: ApprovalDecision) => void;
}

const failedDependencyStates = new Set<NodeRunSnapshot["state"]>([
  "failed",
  "blocked",
  "cancelled"
]);

const terminalRunStates = new Set<RunState>(["succeeded", "failed", "cancelled", "interrupted"]);

export class DeterministicScheduler {
  private readonly runs = new Map<string, MutableRun>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly locks: ResourceLockManager;
  /** In-flight runs, keyed by run id. Each entry settles only after the terminal write committed. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** First real persistence failure. It is sticky, because a broken store poisons every later claim. */
  private persistenceFailure: unknown = null;
  private closing = false;
  private closed: Promise<void> | null = null;

  public constructor(
    private readonly executor: WorkflowNodeExecutor,
    private readonly store: RunStore,
    private readonly artifacts: ArtifactRegistry,
    options: SchedulerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => crypto.randomUUID());
    this.sleep = options.sleep ?? delay;
    this.locks = options.lockManager ?? new InMemoryResourceLockManager();
  }

  public start(input: SchedulerStartInput): WorkflowRunHandle {
    if (this.closing) {
      throw new Error("Workflow scheduler is shutting down and cannot accept new runs");
    }
    const immutableWorkflow = workflowSchema.parse(input.workflow);
    const validation = validateWorkflowDag(immutableWorkflow, input.grantedPermissions);
    if (!validation.valid) {
      throw new Error(
        `Invalid workflow: ${validation.issues.map((issue) => issue.message).join("; ")}`
      );
    }
    if (
      !(input.dryRun ?? false) &&
      immutableWorkflow.nodes.some((node) => node.isolation === "git_worktree") &&
      input.availableCapabilities?.gitWorktree !== true
    ) {
      throw new Error(
        "Workflow requires git_worktree capability, which is not available in this phase"
      );
    }
    const runId = input.runId ?? this.id();
    if (!/^[A-Za-z0-9_-]+$/.test(runId) || this.runs.has(runId)) {
      throw new Error("Workflow run id is invalid or already active");
    }
    const workflowHash = hashValue(immutableWorkflow);
    const inputHash = hashValue(immutableWorkflow.inputs);
    const run: MutableRun = {
      id: runId,
      workflow: immutableWorkflow,
      dryRun: input.dryRun ?? false,
      grantedPermissions: { ...input.grantedPermissions },
      state: "created",
      startedAt: null,
      endedAt: null,
      nodes: new Map(
        immutableWorkflow.nodes.map((node) => [
          node.id,
          {
            id: this.id(),
            runId,
            nodeId: node.id,
            state: "pending" as const,
            attempt: 0,
            inputHash: hashValue({ workflow: inputHash, nodeId: node.id }),
            idempotencyKey: `${runId}:${node.id}:0:${inputHash}`,
            evidence: [],
            failureReason: null
          }
        ])
      ),
      events: [],
      abortController: new AbortController(),
      pauseRequested: false,
      cancelRequested: false,
      shutdownRequested: false,
      finalizing: false,
      resumeWaiters: [],
      reportArtifact: null,
      lineage: input.lineage ?? null,
      executionContext:
        input.executionContext === undefined
          ? null
          : { ...input.executionContext.context, deliveryCheckpoint: null },
      executionContextLifecycle: input.executionContext ?? null,
      workflowHash,
      inputHash,
      eventSequence: 0,
      autonomy: input.autonomy ?? null,
      prepareRun: input.prepareRun ?? null,
      agentNodeIds: new Set(
        immutableWorkflow.nodes.filter((node) => node.type === "agent").map((node) => node.id)
      ),
      spawnedAgents: 0
    };
    this.runs.set(runId, run);
    const completion = this.executeRun(run).catch(async (error: unknown) => {
      const state = this.terminalRunState(run, "failed");
      await this.commitTerminal(run, { ...toSnapshot(run), state }, terminalEventType(state), {
        reason: error instanceof Error ? error.message : "Unknown scheduler error"
      });
      return toSnapshot(run);
    });
    this.track(runId, completion);
    return { runId, completion };
  }

  /**
   * Keeps one settled-tracking promise per in-flight run so {@link drain} can wait for every terminal
   * write. It also owns the rejection: a persistence failure is recorded here instead of escaping as an
   * unhandled rejection when the caller discarded the handle (materialized runs do exactly that).
   */
  private track(runId: string, completion: Promise<WorkflowRunSnapshot>): void {
    const tracked = completion
      .then(
        () => undefined,
        (error: unknown) => {
          if (this.persistenceFailure === null) this.persistenceFailure = error;
        }
      )
      .finally(() => {
        this.inFlight.delete(runId);
      });
    this.inFlight.set(runId, tracked);
  }

  /**
   * Resolves once every in-flight run committed its terminal transition durably. It never inspects the
   * in-memory snapshot: a run is drained only when its store write resolved. A real persistence failure
   * is rethrown, so a caller can never mistake a broken store for a clean shutdown.
   */
  public async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
    if (this.persistenceFailure !== null) {
      throw this.persistenceFailure instanceof Error
        ? this.persistenceFailure
        : new Error(String(this.persistenceFailure));
    }
  }

  /**
   * Ordered scheduler shutdown: stop accepting runs, interrupt everything still in flight, release every
   * waiter that could block the unwind, then drain. A run that already entered its terminal commit is
   * awaited rather than interrupted, so a finishing run is never downgraded. Idempotent.
   */
  public async close(): Promise<void> {
    this.closed ??= this.shutdown();
    await this.closed;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    for (const run of this.runs.values()) {
      if (run.finalizing || terminalRunStates.has(run.state)) continue;
      run.shutdownRequested = true;
      run.pauseRequested = false;
      run.abortController.abort();
      for (const resolve of run.resumeWaiters.splice(0)) resolve();
    }
    // Approvals would otherwise block forever; a host shutdown is never an approval.
    for (const [key, approval] of [...this.approvals.entries()]) {
      this.approvals.delete(key);
      approval.resolve({ approved: false, note: "Local host shutdown" });
    }
    await this.drain();
  }

  public getRun(runId: string): WorkflowRunSnapshot {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown workflow run: ${runId}`);
    }
    return toSnapshot(run);
  }

  public async pause(runId: string): Promise<WorkflowRunSnapshot> {
    const run = this.requireRun(runId);
    if (run.state !== "running") throw new Error(`Workflow run cannot pause from ${run.state}`);
    run.pauseRequested = true;
    run.state = "paused";
    await this.persistRunTransition(run, "run.paused", {});
    return toSnapshot(run);
  }

  public async resume(runId: string): Promise<WorkflowRunSnapshot> {
    const run = this.requireRun(runId);
    if (run.state !== "paused") throw new Error(`Workflow run cannot resume from ${run.state}`);
    run.pauseRequested = false;
    run.state = "running";
    const waiters = run.resumeWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
    await this.persistRunTransition(run, "run.resumed", {});
    return toSnapshot(run);
  }

  public async cancel(runId: string): Promise<WorkflowRunSnapshot> {
    const run = this.requireRun(runId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(run.state)) {
      throw new Error(`Workflow run cannot cancel from ${run.state}`);
    }
    run.cancelRequested = true;
    run.pauseRequested = false;
    run.abortController.abort();
    const waiters = run.resumeWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
    for (const [key, approval] of this.approvals.entries()) {
      if (approval.runId !== runId) continue;
      this.approvals.delete(key);
      approval.resolve({ approved: false, note: "Cancelled by local user" });
    }
    return toSnapshot(run);
  }

  public async resolveApproval(
    runId: string,
    nodeId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const key = approvalKey(runId, nodeId);
    const approval = this.approvals.get(key);
    if (approval === undefined) {
      throw new Error(`No approval is pending for node ${nodeId}`);
    }
    this.approvals.delete(key);
    approval.resolve(decision);
  }

  private async executeRun(run: MutableRun): Promise<WorkflowRunSnapshot> {
    const createdEvent = this.createEvent(run, "run.created", null, { dryRun: run.dryRun });
    await this.store.createRun(toSnapshot(run), run.workflow, createdEvent);
    await run.prepareRun?.(run.id);
    run.state = "running";
    run.startedAt = this.now().toISOString();
    await this.persistRunTransition(run, "run.started", {
      concurrency: run.workflow.concurrency
    });

    if (run.dryRun) {
      const plan = createDryRunPlan(run.workflow, run.grantedPermissions);
      for (const nodeRun of run.nodes.values()) {
        nodeRun.state = "skipped";
        await this.store.saveNodeRun(toNodeSnapshot(nodeRun));
      }
      await this.finishWithReport(run, "succeeded", { dryRunPlan: plan });
      return toSnapshot(run);
    }

    const pending = new Set(run.workflow.nodes.map((node) => node.id));
    while (pending.size > 0) {
      await this.waitUntilRunnable(run);
      if (this.stopRequested(run)) {
        await this.stopPendingNodes(run, pending);
        break;
      }
      await this.blockFailedDependents(run, pending);
      const ready = run.workflow.nodes
        .filter((node) => pending.has(node.id) && dependenciesSucceeded(run, node))
        .sort((left, right) => left.id.localeCompare(right.id));

      if (ready.length === 0) {
        if (pending.size > 0) {
          throw new Error("Scheduler reached an invalid dependency state");
        }
        break;
      }

      const batch = ready.slice(0, run.workflow.concurrency);
      for (const node of batch) {
        const nodeRun = requireNodeRun(run, node.id);
        nodeRun.state = "ready";
        await this.persistNodeTransition(run, nodeRun, "node.ready", { nodeId: node.id });
      }
      await Promise.all(batch.map((node) => this.executeNode(run, node)));
      for (const node of batch) {
        pending.delete(node.id);
      }
    }

    const terminal = this.terminalRunState(run, "succeeded");
    if (terminal === "interrupted") {
      // A host shutdown produces no delivery checkpoint and no final report: the run never concluded.
      await this.finishInterrupted(run);
    } else {
      await this.finishWithReport(run, terminal, {});
    }
    return toSnapshot(run);
  }

  /**
   * The official outcome of a settled run. A host shutdown wins over every other outcome, because an
   * interrupted run did not conclude — that is exactly the state a crash would leave behind, and the
   * reload contract already treats it as such.
   */
  private terminalRunState(run: MutableRun, fallback: RunState): RunState {
    if (run.shutdownRequested) return "interrupted";
    if ([...run.nodes.values()].some((node) => node.state === "failed")) return "failed";
    if (run.cancelRequested) return "cancelled";
    return fallback;
  }

  private stopRequested(run: MutableRun): boolean {
    return run.cancelRequested || run.shutdownRequested;
  }

  private async blockFailedDependents(run: MutableRun, pending: Set<string>): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of run.workflow.nodes) {
        if (!pending.has(node.id)) {
          continue;
        }
        const failedDependency = node.depends_on.find((dependency) =>
          failedDependencyStates.has(requireNodeRun(run, dependency).state)
        );
        if (failedDependency === undefined) {
          continue;
        }
        const nodeRun = requireNodeRun(run, node.id);
        nodeRun.state = "blocked";
        nodeRun.failureReason = "unknown_error";
        pending.delete(node.id);
        changed = true;
        await this.persistNodeTransition(run, nodeRun, "node.blocked", {
          nodeId: node.id,
          failedDependency
        });
      }
    }
  }

  private async executeNode(run: MutableRun, node: WorkflowNode): Promise<void> {
    const nodeRun = requireNodeRun(run, node.id);
    await this.waitUntilRunnable(run);
    if (this.stopRequested(run)) {
      await this.persistNodeStop(run, nodeRun);
      return;
    }
    if (node.type === "human_approval") {
      await this.waitForApproval(run, nodeRun);
      return;
    }

    // Supervised/autonomous runs check the guardrail before any forward step so the durable kill
    // switch and the runtime budget stop every node type immediately. Assisted/manual runs skip it.
    if (run.autonomy !== null) {
      const proceed = await this.gateForwardStep(run, node, nodeRun, "continue_approved_step");
      if (!proceed) return;
      if (run.agentNodeIds.has(node.id)) {
        const spawnApproved = await this.gateForwardStep(run, node, nodeRun, "spawn_agent");
        if (!spawnApproved) return;
        run.spawnedAgents += 1;
      }
    }

    const releaseLocks = await this.locks.acquire(
      node.resources.map((resource) => `${resource.type}:${resource.key}`),
      nodeRun.id
    );
    try {
      await this.executeNodeWithRetry(run, node, nodeRun);
    } finally {
      releaseLocks();
    }
  }

  /**
   * Assesses one automatic forward action. On `allow` execution continues. On `stop` the node is
   * blocked (and a kill-switch stop cancels the run so nothing else advances). On `require_approval`
   * the node waits for an explicit human decision; approval lets it proceed, denial fails it. Every
   * decision is recorded by the gate in the durable audit before this returns.
   */
  private async gateForwardStep(
    run: MutableRun,
    node: WorkflowNode,
    nodeRun: MutableNodeRun,
    action: AutonomyGateAction
  ): Promise<boolean> {
    if (run.autonomy === null) return true;
    const decision = await run.autonomy.gate.assess({
      runId: run.id,
      nodeId: node.id,
      action,
      state: this.autonomyState(run, nodeRun)
    });
    if (decision.outcome === "allow") return true;
    if (decision.outcome === "stop") {
      // The kill switch cancels the whole run (node stays blocked so the run reads "cancelled").
      // Any other stop (quota or runtime budget) fails just this node and needs a human.
      if (decision.rule === "kill_switch") {
        nodeRun.state = "blocked";
        nodeRun.failureReason = null;
        await this.persistNodeTransition(run, nodeRun, "node.blocked", {
          nodeId: node.id,
          autonomyAction: action,
          autonomyRule: decision.rule
        });
        await this.cancel(run.id);
        return false;
      }
      nodeRun.state = "failed";
      nodeRun.failureReason = "permission_denied";
      await this.persistNodeTransition(run, nodeRun, "node.failed", {
        nodeId: node.id,
        autonomyAction: action,
        autonomyRule: decision.rule,
        reason: "permission_denied"
      });
      return false;
    }
    const approved = await this.awaitAutonomyApproval(run, nodeRun, action, decision.rule);
    if (approved) return true;
    nodeRun.state = "failed";
    nodeRun.failureReason = "approval_denied";
    await this.persistNodeTransition(run, nodeRun, "node.failed", {
      nodeId: node.id,
      autonomyAction: action,
      reason: "approval_denied"
    });
    return false;
  }

  private autonomyState(
    run: MutableRun,
    nodeRun: MutableNodeRun
  ): {
    readonly nodeAttempts: number;
    readonly concurrentAgents: number;
    readonly spawnedAgents: number;
    readonly elapsedMinutes: number;
  } {
    const startedAt = run.startedAt === null ? this.now() : new Date(run.startedAt);
    const concurrentAgents = [...run.nodes.values()].filter(
      (candidate) => candidate.state === "running" && run.agentNodeIds.has(candidate.nodeId)
    ).length;
    return {
      nodeAttempts: nodeRun.attempt,
      concurrentAgents,
      spawnedAgents: run.spawnedAgents,
      elapsedMinutes: Math.max(0, (this.now().getTime() - startedAt.getTime()) / 60_000)
    };
  }

  private async awaitAutonomyApproval(
    run: MutableRun,
    nodeRun: MutableNodeRun,
    action: AutonomyGateAction,
    rule: string
  ): Promise<boolean> {
    nodeRun.state = "waiting";
    run.state = "waiting";
    await this.persistNodeTransition(run, nodeRun, "node.waiting", {
      nodeId: nodeRun.nodeId,
      autonomyAction: action,
      autonomyRule: rule
    });
    await this.appendEvent(run, "approval.requested", nodeRun.id, {
      nodeId: nodeRun.nodeId,
      autonomyAction: action
    });
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(approvalKey(run.id, nodeRun.nodeId), {
        runId: run.id,
        nodeId: nodeRun.nodeId,
        resolve
      });
    });
    run.state = "running";
    return decision.approved && !this.stopRequested(run);
  }

  private async executeNodeWithRetry(
    run: MutableRun,
    node: WorkflowNode,
    nodeRun: MutableNodeRun
  ): Promise<void> {
    const maxAttempts = node.retry.max_attempts;
    while (nodeRun.attempt < maxAttempts) {
      await this.waitUntilRunnable(run);
      if (this.stopRequested(run)) {
        await this.persistNodeStop(run, nodeRun);
        return;
      }
      nodeRun.attempt += 1;
      nodeRun.idempotencyKey = `${run.id}:${node.id}:${nodeRun.attempt}:${nodeRun.inputHash}`;
      nodeRun.state = "running";
      await this.persistNodeTransition(run, nodeRun, "node.started", {
        nodeId: node.id,
        attempt: nodeRun.attempt
      });

      let result: NodeExecutionResult;
      try {
        result = await this.executor.execute(node, {
          runId: run.id,
          nodeRunId: nodeRun.id,
          attempt: nodeRun.attempt,
          workflowVersion: run.workflow.schema_version,
          grantedPermissions: run.grantedPermissions,
          abortSignal: run.abortController.signal
        });
      } catch (error: unknown) {
        result = {
          success: false,
          reason: "unknown_error",
          message: error instanceof Error ? error.message : "Node executor failed",
          evidence: []
        };
      }

      if (this.stopRequested(run)) {
        await this.persistNodeStop(run, nodeRun);
        return;
      }

      if (result.success && result.evidence.length > 0) {
        nodeRun.state = "succeeded";
        nodeRun.evidence = [...result.evidence];
        nodeRun.failureReason = null;
        await this.persistNodeTransition(run, nodeRun, "node.succeeded", {
          nodeId: node.id,
          attempt: nodeRun.attempt,
          evidenceCount: result.evidence.length
        });
        return;
      }

      const failure: Extract<NodeExecutionResult, { success: false }> = result.success
        ? {
            success: false,
            reason: "missing_evidence",
            message: "A completed node must provide evidence",
            evidence: []
          }
        : result;
      nodeRun.failureReason = failure.reason;
      nodeRun.evidence = [...failure.evidence];
      const retryable =
        nodeRun.attempt < maxAttempts &&
        node.retry.retry_on.some((reason) => reason === failure.reason);
      if (retryable) {
        // In supervised/autonomous runs an automatic retry needs the guardrail's approval: the
        // retry quota, runtime budget and kill switch all apply here. A blocked retry leaves the
        // node failed instead of silently retrying.
        const retryDecision =
          run.autonomy === null ? null : await this.gateRetry(run, node, nodeRun);
        if (retryDecision !== null && retryDecision.outcome !== "allow") {
          nodeRun.state = "failed";
          await this.persistNodeTransition(run, nodeRun, "node.failed", {
            nodeId: node.id,
            attempt: nodeRun.attempt,
            reason: failure.reason,
            autonomyAction: "retry_node",
            autonomyRule: retryDecision.rule
          });
          if (retryDecision.rule === "kill_switch") await this.cancel(run.id);
          return;
        }
        await this.appendEvent(run, "node.retry_scheduled", nodeRun.id, {
          nodeId: node.id,
          attempt: nodeRun.attempt,
          reason: failure.reason,
          backoffMs: node.retry.backoff_ms
        });
        await this.sleep(node.retry.backoff_ms);
        continue;
      }
      nodeRun.state = "failed";
      await this.persistNodeTransition(run, nodeRun, "node.failed", {
        nodeId: node.id,
        attempt: nodeRun.attempt,
        reason: failure.reason,
        message: failure.message
      });
      return;
    }
  }

  private async gateRetry(
    run: MutableRun,
    node: WorkflowNode,
    nodeRun: MutableNodeRun
  ): Promise<AutonomyGateDecision> {
    if (run.autonomy === null) return { outcome: "allow", rule: "no_autonomy" };
    return run.autonomy.gate.assess({
      runId: run.id,
      nodeId: node.id,
      action: "retry_node",
      state: this.autonomyState(run, nodeRun)
    });
  }

  private async waitForApproval(run: MutableRun, nodeRun: MutableNodeRun): Promise<void> {
    nodeRun.attempt = 1;
    nodeRun.state = "waiting";
    run.state = "waiting";
    await this.persistNodeTransition(run, nodeRun, "node.waiting", {
      nodeId: nodeRun.nodeId
    });
    await this.store.saveRun(toSnapshot(run));
    await this.appendEvent(run, "approval.requested", nodeRun.id, { nodeId: nodeRun.nodeId });

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(approvalKey(run.id, nodeRun.nodeId), {
        runId: run.id,
        nodeId: nodeRun.nodeId,
        resolve
      });
    });
    if (this.stopRequested(run)) {
      await this.persistNodeStop(run, nodeRun);
      return;
    }
    const evidence: Evidence = {
      id: this.id(),
      type: "approval",
      summary: decision.approved ? "Human approval granted" : "Human approval denied",
      metadata: { note: decision.note }
    };
    nodeRun.evidence = [evidence];
    nodeRun.state = decision.approved ? "succeeded" : "failed";
    nodeRun.failureReason = decision.approved ? null : "approval_denied";
    run.state = "running";
    await this.persistNodeTransition(run, nodeRun, "approval.resolved", {
      nodeId: nodeRun.nodeId,
      approved: decision.approved,
      note: decision.note
    });
    await this.store.saveRun(toSnapshot(run));
    await this.appendEvent(run, decision.approved ? "node.succeeded" : "node.failed", nodeRun.id, {
      nodeId: nodeRun.nodeId,
      reason: nodeRun.failureReason
    });
  }

  /**
   * Concludes a run officially. The delivery checkpoint, the final report and the terminal state all
   * belong to the same transition, so none of them is published on the run before the store accepted
   * the whole transition — see {@link commitTerminal}.
   */
  private async finishWithReport(
    run: MutableRun,
    terminal: RunState,
    additionalPayload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    run.finalizing = true;
    const executionContext = await this.captureDeliveryCheckpoint(run);
    const endedAt = this.now().toISOString();
    const settled: WorkflowRunSnapshot = {
      ...toSnapshot(run),
      state: terminal,
      endedAt,
      executionContext
    };
    const artifact = await this.artifacts.createFinalReport({
      run: settled,
      workflow: run.workflow,
      events: run.events
    });
    await this.appendEvent(run, "report.created", null, { artifactId: artifact.id });
    await this.appendEvent(run, "artifact.created", null, {
      artifactId: artifact.id,
      type: artifact.type
    });
    await this.commitTerminal(
      run,
      { ...settled, reportArtifact: artifact },
      terminalEventType(terminal),
      additionalPayload
    );
  }

  /** A run the host interrupted: no delivery checkpoint and no report, exactly like crash recovery. */
  private async finishInterrupted(run: MutableRun): Promise<void> {
    run.finalizing = true;
    await this.commitTerminal(
      run,
      { ...toSnapshot(run), state: "interrupted", endedAt: this.now().toISOString() },
      "run.interrupted",
      { reason: "host_shutdown" }
    );
  }

  /**
   * The single point where a run becomes terminal. The store write comes first and the in-memory run
   * adopts the terminal state only after it resolved, so no official read — `getRun`, `show`, a
   * handle completion, an IPC projection — can ever report `succeeded`, `failed`, `cancelled` or
   * `interrupted` for a transition SQLite has not accepted yet. A failed write leaves the run
   * non-terminal and propagates, instead of silently claiming a conclusion.
   */
  private async commitTerminal(
    run: MutableRun,
    settled: WorkflowRunSnapshot,
    type: RunEventType,
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const event = this.createEvent(run, type, null, payload);
    await this.store.saveRunWithEvent(settled, event);
    run.state = settled.state;
    run.endedAt = settled.endedAt;
    run.reportArtifact = settled.reportArtifact;
    run.executionContext = settled.executionContext ?? null;
  }

  /**
   * The delivery checkpoint is captured after all nodes settle but before the final report and
   * terminal transition are committed. A failed checkpoint prevents us from claiming completion.
   */
  private async captureDeliveryCheckpoint(
    run: MutableRun
  ): Promise<WorkflowRunExecutionContext | null> {
    const context = run.executionContext;
    if (context === null || context.deliveryCheckpoint !== null) return context;
    const lifecycle = run.executionContextLifecycle;
    if (lifecycle === null) return context;
    return { ...context, deliveryCheckpoint: await lifecycle.createDeliveryCheckpoint() };
  }

  private requireRun(runId: string): MutableRun {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`Unknown workflow run: ${runId}`);
    return run;
  }

  private async waitUntilRunnable(run: MutableRun): Promise<void> {
    while (run.pauseRequested && !this.stopRequested(run)) {
      await new Promise<void>((resolve) => run.resumeWaiters.push(resolve));
    }
  }

  private async stopPendingNodes(run: MutableRun, pending: Set<string>): Promise<void> {
    for (const nodeId of pending) {
      const nodeRun = requireNodeRun(run, nodeId);
      if (["succeeded", "failed", "blocked", "cancelled"].includes(nodeRun.state)) continue;
      await this.persistNodeStop(run, nodeRun);
    }
    pending.clear();
  }

  /**
   * Settles one node that stopped before finishing. A user cancellation is an official decision and
   * keeps its `node.cancelled` audit event; a host shutdown mirrors the recovery contract instead —
   * the node is `interrupted` and the run-level `run.interrupted` event is the single audit record,
   * exactly what `recoverInterruptedRuns` would have written on the next boot.
   */
  private async persistNodeStop(run: MutableRun, nodeRun: MutableNodeRun): Promise<void> {
    if (run.cancelRequested) {
      nodeRun.state = "cancelled";
      nodeRun.failureReason = null;
      await this.persistNodeTransition(run, nodeRun, "node.cancelled", {
        nodeId: nodeRun.nodeId,
        reason: "cancelled"
      });
      return;
    }
    nodeRun.state = "interrupted";
    nodeRun.failureReason = "unknown_error";
    await this.store.saveNodeRun(toNodeSnapshot(nodeRun));
  }

  private createEvent(
    run: MutableRun,
    type: RunEventType,
    nodeRunId: string | null,
    payload: Readonly<Record<string, unknown>>
  ): RunEvent {
    const event: RunEvent = {
      id: this.id(),
      runId: run.id,
      nodeRunId,
      type,
      timestamp: this.now().toISOString(),
      schemaVersion: "1.0",
      sequence: ++run.eventSequence,
      payload
    };
    run.events.push(event);
    return event;
  }

  private async appendEvent(
    run: MutableRun,
    type: RunEventType,
    nodeRunId: string | null,
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const event = this.createEvent(run, type, nodeRunId, payload);
    await this.store.appendEvent(event);
  }

  private async persistRunTransition(
    run: MutableRun,
    type: RunEventType,
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const event = this.createEvent(run, type, null, payload);
    await this.store.saveRunWithEvent(toSnapshot(run), event);
  }

  private async persistNodeTransition(
    run: MutableRun,
    nodeRun: MutableNodeRun,
    type: RunEventType,
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const event = this.createEvent(run, type, nodeRun.id, payload);
    await this.store.saveNodeRunWithEvent(toNodeSnapshot(nodeRun), event);
  }
}

function dependenciesSucceeded(run: MutableRun, node: WorkflowNode): boolean {
  return node.depends_on.every(
    (dependency) => requireNodeRun(run, dependency).state === "succeeded"
  );
}

function requireNodeRun(run: MutableRun, nodeId: string): MutableNodeRun {
  const nodeRun = run.nodes.get(nodeId);
  if (nodeRun === undefined) {
    throw new Error(`Missing node run: ${nodeId}`);
  }
  return nodeRun;
}

function toNodeSnapshot(node: MutableNodeRun): NodeRunSnapshot {
  return {
    id: node.id,
    runId: node.runId,
    nodeId: node.nodeId,
    state: node.state,
    attempt: node.attempt,
    inputHash: node.inputHash,
    idempotencyKey: node.idempotencyKey,
    evidence: [...node.evidence],
    failureReason: node.failureReason
  };
}

function toSnapshot(run: MutableRun): WorkflowRunSnapshot {
  return {
    id: run.id,
    workflowId: run.workflow.id,
    workflowVersion: run.workflow.schema_version,
    workflowHash: run.workflowHash,
    inputHash: run.inputHash,
    effectivePermissions: { ...run.grantedPermissions },
    state: run.state,
    dryRun: run.dryRun,
    concurrency: run.workflow.concurrency,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lineage: run.lineage,
    executionContext: run.executionContext,
    nodeRuns: [...run.nodes.values()].map(toNodeSnapshot),
    reportArtifact: run.reportArtifact
  };
}

function terminalEventType(state: RunState): RunEventType {
  if (state === "succeeded") return "run.completed";
  if (state === "cancelled") return "run.cancelled";
  if (state === "interrupted") return "run.interrupted";
  return "run.failed";
}

function approvalKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
