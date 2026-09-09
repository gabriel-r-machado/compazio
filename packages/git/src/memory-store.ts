import type {
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
  DeliveryReportStore,
  WorktreeLeaseRecord,
  WorktreeStore
} from "./contracts";
import { pathsEqual } from "./path-security";

export class InMemoryGitStore
  implements
    ProjectStore,
    WorktreeStore,
    ProjectLockStore,
    MergePlanStore,
    DeliveryReportStore,
    GateProcessStore
{
  private readonly projects = new Map<string, GitProject>();
  private readonly worktrees = new Map<string, ManagedWorktree>();
  private readonly leases = new Map<string, WorktreeLeaseRecord>();
  private readonly projectLeases = new Map<string, ProjectLeaseRecord>();
  private readonly gateProcesses = new Map<string, GateProcessRecord>();
  private readonly mergePlans = new Map<string, MergePlanRecord>();
  private readonly deliveryReports = new Map<string, PrReadyReportRecord>();

  public async listProjects(): Promise<readonly GitProject[]> {
    return [...this.projects.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  public async getProject(id: string): Promise<GitProject | null> {
    return this.projects.get(id) ?? null;
  }

  public async findProjectByCanonicalRoot(canonicalRootPath: string): Promise<GitProject | null> {
    return (
      [...this.projects.values()].find((project) =>
        pathsEqual(project.canonicalRootPath, canonicalRootPath)
      ) ?? null
    );
  }

  public async saveProject(project: GitProject): Promise<void> {
    this.projects.set(project.id, project);
  }

  public async listWorktrees(projectId: string): Promise<readonly ManagedWorktree[]> {
    return [...this.worktrees.values()].filter((worktree) => worktree.projectId === projectId);
  }

  public async getWorktree(id: string): Promise<ManagedWorktree | null> {
    return this.worktrees.get(id) ?? null;
  }

  public async findActiveWorktreeByBranch(
    projectId: string,
    branchName: string
  ): Promise<ManagedWorktree | null> {
    return (
      [...this.worktrees.values()].find(
        (worktree) =>
          worktree.projectId === projectId &&
          worktree.branchName === branchName &&
          worktree.state === "active"
      ) ?? null
    );
  }

  public async saveWorktree(worktree: ManagedWorktree): Promise<void> {
    this.worktrees.set(worktree.id, worktree);
  }

  public async markWorktreeRemoved(id: string, updatedAt: string): Promise<void> {
    const worktree = this.worktrees.get(id);
    if (worktree === undefined) {
      throw new Error(`Unknown worktree: ${id}`);
    }
    this.worktrees.set(id, { ...worktree, state: "removed", updatedAt });
  }

  public async tryAcquireLease(lease: WorktreeLeaseRecord): Promise<boolean> {
    if (this.leases.has(lease.worktreeId)) {
      return false;
    }
    this.leases.set(lease.worktreeId, lease);
    return true;
  }

  public async getActiveLease(worktreeId: string): Promise<WorktreeLeaseRecord | null> {
    return this.leases.get(worktreeId) ?? null;
  }

  public async releaseLease(leaseId: string, ownerId: string): Promise<void> {
    for (const [worktreeId, lease] of this.leases) {
      if (lease.id === leaseId && lease.ownerId === ownerId) {
        this.leases.delete(worktreeId);
        return;
      }
    }
  }

  public async recoverLeases(preserveWorktreeIds: readonly string[] = []): Promise<number> {
    const preserved = new Set(preserveWorktreeIds);
    let count = 0;
    for (const [worktreeId] of this.leases) {
      if (!preserved.has(worktreeId)) {
        this.leases.delete(worktreeId);
        count += 1;
      }
    }
    return count;
  }

  public async saveGateProcess(record: GateProcessRecord): Promise<void> {
    this.gateProcesses.set(record.gateRunId, record);
  }

  public async listGateProcesses(): Promise<readonly GateProcessRecord[]> {
    return [...this.gateProcesses.values()];
  }

  public async removeGateProcess(gateRunId: string): Promise<void> {
    this.gateProcesses.delete(gateRunId);
  }

  public async tryAcquireProjectLease(lease: ProjectLeaseRecord): Promise<boolean> {
    if (this.projectLeases.has(lease.projectId)) {
      return false;
    }
    this.projectLeases.set(lease.projectId, lease);
    return true;
  }

  public async getProjectLease(projectId: string): Promise<ProjectLeaseRecord | null> {
    return this.projectLeases.get(projectId) ?? null;
  }

  public async releaseProjectLease(leaseId: string, ownerId: string): Promise<void> {
    for (const [projectId, lease] of this.projectLeases) {
      if (lease.id === leaseId && lease.ownerId === ownerId) {
        this.projectLeases.delete(projectId);
        return;
      }
    }
  }

  public async recoverProjectLeases(): Promise<number> {
    const count = this.projectLeases.size;
    this.projectLeases.clear();
    return count;
  }

  public async saveMergePlan(plan: MergePlanRecord): Promise<void> {
    this.mergePlans.set(plan.id, plan);
  }

  public async getMergePlan(id: string): Promise<MergePlanRecord | null> {
    return this.mergePlans.get(id) ?? null;
  }

  public async saveDeliveryReport(report: PrReadyReportRecord): Promise<void> {
    this.deliveryReports.set(report.id, report);
  }

  public async getDeliveryReport(id: string): Promise<PrReadyReportRecord | null> {
    return this.deliveryReports.get(id) ?? null;
  }
}
