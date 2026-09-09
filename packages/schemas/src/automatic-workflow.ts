import { z } from "zod";

import type { ExecutionProfile } from "./workflow-mode";

/**
 * The entry contract for Automatic Mode. The user supplies only an objective and a budget mode; the
 * product — never the model — fixes the enforceable limits. The AutomaticWorkflowCoordinator threads
 * these through the existing materialization, runtime, verification and remediation, so the model can
 * never widen its own budget or run an unbounded loop.
 */

export const automaticWorkflowModeSchema = z.enum(["economic", "standard", "high-performance"]);
export type AutomaticWorkflowMode = z.infer<typeof automaticWorkflowModeSchema>;

export const automaticWorkflowLimitsSchema = z
  .object({
    /** Hard cap on how many nodes the generated plan may contain. */
    maxWorkflowNodes: z.number().int().min(1).max(50),
    /** How many automatic verify→remediate→retry cycles the whole run may perform. */
    maxRemediationCycles: z.number().int().min(0).max(5),
    /** How many attempts a single node may accumulate (initial attempt included). */
    maxAttemptsPerNode: z.number().int().min(1).max(6),
    /** Wall-clock ceiling for the entire automatic run. */
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(6 * 60 * 60 * 1_000)
  })
  .strict();
export type AutomaticWorkflowLimits = z.infer<typeof automaticWorkflowLimitsSchema>;

export const automaticWorkflowRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    objective: z.string().trim().min(1).max(8_000),
    mode: automaticWorkflowModeSchema,
    limits: automaticWorkflowLimitsSchema
  })
  .strict();
export type AutomaticWorkflowRequest = z.infer<typeof automaticWorkflowRequestSchema>;

/**
 * Product-defined default limits per mode, before the global safety ceilings are applied. Modes
 * express budget and strategy, not minimum quality or safety — every mode still runs the full
 * verification. The clamp against ORCHESTRATOR_GLOBAL_LIMITS lives in the orchestration package.
 */
export const AUTOMATIC_MODE_DEFAULT_LIMITS: Readonly<
  Record<AutomaticWorkflowMode, AutomaticWorkflowLimits>
> = Object.freeze({
  economic: {
    maxWorkflowNodes: 4,
    maxRemediationCycles: 1,
    maxAttemptsPerNode: 2,
    timeoutMs: 20 * 60 * 1_000
  },
  standard: {
    maxWorkflowNodes: 8,
    maxRemediationCycles: 2,
    maxAttemptsPerNode: 2,
    timeoutMs: 45 * 60 * 1_000
  },
  "high-performance": {
    maxWorkflowNodes: 12,
    maxRemediationCycles: 3,
    maxAttemptsPerNode: 3,
    timeoutMs: 90 * 60 * 1_000
  }
});

/** Maps a budget mode to the internal execution profile that drives model/context/parallelism policy. */
export function automaticModeToExecutionProfile(mode: AutomaticWorkflowMode): ExecutionProfile {
  switch (mode) {
    case "economic":
      return "economy";
    case "standard":
      return "balanced";
    case "high-performance":
      return "maximum";
  }
}
