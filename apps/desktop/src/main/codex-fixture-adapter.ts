import type { CommandRunner } from "@forgedeck/agent-sdk";
import { createAllowedEnvironment } from "@forgedeck/terminal";

import {
  AgentAdapterUnavailableError,
  type AgentAdapterAvailability,
  type AgentNodeAdapter
} from "./agent-adapter-registry";
import { CODEX_ADAPTER_ID } from "./codex-agent-adapter";
import type { AgentNodeLaunchInput, AgentNodeLaunchPlan } from "./process-agent-node-executor";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CONTEXT_BYTES = 16_384;

/**
 * Test/e2e double for the Codex adapter, registered under the same `codex` id. It runs the
 * deterministic fixture over the SAME pipe transport the real adapter uses, and — importantly — builds
 * the SAME argument shape: `exec`, the sandbox flag, `--cd`, and `--output-last-message` pointing at
 * the managed staging path, with the prompt on stdin and never in argv. The fixture rejects any other
 * shape, so a change that breaks the real contract cannot quietly pass here.
 *
 * It is NEVER wired into production `index.ts`: the pipe transport needs a native executable, and Node
 * is that binary here, whereas the real adapter resolves Codex's own vendored binary. The real
 * executable resolution is covered by the adapter's unit tests and the opt-in local check.
 */
export class CodexFixtureAdapter implements AgentNodeAdapter {
  public readonly id = CODEX_ADAPTER_ID;
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
    // The upstream context is described exactly as the real adapter describes it — by path and hash,
    // never by content — so a cross-agent handoff is exercised through Compazio's own artifacts.
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
      args: [
        this.fixtureScriptPath,
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--sandbox",
        input.node.permissions.workspace_write === true ? "workspace-write" : "read-only",
        "--cd",
        input.cwd,
        "--output-last-message",
        input.outputPath
      ],
      stdin: `${lines.join("\n")}\n`,
      transport: "pipe",
      producesArtifact: true,
      artifactType: "codex-result",
      artifactFilename: "result.txt",
      mediaType: "text/plain",
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
          message: "The Codex fixture did not report a version.",
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
