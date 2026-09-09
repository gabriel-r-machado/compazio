import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rebuild } from "@electron/rebuild";

const require = createRequire(import.meta.url);
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDirectory, "../../..");
const electronVersion = require("electron/package.json").version;

if (process.platform === "win32" && process.env.npm_config_msvs_version === undefined) {
  const buildTools2022 = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools";
  const msbuild = resolve(buildTools2022, "MSBuild/Current/Bin/MSBuild.exe");
  if (existsSync(msbuild)) {
    process.env.npm_config_msvs_version = buildTools2022;
  }
}

await rebuild({
  buildPath: projectRoot,
  projectRootPath: projectRoot,
  electronVersion,
  force: true,
  onlyModules: ["better-sqlite3", "node-pty"]
});

// pnpm's content-addressed layout can make @electron/rebuild report success
// while leaving better-sqlite3's real package directory on the host Node ABI.
// Windows keeps the explicit package-directory rebuild because it is required by
// the NSIS smoke. On Unix, @electron/rebuild is authoritative: a second raw
// node-gyp invocation is not portable across GCC/Clang and Electron headers.
if (process.platform === "win32") {
  const betterSqliteDirectory = dirname(require.resolve("better-sqlite3/package.json"));
  await run(
    process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/s", "/c", "npm.cmd", "run", "build-release"],
    betterSqliteDirectory,
    {
      ...process.env,
      npm_config_runtime: "electron",
      npm_config_target: electronVersion,
      npm_config_dist_url: "https://electronjs.org/headers",
      npm_config_build_from_source: "true"
    }
  );
}

process.stdout.write("Rebuild Complete\n");

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
