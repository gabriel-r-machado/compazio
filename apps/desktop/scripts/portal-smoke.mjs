import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");
const userData = await mkdtemp(join(tmpdir(), "compazio-portal-smoke-user-"));
const workspace = await mkdtemp(join(tmpdir(), "compazio-portal-smoke-workspace-"));
const portalExecutable = process.env.COMPAZIO_V2_PORTAL_EXECUTABLE ?? electronPath;

try {
  if (process.env.COMPAZIO_V2_PORTAL_EXECUTABLE === undefined)
    await run(
      "build:v2",
      process.platform === "win32"
        ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
        : "pnpm",
      process.platform === "win32" ? ["/d", "/s", "/c", "pnpm run build:v2"] : ["run", "build:v2"]
    );
  await run(
    "Portal Electron smoke",
    portalExecutable,
    [join(desktopRoot, "out-v2", "main", "index.js")],
    {
      COMPAZIO_V2_PORTAL_SMOKE: "true",
      COMPAZIO_V2_PORTAL_TEST_HOOKS: "true",
      COMPAZIO_V2_PORTAL_SMOKE_WORKSPACE: workspace,
      COMPAZIO_V2_DATA_DIR: join(userData, "compazio", "v2")
    }
  );
} finally {
  await rm(userData, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

function run(label, command, args, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, ...extraEnvironment }
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}
