import type { CommandRunner } from "@forgedeck/agent-sdk";
import { createAllowedEnvironment } from "@forgedeck/terminal";

import {
  AgentAdapterUnavailableError,
  type AgentAdapterAvailability,
  type AgentNodeAdapter
} from "./agent-adapter-registry";
import { OPENCODE_ADAPTER_ID } from "./opencode-agent-adapter";
import type { AgentNodeLaunchInput, AgentNodeLaunchPlan } from "./process-agent-node-executor";

const RESULT_PATH_ENV = "COMPAZIO_RESULT_PATH" as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CONTEXT_BYTES = 16_384;

/**
 * Test/e2e double for the OpenCode adapter, registered under the same `opencode` id. It runs the
 * deterministic fixture over the SAME pipe transport the real adapter uses and builds the SAME
 * argument shape: `run`, `--format json`, `--dir`, with NO positional message and the prompt on
 * stdin. The fixture rejects any other shape — including a positional prompt or the dangerous
 * permission bypass — so a change that breaks the real contract cannot quietly pass here.
 *
 * It is NEVER wired into production `index.ts`: the pipe transport needs a native executable and Node
 * is that binary here, whereas the real adapter resolves OpenCode's own native binary.
 */
export class OpenCodeFixtureAdapter implements AgentNodeAdapter {
  public readonly id = OPENCODE_ADAPTER_ID;
  private readonly fixtureScriptPath: string;
  private readonly nodeExecutablePath: string;
  private readonly commandRunner: CommandRunner;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;

  public constructor(deps: {
    readonly fixtureScriptPath: string;
    readonly nodeExecutablePath?: string;
    readonly commandRunner: CommandRunner;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
  }) {
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
    const lines = [input.task];
    // Upstream work is described exactly as the real adapter describes it — by path and hash, never
    // by content — so a cross-agent handoff is exercised through Compazio's own artifacts.
    if (input.inputs.length > 0) {
      let description = "";
      for (const upstream of input.inputs) {
        const line = `- ${upstream.nodeId}: ${upstream.path} (sha256 ${upstream.sha256}, ${upstream.mediaType})\n`;
        if (description.length + line.length > MAX_PROMPT_CONTEXT_BYTES) break;
        description += line;
      }
      lines.push(
        "",
        "Upstream context (official artifacts you may read by path):",
        description.trimEnd()
      );
    }
    return {
      executable: { path: this.nodeExecutablePath, kind: "native" },
      // The fixture SCRIPT path is a controlled argument; the prompt itself is never on argv.
      args: [this.fixtureScriptPath, "run", "--format", "json", "--dir", input.cwd],
      stdin: `${lines.join("\n")}\n`,
      transport: "pipe",
      producesArtifact: true,
      artifactType: "opencode-result",
      artifactFilename: "result.txt",
      mediaType: "text/plain",
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
          message: "The OpenCode fixture did not report a version.",
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
