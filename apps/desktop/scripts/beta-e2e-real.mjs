import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");
const root = join(desktopRoot, "..", "..");
const pnpm = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";

if (process.env.COMPAZIO_V2_COMPAZIO_REAL_AGENTS !== "true") {
  throw new Error("The real beta journey is opt-in. Set COMPAZIO_V2_COMPAZIO_REAL_AGENTS=true.");
}

await new Promise((resolve, reject) => {
  const pnpmArgs = [
    "--filter",
    "@forgedeck/desktop",
    "test:compazio-real-agents",
    "--",
    "--compazio",
    "claude-code",
    "--team",
    "mixed-dependent"
  ];
  const child = spawn(
    pnpm,
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...pnpmArgs] : pnpmArgs,
    {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env }
    }
  );
  const timeout = setTimeout(
    () => {
      child.kill();
      reject(new Error("real beta journey timed out"));
    },
    20 * 60 * 1000
  );
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) resolve();
    else
      reject(new Error(`real beta journey exited with ${signal ?? `code ${code ?? "unknown"}`}`));
  });
});

console.info("Compazio real beta journey passed");
