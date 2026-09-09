import { describe, expect, it } from "vitest";

import type { TerminalSession } from "@forgedeck/schemas";

import { projectWorkspaceTerminalSessions } from "./workspace-terminal-sessions";

describe("projectWorkspaceTerminalSessions", () => {
  it("never attaches a terminal from another project canvas even when node ids collide", () => {
    const sessions = [
      session("session-a", "workspace-a", "agent-work"),
      session("session-b", "workspace-b", "agent-work"),
      session("deleted", "workspace-a", "removed-node")
    ];

    expect(
      projectWorkspaceTerminalSessions(sessions, "workspace-b", new Set(["agent-work"]))
    ).toEqual({
      sessions: { "session-b": sessions[1] },
      nodeSessionIds: { "agent-work": "session-b" }
    });
  });
});

function session(id: string, workspaceId: string, canvasNodeId: string): TerminalSession {
  return {
    id,
    adapterId: "codex",
    state: "running",
    startedAt: "2026-07-26T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    workspaceId,
    canvasNodeId,
    readOnly: false
  };
}
