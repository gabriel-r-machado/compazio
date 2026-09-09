import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CommandRunner,
  DetectedExecutable,
  ExecutableDetector,
  RuntimePlatform
} from "@forgedeck/agent-sdk";

import {
  AgentAdapterUnavailableError,
  type AgentAdapterAvailability,
  type AgentNodeAdapter
} from "./agent-adapter-registry";
import { redactSensitive } from "./claude-code-agent-adapter";
import { CodexExecutableError, resolveCodexExecutable } from "./codex-executable";
import type {
  AgentNodeLaunchInput,
  AgentNodeLaunchPlan,
  ResolvedAgentInput
} from "./process-agent-node-executor";

export const CODEX_ADAPTER_ID = "codex" as const;

/** Codex's own profile directory (config + local auth). Preserved by value, never read or stored. */
const CODEX_HOME_ENV = "CODEX_HOME" as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROMPT_CONTEXT_BYTES = 16_384;
const MAX_PROMPT_OBJECTIVE_BYTES = 8_192;
const MAX_CRITERIA = 32;

export interface CodexAdapterConfig {
  /** Explicit executable to run. When set it is the only candidate; tests swap only this path. */
  readonly executablePath?: string;
  /** Adapter-validated single-shot timeout, clamped to [1s, 60m]; defaults to 5 minutes. */
  readonly timeoutMs?: number;
  /** Overrides the detected CPU architecture when resolving the vendored binary (tests only). */
  readonly architecture?: string;
}

export interface CodexAdapterDeps {
  readonly detector: ExecutableDetector;
  readonly commandRunner: CommandRunner;
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly config?: CodexAdapterConfig;
  /** Injectable existence check for a resolved native target; defaults to fs access. */
  readonly fileExists?: (path: string) => Promise<boolean>;
}

/**
 * Production adapter for the locally installed and authenticated Codex CLI, run through
 * `codex exec` — its official non-interactive mode — over the same pipe transport, the same
 * ProcessAgentNodeExecutor and the same ProcessSupervisor every other agent uses.
 *
 * It reuses the user's own Codex authentication exactly as it stands: it never asks for an API key,
 * never reads, copies or stores a credential file, and never inspects an auth token. It only
 * preserves `CODEX_HOME` by value for this one launch, so the CLI finds the profile it already owns.
 *
 * Its whole responsibility is the launch decision: locate the allowed executable, validate
 * availability, build safe arguments (no shell, prompt on stdin, result written to a managed path
 * inside the official staging directory), pick the cwd and the permitted environment, declare the
 * artifact it produces, and report sanitized errors. It never controls the scheduler, creates an
 * attempt, decides a retry, touches SQLite, updates the renderer, or launches another agent.
 */
export class CodexAgentAdapter implements AgentNodeAdapter {
  public readonly id = CODEX_ADAPTER_ID;
  private readonly detector: ExecutableDetector;
  private readonly commandRunner: CommandRunner;
  private readonly platform: RuntimePlatform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly config: CodexAdapterConfig;
  private readonly secretValues: readonly string[];
  private readonly fileExists: (path: string) => Promise<boolean>;

  public constructor(deps: CodexAdapterDeps) {
    this.detector = deps.detector;
    this.commandRunner = deps.commandRunner;
    this.platform = deps.platform;
    this.environment = deps.environment;
    this.config = deps.config ?? {};
    this.secretValues = collectSecretValues(deps.environment);
    this.fileExists = deps.fileExists ?? defaultFileExists;
  }

  public async planLaunch(input: AgentNodeLaunchInput): Promise<AgentNodeLaunchPlan> {
    const executable = await this.requireExecutable();

    // An empty objective is rejected here, before any process is started.
    if (input.task.trim().length === 0) {
      throw new AgentAdapterUnavailableError("The agent objective is empty.", this.id);
    }

    // Every managed path the process is pointed at must stay inside the approved workspace root.
    assertInsideWorkspace(input.cwd, input.outputPath, this.id);
    for (const upstream of input.inputs) {
      assertInsideWorkspace(input.cwd, upstream.path, this.id);
    }

    return {
      executable,
      // `codex exec` is the official non-interactive mode. The prompt is deliberately NOT passed as
      // the positional argument: omitting it makes Codex read the instructions from stdin, so the
      // full text — newlines, Unicode, quotes, shell metacharacters — never touches the command line.
      // `--output-last-message` is Codex's own mechanism for writing its final answer to a file, so
      // the structured result lands in the managed staging path rather than being scraped from stdout.
      args: [
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--sandbox",
        this.sandboxMode(input),
        "--cd",
        input.cwd,
        "--output-last-message",
        input.outputPath
      ],
      stdin: this.buildPrompt(input),
      // Single-shot Codex runs over a real stdin pipe, never a pty: a Windows ConPTY does not deliver
      // written input to a child's stdin, and a batch run has no terminal to attach to.
      transport: "pipe",
      producesArtifact: true,
      artifactType: "codex-result",
      artifactFilename: "result.txt",
      mediaType: "text/plain",
      // Only Codex's own profile directory is passed through, and only by value for this launch.
      additionalAllowedEnvKeys: [CODEX_HOME_ENV],
      timeoutMs: this.resolveTimeoutMs()
    };
  }

  public async detect(): Promise<AgentAdapterAvailability> {
    let executable: DetectedExecutable;
    try {
      executable = await this.requireExecutable();
    } catch (error: unknown) {
      if (error instanceof AgentAdapterUnavailableError) {
        return {
          id: this.id,
          available: false,
          version: null,
          issue: {
            code: "adapter_executable_not_found",
            message: this.sanitize(error.message),
            remediation:
              "Install the Codex CLI (npm i -g @openai/codex) and ensure `codex` is on PATH."
          }
        };
      }
      throw error;
    }
    const result = await this.commandRunner.run({
      executable,
      args: ["--version"],
      cwd: process.cwd(),
      environment: this.probeEnvironment(),
      timeoutMs: VERSION_PROBE_TIMEOUT_MS
    });
    const version = firstLine(result.stdout) ?? firstLine(result.stderr);
    if (result.exitCode !== 0 || version === null) {
      return {
        id: this.id,
        available: false,
        version: null,
        issue: {
          code: "adapter_detection_failed",
          message: this.sanitize("Codex was found but could not report its version."),
          remediation: "Run `codex --version` in a trusted terminal to verify the installation."
        }
      };
    }
    // Authentication is deliberately not probed: Codex has no local check that is both safe and
    // unpaid, and reading its credential files is exactly what this adapter must never do.
    return { id: this.id, available: true, version: this.sanitize(version), issue: null };
  }

  /** Redacts local secret values and common token shapes from any diagnostic text. */
  public sanitize(text: string): string {
    return redactSensitive(text, this.secretValues);
  }

  /**
   * Codex's sandbox is chosen from the node's own declared permissions, never widened by the adapter.
   * A node that may not write to the workspace runs read-only, and the dangerous bypass modes are
   * unreachable from here by construction.
   */
  private sandboxMode(input: AgentNodeLaunchInput): "read-only" | "workspace-write" {
    return input.node.permissions.workspace_write === true ? "workspace-write" : "read-only";
  }

  /**
   * The launchable Codex binary, or an unavailability error carrying an actionable reason. The
   * resolution itself lives in the shared {@link resolveCodexExecutable} primitive, so the planning
   * port reaches the same binary the same safe way instead of duplicating the layout knowledge.
   */
  private async requireExecutable(): Promise<DetectedExecutable> {
    try {
      return await resolveCodexExecutable({
        detector: this.detector,
        platform: this.platform,
        environment: this.environment,
        executablePath: this.config.executablePath,
        architecture: this.config.architecture,
        fileExists: this.fileExists
      });
    } catch (error: unknown) {
      if (error instanceof CodexExecutableError) {
        throw new AgentAdapterUnavailableError(error.message, this.id);
      }
      throw error;
    }
  }

  private resolveTimeoutMs(): number {
    const requested = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(requested)) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }

  private probeEnvironment(): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    const path = readEnv(this.environment, "PATH");
    if (path !== undefined) output.PATH = path;
    const pathExt = readEnv(this.environment, "PATHEXT");
    if (pathExt !== undefined) output.PATHEXT = pathExt;
    const codexHome = readEnv(this.environment, CODEX_HOME_ENV);
    if (codexHome !== undefined) output[CODEX_HOME_ENV] = codexHome;
    return output;
  }

  /**
   * The complete instruction for this node, and nothing else. It carries the objective, the role, the
   * acceptance criteria and the official upstream context — artifact paths and their recorded hashes.
   * It deliberately never carries the run's transcript, another node's history, or any state held
   * inside a different agent: everything Codex is allowed to rely on came through Compazio's own
   * artifacts and hashes.
   */
  private buildPrompt(input: AgentNodeLaunchInput): string {
    const objective = input.task.trim();
    const lines = [
      "You are a single-shot delivery agent running non-interactively.",
      `Role: ${input.role}.`,
      `Attempt: ${input.attempt}.`,
      "Objective:",
      objective.slice(0, MAX_PROMPT_OBJECTIVE_BYTES),
      "",
      `Work only inside the approved workspace: ${input.cwd}`,
      "Complete and verify every requested workspace change before your final message; a final message never replaces a required file or code change.",
      "End your final message with the result of the work; it is recorded as this step's official artifact."
    ];
    const criteria = acceptanceCriteria(input);
    if (criteria.length > 0) {
      lines.push("", "Acceptance criteria:", ...criteria.map((entry) => `- ${entry}`));
    }
    const context = describeUpstreamContext(input.inputs);
    if (context !== null) {
      lines.push("", "Upstream context (official artifacts you may read by path):", context);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** The node's declared acceptance criteria, bounded and de-duplicated. */
function acceptanceCriteria(input: AgentNodeLaunchInput): readonly string[] {
  const declared = input.node.output?.acceptanceCriteria;
  if (!Array.isArray(declared)) return [];
  return [
    ...new Set(
      declared.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    )
  ].slice(0, MAX_CRITERIA);
}

/** A bounded description of the official upstream artifacts, by path and hash — never contents. */
function describeUpstreamContext(inputs: readonly ResolvedAgentInput[]): string | null {
  if (inputs.length === 0) return null;
  let description = "";
  for (const input of inputs) {
    const line = `- ${input.nodeId}: ${input.path} (sha256 ${input.sha256}, ${input.mediaType})\n`;
    if (description.length + line.length > MAX_PROMPT_CONTEXT_BYTES) break;
    description += line;
  }
  return description.trimEnd();
}

/** Rejects a managed path that escapes the approved workspace root. */
function assertInsideWorkspace(workspaceRoot: string, candidate: string, adapterId: string): void {
  const root = resolve(workspaceRoot);
  const target = resolve(candidate);
  const fromRoot = relative(root, target);
  const inside =
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
  if (!inside) {
    throw new AgentAdapterUnavailableError(
      "A managed path resolved outside the approved workspace.",
      adapterId
    );
  }
}

/** Literal values of environment entries whose key names suggest a credential. */
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

function readEnv(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

function firstLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
