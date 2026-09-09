import { randomUUID } from "node:crypto";

import type { Workflow, WorkflowNode } from "@forgedeck/workflow";
import type { WorkflowRunLineage } from "@forgedeck/orchestration";
import { builtInWorkflowTemplates, workflowSchema } from "@forgedeck/workflow";
import {
  DeterministicScheduler,
  type ApprovalDecision,
  type ArtifactRegistry,
  type NodeExecutionResult,
  type NodeExecutionContext,
  type RunEvent,
  type RunState,
  type SchedulerStartInput,
  type WorkflowNodeExecutor,
  type WorkflowRunExecutionContext,
  type WorkflowRunExecutionContextLifecycle,
  type WorkflowRunHandle,
  type WorkflowRunSnapshot
} from "@forgedeck/orchestration";
import type { WorkflowRunGraphDto } from "@forgedeck/schemas";

/**
 * Runtime-owned entry point for trusted workflow templates. The caller supplies only a built-in
 * template identifier; no command line, executable, path, working directory or workflow JSON is
 * accepted from CLI or IPC.
 */
export class WorkflowRunRuntime {
  private readonly scheduler: DeterministicScheduler;
  private readonly startedInputs = new Map<string, SchedulerStartInput>();
  private readonly templates: ReadonlyMap<string, Workflow>;

  public constructor(
    executor: WorkflowNodeExecutor,
    private readonly store: {
      createRun: ConstructorParameters<typeof DeterministicScheduler>[1]["createRun"];
      saveRun: ConstructorParameters<typeof DeterministicScheduler>[1]["saveRun"];
      saveRunWithEvent: ConstructorParameters<typeof DeterministicScheduler>[1]["saveRunWithEvent"];
      saveNodeRun: ConstructorParameters<typeof DeterministicScheduler>[1]["saveNodeRun"];
      saveNodeRunWithEvent: ConstructorParameters<
        typeof DeterministicScheduler
      >[1]["saveNodeRunWithEvent"];
      appendEvent: ConstructorParameters<typeof DeterministicScheduler>[1]["appendEvent"];
      getWorkflow(runId: string): Workflow | null;
      get(runId: string): WorkflowRunSnapshot | null;
      list(input: {
        readonly state?: RunState;
        readonly limit?: number;
      }): readonly WorkflowRunSnapshot[];
      listEvents(runId: string, limit?: number): readonly RunEvent[];
    },
    artifacts: ArtifactRegistry,
    private readonly roots?: {
      bindRunRoot(runId: string, root: string): void;
      releaseRunRoot?(runId: string): void;
    },
    private readonly id: () => string = randomUUID
  ) {
    this.scheduler = new DeterministicScheduler(executor, store, artifacts);
    const reportOnly = workflowSchema.parse({
      schema_version: "1.0",
      id: "delivery-report",
      name: "Delivery report",
      description: "Creates an audited run report without executing an external process.",
      concurrency: 1,
      permissions: {},
      nodes: [{ id: "report", type: "artifact", permissions: {} }]
    });
    const shellCheck = workflowSchema.parse({
      schema_version: "1.0",
      id: "local-shell-check",
      name: "Local shell check",
      description: "Verifies the approved local package-manager process path and records evidence.",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "package-manager",
          type: "shell",
          command: { executable: "pnpm", args: ["--version"] },
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["package-manager"], permissions: {} }
      ]
    });
    const qualityCheck = workflowSchema.parse({
      schema_version: "1.0",
      id: "local-quality-check",
      name: "Local quality check",
      description: "Runs the trusted local typecheck gate and records verified evidence.",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "typecheck",
          type: "quality_gate",
          command: { executable: "pnpm", args: ["run", "typecheck"] },
          timeout_ms: 600_000,
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["typecheck"], permissions: {} }
      ]
    });
    const qualitySuite = workflowSchema.parse({
      schema_version: "1.0",
      id: "local-quality-suite",
      name: "Local quality suite",
      description:
        "Runs the approved local lint, typecheck, test and build gates in deterministic order.",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "lint",
          type: "quality_gate",
          command: { executable: "pnpm", args: ["run", "lint"] },
          timeout_ms: 600_000,
          permissions: { process: true }
        },
        {
          id: "typecheck",
          type: "quality_gate",
          depends_on: ["lint"],
          command: { executable: "pnpm", args: ["run", "typecheck"] },
          timeout_ms: 600_000,
          permissions: { process: true }
        },
        {
          id: "test",
          type: "quality_gate",
          depends_on: ["typecheck"],
          command: { executable: "pnpm", args: ["run", "test"] },
          timeout_ms: 600_000,
          permissions: { process: true }
        },
        {
          id: "build",
          type: "quality_gate",
          depends_on: ["test"],
          command: { executable: "pnpm", args: ["run", "build"] },
          timeout_ms: 600_000,
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["build"], permissions: {} }
      ]
    });
    const agentDelivery = workflowSchema.parse({
      schema_version: "1.0",
      id: "local-agent-delivery",
      name: "Local agent delivery",
      description:
        "Queues one audited delivery request to an explicitly selected existing local agent.",
      concurrency: 1,
      permissions: {},
      nodes: [
        {
          id: "deliver",
          type: "agent",
          title: "Deliver approved workflow request",
          role: "delivery",
          permissions: {}
        },
        { id: "report", type: "artifact", depends_on: ["deliver"], permissions: {} }
      ]
    });
    const handoffDraft = workflowSchema.parse({
      schema_version: "1.0",
      id: "local-handoff-draft",
      name: "Local handoff draft",
      description: "Prepares one reviewed handoff draft through a persisted canvas handoff route.",
      concurrency: 1,
      permissions: {},
      nodes: [
        { id: "prepare", type: "handoff", permissions: {} },
        { id: "report", type: "artifact", depends_on: ["prepare"], permissions: {} }
      ]
    });
    const verticalSlice = workflowSchema.parse({
      schema_version: "1.0",
      id: "vertical-slice-reference",
      name: "Vertical slice reference",
      description:
        "Reference flow: a planner agent produces an official artifact, an executor agent consumes it, a quality gate verifies the result, and a final report is recorded.",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "planner",
          type: "agent",
          role: "planner-flaky",
          adapter: "fake-agent",
          title: "Plan the vertical slice",
          permissions: { process: true },
          retry: { max_attempts: 2, backoff_ms: 0, retry_on: ["process_exit_nonzero"] }
        },
        {
          id: "executor",
          type: "agent",
          role: "executor",
          adapter: "fake-agent",
          title: "Execute the plan",
          depends_on: ["planner"],
          permissions: { process: true }
        },
        {
          id: "gate",
          type: "quality_gate",
          command: { executable: "pnpm", args: ["--version"] },
          timeout_ms: 600_000,
          depends_on: ["executor"],
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["gate"], permissions: {} }
      ]
    });
    const verticalSliceBlocked = workflowSchema.parse({
      schema_version: "1.0",
      id: "vertical-slice-reference-blocked",
      name: "Vertical slice reference (failure path)",
      description:
        "Reference flow whose planner fails deterministically, proving dependents stay blocked and no downstream artifact or delivery is produced.",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "planner",
          type: "agent",
          role: "always-fail",
          adapter: "fake-agent",
          title: "Plan the vertical slice",
          permissions: { process: true }
        },
        {
          id: "executor",
          type: "agent",
          role: "executor",
          adapter: "fake-agent",
          title: "Execute the plan",
          depends_on: ["planner"],
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["executor"], permissions: {} }
      ]
    });
    const verticalSliceCancel = workflowSchema.parse({
      schema_version: "1.0",
      id: "vertical-slice-reference-cancel",
      name: "Vertical slice reference (cancellation path)",
      description:
        "Reference flow whose planner blocks until cancelled, proving cancellation keeps dependents blocked and produces no downstream artifact.",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "planner",
          type: "agent",
          role: "hang",
          adapter: "fake-agent",
          title: "Plan the vertical slice",
          permissions: { process: true }
        },
        {
          id: "executor",
          type: "agent",
          role: "executor",
          adapter: "fake-agent",
          title: "Execute the plan",
          depends_on: ["planner"],
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["executor"], permissions: {} }
      ]
    });
    this.templates = new Map(
      [
        ...builtInWorkflowTemplates,
        reportOnly,
        shellCheck,
        qualityCheck,
        qualitySuite,
        agentDelivery,
        handoffDraft,
        verticalSlice,
        verticalSliceBlocked,
        verticalSliceCancel
      ].map((template) => [template.id, template])
    );
  }

  public listTemplateIds(): readonly string[] {
    return [...this.templates.keys()].sort();
  }

  /** Internal capability query used by the desktop dispatcher before it creates a managed worktree. */
  public requiresGitWorktree(templateId: string): boolean {
    const workflow = this.templates.get(templateId);
    if (workflow === undefined) throw new Error("Workflow template is not available");
    return requiresGitWorktree(workflow);
  }

  public startTemplate(
    templateId: string,
    dryRun: boolean,
    target?: WorkflowRunExecutionTarget
  ): WorkflowRunHandle {
    const workflow = this.templates.get(templateId);
    if (workflow === undefined) throw new Error("Workflow template is not available");
    requireExecutionTarget(workflow, target, dryRun);
    const runId = this.id();
    return this.start(
      {
        runId,
        workflow,
        grantedPermissions: workflow.permissions,
        dryRun,
        availableCapabilities: { gitWorktree: target?.worktreeId !== undefined },
        ...(target?.executionContext === undefined
          ? {}
          : {
              executionContext: toExecutionContextLifecycle(target.executionContext)
            })
      },
      target
    );
  }

  /**
   * Starts one run from an already-materialized official workflow. Unlike {@link startTemplate}, the
   * definition is built in the trusted main process from an approved draft — never accepted as JSON
   * from the CLI or renderer — so the runtime stays the single authority for the run, attempts,
   * scheduling, retries, cancellation, events, artifacts and recovery. It delegates to the same
   * private {@link start} and shared scheduler; it never reproduces scheduler logic.
   */
  public startMaterialized(input: {
    readonly workflow: Workflow;
    readonly target: WorkflowRunExecutionTarget;
    readonly executionContext?: WorkflowRunExecutionContextTarget;
    /** Runs after durable run creation and before the first node is eligible to launch. */
    readonly prepareRun?: (runId: string) => Promise<void> | void;
  }): WorkflowRunHandle {
    const workflow = workflowSchema.parse(input.workflow);
    requireExecutionTarget(workflow, input.target, false);
    return this.start(
      {
        runId: this.id(),
        workflow,
        grantedPermissions: workflow.permissions,
        dryRun: false,
        availableCapabilities: { gitWorktree: input.target.worktreeId !== undefined },
        ...(input.prepareRun === undefined ? {} : { prepareRun: input.prepareRun }),
        ...(input.executionContext === undefined
          ? {}
          : { executionContext: toExecutionContextLifecycle(input.executionContext) })
      },
      input.target
    );
  }

  public get(runId: string): WorkflowRunSnapshot {
    return this.scheduler.getRun(runId);
  }

  /**
   * Resolves once every run this runtime started has committed its terminal transition durably. It is
   * the flush a host performs before closing the stores; it starts nothing and cancels nothing.
   */
  public async drain(): Promise<void> {
    await this.scheduler.drain();
  }

  /**
   * Ordered runtime shutdown: no new run is accepted, everything still in flight is interrupted, and
   * this resolves only after every terminal transition reached the database. Idempotent, and a real
   * persistence failure propagates instead of being reported as a clean close. The caller closes the
   * supervisor and the stores only after this resolves.
   */
  public async close(): Promise<void> {
    await this.scheduler.close();
  }

  public show(runId: string): WorkflowRunSnapshot {
    try {
      return this.scheduler.getRun(runId);
    } catch {
      const snapshot = this.store.get(runId);
      if (snapshot === null) throw new Error("Workflow run was not found");
      return snapshot;
    }
  }

  public list(
    input: { readonly state?: RunState; readonly limit?: number } = {}
  ): readonly WorkflowRunSnapshot[] {
    return this.store.list(input);
  }

  public events(runId: string): readonly RunEvent[] {
    return this.store.listEvents(runId, 500);
  }

  /**
   * Returns the small immutable graph needed by the run inspector. The stored workflow is never
   * sent whole because it can contain runtime-only commands, permissions and resource locks.
   */
  public graph(runId: string): WorkflowRunGraphDto {
    const workflow = this.startedInputs.get(runId)?.workflow ?? this.store.getWorkflow(runId);
    if (workflow === null || workflow === undefined) {
      throw new Error("Workflow definition was not found");
    }
    return {
      runId,
      workflowId: workflow.id,
      nodes: workflow.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title ?? null,
        dependsOn: [...node.depends_on]
      }))
    };
  }

  public async pause(runId: string): Promise<WorkflowRunSnapshot> {
    return this.scheduler.pause(runId);
  }

  public async resume(runId: string): Promise<WorkflowRunSnapshot> {
    return this.scheduler.resume(runId);
  }

  public async cancel(runId: string): Promise<WorkflowRunSnapshot> {
    return this.scheduler.cancel(runId);
  }

  public async resolveApproval(
    runId: string,
    nodeId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    await this.scheduler.resolveApproval(runId, nodeId, decision);
  }

  /** A retry always creates a distinct run and never overwrites prior evidence or reports. */
  public retry(
    runId: string,
    target?: WorkflowRunExecutionTarget,
    selection?: WorkflowRetrySelection,
    prepareRun?: (newRunId: string) => Promise<void> | void
  ): WorkflowRunHandle {
    const active = this.activeSnapshot(runId);
    if (active !== null) {
      ensureTerminal(active);
    }
    const previous = this.startedInputs.get(runId);
    if (previous !== undefined) {
      const workflow = selectWorkflowRetrySubgraph(previous.workflow, selection);
      requireExecutionTarget(workflow, target, previous.dryRun ?? false);
      if (previous.executionContext !== undefined && target?.executionContext === undefined) {
        throw new Error(
          "Context-bound workflow retries must be requested through the local runtime"
        );
      }
      return this.start(
        {
          ...previous,
          runId: this.id(),
          workflow,
          lineage: retryLineage(runId, selection),
          ...(prepareRun === undefined ? {} : { prepareRun }),
          ...(target?.executionContext === undefined
            ? {}
            : { executionContext: toExecutionContextLifecycle(target.executionContext) })
        },
        target
      );
    }
    const snapshot = this.requireStoredRun(runId);
    const workflow = selectWorkflowRetrySubgraph(this.requireStoredWorkflow(runId), selection);
    requireExecutionTarget(workflow, target, snapshot.dryRun);
    if (snapshot.executionContext !== null && snapshot.executionContext !== undefined) {
      if (target?.executionContext === undefined) {
        throw new Error(
          "Context-bound workflow retries must be requested through the local runtime"
        );
      }
    }
    return this.start(
      {
        runId: this.id(),
        workflow,
        grantedPermissions: snapshot.effectivePermissions,
        dryRun: snapshot.dryRun,
        availableCapabilities: { gitWorktree: target?.worktreeId !== undefined },
        lineage: retryLineage(runId, selection),
        ...(prepareRun === undefined ? {} : { prepareRun }),
        ...(target?.executionContext === undefined
          ? {}
          : { executionContext: toExecutionContextLifecycle(target.executionContext) })
      },
      target
    );
  }

  private start(
    input: SchedulerStartInput,
    target: WorkflowRunExecutionTarget | undefined
  ): WorkflowRunHandle {
    if (target !== undefined && input.runId !== undefined) {
      this.roots?.bindRunRoot(input.runId, target.root);
    }
    const handle = this.scheduler.start(input);
    this.startedInputs.set(handle.runId, input);
    // A materialized run is started without its handle being awaited, so this bookkeeping chain must
    // never reject on its own: the scheduler already owns the failure and surfaces it through close().
    void handle.completion
      .catch(() => undefined)
      .finally(() => this.roots?.releaseRunRoot?.(handle.runId));
    return handle;
  }

  /**
   * The full stored definition of a run, for main-process composition only — appending an official
   * corrective node to the next run of an automatic lineage reads the previous definition instead of
   * mutating it. Unlike {@link graph} this is never sent to the renderer or the CLI, because a definition
   * can carry runtime-only commands, permissions and resource locks.
   */
  public definition(runId: string): Workflow {
    return this.requireStoredWorkflow(runId);
  }

  private requireStoredRun(runId: string): WorkflowRunSnapshot {
    const snapshot = this.store.get(runId);
    if (snapshot === null) throw new Error("Workflow run was not found");
    if (!["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.state)) {
      throw new Error("Workflow run is still active and cannot be retried");
    }
    return snapshot;
  }

  private requireStoredWorkflow(runId: string): Workflow {
    const workflow = this.store.getWorkflow(runId);
    if (workflow === null) throw new Error("Workflow definition was not found");
    return workflow;
  }

  private activeSnapshot(runId: string): WorkflowRunSnapshot | null {
    try {
      return this.scheduler.getRun(runId);
    } catch {
      return null;
    }
  }
}

export interface WorkflowRunExecutionTarget {
  readonly root: string;
  /** Stable canvas node identifier, persisted separately from the runtime-only root path. */
  readonly agentNodeId?: string;
  /** Opaque managed-worktree ID. The corresponding path stays in the runtime-only root field. */
  readonly worktreeId?: string;
  /** Runtime-only checkpoint factory; never received from CLI, renderer or IPC. */
  readonly executionContext?: WorkflowRunExecutionContextTarget;
}

/** A user-selected retry is a new run over the target and its required subgraph. */
export interface WorkflowRetrySelection {
  readonly nodeId: string;
  readonly scope: "node" | "dependents";
  /** A locally named branch that may run alongside other branches of the same source node. */
  readonly alternativeLabel?: string | null;
}

export interface WorkflowRunExecutionContextTarget {
  readonly context: WorkflowRunExecutionContext;
  readonly createDeliveryCheckpoint: () => Promise<
    WorkflowRunExecutionContext["functionCheckpoint"]
  >;
}

function ensureTerminal(snapshot: WorkflowRunSnapshot): void {
  if (!["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.state)) {
    throw new Error("Workflow run is still active and cannot be retried");
  }
}

/**
 * Selects a closed workflow subgraph for a manual retry. A node retry includes every prerequisite;
 * a dependents retry includes the node, every descendant, and all prerequisites of that set.
 */
export function selectWorkflowRetrySubgraph(
  workflow: Workflow,
  selection: WorkflowRetrySelection | undefined
): Workflow {
  if (selection === undefined) return workflow;
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  if (!nodes.has(selection.nodeId)) throw new Error("Workflow retry node was not found");
  const selected = new Set<string>([selection.nodeId]);
  if (selection.scope === "dependents") {
    const dependents = new Map<string, string[]>();
    for (const node of workflow.nodes) {
      for (const dependency of node.depends_on) {
        const entries = dependents.get(dependency) ?? [];
        entries.push(node.id);
        dependents.set(dependency, entries);
      }
    }
    const pending = [selection.nodeId];
    while (pending.length > 0) {
      const nodeId = pending.shift();
      if (nodeId === undefined) break;
      for (const dependent of dependents.get(nodeId) ?? []) {
        if (selected.has(dependent)) continue;
        selected.add(dependent);
        pending.push(dependent);
      }
    }
  }
  const pending = [...selected];
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (nodeId === undefined) break;
    const node = nodes.get(nodeId);
    if (node === undefined) continue;
    for (const dependency of node.depends_on) {
      if (selected.has(dependency)) continue;
      selected.add(dependency);
      pending.push(dependency);
    }
  }
  return workflowSchema.parse({
    ...workflow,
    nodes: workflow.nodes.filter((node) => selected.has(node.id))
  });
}

function retryLineage(
  runId: string,
  selection: WorkflowRetrySelection | undefined
): WorkflowRunLineage {
  const isAlternative = selection?.alternativeLabel !== undefined;
  return {
    sourceRunId: runId,
    nodeId: selection?.nodeId ?? null,
    scope: selection?.scope ?? "run",
    alternativeGroupId:
      !isAlternative || selection === undefined ? null : `alternative:${runId}:${selection.nodeId}`,
    alternativeLabel: isAlternative ? (selection?.alternativeLabel ?? null) : null
  };
}

function requireExecutionTarget(
  workflow: Workflow,
  target: WorkflowRunExecutionTarget | undefined,
  dryRun: boolean
): void {
  if (requiresProjectTarget(workflow) && target === undefined) {
    throw new Error("Workflow template requires an approved project target");
  }
  if (requiresAgentTarget(workflow) && target?.agentNodeId === undefined) {
    throw new Error("Workflow template requires an explicit existing agent target");
  }
  if (!dryRun && requiresGitWorktree(workflow) && target?.worktreeId === undefined) {
    throw new Error("Workflow template requires a managed Git worktree");
  }
}

function requiresProjectTarget(workflow: Workflow): boolean {
  return workflow.nodes.some(
    (node) => node.permissions.process === true || node.permissions.workspace_write === true
  );
}

function requiresAgentTarget(workflow: Workflow): boolean {
  return workflow.nodes.some((node) => node.type === "agent" || node.type === "handoff");
}

function requiresGitWorktree(workflow: Workflow): boolean {
  return workflow.nodes.some((node) => node.isolation === "git_worktree");
}

function toExecutionContextLifecycle(
  target: WorkflowRunExecutionContextTarget
): WorkflowRunExecutionContextLifecycle {
  return {
    context: target.context,
    createDeliveryCheckpoint: target.createDeliveryCheckpoint
  };
}

/** The initial executor is deliberately capability-minimal until each real adapter is installed. */
export class SafeWorkflowNodeExecutor implements WorkflowNodeExecutor {
  public constructor(
    private readonly shell: WorkflowNodeExecutor | null = null,
    private readonly agent: WorkflowNodeExecutor | null = null,
    private readonly handoff: WorkflowNodeExecutor | null = null
  ) {}

  public async execute(
    node: WorkflowNode,
    _context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    void _context;
    if (node.type === "artifact") {
      return {
        success: true,
        evidence: [
          {
            id: `evidence-${node.id}`,
            type: "artifact",
            summary: "Workflow report stage completed by the local runtime.",
            metadata: { nodeId: node.id }
          }
        ],
        output: { reportStage: true }
      };
    }
    if ((node.type === "shell" || node.type === "quality_gate") && this.shell !== null) {
      return this.shell.execute(node, _context);
    }
    if (node.type === "agent" && this.agent !== null) {
      return this.agent.execute(node, _context);
    }
    if (node.type === "handoff" && this.handoff !== null) {
      return this.handoff.execute(node, _context);
    }
    return {
      success: false,
      reason: "adapter_unavailable",
      message: "This workflow node requires an executor that is not enabled yet.",
      evidence: []
    };
  }
}
