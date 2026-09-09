import { AGENT_ADAPTER_IDS, agentDescriptorSchema } from "@forgedeck/schemas";
import type { AgentAdapterId, AgentCapability, AgentDescriptor } from "@forgedeck/schemas";

import type { AgentAdapterRegistry } from "./agent-adapter-registry";

/**
 * The one catalog of agents Compazio knows about — deliberately SEPARATE from
 * {@link AgentAdapterRegistry}, which owns executable launch plans.
 *
 * This registry answers "what is this agent, what does it declare it can do, and can I use it right
 * now". The adapter registry answers "how do I launch it". Keeping them apart is what lets an agent be
 * a first-class, selectable option in the interface while having no executable implementation yet:
 * Codex and OpenCode are known here, described honestly as unavailable, and are never silently
 * treated as runnable.
 *
 * Availability, version and authentication are observations of the local machine at a point in time.
 * They are served live, refreshed on demand, and NEVER persisted as a permanent fact about a workflow;
 * only the chosen adapter ids belong in a document. No credential, token or profile content is read,
 * copied or stored — each CLI keeps owning its own authentication.
 */

/** Immutable, product-configured facts about one agent. Never a benchmark and never a ranking. */
export interface AgentDescriptorProfile {
  readonly id: AgentAdapterId;
  readonly displayName: string;
  readonly capabilities: readonly AgentCapability[];
  readonly supportsPlanning: boolean;
  readonly supportsExecution: boolean;
  readonly supportsPipe: boolean;
  readonly supportsInteractive: boolean;
  readonly knownLimitations: readonly string[];
  /** Shown when no executable implementation is registered for this agent yet. */
  readonly notImplementedRemediation: string;
}

/**
 * Every capability the product declares for each agent. The lists are intentionally broad and equal
 * where the work is genuinely comparable: they exist to match work to agents, not to assert that one
 * vendor is better than another. Claude's list is complete so no workflow that runs today can be
 * blocked by an incomplete declaration.
 */
const ALL_CAPABILITIES: readonly AgentCapability[] = [
  "planning",
  "architecture",
  "frontend",
  "ui-ux",
  "backend",
  "testing",
  "review",
  "documentation",
  "repository-analysis"
];

export const AGENT_DESCRIPTOR_PROFILES: Readonly<Record<AgentAdapterId, AgentDescriptorProfile>> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: ALL_CAPABILITIES,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    supportsInteractive: false,
    knownLimitations: ["Runs single-shot only; the interactive terminal is a later milestone."],
    notImplementedRemediation: "Install Claude Code and ensure `claude` is available on PATH."
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    // Declared for execution work. Planning is deliberately absent in this phase: Codex has no
    // orchestrator port yet, so claiming the capability would offer a choice that cannot be honoured.
    capabilities: [
      "architecture",
      "frontend",
      "ui-ux",
      "backend",
      "testing",
      "review",
      "documentation",
      "repository-analysis"
    ],
    supportsPlanning: false,
    supportsExecution: true,
    supportsPipe: true,
    supportsInteractive: false,
    knownLimitations: [
      "Runs single-shot through `codex exec`; the interactive terminal is a later milestone.",
      "Cannot plan a workflow yet: selecting Codex as the orchestrator is a later milestone."
    ],
    notImplementedRemediation:
      "Install the Codex CLI (npm i -g @openai/codex) and ensure `codex` is on PATH."
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    // Declared for execution work. Planning is deliberately absent in this phase: OpenCode has no
    // orchestrator port yet, so claiming the capability would offer a choice that cannot be honoured.
    capabilities: [
      "architecture",
      "frontend",
      "ui-ux",
      "backend",
      "testing",
      "review",
      "documentation",
      "repository-analysis"
    ],
    supportsPlanning: false,
    supportsExecution: true,
    supportsPipe: true,
    supportsInteractive: false,
    knownLimitations: [
      "Runs single-shot through `opencode run`; the interactive terminal is a later milestone.",
      "Cannot plan a workflow yet: selecting OpenCode as the orchestrator is a later milestone.",
      "Uses your own provider configuration and permission policy; Compazio never bypasses either."
    ],
    notImplementedRemediation:
      "Install the OpenCode CLI (npm i -g opencode-ai) and ensure `opencode` is on PATH."
  }
};

export class AgentDescriptorRegistry {
  private readonly profiles: Readonly<Record<AgentAdapterId, AgentDescriptorProfile>>;
  private readonly detected = new Map<AgentAdapterId, AgentDescriptor>();

  public constructor(
    /**
     * The executable adapters. Only their presence is read — this registry never launches anything
     * and never asks an adapter to plan a launch.
     */
    private readonly adapters: Pick<AgentAdapterRegistry, "has" | "detect">,
    profiles: Readonly<Record<AgentAdapterId, AgentDescriptorProfile>> = AGENT_DESCRIPTOR_PROFILES
  ) {
    this.profiles = profiles;
  }

  /** Every known agent, with whatever availability the last refresh observed. */
  public list(): readonly AgentDescriptor[] {
    return AGENT_ADAPTER_IDS.map((id) => this.detected.get(id) ?? this.unprobed(id));
  }

  public get(id: AgentAdapterId): AgentDescriptor {
    return this.detected.get(id) ?? this.unprobed(id);
  }

  /**
   * Re-probes every agent that has an executable implementation and caches the result in memory. An
   * agent without an implementation is reported unavailable without running anything at all, so a
   * missing CLI can never fail startup and no unpaid probe is wasted on an agent we could not launch.
   */
  public async refresh(): Promise<readonly AgentDescriptor[]> {
    for (const id of AGENT_ADAPTER_IDS) {
      this.detected.set(id, await this.probe(id));
    }
    return this.list();
  }

  private async probe(id: AgentAdapterId): Promise<AgentDescriptor> {
    const profile = this.profiles[id];
    if (!this.adapters.has(id)) return this.unprobed(id);
    try {
      const availability = await this.adapters.detect(id);
      return agentDescriptorSchema.parse({
        ...this.baseOf(profile),
        hasImplementation: true,
        available: availability.available,
        version: availability.version,
        unavailability:
          availability.issue === null
            ? null
            : {
                code: availability.issue.code,
                message: availability.issue.message,
                remediation: availability.issue.remediation
              }
      });
    } catch {
      // A probe that throws is an unavailable agent, never a crash and never a startup failure.
      return agentDescriptorSchema.parse({
        ...this.baseOf(profile),
        hasImplementation: true,
        available: false,
        unavailability: {
          code: "adapter_detection_failed",
          message: `${profile.displayName} could not be probed on this machine.`,
          remediation: profile.notImplementedRemediation
        }
      });
    }
  }

  /** A known agent with no executable implementation registered: selectable to read, never runnable. */
  private unprobed(id: AgentAdapterId): AgentDescriptor {
    const profile = this.profiles[id];
    return agentDescriptorSchema.parse({
      ...this.baseOf(profile),
      hasImplementation: false,
      available: false,
      unavailability: {
        code: "adapter_not_implemented",
        message: `${profile.displayName} is not available in this version of Compazio.`,
        remediation: profile.notImplementedRemediation
      }
    });
  }

  private baseOf(profile: AgentDescriptorProfile): Record<string, unknown> {
    return {
      id: profile.id,
      displayName: profile.displayName,
      capabilities: [...profile.capabilities],
      // Authentication is reported only when a safe, unpaid local check can determine it. No adapter
      // can today, so it stays null rather than being guessed from availability.
      authenticated: null,
      version: null,
      supportsPlanning: profile.supportsPlanning,
      supportsExecution: profile.supportsExecution,
      supportsPipe: profile.supportsPipe,
      supportsInteractive: profile.supportsInteractive,
      knownLimitations: [...profile.knownLimitations]
    };
  }
}
