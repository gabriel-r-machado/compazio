import { describe, expect, it } from "vitest";

import {
  MENTION_TRIGGER,
  composeTerminalPrompt,
  composerBlockedKey,
  composerMentionsFor,
  type ComposerMention
} from "./prompt-composition";

function node(id: string, title: string, type?: string) {
  return { id, type, data: { title } };
}

function edge(source: string, target: string) {
  return { source, target };
}

describe("composer mentions", () => {
  it("offers direct neighbours in both directions and classifies them", () => {
    const mentions = composerMentionsFor(
      "agent-1",
      [
        node("agent-1", "Implementador", "agent"),
        node("note-1", "Briefing", "note"),
        node("agent-2", "Revisor", "terminal"),
        node("file-1", "spec.md", "file")
      ],
      [edge("note-1", "agent-1"), edge("agent-1", "agent-2"), edge("file-1", "agent-1")]
    );

    expect(mentions).toEqual([
      { nodeId: "note-1", label: "Briefing", kind: "note" },
      { nodeId: "agent-2", label: "Revisor", kind: "agent" },
      { nodeId: "file-1", label: "spec.md", kind: "material" }
    ]);
  });

  it("leaves out nodes that are not connected to this terminal", () => {
    const mentions = composerMentionsFor(
      "agent-1",
      [node("agent-1", "Implementador", "agent"), node("note-1", "Nota solta", "note")],
      []
    );

    expect(mentions).toEqual([]);
  });

  it("skips decoration and untitled nodes, which name nothing an agent can read", () => {
    const mentions = composerMentionsFor(
      "agent-1",
      [
        node("shape-1", "Retângulo", "shape"),
        node("frame-1", "Grupo", "frame"),
        node("drawing-1", "Rascunho", "drawing"),
        node("note-1", "   ", "note")
      ],
      [
        edge("agent-1", "shape-1"),
        edge("agent-1", "frame-1"),
        edge("agent-1", "drawing-1"),
        edge("agent-1", "note-1")
      ]
    );

    expect(mentions).toEqual([]);
  });

  it("keeps one mention per label, because an ambiguous @ cannot be resolved", () => {
    const mentions = composerMentionsFor(
      "agent-1",
      [node("note-1", "Briefing", "note"), node("note-2", "Briefing", "note")],
      [edge("note-1", "agent-1"), edge("note-2", "agent-1")]
    );

    expect(mentions).toEqual([{ nodeId: "note-1", label: "Briefing", kind: "note" }]);
  });
});

describe("mention trigger", () => {
  it("captures a query that spans spaces, so multi-word titles stay reachable", () => {
    expect(MENTION_TRIGGER.exec("Peça ao @Revisor de")?.[1]).toBe("Revisor de");
  });

  it("captures an empty query the moment @ is typed", () => {
    expect(MENTION_TRIGGER.exec("Aplique o @")?.[1]).toBe("");
  });

  it("does not reach back past a newline or a later @", () => {
    expect(MENTION_TRIGGER.exec("Use o @Briefing\nAgora corrija")).toBeNull();
    expect(MENTION_TRIGGER.exec("@Briefing e @Rev")?.[1]).toBe("Rev");
  });

  it("finds nothing in a draft without a mention", () => {
    expect(MENTION_TRIGGER.exec("Corrija o login.")).toBeNull();
  });
});

describe("composer blocking", () => {
  it("blocks a shell, whose prompt would read the instruction as a command", () => {
    expect(composerBlockedKey("shell", true)).toBe("composer.shellBlocked");
    expect(composerBlockedKey(undefined, true)).toBe("composer.shellBlocked");
  });

  it("blocks an agent terminal that has no live session yet", () => {
    expect(composerBlockedKey("claude-code", false)).toBe("composer.inactiveBlocked");
  });

  it("allows a running agent terminal", () => {
    expect(composerBlockedKey("claude-code", true)).toBeNull();
  });
});

describe("composed prompt", () => {
  const mentions: readonly ComposerMention[] = [
    { nodeId: "note-1", label: "Briefing", kind: "note" },
    { nodeId: "agent-2", label: "Revisor de código", kind: "agent" }
  ];

  it("refuses an empty draft instead of writing a bare newline into a session", () => {
    expect(composeTerminalPrompt("", mentions, "Implementador")).toBeNull();
    expect(composeTerminalPrompt("   \n  ", mentions, "Implementador")).toBeNull();
  });

  it("sends the text alone when nothing was mentioned", () => {
    expect(composeTerminalPrompt("  Corrija o login.  ", mentions, "Implementador")).toBe(
      "Corrija o login."
    );
  });

  it("lists only the mentions the draft actually names, including multi-word titles", () => {
    const prompt = composeTerminalPrompt(
      "Aplique o @Briefing e peça revisão ao @Revisor de código.",
      mentions,
      "Implementador"
    );

    expect(prompt).toContain("- Briefing (nota)");
    expect(prompt).toContain("- Revisor de código (agente)");
  });

  it("omits a mention that exists but was not typed", () => {
    const prompt = composeTerminalPrompt("Aplique o @Briefing.", mentions, "Implementador");

    expect(prompt).toContain("- Briefing (nota)");
    expect(prompt).not.toContain("Revisor de código");
  });

  it("names the command that resolves the references, quoting the terminal's own title", () => {
    const prompt = composeTerminalPrompt("Use o @Briefing.", mentions, 'Implementador "principal"');

    expect(prompt).toContain('compazio context "Implementador principal"');
  });
});
