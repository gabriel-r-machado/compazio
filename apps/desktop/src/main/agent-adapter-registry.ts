import type {
  AgentNodeLaunchInput,
  AgentNodeLaunchPlan,
  AgentNodeLaunchResolver
} from "./process-agent-node-executor";

/**
 * Raised by an adapter when it cannot run this node without starting a process — the binary is
 * missing, the workspace is invalid, or the arguments would be unsafe. The registry turns it into a
 * `null` launch plan so the node fails safely (adapter_unavailable) before any process is spawned.
 * It is never used to signal a runtime failure of an already-started process.
 */
export class AgentAdapterUnavailableError extends Error {
  public constructor(
    message: string,
    public readonly adapterId: string
  ) {
    super(message);
    this.name = "AgentAdapterUnavailableError";
  }
}

/** Availability of a process agent adapter, surfaced to the canvas before a run is materialized. */
export interface AgentAdapterAvailability {
  readonly id: string;
  readonly available: boolean;
  readonly version: string | null;
  readonly issue: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
  } | null;
}

/**
 * A production agent adapter, selected exclusively by `node.adapter`. It owns the single safe launch
 * decision for one agent CLI (which executable, which arguments, cwd, environment, stdin, and which
 * files become official artifacts) plus a cheap availability probe. It never controls the scheduler,
 * creates attempts, decides retries, updates cards, touches SQLite, or interprets terminal text as a
 * domain outcome — those belong to the runtime and the ProcessAgentNodeExecutor.
 */
export interface AgentNodeAdapter {
  readonly id: string;
  /** Builds the safe launch plan, or throws {@link AgentAdapterUnavailableError} if it cannot. */
  planLaunch(input: AgentNodeLaunchInput): Promise<AgentNodeLaunchPlan>;
  /** Cheap, unpaid availability probe (never runs a billable task). */
  detect(): Promise<AgentAdapterAvailability>;
}

/**
 * The one official registry of process agent adapters. An adapter is chosen strictly by
 * `node.adapter`; the node's title, prompt text or visual name never participate in the choice. An
 * unknown id resolves to `null`, so the node fails before a process is started. The registry is also
 * an {@link AgentNodeLaunchResolver}, so it drops directly into the existing ProcessAgentNodeExecutor
 * seam without a new runtime, scheduler, queue or persistence.
 */
export class AgentAdapterRegistry implements AgentNodeLaunchResolver {
  private readonly adapters: ReadonlyMap<string, AgentNodeAdapter>;

  public constructor(adapters: readonly AgentNodeAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  public has(id: string): boolean {
    return this.adapters.has(id);
  }

  public list(): readonly AgentNodeAdapter[] {
    return [...this.adapters.values()];
  }

  public get(id: string): AgentNodeAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new AgentAdapterUnavailableError(`Unknown agent adapter: ${id}`, id);
    }
    return adapter;
  }

  public async detect(id: string): Promise<AgentAdapterAvailability> {
    return this.get(id).detect();
  }

  public async detectAll(): Promise<readonly AgentAdapterAvailability[]> {
    return Promise.all(this.list().map((adapter) => adapter.detect()));
  }

  public async resolve(input: AgentNodeLaunchInput): Promise<AgentNodeLaunchPlan | null> {
    const id = input.node.adapter;
    if (id === undefined) return null;
    const adapter = this.adapters.get(id);
    if (adapter === undefined) return null;
    try {
      return await adapter.planLaunch(input);
    } catch (error: unknown) {
      // Unavailability is an expected, safe failure: no process, no attempt side effects.
      if (error instanceof AgentAdapterUnavailableError) return null;
      throw error;
    }
  }
}
