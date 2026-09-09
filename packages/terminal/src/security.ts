import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { LaunchSpec, RuntimePlatform } from "@forgedeck/agent-sdk";

const allowedEnvironmentKeys = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI"
]);

/**
 * Builds the process environment from an allowlist. A real adapter may declare a small set of extra
 * keys it legitimately needs (for example an agent CLI's local profile directory or a managed output
 * path); those keys are unioned into the allowlist for this launch only. The values are never
 * persisted as workflow data — they flow straight from the live environment into the child.
 */
export function createAllowedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
  additionalAllowedKeys: readonly string[] = []
): Readonly<Record<string, string>> {
  const allowed = unionAllowedKeys(additionalAllowedKeys);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...source, ...overrides })) {
    if (value !== undefined && allowed.has(key.toUpperCase())) {
      output[key] = value;
    }
  }
  return output;
}

function unionAllowedKeys(additionalAllowedKeys: readonly string[]): ReadonlySet<string> {
  if (additionalAllowedKeys.length === 0) return allowedEnvironmentKeys;
  const union = new Set(allowedEnvironmentKeys);
  for (const key of additionalAllowedKeys) {
    union.add(key.toUpperCase());
  }
  return union;
}

export async function validateLaunchSpec(
  spec: LaunchSpec,
  allowedCwdRoots: readonly string[],
  platform: RuntimePlatform,
  additionalAllowedEnvKeys: readonly string[] = []
): Promise<void> {
  if (!isAbsolute(spec.executable.path)) {
    throw new Error("Executable path must be absolute");
  }
  if (spec.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Process arguments cannot contain null bytes");
  }
  if (spec.cols < 1 || spec.cols > 500 || spec.rows < 1 || spec.rows > 500) {
    throw new Error("Terminal dimensions are outside the allowed range");
  }
  if (allowedCwdRoots.length === 0) {
    throw new Error("At least one approved cwd root is required");
  }

  const executablePath = await realpath(spec.executable.path);
  await access(executablePath, platform === "win32" ? constants.F_OK : constants.X_OK);

  const cwd = await realpath(spec.cwd);
  const cwdStats = await stat(cwd);
  if (!cwdStats.isDirectory()) {
    throw new Error("Process cwd must be a directory");
  }

  const approvedRoots = await Promise.all(allowedCwdRoots.map((root) => realpath(resolve(root))));
  if (!approvedRoots.some((root) => isPathInside(root, cwd))) {
    throw new Error("Process cwd is outside the approved roots");
  }

  const allowedEnv = unionAllowedKeys(additionalAllowedEnvKeys);
  for (const key of Object.keys(spec.environment)) {
    if (!allowedEnv.has(key.toUpperCase())) {
      throw new Error(`Environment variable is not allowed: ${key}`);
    }
  }

  if (platform === "win32" && spec.executable.kind === "command-shim") {
    for (const argument of spec.args) {
      if (/[&|<>^()%!]/.test(argument)) {
        throw new Error("Windows command shim arguments contain shell metacharacters");
      }
    }
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}
