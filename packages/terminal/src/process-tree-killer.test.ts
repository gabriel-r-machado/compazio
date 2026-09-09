import { describe, expect, it, vi } from "vitest";

import { PlatformProcessTreeKiller } from "./process-tree-killer";
import type { ProcessTreeKillError } from "./process-tree-killer";

describe("PlatformProcessTreeKiller on Windows", () => {
  it("skips taskkill when the process has already exited", async () => {
    const killWindowsTree = vi.fn(async () => undefined);
    const killer = new PlatformProcessTreeKiller({
      platform: "win32",
      isProcessAlive: () => false,
      killWindowsTree
    });

    await expect(killer.kill(42)).resolves.toBeUndefined();
    expect(killWindowsTree).not.toHaveBeenCalled();
  });

  it("treats a process exiting during taskkill as completed cleanup", async () => {
    const killWindowsTree = vi.fn(async () => {
      throw new Error("taskkill raced with exit");
    });
    let checks = 0;
    const killer = new PlatformProcessTreeKiller({
      platform: "win32",
      isProcessAlive: () => {
        checks += 1;
        return checks === 1;
      },
      killWindowsTree
    });

    await expect(killer.kill(42)).resolves.toBeUndefined();
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
  });

  it("surfaces a real taskkill failure while the process is still alive", async () => {
    const rootCause = new Error("access denied");
    const killer = new PlatformProcessTreeKiller({
      platform: "win32",
      isProcessAlive: () => true,
      killWindowsTree: async () => {
        throw rootCause;
      }
    });

    await expect(killer.kill(42)).rejects.toMatchObject({
      name: "ProcessTreeKillError",
      cause: rootCause
    } satisfies Partial<ProcessTreeKillError>);
  });
});
