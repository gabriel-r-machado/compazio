import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { simpleGit } from "simple-git";

import { assertSafeGitRef } from "./branch-naming";
import type { MergeConflictResult, ProjectStore } from "./contracts";
import { canonicalizeDirectory, ensurePathInside } from "./path-security";

export class MergeConflictDetector {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly managedRoot: string,
    private readonly id: () => string = randomUUID
  ) {}

  public async detect(
    projectId: string,
    sourceRef: string,
    targetRef: string
  ): Promise<MergeConflictResult> {
    assertSafeGitRef(sourceRef);
    assertSafeGitRef(targetRef);
    const project = await this.projects.getProject(projectId);
    if (project === null) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    const projectRoot = await canonicalizeDirectory(project.rootPath);
    const projectGit = simpleGit({ baseDir: projectRoot, maxConcurrentProcesses: 1 });
    let sourceCommit: string;
    let targetCommit: string;
    try {
      [sourceCommit, targetCommit] = await Promise.all([
        projectGit.revparse([`${sourceRef}^{commit}`]).then((value) => value.trim()),
        projectGit.revparse([`${targetRef}^{commit}`]).then((value) => value.trim())
      ]);
    } catch {
      throw new Error("Merge conflict check requires two existing commit refs");
    }

    const checkRoot = join(resolve(this.managedRoot), "_merge-check", project.id);
    await mkdir(checkRoot, { recursive: true });
    const canonicalCheckRoot = await canonicalizeDirectory(checkRoot);
    const temporaryPath = join(canonicalCheckRoot, this.id());
    ensurePathInside(canonicalCheckRoot, temporaryPath, "Merge check path");
    let added = false;
    let operationResult: MergeConflictResult | undefined;
    let operationError: unknown;
    try {
      await projectGit.raw(["worktree", "add", "--detach", temporaryPath, targetCommit]);
      added = true;
      const temporaryGit = simpleGit({ baseDir: temporaryPath, maxConcurrentProcesses: 1 });
      try {
        await temporaryGit.raw(["merge", "--no-commit", "--no-ff", sourceCommit]);
        const conflictedFiles = await listConflictedFiles(temporaryGit);
        await abortMergeIfPresent(temporaryGit);
        operationResult = { hasConflicts: conflictedFiles.length > 0, conflictedFiles };
      } catch {
        const conflictedFiles = await listConflictedFiles(temporaryGit);
        await abortMergeIfPresent(temporaryGit);
        if (conflictedFiles.length === 0) {
          throw new Error("Git merge check failed without producing conflict entries");
        }
        operationResult = { hasConflicts: true, conflictedFiles };
      }
    } catch (error: unknown) {
      operationError = error;
    }

    let cleanupError: unknown;
    if (added) {
      try {
        await projectGit.raw(["worktree", "remove", "--force", temporaryPath]);
        await projectGit.raw(["worktree", "prune"]);
      } catch (error: unknown) {
        cleanupError = error;
      }
    }
    try {
      await rm(temporaryPath, { recursive: true, force: true });
    } catch (error: unknown) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, cleanupError],
          "Merge conflict check failed and its disposable worktree could not be cleaned"
        );
      }
      throw new Error("Could not clean the disposable merge-check worktree", {
        cause: cleanupError
      });
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (operationResult === undefined) {
      throw new Error("Merge conflict check did not produce a result");
    }
    return operationResult;
  }
}

async function listConflictedFiles(git: ReturnType<typeof simpleGit>): Promise<readonly string[]> {
  return (await git.raw(["diff", "--name-only", "--diff-filter=U"]))
    .split(/\r?\n/)
    .filter((path) => path.length > 0);
}

async function abortMergeIfPresent(git: ReturnType<typeof simpleGit>): Promise<void> {
  try {
    await git.revparse(["--verify", "MERGE_HEAD"]);
  } catch {
    return;
  }
  await git.raw(["merge", "--abort"]);
}
