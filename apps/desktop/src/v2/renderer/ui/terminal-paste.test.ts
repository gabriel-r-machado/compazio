import { describe, expect, it } from "vitest";

import { forcedAgentPasteFrame } from "./terminal-paste";

describe("forcedAgentPasteFrame", () => {
  it("keeps a long Windows agent prompt in one complete bracketed-paste frame", () => {
    const lines = [
      "BEGIN_PROMPT_SENTINEL",
      ...Array.from(
        { length: 400 },
        (_, index) => `instruction-${index.toString().padStart(3, "0")}`
      ),
      "END_PROMPT_SENTINEL"
    ];
    const frame = forcedAgentPasteFrame({
      text: lines.join("\r\n"),
      agentId: "claude-code",
      windowsConpty: true,
      bracketedPasteMode: false
    });

    expect(frame).not.toBeNull();
    expect(frame).toHaveLength(lines.join("\r").length + 12);
    expect(frame).toBe(`\u001b[200~${lines.join("\r")}\u001b[201~`);
    expect(frame?.split("\u001b[200~")).toHaveLength(2);
    expect(frame?.split("\u001b[201~")).toHaveLength(2);
  });

  it("leaves normal xterm paste ownership unchanged outside the hidden ConPTY mode", () => {
    const common = { text: "line 1\nline 2", bracketedPasteMode: false };
    expect(forcedAgentPasteFrame({ ...common, agentId: "shell", windowsConpty: true })).toBeNull();
    expect(
      forcedAgentPasteFrame({ ...common, agentId: "claude-code", windowsConpty: false })
    ).toBeNull();
    expect(
      forcedAgentPasteFrame({
        ...common,
        agentId: "claude-code",
        windowsConpty: true,
        bracketedPasteMode: true
      })
    ).toBeNull();
  });

  it("can force the prompt-composer frame even after xterm observed bracketed paste", () => {
    expect(
      forcedAgentPasteFrame({
        text: "line 1\nline 2",
        agentId: "codex",
        windowsConpty: true,
        bracketedPasteMode: false
      })
    ).toBe("\u001b[200~line 1\rline 2\u001b[201~");
  });
});
