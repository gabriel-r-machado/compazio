import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";

import { simpleGit } from "simple-git";

import type { GitProject, ProjectStore } from "./contracts";
import { assertSafeGitRef } from "./branch-naming";
import { parseGitHubRepositoryUrl } from "./github-repository-url";
import { canonicalizeDirectory, ensurePathInside } from "./path-security";

export class ProjectRepositoryService {
  public constructor(
    private readonly store: ProjectStore,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID
  ) {}

  public list(): Promise<readonly GitProject[]> {
    return this.store.listProjects();
  }

  public get(projectId: string): Promise<GitProject | null> {
    return this.store.getProject(projectId);
  }

  public async listBranches(projectId: string): Promise<{
    readonly branches: readonly { readonly name: string; readonly current: boolean }[];
    readonly currentBranch: string;
    readonly dirty: boolean;
  }> {
    const project = await this.requireProject(projectId);
    const git = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    const status = await git.status();
    if (status.current === null) {
      throw new Error("The repository is in detached HEAD state and cannot switch branches here");
    }
    const branches = await git.branchLocal();
    return {
      currentBranch: status.current,
      dirty: !status.isClean(),
      branches: branches.all.map((name) => ({ name, current: name === status.current }))
    };
  }

  public async switchBranch(
    projectId: string,
    branchName: string
  ): Promise<{ readonly currentBranch: string; readonly headCommit: string }> {
    assertSafeGitRef(branchName);
    const project = await this.requireProject(projectId);
    const git = simpleGit({ baseDir: project.canonicalRootPath, maxConcurrentProcesses: 1 });
    const status = await git.status();
    if (!status.isClean()) {
      throw new Error("Commit or stash local changes before switching branches");
    }
    const branches = await git.branchLocal();
    if (!branches.all.includes(branchName)) {
      throw new Error(`Local Git branch does not exist: ${branchName}`);
    }
    if (status.current !== branchName) {
      await git.checkout(branchName);
    }
    const headCommit = (await git.revparse(["HEAD"])).trim();
    await this.store.saveProject({
      ...project,
      headCommit,
      updatedAt: this.now().toISOString()
    });
    return { currentBranch: branchName, headCommit };
  }

  public async addDirectory(selectedPath: string): Promise<GitProject> {
    const selectedDirectory = await canonicalizeDirectory(selectedPath);
    const selectedGit = simpleGit({ baseDir: selectedDirectory, maxConcurrentProcesses: 1 });
    let reportedRoot: string;
    try {
      reportedRoot = (await selectedGit.revparse(["--show-toplevel"])).trim();
    } catch {
      throw new Error("Selected directory is not inside a Git repository");
    }
    const canonicalRootPath = await canonicalizeDirectory(reportedRoot);
    ensurePathInside(canonicalRootPath, selectedDirectory, "Selected project path");

    const existing = await this.store.findProjectByCanonicalRoot(canonicalRootPath);
    const repositoryGit = simpleGit({ baseDir: canonicalRootPath, maxConcurrentProcesses: 1 });
    let headCommit: string;
    try {
      headCommit = (await repositoryGit.revparse(["HEAD"])).trim();
    } catch {
      throw new Error("Git repository must contain at least one commit before it can be added");
    }
    const defaultBranch = await detectDefaultBranch(repositoryGit);
    const timestamp = this.now().toISOString();
    const project: GitProject = {
      id: existing?.id ?? this.id(),
      name: basename(canonicalRootPath),
      rootPath: canonicalRootPath,
      canonicalRootPath,
      defaultBranch,
      headCommit,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    await this.store.saveProject(project);
    return project;
  }

  /**
   * Turns a user-selected local folder into a usable local-first project. The bootstrap commit is empty:
   * existing files are never staged, inspected or modified by Compazio merely to open a folder.
   */
  public async initializeDirectory(selectedPath: string): Promise<GitProject> {
    const selectedDirectory = await canonicalizeDirectory(selectedPath);
    const git = simpleGit({ baseDir: selectedDirectory, maxConcurrentProcesses: 1 });
    try {
      await git.revparse(["--show-toplevel"]);
    } catch {
      await git.init(["--initial-branch=main"]);
    }
    try {
      await git.revparse(["HEAD"]);
    } catch {
      // Do not write user.name/user.email to global or local Git configuration. This identity exists only
      // on the empty bootstrap commit required by the worktree model; users remain free to configure Git.
      await git.raw([
        "-c",
        "user.name=Compazio",
        "-c",
        "user.email=compazio@local",
        "commit",
        "--allow-empty",
        "-m",
        "chore: initialize project"
      ]);
    }
    return this.addDirectory(selectedDirectory);
  }

  public async cloneGitHub(
    repositoryUrl: string,
    destinationDirectory: string
  ): Promise<GitProject> {
    const repository = parseGitHubRepositoryUrl(repositoryUrl);
    const destination = await canonicalizeDirectory(destinationDirectory);
    const checkoutDirectory = join(destination, repository.repository);
    ensurePathInside(destination, checkoutDirectory, "GitHub clone destination");
    try {
      await access(checkoutDirectory);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      await simpleGit({ baseDir: destination, maxConcurrentProcesses: 1 }).clone(
        repository.cloneUrl,
        checkoutDirectory,
        ["--origin", "origin"]
      );
      return this.addDirectory(checkoutDirectory);
    }
    throw new Error("GitHub clone destination already exists");
  }

  private async requireProject(projectId: string): Promise<GitProject> {
    const project = await this.store.getProject(projectId);
    if (project === null) throw new Error("Git project was not found");
    return project;
  }
}

async function detectDefaultBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const remoteHead = (
      await git.raw(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    )
      .trim()
      .replace(/^origin\//, "");
    if (remoteHead.length > 0) {
      return remoteHead;
    }
  } catch {
    // A local-only repository is valid and may not have origin/HEAD.
  }

  const status = await git.status();
  const branches = await git.branchLocal();
  const current = status.current === null ? [] : [status.current];
  const fallback = ["main", "master", ...current, ...branches.all].find((branch) =>
    branches.all.includes(branch)
  );
  if (fallback === undefined) {
    throw new Error("Git repository does not have a local branch");
  }
  return fallback;
}
