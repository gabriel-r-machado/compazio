import {
  AGENT_ADAPTER_IDS,
  orchestratorPlanSchema,
  orchestratorPlanToDraft,
  type AutomaticWorkflowLimits,
  type AutomaticWorkflowRequest,
  type OrchestratorPlan
} from "@forgedeck/schemas";

import type { AutomaticModeStrategy } from "./automatic-mode-strategy";
import type { RemediationContext } from "./automatic-workflow-coordinator";
import { materializeWorkflowDraft } from "./workflow-materializer";

/**
 * The agent-neutral planning contract.
 *
 * Planning and execution are different jobs done by different agents: `orchestratorAdapter` names who
 * WRITES the plan, `assignedAdapter` names who EXECUTES a node. A planner produces one neutral
 * {@link OrchestratorPlan} and stops there — it never runs a node, calls another agent, starts a run,
 * touches the scheduler, creates an attempt, publishes execution artifacts, or silently decides the
 * user's final per-node adapters.
 *
 * Every planner validates through {@link validateOrchestratorPlan}, so Claude and Codex answer to the
 * same official schema, the same structural rules and the same diagnostic vocabulary. There is no
 * per-provider schema, no per-provider converter and no permissive fallback.
 */

/**
 * Every agent Compazio knows as a possible planner. Derived from the schema's own agent list rather
 * than restated, so planner ids and agent ids can never drift apart. Membership is not availability,
 * and it says nothing about whether the agent can execute anything.
 */
export const ORCHESTRATOR_ADAPTER_IDS = AGENT_ADAPTER_IDS;
export type OrchestratorAdapterId = (typeof ORCHESTRATOR_ADAPTER_IDS)[number];

export function isOrchestratorAdapterId(value: string): value is OrchestratorAdapterId {
  return (ORCHESTRATOR_ADAPTER_IDS as readonly string[]).includes(value);
}

/**
 * The vocabulary every planner reports failures in. Two different CLIs failing the same way must be
 * indistinguishable to the caller, so a diagnostic never carries a provider-specific code.
 */
export type OrchestratorDiagnosticCode =
  | "planner_unavailable"
  | "planner_not_implemented"
  | "snapshot_unavailable"
  | "result_missing"
  | "result_empty"
  | "result_not_json"
  | "result_wrapped_in_markdown"
  | "schema_invalid"
  | "invalid_adapter"
  | "invalid_role"
  | "invalid_dependency"
  | "dependency_cycle"
  | "limit_exceeded"
  | "not_materializable"
  | "workspace_mutated"
  | "process_failed"
  | "timeout"
  | "cancelled";

/**
 * A structured, already-sanitized planning failure. It carries WHERE and WHAT SHAPE, never the value:
 * no prompt, no file content, no credential, no raw transcript.
 */
export interface StructuredDiagnostic {
  readonly code: OrchestratorDiagnosticCode;
  /** Dotted path inside the plan when the failure is structural (e.g. `nodes.2.role`), else null. */
  readonly path: string | null;
  readonly message: string;
  /** Redacted shape of the offending value, e.g. `string(12)` or `object{3 keys}`; never its content. */
  readonly structuralShape: string | null;
}

export function diagnostic(
  code: OrchestratorDiagnosticCode,
  message: string,
  options: { readonly path?: string | null; readonly structuralShape?: string | null } = {}
): StructuredDiagnostic {
  return {
    code,
    path: options.path ?? null,
    message,
    structuralShape: options.structuralShape ?? null
  };
}

/** Describes a value by shape alone, so a diagnostic can be specific without leaking anything. */
export function structuralShapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  switch (typeof value) {
    case "string":
      return `string(${String(value.length)})`;
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "object":
      return `object{${String(Object.keys(value as Record<string, unknown>).length)} keys}`;
    default:
      return typeof value;
  }
}

/** What a planner is allowed to know about one selectable executor when it writes the plan. */
export interface AgentPlanningDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  /** Whether this agent can currently EXECUTE a node. A planner may only name usable executors. */
  readonly available: boolean;
}

/** Everything a planner receives. It never resolves the workspace, the snapshot or the limits itself. */
export interface OrchestratorPlanRequest {
  readonly objective: string;
  /**
   * The disposable analysis copy the planning turn runs in. The real workspace is never the cwd and
   * never an allowed root; anything the planner writes lands here and dies with the snapshot.
   */
  readonly planningSnapshotPath: string;
  /** Sanitized, caller-resolved repository facts. Never assembled by the planner. */
  readonly projectMetadata: unknown;
  readonly limits: AutomaticWorkflowLimits;
  readonly availableAgents: readonly AgentPlanningDescriptor[];
  readonly strategy: AutomaticModeStrategy;
  readonly acceptanceCriteria?: readonly string[];
}

export interface OrchestratorPlanResult {
  /** The validated plan. Absent when planning failed; a partial plan is never returned. */
  readonly plan: OrchestratorPlan | null;
  readonly adapterId: OrchestratorAdapterId;
  /** The planner CLI's own reported version, when it reported one. Never a credential. */
  readonly adapterVersion?: string | null;
  readonly diagnostics: readonly StructuredDiagnostic[];
}

export interface OrchestratorAvailability {
  readonly id: OrchestratorAdapterId;
  /** False when this build has no planning port for the id at all (e.g. OpenCode in this phase). */
  readonly hasImplementation: boolean;
  readonly available: boolean;
  readonly version: string | null;
  readonly issue: StructuredDiagnostic | null;
}

/**
 * One agent's planning capability. Detection never starts a planning turn, never reads a credential
 * and never widens what the port may do.
 *
 * Named `...PlanningPort` because {@link OrchestratorPort} is already the coordinator's own
 * analyze/remediate seam: this is the neutral, identified, detectable planner contract, and a real
 * port (ClaudeOrchestratorPort) implements both without either changing the other's semantics.
 */
export interface OrchestratorPlanningPort {
  readonly id: OrchestratorAdapterId;
  detect(): Promise<OrchestratorAvailability>;
  createPlan(
    request: OrchestratorPlanRequest,
    signal?: AbortSignal
  ): Promise<OrchestratorPlanResult>;
}

/**
 * Optional capabilities a planning port MAY also implement. They are declared by the port and detected
 * structurally — never by comparing ids. A caller therefore has one code path for every planner: it
 * asks what the port can do, not who it is, so adding or removing a planner changes no dispatch logic.
 */

/**
 * A planner that already speaks the coordinator's own analysis seam. It is used as-is, which is how an
 * established planner keeps its exact prompt, transport, parser, validation and snapshot handling
 * instead of being re-routed through a generic path.
 */
export interface OrchestratorAnalysisCapable {
  analyze(request: AutomaticWorkflowRequest): Promise<unknown>;
}

/** A planner that can also produce a structured remediation for a node that failed verification. */
export interface OrchestratorRemediationCapable {
  remediate(context: RemediationContext): Promise<unknown>;
}

export function canAnalyze<T extends object>(port: T): port is T & OrchestratorAnalysisCapable {
  return typeof (port as { analyze?: unknown }).analyze === "function";
}

export function canRemediate<T extends object>(
  port: T
): port is T & OrchestratorRemediationCapable {
  return typeof (port as { remediate?: unknown }).remediate === "function";
}

/** The result of validating raw planner output. Either a usable plan, or diagnostics — never both. */
export type OrchestratorPlanValidation =
  | { readonly ok: true; readonly plan: OrchestratorPlan }
  | { readonly ok: false; readonly diagnostics: readonly StructuredDiagnostic[] };

export interface ValidateOrchestratorPlanOptions {
  /** Adapter ids the plan may name for its nodes. An unknown adapter is a rejection, never a warning. */
  readonly allowedAdapters: readonly string[];
  readonly maxNodes: number;
  /** Proves the plan can become an official run; a plan that cannot is rejected before anything starts. */
  readonly workspaceId: string;
  readonly objective: string;
  readonly executionProfile: Parameters<typeof orchestratorPlanToDraft>[1]["executionProfile"];
  readonly sourceTerminalId: string;
}

/**
 * The single validation path for EVERY planner. Order matters: schema first (which already rejects
 * duplicate ids, self-dependencies and missing dependencies), then the product limits, then the
 * conversion to the official draft, then materializability — which is what actually catches a cycle.
 */
export function validateOrchestratorPlan(
  raw: unknown,
  options: ValidateOrchestratorPlanOptions
): OrchestratorPlanValidation {
  const parsed = orchestratorPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) =>
        diagnostic(schemaIssueCode(issue.message, issue.path), issue.message, {
          path: issue.path.length === 0 ? null : issue.path.join("."),
          structuralShape: structuralShapeOf(valueAt(raw, issue.path))
        })
      )
    };
  }
  const plan = parsed.data;

  const unknownAdapters = plan.nodes.filter(
    (node) => !options.allowedAdapters.includes(node.adapter)
  );
  if (unknownAdapters.length > 0) {
    return {
      ok: false,
      diagnostics: unknownAdapters.map((node) =>
        diagnostic(
          "invalid_adapter",
          `Plan node ${node.id} names an adapter that is not selectable here.`,
          { path: `nodes.${node.id}.adapter`, structuralShape: structuralShapeOf(node.adapter) }
        )
      )
    };
  }

  if (plan.nodes.length > options.maxNodes) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "limit_exceeded",
          `The plan has ${String(plan.nodes.length)} nodes, over the ${String(options.maxNodes)}-node budget.`,
          { path: "nodes", structuralShape: `array(${String(plan.nodes.length)})` }
        )
      ]
    };
  }

  let draft;
  try {
    draft = orchestratorPlanToDraft(plan, {
      workspaceId: options.workspaceId,
      objective: options.objective,
      executionProfile: options.executionProfile,
      sourceTerminalId: options.sourceTerminalId
    });
  } catch (error: unknown) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "not_materializable",
          error instanceof Error ? error.message : "The plan could not become a draft.",
          { path: "nodes" }
        )
      ]
    };
  }

  const materialization = materializeWorkflowDraft(draft);
  if (materialization.issues.length > 0) {
    return {
      ok: false,
      diagnostics: materialization.issues.map((issue) =>
        diagnostic(
          /cycle/i.test(issue.message) ? "dependency_cycle" : "not_materializable",
          issue.message,
          { path: issue.nodeId === null ? "nodes" : `nodes.${issue.nodeId}` }
        )
      )
    };
  }
  return { ok: true, plan };
}

/**
 * Maps a schema issue onto the shared vocabulary, so Claude and Codex report a failure identically.
 * The field is read from the issue PATH, never from the message text: a validator's wording is not a
 * contract, and matching on it would silently reclassify failures the day the wording changes.
 */
function schemaIssueCode(
  message: string,
  path: readonly PropertyKey[]
): OrchestratorDiagnosticCode {
  const field = String(path.at(-1) ?? "");
  if (field === "role") return "invalid_role";
  if (field === "adapter") return "invalid_adapter";
  if (/depends on missing node|cannot depend on itself/i.test(message)) return "invalid_dependency";
  return "schema_invalid";
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
