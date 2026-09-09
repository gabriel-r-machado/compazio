import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type {
  GitChangedFile,
  GitFileStatus,
  GitRepositorySnapshot
} from "@forgedeck/compazio-v2-domain";

import { normalizeRelative } from "./file-system-service";

const defaultTimeoutMs = 30_000;
const maximumOutputBytes = 1_048_576;

export type GitErrorCode =
  | "GIT_NOT_INSTALLED"
  | "GIT_REPOSITORY_NOT_FOUND"
  | "GIT_COMMAND_FAILED"
  | "GIT_CONFLICT"
  | "GIT_DIRTY_WORKTREE"
  | "GIT_AUTH_REQUIRED"
  | "DIFF_NOT_AVAILABLE";

export class GitServiceError extends Error {
  public constructor(
    public readonly code: GitErrorCode,
    message: string,
    public readonly technicalDetails?: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "GitServiceError";
  }
}

export interface GitServiceOptions {
  readonly workspaceRoot: (workspaceId: string) => Promise<string>;
  readonly executable?: string;
  readonly now?: () => string;
}

/** Runs Git directly with argument arrays; no renderer input is ever interpolated into a shell. */
export class GitService {
  private readonly executable: string;
  private readonly now: () => string;

  public constructor(private readonly options: GitServiceOptions) {
    this.executable = options.executable ?? "git";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async status(workspaceId: string): Promise<GitRepositorySnapshot> {
    const root = await this.repositoryRoot(workspaceId);
    const [branchResult, statusResult] = await Promise.all([
      this.run(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      this.run(root, ["status", "--porcelain=v1", "--branch"])
    ]);
    const first = statusResult.stdout.split(/\r?\n/)[0] ?? "";
    const upstream = parseAheadBehind(first);
    const branch = branchResult.stdout.trim();
    return {
      repositoryRoot: ".",
      ...(branch === "HEAD" ? {} : { branch }),
      detached: branch === "HEAD",
      ahead: upstream.ahead,
      behind: upstream.behind,
      files: [...parseStatus(statusResult.stdout)],
      updatedAt: this.now()
    };
  }

  public async diff(workspaceId: string, path?: string, staged = false): Promise<string> {
    const root = await this.repositoryRoot(workspaceId);
    const args = ["diff", "--no-ext-diff", "--unified=3", ...(staged ? ["--cached"] : [])];
    if (path !== undefined) args.push("--", normalizeRelative(path));
    const result = await this.run(root, args);
    if (result.stdout.length > maximumOutputBytes) {
      throw new GitServiceError(
        "DIFF_NOT_AVAILABLE",
        "O diff é grande demais para esta revisão contextual."
      );
    }
    return result.stdout;
  }

  public async stage(
    workspaceId: string,
    paths: readonly string[]
  ): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["add", "--", ...paths.map(normalizeRelative)]);
  }

  public async unstage(
    workspaceId: string,
    paths: readonly string[]
  ): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["restore", "--staged", "--", ...paths.map(normalizeRelative)]);
  }

  public async commit(workspaceId: string, message: string): Promise<GitRepositorySnapshot> {
    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.length > 240) {
      throw new GitServiceError(
        "GIT_COMMAND_FAILED",
        "Informe uma mensagem de commit entre 1 e 240 caracteres."
      );
    }
    return this.mutate(workspaceId, ["commit", "-m", trimmed], 60_000);
  }

  public async fetch(workspaceId: string): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["fetch", "--prune"], 60_000);
  }

  public async pull(workspaceId: string): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["pull", "--ff-only"], 60_000);
  }

  public async push(workspaceId: string): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["push"], 60_000);
  }

  public async checkout(workspaceId: string, branch: string): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["checkout", validateBranch(branch)]);
  }

  public async createBranch(workspaceId: string, branch: string): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, ["checkout", "-b", validateBranch(branch)]);
  }

  public async stash(workspaceId: string, message?: string): Promise<GitRepositorySnapshot> {
    return this.mutate(workspaceId, [
      "stash",
      "push",
      ...(message?.trim() ? ["-m", message.trim()] : [])
    ]);
  }

  public async applyStash(
    workspaceId: string,
    reference = "stash@{0}"
  ): Promise<GitRepositorySnapshot> {
    if (!/^stash@\{\d+\}$/.test(reference)) {
      throw new GitServiceError("GIT_COMMAND_FAILED", "A referência de stash é inválida.");
    }
    return this.mutate(workspaceId, ["stash", "apply", reference]);
  }

  public async listStashes(
    workspaceId: string
  ): Promise<readonly { readonly reference: string; readonly message: string }[]> {
    const root = await this.repositoryRoot(workspaceId);
    const result = await this.run(root, ["stash", "list", "--format=%gd%x00%s"]);
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        const [reference, message] = line.split("\0", 2);
        return reference === undefined || message === undefined ? [] : [{ reference, message }];
      });
  }

  private async mutate(
    workspaceId: string,
    args: readonly string[],
    timeoutMs = defaultTimeoutMs
  ): Promise<GitRepositorySnapshot> {
    const root = await this.repositoryRoot(workspaceId);
    await this.run(root, args, timeoutMs);
    return this.status(workspaceId);
  }

  private async repositoryRoot(workspaceId: string): Promise<string> {
    const workspaceRoot = await realpath(await this.options.workspaceRoot(workspaceId));
    try {
      const result = await this.run(workspaceRoot, ["rev-parse", "--show-toplevel"]);
      const repositoryRoot = await realpath(result.stdout.trim());
      const difference = relative(workspaceRoot, repositoryRoot);
      if (difference !== "" || isAbsolute(difference)) {
        throw new GitServiceError(
          "GIT_REPOSITORY_NOT_FOUND",
          "A raiz do repositório Git deve estar dentro do workspace selecionado."
        );
      }
      return repositoryRoot;
    } catch (error: unknown) {
      if (error instanceof GitServiceError) {
        if (error.code === "GIT_NOT_INSTALLED") throw error;
        throw new GitServiceError(
          "GIT_REPOSITORY_NOT_FOUND",
          "Este workspace nÃ£o contÃ©m um repositÃ³rio Git.",
          error.technicalDetails
        );
      }
      throw new GitServiceError(
        "GIT_REPOSITORY_NOT_FOUND",
        "Este workspace não contém um repositório Git."
      );
    }
  }

  private run(
    cwd: string,
    args: readonly string[],
    timeoutMs = defaultTimeoutMs
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve({ stdout, stderr });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(
          new GitServiceError(
            "GIT_COMMAND_FAILED",
            "A operação Git excedeu o tempo permitido.",
            undefined,
            true
          )
        );
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(0, maximumOutputBytes + 1);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(0, 32_000);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(
          new GitServiceError(
            error.code === "ENOENT" ? "GIT_NOT_INSTALLED" : "GIT_COMMAND_FAILED",
            error.code === "ENOENT"
              ? "Git não está instalado ou não está disponível no PATH."
              : "Não foi possível iniciar o Git.",
            error.message
          )
        );
      });
      child.once("exit", (code) => {
        if (code === 0) return finish();
        const details = stderr.slice(0, 4_000);
        const failureCode: GitErrorCode = /conflict/i.test(stderr)
          ? "GIT_CONFLICT"
          : /auth|credential|permission denied/i.test(stderr)
            ? "GIT_AUTH_REQUIRED"
            : "GIT_COMMAND_FAILED";
        finish(
          new GitServiceError(
            failureCode,
            "A operação Git não foi concluída.",
            details,
            failureCode !== "GIT_CONFLICT"
          )
        );
      });
    });
  }
}

function parseAheadBehind(header: string): { readonly ahead: number; readonly behind: number } {
  const ahead = /ahead (\d+)/.exec(header)?.[1];
  const behind = /behind (\d+)/.exec(header)?.[1];
  return {
    ahead: ahead === undefined ? 0 : Number(ahead),
    behind: behind === undefined ? 0 : Number(behind)
  };
}

function parseStatus(stdout: string): readonly GitChangedFile[] {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .flatMap((line) => {
      const xy = line.slice(0, 2);
      const rawPath = line.slice(3);
      if (rawPath === "") return [];
      const status = statusFor(xy);
      if (status === null) return [];
      return [{ path: normalizeRelative(rawPath), status, staged: xy[0] !== " " }];
    });
}

function statusFor(xy: string): GitFileStatus | null {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflicted";
  if (xy.includes("?")) return "untracked";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  if (xy.includes("M")) return "modified";
  return null;
}

function validateBranch(value: string): string {
  const branch = value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/")
  ) {
    throw new GitServiceError("GIT_COMMAND_FAILED", "O nome da branch é inválido.");
  }
  return branch;
}
