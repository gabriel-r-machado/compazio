import type { TaskResult, TaskResultStatus } from "@forgedeck/schemas";

/**
 * The completion rule for coordinated work (spec §11.4, acceptance §20.5). A task is never "done"
 * because a terminal went idle — it completes only when a worker returns a {@link TaskResult} whose
 * `dispatchId` matches the task's currently-active dispatch. This makes three guarantees:
 *
 *  - idle ≠ done: nothing here observes terminal silence; completion is an explicit result;
 *  - idempotent `worker_done`: replaying the same result for a completed dispatch is a no-op;
 *  - no stale completion: a result from an old (retried) dispatch is rejected, never applied.
 */

export type DispatchStatus = "dispatched" | TaskResultStatus;

export interface DispatchRecord {
  readonly taskId: string;
  /** The single dispatch the task currently expects a result from. A retry mints a new id. */
  readonly dispatchId: string;
  readonly status: DispatchStatus;
}

export type ReconcileStatus = "applied" | "ignored" | "rejected";

export interface ReconcileOutcome {
  readonly status: ReconcileStatus;
  /** The record after reconciliation (unchanged for ignored/rejected). */
  readonly record: DispatchRecord;
  readonly reason?: string;
}

/** Opens a fresh dispatch for a task; the scheduler calls this on first dispatch and on each retry. */
export function openDispatch(taskId: string, dispatchId: string): DispatchRecord {
  return { taskId, dispatchId, status: "dispatched" };
}

const TERMINAL: ReadonlySet<DispatchStatus> = new Set<DispatchStatus>([
  "completed",
  "blocked",
  "failed",
  "cancelled"
]);

export function reconcileTaskResult(record: DispatchRecord, result: TaskResult): ReconcileOutcome {
  if (result.taskId !== record.taskId) {
    return {
      status: "rejected",
      record,
      reason: `Result addresses task "${result.taskId}", not "${record.taskId}".`
    };
  }
  if (result.dispatchId !== record.dispatchId) {
    // A result from an old dispatch (e.g. a retried worker that finally spoke) must not complete the
    // current one.
    return {
      status: "rejected",
      record,
      reason: `Stale dispatch "${result.dispatchId}"; the active dispatch is "${record.dispatchId}".`
    };
  }
  if (TERMINAL.has(record.status)) {
    // worker_done is idempotent: the dispatch already reached a terminal state.
    return { status: "ignored", record };
  }
  return { status: "applied", record: { ...record, status: result.status } };
}
