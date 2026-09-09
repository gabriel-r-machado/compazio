import { canAnalyze, canRemediate } from "@forgedeck/orchestration";
import type {
  AgentPlanningDescriptor,
  OrchestratorPlanningPort,
  OrchestratorPort
} from "@forgedeck/orchestration";
import type {
  AgentAdapterId,
  AutomaticOrchestratorOption,
  AutomaticWorkflowRequest
} from "@forgedeck/schemas";

import type { OrchestratorSelection } from "./automatic-mode-service";
import { OrchestratorRegistry } from "./orchestrator-registry";
import { PlanningPortBridge, RemediationUnsupportedError } from "./planning-port-bridge";
import type { PlanningIsolation } from "./planning-snapshot";

/**
 * Wires the planner registry into the automatic session: which agents may WRITE a plan, whether each
 * one can right now, and which one this session will use.
 *
 * Every planner — Claude, Codex, and whatever comes next — is resolved through the SAME
 * {@link OrchestratorRegistry}, by the selected id alone. There is no branch on identity anywhere: what
 * differs between planners is what each one DECLARES it can do, asked structurally.
 *
 * - a planner that already speaks the coordinator's analysis seam is used as-is, so its approved
 *   prompt, transport, parser, validation, diagnostics and snapshot handling are preserved exactly;
 * - a planner that only implements the neutral contract is driven through {@link PlanningPortBridge},
 *   which owns the disposable snapshot around its turn;
 * - a planner that cannot remediate stops the session with a stated reason instead of borrowing another.
 *
 * It touches nothing about execution: the agents a plan may assign to its nodes are passed in and
 * handed to the planner unchanged, so choosing a planner never moves a node's executor.
 */

const DISPLAY_NAMES: Readonly<Record<AgentAdapterId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode"
};

export interface OrchestratorSelectionDeps {
  /** Every planning port this build ships. OpenCode is deliberately absent in this phase. */
  readonly ports: readonly OrchestratorPlanningPort[];
  readonly isolation: PlanningIsolation;
  readonly workspaceRoot: (request: AutomaticWorkflowRequest) => Promise<string> | string;
  readonly projectMetadata: (request: AutomaticWorkflowRequest) => Promise<unknown> | unknown;
  /** The agents a plan may assign to nodes. Independent of who is planning. */
  readonly availableAgents: () => Promise<readonly AgentPlanningDescriptor[]>;
}

/** One planner as the session uses it: a coordinator seam plus what it declares it can do. */
interface ResolvedPlanner {
  readonly port: OrchestratorPort;
  readonly supportsRemediation: boolean;
  readonly planHash: () => string | null;
}

/** A port may explicitly bind itself to a local workspace for a session. */
interface WorkspaceScopedOrchestratorPort {
  forWorkspace(workspaceId: string): OrchestratorPort;
}

export function createOrchestratorSelection(
  deps: OrchestratorSelectionDeps
): OrchestratorSelection {
  const registry = new OrchestratorRegistry(deps.ports);
  const resolved = new Map<string, ResolvedPlanner>();
  const versions = new Map<AgentAdapterId, string | null>();

  /** Built once per planner, from its declared capabilities. No id is ever compared here. */
  const plannerFor = (id: AgentAdapterId, workspaceId?: string): ResolvedPlanner | null => {
    const cacheKey = `${id}:${workspaceId ?? "global"}`;
    const existing = resolved.get(cacheKey);
    if (existing !== undefined) return existing;
    if (!registry.has(id)) return null;
    const registered = registry.get(id);
    const port =
      workspaceId === undefined || !hasWorkspaceScope(registered)
        ? registered
        : registered.forWorkspace(workspaceId);
    const remediates = canRemediate(port);

    if (canAnalyze(port)) {
      // The planner drives its own analysis turn. Nothing about it is re-implemented or re-parsed.
      const entry: ResolvedPlanner = {
        port: {
          analyze: (request) => port.analyze(request),
          remediate: async (context) => {
            if (!canRemediate(port)) throw new RemediationUnsupportedError(port.id);
            return port.remediate(context);
          }
        },
        supportsRemediation: remediates,
        planHash: () => null
      };
      resolved.set(cacheKey, entry);
      return entry;
    }

    // A neutral-only planner is driven through the shared bridge, which owns its snapshot lifecycle.
    const bridge = new PlanningPortBridge({
      port,
      isolation: deps.isolation,
      workspaceRoot: deps.workspaceRoot,
      projectMetadata: deps.projectMetadata,
      availableAgents: deps.availableAgents,
      ...(remediates ? { remediation: port } : {})
    });
    const entry: ResolvedPlanner = {
      port: bridge,
      supportsRemediation: bridge.supportsRemediation,
      planHash: () => bridge.lastPlan?.planHash ?? null
    };
    resolved.set(cacheKey, entry);
    return entry;
  };

  return {
    list: async () => {
      const availabilities = await registry.detectAll();
      return availabilities.map((availability): AutomaticOrchestratorOption => {
        versions.set(availability.id, availability.version);
        const port = registry.has(availability.id) ? registry.get(availability.id) : null;
        return {
          id: availability.id,
          displayName: DISPLAY_NAMES[availability.id],
          // Planning exists when a port exists; remediation is asked of the port itself. Neither is
          // hard-coded per agent, so a new planner reports its own capabilities with no change here.
          supportsPlanning: availability.hasImplementation,
          supportsRemediation: port !== null && canRemediate(port),
          available: availability.available,
          version: availability.version,
          unavailableReason: availability.issue?.message ?? null
        };
      });
    },
    resolve: (id, workspaceId) => {
      const planner = plannerFor(id, workspaceId);
      if (planner === null) return null;
      return {
        port: planner.port,
        supportsRemediation: planner.supportsRemediation,
        version: () => versions.get(id) ?? null,
        planHash: planner.planHash
      };
    }
  };
}

function hasWorkspaceScope(port: object): port is object & WorkspaceScopedOrchestratorPort {
  return typeof (port as { readonly forWorkspace?: unknown }).forWorkspace === "function";
}
