import type { AutomaticWorkflowRequest, AutomaticWorkflowLimits } from "@forgedeck/schemas";
import {
  diagnostic,
  validateOrchestratorPlan,
  type OrchestratorAvailability,
  type OrchestratorPlanRequest,
  type OrchestratorPlanResult,
  type OrchestratorPlanningPort,
  type OrchestratorPort,
  type RemediationContext,
  type StructuredDiagnostic
} from "@forgedeck/orchestration";

import { CLAUDE_CODE_ADAPTER_ID } from "./claude-code-agent-adapter";
import { planContractSection, READ_ONLY_CONTRACT } from "./orchestrator-plan-contract";
import type { PlanningIsolation } from "./planning-snapshot";

/**
 * The real {@link OrchestratorPort}: it asks the user's own installed Claude Code for a STRUCTURED plan
 * (and, on failure, a structured remediation) over the approved pipe transport, and returns raw JSON for
 * the coordinator to validate. It never accepts free text as a plan, never executes the plan, and never
 * decides anything itself.
 *
 * Planning is analysis only, and that is enforced three times over. The prompt forbids every mutating
 * action. The turn runs in a disposable snapshot holding only analysis material, so the real project is not
 * reachable at all — the agent is launched with editing capability, and prevention must not depend on it
 * behaving. Finally the real workspace is fingerprinted before and after, so a mutation that happened
 * anyway discards the plan instead of being silently accepted.
 */

/** Runs one single-shot, non-interactive agent turn and returns its stdout. */
export interface OrchestratorAgentRunner {
  run(input: {
    readonly prompt: string;
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly stdout: string; readonly exitCode: number | null }>;
}

/** The workspace facts the planner is allowed to see. Every field is caller-supplied and sanitized. */
export interface RepositoryContext {
  readonly summary: string;
  readonly availableScripts: readonly string[];
  readonly gitStatus: string;
  /** CLAUDE.md and the docs the product decided are relevant; never the whole repository. */
  readonly documentation: readonly { readonly path: string; readonly content: string }[];
  readonly acceptanceCriteria: readonly string[];
}

/**
 * A stable fingerprint of the workspace's mutable state, taken before and after planning. Any difference
 * proves the planning turn modified the workspace, which planning is not allowed to do.
 */
export interface WorkspaceFingerprinter {
  fingerprint(cwd: string): Promise<string>;
}

export class PlanningMutatedWorkspaceError extends Error {
  public constructor(public readonly detail: string) {
    super(`The planning turn modified the workspace, which analysis must never do: ${detail}`);
    this.name = "PlanningMutatedWorkspaceError";
  }
}

export interface ClaudeOrchestratorPortDeps {
  readonly runner: OrchestratorAgentRunner;
  readonly fingerprinter: WorkspaceFingerprinter;
  /** The REAL workspace. It is fingerprinted, and it is never handed to the planning turn. */
  readonly cwd: string;
  /**
   * Required, not optional: the planning agent is launched with editing capability, so the real project is
   * protected by never being reachable, not merely by detecting damage afterwards. Every analysis runs in a
   * disposable snapshot.
   */
  readonly isolation: PlanningIsolation;
  /** Repository facts for the objective being planned; resolved by the caller, never by the model. */
  readonly context: (request: AutomaticWorkflowRequest) => Promise<RepositoryContext>;
  /** Adapter ids a plan may name in this milestone; defaults to the one registered adapter. */
  readonly allowedAdapters?: readonly string[];
  readonly planningTimeoutMs?: number;
  readonly remediationTimeoutMs?: number;
  /**
   * Reports whether the user's Claude Code CLI is installed and usable. Availability is a fact about
   * the local install, asked for on demand — never inferred, and never persisted as a permanent truth.
   */
  readonly availability?: () => Promise<{
    readonly available: boolean;
    readonly version: string | null;
    readonly message?: string;
  }>;
}

const DEFAULT_PLANNING_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_REMEDIATION_TIMEOUT_MS = 3 * 60 * 1_000;

export class ClaudeOrchestratorPort implements OrchestratorPort, OrchestratorPlanningPort {
  /** Identity for the planner registry. Resolution is by this id alone, never by inference. */
  public readonly id = CLAUDE_CODE_ADAPTER_ID;

  public constructor(private readonly deps: ClaudeOrchestratorPortDeps) {}

  public async detect(): Promise<OrchestratorAvailability> {
    if (this.deps.availability === undefined) {
      return {
        id: this.id,
        hasImplementation: true,
        available: false,
        version: null,
        issue: diagnostic(
          "planner_unavailable",
          "Claude Code availability was not resolved for this composition."
        )
      };
    }
    const probe = await this.deps.availability();
    return {
      id: this.id,
      hasImplementation: true,
      available: probe.available,
      version: probe.version,
      issue: probe.available
        ? null
        : diagnostic("planner_unavailable", probe.message ?? "Claude Code is not available.")
    };
  }

  /**
   * The neutral planning entry point. It asks the same questions {@link analyze} asks, in the same
   * schema-derived contract, and validates through the SAME shared validator Codex uses — so the two
   * planners answer to one schema and report a failure in one vocabulary. Unlike the legacy
   * {@link analyze} path, the answer here is parsed strictly: a fenced or decorated answer is reported,
   * never unwrapped, and no partial plan is ever returned.
   */
  public async createPlan(
    request: OrchestratorPlanRequest,
    signal?: AbortSignal
  ): Promise<OrchestratorPlanResult> {
    if (request.planningSnapshotPath.trim().length === 0) {
      return this.planFailed([
        diagnostic("snapshot_unavailable", "No planning snapshot was provided for the analysis.")
      ]);
    }
    if (isAborted(signal)) {
      return this.planFailed([diagnostic("cancelled", "The planning turn was cancelled.")]);
    }
    const before = await this.deps.fingerprinter.fingerprint(this.deps.cwd);
    let stdout: string;
    try {
      const result = await this.deps.runner.run({
        prompt: this.neutralPlanPrompt(request),
        cwd: request.planningSnapshotPath,
        timeoutMs: this.deps.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS
      });
      if (result.exitCode !== 0) {
        return this.planFailed([
          diagnostic(
            "process_failed",
            `The planning process exited with ${result.exitCode === null ? "an unknown code" : String(result.exitCode)}.`
          )
        ]);
      }
      stdout = result.stdout;
    } catch (error: unknown) {
      return this.planFailed([
        diagnostic(
          "process_failed",
          error instanceof Error ? error.message : "The planning turn failed."
        )
      ]);
    }
    // Defence in depth, unchanged from the approved behaviour: a mutation discards the plan.
    const after = await this.deps.fingerprinter.fingerprint(this.deps.cwd);
    if (before !== after) {
      return this.planFailed([
        diagnostic(
          "workspace_mutated",
          "The planning turn modified the workspace, which analysis must never do."
        )
      ]);
    }
    if (isAborted(signal)) {
      return this.planFailed([diagnostic("cancelled", "The planning turn was cancelled.")]);
    }
    return this.validateAnswer(stdout, request);
  }

  private validateAnswer(answer: string, request: OrchestratorPlanRequest): OrchestratorPlanResult {
    if (answer.trim().length === 0) {
      return this.planFailed([diagnostic("result_empty", "The planner's answer was empty.")]);
    }
    if (answer.includes("```")) {
      return this.planFailed([
        diagnostic(
          "result_wrapped_in_markdown",
          "The planner wrapped its answer in a markdown fence; the contract requires bare JSON.",
          { structuralShape: `string(${String(answer.length)})` }
        )
      ]);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(answer.trim());
    } catch {
      return this.planFailed([
        diagnostic("result_not_json", "The planner's answer was not valid JSON.", {
          structuralShape: `string(${String(answer.length)})`
        })
      ]);
    }
    const usable = request.availableAgents.filter((agent) => agent.available).map((a) => a.id);
    const validation = validateOrchestratorPlan(raw, {
      allowedAdapters: usable.length === 0 ? request.availableAgents.map((a) => a.id) : usable,
      maxNodes: request.strategy.limits.maxWorkflowNodes,
      workspaceId: "planning",
      objective: request.objective,
      executionProfile: request.strategy.executionProfile,
      sourceTerminalId: "orchestrator:claude-code"
    });
    if (!validation.ok) return this.planFailed(validation.diagnostics);
    return { plan: validation.plan, adapterId: this.id, diagnostics: [] };
  }

  private planFailed(diagnostics: readonly StructuredDiagnostic[]): OrchestratorPlanResult {
    return { plan: null, adapterId: this.id, diagnostics };
  }

  /** The neutral request rendered with the shared, schema-derived contract Codex also receives. */
  private neutralPlanPrompt(request: OrchestratorPlanRequest): string {
    const usable = request.availableAgents.filter((agent) => agent.available).map((a) => a.id);
    return [
      "You are the planning step of an automatic workflow. Answer with ONE JSON object and nothing else.",
      "",
      "## Read-only contract",
      ...READ_ONLY_CONTRACT.map((rule) => `- ${rule}`),
      "",
      "## Objective",
      request.objective,
      "",
      "## Budget (fixed by the product; you cannot widen it)",
      ...limitLines(request.limits),
      "",
      "## Project",
      typeof request.projectMetadata === "string"
        ? request.projectMetadata
        : JSON.stringify(request.projectMetadata ?? null, null, 2).slice(0, 8_000),
      "",
      "## Agents available to EXECUTE nodes (you are the planner, not an executor)",
      ...request.availableAgents.map(
        (agent) =>
          `- ${agent.id} (${agent.displayName})${agent.capabilities.length === 0 ? "" : `: ${agent.capabilities.join(", ")}`}`
      ),
      "",
      ...planContractSection(
        usable.length === 0 ? request.availableAgents.map((a) => a.id) : usable
      )
    ].join("\n");
  }

  /**
   * Read-only analysis and planning. Returns the raw parsed JSON; the coordinator validates it against the
   * plan schema, so an answer that is prose, truncated or structurally wrong is rejected there.
   */
  public async analyze(request: AutomaticWorkflowRequest): Promise<unknown> {
    const context = await this.deps.context(request);
    const before = await this.deps.fingerprinter.fingerprint(this.deps.cwd);
    // Prevention: analysis happens in a disposable copy holding only what it needs, so an agent that tries
    // to edit can only reach the copy. The real workspace is never the cwd and never an allowed root.
    const snapshot = await this.deps.isolation.create(this.deps.cwd);
    try {
      const result = await this.deps.runner.run({
        prompt: this.planPrompt(request, context),
        cwd: snapshot.path,
        timeoutMs: this.deps.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS
      });
      // Detection, kept as defence in depth: if the real workspace changed anyway, the plan is discarded
      // rather than trusted, because an analysis that edited the project has already broken its contract.
      const after = await this.deps.fingerprinter.fingerprint(this.deps.cwd);
      if (before !== after) {
        throw new PlanningMutatedWorkspaceError(
          "the tracked workspace state differs between the start and the end of the analysis"
        );
      }
      return parseStructuredAnswer(result.stdout, "plan");
    } finally {
      // The snapshot never survives the turn, on success or on failure.
      await snapshot.dispose();
    }
  }

  /**
   * Asks for a structured remediation from the FAILURE ALONE. The model receives the objective, the failed
   * node, the unmet criteria, the sanitized error, the attempts and what is left of the budget — never the
   * raw transcript, the full history or any artifact content.
   */
  public async remediate(context: RemediationContext): Promise<unknown> {
    const result = await this.deps.runner.run({
      prompt: this.remediationPrompt(context),
      cwd: this.deps.cwd,
      timeoutMs: this.deps.remediationTimeoutMs ?? DEFAULT_REMEDIATION_TIMEOUT_MS
    });
    return parseStructuredAnswer(result.stdout, "remediation");
  }

  private planPrompt(request: AutomaticWorkflowRequest, context: RepositoryContext): string {
    return [
      "You are the planning step of an automatic workflow. Answer with ONE JSON object and nothing else.",
      "",
      "## Read-only contract",
      ...READ_ONLY_CONTRACT.map((rule) => `- ${rule}`),
      "",
      "## Objective",
      request.objective,
      "",
      "## Budget (fixed by the product; you cannot widen it)",
      ...limitLines(request.limits),
      "",
      "## Repository",
      context.summary,
      "",
      "### Available scripts",
      ...context.availableScripts.map((script) => `- ${script}`),
      "",
      "### Git status",
      context.gitStatus,
      "",
      ...context.documentation.flatMap((document) => [
        `### ${document.path}`,
        document.content,
        ""
      ]),
      ...(context.acceptanceCriteria.length === 0
        ? []
        : [
            "### Acceptance criteria required by the user",
            ...context.acceptanceCriteria.map((criterion) => `- ${criterion}`),
            ""
          ]),
      ...this.contractSection()
    ].join("\n");
  }

  /**
   * The response contract, rendered from the schema's own constants and a schema-validated example, and
   * now shared verbatim with every other planner. It is never a hand-maintained list, so it cannot
   * drift from what the validator will accept — nor from what another planner is told.
   */
  private contractSection(): readonly string[] {
    return planContractSection(this.deps.allowedAdapters ?? [CLAUDE_CODE_ADAPTER_ID]);
  }

  private remediationPrompt(context: RemediationContext): string {
    return [
      "A workflow node failed its verification. Answer with ONE JSON object and nothing else.",
      "",
      "## Original objective",
      context.objective,
      "",
      "## Failed node",
      context.targetNodeId,
      "",
      "## Unmet acceptance criteria",
      ...context.failedCriteria.map((criterion) => `- ${criterion}`),
      "",
      "## Sanitized error",
      context.sanitizedError.length === 0
        ? "(no error detail was captured)"
        : context.sanitizedError,
      "",
      "## Areas this node may touch",
      ...context.allowedAreas.map((area) => `- ${area}`),
      "",
      `## Attempts already made on this node: ${context.priorAttempts}`,
      "",
      "## Required answer shape",
      "{",
      '  "action": "retry_node" | "add_corrective_node",',
      `  "targetNodeId": "${context.targetNodeId}",`,
      '  "reason": string,',
      '  "updatedPrompt": string,',
      '  "correctiveNode": { same shape as a plan node }  // only for add_corrective_node',
      "}",
      "",
      `The remediation must address ${context.targetNodeId} and no other node.`,
      "Never undo work that already passed verification; fix forward.",
      "`updatedPrompt` replaces the failed node's prompt and must stand alone."
    ].join("\n");
  }
}

/**
 * Extracts the single JSON object from an agent answer. Agents commonly wrap JSON in prose or a fenced
 * block, so the outermost object is taken; anything that is not parseable JSON is a hard failure, never a
 * best-effort guess, because a plan must never be inferred from prose.
 */
function parseStructuredAnswer(stdout: string, label: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(stdout);
  const candidate = (fenced?.[1] ?? stdout).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`The orchestrator did not return a JSON ${label}.`);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error: unknown) {
    throw new Error(`The orchestrator ${label} was not valid JSON.`, { cause: error });
  }
}

/** Read through a function so the signal is re-checked after every await, not narrowed once. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function limitLines(limits: AutomaticWorkflowLimits): readonly string[] {
  return [
    `- At most ${limits.maxWorkflowNodes} nodes.`,
    `- At most ${limits.maxRemediationCycles} automatic remediation cycles for the whole run.`,
    `- At most ${limits.maxAttemptsPerNode} attempts per node.`,
    `- The whole run must fit in ${Math.round(limits.timeoutMs / 60_000)} minutes.`
  ];
}
