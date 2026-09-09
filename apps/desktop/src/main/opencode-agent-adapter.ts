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
import { OpenCodeExecutableError, resolveOpenCodeExecutable } from "./opencode-executable";
import type {
  AgentNodeLaunchInput,
  AgentNodeLaunchPlan,
  ResolvedAgentInput
} from "./process-agent-node-executor";

export const OPENCODE_ADAPTER_ID = "opencode" as const;

/** The managed path the agent must write its result to; named in the prompt and in the environment. */
const RESULT_PATH_ENV = "COMPAZIO_RESULT_PATH" as const;

/**
 * OpenCode's own config location. These are PATHS to the profile the user already owns — never
 * credential content. `OPENCODE_AUTH_CONTENT` and `OPENCODE_CONFIG_CONTENT` exist and carry inline
 * credentials/config; they are deliberately absent here and are never read, set or forwarded.
 */
const OPENCODE_CONFIG_ENV = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROMPT_CONTEXT_BYTES = 16_384;
const MAX_PROMPT_OBJECTIVE_BYTES = 8_192;
const MAX_CRITERIA = 32;

/** `provider/model`, the only shape OpenCode accepts. Anything else is rejected, never passed through. */
const MODEL_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.:-]{1,96}$/;

export interface OpenCodeAdapterConfig {
  /** Explicit executable to run. When set it is the only candidate; tests swap only this path. */
  readonly executablePath?: string;
  /** Adapter-validated single-shot timeout, clamped to [1s, 60m]; defaults to 5 minutes. */
  readonly timeoutMs?: number;
  /**
   * Optional `provider/model` override. It is validated against {@link MODEL_PATTERN} and passed as a
   * plain argument; when absent OpenCode uses the user's own configured default. The adapter never
   * picks a provider on its own and never carries a credential.
   */
  readonly model?: string;
}

export interface OpenCodeAdapterDeps {
  readonly detector: ExecutableDetector;
  readonly commandRunner: CommandRunner;
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly config?: OpenCodeAdapterConfig;
  /** Injectable existence check for a resolved native target; defaults to fs access. */
  readonly fileExists?: (path: string) => Promise<boolean>;
}

/**
 * Production adapter for the locally installed and configured OpenCode CLI, run through
 * `opencode run` — its official non-interactive mode — over the same pipe transport, the same
 * ProcessAgentNodeExecutor and the same ProcessSupervisor every other agent uses.
 *
 * The prompt is delivered on stdin: with no positional message and a piped (non-TTY) stdin, OpenCode
 * reads the whole input as the message, so the instruction never touches the command line. There is
 * no file fallback for the prompt — if stdin does not arrive, OpenCode fails loudly rather than
 * running an empty task.
 *
 * OpenCode has no `--output-last-message` equivalent, so the official result is a controlled file
 * inside the run's managed staging directory: the adapter names that path in the environment and in
 * the prompt, and the executor treats a missing, empty or unreadable file as a failure. Terminal text
 * is never authority.
 *
 * Provider and model stay the user's own: no key is requested or stored, only path-valued config
 * variables are forwarded, and the dangerous permission bypass this CLI offers is never used.
 */
export class OpenCodeAgentAdapter implements AgentNodeAdapter {
  public readonly id = OPENCODE_ADAPTER_ID;
  private readonly detector: ExecutableDetector;
  private readonly commandRunner: CommandRunner;
  private readonly platform: RuntimePlatform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly config: OpenCodeAdapterConfig;
  private readonly secretValues: readonly string[];
  private readonly fileExists: (path: string) => Promise<boolean>;

  public constructor(deps: OpenCodeAdapterDeps) {
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
      // No positional message: OpenCode reads the whole prompt from the piped stdin. `--format json`
      // keeps stdout deterministic for observability only — it is never read as the result. The
      // dangerous permission bypass is deliberately absent, so the user's own permission policy holds.
      args: ["run", "--format", "json", "--dir", input.cwd, ...this.modelArguments()],
      stdin: this.buildPrompt(input),
      // Single-shot OpenCode runs over a real stdin pipe, never a pty: it only reads stdin when
      // stdin is NOT a TTY, and a batch run has no terminal to attach to.
      transport: "pipe",
      producesArtifact: true,
      artifactType: "opencode-result",
      artifactFilename: "result.txt",
      mediaType: "text/plain",
      environment: { [RESULT_PATH_ENV]: input.outputPath },
      additionalAllowedEnvKeys: [RESULT_PATH_ENV, ...OPENCODE_CONFIG_ENV],
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
              "Install the OpenCode CLI (npm i -g opencode-ai) and ensure `opencode` is on PATH."
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
          message: this.sanitize("OpenCode was found but could not report its version."),
          remediation: "Run `opencode --version` in a trusted terminal to verify the installation."
        }
      };
    }
    // Whether a provider is configured is NOT probed here: the only checks that would prove it are
    // paid or hit the network, and reading OpenCode's credential store is exactly what this adapter
    // must never do. A missing provider surfaces as a real node failure with the CLI's own message.
    return { id: this.id, available: true, version: this.sanitize(version), issue: null };
  }

  /** Redacts local secret values and common token shapes from any diagnostic text. */
  public sanitize(text: string): string {
    return redactSensitive(text, this.secretValues);
  }

  /** The `-m provider/model` pair, only when a valid one was configured for this adapter. */
  private modelArguments(): readonly string[] {
    const model = this.config.model;
    if (model === undefined) return [];
    if (!MODEL_PATTERN.test(model)) {
      throw new AgentAdapterUnavailableError(
        "The configured OpenCode model is not a valid provider/model reference.",
        this.id
      );
    }
    return ["-m", model];
  }

  /**
   * The launchable OpenCode binary, or an unavailability error carrying an actionable reason. The
   * resolution itself lives in the shared {@link resolveOpenCodeExecutable} primitive, so the planning
   * port reaches the same binary the same safe way instead of duplicating the layout knowledge.
   */
  private async requireExecutable(): Promise<DetectedExecutable> {
    try {
      return await resolveOpenCodeExecutable({
        detector: this.detector,
        platform: this.platform,
        environment: this.environment,
        executablePath: this.config.executablePath,
        fileExists: this.fileExists
      });
    } catch (error: unknown) {
      if (error instanceof OpenCodeExecutableError) {
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
    for (const name of ["PATH", "PATHEXT", "HOME", "USERPROFILE", ...OPENCODE_CONFIG_ENV]) {
      const value = readEnv(this.environment, name);
      if (value !== undefined) output[name] = value;
    }
    return output;
  }

  /**
   * The complete instruction for this node, and nothing else: the objective, the role, the attempt,
   * the acceptance criteria, the approved workspace and the official upstream context by artifact path
   * and recorded hash. It never carries the run's transcript, another node's history, or state held
   * inside a different agent — every fact OpenCode may rely on came through Compazio's own artifacts.
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
      `Write your final result to the file named by the ${RESULT_PATH_ENV} environment variable: ${input.outputPath}`,
      "The task is only complete once that file exists; printing the result to the terminal is not enough."
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
      /TOKEN|SECRET|KEY|COOKIE|PASSWORD|SESSION|AUTH|CONTENT/i.test(key)
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
