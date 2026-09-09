import { describe, expect, it } from "vitest";

import { isTerminalBackedNode } from "./node-terminal";

describe("canvas terminal nodes", () => {
  it("keeps agent terminals behind a declared adapter only", () => {
    expect(isTerminalBackedNode("terminal", undefined)).toBe(true);
    expect(isTerminalBackedNode("agent", "claude-code")).toBe(true);
    expect(isTerminalBackedNode("agent", "codex")).toBe(true);
    expect(isTerminalBackedNode("agent", undefined)).toBe(false);
    expect(isTerminalBackedNode("task", "shell")).toBe(false);
  });
});
