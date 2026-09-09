import { taskResultSchema } from "@forgedeck/schemas";
import type { TaskResult } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { openDispatch, reconcileTaskResult } from "./dispatch-reconciler";

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return taskResultSchema.parse({
    taskId: "task-1",
    dispatchId: "dispatch-1",
    status: "completed",
    summary: "done",
    completedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  });
}

describe("reconcileTaskResult", () => {
  it("completes a task only on a matching, validated result (idle never completes)", () => {
    const record = openDispatch("task-1", "dispatch-1");
    expect(record.status).toBe("dispatched");
    const outcome = reconcileTaskResult(record, result());
    expect(outcome.status).toBe("applied");
    expect(outcome.record.status).toBe("completed");
  });

  it("is idempotent: a repeated worker_done for the same dispatch changes nothing", () => {
    const record = openDispatch("task-1", "dispatch-1");
    const first = reconcileTaskResult(record, result());
    const second = reconcileTaskResult(first.record, result());
    expect(second.status).toBe("ignored");
    expect(second.record).toEqual(first.record);
  });

  it("rejects a stale retry: an old dispatchId cannot complete a newer dispatch", () => {
    // The task was retried, so the active dispatch is now dispatch-2.
    const record = openDispatch("task-1", "dispatch-2");
    const outcome = reconcileTaskResult(record, result({ dispatchId: "dispatch-1" }));
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/stale|dispatch/i);
    expect(outcome.record.status).toBe("dispatched");
  });

  it("rejects a result addressed to a different task", () => {
    const record = openDispatch("task-1", "dispatch-1");
    const outcome = reconcileTaskResult(record, result({ taskId: "task-2" }));
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/task/i);
  });

  it("carries the terminal status through (blocked/failed/cancelled)", () => {
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      const record = openDispatch("task-1", "dispatch-1");
      const outcome = reconcileTaskResult(record, result({ status }));
      expect(outcome.status).toBe("applied");
      expect(outcome.record.status).toBe(status);
    }
  });

  it("a fresh retry after a failure accepts the new dispatch's result", () => {
    const failed = reconcileTaskResult(
      openDispatch("task-1", "dispatch-1"),
      result({ status: "failed" })
    );
    expect(failed.record.status).toBe("failed");
    // The scheduler retries → a new dispatch supersedes the failed one.
    const retried = openDispatch("task-1", "dispatch-2");
    const outcome = reconcileTaskResult(retried, result({ dispatchId: "dispatch-2" }));
    expect(outcome.status).toBe("applied");
    expect(outcome.record.status).toBe("completed");
  });
});
