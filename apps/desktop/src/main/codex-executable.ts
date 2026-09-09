import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DetectedExecutable, ExecutableDetector, RuntimePlatform } from "@forgedeck/agent-sdk";

/**
 * Safe resolution of the locally installed Codex binary — the ONE primitive the execution adapter and
 * the planning port share. Sharing this and the transport is deliberate; the planner never borrows the
 * execution adapter itself, because planning and execution are different jobs with different sandboxes.
 *
 * The npm entry point is a launcher script that only re-spawns the vendored native binary. We resolve
 * that binary and run it directly: a command shim cannot be spawned without a shell, which nothing here
 * ever uses, and the extra Node process would otherwise sit between the supervisor and the agent, which
 * is exactly what makes cancellation and tree termination unreliable.
 */

/** The npm package that ships Codex, and the vendored native binary inside it. */
const CODEX_PACKAGE_PATH = ["node_modules", "@openai", "codex"] as const;

/** Target triples exactly as Codex's own launcher maps them; never guessed. */
const CODEX_TARGET_TRIPLES: Readonly<Record<string, string>> = {
  "win32:x64": "x86_64-pc-windows-msvc",
  "win32:arm64": "aarch64-pc-windows-msvc",
  "darwin:x64": "x86_64-apple-darwin",
  "darwin:arm64": "aarch64-apple-darwin",
  "linux:x64": "x86_64-unknown-linux-musl",
  "linux:arm64": "aarch64-unknown-linux-musl"
};

/** Why Codex could not be resolved, in the caller's own error vocabulary. */
export type CodexExecutableFailure = "configured_missing" | "not_found" | "shim_unresolvable";

export class CodexExecutableError extends Error {
  public constructor(
    public readonly failure: CodexExecutableFailure,
    message: string
  ) {
    super(message);
    this.name = "CodexExecutableError";
  }
}

export interface CodexExecutableDeps {
  readonly detector: ExecutableDetector;
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Explicit executable to run. When set it is the only candidate; tests swap only this path. */
  readonly executablePath?: string | undefined;
  /** Overrides the detected CPU architecture when resolving the vendored binary (tests only). */
  readonly architecture?: string | undefined;
  /** Injectable existence check for a resolved native target; defaults to fs access. */
  readonly fileExists?: ((path: string) => Promise<boolean>) | undefined;
}

/** The launchable Codex binary, or a {@link CodexExecutableError} carrying an actionable reason. */
export async function resolveCodexExecutable(
  deps: CodexExecutableDeps
): Promise<DetectedExecutable> {
  const exists = deps.fileExists ?? defaultFileExists;
  if (deps.executablePath !== undefined) {
    if (!(await exists(deps.executablePath))) {
      throw new CodexExecutableError(
        "configured_missing",
        "The configured Codex executable does not exist."
      );
    }
    return { path: deps.executablePath, kind: "native" };
  }
  const detected = await deps.detector.find(["codex"], {
    platform: deps.platform,
    environment: deps.environment
  });
  if (detected === null) {
    throw new CodexExecutableError(
      "not_found",
      "Codex was not found. Install it and ensure `codex` is on PATH."
    );
  }
  const native = await resolveVendoredBinary(detected.path, deps, exists);
  if (native !== null) return { path: native, kind: "native" };
  if (detected.kind === "native") return detected;
  throw new CodexExecutableError(
    "shim_unresolvable",
    "Codex is installed only as a command shim whose native binary could not be resolved."
  );
}

/**
 * Finds the native binary the npm launcher wraps, in the two layouts Codex itself looks in. The result
 * is returned only when it exists at the expected vendored location — never a guess, never a generic
 * shell fallback, and never a path assembled from caller-supplied data.
 */
async function resolveVendoredBinary(
  entryPointPath: string,
  deps: CodexExecutableDeps,
  exists: (path: string) => Promise<boolean>
): Promise<string | null> {
  const architecture = deps.architecture ?? process.arch;
  const triple = CODEX_TARGET_TRIPLES[`${deps.platform}:${architecture}`];
  if (triple === undefined) return null;
  const binaryName = deps.platform === "win32" ? "codex.exe" : "codex";
  const packageRoot = join(dirname(entryPointPath), ...CODEX_PACKAGE_PATH);
  const candidates = [
    // The platform package npm installs as an optional dependency of @openai/codex.
    join(
      packageRoot,
      "node_modules",
      "@openai",
      `codex-${deps.platform}-${architecture}`,
      "vendor",
      triple,
      "bin",
      binaryName
    ),
    // The layout Codex's own launcher falls back to.
    join(packageRoot, "vendor", triple, "bin", binaryName)
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
