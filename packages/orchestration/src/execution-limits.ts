import { executionProfileConfig } from "@forgedeck/schemas";
import type { ExecutionProfile } from "@forgedeck/schemas";

import { ORCHESTRATOR_GLOBAL_LIMITS } from "./orchestrator-prompt";

/**
 * The real, enforceable limits for an execution profile (spec §10, §16.1). A profile preset expresses
 * intent, but the global safety ceilings win: Alta Performance must never exceed three concurrent or
 * six spawned agents (acceptance §20.4.3), regardless of the preset's parallelism. This is the single
 * place that reconciles "profile preset" with "global limit", so the scheduler cannot over-provision.
 */
export interface EffectiveExecutionLimits {
  readonly maxConcurrentAgents: number;
  readonly maxSpawnedAgents: number;
  readonly maxRetriesPerTask: number;
}

export function resolveExecutionLimits(profile: ExecutionProfile): EffectiveExecutionLimits {
  const preset = executionProfileConfig(profile);
  return {
    maxConcurrentAgents: Math.min(
      preset.maxParallelism,
      ORCHESTRATOR_GLOBAL_LIMITS.maxConcurrentAgents
    ),
    maxSpawnedAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxSpawnedAgents,
    maxRetriesPerTask: Math.min(preset.maxRetries, ORCHESTRATOR_GLOBAL_LIMITS.maxRetriesPerNode)
  };
}
