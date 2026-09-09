import { z } from "zod";

/**
 * The neutral agent model. Compazio connects several coding agents inside one workflow, so nothing
 * here is specific to a single vendor: a node declares what it NEEDS (capabilities), the product may
 * RECOMMEND adapters, and the user CHOOSES the one that will run it.
 *
 * Two ideas are deliberately kept apart, and the rest of the product depends on that separation:
 *
 * - a *descriptor* is metadata about an agent — its display name, what it declares it can do, and its
 *   current availability. Availability is dynamic runtime state and is never persisted as a truth.
 * - an *adapter implementation* is the executable seam that can actually launch the agent. An agent
 *   can be known and described without being executable, which is exactly how an adapter that is not
 *   installed, or not implemented yet, appears in the interface.
 */

/** Every agent Compazio knows by name. An id outside this list is never inferred or accepted. */
export const AGENT_ADAPTER_IDS = ["claude-code", "codex", "opencode"] as const;
export const agentAdapterIdSchema = z.enum(AGENT_ADAPTER_IDS);
export type AgentAdapterId = z.infer<typeof agentAdapterIdSchema>;

/**
 * What a node needs, and what an agent declares it does. These are declared product configuration —
 * a vocabulary for matching work to agents — never a benchmark or a quality claim about any vendor.
 */
export const AGENT_CAPABILITIES = [
  "planning",
  "architecture",
  "frontend",
  "ui-ux",
  "backend",
  "testing",
  "review",
  "documentation",
  "repository-analysis"
] as const;
export const agentCapabilitySchema = z.enum(AGENT_CAPABILITIES);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

/** Narrows an arbitrary string to a known adapter id. Nothing else may produce an adapter id. */
export function toAgentAdapterId(value: string | null | undefined): AgentAdapterId | null {
  if (value === null || value === undefined) return null;
  return (AGENT_ADAPTER_IDS as readonly string[]).includes(value)
    ? (value as AgentAdapterId)
    : null;
}

/**
 * One node's agent decision. `recommendedAdapters` is advice in priority order and may name an agent
 * that is not installed — a recommendation is not an assignment and never authorizes execution. Only
 * `assignedAdapter` is the choice, and materialization refuses to proceed without a valid one.
 */
export const workflowNodeAgentAssignmentSchema = z
  .object({
    requiredCapabilities: z.array(agentCapabilitySchema).max(16).default([]),
    /** Ordered advice; order is preserved and meaningful. May include unavailable adapters. */
    recommendedAdapters: z.array(agentAdapterIdSchema).max(8).default([]),
    /** The user's (or a preset's) explicit choice. Null means the node still needs a decision. */
    assignedAdapter: agentAdapterIdSchema.nullable().default(null),
    /** Ordered candidates a future fallback phase may offer; never applied automatically here. */
    fallbackAdapters: z.array(agentAdapterIdSchema).max(8).default([]),
    /** Short, human-readable reason for the recommendation or the preset's choice. */
    recommendationReason: z.string().trim().max(2_000).default("")
  })
  .strict();
export type WorkflowNodeAgentAssignment = z.infer<typeof workflowNodeAgentAssignmentSchema>;

export const AGENT_ASSIGNMENT_DEFAULT: WorkflowNodeAgentAssignment =
  workflowNodeAgentAssignmentSchema.parse({});

/** Why an agent cannot be used right now. Dynamic state: shown, acted on, never persisted as truth. */
export const agentUnavailabilitySchema = z
  .object({
    code: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2_000),
    remediation: z.string().trim().max(2_000).default("")
  })
  .strict();
export type AgentUnavailability = z.infer<typeof agentUnavailabilitySchema>;

/**
 * Everything the product knows about one agent. `available`, `authenticated` and `version` are
 * observations of the local machine at a point in time — they belong to a live capability registry and
 * are never stored as a permanent fact about the workflow.
 */
export const agentDescriptorSchema = z
  .object({
    id: agentAdapterIdSchema,
    displayName: z.string().trim().min(1).max(160),
    /** Declared, product-configured capabilities. Not a benchmark and not a ranking. */
    capabilities: z.array(agentCapabilitySchema).max(32).default([]),
    available: z.boolean(),
    /** Null when authentication cannot be determined by a safe, unpaid local check. */
    authenticated: z.boolean().nullable().default(null),
    version: z.string().trim().max(200).nullable().default(null),
    supportsPlanning: z.boolean(),
    supportsExecution: z.boolean(),
    supportsPipe: z.boolean(),
    /** Interactive terminal agents are a later milestone; declared so the UI can say so honestly. */
    supportsInteractive: z.boolean().default(false),
    /** True only when an executable adapter implementation is registered for this id. */
    hasImplementation: z.boolean().default(false),
    knownLimitations: z.array(z.string().trim().min(1).max(500)).max(16).default([]),
    unavailability: agentUnavailabilitySchema.nullable().default(null)
  })
  .strict();
export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>;

/**
 * How a preset picks agents for a whole draft. Every preset is deterministic and decides only from
 * availability, declared capabilities, the node's ordered recommendations and an explicit preference
 * order. `manual` decides nothing: the user must choose every node.
 */
export const agentAssignmentPresetSchema = z.enum([
  "automatic",
  "quality",
  "economic",
  "speed",
  "manual"
]);
export type AgentAssignmentPreset = z.infer<typeof agentAssignmentPresetSchema>;

/**
 * The product's stated preference order per preset. This is a documented product preference used to
 * break ties deterministically — it is NOT a benchmark and makes no claim that one agent is
 * objectively better than another. A preset never selects an unavailable agent, so this order only
 * ever ranks candidates that already passed availability and capability checks.
 */
export const AGENT_PRESET_PREFERENCE: Readonly<
  Record<AgentAssignmentPreset, readonly AgentAdapterId[]>
> = {
  automatic: ["claude-code", "codex", "opencode"],
  quality: ["claude-code", "codex", "opencode"],
  economic: ["opencode", "codex", "claude-code"],
  speed: ["codex", "opencode", "claude-code"],
  manual: []
};
