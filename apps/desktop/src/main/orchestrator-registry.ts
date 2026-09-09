import {
  ORCHESTRATOR_ADAPTER_IDS,
  diagnostic,
  isOrchestratorAdapterId,
  type OrchestratorAdapterId,
  type OrchestratorAvailability,
  type OrchestratorPlanningPort
} from "@forgedeck/orchestration";

/**
 * The registry of PLANNERS — who may write a plan — kept deliberately separate from
 * AgentAdapterRegistry (who executes a node) and AgentDescriptorRegistry (what the canvas may offer).
 * Mixing them is what would let an available executor silently become a planner, or a planning choice
 * silently change an executor.
 *
 * Resolution is strictly by the persisted `orchestratorAdapter` id. Nothing is ever inferred from a
 * model name, a plan title, the node adapters, or which executors happen to be installed. An id this
 * build knows but has no port for (OpenCode in this phase) is reported honestly as not implemented
 * rather than silently substituted, and an id outside the known set is refused outright.
 *
 * Detection reports availability. It never starts a planning turn, never reads a credential and never
 * stores one.
 */
export class UnknownOrchestratorError extends Error {
  public constructor(public readonly requested: string) {
    super(`No orchestrator is registered for "${requested}".`);
    this.name = "UnknownOrchestratorError";
  }
}

export class OrchestratorRegistry {
  private readonly ports: ReadonlyMap<OrchestratorAdapterId, OrchestratorPlanningPort>;

  public constructor(ports: readonly OrchestratorPlanningPort[]) {
    const byId = new Map<OrchestratorAdapterId, OrchestratorPlanningPort>();
    for (const port of ports) {
      if (byId.has(port.id)) {
        throw new Error(`Duplicate orchestrator registration for "${port.id}".`);
      }
      byId.set(port.id, port);
    }
    this.ports = byId;
  }

  /** Every planner id this build knows, implemented or not. Membership is not availability. */
  public knownIds(): readonly OrchestratorAdapterId[] {
    return ORCHESTRATOR_ADAPTER_IDS;
  }

  /** True only when a real planning port is registered for the id. */
  public has(id: string): id is OrchestratorAdapterId {
    return isOrchestratorAdapterId(id) && this.ports.has(id);
  }

  public get(id: string): OrchestratorPlanningPort {
    if (!isOrchestratorAdapterId(id)) throw new UnknownOrchestratorError(id);
    const port = this.ports.get(id);
    if (port === undefined) throw new UnknownOrchestratorError(id);
    return port;
  }

  /**
   * Availability for one planner. A known id with no port answers `hasImplementation: false` with a
   * stated reason — never a substitution, and never a silent fallback to another planner.
   */
  public async detect(id: string): Promise<OrchestratorAvailability> {
    if (!isOrchestratorAdapterId(id)) throw new UnknownOrchestratorError(id);
    const port = this.ports.get(id);
    if (port === undefined) return notImplemented(id);
    return port.detect();
  }

  /** Availability for every known planner, in the canonical order, for the selector to render. */
  public async detectAll(): Promise<readonly OrchestratorAvailability[]> {
    return Promise.all(ORCHESTRATOR_ADAPTER_IDS.map((id) => this.detect(id)));
  }
}

function notImplemented(id: OrchestratorAdapterId): OrchestratorAvailability {
  return {
    id,
    hasImplementation: false,
    available: false,
    version: null,
    issue: diagnostic(
      "planner_not_implemented",
      `${id} is a known agent, but planning with it is not implemented in this version.`
    )
  };
}
