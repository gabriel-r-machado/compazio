import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Canonical script to (re)build better-sqlite3 for the current Node ABI. It is the single place that
// restores the host Node binding after the Electron smoke rebuilds it for the Electron ABI. Keep the
// Electron rebuild in native-electron.mjs and the Node rebuild here; do not duplicate rebuild logic.

const require = createRequire(import.meta.url);
const currentDirectory = dirname(fileURLToPath(import.meta.url));
void currentDirectory;

if (process.platform === "win32" && process.env.npm_config_msvs_version === undefined) {
  const buildTools2022 = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools";
  const msbuild = resolve(buildTools2022, "MSBuild/Current/Bin/MSBuild.exe");
  if (existsSync(msbuild)) {
    process.env.npm_config_msvs_version = buildTools2022;
  }
}

const betterSqliteDirectory = dirname(require.resolve("better-sqlite3/package.json"));
await run(
  process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "npm",
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "run", "build-release"]
    : ["run", "build-release"],
  betterSqliteDirectory,
  {
    ...process.env,
    // Default runtime is Node; force a from-source rebuild so a prior Electron build is replaced.
    npm_config_build_from_source: "true"
  }
);

// Record the ABI marker for a quick, test-free diagnosis of the current binding.
writeFileSync(
  join(betterSqliteDirectory, "build", "Release", ".forge-meta"),
  `${process.arch}--${process.versions.modules}`,
  { encoding: "utf8" }
);

process.stdout.write(`Restored better-sqlite3 to Node ABI ${process.versions.modules}\n`);

function run(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}
