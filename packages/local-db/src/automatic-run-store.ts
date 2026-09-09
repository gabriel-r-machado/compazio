import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

/**
 * Durable state of an automatic-mode session. It persists what a reload needs to resume the same session
 * without re-analyzing, re-materializing or re-running anything: the plan, the lineage of official runs,
 * the remediation cycle, the corrective delegations, the open failures and the final verdict.
 *
 * It executes nothing. The WorkflowRunRuntime remains the sole authority for runs, attempts, scheduling
 * and recovery; this store only remembers the automatic session that drives them.
 *
 * Two satellite tables serve purposes the official contracts deliberately do not:
 *
 * - `automatic_node_prompts` carries each node's full prompt for one run. The official workflow
 *   definition has no prompt field (its title is capped and its shape is strict), so the launch resolver
 *   reads the prompt from here at launch time. A remediation run gets its own corrected prompt, keyed by
 *   its own run id, so an earlier run's prompt is never rewritten.
 * - `automatic_approvals` records a human decision bound to a fingerprint of the exact action approved,
 *   so a decision is idempotent and can never be replayed for a different action.
 */
export type AutomaticRunStatus =
  "planning" | "awaiting_approval" | "running" | "completed" | "stopped" | "rejected";

export type AutomaticApprovalDecision = "pending" | "approved" | "rejected";

export interface AutomaticRunRecord {
  readonly automaticRunId: string;
  readonly workspaceId: string;
  readonly objective: string;
  readonly mode: string;
  readonly status: AutomaticRunStatus;
  readonly draftId: string;
  /** The current run of the lineage, or null before the first run exists. */
  readonly currentRunId: string | null;
  readonly remediationCycle: number;
  readonly stopReason: string | null;
  /** Short, sanitized description of the final result; never raw terminal output. */
  readonly result: string | null;
  /** The serialized coordinator state; opaque to this store. */
  readonly state: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAutomaticRunInput {
  readonly workspaceId: string;
  readonly objective: string;
  readonly mode: string;
  readonly draftId: string;
  readonly state: unknown;
}

export interface SaveAutomaticRunInput {
  readonly automaticRunId: string;
  readonly status: AutomaticRunStatus;
  readonly currentRunId?: string | null;
  readonly remediationCycle: number;
  readonly stopReason?: string | null;
  readonly result?: string | null;
  readonly state: unknown;
}

export interface AutomaticNodePrompt {
  readonly runId: string;
  readonly nodeId: string;
  readonly cycle: number;
  readonly prompt: string;
}

export interface AutomaticApprovalRecord {
  readonly approvalId: string;
  readonly automaticRunId: string;
  readonly nodeId: string;
  readonly actionFingerprint: string;
  readonly decision: AutomaticApprovalDecision;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

interface AutomaticRunRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly mode: string;
  readonly status: string;
  readonly draft_id: string;
  readonly current_run_id: string | null;
  readonly remediation_cycle: number;
  readonly stop_reason: string | null;
  readonly result: string | null;
  readonly state_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface PromptRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly cycle: number;
  readonly prompt: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly automatic_run_id: string;
  readonly node_id: string;
  readonly action_fingerprint: string;
  readonly decision: string;
  readonly created_at: number;
  readonly decided_at: number | null;
}

/**
 * Binds an approval to the exact action described, so approving one action never authorizes another.
 * Any change to the node, its prompt, its risk or the operation produces a different fingerprint.
 */
export function automaticApprovalFingerprint(input: {
  readonly nodeId: string;
  readonly prompt: string;
  readonly operationRisk: string;
  readonly operation: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([input.nodeId, input.prompt, input.operationRisk, input.operation]),
      "utf8"
    )
    .digest("hex");
}

export class SqliteAutomaticRunStore {
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

  public create(input: CreateAutomaticRunInput): AutomaticRunRecord {
    this.requireWorkspace(input.workspaceId);
    const timestamp = this.now().getTime();
    const id = this.createId();
    this.sqlite
      .prepare(
        `INSERT INTO automatic_runs
           (id, workspace_id, objective, mode, status, draft_id, current_run_id,
            remediation_cycle, stop_reason, result, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'planning', ?, NULL, 0, NULL, NULL, ?, ?, ?)`
      )
      .run(
        id,
        input.workspaceId,
        input.objective,
        input.mode,
        input.draftId,
        JSON.stringify(input.state),
        timestamp,
        timestamp
      );
    const record = this.get(id);
    if (record === null) throw new Error("Automatic run was not persisted");
    return record;
  }

  /** Replaces the mutable state of a session. The identity, workspace and objective never change. */
  public save(input: SaveAutomaticRunInput): AutomaticRunRecord {
    const current = this.get(input.automaticRunId);
    if (current === null) throw new Error("Automatic run was not found");
    this.sqlite
      .prepare(
        `UPDATE automatic_runs
            SET status = ?, current_run_id = ?, remediation_cycle = ?, stop_reason = ?,
                result = ?, state_json = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        input.status,
        input.currentRunId === undefined ? current.currentRunId : input.currentRunId,
        input.remediationCycle,
        input.stopReason ?? null,
        input.result ?? null,
        JSON.stringify(input.state),
        this.now().getTime(),
        input.automaticRunId
      );
    const updated = this.get(input.automaticRunId);
    if (updated === null) throw new Error("Automatic run was not found after save");
    return updated;
  }

  public get(automaticRunId: string): AutomaticRunRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM automatic_runs WHERE id = ?")
      .get(automaticRunId) as AutomaticRunRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  public list(
    input: { readonly workspaceId?: string; readonly limit?: number } = {}
  ): readonly AutomaticRunRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows =
      input.workspaceId === undefined
        ? (this.sqlite
            .prepare("SELECT * FROM automatic_runs ORDER BY updated_at DESC, id DESC LIMIT ?")
            .all(limit) as AutomaticRunRow[])
        : (this.sqlite
            .prepare(
              `SELECT * FROM automatic_runs WHERE workspace_id = ?
                ORDER BY updated_at DESC, id DESC LIMIT ?`
            )
            .all(input.workspaceId, limit) as AutomaticRunRow[]);
    return rows.map(toRecord);
  }

  /** Sessions that were mid-flight when the app stopped; the caller decides whether to resume each. */
  public listResumable(workspaceId?: string): readonly AutomaticRunRecord[] {
    return this.list({ ...(workspaceId === undefined ? {} : { workspaceId }), limit: 200 }).filter(
      (record) => record.status === "running" || record.status === "awaiting_approval"
    );
  }

  /**
   * Records the prompt a node must receive in one specific run. Re-recording the same (run, node) pair is
   * a no-op, so a resume never rewrites the prompt a run already used.
   */
  public putNodePrompt(automaticRunId: string, prompt: AutomaticNodePrompt): void {
    this.sqlite
      .prepare(
        `INSERT INTO automatic_node_prompts
           (run_id, node_id, automatic_run_id, cycle, prompt, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_id) DO NOTHING`
      )
      .run(
        prompt.runId,
        prompt.nodeId,
        automaticRunId,
        prompt.cycle,
        prompt.prompt,
        this.now().getTime()
      );
  }

  /** The prompt the launch resolver must deliver, or null when this node is not automatic-mode work. */
  public getNodePrompt(runId: string, nodeId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT prompt FROM automatic_node_prompts WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId) as { readonly prompt: string } | undefined;
    return row === undefined ? null : row.prompt;
  }

  public listNodePrompts(automaticRunId: string): readonly AutomaticNodePrompt[] {
    const rows = this.sqlite
      .prepare(
        `SELECT run_id, node_id, cycle, prompt FROM automatic_node_prompts
          WHERE automatic_run_id = ? ORDER BY cycle ASC, node_id ASC`
      )
      .all(automaticRunId) as PromptRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      nodeId: row.node_id,
      cycle: row.cycle,
      prompt: row.prompt
    }));
  }

  /**
   * Opens a pending approval for one action. Requesting the same action twice returns the existing
   * record, so a repeated IPC call or a reload never asks twice or loses a decision already made.
   */
  public requireApproval(input: {
    readonly automaticRunId: string;
    readonly nodeId: string;
    readonly actionFingerprint: string;
  }): AutomaticApprovalRecord {
    const existing = this.getApproval(input);
    if (existing !== null) return existing;
    this.sqlite
      .prepare(
        `INSERT INTO automatic_approvals
           (id, automatic_run_id, node_id, action_fingerprint, decision, created_at, decided_at)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL)
         ON CONFLICT(automatic_run_id, node_id, action_fingerprint) DO NOTHING`
      )
      .run(
        this.createId(),
        input.automaticRunId,
        input.nodeId,
        input.actionFingerprint,
        this.now().getTime()
      );
    const record = this.getApproval(input);
    if (record === null) throw new Error("Automatic approval was not persisted");
    return record;
  }

  /**
   * Records a human decision for exactly the action that was presented. A decision already taken is
   * returned unchanged, so deciding twice cannot flip an approval or double-authorize an action.
   */
  public decideApproval(input: {
    readonly automaticRunId: string;
    readonly nodeId: string;
    readonly actionFingerprint: string;
    readonly decision: "approved" | "rejected";
  }): AutomaticApprovalRecord {
    const existing = this.getApproval(input);
    if (existing === null) throw new Error("Automatic approval was not requested");
    if (existing.decision !== "pending") return existing;
    this.sqlite
      .prepare(
        `UPDATE automatic_approvals SET decision = ?, decided_at = ?
          WHERE automatic_run_id = ? AND node_id = ? AND action_fingerprint = ?`
      )
      .run(
        input.decision,
        this.now().getTime(),
        input.automaticRunId,
        input.nodeId,
        input.actionFingerprint
      );
    const updated = this.getApproval(input);
    if (updated === null) throw new Error("Automatic approval was not found after the decision");
    return updated;
  }

  public getApproval(input: {
    readonly automaticRunId: string;
    readonly nodeId: string;
    readonly actionFingerprint: string;
  }): AutomaticApprovalRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM automatic_approvals
          WHERE automatic_run_id = ? AND node_id = ? AND action_fingerprint = ?`
      )
      .get(input.automaticRunId, input.nodeId, input.actionFingerprint) as ApprovalRow | undefined;
    return row === undefined ? null : toApproval(row);
  }

  public listApprovals(automaticRunId: string): readonly AutomaticApprovalRecord[] {
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM automatic_approvals WHERE automatic_run_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(automaticRunId) as ApprovalRow[];
    return rows.map(toApproval);
  }

  public close(): void {
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): void {
    const row = this.sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (row === undefined) throw new Error("Automatic run workspace was not found");
  }
}

function toRecord(row: AutomaticRunRow): AutomaticRunRecord {
  return {
    automaticRunId: row.id,
    workspaceId: row.workspace_id,
    objective: row.objective,
    mode: row.mode,
    status: toStatus(row.status),
    draftId: row.draft_id,
    currentRunId: row.current_run_id,
    remediationCycle: row.remediation_cycle,
    stopReason: row.stop_reason,
    result: row.result,
    state: JSON.parse(row.state_json),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

const statuses: ReadonlySet<AutomaticRunStatus> = new Set([
  "planning",
  "awaiting_approval",
  "running",
  "completed",
  "stopped",
  "rejected"
]);

function toStatus(value: string): AutomaticRunStatus {
  return statuses.has(value as AutomaticRunStatus) ? (value as AutomaticRunStatus) : "stopped";
}

function toApproval(row: ApprovalRow): AutomaticApprovalRecord {
  return {
    approvalId: row.id,
    automaticRunId: row.automatic_run_id,
    nodeId: row.node_id,
    actionFingerprint: row.action_fingerprint,
    decision: row.decision === "approved" || row.decision === "rejected" ? row.decision : "pending",
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString()
  };
}
