export interface GitProject {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly defaultBranch: string;
  readonly headCommit: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedWorktree {
  readonly id: string;
  readonly projectId: string;
  readonly taskKey: string;
  readonly taskTitle: string;
  readonly branchName: string;
  readonly path: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly state: "active" | "removed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorktreeLeaseRecord {
  readonly id: string;
  readonly worktreeId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
}

export interface ProjectLeaseRecord {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
}

export interface GateProcessRecord {
  readonly gateRunId: string;
  readonly worktreeId: string;
  readonly processId: number;
  readonly startedAt: string;
}

export interface GateProcessStore {
  saveGateProcess(record: GateProcessRecord): Promise<void>;
  listGateProcesses(): Promise<readonly GateProcessRecord[]>;
  removeGateProcess(gateRunId: string): Promise<void>;
}

export interface WorktreeFileStatus {
  readonly path: string;
  readonly index: string;
  readonly workingTree: string;
}

export interface WorktreeStatus {
  readonly worktreeId: string;
  readonly branchName: string;
  readonly headCommit: string;
  readonly dirty: boolean;
  readonly gitLocked: boolean;
  readonly leased: boolean;
  readonly leaseOwnerId: string | null;
  readonly files: readonly WorktreeFileStatus[];
  readonly ignoredFiles: readonly string[];
}

export interface WorktreeLease {
  readonly record: WorktreeLeaseRecord;
  release(): Promise<void>;
}

export interface DiffFile {
  readonly path: string;
  readonly status: string;
  readonly oldPath: string | null;
}

export interface WorktreeDiff {
  readonly worktreeId: string;
  readonly baseRef: string;
  readonly headCommit: string;
  readonly dirty: boolean;
  readonly files: readonly DiffFile[];
  readonly untrackedFiles: readonly string[];
  readonly patch: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

export interface MergeConflictResult {
  readonly hasConflicts: boolean;
  readonly conflictedFiles: readonly string[];
}

export interface ProjectStore {
  listProjects(): Promise<readonly GitProject[]>;
  getProject(id: string): Promise<GitProject | null>;
  findProjectByCanonicalRoot(canonicalRootPath: string): Promise<GitProject | null>;
  saveProject(project: GitProject): Promise<void>;
}

export interface WorktreeStore {
  listWorktrees(projectId: string): Promise<readonly ManagedWorktree[]>;
  getWorktree(id: string): Promise<ManagedWorktree | null>;
  findActiveWorktreeByBranch(
    projectId: string,
    branchName: string
  ): Promise<ManagedWorktree | null>;
  saveWorktree(worktree: ManagedWorktree): Promise<void>;
  markWorktreeRemoved(id: string, updatedAt: string): Promise<void>;
  tryAcquireLease(lease: WorktreeLeaseRecord): Promise<boolean>;
  getActiveLease(worktreeId: string): Promise<WorktreeLeaseRecord | null>;
  releaseLease(leaseId: string, ownerId: string): Promise<void>;
  recoverLeases(preserveWorktreeIds?: readonly string[]): Promise<number>;
}

export interface ProjectLockStore {
  tryAcquireProjectLease(lease: ProjectLeaseRecord): Promise<boolean>;
  getProjectLease(projectId: string): Promise<ProjectLeaseRecord | null>;
  releaseProjectLease(leaseId: string, ownerId: string): Promise<void>;
  recoverProjectLeases(): Promise<number>;
}

export type MergePlanState = "pending" | "confirmed" | "invalid" | "failed";

export interface MergePlanRecord {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly sourceHead: string;
  readonly targetHead: string;
  readonly confirmationTokenHash: string | null;
  readonly conflictedFiles: readonly string[];
  readonly requiredGateRunIds: readonly string[];
  readonly state: MergePlanState;
  readonly eligible: boolean;
  readonly issues: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly confirmedAt: string | null;
  readonly mergeCommit: string | null;
  readonly error: string | null;
}

export interface MergePlanPreview {
  readonly plan: MergePlanRecord;
  readonly confirmationToken: string | null;
}

export interface MergePlanStore {
  saveMergePlan(plan: MergePlanRecord): Promise<void>;
  getMergePlan(id: string): Promise<MergePlanRecord | null>;
}

export interface MergeConfirmationResult {
  readonly planId: string;
  readonly state: "confirmed" | "failed";
  readonly mergeCommit: string | null;
  readonly rollbackCommand: string | null;
  readonly error: string | null;
}

export interface PrReadyReportRecord {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly title: string;
  readonly markdown: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface DeliveryReportStore {
  saveDeliveryReport(report: PrReadyReportRecord): Promise<void>;
  getDeliveryReport(id: string): Promise<PrReadyReportRecord | null>;
}

export interface CreateWorktreeInput {
  readonly projectId: string;
  readonly taskKey: string;
  readonly taskTitle: string;
  readonly baseRef?: string;
}
