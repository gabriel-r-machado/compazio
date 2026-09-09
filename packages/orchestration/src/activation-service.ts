import type { ExecutionProfile, TaskResult, WorkflowDraft } from "@forgedeck/schemas";

import { planActivation } from "./activation-planner";
import { openDispatch, reconcileTaskResult } from "./dispatch-reconciler";
import type { DispatchRecord, ReconcileOutcome } from "./dispatch-reconciler";
import { resolveExecutionLimits } from "./execution-limits";
import type { EffectiveExecutionLimits } from "./execution-limits";

/**
 * The scheduler brain for activation-after-approval (spec §11). It ties the pure pieces together: on
 * start it dispatches the dependency-free nodes up to the profile's concurrency cap; on each validated
 * {@link TaskResult} it advances the plan, retries failures within the limit, and dispatches the next
 * batch. It is transport-agnostic — the worker launcher is injected — so a terminal going idle can never
 * complete a task (only a submitted result does), and the whole flow stays unit-testable without a PTY.
 */

export interface WorkerDispatch {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly runtimeId: string;
}

export interface WorkerDispatchPort {
  /** Side-effecting: spawn/route a worker for this dispatch. In production this launches a PTY. */
  dispatch(input: WorkerDispatch): void;
}

export interface ActivationServiceDeps {
  readonly launcher: WorkerDispatchPort;
  readonly newId: () => string;
}

export interface ActivationSnapshot {
  readonly completed: readonly string[];
  readonly running: readonly string[];
  readonly failed: readonly string[];
  readonly done: boolean;
}

export interface SubmitResultOutcome extends ReconcileOutcome {
  readonly done: boolean;
}

export class ActivationService {
  private readonly launcher: WorkerDispatchPort;
  private readonly newId: () => string;
  private draft: WorkflowDraft | null = null;
  private limits: EffectiveExecutionLimits | null = null;
  private readonly records = new Map<string, DispatchRecord>();
  private readonly running = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly retries = new Map<string, number>();

  constructor(deps: ActivationServiceDeps) {
    this.launcher = deps.launcher;
    this.newId = deps.newId;
  }

  /** Begins execution of an approved draft: dispatches the first eligible batch. */
  start(draft: WorkflowDraft, profile: ExecutionProfile): void {
    this.draft = draft;
    this.limits = resolveExecutionLimits(profile);
    this.dispatchNext();
  }

  /** Feeds a worker's structured result; advances the plan. Idle never reaches here — only results do. */
  submitResult(result: TaskResult): SubmitResultOutcome {
    const record = this.records.get(result.taskId);
    if (record === undefined) {
      return {
        status: "rejected",
        record: openDispatch(result.taskId, result.dispatchId),
        reason: "Unknown task.",
        done: this.isDone()
      };
    }
    const outcome = reconcileTaskResult(record, result);
    if (outcome.status !== "applied") {
      return { ...outcome, done: this.isDone() };
    }
    this.records.set(result.taskId, outcome.record);
    this.running.delete(result.taskId);
    if (result.status === "completed") {
      this.completed.add(result.taskId);
    } else if (result.status === "failed" && this.canRetry(result.taskId)) {
      this.retries.set(result.taskId, (this.retries.get(result.taskId) ?? 0) + 1);
      this.dispatchNode(result.taskId);
    } else {
      this.failed.add(result.taskId);
    }
    this.dispatchNext();
    return { ...outcome, done: this.isDone() };
  }

  snapshot(): ActivationSnapshot {
    return {
      completed: [...this.completed],
      running: [...this.running],
      failed: [...this.failed],
      done: this.isDone()
    };
  }

  private canRetry(taskId: string): boolean {
    const used = this.retries.get(taskId) ?? 0;
    return used < (this.limits?.maxRetriesPerTask ?? 0);
  }

  private dispatchNext(): void {
    if (this.draft === null || this.limits === null) return;
    const plan = planActivation({
      draft: this.draft,
      maxConcurrentAgents: this.limits.maxConcurrentAgents,
      // Failed (retries exhausted) nodes are terminal: never re-dispatch them.
      completedNodeIds: [...this.completed, ...this.failed],
      runningNodeIds: [...this.running]
    });
    for (const nodeId of plan.ready) {
      this.dispatchNode(nodeId);
    }
  }

  private dispatchNode(nodeId: string): void {
    if (this.draft === null) return;
    const node = this.draft.nodes.find((entry) => entry.id === nodeId);
    const runtimeId = node?.runtimeRequirement.resolvedRuntimeId;
    if (runtimeId === undefined || runtimeId === null) return;
    const dispatchId = this.newId();
    this.records.set(nodeId, openDispatch(nodeId, dispatchId));
    this.running.add(nodeId);
    this.launcher.dispatch({ taskId: nodeId, dispatchId, runtimeId });
  }

  private isDone(): boolean {
    return this.draft !== null && this.draft.nodes.length > 0
      ? this.draft.nodes.every((node) => this.completed.has(node.id))
      : false;
  }
}
