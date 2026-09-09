import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  AdapterContext,
  AdapterTerminalOutputSnapshot,
  AgentManifest,
  AgentMessage,
  AuthResult,
  DetectedExecutable,
  LaunchInput,
  LaunchSpec
} from "@forgedeck/agent-sdk";

import {
  BaseAgentAdapter,
  compactEnvironment,
  interactiveCliHandoffStrategy,
  launchSpec,
  parseJsonLines
} from "./base-adapter";

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  protected readonly reviewedHandoffStrategy = interactiveCliHandoffStrategy((text) =>
    /(?:^|\n)\s*(?:❯|>)\s*$/m.test(text)
  );

  public readonly manifest: AgentManifest = {
    id: "claude-code",
    displayName: "Claude Code",
    version: "1",
    executables: ["claude"],
    platforms: ["win32", "darwin", "linux"],
    capabilities: {
      interactive: true,
      nonInteractive: true,
      resume: true,
      structuredOutput: true,
      mcp: true,
      imageInput: true,
      messageQueue: true
    },
    permissions: ["workspace-process"]
  };

  public override isReadyForReviewedHandoff(snapshot: AdapterTerminalOutputSnapshot): boolean {
    return /(?:^|\n)\s*(?:\u276f|>)\s*$/m.test(cleanTerminalText(snapshot.data));
  }

  public override async detect(context: AdapterContext) {
    const pathDetection = await super.detect(context);
    if (pathDetection.available || context.platform !== "win32") {
      return pathDetection;
    }

    const executable = await findVsCodeClaudeExecutable(context);
    if (executable === null) {
      return pathDetection;
    }
    const versionResult = await context.commandRunner.run({
      executable,
      args: ["--version"],
      cwd: context.cwd,
      environment: compactEnvironment(context.environment),
      timeoutMs: 5_000
    });
    const version = firstLine(versionResult.stdout) ?? firstLine(versionResult.stderr);
    if (versionResult.exitCode !== 0 || version === null) {
      return pathDetection;
    }
    return { available: true, executable, version, issue: null };
  }

  public override async validateAuth(
    context: AdapterContext,
    executable: DetectedExecutable
  ): Promise<AuthResult> {
    const result = await context.commandRunner.run({
      executable,
      args: ["auth", "status", "--json"],
      cwd: context.cwd,
      environment: compactEnvironment(context.environment),
      timeoutMs: 5_000
    });
    if (result.exitCode === 0) {
      return { authenticated: true, issue: null };
    }
    return {
      authenticated: false,
      issue: {
        code: "adapter_auth_unavailable",
        message: "Claude Code is installed but is not authenticated",
        remediation: "Run `claude auth login` in a trusted terminal."
      }
    };
  }

  public async buildLaunch(input: LaunchInput): Promise<LaunchSpec> {
    validateSessionId(input.resumeSessionId);
    if (input.mode === "interactive") {
      const args = [
        "--disable-slash-commands",
        ...(input.resumeSessionId === undefined ? [] : ["--resume", input.resumeSessionId])
      ];
      return launchSpec(input, args, input.initialMessage?.content);
    }
    const args = [
      "--disable-slash-commands",
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose"
    ];
    if (input.resumeSessionId !== undefined) {
      args.push("--resume", input.resumeSessionId);
    }
    return launchSpec(
      input,
      args,
      input.initialMessage === undefined ? undefined : this.encodeMessage(input.initialMessage)
    );
  }

  public override parseOutput = parseJsonLines;

  public override encodeMessage(message: AgentMessage): string {
    return `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: message.content }] }
    })}\n`;
  }
}

async function findVsCodeClaudeExecutable(
  context: AdapterContext
): Promise<DetectedExecutable | null> {
  const userProfile = environmentValue(context.environment, "USERPROFILE");
  if (userProfile === undefined) {
    return null;
  }

  for (const editorDirectory of [".vscode", ".vscode-insiders"]) {
    const extensionsDirectory = join(userProfile, editorDirectory, "extensions");
    let entries: Dirent[];
    try {
      entries = await readdir(extensionsDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    const extensionDirectories = entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.toLowerCase().startsWith("anthropic.claude-code-")
      )
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    for (const extension of extensionDirectories) {
      const executable = await context.detector.find(
        [join(extensionsDirectory, extension.name, "resources", "native-binary", "claude.exe")],
        context
      );
      if (executable !== null) {
        return executable;
      }
    }
  }
  return null;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  return Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
}

function firstLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function cleanTerminalText(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "").replace(/\r/g, "");
}

function validateSessionId(value: string | undefined): void {
  if (value !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("Claude session id contains unsupported characters");
  }
}
