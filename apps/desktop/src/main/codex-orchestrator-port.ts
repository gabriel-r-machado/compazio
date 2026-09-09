import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunner, DetectedExecutable, RuntimePlatform } from "@forgedeck/agent-sdk";
import {
  diagnostic,
  structuralShapeOf,
  validateOrchestratorPlan,
  type OrchestratorAvailability,
  type OrchestratorPlanRequest,
  type OrchestratorPlanResult,
  type OrchestratorPlanningPort,
  type StructuredDiagnostic
} from "@forgedeck/orchestration";

import { redactSensitive } from "./claude-code-agent-adapter";
import { CODEX_ADAPTER_ID } from "./codex-agent-adapter";
import {
  CodexExecutableError,
  resolveCodexExecutable,
  type CodexExecutableDeps
} from "./codex-executable";
import { planContractSection, READ_ONLY_CONTRACT } from "./orchestrator-plan-contract";

/**
 * Codex as a PLANNER. It writes one neutral {@link OrchestratorPlan} and stops: it never executes a
 * node, calls another agent, starts a run, reaches the scheduler, creates an attempt or publishes an
 * execution artifact. Which agent ends up running each node stays the user's choice.
 *
 * It reuses the safe primitives — the same vendored-binary resolution and the same pipe transport — but
 * never the execution adapter itself, because planning has a different sandbox and a different job. The
 * turn runs with `codex exec --sandbox read-only`, its cwd is the disposable planning snapshot, and the
 * real workspace is never the cwd and never an allowed root. The prompt travels on stdin and never
 * touches argv.
 *
 * The plan is read from Codex's own `--output-last-message` file, never scraped from stdout: terminal
 * text is not a plan. Missing, empty, fenced, unparseable or schema-invalid output is a structured
 * planning failure, and no partial plan is ever returned.
 */

const DEFAULT_PLANNING_TIMEOUT_MS = 5 * 60 * 1_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** Bounds the answer we are willing to read back, so a runaway file cannot be loaded whole. */
const MAX_RESULT_BYTES = 512 * 1024;
/** The managed directory, inside the disposable snapshot, that holds the planning answer. */
const RESULT_DIRECTORY = ".compazio" as const;
const RESULT_FILENAME = "plan.json" as const;

/** One single-shot planning process. The composition backs this with the live ProcessSupervisor. */
export interface PlanningProcessRunner {
  run(input: {
    readonly executable: DetectedExecutable;
    readonly args: readonly string[];
    readonly cwd: string;
    /** The whole prompt, delivered on stdin and closed; never placed on the command line. */
    readonly stdin: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<PlanningProcessOutcome>;
}

export interface PlanningProcessOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Sanitized tail of stderr for diagnostics only; never treated as a plan. */
  readonly sanitizedError?: string;
}

export interface CodexOrchestratorPortDeps {
  readonly runner: PlanningProcessRunner;
  readonly commandRunner: CommandRunner;
  readonly detector: CodexExecutableDeps["detector"];
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executablePath?: string;
  readonly architecture?: string;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly planningTimeoutMs?: number;
}

export class CodexOrchestratorPort implements OrchestratorPlanningPort {
  public readonly id = CODEX_ADAPTER_ID;
  private readonly secretValues: readonly string[];

  public constructor(private readonly deps: CodexOrchestratorPortDeps) {
    this.secretValues = collectSecretValues(deps.environment);
  }

  public async detect(): Promise<OrchestratorAvailability> {
    let executable: DetectedExecutable;
    try {
      executable = await this.resolveExecutable();
    } catch (error: unknown) {
      return {
        id: this.id,
        hasImplementation: true,
        available: false,
        version: null,
        issue: diagnostic(
          "planner_unavailable",
          this.sanitize(
            error instanceof CodexExecutableError
              ? error.message
              : "Codex could not be resolved for planning."
          )
        )
      };
    }
    const probe = await this.deps.commandRunner.run({
      executable,
      args: ["--version"],
      cwd: process.cwd(),
      environment: this.probeEnvironment(),
      timeoutMs: VERSION_PROBE_TIMEOUT_MS
    });
    const version = firstLine(probe.stdout) ?? firstLine(probe.stderr);
    if (probe.exitCode !== 0 || version === null) {
      return {
        id: this.id,
        hasImplementation: true,
        available: false,
        version: null,
        issue: diagnostic(
          "planner_unavailable",
          this.sanitize("Codex was found but could not report its version.")
        )
      };
    }
    // Authentication is deliberately not probed: no local check is both safe and unpaid, and reading
    // Codex's credential files is exactly what this port must never do.
    return {
      id: this.id,
      hasImplementation: true,
      available: true,
      version: this.sanitize(version),
      issue: null
    };
  }

  public async createPlan(
    request: OrchestratorPlanRequest,
    signal?: AbortSignal
  ): Promise<OrchestratorPlanResult> {
    if (request.planningSnapshotPath.trim().length === 0) {
      return this.failed([
        diagnostic("snapshot_unavailable", "No planning snapshot was provided for the analysis.")
      ]);
    }
    let executable: DetectedExecutable;
    try {
      executable = await this.resolveExecutable();
    } catch (error: unknown) {
      return this.failed([
        diagnostic(
          "planner_unavailable",
          this.sanitize(
            error instanceof CodexExecutableError
              ? error.message
              : "Codex could not be resolved for planning."
          )
        )
      ]);
    }

    const resultDirectory = join(request.planningSnapshotPath, RESULT_DIRECTORY);
    const resultPath = join(resultDirectory, RESULT_FILENAME);
    try {
      await mkdir(resultDirectory, { recursive: true });
    } catch {
      return this.failed([
        diagnostic("snapshot_unavailable", "The planning snapshot could not hold a result file.")
      ]);
    }

    try {
      const outcome = await this.deps.runner.run({
        executable,
        // No positional prompt: the instruction arrives on stdin. `--sandbox read-only` is the whole
        // point of a planning turn, and the dangerous bypass modes are unreachable from here.
        args: [
          "exec",
          "--skip-git-repo-check",
          "--color",
          "never",
          "--sandbox",
          "read-only",
          "--cd",
          request.planningSnapshotPath,
          "--output-last-message",
          resultPath
        ],
        cwd: request.planningSnapshotPath,
        stdin: this.buildPrompt(request),
        timeoutMs: this.resolveTimeoutMs(),
        signal
      });
      if (outcome.cancelled) {
        return this.failed([diagnostic("cancelled", "The planning turn was cancelled.")]);
      }
      if (outcome.timedOut) {
        return this.failed([
          diagnostic("timeout", "The planning turn reached its timeout before answering.")
        ]);
      }
      if (outcome.exitCode !== 0) {
        return this.failed([
          diagnostic(
            "process_failed",
            this.sanitize(
              `The planning process exited with ${outcome.exitCode === null ? "an unknown code" : String(outcome.exitCode)}.`
            ),
            { structuralShape: outcome.sanitizedError === undefined ? null : "string(stderr)" }
          )
        ]);
      }
      return this.readPlan(resultPath, request);
    } finally {
      // The answer file never outlives the turn, on success or on failure. The snapshot itself is
      // disposed by its owner; this only removes what this port added to it.
      await rm(resultDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Redacts local secret values and common token shapes from any diagnostic text. */
  public sanitize(text: string): string {
    return redactSensitive(text, this.secretValues);
  }

  /**
   * Strict parse. The answer must be JSON and nothing else: a fenced block is REPORTED, never
   * unwrapped, because quietly accepting decorated output is how a planner learns to ignore the
   * contract. Nothing here treats stdout as an alternative source.
   */
  private async readPlan(
    resultPath: string,
    request: OrchestratorPlanRequest
  ): Promise<OrchestratorPlanResult> {
    let content: string;
    try {
      content = await readFile(resultPath, "utf8");
    } catch {
      return this.failed([
        diagnostic("result_missing", "The planner exited successfully but wrote no plan file.")
      ]);
    }
    if (content.trim().length === 0) {
      return this.failed([diagnostic("result_empty", "The planner's plan file was empty.")]);
    }
    if (content.length > MAX_RESULT_BYTES) {
      return this.failed([
        diagnostic("limit_exceeded", "The planner's answer is larger than the accepted budget.", {
          structuralShape: `string(${String(content.length)})`
        })
      ]);
    }
    if (content.includes("```")) {
      return this.failed([
        diagnostic(
          "result_wrapped_in_markdown",
          "The planner wrapped its answer in a markdown fence; the contract requires bare JSON.",
          { structuralShape: `string(${String(content.length)})` }
        )
      ]);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return this.failed([
        diagnostic("result_not_json", "The planner's answer was not valid JSON.", {
          structuralShape: `string(${String(content.length)})`
        })
      ]);
    }
    const validation = validateOrchestratorPlan(raw, {
      allowedAdapters: allowedAdapters(request),
      maxNodes: request.strategy.limits.maxWorkflowNodes,
      workspaceId: "planning",
      objective: request.objective,
      executionProfile: request.strategy.executionProfile,
      sourceTerminalId: "orchestrator:codex"
    });
    if (!validation.ok) return this.failed(validation.diagnostics);
    return { plan: validation.plan, adapterId: this.id, diagnostics: [] };
  }

  private failed(diagnostics: readonly StructuredDiagnostic[]): OrchestratorPlanResult {
    // A failed planning turn returns NO plan: a partial or "mostly valid" plan is never materialized.
    return { plan: null, adapterId: this.id, diagnostics };
  }

  private async resolveExecutable(): Promise<DetectedExecutable> {
    return resolveCodexExecutable({
      detector: this.deps.detector,
      platform: this.deps.platform,
      environment: this.deps.environment,
      executablePath: this.deps.executablePath,
      architecture: this.deps.architecture,
      fileExists: this.deps.fileExists
    });
  }

  private resolveTimeoutMs(): number {
    const requested = this.deps.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;
    if (!Number.isInteger(requested)) return DEFAULT_PLANNING_TIMEOUT_MS;
    return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }

  private probeEnvironment(): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const name of ["PATH", "PATHEXT", "HOME", "USERPROFILE", "CODEX_HOME"]) {
      const value = Object.entries(this.deps.environment).find(
        ([key]) => key.toUpperCase() === name
      )?.[1];
      if (value !== undefined) output[name] = value;
    }
    return output;
  }

  /**
   * The same objective, budget, project facts and schema-derived contract Claude receives. Only the
   * delivery differs, because the two CLIs differ; the asked-for shape is identical by construction.
   */
  private buildPrompt(request: OrchestratorPlanRequest): string {
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
      ...limitLines(request),
      "",
      "## Project",
      describeMetadata(request.projectMetadata),
      "",
      "## Agents available to EXECUTE nodes (you are the planner, not an executor)",
      ...request.availableAgents.map(
        (agent) =>
          `- ${agent.id} (${agent.displayName})${agent.capabilities.length === 0 ? "" : `: ${agent.capabilities.join(", ")}`}`
      ),
      "",
      ...(request.acceptanceCriteria === undefined || request.acceptanceCriteria.length === 0
        ? []
        : [
            "### Acceptance criteria required by the user",
            ...request.acceptanceCriteria.map((criterion) => `- ${criterion}`),
            ""
          ]),
      ...planContractSection(allowedAdapters(request))
    ].join("\n");
  }
}

/** Only agents that can actually execute a node may be named by a plan. */
function allowedAdapters(request: OrchestratorPlanRequest): readonly string[] {
  const usable = request.availableAgents
    .filter((agent) => agent.available)
    .map((agent) => agent.id);
  return usable.length === 0 ? request.availableAgents.map((agent) => agent.id) : usable;
}

function limitLines(request: OrchestratorPlanRequest): readonly string[] {
  const limits = request.strategy.limits;
  return [
    `- At most ${String(limits.maxWorkflowNodes)} nodes.`,
    `- At most ${String(limits.maxRemediationCycles)} automatic remediation cycles for the whole run.`,
    `- At most ${String(limits.maxAttemptsPerNode)} attempts per node.`,
    `- The whole run must fit in ${String(Math.round(limits.timeoutMs / 60_000))} minutes.`
  ];
}

/** Project facts are caller-resolved and already sanitized; they are described, never re-derived. */
function describeMetadata(metadata: unknown): string {
  if (typeof metadata === "string") return metadata;
  if (metadata === null || metadata === undefined) return "(no project metadata was provided)";
  try {
    return JSON.stringify(metadata, null, 2).slice(0, 8_000);
  } catch {
    return `(project metadata could not be described: ${structuralShapeOf(metadata)})`;
  }
}

function collectSecretValues(
  environment: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      value.length >= 4 &&
      /TOKEN|SECRET|KEY|COOKIE|PASSWORD|SESSION|AUTH/i.test(key)
    ) {
      values.push(value);
    }
  }
  return values;
}

function firstLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}
