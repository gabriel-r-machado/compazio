import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");
const root = join(desktopRoot, "..", "..");
const pnpm = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";

// This is the deterministic beta journey. Each child owns its own temporary
// user-data/workspace directories and performs its own teardown.
const gates = [
  ["legacy typed-IPC smoke", ["--filter", "@forgedeck/desktop", "smoke"]],
  ["V2 Compazio/persistence smoke", ["--filter", "@forgedeck/desktop", "smoke:v2"]],
  ["Portal integration", ["--filter", "@forgedeck/desktop", "test:portal-integration"]],
  ["Portal Electron smoke", ["--filter", "@forgedeck/desktop", "smoke:portals"]]
];

for (const [label, args] of gates) await run(label, args);
console.info("Compazio Beta Journey passed");

function run(label, args) {
  return new Promise((resolve, reject) => {
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args;
    const child = spawn(pnpm, commandArgs, {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env }
    });
    const timeout = setTimeout(
      () => {
        child.kill();
        reject(new Error(`${label} timed out`));
      },
      15 * 60 * 1000
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${signal ?? `code ${code ?? "unknown"}`}`));
    });
  });
}
