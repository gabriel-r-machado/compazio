import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimePlatform } from "@forgedeck/agent-sdk";

/**
 * Installs the `compazio` command an agent reaches from inside its own terminal.
 *
 * The command is a tiny shim, not a copy of the product: it runs the app's own Electron binary with
 * `ELECTRON_RUN_AS_NODE=1` against the bundled CLI entrypoint. That keeps the native `better-sqlite3`
 * binding on the ABI it was built for, and means the agent always talks to the CLI that shipped with
 * the running app rather than a stale global install.
 *
 * The shim contains only paths this process controls. Nothing an agent types reaches it — arguments
 * are forwarded to the CLI, which validates them itself.
 */

export interface ProvisionCompazioCliInput {
  /** Directory the shim is written to; it is prepended to a terminal session's PATH. */
  readonly binDirectory: string;
  /** Absolute path of the Electron binary running this process. */
  readonly electronExecutable: string;
  /** Absolute path of the bundled CLI entrypoint inside the app. */
  readonly cliEntrypoint: string;
  readonly platform: RuntimePlatform;
}

export interface ProvisionedCompazioCli {
  readonly binDirectory: string;
  readonly commandPath: string;
}

export const COMPAZIO_CLI_COMMAND = "compazio";

export function provisionCompazioCli(input: ProvisionCompazioCliInput): ProvisionedCompazioCli {
  assertAbsolutePath(input.electronExecutable, "Electron executable");
  assertAbsolutePath(input.cliEntrypoint, "CLI entrypoint");

  const commandPath = join(
    input.binDirectory,
    input.platform === "win32" ? `${COMPAZIO_CLI_COMMAND}.cmd` : COMPAZIO_CLI_COMMAND
  );
  const contents =
    input.platform === "win32"
      ? windowsShim(input.electronExecutable, input.cliEntrypoint)
      : posixShim(input.electronExecutable, input.cliEntrypoint);

  mkdirSync(input.binDirectory, { recursive: true });
  // An app update moves both paths, so the shim is rewritten whenever it no longer matches. Reading
  // first keeps an unchanged install from rewriting a file on every launch.
  if (readFileIfPresent(commandPath) !== contents) {
    writeFileSync(commandPath, contents, "utf8");
  }
  if (input.platform !== "win32") {
    chmodSync(commandPath, 0o755);
  }
  return { binDirectory: input.binDirectory, commandPath };
}

/**
 * Puts `directory` first on PATH without disturbing the rest of the environment. On Windows the
 * variable's name is case-insensitive and commonly arrives as `Path`, so the existing entry is
 * replaced under the name it already has instead of adding a second one.
 */
export function prependToPath(
  environment: Readonly<Record<string, string>>,
  directory: string,
  platform: RuntimePlatform
): Readonly<Record<string, string>> {
  const separator = platform === "win32" ? ";" : ":";
  const existingKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH");
  const existingValue = existingKey === undefined ? "" : (environment[existingKey] ?? "");
  const value = existingValue.length === 0 ? directory : `${directory}${separator}${existingValue}`;
  return { ...environment, [existingKey ?? "PATH"]: value };
}

function windowsShim(electronExecutable: string, cliEntrypoint: string): string {
  return [
    "@echo off",
    "setlocal",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${electronExecutable}" "${cliEntrypoint}" %*`,
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
}

function posixShim(electronExecutable: string, cliEntrypoint: string): string {
  return [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec "${electronExecutable}" "${cliEntrypoint}" "$@"`,
    ""
  ].join("\n");
}

function readFileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function assertAbsolutePath(value: string, label: string): void {
  // Both are supplied by the main process, never by a renderer or an agent. A relative path would
  // silently resolve against whatever cwd the agent's terminal happens to have.
  const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(value);
  if (!absolute) {
    throw new Error(`${label} path must be absolute`);
  }
}
