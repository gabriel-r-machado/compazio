import { z } from "zod";

/**
 * Structured completion contracts for coordinated work (spec §11). A worker never "finishes" because
 * its terminal went idle — the scheduler only considers a task done when it receives and validates a
 * {@link taskResultSchema}. Every coordinated unit carries a `taskId` and a `dispatchId`, so a stale
 * retry can never complete a newer dispatch and a repeated `worker_done` is idempotent.
 */

/** Wire sentinels a coordinated worker uses to report its structured result (spec §11.4). */
export const ORCHESTRATOR_RESULT_OPEN = "⟦compasso:result⟧";
export const ORCHESTRATOR_RESULT_CLOSE = "⟦/compasso⟧";

export const taskResultStatusSchema = z.enum(["completed", "blocked", "failed", "cancelled"]);
export type TaskResultStatus = z.infer<typeof taskResultStatusSchema>;

export const taskCheckSchema = z
  .object({
    command: z.string().trim().min(1).max(2_000),
    status: z.enum(["passed", "failed", "skipped"]),
    summary: z.string().trim().max(2_000).optional()
  })
  .strict();
export type TaskCheck = z.infer<typeof taskCheckSchema>;

export const taskArtifactSchema = z
  .object({
    type: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(4_096)
  })
  .strict();
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;

/** The single source of truth a worker returns; the scheduler validates it before marking a task done. */
export const taskResultSchema = z
  .object({
    taskId: z.string().trim().min(1).max(160),
    dispatchId: z.string().trim().min(1).max(160),
    status: taskResultStatusSchema,
    summary: z.string().trim().max(8_000),
    filesModified: z.array(z.string().trim().min(1).max(4_096)).max(1_000).default([]),
    checksRun: z.array(taskCheckSchema).max(64).default([]),
    artifacts: z.array(taskArtifactSchema).max(256).default([]),
    decisions: z.array(z.string().trim().min(1).max(2_000)).max(128).default([]),
    remainingIssues: z.array(z.string().trim().min(1).max(2_000)).max(128).default([]),
    completedAt: z.string().datetime({ offset: true })
  })
  .strict();
export type TaskResult = z.infer<typeof taskResultSchema>;

/** The compact summary the NEXT agent receives — not the raw transcript (spec §11.5). */
export const handoffSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    fromTaskId: z.string().trim().min(1).max(160),
    toTaskId: z.string().trim().min(1).max(160),
    summary: z.string().trim().max(8_000),
    decisions: z.array(z.string().trim().min(1).max(2_000)).max(128).default([]),
    filesModified: z.array(z.string().trim().min(1).max(4_096)).max(1_000).default([]),
    artifacts: z.array(z.string().trim().min(1).max(4_096)).max(256).default([]),
    checks: z.array(z.string().trim().min(1).max(2_000)).max(128).default([]),
    risks: z.array(z.string().trim().min(1).max(2_000)).max(128).default([]),
    openQuestions: z.array(z.string().trim().min(1).max(2_000)).max(128).default([]),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();
export type Handoff = z.infer<typeof handoffSchema>;

/** Message types on the coordination bus (spec §11.2). */
export const messageTypeSchema = z.enum([
  "instruction",
  "status",
  "question",
  "answer",
  "heartbeat",
  "worker_done",
  "blocked",
  "failed",
  "approval_request",
  "handoff"
]);
export type MessageType = z.infer<typeof messageTypeSchema>;
