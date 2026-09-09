import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
const agents = [
  ["Claude Code", "test:adapter:claude-local", "COMPAZIO_CLAUDE_LOCAL"],
  ["Codex", "test:adapter:codex-local", "COMPAZIO_CODEX_LOCAL"],
  ["OpenCode", "test:adapter:opencode-local", "COMPAZIO_OPENCODE_LOCAL"]
];

for (const [label, script, optIn] of agents) {
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    await run(`${label} cycle ${cycle}/10`, script, optIn);
  }
}
console.info(
  "Beta.3 agent stress passed: 30 real start/input/output/stop cycles, no registered sessions."
);

function run(label, script, optIn) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? pnpm : "pnpm";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm", "--filter", "@forgedeck/desktop", script]
        : ["--filter", "@forgedeck/desktop", script];
    const child = spawn(command, args, {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, [optIn]: "1" }
    });
    const timeout = setTimeout(() => child.kill(), 240_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with code ${code ?? "unknown"}`));
    });
  });
}
