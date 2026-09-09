import { execFile } from "node:child_process";
import { join } from "node:path";

import type { ProcessTreeKiller } from "./types";

export interface PlatformProcessTreeKillerOptions {
  /** Injectable only to make Windows cleanup races deterministic in tests. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Injectable only to make Windows taskkill outcomes deterministic in tests. */
  readonly killWindowsTree?: (pid: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
}

export class ProcessTreeKillError extends Error {
  public override readonly cause?: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProcessTreeKillError";
    this.cause = cause;
  }
}

export class PlatformProcessTreeKiller implements ProcessTreeKiller {
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly killWindowsTree: (pid: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;

  public constructor(options: PlatformProcessTreeKillerOptions = {}) {
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.killWindowsTree = options.killWindowsTree ?? killWindowsTree;
    this.platform = options.platform ?? process.platform;
  }

  public async kill(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Cannot kill an invalid process id");
    }
    if (this.platform === "win32") {
      // Do not fall back to `node-pty.kill()` for a PID which has already exited. On ConPTY this
      // fallback starts node-pty's AttachConsole helper after cleanup, producing a misleading error.
      if (!this.isProcessAlive(pid)) return;
      try {
        await this.killWindowsTree(pid);
      } catch (error: unknown) {
        // A child may exit between the preflight and taskkill. That is a successful cleanup, not a
        // reason to invoke the PTY fallback. Any still-live process remains a genuine failure.
        if (!this.isProcessAlive(pid)) return;
        throw new ProcessTreeKillError(`Unable to terminate Windows process tree ${pid}`, error);
      }
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The process may not be a group leader; fall back to the direct PID.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error: unknown) {
      if (!isMissingProcessError(error)) throw error;
    }
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isMissingProcessError(error);
  }
}

function killWindowsTree(pid: number): Promise<void> {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkill = join(windowsDirectory, "System32", "taskkill.exe");
  return new Promise<void>((resolve, reject) => {
    execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EINVAL")
  );
}
