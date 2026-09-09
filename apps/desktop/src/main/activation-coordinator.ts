import { createHash } from "node:crypto";

import {
  ActivationService,
  createTaskResultParser,
  materializeWorkflowDraft,
  materializedWorkflowId
} from "@forgedeck/orchestration";
import type {
  ActivationSnapshot,
  AgentAssignmentCatalog,
  TaskResultParser,
  WorkerDispatch,
  WorkflowRunSnapshot
} from "@forgedeck/orchestration";
import type { Workflow } from "@forgedeck/workflow";
import type { ExecutionProfile, WorkflowActivationResult, WorkflowDraft } from "@forgedeck/schemas";

import { buildApprovedNodePrompt } from "./approved-node-prompt";

/**
 * Bridges the pure {@link ActivationService} to the real world without owning any async PTY logic, so it
 * stays unit-testable. On approve, {@link activate} starts the scheduler; each dispatch is forwarded to
 * `onDispatch`, which the main process fulfils by spawning a worker PTY and then calling
 * {@link bindWorkerSession} with the resulting session id. Worker output is fed back through
 * {@link ingest}: only a schema-valid `TaskResult` from the `⟦compasso:result⟧` envelope advances the
 * plan — a terminal going idle never completes a task (spec §11.4/§20.5.1).
 */

/** The single durable input the runtime needs to create one run from a materialized definition. */
export interface MaterializedWorkflowRunInput {
  readonly workflow: Workflow;
  readonly workspaceId: string;
  /** Primary canvas agent node id (stable), used as the run's execution-context agent. */
  readonly agentNodeId: string;
  readonly task: string;
  readonly root: string;
  readonly definitionSha256: string;
  readonly nodePrompts: readonly { readonly nodeId: string; readonly prompt: string }[];
}

/**
 * The narrow port the coordinator uses to create a run. Production delegates to the single live
 * {@link WorkflowRunRuntime}; the coordinator never instantiates a runtime, scheduler or store, and
 * never controls attempts. It returns the initial official snapshot right after the run is created.
 */
export interface WorkflowRunStarter {
  startMaterializedWorkflow(input: MaterializedWorkflowRunInput): Promise<WorkflowRunSnapshot>;
}

/** Durable idempotency ledger for approvals (implemented by SqliteWorkflowActivationStore). */
export interface WorkflowActivationLedger {
  getByDraft(
    draftId: string,
    draftVersion: number
  ): {
    readonly activationId: string;
    readonly workflowId: string;
    readonly runId: string | null;
  } | null;
  ensureIntent(input: {
    readonly draftId: string;
    readonly draftVersion: number;
    readonly workspaceId: string;
    readonly workflowId: string;
    readonly definitionSha256: string;
  }): { readonly activationId: string; readonly runId: string | null };
  attachRun(activationId: string, runId: string): unknown;
  markFailed(activationId: string): void;
}

export interface ActivationMaterializationDeps {
  readonly ledger: WorkflowActivationLedger;
  readonly starter: WorkflowRunStarter;
  /** Resolves the project root for a workspace, or null if the project is unavailable. */
  readonly resolveProjectRoot: (workspaceId: string) => Promise<string | null> | string | null;
  /**
   * The agents present on this machine, read at approval time. Supplying it makes every node's agent
   * choice a precondition of the run. When absent, materialization keeps judging only the legacy
   * runtime binding, which is what an already-materialized historical workflow needs.
   */
  readonly agents?: () => AgentAssignmentCatalog | Promise<AgentAssignmentCatalog>;
}

export interface ActivationCoordinatorDeps {
  /** Called for each dispatch; the caller spawns the worker PTY and then calls bindWorkerSession. */
  readonly onDispatch: (dispatch: WorkerDispatch) => void;
  readonly newId: () => string;
  /** Notified when the whole workflow finishes. */
  readonly onDone?: () => void;
  /** Increment A: draft→official-run materialization. When absent, {@link materialize} is disabled. */
  readonly materialization?: ActivationMaterializationDeps;
}

interface WorkerBinding {
  readonly taskId: string;
  readonly parser: TaskResultParser;
}

export class ActivationCoordinator {
  private readonly deps: ActivationCoordinatorDeps;
  private service: ActivationService | null = null;
  private readonly bindings = new Map<string, WorkerBinding>();

  constructor(deps: ActivationCoordinatorDeps) {
    this.deps = deps;
  }

  /**
   * Increment A: materializes an approved draft into one official run. It orchestrates only — it
   * validates, materializes, records the activation, asks the runtime port to create the run, and
   * binds the run id. It never executes a node, controls attempts, or reproduces scheduler logic.
   *
   * Idempotent by `(draftId, version)`: a double click, repeated IPC call, request retry or a reload
   * during approval creates at most one run. A repeat returns the existing run; a definition recorded
   * without a run (a crash before the run was created) creates only the run on retry. A validation
   * failure never creates a run or attempt.
   */
  async materialize(draft: WorkflowDraft): Promise<WorkflowActivationResult> {
    const deps = this.deps.materialization;
    if (deps === undefined) {
      return invalidActivation([
        { code: "unavailable", nodeId: null, message: "Materialization is not configured." }
      ]);
    }

    // 1. A prior activation that already produced a run wins — never create a second run.
    const existing = deps.ledger.getByDraft(draft.id, draft.version);
    if (existing !== null && existing.runId !== null) {
      return {
        activationId: existing.activationId,
        workflowId: existing.workflowId,
        runId: existing.runId,
        status: "started",
        issues: []
      };
    }

    // 2. Validate + materialize. Any issue blocks: no run, no attempt. When an agent catalog is
    // configured, a node with no valid, available and capable agent is one of those issues.
    const agents = deps.agents === undefined ? undefined : await deps.agents();
    const result = materializeWorkflowDraft(draft, agents === undefined ? {} : { agents });
    const agentNodeId = result.agentNodeIds[0];
    if (result.workflow === null || agentNodeId === undefined) {
      return invalidActivation(
        result.workflow === null
          ? result.issues
          : [{ code: "missing_binding", nodeId: null, message: "No executable agent node." }]
      );
    }
    const workflow = result.workflow;
    const definitionSha256 = createHash("sha256").update(canonicalize(workflow)).digest("hex");

    // 3. Record the activation intent (idempotent) before creating the run.
    const activation = deps.ledger.ensureIntent({
      draftId: draft.id,
      draftVersion: draft.version,
      workspaceId: draft.workspaceId,
      workflowId: materializedWorkflowId(draft),
      definitionSha256
    });
    if (activation.runId !== null) {
      return {
        activationId: activation.activationId,
        workflowId: materializedWorkflowId(draft),
        runId: activation.runId,
        status: "started",
        issues: []
      };
    }

    // 4. Resolve the project target; a missing project blocks without creating a run.
    const root = await deps.resolveProjectRoot(draft.workspaceId);
    if (root === null) {
      deps.ledger.markFailed(activation.activationId);
      return {
        activationId: activation.activationId,
        workflowId: materializedWorkflowId(draft),
        runId: null,
        status: "failed",
        issues: [{ code: "project_unavailable", nodeId: null, message: "No approved project." }]
      };
    }

    // 5. Ask the runtime to create exactly one run, then bind it to the activation.
    try {
      const snapshot = await deps.starter.startMaterializedWorkflow({
        workflow,
        workspaceId: draft.workspaceId,
        agentNodeId,
        task:
          draft.objective.length > 0
            ? draft.objective
            : draft.title.length > 0
              ? draft.title
              : "Approved workflow",
        root,
        definitionSha256,
        nodePrompts: draft.nodes.map((node) => ({
          nodeId: node.id,
          prompt: buildApprovedNodePrompt(draft, node)
        }))
      });
      deps.ledger.attachRun(activation.activationId, snapshot.id);
      return {
        activationId: activation.activationId,
        workflowId: materializedWorkflowId(draft),
        runId: snapshot.id,
        status: "started",
        issues: []
      };
    } catch (error) {
      deps.ledger.markFailed(activation.activationId);
      return {
        activationId: activation.activationId,
        workflowId: materializedWorkflowId(draft),
        runId: null,
        status: "failed",
        issues: [
          {
            code: "run_start_failed",
            nodeId: null,
            message: error instanceof Error ? error.message : "The run could not be started."
          }
        ]
      };
    }
  }

  /** Starts executing an approved draft. Dispatches the first eligible batch via onDispatch. */
  activate(draft: WorkflowDraft, profile: ExecutionProfile): void {
    this.service = new ActivationService({
      launcher: { dispatch: (dispatch) => this.deps.onDispatch(dispatch) },
      newId: this.deps.newId
    });
    this.service.start(draft, profile);
  }

  /** Maps a spawned worker session to its task so the session's output can be reconciled. */
  bindWorkerSession(taskId: string, sessionId: string): void {
    this.bindings.set(sessionId, { taskId, parser: createTaskResultParser() });
  }

  /** Feeds a worker session's raw output; a valid TaskResult advances the plan. */
  ingest(sessionId: string, chunk: string): void {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || this.service === null) {
      return;
    }
    for (const result of binding.parser.push(chunk)) {
      const outcome = this.service.submitResult(result);
      if (outcome.status === "applied") {
        this.bindings.delete(sessionId);
      }
      if (outcome.done) {
        this.deps.onDone?.();
      }
    }
  }

  snapshot(): ActivationSnapshot {
    return this.service?.snapshot() ?? { completed: [], running: [], failed: [], done: false };
  }
}

function invalidActivation(
  issues: readonly {
    readonly code: string;
    readonly nodeId: string | null;
    readonly message: string;
  }[]
): WorkflowActivationResult {
  return {
    activationId: null,
    workflowId: null,
    runId: null,
    status: "invalid",
    issues: issues.map((issue) => ({
      code: issue.code,
      nodeId: issue.nodeId,
      message: issue.message
    }))
  };
}

/** Stable, order-independent JSON for a definition hash (keys sorted recursively). */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
