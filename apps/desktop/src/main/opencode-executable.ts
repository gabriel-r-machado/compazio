import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DetectedExecutable, ExecutableDetector, RuntimePlatform } from "@forgedeck/agent-sdk";

/**
 * Safe resolution of the locally installed OpenCode binary — the ONE primitive the execution adapter
 * and the planning port share. Sharing this and the transport is deliberate; the planner never borrows
 * the execution adapter itself, because planning and execution are different jobs.
 *
 * The npm shim invokes a native binary at a known location inside the package, so that binary is
 * resolved and launched directly: a command shim cannot be spawned without a shell, which nothing here
 * ever uses. Nothing is guessed and no command string is ever assembled.
 */

/** The npm package that ships OpenCode, and the native binary its shim invokes. */
const OPENCODE_PACKAGE_BINARY = ["node_modules", "opencode-ai", "bin"] as const;

export type OpenCodeExecutableFailure = "configured_missing" | "not_found" | "shim_unresolvable";

export class OpenCodeExecutableError extends Error {
  public constructor(
    public readonly failure: OpenCodeExecutableFailure,
    message: string
  ) {
    super(message);
    this.name = "OpenCodeExecutableError";
  }
}

export interface OpenCodeExecutableDeps {
  readonly detector: ExecutableDetector;
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Explicit executable to run. When set it is the only candidate; tests swap only this path. */
  readonly executablePath?: string | undefined;
  /** Injectable existence check for a resolved native target; defaults to fs access. */
  readonly fileExists?: ((path: string) => Promise<boolean>) | undefined;
}

/** The launchable OpenCode binary, or an {@link OpenCodeExecutableError} with an actionable reason. */
export async function resolveOpenCodeExecutable(
  deps: OpenCodeExecutableDeps
): Promise<DetectedExecutable> {
  const exists = deps.fileExists ?? defaultFileExists;
  if (deps.executablePath !== undefined) {
    if (!(await exists(deps.executablePath))) {
      throw new OpenCodeExecutableError(
        "configured_missing",
        "The configured OpenCode executable does not exist."
      );
    }
    return { path: deps.executablePath, kind: "native" };
  }
  const detected = await deps.detector.find(["opencode"], {
    platform: deps.platform,
    environment: deps.environment
  });
  if (detected === null) {
    throw new OpenCodeExecutableError(
      "not_found",
      "OpenCode was not found. Install it and ensure `opencode` is on PATH."
    );
  }
  const native = await resolveNativeBinary(detected.path, deps, exists);
  if (native !== null) return { path: native, kind: "native" };
  if (detected.kind === "native") return detected;
  throw new OpenCodeExecutableError(
    "shim_unresolvable",
    "OpenCode is installed only as a command shim whose native binary could not be resolved."
  );
}

/** The native binary the npm shim invokes, returned only when it exists at the expected location. */
async function resolveNativeBinary(
  entryPointPath: string,
  deps: OpenCodeExecutableDeps,
  exists: (path: string) => Promise<boolean>
): Promise<string | null> {
  const binaryName = deps.platform === "win32" ? "opencode.exe" : "opencode";
  const candidate = join(dirname(entryPointPath), ...OPENCODE_PACKAGE_BINARY, binaryName);
  return (await exists(candidate)) ? candidate : null;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
