import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

// End-to-end driver for the workflow Electron smoke.
//
//   1. rebuild better-sqlite3 for the Electron ABI (canonical native-electron.mjs);
//   2. run the smoke through two real Electron launches (produce, then close + reopen);
//   3. ALWAYS restore the host Node ABI (canonical native-node.mjs), even on failure.
//
// The gates run pnpm build first (Node ABI). Only the native module ABI toggles here; the bundle is
// reused. Every scenario gets its own isolated database and artifact directory inside a temp root.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const smokeMain = join(desktopRoot, "out-e2e", "main", "e2e", "workflow-smoke.js");
const harnessPath = join(desktopRoot, "out-e2e", "renderer", "workflow-overlay-harness.html");
const preloadPath = join(desktopRoot, "out", "preload", "index.cjs");
const fakeAgentPath = join(repoRoot, "packages", "fake-agent", "bin", "fake-agent.mjs");
// The fixture runs as `node <fixture.mjs>` over the pipe transport on every platform (no .cmd shim).
const claudeFixturePath = join(desktopRoot, "e2e", "fixtures", "claude-code-fixture.mjs");
const codexFixturePath = join(desktopRoot, "e2e", "fixtures", "codex-fixture.mjs");
const openCodeFixturePath = join(desktopRoot, "e2e", "fixtures", "opencode-fixture.mjs");
// The planner stand-in for `codex exec`. Like every other fixture it lives outside the shipped bundle.
const codexPlannerFixturePath = join(desktopRoot, "e2e", "fixtures", "codex-planner-fixture.mjs");
const openCodePlannerFixturePath = join(
  desktopRoot,
  "e2e",
  "fixtures",
  "opencode-planner-fixture.mjs"
);

async function main() {
  if (!existsSync(preloadPath)) {
    process.stderr.write(
      `Production preload not built at ${preloadPath}. Run "pnpm build" first.\n`
    );
    return 1;
  }
  if (!existsSync(fakeAgentPath)) {
    process.stderr.write(`fake-agent binary not found at ${fakeAgentPath}.\n`);
    return 1;
  }

  const userData = await mkdtemp(join(tmpdir(), "forgedeck-workflow-smoke-"));
  let exitCode = 0;
  try {
    // Build the isolated smoke composition root (never part of the production bundle).
    await runShell("electron-vite smoke build", "pnpm", [
      "exec",
      "electron-vite",
      "build",
      "--config",
      "electron.vite.e2e.config.ts"
    ]);
    if (!existsSync(smokeMain)) {
      throw new Error(`Smoke main was not built at ${smokeMain}`);
    }
    if (!existsSync(harnessPath)) {
      throw new Error(`Smoke renderer harness was not built at ${harnessPath}`);
    }
    await runScript("native:electron", join(desktopRoot, "scripts", "native-electron.mjs"));
    for (const phase of ["run", "reload"]) {
      const code = await runElectron(phase, userData);
      if (code !== 0) {
        process.stderr.write(`Workflow smoke phase "${phase}" failed with code ${code}\n`);
        exitCode = code;
        break;
      }
    }
  } catch (error) {
    process.stderr.write(`Workflow smoke driver error: ${error?.message ?? error}\n`);
    exitCode = 1;
  } finally {
    try {
      await runScript("native:node", join(desktopRoot, "scripts", "native-node.mjs"));
    } catch (error) {
      process.stderr.write(`Failed to restore Node ABI: ${error?.message ?? error}\n`);
      exitCode = exitCode === 0 ? 1 : exitCode;
    }
    rmSync(userData, { recursive: true, force: true });
  }
  return exitCode;
}

function runElectron(phase, userData) {
  return new Promise((resolvePromise) => {
    const child = spawn(electronPath, [smokeMain], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        FORGEDECK_WORKFLOW_SMOKE_PHASE: phase,
        FORGEDECK_WORKFLOW_SMOKE_USER_DATA: userData,
        FORGEDECK_FAKE_AGENT_PATH: fakeAgentPath,
        FORGEDECK_CLAUDE_FIXTURE_PATH: claudeFixturePath,
        FORGEDECK_CODEX_FIXTURE_PATH: codexFixturePath,
        FORGEDECK_OPENCODE_FIXTURE_PATH: openCodeFixturePath,
        FORGEDECK_CODEX_PLANNER_FIXTURE_PATH: codexPlannerFixturePath,
        FORGEDECK_OPENCODE_PLANNER_FIXTURE_PATH: openCodePlannerFixturePath,
        FORGEDECK_SMOKE_HARNESS_PATH: harnessPath,
        FORGEDECK_SMOKE_PRELOAD_PATH: preloadPath,
        FORGEDECK_SMOKE_MIGRATIONS_DIR: join(repoRoot, "packages", "local-db", "drizzle"),
        // Electron's process.execPath is not Node; give the child a real Node binary to run the
        // fake-agent through the ProcessSupervisor.
        FORGEDECK_SMOKE_NODE_PATH: process.execPath
      },
      stdio: "inherit",
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      child.kill();
      process.stderr.write(`Workflow smoke phase "${phase}" timed out\n`);
      resolvePromise(1);
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      process.stderr.write(`Workflow smoke phase "${phase}" could not start: ${error.message}\n`);
      resolvePromise(1);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise(code ?? 1);
    });
  });
}

// Runs a local Node script. No shell, so an executable path containing spaces is passed verbatim.
function runScript(label, scriptPath) {
  return runProcess(label, process.execPath, [scriptPath], false);
}

// Runs a PATH command (e.g. pnpm) that on Windows needs a shell to resolve its .cmd shim.
function runShell(label, command, args) {
  return runProcess(label, command, args, process.platform === "win32");
}

function runProcess(label, command, args, shell) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n--- ${label} ---\n`);
    const child = spawn(command, args, {
      cwd: desktopRoot,
      stdio: "inherit",
      windowsHide: true,
      shell
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}

process.exitCode = await main();
