import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";

import { LEGACY_COORDINATOR_TEMP_PREFIX } from "@forgedeck/compazio-v2-domain";

// Pre-rename harness roots must stay removable, otherwise they leak in the temporary directory.
const managedPrefixes = ["compazio-agents-real-", LEGACY_COORDINATOR_TEMP_PREFIX] as const;
const retryableCodes = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

export interface CompazioTempCleanupResult {
  readonly attempts: number;
}

export class CompazioTempCleanupError extends Error {
  public constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly attempts: number
  ) {
    super(message);
    this.name = "CompazioTempCleanupError";
  }
}

/**
 * Removes only a harness-owned temporary root after all clients, streams and MCP transports have
 * been closed. Windows may briefly retain a directory handle; retries are deliberately narrow and
 * diagnostic instead of silently swallowing cleanup failures.
 */
export async function cleanupCompazioTemporaryDirectory(
  directory: string,
  options: {
    readonly maxAttempts?: number;
    readonly retryDelayMs?: number;
    readonly remove?: (path: string) => Promise<void>;
    readonly delay?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<CompazioTempCleanupResult> {
  assertManagedTemporaryDirectory(directory);
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 4, 1), 8);
  const retryDelayMs = Math.min(Math.max(options.retryDelayMs ?? 50, 1), 500);
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));

  let lastCode: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await remove(directory);
      return { attempts: attempt };
    } catch (error: unknown) {
      lastCode = errorCode(error);
      if (!retryableCodes.has(lastCode ?? "") || attempt === maxAttempts) {
        throw new CompazioTempCleanupError(
          `Could not remove managed Compazio temporary directory after ${attempt} attempt(s).`,
          lastCode,
          attempt
        );
      }
      await delay(retryDelayMs * attempt);
    }
  }
  throw new CompazioTempCleanupError(
    "Could not remove managed Compazio temporary directory.",
    lastCode,
    maxAttempts
  );
}

function assertManagedTemporaryDirectory(directory: string): void {
  const resolved = resolve(directory);
  const temporaryRoot = resolve(tmpdir());
  const pathFromTemporaryRoot = relative(temporaryRoot, resolved);
  if (
    pathFromTemporaryRoot === "" ||
    pathFromTemporaryRoot === ".." ||
    pathFromTemporaryRoot.startsWith("..\\") ||
    pathFromTemporaryRoot.startsWith("../") ||
    managedPrefixes.some((prefix) => basename(resolved).startsWith(prefix)) === false
  ) {
    throw new CompazioTempCleanupError(
      "Refusing to remove a directory outside the managed Compazio temporary root.",
      undefined,
      0
    );
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
