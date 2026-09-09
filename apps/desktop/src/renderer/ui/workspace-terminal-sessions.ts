import type { TerminalSession } from "@forgedeck/schemas";

export interface WorkspaceTerminalSessions {
  readonly sessions: Readonly<Record<string, TerminalSession>>;
  readonly nodeSessionIds: Readonly<Record<string, string>>;
}

/** Projects process sessions onto exactly one persisted workspace and its currently visible nodes. */
export function projectWorkspaceTerminalSessions(
  sessions: readonly TerminalSession[],
  workspaceId: string,
  visibleNodeIds: ReadonlySet<string>
): WorkspaceTerminalSessions {
  const current = sessions.filter(
    (session): session is TerminalSession & { readonly canvasNodeId: string } =>
      session.workspaceId === workspaceId &&
      session.canvasNodeId !== undefined &&
      visibleNodeIds.has(session.canvasNodeId)
  );
  return {
    sessions: Object.fromEntries(current.map((session) => [session.id, session])),
    nodeSessionIds: Object.fromEntries(current.map((session) => [session.canvasNodeId, session.id]))
  };
}
