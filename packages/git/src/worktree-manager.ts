import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { simpleGit } from "simple-git";

import { assertForgeDeckBranchName, assertSafeGitRef, createTaskBranchName } from "./branch-naming";
import type {
  CreateWorktreeInput,
  GitProject,
  ManagedWorktree,
  ProjectStore,
  WorktreeLease,
  WorktreeLeaseRecord,
  WorktreeStatus,
  WorktreeStore
} from "./contracts";
import { canonicalizeDirectory, ensurePathInside, pathsEqual } from "./path-security";

export class WorktreeManager {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly worktrees: WorktreeStore,
    private readonly managedRoot: string,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID
  ) {}

  public list(projectId: string): Promise<readonly ManagedWorktree[]> {
    return this.worktrees.listWorktrees(projectId);
  }

  public async create(input: CreateWorktreeInput): Promise<ManagedWorktree> {
    const project = await this.requireProject(input.projectId);
    await this.validateProjectRoot(project);
    const branchName = createTaskBranchName(input.taskTitle, input.taskKey);
    assertForgeDeckBranchName(branchName);
    if ((await this.worktrees.findActiveWorktreeByBranch(project.id, branchName)) !== null) {
      throw new Error(`A managed worktree already uses branch ${branchName}`);
    }

    const baseRef = input.baseRef ?? project.defaultBranch;
    assertSafeGitRef(baseRef);
    const projectGit = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    const branches = await projectGit.branchLocal();
    if (branches.all.includes(branchName)) {
      throw new Error(`Git branch already exists: ${branchName}`);
    }
    let baseCommit: string;
    try {
      baseCommit = (await projectGit.revparse([`${baseRef}^{commit}`])).trim();
    } catch {
      throw new Error(`Base ref does not resolve to a commit: ${baseRef}`);
    }

    const worktreeId = this.id();
    const projectWorktreeRoot = join(resolve(this.managedRoot), project.id);
    await mkdir(projectWorktreeRoot, { recursive: true });
    const canonicalManagedRoot = await canonicalizeDirectory(projectWorktreeRoot);
    const targetPath = join(canonicalManagedRoot, worktreeId);
    ensurePathInside(canonicalManagedRoot, targetPath, "Worktree path");

    try {
      await projectGit.raw(["worktree", "add", "-b", branchName, targetPath, baseCommit]);
    } catch {
      throw new Error(`Could not create Git worktree for branch ${branchName}`);
    }

    try {
      const canonicalTargetPath = await canonicalizeDirectory(targetPath);
      ensurePathInside(canonicalManagedRoot, canonicalTargetPath, "Created worktree path");
      const timestamp = this.now().toISOString();
      const worktree: ManagedWorktree = {
        id: worktreeId,
        projectId: project.id,
        taskKey: input.taskKey,
        taskTitle: input.taskTitle,
        branchName,
        path: canonicalTargetPath,
        baseRef,
        baseCommit,
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await this.worktrees.saveWorktree(worktree);
      return worktree;
    } catch (error: unknown) {
      try {
        await this.removeInternalWorktree(project, targetPath);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          `Worktree creation failed and rollback could not remove ${branchName}`,
          { cause: cleanupError }
        );
      }
      throw error;
    }
  }

  public async status(worktreeId: string): Promise<WorktreeStatus> {
    const worktree = await this.requireActiveWorktree(worktreeId);
    const project = await this.requireProject(worktree.projectId);
    await this.validateManagedWorktreePath(project, worktree);
    const git = simpleGit({ baseDir: worktree.path, maxConcurrentProcesses: 1 });
    const status = await git.status();
    const ignoredFiles = (await git.raw(["status", "--porcelain=v1", "--ignored=matching"]))
      .split(/\r?\n/)
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3));
    const headCommit = (await git.revparse(["HEAD"])).trim();
    const lease = await this.worktrees.getActiveLease(worktree.id);
    return {
      worktreeId: worktree.id,
      branchName: worktree.branchName,
      headCommit,
      dirty: !status.isClean(),
      gitLocked: await this.isGitLocked(project, worktree.path),
      leased: lease !== null,
      leaseOwnerId: lease?.ownerId ?? null,
      files: status.files.map((file) => ({
        path: file.path,
        index: file.index,
        workingTree: file.working_dir
      })),
      ignoredFiles
    };
  }

  public async acquireLease(worktreeId: string, ownerId: string): Promise<WorktreeLease> {
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(ownerId)) {
      throw new Error("Worktree lease owner id is invalid");
    }
    const worktree = await this.requireActiveWorktree(worktreeId);
    const project = await this.requireProject(worktree.projectId);
    await this.validateManagedWorktreePath(project, worktree);
    if (await this.isGitLocked(project, worktree.path)) {
      throw new Error("Worktree is locked by Git and cannot execute code");
    }
    const record: WorktreeLeaseRecord = {
      id: this.id(),
      worktreeId,
      ownerId,
      acquiredAt: this.now().toISOString()
    };
    if (!(await this.worktrees.tryAcquireLease(record))) {
      const current = await this.worktrees.getActiveLease(worktreeId);
      throw new Error(`Worktree is already in use by ${current?.ownerId ?? "another task"}`);
    }
    let released = false;
    return {
      record,
      release: async () => {
        if (!released) {
          released = true;
          await this.worktrees.releaseLease(record.id, ownerId);
        }
      }
    };
  }

  public async cleanup(worktreeId: string): Promise<void> {
    const worktree = await this.requireActiveWorktree(worktreeId);
    const project = await this.requireProject(worktree.projectId);
    await this.validateManagedWorktreePath(project, worktree);
    const lease = await this.acquireLease(worktreeId, `cleanup:${this.id()}`);
    try {
      const status = await this.status(worktree.id);
      if (status.gitLocked) {
        throw new Error("Cleanup refused: worktree is locked by Git");
      }
      if (status.dirty || status.ignoredFiles.length > 0) {
        throw new Error("Cleanup refused: worktree has uncommitted, untracked or ignored files");
      }

      const projectGit = simpleGit({
        baseDir: project.canonicalRootPath,
        maxConcurrentProcesses: 1
      });
      try {
        await projectGit.raw(["worktree", "remove", worktree.path]);
        await projectGit.raw(["worktree", "prune"]);
      } catch (error: unknown) {
        throw new Error("Git refused to remove the clean worktree", { cause: error });
      }
      await this.worktrees.markWorktreeRemoved(worktree.id, this.now().toISOString());
    } finally {
      await lease.release();
    }
  }

  public recoverLeases(): Promise<number> {
    return this.worktrees.recoverLeases();
  }

  private async requireProject(projectId: string): Promise<GitProject> {
    const project = await this.projects.getProject(projectId);
    if (project === null) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  private async requireActiveWorktree(worktreeId: string): Promise<ManagedWorktree> {
    const worktree = await this.worktrees.getWorktree(worktreeId);
    if (worktree === null || worktree.state !== "active") {
      throw new Error(`Unknown active worktree: ${worktreeId}`);
    }
    return worktree;
  }

  private async validateProjectRoot(project: GitProject): Promise<void> {
    const currentRoot = await canonicalizeDirectory(project.rootPath);
    if (!pathsEqual(currentRoot, project.canonicalRootPath)) {
      throw new Error("Persisted project root no longer resolves to the approved directory");
    }
  }

  private async validateManagedWorktreePath(
    project: GitProject,
    worktree: ManagedWorktree
  ): Promise<void> {
    await this.validateProjectRoot(project);
    const canonicalPath = await canonicalizeDirectory(worktree.path);
    const canonicalManagedRoot = await canonicalizeDirectory(
      join(resolve(this.managedRoot), project.id)
    );
    ensurePathInside(canonicalManagedRoot, canonicalPath, "Worktree path");
    if (!pathsEqual(canonicalPath, worktree.path)) {
      throw new Error("Worktree path no longer resolves to its approved location");
    }
  }

  private async isGitLocked(project: GitProject, worktreePath: string): Promise<boolean> {
    const git = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    const porcelain = await git.raw(["worktree", "list", "--porcelain"]);
    const blocks = porcelain.split(/\r?\n\r?\n/);
    return blocks.some((block) => {
      const lines = block.split(/\r?\n/);
      const pathLine = lines.find((line) => line.startsWith("worktree "));
      return (
        pathLine !== undefined &&
        pathsEqual(pathLine.slice("worktree ".length), worktreePath) &&
        lines.some((line) => line === "locked" || line.startsWith("locked "))
      );
    });
  }

  private async removeInternalWorktree(project: GitProject, path: string): Promise<void> {
    const git = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    try {
      await git.raw(["worktree", "remove", "--force", path]);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
}
