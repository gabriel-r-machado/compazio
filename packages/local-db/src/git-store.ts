import Database from "better-sqlite3";

import type {
  DeliveryReportStore,
  GateProcessRecord,
  GateProcessStore,
  GitProject,
  ManagedWorktree,
  MergePlanRecord,
  MergePlanStore,
  PrReadyReportRecord,
  ProjectLeaseRecord,
  ProjectLockStore,
  ProjectStore,
  WorktreeLeaseRecord,
  WorktreeStore
} from "@forgedeck/git";
import { redactText } from "@forgedeck/logger";
import type {
  QualityGatePresetId,
  QualityGateRunRecord,
  QualityGateRunState,
  QualityGateStore
} from "@forgedeck/orchestration";

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly root_path: string;
  readonly canonical_root_path: string;
  readonly default_branch: string;
  readonly head_commit: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface WorktreeRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_key: string;
  readonly task_title: string;
  readonly branch_name: string;
  readonly path: string;
  readonly base_ref: string;
  readonly base_commit: string;
  readonly state: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface LeaseRow {
  readonly id: string;
  readonly owner_id: string;
  readonly acquired_at: number;
}

interface GateRunRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_id: string;
  readonly preset_id: string;
  readonly state: string;
  readonly executable_name: string;
  readonly args_json: string;
  readonly head_commit: string;
  readonly exit_code: number | null;
  readonly duration_ms: number | null;
  readonly timed_out: number;
  readonly output_summary: string;
  readonly started_at: number;
  readonly ended_at: number | null;
}

interface GateProcessRow {
  readonly gate_run_id: string;
  readonly worktree_id: string;
  readonly process_id: number;
  readonly started_at: number;
}

interface MergePlanRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_id: string;
  readonly source_branch: string;
  readonly target_branch: string;
  readonly source_head: string;
  readonly target_head: string;
  readonly confirmation_token_hash: string | null;
  readonly conflicted_files_json: string;
  readonly required_gate_run_ids_json: string;
  readonly state: string;
  readonly eligible: number;
  readonly issues_json: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly confirmed_at: number | null;
  readonly merge_commit: string | null;
  readonly error: string | null;
}

interface DeliveryReportRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_id: string;
  readonly title: string;
  readonly markdown: string;
  readonly sha256: string;
  readonly created_at: number;
}

export class SqliteGitStore
  implements
    ProjectStore,
    WorktreeStore,
    ProjectLockStore,
    QualityGateStore,
    MergePlanStore,
    DeliveryReportStore,
    GateProcessStore
{
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public async listProjects(): Promise<readonly GitProject[]> {
    return (
      this.sqlite.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[]
    ).map(toProject);
  }

  public async getProject(id: string): Promise<GitProject | null> {
    const row = this.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      ProjectRow | undefined;
    return row === undefined ? null : toProject(row);
  }

  public async findProjectByCanonicalRoot(canonicalRootPath: string): Promise<GitProject | null> {
    const row = this.sqlite
      .prepare("SELECT * FROM projects WHERE canonical_root_path = ? COLLATE NOCASE")
      .get(canonicalRootPath) as ProjectRow | undefined;
    return row === undefined ? null : toProject(row);
  }

  public async saveProject(project: GitProject): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO projects
          (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           canonical_root_path = excluded.canonical_root_path,
           default_branch = excluded.default_branch,
           head_commit = excluded.head_commit,
           updated_at = excluded.updated_at`
      )
      .run(
        project.id,
        project.name,
        project.rootPath,
        project.canonicalRootPath,
        project.defaultBranch,
        project.headCommit,
        toMilliseconds(project.createdAt),
        toMilliseconds(project.updatedAt)
      );
  }

  public async listWorktrees(projectId: string): Promise<readonly ManagedWorktree[]> {
    return (
      this.sqlite
        .prepare("SELECT * FROM managed_worktrees WHERE project_id = ? ORDER BY created_at DESC")
        .all(projectId) as WorktreeRow[]
    ).map(toWorktree);
  }

  public async getWorktree(id: string): Promise<ManagedWorktree | null> {
    const row = this.sqlite.prepare("SELECT * FROM managed_worktrees WHERE id = ?").get(id) as
      WorktreeRow | undefined;
    return row === undefined ? null : toWorktree(row);
  }

  public async findActiveWorktreeByBranch(
    projectId: string,
    branchName: string
  ): Promise<ManagedWorktree | null> {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM managed_worktrees WHERE project_id = ? AND branch_name = ? AND state = 'active'"
      )
      .get(projectId, branchName) as WorktreeRow | undefined;
    return row === undefined ? null : toWorktree(row);
  }

  public async saveWorktree(worktree: ManagedWorktree): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO managed_worktrees
          (id, project_id, task_key, task_title, branch_name, path, base_ref, base_commit,
           state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
      )
      .run(
        worktree.id,
        worktree.projectId,
        worktree.taskKey,
        worktree.taskTitle,
        worktree.branchName,
        worktree.path,
        worktree.baseRef,
        worktree.baseCommit,
        worktree.state,
        toMilliseconds(worktree.createdAt),
        toMilliseconds(worktree.updatedAt)
      );
  }

  public async markWorktreeRemoved(id: string, updatedAt: string): Promise<void> {
    const result = this.sqlite
      .prepare("UPDATE managed_worktrees SET state = 'removed', updated_at = ? WHERE id = ?")
      .run(toMilliseconds(updatedAt), id);
    if (result.changes !== 1) {
      throw new Error(`Unknown worktree: ${id}`);
    }
  }

  public async tryAcquireLease(lease: WorktreeLeaseRecord): Promise<boolean> {
    const result = this.sqlite
      .prepare(
        `INSERT INTO worktree_leases (id, worktree_id, owner_id, acquired_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(worktree_id) DO NOTHING`
      )
      .run(lease.id, lease.worktreeId, lease.ownerId, toMilliseconds(lease.acquiredAt));
    return result.changes === 1;
  }

  public async getActiveLease(worktreeId: string): Promise<WorktreeLeaseRecord | null> {
    const row = this.sqlite
      .prepare("SELECT id, owner_id, acquired_at FROM worktree_leases WHERE worktree_id = ?")
      .get(worktreeId) as LeaseRow | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          worktreeId,
          ownerId: row.owner_id,
          acquiredAt: toIso(row.acquired_at)
        };
  }

  public async releaseLease(leaseId: string, ownerId: string): Promise<void> {
    this.sqlite
      .prepare("DELETE FROM worktree_leases WHERE id = ? AND owner_id = ?")
      .run(leaseId, ownerId);
  }

  public async recoverLeases(preserveWorktreeIds: readonly string[] = []): Promise<number> {
    if (preserveWorktreeIds.length === 0) {
      return this.sqlite.prepare("DELETE FROM worktree_leases").run().changes;
    }
    const placeholders = preserveWorktreeIds.map(() => "?").join(", ");
    return this.sqlite
      .prepare(`DELETE FROM worktree_leases WHERE worktree_id NOT IN (${placeholders})`)
      .run(...preserveWorktreeIds).changes;
  }

  public async saveGateProcess(record: GateProcessRecord): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO quality_gate_processes (gate_run_id, worktree_id, process_id, started_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(gate_run_id) DO UPDATE SET
           worktree_id = excluded.worktree_id,
           process_id = excluded.process_id,
           started_at = excluded.started_at`
      )
      .run(record.gateRunId, record.worktreeId, record.processId, toMilliseconds(record.startedAt));
  }

  public async listGateProcesses(): Promise<readonly GateProcessRecord[]> {
    return (
      this.sqlite.prepare("SELECT * FROM quality_gate_processes").all() as GateProcessRow[]
    ).map((row) => ({
      gateRunId: row.gate_run_id,
      worktreeId: row.worktree_id,
      processId: row.process_id,
      startedAt: toIso(row.started_at)
    }));
  }

  public async removeGateProcess(gateRunId: string): Promise<void> {
    this.sqlite.prepare("DELETE FROM quality_gate_processes WHERE gate_run_id = ?").run(gateRunId);
  }

  public async tryAcquireProjectLease(lease: ProjectLeaseRecord): Promise<boolean> {
    const result = this.sqlite
      .prepare(
        `INSERT INTO project_leases (id, project_id, owner_id, acquired_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING`
      )
      .run(lease.id, lease.projectId, lease.ownerId, toMilliseconds(lease.acquiredAt));
    return result.changes === 1;
  }

  public async getProjectLease(projectId: string): Promise<ProjectLeaseRecord | null> {
    const row = this.sqlite
      .prepare("SELECT id, owner_id, acquired_at FROM project_leases WHERE project_id = ?")
      .get(projectId) as LeaseRow | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          projectId,
          ownerId: row.owner_id,
          acquiredAt: toIso(row.acquired_at)
        };
  }

  public async releaseProjectLease(leaseId: string, ownerId: string): Promise<void> {
    this.sqlite
      .prepare("DELETE FROM project_leases WHERE id = ? AND owner_id = ?")
      .run(leaseId, ownerId);
  }

  public async recoverProjectLeases(): Promise<number> {
    return this.sqlite.prepare("DELETE FROM project_leases").run().changes;
  }

  public async saveGateRun(record: QualityGateRunRecord): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO quality_gate_runs
          (id, project_id, worktree_id, preset_id, state, executable_name, args_json,
           head_commit, exit_code, duration_ms, timed_out, output_summary, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           exit_code = excluded.exit_code,
           duration_ms = excluded.duration_ms,
           timed_out = excluded.timed_out,
           output_summary = excluded.output_summary,
           ended_at = excluded.ended_at`
      )
      .run(
        record.id,
        record.projectId,
        record.worktreeId,
        record.presetId,
        record.state,
        record.executableName,
        JSON.stringify(record.args),
        record.headCommit,
        record.exitCode,
        record.durationMs,
        record.timedOut ? 1 : 0,
        redactText(record.outputSummary),
        toMilliseconds(record.startedAt),
        record.endedAt === null ? null : toMilliseconds(record.endedAt)
      );
  }

  public async getGateRun(id: string): Promise<QualityGateRunRecord | null> {
    const row = this.sqlite.prepare("SELECT * FROM quality_gate_runs WHERE id = ?").get(id) as
      GateRunRow | undefined;
    return row === undefined ? null : toGateRun(row);
  }

  public async listGateRuns(worktreeId: string): Promise<readonly QualityGateRunRecord[]> {
    return (
      this.sqlite
        .prepare("SELECT * FROM quality_gate_runs WHERE worktree_id = ? ORDER BY started_at DESC")
        .all(worktreeId) as GateRunRow[]
    ).map(toGateRun);
  }

  public async recoverGateRuns(at: string): Promise<number> {
    return this.sqlite
      .prepare(
        "UPDATE quality_gate_runs SET state = 'interrupted', ended_at = ? WHERE state = 'running'"
      )
      .run(toMilliseconds(at)).changes;
  }

  public async saveMergePlan(plan: MergePlanRecord): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO merge_plans
          (id, project_id, worktree_id, source_branch, target_branch, source_head, target_head,
           confirmation_token_hash, conflicted_files_json, required_gate_run_ids_json, state,
           eligible, issues_json, created_at, expires_at, confirmed_at, merge_commit, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           confirmation_token_hash = excluded.confirmation_token_hash,
           state = excluded.state,
           eligible = excluded.eligible,
           issues_json = excluded.issues_json,
           confirmed_at = excluded.confirmed_at,
           merge_commit = excluded.merge_commit,
           error = excluded.error`
      )
      .run(
        plan.id,
        plan.projectId,
        plan.worktreeId,
        plan.sourceBranch,
        plan.targetBranch,
        plan.sourceHead,
        plan.targetHead,
        plan.confirmationTokenHash,
        JSON.stringify(plan.conflictedFiles),
        JSON.stringify(plan.requiredGateRunIds),
        plan.state,
        plan.eligible ? 1 : 0,
        JSON.stringify(plan.issues),
        toMilliseconds(plan.createdAt),
        toMilliseconds(plan.expiresAt),
        plan.confirmedAt === null ? null : toMilliseconds(plan.confirmedAt),
        plan.mergeCommit,
        plan.error
      );
  }

  public async getMergePlan(id: string): Promise<MergePlanRecord | null> {
    const row = this.sqlite.prepare("SELECT * FROM merge_plans WHERE id = ?").get(id) as
      MergePlanRow | undefined;
    return row === undefined ? null : toMergePlan(row);
  }

  public async saveDeliveryReport(report: PrReadyReportRecord): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO delivery_reports
          (id, project_id, worktree_id, title, markdown, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        report.id,
        report.projectId,
        report.worktreeId,
        report.title,
        redactText(report.markdown),
        report.sha256,
        toMilliseconds(report.createdAt)
      );
  }

  public async getDeliveryReport(id: string): Promise<PrReadyReportRecord | null> {
    const row = this.sqlite.prepare("SELECT * FROM delivery_reports WHERE id = ?").get(id) as
      DeliveryReportRow | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          projectId: row.project_id,
          worktreeId: row.worktree_id,
          title: row.title,
          markdown: row.markdown,
          sha256: row.sha256,
          createdAt: toIso(row.created_at)
        };
  }

  public close(): void {
    this.sqlite.close();
  }
}

function toProject(row: ProjectRow): GitProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    canonicalRootPath: row.canonical_root_path,
    defaultBranch: row.default_branch,
    headCommit: row.head_commit,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toWorktree(row: WorktreeRow): ManagedWorktree {
  if (row.state !== "active" && row.state !== "removed") {
    throw new Error(`Stored worktree state is invalid: ${row.state}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskKey: row.task_key,
    taskTitle: row.task_title,
    branchName: row.branch_name,
    path: row.path,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    state: row.state,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toGateRun(row: GateRunRow): QualityGateRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    presetId: parseGatePreset(row.preset_id),
    state: parseGateState(row.state),
    executableName: row.executable_name,
    args: parseStringArray(row.args_json),
    headCommit: row.head_commit,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    timedOut: row.timed_out === 1,
    outputSummary: row.output_summary,
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at === null ? null : toIso(row.ended_at)
  };
}

function toMergePlan(row: MergePlanRow): MergePlanRecord {
  if (!["pending", "confirmed", "invalid", "failed"].includes(row.state)) {
    throw new Error(`Stored merge plan state is invalid: ${row.state}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    sourceHead: row.source_head,
    targetHead: row.target_head,
    confirmationTokenHash: row.confirmation_token_hash,
    conflictedFiles: parseStringArray(row.conflicted_files_json),
    requiredGateRunIds: parseStringArray(row.required_gate_run_ids_json),
    state: row.state as MergePlanRecord["state"],
    eligible: row.eligible === 1,
    issues: parseStringArray(row.issues_json),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    confirmedAt: row.confirmed_at === null ? null : toIso(row.confirmed_at),
    mergeCommit: row.merge_commit,
    error: row.error
  };
}

function parseGatePreset(value: string): QualityGatePresetId {
  if (["lint", "typecheck", "test", "build", "playwright"].includes(value)) {
    return value as QualityGatePresetId;
  }
  throw new Error(`Stored quality gate preset is invalid: ${value}`);
}

function parseGateState(value: string): QualityGateRunState {
  if (["running", "passed", "failed", "interrupted"].includes(value)) {
    return value as QualityGateRunState;
  }
  throw new Error(`Stored quality gate state is invalid: ${value}`);
}

function parseStringArray(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Stored JSON string array is invalid");
  }
  return parsed;
}

function toMilliseconds(value: string): number {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Timestamp is invalid");
  }
  return milliseconds;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
