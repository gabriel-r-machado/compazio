import { z } from "zod";

/**
 * Two independent workspace controls that the header exposes and that persist with the canvas.
 *
 * - {@link creationModeSchema} decides HOW a workflow is assembled: `manual` (the user creates and
 *   connects nodes) or `automatic` (a Workflow Orchestrator composes a draft on the canvas).
 * - {@link executionProfileSchema} decides HOW tokens, models, context, parallelism, retries and
 *   validation are administered once the workflow runs.
 *
 * They are orthogonal and valid in any combination. The profile presets are persisted and displayed
 * from this phase, but their real effect on models/tokens/context/parallelism/retries is deferred to
 * the ContextCompiler/BudgetGovernor work (Phase 4); nothing here changes execution yet.
 */
export const creationModeSchema = z.enum(["manual", "automatic"]);
export const executionProfileSchema = z.enum(["economy", "balanced", "maximum"]);

/** Balanced is the default profile everywhere a value is missing. */
export const DEFAULT_EXECUTION_PROFILE = "balanced" as const;
export const DEFAULT_CREATION_MODE = "manual" as const;

export const executionModelRoutingSchema = z.enum([
  "lowest_capable",
  "best_cost_capability",
  "highest_capability"
]);
export const executionContextStrategySchema = z.enum([
  "strict_relevance",
  "selective",
  "broad_relevance"
]);
export const executionReviewDepthSchema = z.enum([
  "milestone_only",
  "standard",
  "independent_cross_review"
]);

export const executionProfileConfigSchema = z
  .object({
    modelRouting: executionModelRoutingSchema,
    contextStrategy: executionContextStrategySchema,
    defaultParallelism: z.number().int().min(1).max(16),
    maxParallelism: z.number().int().min(1).max(32),
    reviewDepth: executionReviewDepthSchema,
    maxRetries: z.number().int().min(0).max(10),
    duplicateRoleReduction: z.boolean(),
    deltaHandoffs: z.boolean(),
    automaticEscalation: z.boolean()
  })
  .strict();

export type CreationMode = z.infer<typeof creationModeSchema>;
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type ExecutionProfileConfig = z.infer<typeof executionProfileConfigSchema>;

/**
 * The exact preset policies from the product spec. These are the source of truth for what each
 * profile MEANS; they are informational in this phase and consumed for real by the scheduler and
 * budget governor in a later phase.
 */
export const EXECUTION_PROFILE_CONFIG: Readonly<Record<ExecutionProfile, ExecutionProfileConfig>> =
  Object.freeze({
    economy: {
      modelRouting: "lowest_capable",
      contextStrategy: "strict_relevance",
      defaultParallelism: 1,
      maxParallelism: 2,
      reviewDepth: "milestone_only",
      maxRetries: 1,
      duplicateRoleReduction: true,
      deltaHandoffs: true,
      automaticEscalation: true
    },
    balanced: {
      modelRouting: "best_cost_capability",
      contextStrategy: "selective",
      defaultParallelism: 2,
      maxParallelism: 3,
      reviewDepth: "standard",
      maxRetries: 2,
      duplicateRoleReduction: false,
      deltaHandoffs: true,
      automaticEscalation: true
    },
    maximum: {
      modelRouting: "highest_capability",
      contextStrategy: "broad_relevance",
      defaultParallelism: 3,
      maxParallelism: 8,
      reviewDepth: "independent_cross_review",
      maxRetries: 3,
      duplicateRoleReduction: false,
      deltaHandoffs: true,
      automaticEscalation: true
    }
  });

export function executionProfileConfig(profile: ExecutionProfile): ExecutionProfileConfig {
  return EXECUTION_PROFILE_CONFIG[profile];
}

/**
 * Reads a legacy token-budget label (the old single toggle) as a modern execution profile so
 * canvases saved before this refactor keep opening without a migration: `economico` → economy,
 * `completo` → balanced. Anything already valid passes through.
 */
export function coerceLegacyExecutionProfile(value: unknown): ExecutionProfile {
  if (value === "economico") return "economy";
  if (value === "completo") return "balanced";
  const parsed = executionProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_EXECUTION_PROFILE;
}

/**
 * Visual state of a node as it moves from a composed ghost to a finished run. Only `draft` and
 * `configured` are produced during composition; the later states belong to activation/execution
 * (Phase 3+), but the whole vocabulary lives here so persisted drafts and the canvas agree.
 */
export const canvasNodeLifecycleSchema = z.enum([
  "draft",
  "configured",
  "queued",
  "starting",
  "running",
  "waiting_handoff",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
]);
export type CanvasNodeLifecycle = z.infer<typeof canvasNodeLifecycleSchema>;

/**
 * A user's lock over a node. When `lockedByUser` is set the orchestrator may not silently overwrite
 * the node; when `lockedFields` is present only those fields are protected. The composer rejects a
 * conflicting update deterministically instead of ignoring it.
 */
export const workflowNodeLockSchema = z
  .object({
    lockedByUser: z.boolean(),
    lockedFields: z.array(z.string().min(1).max(64)).max(32).optional()
  })
  .strict();
export type WorkflowNodeLock = z.infer<typeof workflowNodeLockSchema>;
