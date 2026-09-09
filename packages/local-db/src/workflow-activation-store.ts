import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

/**
 * Durable association between an approved draft, its materialized official workflow definition, and
 * the single run created for it. It is the idempotency ledger for approval: the unique
 * `(draft_id, draft_version)` key guarantees that a double click, a repeated IPC call, a request
 * retry, or a reload during approval can create at most one run. It never executes anything — the
 * WorkflowRunRuntime remains the sole authority for the run, attempts, scheduling and recovery.
 */
export type WorkflowActivationStatus = "materialized" | "started" | "failed";

export interface WorkflowActivationRecord {
  readonly activationId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly definitionSha256: string;
  readonly runId: string | null;
  readonly status: WorkflowActivationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkflowActivationInput {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly definitionSha256: string;
}

interface ActivationRow {
  readonly id: string;
  readonly draft_id: string;
  readonly draft_version: number;
  readonly workspace_id: string;
  readonly workflow_id: string;
  readonly definition_sha256: string;
  readonly run_id: string | null;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export class SqliteWorkflowActivationStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  /**
   * Records the intent to materialize a draft. If an activation already exists for the same
   * `(draftId, draftVersion)` it is returned unchanged, so materialization is idempotent even before a
   * run exists. A returned record with a non-null `runId` means a run was already created.
   */
  public ensureIntent(input: CreateWorkflowActivationInput): WorkflowActivationRecord {
    this.requireWorkspace(input.workspaceId);
    const existing = this.getByDraft(input.draftId, input.draftVersion);
    if (existing !== null) {
      return existing;
    }
    const timestamp = this.now().getTime();
    const id = this.createId();
    this.sqlite
      .prepare(
        `INSERT INTO workflow_activations
           (id, draft_id, draft_version, workspace_id, workflow_id, definition_sha256, run_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'materialized', ?, ?)
         ON CONFLICT(draft_id, draft_version) DO NOTHING`
      )
      .run(
        id,
        input.draftId,
        input.draftVersion,
        input.workspaceId,
        input.workflowId,
        input.definitionSha256,
        timestamp,
        timestamp
      );
    const record = this.getByDraft(input.draftId, input.draftVersion);
    if (record === null) throw new Error("Workflow activation intent was not persisted");
    return record;
  }

  /**
   * Attaches the single created run to an activation. It only ever sets the run once: if the
   * activation already carries a different run id it throws, so a race can never bind two runs.
   */
  public attachRun(activationId: string, runId: string): WorkflowActivationRecord {
    const current = this.getById(activationId);
    if (current === null) throw new Error("Workflow activation was not found");
    if (current.runId !== null && current.runId !== runId) {
      throw new Error("Workflow activation already has a different run");
    }
    this.sqlite
      .prepare(
        `UPDATE workflow_activations SET run_id = ?, status = 'started', updated_at = ? WHERE id = ?`
      )
      .run(runId, this.now().getTime(), activationId);
    const updated = this.getById(activationId);
    if (updated === null) throw new Error("Workflow activation was not found after attach");
    return updated;
  }

  public markFailed(activationId: string): void {
    this.sqlite
      .prepare(
        `UPDATE workflow_activations SET status = 'failed', updated_at = ? WHERE id = ? AND run_id IS NULL`
      )
      .run(this.now().getTime(), activationId);
  }

  public getById(activationId: string): WorkflowActivationRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM workflow_activations WHERE id = ?")
      .get(activationId) as ActivationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  public getByDraft(draftId: string, draftVersion: number): WorkflowActivationRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM workflow_activations WHERE draft_id = ? AND draft_version = ?")
      .get(draftId, draftVersion) as ActivationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** The latest activation that produced a run for a workspace; used to reconcile after reload. */
  public getLatestStartedForWorkspace(workspaceId: string): WorkflowActivationRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM workflow_activations
         WHERE workspace_id = ? AND run_id IS NOT NULL
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(workspaceId) as ActivationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  public close(): void {
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): void {
    const row = this.sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (row === undefined) throw new Error("Workflow activation workspace was not found");
  }
}

function toRecord(row: ActivationRow): WorkflowActivationRecord {
  return {
    activationId: row.id,
    draftId: row.draft_id,
    draftVersion: row.draft_version,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    definitionSha256: row.definition_sha256,
    runId: row.run_id,
    status: toStatus(row.status),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toStatus(value: string): WorkflowActivationStatus {
  return value === "started" || value === "failed" ? value : "materialized";
}
