import type {
  AdapterContext,
  AdapterTerminalOutputSnapshot,
  AgentManifest,
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

export class CodexAdapter extends BaseAgentAdapter {
  protected readonly reviewedHandoffStrategy = interactiveCliHandoffStrategy((text) =>
    /(?:^|\n)\s*(?:›|>)\s*$/m.test(text)
  );

  public readonly manifest: AgentManifest = {
    id: "codex",
    displayName: "Codex CLI",
    version: "1",
    executables: ["codex"],
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
    return isCodexPromptReady(cleanTerminalText(snapshot.data));
  }

  public override async validateAuth(
    context: AdapterContext,
    executable: DetectedExecutable
  ): Promise<AuthResult> {
    const result = await context.commandRunner.run({
      executable,
      args: ["login", "status"],
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
        message: "Codex CLI is installed but is not authenticated",
        remediation: "Run `codex login` in a trusted terminal."
      }
    };
  }

  public async buildLaunch(input: LaunchInput): Promise<LaunchSpec> {
    validateSessionId(input.resumeSessionId);
    if (input.mode === "interactive") {
      const args = ["-c", "check_for_update_on_startup=false"];
      if (input.resumeSessionId !== undefined) {
        args.push("resume", input.resumeSessionId);
      }
      return launchSpec(input, args, input.initialMessage?.content);
    }
    const args = ["exec", "--json", "--sandbox", input.workspaceAccess];
    if (input.resumeSessionId !== undefined) {
      args.push("resume", input.resumeSessionId);
    }
    args.push("-");
    return launchSpec(input, args, input.initialMessage?.content);
  }

  public override parseOutput = parseJsonLines;
}

function validateSessionId(value: string | undefined): void {
  if (value !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("Codex session id contains unsupported characters");
  }
}

function cleanTerminalText(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "").replace(/\r/g, "");
}

function isCodexPromptReady(value: string): boolean {
  return /(?:^|\n)\s*(?:\u203a|>|(?:gpt|o|codex)-[a-z0-9._-]+(?:\s+[a-z][a-z0-9._-]*){0,4}\s+·\s+(?:~|[A-Za-z]:[\\/]|\/).*)\s*$/im.test(
    value
  );
}
