import { Buffer } from "node:buffer";

import { simpleGit } from "simple-git";

import type { DiffFile, ProjectStore, WorktreeDiff, WorktreeStore } from "./contracts";
import { canonicalizeDirectory, pathsEqual } from "./path-security";

const defaultMaximumPatchBytes = 2 * 1024 * 1024;

export class WorktreeDiffService {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly worktrees: WorktreeStore,
    private readonly maximumPatchBytes = defaultMaximumPatchBytes
  ) {}

  public async getDiff(worktreeId: string): Promise<WorktreeDiff> {
    const worktree = await this.worktrees.getWorktree(worktreeId);
    if (worktree === null || worktree.state !== "active") {
      throw new Error(`Unknown active worktree: ${worktreeId}`);
    }
    const project = await this.projects.getProject(worktree.projectId);
    if (project === null) {
      throw new Error(`Unknown project: ${worktree.projectId}`);
    }
    const canonicalPath = await canonicalizeDirectory(worktree.path);
    if (!pathsEqual(canonicalPath, worktree.path)) {
      throw new Error("Worktree path no longer resolves to its approved location");
    }

    const git = simpleGit({ baseDir: canonicalPath, maxConcurrentProcesses: 1 });
    const status = await git.status();
    const headCommit = (await git.revparse(["HEAD"])).trim();
    const patch = await git.raw([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      worktree.baseCommit,
      "--",
      "."
    ]);
    const nameStatus = await git.raw([
      "diff",
      "--name-status",
      "--find-renames",
      worktree.baseCommit,
      "--",
      "."
    ]);
    const originalBytes = Buffer.byteLength(patch, "utf8");
    return {
      worktreeId,
      baseRef: worktree.baseRef,
      headCommit,
      dirty: !status.isClean(),
      files: parseNameStatus(nameStatus),
      untrackedFiles: status.not_added,
      patch: truncateUtf8(patch, this.maximumPatchBytes),
      truncated: originalBytes > this.maximumPatchBytes,
      originalBytes
    };
  }
}

function parseNameStatus(value: string): readonly DiffFile[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status = "?", firstPath = "", secondPath] = line.split("\t");
      const renamed = status.startsWith("R") || status.startsWith("C");
      return {
        path: renamed ? (secondPath ?? firstPath) : firstPath,
        status,
        oldPath: renamed ? firstPath : null
      };
    });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= maximumBytes
    ? value
    : `${buffer.subarray(0, maximumBytes).toString("utf8")}\n[diff truncated]\n`;
}
