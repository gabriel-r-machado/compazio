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
import { OPENCODE_ADAPTER_ID } from "./opencode-agent-adapter";
import {
  resolveOpenCodeExecutable,
  OpenCodeExecutableError,
  type OpenCodeExecutableDeps
} from "./opencode-executable";
import { planContractSection, READ_ONLY_CONTRACT } from "./orchestrator-plan-contract";
import type { PlanningProcessRunner } from "./codex-orchestrator-port";

/**
 * OpenCode as a PLANNER. It writes one neutral {@link OrchestratorPlan} and stops: it never executes a
 * node, calls another agent, starts a run, reaches the scheduler, creates an attempt or publishes an
 * execution artifact. Which agent ends up running each node stays the user's choice.
 *
 * Protection is by ISOLATION, not by a sandbox claim. OpenCode offers no read-only mode this port can
 * rely on, so nothing here pretends it does: the turn runs with its cwd inside the disposable planning
 * snapshot, the real workspace is never the cwd and never an allowed root, the only write the plan
 * needs is the managed answer file inside that snapshot, and the caller fingerprints the real
 * workspace before and after. The dangerous permission bypass the CLI offers is never passed.
 *
 * The plan is read from that managed file, never scraped from stdout: terminal text is not a plan.
 * Missing, empty, fenced, unparseable or schema-invalid output is a structured planning failure, and
 * no partial plan is ever returned. The provider and model stay the user's own — no key is requested
 * or stored, and inline credential/config variables are never read or forwarded.
 */

const DEFAULT_PLANNING_TIMEOUT_MS = 5 * 60 * 1_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_RESULT_BYTES = 512 * 1024;
/** The managed directory, inside the disposable snapshot, that holds the planning answer. */
const RESULT_DIRECTORY = ".compazio" as const;
const RESULT_FILENAME = "plan.json" as const;
/** The variable that names the managed answer file. Its literal value is also given in the prompt. */
const PLAN_PATH_ENV = "COMPAZIO_PLAN_PATH" as const;
/**
 * OpenCode's own config location. These are PATHS to the profile the user already owns — never
 * credential content. `OPENCODE_AUTH_CONTENT` and `OPENCODE_CONFIG_CONTENT` carry inline credentials
 * and are deliberately absent: they are never read, set or forwarded.
 */
const OPENCODE_CONFIG_ENV = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] as const;

export interface OpenCodeOrchestratorPortDeps {
  readonly runner: PlanningProcessRunner;
  readonly commandRunner: CommandRunner;
  readonly detector: OpenCodeExecutableDeps["detector"];
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executablePath?: string;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly planningTimeoutMs?: number;
}

export class OpenCodeOrchestratorPort implements OrchestratorPlanningPort {
  public readonly id = OPENCODE_ADAPTER_ID;
  private readonly secretValues: readonly string[];

  public constructor(private readonly deps: OpenCodeOrchestratorPortDeps) {
    this.secretValues = collectSecretValues(deps.environment);
  }

  public async detect(): Promise<OrchestratorAvailability> {
    let executable: DetectedExecutable;
    try {
      executable = await this.resolveExecutable();
    } catch (error: unknown) {
      return this.unavailable(
        error instanceof OpenCodeExecutableError
          ? error.message
          : "OpenCode could not be resolved for planning."
      );
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
      return this.unavailable("OpenCode was found but could not report its version.");
    }
    // Whether a provider is configured is NOT probed: the only checks that would prove it are paid or
    // hit the network, and reading OpenCode's credential store is exactly what this port must never do.
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
            error instanceof OpenCodeExecutableError
              ? error.message
              : "OpenCode could not be resolved for planning."
          )
        )
      ]);
    }

    const resultDirectory = join(request.planningSnapshotPath, RESULT_DIRECTORY);
    const planPath = join(resultDirectory, RESULT_FILENAME);
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
        // No positional message: with a piped stdin OpenCode reads the whole prompt from it, so the
        // instruction never touches the command line. `--format json` keeps stdout deterministic for
        // observability only — it is never read as the plan. The permission bypass is absent.
        args: ["run", "--format", "json", "--dir", request.planningSnapshotPath],
        cwd: request.planningSnapshotPath,
        stdin: this.buildPrompt(request, planPath),
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
            )
          )
        ]);
      }
      return this.readPlan(planPath, request);
    } finally {
      // The answer file never outlives the turn. The snapshot itself is disposed by its owner; this
      // removes only what this port added to it.
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
    planPath: string,
    request: OrchestratorPlanRequest
  ): Promise<OrchestratorPlanResult> {
    let content: string;
    try {
      content = await readFile(planPath, "utf8");
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
      sourceTerminalId: "orchestrator:opencode"
    });
    if (!validation.ok) return this.failed(validation.diagnostics);
    return { plan: validation.plan, adapterId: this.id, diagnostics: [] };
  }

  private failed(diagnostics: readonly StructuredDiagnostic[]): OrchestratorPlanResult {
    // A failed planning turn returns NO plan: a partial or "mostly valid" plan is never materialized.
    return { plan: null, adapterId: this.id, diagnostics };
  }

  private unavailable(message: string): OrchestratorAvailability {
    return {
      id: this.id,
      hasImplementation: true,
      available: false,
      version: null,
      issue: diagnostic("planner_unavailable", this.sanitize(message))
    };
  }

  private async resolveExecutable(): Promise<DetectedExecutable> {
    return resolveOpenCodeExecutable({
      detector: this.deps.detector,
      platform: this.deps.platform,
      environment: this.deps.environment,
      executablePath: this.deps.executablePath,
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
    for (const name of ["PATH", "PATHEXT", "HOME", "USERPROFILE", ...OPENCODE_CONFIG_ENV]) {
      const value = Object.entries(this.deps.environment).find(
        ([key]) => key.toUpperCase() === name
      )?.[1];
      if (value !== undefined) output[name] = value;
    }
    return output;
  }

  /**
   * The same objective, budget, project facts and schema-derived contract every other planner receives.
   * The managed answer path is given LITERALLY as well as by variable name: an agent that cannot run a
   * shell has no approved way to resolve a variable, and would otherwise exit successfully having
   * written nothing.
   */
  private buildPrompt(request: OrchestratorPlanRequest, planPath: string): string {
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
      "## Where the plan goes",
      "Compazio requires the plan in a managed file, and that file is the only thing you may write.",
      "Write the JSON object to the exact absolute path below, given here as a JSON-encoded string —",
      "decode it and use that value verbatim:",
      JSON.stringify(planPath),
      "",
      `This is the same path referenced by the ${PLAN_PATH_ENV} environment variable.`,
      "Use the literal path directly. Do not run a shell command to resolve the environment variable.",
      "Do not write any other file, and do not print the plan to the terminal instead.",
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
      /TOKEN|SECRET|KEY|COOKIE|PASSWORD|SESSION|AUTH|CONTENT/i.test(key)
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
