import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { QualityGateRunRecord, QualityGateStore } from "@forgedeck/orchestration";
import { simpleGit } from "simple-git";

import type {
  GitProject,
  ManagedWorktree,
  MergeConfirmationResult,
  MergePlanPreview,
  MergePlanRecord,
  MergePlanStore,
  ProjectLeaseRecord,
  ProjectLockStore,
  ProjectStore,
  WorktreeStore
} from "./contracts";
import type { MergeConflictDetector } from "./conflict-detector";
import type { QualityGateService } from "./quality-gate-service";
import type { WorktreeManager } from "./worktree-manager";

const planLifetimeMs = 10 * 60 * 1000;

export class ConfirmedMergeService {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly worktrees: WorktreeStore,
    private readonly projectLocks: ProjectLockStore,
    private readonly gateStore: QualityGateStore,
    private readonly plans: MergePlanStore,
    private readonly worktreeManager: WorktreeManager,
    private readonly qualityGates: QualityGateService,
    private readonly conflicts: MergeConflictDetector,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
    private readonly token: () => string = () => randomBytes(32).toString("hex")
  ) {}

  public async prepare(worktreeId: string): Promise<MergePlanPreview> {
    const { project, worktree } = await this.requireContext(worktreeId);
    const worktreeStatus = await this.worktreeManager.status(worktreeId);
    const projectGit = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    const projectStatus = await projectGit.status();
    const targetHead = (await projectGit.revparse([`${project.defaultBranch}^{commit}`])).trim();
    const issues: string[] = [];

    if (worktreeStatus.dirty) {
      issues.push("Source worktree has uncommitted or untracked changes");
    }
    if (worktreeStatus.leased) {
      issues.push(`Source worktree is in use by ${worktreeStatus.leaseOwnerId ?? "another task"}`);
    }
    if (worktreeStatus.gitLocked) {
      issues.push("Source worktree is locked by Git");
    }
    if (!projectStatus.isClean()) {
      issues.push("Target project worktree has uncommitted or untracked changes");
    }
    if (projectStatus.current !== project.defaultBranch) {
      issues.push(`Target project must be on branch ${project.defaultBranch}`);
    }
    if ((await this.projectLocks.getProjectLease(project.id)) !== null) {
      issues.push("Project is already locked by another Git operation");
    }

    const definitions = await this.qualityGates.discover(worktreeId).catch(() => []);
    const requiredDefinitions = definitions.filter((definition) => !definition.optional);
    if (requiredDefinitions.length === 0) {
      issues.push("No required quality gate scripts are available");
    }
    const gateRuns = await this.gateStore.listGateRuns(worktreeId);
    const requiredGateRuns: QualityGateRunRecord[] = [];
    for (const definition of requiredDefinitions) {
      const gateRun = gateRuns.find(
        (record) =>
          record.presetId === definition.id &&
          record.headCommit === worktreeStatus.headCommit &&
          record.state === "passed" &&
          record.exitCode === 0 &&
          record.durationMs !== null
      );
      if (gateRun === undefined) {
        issues.push(`Required gate has no passing evidence for source HEAD: ${definition.label}`);
      } else {
        requiredGateRuns.push(gateRun);
      }
    }

    const alreadyMerged = await isAncestor(projectGit, worktreeStatus.headCommit, targetHead);
    if (alreadyMerged) {
      issues.push("Source HEAD is already contained in the target branch");
    }
    const conflictResult = await this.conflicts.detect(
      project.id,
      worktree.branchName,
      project.defaultBranch
    );
    if (conflictResult.hasConflicts) {
      issues.push(`Merge conflicts detected in ${conflictResult.conflictedFiles.join(", ")}`);
    }

    const eligible = issues.length === 0;
    const confirmationToken = eligible ? this.token() : null;
    const createdAt = this.now();
    const plan: MergePlanRecord = {
      id: this.id(),
      projectId: project.id,
      worktreeId,
      sourceBranch: worktree.branchName,
      targetBranch: project.defaultBranch,
      sourceHead: worktreeStatus.headCommit,
      targetHead,
      confirmationTokenHash: confirmationToken === null ? null : hashToken(confirmationToken),
      conflictedFiles: conflictResult.conflictedFiles,
      requiredGateRunIds: requiredGateRuns.map((record) => record.id),
      state: eligible ? "pending" : "invalid",
      eligible,
      issues,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + planLifetimeMs).toISOString(),
      confirmedAt: null,
      mergeCommit: null,
      error: null
    };
    await this.plans.saveMergePlan(plan);
    return { plan, confirmationToken };
  }

  public async confirm(input: {
    readonly planId: string;
    readonly confirmationToken: string;
    readonly confirmed: boolean;
  }): Promise<MergeConfirmationResult> {
    if (!input.confirmed) {
      throw new Error("Merge requires explicit human confirmation");
    }
    const plan = await this.plans.getMergePlan(input.planId);
    if (
      plan === null ||
      plan.state !== "pending" ||
      !plan.eligible ||
      plan.confirmationTokenHash === null
    ) {
      throw new Error("Merge plan is not eligible for confirmation");
    }
    if (!tokenMatches(input.confirmationToken, plan.confirmationTokenHash)) {
      throw new Error("Merge confirmation token is invalid");
    }
    if (this.now().getTime() > new Date(plan.expiresAt).getTime()) {
      await this.invalidatePlan(plan, "Merge confirmation expired");
      throw new Error("Merge confirmation expired; prepare a new merge plan");
    }

    const projectLease: ProjectLeaseRecord = {
      id: this.id(),
      projectId: plan.projectId,
      ownerId: `merge:${plan.id}`,
      acquiredAt: this.now().toISOString()
    };
    if (!(await this.projectLocks.tryAcquireProjectLease(projectLease))) {
      throw new Error("Project is already locked by another Git operation");
    }
    let worktreeLease: Awaited<ReturnType<WorktreeManager["acquireLease"]>> | null = null;
    try {
      worktreeLease = await this.worktreeManager.acquireLease(plan.worktreeId, `merge:${plan.id}`);
      const revalidationError = await this.revalidate(plan);
      if (revalidationError !== null) {
        await this.invalidatePlan(plan, revalidationError);
        return {
          planId: plan.id,
          state: "failed",
          mergeCommit: null,
          rollbackCommand: null,
          error: revalidationError
        };
      }

      const project = await this.requireProject(plan.projectId);
      const git = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
      try {
        await git.raw(["merge", "--no-ff", "--no-edit", plan.sourceHead]);
      } catch {
        await abortMergeIfPresent(git);
        const error = "Git merge failed and was aborted without deleting either branch";
        await this.plans.saveMergePlan({
          ...plan,
          confirmationTokenHash: null,
          state: "failed",
          error
        });
        return {
          planId: plan.id,
          state: "failed",
          mergeCommit: null,
          rollbackCommand: null,
          error
        };
      }

      const mergeCommit = (await git.revparse(["HEAD"])).trim();
      const confirmedAt = this.now().toISOString();
      const rollbackCommand = `git revert -m 1 ${mergeCommit}`;
      try {
        await this.plans.saveMergePlan({
          ...plan,
          confirmationTokenHash: null,
          state: "confirmed",
          confirmedAt,
          mergeCommit,
          error: null
        });
        await this.projects.saveProject({
          ...project,
          headCommit: mergeCommit,
          updatedAt: confirmedAt
        });
      } catch (error: unknown) {
        return {
          planId: plan.id,
          state: "failed",
          mergeCommit,
          rollbackCommand,
          error: `Git merge completed at ${mergeCommit}, but local audit persistence failed: ${error instanceof Error ? error.message : "unknown persistence error"}`
        };
      }
      return {
        planId: plan.id,
        state: "confirmed",
        mergeCommit,
        rollbackCommand,
        error: null
      };
    } finally {
      await worktreeLease?.release();
      await this.projectLocks.releaseProjectLease(projectLease.id, projectLease.ownerId);
    }
  }

  private async revalidate(plan: MergePlanRecord): Promise<string | null> {
    const { project } = await this.requireContext(plan.worktreeId);
    const worktreeStatus = await this.worktreeManager.status(plan.worktreeId);
    if (worktreeStatus.dirty || worktreeStatus.headCommit !== plan.sourceHead) {
      return "Source worktree changed after merge preparation";
    }
    const git = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    const projectStatus = await git.status();
    const targetHead = (await git.revparse([`${plan.targetBranch}^{commit}`])).trim();
    if (
      !projectStatus.isClean() ||
      projectStatus.current !== plan.targetBranch ||
      targetHead !== plan.targetHead
    ) {
      return "Target branch changed after merge preparation";
    }
    for (const gateRunId of plan.requiredGateRunIds) {
      const gate = await this.gateStore.getGateRun(gateRunId);
      if (
        gate === null ||
        gate.state !== "passed" ||
        gate.exitCode !== 0 ||
        gate.durationMs === null ||
        gate.headCommit !== plan.sourceHead
      ) {
        return "Required quality gate evidence is no longer valid";
      }
    }
    const conflicts = await this.conflicts.detect(plan.projectId, plan.sourceHead, plan.targetHead);
    return conflicts.hasConflicts ? "Merge conflicts appeared after merge preparation" : null;
  }

  private async invalidatePlan(plan: MergePlanRecord, error: string): Promise<void> {
    await this.plans.saveMergePlan({
      ...plan,
      confirmationTokenHash: null,
      state: "invalid",
      eligible: false,
      issues: [...plan.issues, error],
      error
    });
  }

  private async requireContext(worktreeId: string): Promise<{
    readonly project: GitProject;
    readonly worktree: ManagedWorktree;
  }> {
    const worktree = await this.worktrees.getWorktree(worktreeId);
    if (worktree === null || worktree.state !== "active") {
      throw new Error(`Unknown active worktree: ${worktreeId}`);
    }
    return { project: await this.requireProject(worktree.projectId), worktree };
  }

  private async requireProject(projectId: string): Promise<GitProject> {
    const project = await this.projects.getProject(projectId);
    if (project === null) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function isAncestor(
  git: ReturnType<typeof simpleGit>,
  possibleAncestor: string,
  target: string
): Promise<boolean> {
  try {
    const mergeBase = (await git.raw(["merge-base", possibleAncestor, target])).trim();
    return mergeBase === possibleAncestor;
  } catch {
    return false;
  }
}

async function abortMergeIfPresent(git: ReturnType<typeof simpleGit>): Promise<void> {
  try {
    await git.revparse(["--verify", "MERGE_HEAD"]);
  } catch {
    return;
  }
  await git.raw(["merge", "--abort"]);
}
