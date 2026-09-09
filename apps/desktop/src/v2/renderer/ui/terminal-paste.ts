const codingAgentIds = new Set(["claude-code", "codex", "opencode"]);

/**
 * Windows ConPTY consumes some DEC private-mode output before xterm can observe it. Coding-agent
 * TUIs can therefore enable bracketed paste while `Terminal.modes.bracketedPasteMode` remains
 * false. In that narrow case we frame the clipboard payload ourselves, matching xterm's newline
 * normalization and keeping the complete multiline prompt as one editor operation.
 */
export function forcedAgentPasteFrame(input: {
  readonly text: string;
  readonly agentId: string;
  readonly windowsConpty: boolean;
  readonly bracketedPasteMode: boolean;
}): string | null {
  if (
    input.text.length === 0 ||
    !input.windowsConpty ||
    input.bracketedPasteMode ||
    !codingAgentIds.has(input.agentId)
  )
    return null;
  const normalized = input.text.replace(/\r?\n/g, "\r");
  return `\u001b[200~${normalized}\u001b[201~`;
}
