import type { CommandRunner } from "@forgedeck/agent-sdk";
import { createAllowedEnvironment } from "@forgedeck/terminal";

import {
  AgentAdapterUnavailableError,
  type AgentAdapterAvailability,
  type AgentNodeAdapter
} from "./agent-adapter-registry";
import type { AgentNodeLaunchInput, AgentNodeLaunchPlan } from "./process-agent-node-executor";

const CLAUDE_CODE_ADAPTER_ID = "claude-code" as const;
const RESULT_PATH_ENV = "COMPAZIO_RESULT_PATH" as const;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ClaudeCodeFixtureAdapterDeps {
  /** Absolute path to the controlled `.mjs` fixture that stands in for the real Claude Code CLI. */
  readonly fixtureScriptPath: string;
  /** A real Node binary to run the fixture (Electron's own binary is not Node); defaults to this one. */
  readonly nodeExecutablePath?: string;
  /** Runs the fixture's `--version` probe for availability. */
  readonly commandRunner: CommandRunner;
  /** Live environment the child inherits (allowlisted); defaults to `process.env`. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Test/e2e double for the Claude Code adapter, registered under the same `claude-code` id. It runs the
 * deterministic fixture over the SAME pipe transport the real adapter uses — `node <fixture>` with the
 * prompt on stdin — so the flow test and the smoke exercise the real registry, router, executor and
 * ProcessSupervisor without ever calling the real Claude. It is NEVER wired into production `index.ts`;
 * the pipe transport requires a native executable, and Node is that native binary here (the real
 * adapter resolves `claude.exe`). The real adapter's own executable resolution is covered by its unit
 * tests and the opt-in local check.
 */
export class ClaudeCodeFixtureAdapter implements AgentNodeAdapter {
  public readonly id = CLAUDE_CODE_ADAPTER_ID;
  private readonly fixtureScriptPath: string;
  private readonly nodeExecutablePath: string;
  private readonly commandRunner: CommandRunner;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;

  public constructor(deps: ClaudeCodeFixtureAdapterDeps) {
    this.fixtureScriptPath = deps.fixtureScriptPath;
    this.nodeExecutablePath = deps.nodeExecutablePath ?? process.execPath;
    this.commandRunner = deps.commandRunner;
    this.environment = deps.environment ?? process.env;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async planLaunch(input: AgentNodeLaunchInput): Promise<AgentNodeLaunchPlan> {
    if (input.task.trim().length === 0) {
      throw new AgentAdapterUnavailableError("The agent objective is empty.", this.id);
    }
    // The prompt (carrying the node objective, including the #fixture directive) flows on stdin only,
    // and it mirrors the real adapter's protocol: the managed evidence path is given LITERALLY as a
    // JSON-encoded string, not only by environment variable name, so a fixture that refuses to read
    // the variable still finds it. A change that drops the literal path from the real prompt breaks
    // the fixture here instead of failing later against the real CLI.
    const prompt = [
      input.task,
      "",
      "Compazio requires a managed evidence file for this node.",
      "Write your final structured result as JSON to the exact absolute path below, given here as a",
      "JSON-encoded string — decode it and use that value verbatim:",
      JSON.stringify(input.outputPath),
      "",
      `This is the same path referenced by the ${RESULT_PATH_ENV} environment variable.`,
      "Use the literal path directly. Do not run a shell command to resolve the environment variable.",
      ""
    ].join("\n");
    return {
      executable: { path: this.nodeExecutablePath, kind: "native" },
      // The fixture SCRIPT path is a controlled argument; the prompt itself is never on argv.
      args: [this.fixtureScriptPath, "--print", "--permission-mode", "acceptEdits"],
      stdin: prompt,
      transport: "pipe",
      producesArtifact: true,
      artifactType: "claude-code-result",
      artifactFilename: "result.json",
      mediaType: "application/json",
      environment: { [RESULT_PATH_ENV]: input.outputPath },
      additionalAllowedEnvKeys: [RESULT_PATH_ENV],
      timeoutMs: this.timeoutMs
    };
  }

  public async detect(): Promise<AgentAdapterAvailability> {
    const result = await this.commandRunner.run({
      executable: { path: this.nodeExecutablePath, kind: "native" },
      args: [this.fixtureScriptPath, "--version"],
      cwd: process.cwd(),
      environment: createAllowedEnvironment(this.environment),
      timeoutMs: 5_000
    });
    const version = firstLine(result.stdout);
    if (result.exitCode !== 0 || version === null) {
      return {
        id: this.id,
        available: false,
        version: null,
        issue: {
          code: "adapter_detection_failed",
          message: "The Claude Code fixture did not report a version.",
          remediation: "Confirm the fixture path is correct."
        }
      };
    }
    return { id: this.id, available: true, version, issue: null };
  }
}

function firstLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}
