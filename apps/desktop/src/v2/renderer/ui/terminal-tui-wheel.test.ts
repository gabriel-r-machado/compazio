import { describe, expect, it } from "vitest";

import { terminalTuiWheelPlan } from "./terminal-tui-wheel";

describe("terminalTuiWheelPlan", () => {
  it("keeps Claude on standard page navigation", () => {
    expect(
      terminalTuiWheelPlan({
        agentId: "claude-code",
        deltaY: -120,
        codexTranscriptActive: false
      })
    ).toEqual({ kind: "keys", data: "\u001b[5~", codexTranscriptActive: false });
  });

  it("uses OpenCode's documented message page keys", () => {
    expect(
      terminalTuiWheelPlan({ agentId: "opencode", deltaY: -120, codexTranscriptActive: false })
    ).toEqual({ kind: "keys", data: "\u001b[5~", codexTranscriptActive: false });
  });

  it("opens the Codex transcript on the first upward wheel gesture", () => {
    expect(
      terminalTuiWheelPlan({ agentId: "codex", deltaY: -120, codexTranscriptActive: false })
    ).toEqual({ kind: "keys", data: "\u0014", codexTranscriptActive: true });
  });

  it("pages both directions inside the open Codex transcript", () => {
    expect(
      terminalTuiWheelPlan({ agentId: "codex", deltaY: -120, codexTranscriptActive: true })
    ).toEqual({ kind: "keys", data: "\u001b[5~", codexTranscriptActive: true });
    expect(
      terminalTuiWheelPlan({ agentId: "codex", deltaY: 120, codexTranscriptActive: true })
    ).toEqual({ kind: "keys", data: "\u001b[6~", codexTranscriptActive: true });
  });

  it("does not open the Codex transcript on a downward gesture at the composer", () => {
    expect(
      terminalTuiWheelPlan({ agentId: "codex", deltaY: 120, codexTranscriptActive: false })
    ).toEqual({ kind: "none", codexTranscriptActive: false });
  });

  it("leaves ordinary terminals on native xterm scrollback", () => {
    expect(
      terminalTuiWheelPlan({ agentId: "shell", deltaY: -120, codexTranscriptActive: false })
    ).toEqual({ kind: "native", codexTranscriptActive: false });
  });
});
