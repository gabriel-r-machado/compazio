import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 as winPath } from "node:path";

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
import type {
  AgentNodeLaunchInput,
  AgentNodeLaunchPlan,
  ResolvedAgentInput
} from "./process-agent-node-executor";

export const CLAUDE_CODE_ADAPTER_ID = "claude-code" as const;

/** The managed path the child writes its structured result to; also named in the prompt for Claude. */
const RESULT_PATH_ENV = "COMPAZIO_RESULT_PATH" as const;
/** The managed file holding the full prompt, for large content and shim launches that can't take argv. */
const PROMPT_PATH_ENV = "COMPAZIO_PROMPT_PATH" as const;
/** Claude Code's local profile directory. Preserved by value from the live environment, never stored. */
const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR" as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROMPT_CONTEXT_BYTES = 16_384;
const MAX_PROMPT_OBJECTIVE_BYTES = 8_192;

/**
 * The executable Claude will be launched with, after resolving a Windows command shim (`claude.cmd`)
 * to the native binary it wraps. The pipe transport can only run a native executable, so a shim is
 * only usable once its `nativeTarget` is resolved and validated against the expected install layout.
 */
export interface ResolvedExecutable {
  readonly path: string;
  readonly kind: "native" | "command-shim";
  /** The native binary a command shim invokes, when it could be resolved and validated; else absent. */
  readonly nativeTarget?: string;
}

export interface ClaudeCodeAdapterConfig {
  /**
   * Explicit executable to run. When set it is the only candidate (validated for existence); when
   * absent, `claude` is resolved on PATH. Tests swap only this path — never the arguments.
   */
  readonly executablePath?: string;
  /** Adapter-validated single-shot timeout, clamped to [1s, 60m]; defaults to 5 minutes. */
  readonly timeoutMs?: number;
}

export interface ClaudeCodeAdapterDeps {
  readonly detector: ExecutableDetector;
  readonly commandRunner: CommandRunner;
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly config?: ClaudeCodeAdapterConfig;
  /** Injectable prompt-file writer (defaults to fs writeFile); overridden in unit tests. */
  readonly writePromptFile?: (path: string, content: string) => Promise<void>;
  /**
   * Injectable creator for the managed staging directory (defaults to a recursive fs mkdir). The adapter
   * owns staging its own prompt file, so it must not assume a caller pre-created the directory.
   */
  readonly createDirectory?: (path: string) => Promise<void>;
  /** Injectable reader for a command shim's text, to resolve its native target; defaults to fs. */
  readonly readShimFile?: (path: string) => Promise<string>;
  /** Injectable existence check for a resolved native target; defaults to fs access. */
  readonly fileExists?: (path: string) => Promise<boolean>;
}

/**
 * Production adapter for the locally installed and authenticated Claude Code CLI, run as a
 * single-shot (`--print`) agent node through the existing ProcessAgentNodeExecutor / ProcessSupervisor.
 * It reuses the user's local Claude authentication as-is: it never asks for an API key, copies, stores
 * or touches credential files, or assumes an account. It preserves the local profile directory
 * (CLAUDE_CONFIG_DIR) by value for this launch only. No interactive terminal is involved in this
 * milestone.
 *
 * Responsibilities are strictly launch-shaped: locate the allowed executable, validate availability,
 * build safe arguments (no shell, prompt on stdin, managed result path via a dedicated env var),
 * choose the cwd/workspace, select the permitted environment, declare the produced artifact, and
 * report actionable, sanitized errors. It never controls the scheduler, attempts, retries or cards.
 */
export class ClaudeCodeAgentAdapter implements AgentNodeAdapter {
  public readonly id = CLAUDE_CODE_ADAPTER_ID;
  private readonly detector: ExecutableDetector;
  private readonly commandRunner: CommandRunner;
  private readonly platform: RuntimePlatform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly config: ClaudeCodeAdapterConfig;
  private readonly secretValues: readonly string[];
  private readonly writePromptFile: (path: string, content: string) => Promise<void>;
  private readonly createDirectory: (path: string) => Promise<void>;
  private readonly readShimFile: (path: string) => Promise<string>;
  private readonly fileExists: (path: string) => Promise<boolean>;

  public constructor(deps: ClaudeCodeAdapterDeps) {
    this.detector = deps.detector;
    this.commandRunner = deps.commandRunner;
    this.platform = deps.platform;
    this.environment = deps.environment;
    this.config = deps.config ?? {};
    this.secretValues = collectSecretValues(deps.environment);
    this.writePromptFile =
      deps.writePromptFile ?? ((path, content) => writeFile(path, content, "utf8"));
    this.createDirectory =
      deps.createDirectory ??
      (async (path) => {
        await mkdir(path, { recursive: true });
      });
    this.readShimFile = deps.readShimFile ?? ((path) => readFile(path, "utf8"));
    this.fileExists = deps.fileExists ?? defaultFileExists;
  }

  public async planLaunch(input: AgentNodeLaunchInput): Promise<AgentNodeLaunchPlan> {
    const resolved = await this.resolveExecutable();
    if (resolved === null) {
      throw new AgentAdapterUnavailableError(
        "Claude Code executable was not found. Install it and ensure `claude` is on PATH.",
        this.id
      );
    }
    // A command shim is only launchable once its native binary is resolved and validated; otherwise
    // this throws AgentAdapterUnavailableError, so the node fails safely before any process starts.
    const executable = this.toLaunchExecutable(resolved);

    // An empty objective is rejected here, before any process is started.
    if (input.task.trim().length === 0) {
      throw new AgentAdapterUnavailableError("The agent objective is empty.", this.id);
    }

    // Every managed path the process is pointed at must stay inside the approved workspace root.
    assertInsideWorkspace(input.cwd, input.outputPath, this.id);
    // The evidence path is handed to the agent literally, so it must be an absolute staging path and
    // never a relative fragment the agent could resolve against some other directory.
    if (!isAbsolute(input.outputPath)) {
      throw new AgentAdapterUnavailableError("The managed result path must be absolute.", this.id);
    }
    for (const upstream of input.inputs) {
      assertInsideWorkspace(input.cwd, upstream.path, this.id);
    }

    const prompt = this.buildPrompt(input);
    // The prompt is delivered on stdin (mirroring `claude -p`), which preserves newlines, Unicode,
    // quotes and shell metacharacters and never places content on the command line. The one delivery
    // protocol works for both native executables and command shims — no shell, no argv prompt. The
    // staged prompt file is kept only as a controlled diagnostic/fixture aid, never the sole channel.
    const promptPath = `${input.outputPath}.prompt`;
    // The staged path is validated in its own right, not merely inherited from outputPath.
    assertInsideWorkspace(input.cwd, promptPath, this.id);
    const stagingDirectory = dirname(promptPath);
    // Validated BEFORE it is created, so a directory is never made outside the approved workspace.
    assertInsideWorkspace(input.cwd, stagingDirectory, this.id);
    // The adapter owns staging its own prompt file, so it creates the managed directory itself instead of
    // assuming a caller prepared it. A planning snapshot, for instance, legitimately starts without one.
    await this.stagePromptFile(stagingDirectory, promptPath, prompt);
    return {
      executable,
      args: ["--print", "--permission-mode", "acceptEdits"],
      stdin: prompt,
      // Single-shot Claude runs over a real stdin pipe, not a pty: `claude -p` reads its prompt from
      // stdin, and a Windows ConPTY does not deliver written input to a child's process.stdin.
      transport: "pipe",
      producesArtifact: true,
      artifactType: "claude-code-result",
      artifactFilename: "result.json",
      mediaType: "application/json",
      environment: { [RESULT_PATH_ENV]: input.outputPath, [PROMPT_PATH_ENV]: promptPath },
      additionalAllowedEnvKeys: [RESULT_PATH_ENV, PROMPT_PATH_ENV, CLAUDE_CONFIG_DIR_ENV],
      timeoutMs: this.resolveTimeoutMs()
    };
  }

  public async detect(): Promise<AgentAdapterAvailability> {
    const resolved = await this.resolveExecutable();
    if (resolved === null) {
      return {
        id: this.id,
        available: false,
        version: null,
        issue: {
          code: "adapter_executable_not_found",
          message: "Claude Code was not found.",
          remediation: "Install Claude Code and ensure `claude` is available on PATH."
        }
      };
    }
    let executable: DetectedExecutable;
    try {
      executable = this.toLaunchExecutable(resolved);
    } catch (error: unknown) {
      // Present but only as a command shim whose native binary could not be resolved: it cannot be
      // launched over a pipe, so it is reported unavailable with an actionable remediation.
      if (error instanceof AgentAdapterUnavailableError) {
        return {
          id: this.id,
          available: false,
          version: null,
          issue: {
            code: "adapter_executable_not_found",
            message: this.sanitize(error.message),
            remediation:
              "Reinstall Claude Code so its native binary is available (npm i -g @anthropic-ai/claude-code)."
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
          message: this.sanitize("Claude Code was found but could not report its version."),
          remediation: "Run `claude --version` in a trusted terminal to verify the installation."
        }
      };
    }
    return { id: this.id, available: true, version: this.sanitize(version), issue: null };
  }

  /** Redacts local secret values and common token shapes from any diagnostic text. */
  public sanitize(text: string): string {
    return redactSensitive(text, this.secretValues);
  }

  /**
   * Creates the managed staging directory and writes the prompt into it. A filesystem failure becomes an
   * adapter-unavailable error carrying a sanitized reason, so the node fails safely before any process is
   * started and no raw path or secret reaches a log or the renderer.
   */
  private async stagePromptFile(
    stagingDirectory: string,
    promptPath: string,
    prompt: string
  ): Promise<void> {
    try {
      await this.createDirectory(stagingDirectory);
    } catch (error: unknown) {
      throw new AgentAdapterUnavailableError(
        this.sanitize(
          `The managed staging directory could not be created: ${describeFileError(error)}`
        ),
        this.id
      );
    }
    try {
      await this.writePromptFile(promptPath, prompt);
    } catch (error: unknown) {
      throw new AgentAdapterUnavailableError(
        this.sanitize(`The prompt file could not be staged: ${describeFileError(error)}`),
        this.id
      );
    }
  }

  /**
   * Finds the Claude executable and, for a Windows command shim, resolves the native binary it wraps.
   * The native target is returned only when it could be extracted from the shim, exists, and lies in
   * the expected Claude Code install layout — never a guess and never a generic shell fallback.
   */
  private async resolveExecutable(): Promise<ResolvedExecutable | null> {
    const candidates =
      this.config.executablePath !== undefined ? [this.config.executablePath] : ["claude"];
    const detected = await this.detector.find(candidates, {
      platform: this.platform,
      environment: this.environment
    });
    if (detected === null) return null;
    if (detected.kind === "native") return { path: detected.path, kind: "native" };
    const nativeTarget = await this.resolveShimNativeTarget(detected.path);
    return nativeTarget === null
      ? { path: detected.path, kind: "command-shim" }
      : { path: detected.path, kind: "command-shim", nativeTarget };
  }

  /** The native executable to launch, or an unavailability error when only an unresolved shim exists. */
  private toLaunchExecutable(resolved: ResolvedExecutable): DetectedExecutable {
    if (resolved.kind === "native") return { path: resolved.path, kind: "native" };
    if (resolved.nativeTarget !== undefined) {
      // Prefer the validated native binary: the pipe transport runs it directly, no shell, no .cmd.
      return { path: resolved.nativeTarget, kind: "native" };
    }
    throw new AgentAdapterUnavailableError(
      "Claude Code is installed only as a command shim whose native binary could not be resolved.",
      this.id
    );
  }

  /**
   * Parses a Windows command shim (e.g. `claude.cmd`) for the native `.exe` it invokes, expands the
   * `%~dp0`/`%dp0%` self-directory references, and returns it only if it exists and belongs to the
   * expected Claude Code install layout (`node_modules/@anthropic-ai/claude-code/bin`). Anything else
   * yields null, so an unexpected or unreadable shim is treated as no native target.
   */
  private async resolveShimNativeTarget(shimPath: string): Promise<string | null> {
    let text: string;
    try {
      text = await this.readShimFile(shimPath);
    } catch {
      return null;
    }
    const match = /"([^"]+\.exe)"/i.exec(text);
    if (match?.[1] === undefined) return null;
    const shimDir = winPath.dirname(shimPath);
    const expanded = match[1].replace(/%~?dp0%?/gi, `${shimDir}\\`);
    const target = winPath.resolve(expanded);
    if (!this.isExpectedClaudeBinary(target)) return null;
    return (await this.fileExists(target)) ? target : null;
  }

  /** Validates the resolved path is a native `.exe` inside the expected Claude Code install layout. */
  private isExpectedClaudeBinary(target: string): boolean {
    const normalized = target.toLowerCase().replace(/\//g, "\\");
    return (
      normalized.endsWith(".exe") &&
      normalized.includes("\\node_modules\\") &&
      normalized.includes("@anthropic-ai") &&
      normalized.includes("claude-code") &&
      normalized.includes("\\bin\\")
    );
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
    const configDir = readEnv(this.environment, CLAUDE_CONFIG_DIR_ENV);
    if (configDir !== undefined) output[CLAUDE_CONFIG_DIR_ENV] = configDir;
    return output;
  }

  private buildPrompt(input: AgentNodeLaunchInput): string {
    const objective = input.task.trim();
    const lines = [
      "You are a single-shot delivery agent running non-interactively.",
      `Role: ${input.role}.`,
      "Objective:",
      objective.length > 0
        ? objective.slice(0, MAX_PROMPT_OBJECTIVE_BYTES)
        : "(no objective provided)",
      "",
      // The managed evidence path is given LITERALLY, not only by environment variable name. Claude
      // runs with `--print --permission-mode acceptEdits`, which auto-approves file edits but not
      // shell commands, so an agent asked to resolve `$COMPAZIO_RESULT_PATH` has no approved way to
      // learn its value and exits 0 having written the project files but no evidence. The path is
      // JSON-encoded so a Windows separator, a space or Unicode survives unambiguously. It comes only
      // from the executor's managed staging path, already validated inside the approved workspace
      // above, and it is never assembled from model text and never placed on argv.
      "Compazio requires a managed evidence file for this node.",
      "",
      "Write your final structured result as JSON to the exact absolute path below, given here as a",
      "JSON-encoded string — decode it and use that value verbatim:",
      JSON.stringify(input.outputPath),
      "",
      `This is the same path referenced by the ${RESULT_PATH_ENV} environment variable.`,
      "Use the literal path directly. Do not run a shell command to resolve the environment variable.",
      "Create or overwrite only this managed evidence file in addition to the project files the task",
      "requires.",
      "",
      "The evidence file must contain valid JSON matching the required result contract.",
      "The task is only complete once that file exists; do not print the result only to stdout.",
      "Do not report success unless this file has been written successfully."
    ];
    const context = describeUpstreamContext(input.inputs);
    if (context !== null) {
      lines.push("", "Upstream context (official artifacts you may read by path):", context);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Builds a bounded description of the official upstream artifacts, by path and hash — never contents. */
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
/**
 * A filesystem failure reduced to its error code. The absolute path is deliberately dropped: the code is
 * what a caller can act on, and a path can carry a user directory or a project name.
 */
function describeFileError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown filesystem error";
}

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

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /(?:api[_-]?key|token|secret|cookie|password|session)["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{4,}/gi
];

/**
 * Removes local secret values and common credential shapes from diagnostic text, so tokens, cookies
 * and keys never reach events, logs, reports or artifacts.
 */
export function redactSensitive(text: string, secretValues: readonly string[] = []): string {
  let output = text;
  for (const value of secretValues) {
    if (value.length >= 4) {
      output = output.split(value).join("[redacted]");
    }
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
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
