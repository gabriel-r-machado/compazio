export type TerminalTuiWheelPlan =
  | {
      readonly kind: "keys";
      readonly data: string;
      readonly codexTranscriptActive: boolean;
    }
  | {
      readonly kind: "mouse" | "none" | "native";
      readonly codexTranscriptActive: boolean;
    };

const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

/**
 * Chooses how a hidden Windows ConPTY mouse mode is bridged for a coding-agent TUI.
 *
 * Claude and OpenCode expose standard page navigation in their current TUIs. Codex keeps its
 * conversation in a transcript pager: the first upward gesture opens it with Ctrl+T and later
 * gestures page inside it. Escape or q remain the native way to return to the composer.
 */
export function terminalTuiWheelPlan(input: {
  readonly agentId: string;
  readonly deltaY: number;
  readonly codexTranscriptActive: boolean;
}): TerminalTuiWheelPlan {
  if (input.deltaY === 0)
    return { kind: "none", codexTranscriptActive: input.codexTranscriptActive };

  if (input.agentId === "claude-code" || input.agentId === "opencode") {
    return {
      kind: "keys",
      data: input.deltaY < 0 ? PAGE_UP : PAGE_DOWN,
      codexTranscriptActive: input.codexTranscriptActive
    };
  }

  if (input.agentId === "codex") {
    if (!input.codexTranscriptActive) {
      if (input.deltaY > 0) return { kind: "none", codexTranscriptActive: false };
      return { kind: "keys", data: "\u0014", codexTranscriptActive: true };
    }
    return {
      kind: "keys",
      data: input.deltaY < 0 ? PAGE_UP : PAGE_DOWN,
      codexTranscriptActive: true
    };
  }

  return { kind: "native", codexTranscriptActive: input.codexTranscriptActive };
}
