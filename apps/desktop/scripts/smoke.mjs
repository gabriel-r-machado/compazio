import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import electronPath from "electron";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");
const smokeUserData = await mkdtemp(join(tmpdir(), "forgedeck-smoke-"));
const smokeProjectRoot = await mkdtemp(join(tmpdir(), "forgedeck-smoke-project-"));

await initializeSmokeProject(smokeProjectRoot);

// The product smoke is a real Electron launch. Rebuild before it and restore the host Node ABI in
// finally so this gate is independently runnable and cannot leave the workspace in Electron ABI.
try {
  await runNodeScript("native:electron", join(scriptDirectory, "native-electron.mjs"));
  await runElectronSmoke();
} finally {
  try {
    await runNodeScript("native:node", join(scriptDirectory, "native-node.mjs"));
  } finally {
    rmSync(smokeUserData, { recursive: true, force: true });
    rmSync(smokeProjectRoot, { recursive: true, force: true });
  }
}

function runElectronSmoke() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronPath, ["."], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        FORGEDECK_SMOKE_TEST: "true",
        FORGEDECK_SMOKE_USER_DATA: smokeUserData,
        FORGEDECK_SMOKE_PROJECT_ROOT: smokeProjectRoot
      },
      stdio: "inherit",
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Desktop smoke test timed out"));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Desktop smoke test exited with code ${code ?? "unknown"}`));
    });
  });
}

async function initializeSmokeProject(projectRoot) {
  await writeFile(join(projectRoot, "README.md"), "# ForgeDeck smoke project\n", "utf8");
  await runGit(projectRoot, ["init", "--initial-branch=main"]);
  await runGit(projectRoot, ["config", "user.email", "smoke@forgedeck.local"]);
  await runGit(projectRoot, ["config", "user.name", "ForgeDeck smoke"]);
  await runGit(projectRoot, ["add", "README.md"]);
  await runGit(projectRoot, ["commit", "-m", "test(smoke): initialize fixture"]);
}

function runGit(projectRoot, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args[0]} exited with code ${code ?? "unknown"}`));
    });
  });
}

function runNodeScript(label, script) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n--- ${label} ---\n`);
    const child = spawn(process.execPath, [script], {
      cwd: desktopRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}
