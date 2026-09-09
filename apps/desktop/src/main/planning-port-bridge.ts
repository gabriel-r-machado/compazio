import { createHash } from "node:crypto";

import type {
  AgentPlanningDescriptor,
  OrchestratorPlanRequest,
  OrchestratorPlanningPort,
  OrchestratorPort,
  RemediationContext,
  StructuredDiagnostic
} from "@forgedeck/orchestration";
import { resolveAutomaticModeStrategy } from "@forgedeck/orchestration";
import type { AutomaticWorkflowRequest, OrchestratorPlan } from "@forgedeck/schemas";

import type { PlanningIsolation } from "./planning-snapshot";

/**
 * Lets a neutral {@link OrchestratorPlanningPort} drive the existing coordinator, which asks for
 * `analyze`/`remediate`. The bridge owns the disposable snapshot lifecycle around the turn: it creates
 * the analysis copy, hands the port only that path, and disposes it in `finally` on every outcome.
 *
 * Remediation is deliberately NOT bridged. A planner that cannot remediate says so, and the session
 * stops with a stated reason — Compazio never quietly hands one agent's failed node to a different
 * agent, because that is a fallback the user did not choose and cannot see.
 */

export class PlanningFailedError extends Error {
  public constructor(
    public readonly adapterId: string,
    public readonly diagnostics: readonly StructuredDiagnostic[]
  ) {
    super(
      diagnostics.length === 0
        ? "The planner produced no plan."
        : diagnostics.map((entry) => entry.message).join("; ")
    );
    this.name = "PlanningFailedError";
  }
}

export class RemediationUnsupportedError extends Error {
  public constructor(public readonly adapterId: string) {
    super(
      `${adapterId} wrote this plan but cannot remediate a failed node. The session stops here for a human decision; Compazio never hands the fix to a different agent on its own.`
    );
    this.name = "RemediationUnsupportedError";
  }
}

export interface PlanningPortBridgeDeps {
  readonly port: OrchestratorPlanningPort;
  /** Builds the disposable analysis copy. The real workspace is never handed to the planning turn. */
  readonly isolation: PlanningIsolation;
  /**
   * The REAL workspace root for this request; used only to build the snapshot from, never as the
   * planning cwd. Keeping the request here matters when more than one local project is open: a
   * planner must never accidentally receive the desktop application's own source tree.
   */
  readonly workspaceRoot: (request: AutomaticWorkflowRequest) => Promise<string> | string;
  /** Sanitized project facts, resolved by the caller. */
  readonly projectMetadata: (request: AutomaticWorkflowRequest) => Promise<unknown> | unknown;
  /** Which agents may be named as node executors. Choosing a planner never changes this list. */
  readonly availableAgents: () => Promise<readonly AgentPlanningDescriptor[]>;
  /** Remediation support of THIS planner. False stops the session instead of switching agents. */
  readonly supportsRemediation?: boolean;
  /** The legacy port to delegate remediation to, when this planner supports it. */
  readonly remediation?: Pick<OrchestratorPort, "remediate">;
}

export class PlanningPortBridge implements OrchestratorPort {
  public constructor(private readonly deps: PlanningPortBridgeDeps) {}

  public get adapterId(): string {
    return this.deps.port.id;
  }

  public get supportsRemediation(): boolean {
    return this.deps.supportsRemediation ?? this.deps.remediation !== undefined;
  }

  /** The last plan this bridge produced, with its hash — provenance the session persists. */
  public lastPlan: { readonly plan: OrchestratorPlan; readonly planHash: string } | null = null;

  public async analyze(request: AutomaticWorkflowRequest): Promise<unknown> {
    const snapshot = await this.deps.isolation.create(await this.deps.workspaceRoot(request));
    try {
      const result = await this.deps.port.createPlan({
        objective: request.objective,
        planningSnapshotPath: snapshot.path,
        projectMetadata: await this.deps.projectMetadata(request),
        limits: request.limits,
        availableAgents: await this.deps.availableAgents(),
        strategy: resolveAutomaticModeStrategy(request.mode, request.limits)
      } satisfies OrchestratorPlanRequest);
      if (result.plan === null) {
        // A failed planning turn is a stated failure, never a partial plan the coordinator could use.
        throw new PlanningFailedError(result.adapterId, result.diagnostics);
      }
      this.lastPlan = { plan: result.plan, planHash: hashPlan(result.plan) };
      return result.plan;
    } finally {
      // The snapshot never survives the turn, on success or on failure.
      await snapshot.dispose();
    }
  }

  public async remediate(context: RemediationContext): Promise<unknown> {
    if (this.deps.remediation === undefined) {
      throw new RemediationUnsupportedError(this.deps.port.id);
    }
    return this.deps.remediation.remediate(context);
  }
}

/** A stable hash of the plan, so a stored session can prove it is showing the plan that was approved. */
export function hashPlan(plan: OrchestratorPlan): string {
  return createHash("sha256").update(canonicalize(plan)).digest("hex");
}

/**
 * A stable hash of the REVISION that will be materialized. It moves when the user changes which agent
 * executes a node; the plan hash does not, because what was planned did not change.
 */
export function hashDraft(draft: unknown): string {
  return createHash("sha256").update(canonicalize(draft)).digest("hex");
}

/** Key-ordered JSON, so an equivalent plan always hashes the same regardless of property order. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
