import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  automaticModeToExecutionProfile,
  type AutomaticWorkflowLimits,
  type AutomaticWorkflowMode
} from "@forgedeck/schemas";
import type { ExecutionProfile } from "@forgedeck/schemas";

import { resolveExecutionLimits, type EffectiveExecutionLimits } from "./execution-limits";
import { ORCHESTRATOR_GLOBAL_LIMITS } from "./orchestrator-prompt";

/**
 * The concrete, enforceable strategy for an automatic-mode budget. It merges the product defaults for
 * the mode with any product-supplied overrides, then clamps every value to the inviolable global
 * ceilings. The model never sees this resolver — it only ever receives already-bounded limits, so it
 * cannot widen its own budget. Modes differ in budget/strategy, never in the minimum safety applied.
 */
export interface AutomaticModeStrategy {
  readonly mode: AutomaticWorkflowMode;
  readonly executionProfile: ExecutionProfile;
  /** Bounded budget for the whole automatic run. */
  readonly limits: AutomaticWorkflowLimits;
  /** Concurrency / spawned-agent / retry ceilings from the execution profile (already global-clamped). */
  readonly executionLimits: EffectiveExecutionLimits;
}

export function resolveAutomaticModeStrategy(
  mode: AutomaticWorkflowMode,
  overrides?: Partial<AutomaticWorkflowLimits>
): AutomaticModeStrategy {
  const base = AUTOMATIC_MODE_DEFAULT_LIMITS[mode];
  const merged: AutomaticWorkflowLimits = { ...base, ...overrides };
  const executionProfile = automaticModeToExecutionProfile(mode);
  const executionLimits = resolveExecutionLimits(executionProfile);

  const limits: AutomaticWorkflowLimits = {
    // Total nodes is a product budget (parallelism is bounded separately by executionLimits); it is not
    // clamped to the spawned-agent ceiling because nodes run under a concurrency cap, not all at once.
    maxWorkflowNodes: merged.maxWorkflowNodes,
    // A remediation cycle maps to at most the global per-node retry ceiling.
    maxRemediationCycles: Math.min(
      merged.maxRemediationCycles,
      ORCHESTRATOR_GLOBAL_LIMITS.maxRetriesPerNode + 1
    ),
    // Attempts include the initial one, so the ceiling is retries + 1.
    maxAttemptsPerNode: Math.min(
      merged.maxAttemptsPerNode,
      ORCHESTRATOR_GLOBAL_LIMITS.maxRetriesPerNode + 1
    ),
    timeoutMs: Math.min(merged.timeoutMs, ORCHESTRATOR_GLOBAL_LIMITS.maxRuntimeMinutes * 60 * 1_000)
  };

  return { mode, executionProfile, limits, executionLimits };
}
