import {
  orchestratorPlanSchema,
  orchestratorPlanToDraft,
  remediationPlanSchema,
  type AutomaticWorkflowRequest,
  type OrchestratorPlan,
  type OrchestratorPlanNode,
  type RemediationPlan,
  type WorkflowDraft
} from "@forgedeck/schemas";

import { resolveAutomaticModeStrategy } from "./automatic-mode-strategy";
import type { VerificationCoordinator } from "./verification-coordinator";
import { materializeWorkflowDraft } from "./workflow-materializer";

/**
 * The AutomaticWorkflowCoordinator turns a single objective into a generated, executed, verified and
 * self-corrected workflow — by COORDINATING the existing official operations, never by owning a new
 * runtime, scheduler, queue or persistence. It: asks the orchestrator (a read-only Claude task) for a
 * structured plan, validates it against the schema, converts it to the existing WorkflowDraft, gates on
 * human approval where required, materializes the draft exactly once, verifies each node by structural
 * evidence (never by "done" text), and on failure requests a validated RemediationPlan that becomes the
 * next official run of the lineage — all inside product-fixed limits so the loop can never be unbounded.
 */

/** Raw structured output from the orchestrator task; validated here, never trusted as free text. */
export interface OrchestratorPort {
  /** Read-only analysis + planning; returns raw JSON to be validated as an {@link OrchestratorPlan}. */
  analyze(request: AutomaticWorkflowRequest): Promise<unknown>;
  /** Returns raw JSON to be validated as a RemediationPlan when a verification fails. */
  remediate(context: RemediationContext): Promise<unknown>;
}

export interface RemediationContext {
  readonly objective: string;
  readonly targetNodeId: string;
  readonly failedCriteria: readonly string[];
  readonly sanitizedError: string;
  readonly allowedAreas: readonly string[];
  readonly priorAttempts: number;
}

export interface NodeRunOutcome {
  readonly nodeId: string;
  /** Structural success: the process exited 0 AND published its declared artifact. */
  readonly structuralSuccess: boolean;
  readonly hasExpectedArtifacts: boolean;
  /** Attempts accumulated so far (initial attempt is 1). */
  readonly attempts: number;
}

export interface RunOutcome {
  readonly runId: string;
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly nodes: readonly NodeRunOutcome[];
}

/**
 * The official run surface the coordinator drives; it owns no scheduler or persistence of its own.
 *
 * Remediation produces a NEW official run linked to the previous one by lineage, because the official
 * runtime deliberately never re-dispatches a node inside a live run and never overwrites the evidence or
 * report of a finished one. One automatic session is therefore a lineage of runs — one per cycle — not a
 * single mutable run, and each run's definition stays immutable and auditable.
 */
export interface WorkflowRunPort {
  /** Materializes the approved draft and starts the first official run of the lineage. */
  materializeAndStart(draft: WorkflowDraft): Promise<{ readonly runId: string }>;
  /** Waits for the run to reach a terminal state and reports per-node structural outcomes. */
  awaitOutcome(runId: string): Promise<RunOutcome>;
  /**
   * Retries one node with a corrected prompt as the next run in the lineage, over that node and the
   * subgraph it releases, and returns the new run id.
   */
  retryNode(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly updatedPrompt: string;
  }): Promise<{ readonly runId: string }>;
  /**
   * Starts the next run in the lineage with ONE corrective node added after the node it corrects, so the
   * fix is added work. The previous run's definition, evidence and report are never rewritten.
   */
  addCorrectiveNode(input: {
    readonly runId: string;
    readonly node: OrchestratorPlanNode;
  }): Promise<{ readonly runId: string }>;
  cancel(runId: string): Promise<void>;
}

export type AutomaticStopReason =
  "remediation_exhausted" | "attempts_exhausted" | "timeout" | "cancelled" | "unrecoverable";

export type AutomaticWorkflowResult =
  | {
      readonly status: "completed";
      /** The last run of the lineage. */
      readonly runId: string;
      readonly remediationCycles: number;
    }
  | {
      readonly status: "awaiting_approval";
      readonly draft: WorkflowDraft;
      readonly approvals: readonly string[];
    }
  | { readonly status: "plan_rejected"; readonly issues: readonly string[] }
  | {
      readonly status: "stopped";
      readonly reason: AutomaticStopReason;
      readonly runId: string | null;
      readonly detail: string;
    };

export type ComposeResult =
  | {
      readonly status: "composed";
      readonly draft: WorkflowDraft;
      readonly plan: OrchestratorPlan;
      /** Node ids that require human approval before the run may start (empty when none). */
      readonly approvals: readonly string[];
    }
  | { readonly status: "plan_rejected"; readonly issues: readonly string[] };

/** One failed node whose fix was delegated to a corrective node; kept so a reload judges it the same way. */
export interface CorrectiveDelegation {
  readonly failedNodeId: string;
  readonly correctiveNodeId: string;
}

/**
 * A verification failure that has not been resolved by any later run of the lineage. It is carried
 * forward because a remediation run only covers the failed node and the subgraph it releases: a node that
 * failed in an earlier run is simply absent from the next run's outcome, and absence must never be read
 * as success.
 */
export interface UnresolvedNodeFailure {
  readonly nodeId: string;
  readonly unmetCriteria: readonly string[];
  /** Already sanitized by the verification step; safe to persist and to put in a remediation prompt. */
  readonly sanitizedError: string | null;
  readonly attempts: number;
}

/** Serializable state that lets a reload resume the automatic run without re-analyzing or re-starting. */
export interface AutomaticRunState {
  readonly request: AutomaticWorkflowRequest;
  /** The plan as it stands, including any corrective nodes added by earlier remediation cycles. */
  readonly plan: OrchestratorPlan;
  readonly draftId: string;
  /** The lineage of official runs, oldest first; the last entry is the current run. */
  readonly runIds: readonly string[];
  readonly remediationCycle: number;
  readonly startedAtMs: number;
  readonly corrections?: readonly CorrectiveDelegation[];
  readonly unresolvedFailures?: readonly UnresolvedNodeFailure[];
  /**
   * Nodes that verified at some point in the lineage. Needed to tell "this node passed" apart from "this
   * node has not run yet", which are otherwise both simply absent from the open-failure set.
   */
  readonly verifiedNodeIds?: readonly string[];
}

/** The current run of a lineage: the one the coordinator is waiting on. */
export function currentRunId(state: AutomaticRunState): string {
  const runId = state.runIds.at(-1);
  if (runId === undefined)
    throw new Error("An automatic run state must carry at least one run id.");
  return runId;
}

export interface AutomaticWorkflowCoordinatorDeps {
  readonly orchestrator: OrchestratorPort;
  readonly run: WorkflowRunPort;
  readonly verification: VerificationCoordinator;
  readonly clock?: () => number;
  readonly sourceTerminalId?: (request: AutomaticWorkflowRequest) => string;
  /** Called when nodes require human approval; default denies (returns false), so the run blocks. */
  readonly requestApproval?: (
    approvals: readonly string[],
    draft: WorkflowDraft
  ) => Promise<boolean>;
  /**
   * Persists the resumable state of the automatic run: once when the run starts and again after every
   * remediation cycle. Without it {@link AutomaticWorkflowCoordinator.resume} has nothing to resume
   * from, so a reload would have to re-analyze and start a second run.
   */
  readonly persistState?: (state: AutomaticRunState) => Promise<void> | void;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
}

/** Read through a function so the signal is re-checked after every await, not narrowed once. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A remediation either became the next run of the lineage, or was refused with a visible reason. */
type AppliedRemediation =
  | { readonly status: "applied"; readonly runId: string }
  | { readonly status: "rejected"; readonly result: AutomaticWorkflowResult };

function rejectRemediation(runId: string, detail: string): AppliedRemediation {
  return {
    status: "rejected",
    result: { status: "stopped", reason: "unrecoverable", runId, detail }
  };
}

export class AutomaticWorkflowCoordinator {
  private readonly clock: () => number;
  private readonly sourceTerminalId: (request: AutomaticWorkflowRequest) => string;
  private readonly requestApproval: (
    approvals: readonly string[],
    draft: WorkflowDraft
  ) => Promise<boolean>;

  public constructor(private readonly deps: AutomaticWorkflowCoordinatorDeps) {
    this.clock = deps.clock ?? (() => Date.now());
    this.sourceTerminalId = deps.sourceTerminalId ?? ((request) => `auto:${request.workspaceId}`);
    this.requestApproval = deps.requestApproval ?? (async () => false);
  }

  /** Analysis + validation + draft, without starting anything. Approval decisions are surfaced, not taken. */
  public async compose(request: AutomaticWorkflowRequest): Promise<ComposeResult> {
    const strategy = resolveAutomaticModeStrategy(request.mode, request.limits);
    const raw = await this.deps.orchestrator.analyze(request);
    const parsed = orchestratorPlanSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "plan_rejected",
        issues: parsed.error.issues.map((issue) => issue.message)
      };
    }
    const plan = parsed.data;
    if (plan.nodes.length > strategy.limits.maxWorkflowNodes) {
      return {
        status: "plan_rejected",
        issues: [
          `The plan has ${plan.nodes.length} nodes, over the ${strategy.limits.maxWorkflowNodes}-node budget for ${request.mode} mode.`
        ]
      };
    }
    let draft: WorkflowDraft;
    try {
      draft = orchestratorPlanToDraft(plan, {
        workspaceId: request.workspaceId,
        objective: request.objective,
        executionProfile: strategy.executionProfile,
        sourceTerminalId: this.sourceTerminalId(request)
      });
    } catch (error) {
      // A schema-valid plan can still describe a draft the draft schema refuses; that is a rejection
      // with a visible reason, never a crash of the automatic run.
      return {
        status: "plan_rejected",
        issues: [error instanceof Error ? error.message : "The plan could not become a draft."]
      };
    }
    // The plan schema catches duplicate, self and missing dependencies, but not a cycle — and only the
    // official materializer decides what is executable. A draft that cannot materialize is rejected
    // here, so materializeAndStart is never handed a broken workflow.
    const materialization = materializeWorkflowDraft(draft);
    if (materialization.issues.length > 0) {
      return {
        status: "plan_rejected",
        issues: materialization.issues.map((issue) => issue.message)
      };
    }
    const approvals = this.approvalNodeIds(plan);
    return { status: "composed", draft, plan, approvals };
  }

  /**
   * Starts the ALREADY COMPOSED revision: approve (if required) → materialize exactly this draft →
   * one run → verify → remediate → retry. It never calls the orchestrator.
   *
   * This is the entry point a reviewed session uses. {@link compose} produced the plan the human saw;
   * asking the planner again here would spend a second paid turn and could materialize a plan nobody
   * approved, so the plan and the draft are passed in and used verbatim.
   */
  public async startApproved(
    input: {
      readonly request: AutomaticWorkflowRequest;
      readonly plan: OrchestratorPlan;
      /** The exact revision to materialize, including any per-node choice the user made. */
      readonly draft: WorkflowDraft;
      readonly approvals?: readonly string[];
    },
    options: RunOptions = {}
  ): Promise<AutomaticWorkflowResult> {
    const approvals = input.approvals ?? this.approvalNodeIds(input.plan);
    if (approvals.length > 0) {
      const granted = await this.requestApproval(approvals, input.draft);
      if (!granted) {
        return { status: "awaiting_approval", draft: input.draft, approvals };
      }
    }
    const handle = await this.deps.run.materializeAndStart(input.draft);
    return this.executeLoop(
      {
        request: input.request,
        plan: input.plan,
        draftId: input.draft.id,
        runIds: [handle.runId],
        remediationCycle: 0,
        startedAtMs: this.clock()
      },
      options
    );
  }

  /**
   * Full automatic cycle in one call: compose → approve (if required) → start one run → verify →
   * remediate → retry. It composes because it is given only an objective; a session that already has
   * a reviewed plan must use {@link startApproved} instead, or it would plan twice.
   */
  public async run(
    request: AutomaticWorkflowRequest,
    options: RunOptions = {}
  ): Promise<AutomaticWorkflowResult> {
    const composed = await this.compose(request);
    if (composed.status === "plan_rejected") {
      return { status: "plan_rejected", issues: composed.issues };
    }
    if (composed.approvals.length > 0) {
      const granted = await this.requestApproval(composed.approvals, composed.draft);
      if (!granted) {
        // Approval blocks only the gated nodes; the coordinator surfaces exactly which ones.
        return {
          status: "awaiting_approval",
          draft: composed.draft,
          approvals: composed.approvals
        };
      }
    }
    const handle = await this.deps.run.materializeAndStart(composed.draft);
    return this.executeLoop(
      {
        request,
        plan: composed.plan,
        draftId: composed.draft.id,
        runIds: [handle.runId],
        remediationCycle: 0,
        startedAtMs: this.clock()
      },
      options
    );
  }

  /** Resumes an interrupted automatic run from its persisted state — no new run, no duplicate attempts. */
  public async resume(
    state: AutomaticRunState,
    options: RunOptions = {}
  ): Promise<AutomaticWorkflowResult> {
    return this.executeLoop(state, options);
  }

  private async executeLoop(
    state: AutomaticRunState,
    options: RunOptions
  ): Promise<AutomaticWorkflowResult> {
    const strategy = resolveAutomaticModeStrategy(state.request.mode, state.request.limits);
    const deadline = state.startedAtMs + strategy.limits.timeoutMs;
    // Corrective nodes join this list, so the next cycle verifies them like any other node.
    const planNodes: OrchestratorPlanNode[] = [...state.plan.nodes];
    // Failed node id → the corrective node that took over its fix, restored across a reload.
    const correctedBy = new Map<string, string>(
      (state.corrections ?? []).map((entry) => [entry.failedNodeId, entry.correctiveNodeId])
    );
    // Failures still open across the whole lineage. A remediation run only covers the failed node and the
    // subgraph it releases, so a node absent from the current outcome keeps the verdict it already earned.
    const unresolved = new Map<string, UnresolvedNodeFailure>(
      (state.unresolvedFailures ?? []).map((entry) => [entry.nodeId, entry])
    );
    const verified = new Set<string>(state.verifiedNodeIds ?? []);
    const runIds = [...state.runIds];
    let cycle = state.remediationCycle;
    let runId = currentRunId(state);

    const snapshot = (): AutomaticRunState => ({
      ...state,
      plan: { ...state.plan, nodes: [...planNodes] },
      runIds: [...runIds],
      remediationCycle: cycle,
      corrections: [...correctedBy].map(([failedNodeId, correctiveNodeId]) => ({
        failedNodeId,
        correctiveNodeId
      })),
      unresolvedFailures: [...unresolved.values()],
      verifiedNodeIds: [...verified]
    });
    await this.persistState(snapshot());

    for (;;) {
      if (isAborted(options.signal)) return this.stopCancelled(runId);
      if (this.clock() > deadline) {
        await this.deps.run.cancel(runId);
        return {
          status: "stopped",
          reason: "timeout",
          runId,
          detail: "The automatic run exceeded its time budget."
        };
      }

      const outcome = await this.deps.run.awaitOutcome(runId);
      // Awaiting the outcome spans the whole node execution, so an abort raised meanwhile only becomes
      // visible now; it must stop the run instead of triggering another remediation.
      if (isAborted(options.signal)) return this.stopCancelled(runId);
      if (outcome.state === "cancelled") {
        return { status: "stopped", reason: "cancelled", runId, detail: "Run cancelled." };
      }

      await this.recordVerification(planNodes, outcome, unresolved, verified);
      const failure = this.nextOpenFailure(planNodes, unresolved, correctedBy, verified);
      if (failure === null) {
        return { status: "completed", runId, remediationCycles: cycle };
      }

      if (cycle >= strategy.limits.maxRemediationCycles) {
        return {
          status: "stopped",
          reason: "remediation_exhausted",
          runId,
          detail: `Reached the ${strategy.limits.maxRemediationCycles}-cycle remediation limit.`
        };
      }
      if (failure.attempts >= strategy.limits.maxAttemptsPerNode) {
        return {
          status: "stopped",
          reason: "attempts_exhausted",
          runId,
          detail: `Node ${failure.nodeId} reached the ${strategy.limits.maxAttemptsPerNode}-attempt limit.`
        };
      }

      const planNode = planNodes.find((node) => node.id === failure.nodeId);
      const rawRemediation = await this.deps.orchestrator.remediate({
        objective: state.request.objective,
        targetNodeId: failure.nodeId,
        failedCriteria: failure.unmetCriteria,
        sanitizedError: failure.sanitizedError ?? "",
        allowedAreas: planNode?.allowedAreas ?? [],
        priorAttempts: failure.attempts
      });
      const remediation = remediationPlanSchema.safeParse(rawRemediation);
      if (!remediation.success) {
        return {
          status: "stopped",
          reason: "unrecoverable",
          runId,
          detail: "The remediation plan was invalid."
        };
      }

      const applied = await this.applyRemediation(
        runId,
        remediation.data,
        failure.nodeId,
        planNodes,
        correctedBy
      );
      if (applied.status === "rejected") return applied.result;
      // The remediation became the next run of the lineage; the loop now waits on that run.
      runId = applied.runId;
      runIds.push(runId);
      cycle += 1;
      await this.persistState(snapshot());
    }
  }

  /**
   * Verifies every plan node present in this run's outcome and folds the verdicts into the lineage-wide
   * open-failure set: a node that verified is cleared, a node that failed is (re)opened. Nodes absent from
   * the outcome are untouched, so they keep whatever verdict an earlier run of the lineage gave them.
   */
  private async recordVerification(
    planNodes: readonly OrchestratorPlanNode[],
    outcome: RunOutcome,
    unresolved: Map<string, UnresolvedNodeFailure>,
    verified: Set<string>
  ): Promise<void> {
    const outcomeByNode = new Map(outcome.nodes.map((node) => [node.nodeId, node]));
    for (const planNode of planNodes) {
      const nodeOutcome = outcomeByNode.get(planNode.id);
      if (nodeOutcome === undefined) continue;
      const result = await this.deps.verification.verifyNode({
        nodeId: planNode.id,
        structuralSuccess: nodeOutcome.structuralSuccess,
        hasExpectedArtifacts: nodeOutcome.hasExpectedArtifacts,
        acceptanceCriteria: planNode.acceptanceCriteria,
        verificationCommands: planNode.verificationCommands
      });
      if (result.passed) {
        unresolved.delete(planNode.id);
        verified.add(planNode.id);
        continue;
      }
      verified.delete(planNode.id);
      const priorAttempts = unresolved.get(planNode.id)?.attempts ?? 0;
      unresolved.set(planNode.id, {
        nodeId: planNode.id,
        unmetCriteria: result.unmetCriteria,
        sanitizedError: result.sanitizedError,
        // Attempts accumulate across the lineage: each run of a node is one attempt at fixing it.
        attempts: Math.max(nodeOutcome.attempts, priorAttempts + 1)
      });
    }
  }

  /**
   * The next failure to remediate, in plan order, or null when the session is done. A failure whose fix was
   * delegated to a corrective node is not its own failure any more: the corrective node's verdict answers
   * for it, so it is skipped once that node has verified.
   */
  private nextOpenFailure(
    planNodes: readonly OrchestratorPlanNode[],
    unresolved: ReadonlyMap<string, UnresolvedNodeFailure>,
    correctedBy: ReadonlyMap<string, string>,
    verified: ReadonlySet<string>
  ): UnresolvedNodeFailure | null {
    for (const planNode of planNodes) {
      const failure = unresolved.get(planNode.id);
      if (failure === undefined) continue;
      const delegate = correctedBy.get(planNode.id);
      // Only a delegate that actually verified answers for the failure. A delegate that has not run yet is
      // simply absent from both sets, and must not be mistaken for a passing one.
      if (delegate !== undefined && verified.has(delegate)) continue;
      return failure;
    }
    return null;
  }

  /**
   * Turns a validated remediation into official work: a retry attempt on the failed node, or one
   * corrective node that depends on it. Anything that would touch another node — and therefore risk
   * undoing work that already verified — is refused instead of applied.
   */
  private async applyRemediation(
    runId: string,
    remediation: RemediationPlan,
    failedNodeId: string,
    planNodes: OrchestratorPlanNode[],
    correctedBy: Map<string, string>
  ): Promise<AppliedRemediation> {
    if (remediation.targetNodeId !== failedNodeId) {
      return rejectRemediation(
        runId,
        `The remediation targeted ${remediation.targetNodeId} instead of the failed node ${failedNodeId}.`
      );
    }

    if (remediation.action === "retry_node") {
      const next = await this.deps.run.retryNode({
        runId,
        nodeId: failedNodeId,
        updatedPrompt: remediation.updatedPrompt
      });
      return { status: "applied", runId: next.runId };
    }

    const corrective = remediation.correctiveNode;
    if (corrective === undefined) {
      return rejectRemediation(
        runId,
        "The remediation asked for a corrective node but did not provide one."
      );
    }
    if (planNodes.some((node) => node.id === corrective.id)) {
      return rejectRemediation(
        runId,
        `The corrective node id ${corrective.id} already exists in the workflow.`
      );
    }
    // The corrective node runs AFTER the node it corrects, so the fix is added work.
    const node: OrchestratorPlanNode = corrective.dependsOn.includes(failedNodeId)
      ? corrective
      : { ...corrective, dependsOn: [...corrective.dependsOn, failedNodeId] };
    const next = await this.deps.run.addCorrectiveNode({ runId, node });
    planNodes.push(node);
    correctedBy.set(failedNodeId, node.id);
    return { status: "applied", runId: next.runId };
  }

  private async stopCancelled(runId: string): Promise<AutomaticWorkflowResult> {
    await this.deps.run.cancel(runId);
    return { status: "stopped", reason: "cancelled", runId, detail: "Aborted." };
  }

  private async persistState(state: AutomaticRunState): Promise<void> {
    await this.deps.persistState?.(state);
  }

  private approvalNodeIds(plan: OrchestratorPlan): readonly string[] {
    // A plan-level approval flag gates the whole run; otherwise only the individual risky/approval
    // nodes are gated, so approval blocks only what it must.
    if (plan.needsHumanApproval) {
      return plan.nodes.map((node) => node.id);
    }
    return plan.nodes
      .filter(
        (node: OrchestratorPlanNode) => node.requiresHumanApproval || node.operationRisk !== "safe"
      )
      .map((node) => node.id);
  }
}
