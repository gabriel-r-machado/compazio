import Database from "better-sqlite3";

export interface WorkflowRunTarget {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly agentNodeId: string | null;
  /** Opaque ID only. The managed worktree path is never returned from this store. */
  readonly worktreeId: string | null;
  readonly createdAt: string;
}

interface TargetRow {
  readonly run_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly agent_node_id: string | null;
  readonly worktree_id: string | null;
  readonly created_at: number;
}

/** Immutable opaque binding between a run and its approved workspace/project. */
export class SqliteWorkflowRunTargetStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public bind(input: Omit<WorkflowRunTarget, "createdAt">): WorkflowRunTarget {
    validateIdentifier(input.runId, "Workflow run id");
    validateIdentifier(input.workspaceId, "Workflow workspace id");
    validateIdentifier(input.projectId, "Workflow project id");
    if (input.agentNodeId !== null) validateIdentifier(input.agentNodeId, "Workflow agent id");
    if (input.worktreeId !== null) validateIdentifier(input.worktreeId, "Workflow worktree id");
    const existing = this.get(input.runId);
    if (existing !== null) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.projectId !== input.projectId ||
        existing.agentNodeId !== input.agentNodeId ||
        existing.worktreeId !== input.worktreeId
      ) {
        throw new Error("Workflow run target is immutable");
      }
      return existing;
    }
    const target: WorkflowRunTarget = { ...input, createdAt: this.now().toISOString() };
    this.sqlite
      .prepare(
        `INSERT INTO workflow_run_targets
           (run_id, workspace_id, project_id, agent_node_id, worktree_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        target.runId,
        target.workspaceId,
        target.projectId,
        target.agentNodeId,
        target.worktreeId,
        Date.parse(target.createdAt)
      );
    return target;
  }

  public get(runId: string): WorkflowRunTarget | null {
    const row = this.sqlite
      .prepare(
        `SELECT run_id, workspace_id, project_id, agent_node_id, worktree_id, created_at
         FROM workflow_run_targets WHERE run_id = ?`
      )
      .get(runId) as TargetRow | undefined;
    return row === undefined
      ? null
      : {
          runId: row.run_id,
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          agentNodeId: row.agent_node_id,
          worktreeId: row.worktree_id,
          createdAt: new Date(row.created_at).toISOString()
        };
  }

  public close(): void {
    this.sqlite.close();
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
}
