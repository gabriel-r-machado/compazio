import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

if (process.env.COMPAZIO_V2_MCP_REAL_AGENTS !== "true") {
  console.error("Defina COMPAZIO_V2_MCP_REAL_AGENTS=true para iniciar clientes reais MCP.");
  process.exit(3);
}
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = await mkdtemp(join(tmpdir(), "compazio-mcp-real-user-"));
try {
  await run(
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm run build:v2"] : ["run", "build:v2"],
    {}
  );
  process.exitCode = await run(
    electronPath,
    [join(desktopRoot, "out-v2", "main", "index.js")],
    {
      COMPAZIO_V2_MCP_REAL_AGENTS: "true",
      COMPAZIO_V2_DATA_DIR: join(data, "state"),
      COMPAZIO_V2_MCP_AGENT: process.env.COMPAZIO_V2_MCP_AGENT ?? "all",
      COMPAZIO_V2_MCP_AGENT_DEBUG: process.env.COMPAZIO_V2_MCP_AGENT_DEBUG ?? "0"
    },
    true
  );
} finally {
  await rm(data, { recursive: true, force: true });
}
function run(command, args, extra, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, ...extra }
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      allowFailure
        ? resolve(code ?? 1)
        : code === 0
          ? resolve(0)
          : reject(new Error(`Exited ${code}`))
    );
  });
}
