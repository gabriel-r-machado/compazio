#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageDirectory, "..", "..");
const desktopRequire = createRequire(
  pathToFileURL(join(workspaceRoot, "apps", "desktop", "package.json"))
);
const electronExecutable = desktopRequire("electron");
const entrypoint = join(packageDirectory, "src", "bin.ts");
const result = spawnSync(
  electronExecutable,
  ["--import", "tsx", entrypoint, ...process.argv.slice(2)],
  {
    cwd: packageDirectory,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  }
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
