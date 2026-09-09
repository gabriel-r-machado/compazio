import type { TerminalAdapterId } from "@forgedeck/schemas";

export interface TerminalSessionAccess {
  readonly projectId: string;
  readonly adapterId: TerminalAdapterId;
  /** Canvas identity used to restore only the terminals that belong to the selected workspace. */
  readonly workspaceId?: string;
  readonly canvasNodeId?: string;
  /** Official worker metadata. Interactive canvas terminals leave this absent. */
  readonly workflow?: {
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
  };
  /** Pipe workers expose live logs but do not accept interactive input. */
  readonly readOnly?: boolean;
}

export class TerminalSessionAccessRegistry {
  private readonly sessions = new Map<string, TerminalSessionAccess>();

  public bind(sessionId: string, access: TerminalSessionAccess): void {
    this.sessions.set(sessionId, access);
  }

  public get(sessionId: string): TerminalSessionAccess | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public belongsToProject(sessionId: string, projectId: string): boolean {
    return this.sessions.get(sessionId)?.projectId === projectId;
  }
}
