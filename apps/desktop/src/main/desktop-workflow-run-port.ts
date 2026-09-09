import { createHash } from "node:crypto";

import type { OrchestratorPlanNode, WorkflowDraft } from "@forgedeck/schemas";
import type { NodeRunOutcome, RunOutcome, WorkflowRunPort } from "@forgedeck/orchestration";
import {
  materializedWorkflowId,
  materializeWorkflowDraft,
  type WorkflowRunSnapshot
} from "@forgedeck/orchestration";
import type { Workflow } from "@forgedeck/workflow";
import { workflowSchema } from "@forgedeck/workflow";

import type {
  WorkflowRetrySelection,
  WorkflowRunExecutionTarget,
  WorkflowRunRuntime
} from "./workflow-run-runtime";

/**
 * The real {@link WorkflowRunPort}: it translates the automatic coordinator's requests into the desktop's
 * ALREADY LIVE official services and nothing else. It owns no runtime, scheduler, queue, store or
 * executor, and it never constructs a WorkflowRunRuntime — the single live instance is injected.
 *
 * Remediation starts the next run of the lineage, because the official runtime never re-dispatches a node
 * inside a live run and never rewrites a finished run's definition, evidence or report. Each cycle is
 * therefore its own immutable, auditable run linked to the previous one.
 */

/** Where the run executes. Supplied by the caller; the port never invents a root or a worktree. */
export interface AutomaticRunTargetResolver {
  resolveTarget(workspaceId: string): WorkflowRunExecutionTarget;
}

/** Records the prompt each node of each run must receive, since the definition cannot carry it. */
export interface AutomaticPromptWriter {
  putNodePrompt(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly cycle: number;
    readonly prompt: string;
  }): void;
}

/** The idempotency ledger for materialization, so one draft revision can create at most one first run. */
export interface AutomaticActivationLedger {
  ensureIntent(input: {
    readonly draftId: string;
    readonly draftVersion: number;
    readonly workspaceId: string;
    readonly workflowId: string;
    readonly definitionSha256: string;
  }): { readonly activationId: string; readonly runId: string | null };
  attachRun(activationId: string, runId: string): void;
  markFailed(activationId: string): void;
}

/** The artifact surface used to decide whether a node published what it declared. */
export interface AutomaticArtifactReader {
  getNodeArtifact(runId: string, nodeId: string): { readonly id: string } | null;
}

export interface DesktopWorkflowRunPortDeps {
  /** The single live runtime of the desktop; never created here. */
  readonly runtime: WorkflowRunRuntime;
  readonly targets: AutomaticRunTargetResolver;
  readonly prompts: AutomaticPromptWriter;
  readonly activations: AutomaticActivationLedger;
  readonly artifacts: AutomaticArtifactReader;
  /** Nodes whose declared artifacts matter, by node id, taken from the validated plan. */
  readonly expectsArtifact: (nodeId: string) => boolean;
  readonly workspaceId: string;
}

export class DesktopWorkflowRunPort implements WorkflowRunPort {
  /** Node prompts as they stand for the next run of the lineage, by node id. */
  private readonly promptsByNode = new Map<string, string>();
  /** Completion of the runs this port started, so waiting never polls a run it owns. */
  private readonly pending = new Map<string, Promise<WorkflowRunSnapshot>>();
  /** The run's agent target, decided by the official materializer and reused by the whole lineage. */
  private agentNodeId: string | null = null;
  private cycle = 0;

  public constructor(private readonly deps: DesktopWorkflowRunPortDeps) {}

  /**
   * Materializes the approved draft through the official materializer and starts the lineage's first run
   * on the live runtime. The activation ledger makes it idempotent: a repeated call for the same draft
   * revision returns the run that already exists instead of starting a second one.
   */
  public async materializeAndStart(draft: WorkflowDraft): Promise<{ readonly runId: string }> {
    const materialization = materializeWorkflowDraft(draft);
    if (materialization.workflow === null) {
      throw new Error(
        `The automatic draft could not be materialized: ${materialization.issues
          .map((issue) => issue.message)
          .join("; ")}`
      );
    }
    const workflow = materialization.workflow;
    // The materializer names the run's agent target; the whole lineage keeps that same target.
    this.agentNodeId = materialization.agentNodeIds[0] ?? null;
    const activation = this.deps.activations.ensureIntent({
      draftId: draft.id,
      draftVersion: draft.version,
      workspaceId: this.deps.workspaceId,
      workflowId: materializedWorkflowId(draft),
      definitionSha256: definitionHash(workflow)
    });
    // A run already bound to this draft revision is THE run; never start a second one.
    if (activation.runId !== null) return { runId: activation.runId };

    // Each node's generated prompt is recorded against the run before it can be launched.
    for (const node of draft.nodes) {
      this.promptsByNode.set(node.id, node.objective);
    }
    try {
      const handle = this.deps.runtime.startMaterialized({
        workflow,
        target: this.target(),
        prepareRun: (runId) => this.recordPrompts(runId)
      });
      this.pending.set(handle.runId, handle.completion);
      this.deps.activations.attachRun(activation.activationId, handle.runId);
      return { runId: handle.runId };
    } catch (error: unknown) {
      this.deps.activations.markFailed(activation.activationId);
      throw error;
    }
  }

  /**
   * Waits for the run to finish and reports the structural outcome per node: a node succeeded only if the
   * official runtime says its node run succeeded AND it published the artifact it declared. A terminal
   * phrase in the transcript proves nothing here.
   */
  public async awaitOutcome(runId: string): Promise<RunOutcome> {
    // A run this port started is awaited through its own handle. After a reload the handle is gone and the
    // stored snapshot is authoritative: recovery has already marked an interrupted run, so reading it is
    // correct and never fabricates a still-running state.
    const pending = this.pending.get(runId);
    const snapshot = pending === undefined ? this.deps.runtime.show(runId) : await pending;
    this.pending.delete(runId);
    return {
      runId,
      state: toRunState(snapshot),
      nodes: snapshot.nodeRuns.map((nodeRun): NodeRunOutcome => {
        const structuralSuccess = nodeRun.state === "succeeded";
        const hasExpectedArtifacts =
          !this.deps.expectsArtifact(nodeRun.nodeId) ||
          this.deps.artifacts.getNodeArtifact(runId, nodeRun.nodeId) !== null;
        return {
          nodeId: nodeRun.nodeId,
          structuralSuccess: structuralSuccess && hasExpectedArtifacts,
          hasExpectedArtifacts,
          attempts: nodeRun.attempt
        };
      })
    };
  }

  /**
   * Retries one node with its corrected prompt as the next run of the lineage. The official retry covers
   * the node and the dependents it releases, so fixing it re-runs exactly what depended on it.
   */
  public async retryNode(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly updatedPrompt: string;
  }): Promise<{ readonly runId: string }> {
    this.cycle += 1;
    this.promptsByNode.set(input.nodeId, input.updatedPrompt);
    const selection: WorkflowRetrySelection = { nodeId: input.nodeId, scope: "dependents" };
    const handle = this.deps.runtime.retry(input.runId, this.target(), selection, (runId) =>
      this.recordPrompts(runId)
    );
    this.pending.set(handle.runId, handle.completion);
    return { runId: handle.runId };
  }

  /**
   * Starts the next run of the lineage with ONE corrective node appended after the node it corrects. The
   * previous run's definition is read, never mutated, so history stays intact and the fix is added work.
   */
  public async addCorrectiveNode(input: {
    readonly runId: string;
    readonly node: OrchestratorPlanNode;
  }): Promise<{ readonly runId: string }> {
    this.cycle += 1;
    const previous = this.deps.runtime.definition(input.runId);
    if (previous.nodes.some((node) => node.id === input.node.id)) {
      throw new Error("The corrective node id already exists in the workflow definition");
    }
    const workflow = workflowSchema.parse({
      ...previous,
      nodes: [
        ...previous.nodes,
        {
          id: input.node.id,
          type: "agent" as const,
          title: input.node.title,
          role: input.node.role,
          adapter: input.node.adapter,
          depends_on: [...input.node.dependsOn],
          permissions: {}
        }
      ]
    });
    this.promptsByNode.set(input.node.id, input.node.prompt);
    const handle = this.deps.runtime.startMaterialized({
      workflow,
      target: this.target(),
      prepareRun: (runId) => this.recordPrompts(runId)
    });
    this.pending.set(handle.runId, handle.completion);
    return { runId: handle.runId };
  }

  public async pause(runId: string): Promise<void> {
    await this.deps.runtime.pause(runId);
  }

  public async resumeRun(runId: string): Promise<void> {
    await this.deps.runtime.resume(runId);
  }

  public snapshot(runId: string): WorkflowRunSnapshot {
    return this.deps.runtime.show(runId);
  }

  public async cancel(runId: string): Promise<void> {
    await this.deps.runtime.cancel(runId);
  }

  /**
   * The execution target for every run of the lineage: the caller's root plus the agent target the
   * official materializer chose, which the runtime requires for a workflow that contains agent nodes.
   */
  private target(): WorkflowRunExecutionTarget {
    const base = this.deps.targets.resolveTarget(this.deps.workspaceId);
    return this.agentNodeId === null ? base : { ...base, agentNodeId: this.agentNodeId };
  }

  /**
   * Records the prompt that currently applies to each node against the new run, before it can launch. A
   * prompt for a node the run does not contain is simply never looked up, and an existing (run, node) pair
   * is never rewritten, so an earlier run's prompt stays exactly as it was used.
   */
  private recordPrompts(runId: string): void {
    for (const [nodeId, prompt] of this.promptsByNode) {
      this.deps.prompts.putNodePrompt({ runId, nodeId, cycle: this.cycle, prompt });
    }
  }
}

function toRunState(snapshot: WorkflowRunSnapshot): RunOutcome["state"] {
  if (snapshot.state === "succeeded") return "succeeded";
  if (snapshot.state === "cancelled") return "cancelled";
  return "failed";
}

function definitionHash(workflow: Workflow): string {
  return createHash("sha256").update(JSON.stringify(workflow), "utf8").digest("hex");
}
