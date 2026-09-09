import type {
  AdapterTerminalOutputSnapshot,
  AgentManifest,
  LaunchInput,
  LaunchSpec
} from "@forgedeck/agent-sdk";

import { BaseAgentAdapter, interactiveCliHandoffStrategy, launchSpec } from "./base-adapter";

/**
 * Adapter for the OpenCode CLI (`opencode`). Only the interactive TUI is supported: running
 * `opencode` inside the workspace opens its terminal UI. Detection and version reporting come from
 * the shared {@link BaseAgentAdapter.detect} `--version` probe, so an absent binary yields an
 * actionable "install it" issue instead of a silent failure.
 */
export class OpenCodeAdapter extends BaseAgentAdapter {
  protected readonly reviewedHandoffStrategy = interactiveCliHandoffStrategy((text) =>
    isOpenCodePromptReady(cleanTerminalText(text))
  );

  public readonly manifest: AgentManifest = {
    id: "opencode",
    displayName: "OpenCode",
    version: "1",
    executables: ["opencode"],
    platforms: ["win32", "darwin", "linux"],
    capabilities: {
      interactive: true,
      nonInteractive: false,
      resume: false,
      structuredOutput: false,
      mcp: true,
      imageInput: false,
      messageQueue: true
    },
    permissions: ["workspace-process"]
  };

  public override isReadyForReviewedHandoff(snapshot: AdapterTerminalOutputSnapshot): boolean {
    return isOpenCodePromptReady(cleanTerminalText(snapshot.data));
  }

  public async buildLaunch(input: LaunchInput): Promise<LaunchSpec> {
    if (input.mode !== "interactive") {
      throw new Error("The OpenCode adapter only supports interactive sessions");
    }
    // A Compazio terminal is a fresh canvas process. Replaying a previous OpenCode session can
    // render stale prompts and file paths from another workspace, then make an automated handoff
    // appear to target the wrong project after resize. Keep the TUI interactive while starting
    // with a clean visible transcript.
    return launchSpec(input, ["--no-replay"], input.initialMessage?.content);
  }
}

function cleanTerminalText(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "").replace(/\r/g, "");
}

function isOpenCodePromptReady(value: string): boolean {
  return /(?:^|\n)\s*(?:❯|›|>)\s*$/m.test(value);
}
