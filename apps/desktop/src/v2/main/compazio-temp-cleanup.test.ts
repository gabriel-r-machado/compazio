import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupCompazioTemporaryDirectory,
  CompazioTempCleanupError
} from "./compazio-temp-cleanup";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Compazio temporary cleanup", () => {
  it("retries a transient open-handle failure and removes the root after the handle is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-agents-real-cleanup-"));
    roots.push(root);
    const handle = await open(join(root, "open-handle.txt"), "w");
    let held = true;
    let attempts = 0;
    const result = await cleanupCompazioTemporaryDirectory(root, {
      maxAttempts: 3,
      retryDelayMs: 1,
      remove: async (path) => {
        attempts += 1;
        if (held) {
          const error = Object.assign(new Error("temporary handle is still open"), {
            code: "EBUSY"
          });
          throw error;
        }
        await rm(path, { recursive: true, force: true });
      },
      delay: async () => {
        held = false;
        await handle.close();
      }
    });

    expect(result).toEqual({ attempts: 2 });
    expect(attempts).toBe(2);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses roots outside the harness-owned temporary namespace", async () => {
    await expect(cleanupCompazioTemporaryDirectory(process.cwd())).rejects.toBeInstanceOf(
      CompazioTempCleanupError
    );
  });
});
