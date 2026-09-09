import type {
  AdapterContext,
  AgentManifest,
  DetectionResult,
  LaunchInput,
  LaunchSpec
} from "@forgedeck/agent-sdk";

import { BaseAgentAdapter, launchSpec, shellHandoffStrategy } from "./base-adapter";

export class ShellAdapter extends BaseAgentAdapter {
  protected readonly reviewedHandoffStrategy = shellHandoffStrategy();

  public readonly manifest: AgentManifest = {
    id: "shell",
    displayName: "Local Shell",
    version: "1",
    executables: shellCandidates(),
    platforms: ["win32", "darwin", "linux"],
    capabilities: {
      interactive: true,
      nonInteractive: false,
      resume: false,
      structuredOutput: false,
      mcp: false,
      imageInput: false,
      messageQueue: true
    },
    permissions: ["workspace-process"]
  };

  public override async detect(context: AdapterContext): Promise<DetectionResult> {
    const executable = await context.detector.find(this.manifest.executables, context);
    if (executable === null) {
      return {
        available: false,
        executable: null,
        version: null,
        issue: {
          code: "adapter_executable_not_found",
          message: "No supported local shell was found",
          remediation: "Install PowerShell, cmd.exe, or a POSIX-compatible /bin/sh."
        }
      };
    }
    return { available: true, executable, version: null, issue: null };
  }

  public async buildLaunch(input: LaunchInput): Promise<LaunchSpec> {
    if (input.mode !== "interactive") {
      throw new Error("The shell adapter only supports interactive sessions");
    }
    return launchSpec(input, []);
  }
}

function shellCandidates(): string[] {
  if (process.platform === "win32") {
    return ["powershell.exe", "pwsh.exe", "cmd.exe"];
  }
  return process.env.SHELL === undefined ? ["/bin/sh"] : [process.env.SHELL, "/bin/sh"];
}
