import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

/**
 * OPT-IN. Starts the real agent CLIs installed on this machine and therefore spends the user's own
 * provider credits. It never runs in CI: without the guard it refuses and explains itself.
 *
 * Exit codes: 0 passed · 1 Compazio defect · 2 external block (provider) · 3 agent unavailable.
 */
const GUARD = "COMPAZIO_PORTAL_REAL_AGENTS";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");

if (process.env[GUARD] !== "1") {
  console.error(
    [
      "Este teste inicia agentes reais (Claude Code, Codex, OpenCode) e consome créditos do seu",
      "provedor. Ele não roda na CI comum.",
      "",
      `Para executar:  ${GUARD}=1 pnpm test:portal-real-agents`,
      `Um agente só:   ${GUARD}=1 pnpm test:portal-real-agent --agent claude-code`,
      "",
      "Códigos de saída: 0 aprovado · 1 falha do Compazio · 2 bloqueio externo · 3 agente indisponível."
    ].join("\n")
  );
  process.exit(3);
}

const agentFlag = process.argv.indexOf("--agent");
const agent =
  agentFlag === -1 ? (process.env.COMPAZIO_V2_PORTAL_AGENT ?? "all") : process.argv[agentFlag + 1];
const modelFlag = process.argv.indexOf("--model");
const model =
  modelFlag === -1 ? process.env.COMPAZIO_V2_PORTAL_AGENT_MODEL : process.argv[modelFlag + 1];
const known = ["all", "claude-code", "codex", "opencode"];
if (!known.includes(agent ?? "all")) {
  console.error(`Agente desconhecido: ${agent}. Use ${known.join(", ")}.`);
  process.exit(3);
}

const userData = await mkdtemp(join(tmpdir(), "compazio-portal-agents-user-"));
console.warn(`Executando agentes reais (${agent}). Isso consome créditos do seu provedor.`);

try {
  await run(
    "build:v2",
    process.platform === "win32"
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "pnpm",
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm run build:v2"] : ["run", "build:v2"],
    {}
  );
  const code = await run(
    "Portal real agents",
    electronPath,
    [join(desktopRoot, "out-v2", "main", "index.js")],
    {
      COMPAZIO_V2_PORTAL_REAL_AGENTS: "true",
      COMPAZIO_V2_PORTAL_AGENT: agent ?? "all",
      ...(model === undefined ? {} : { COMPAZIO_V2_PORTAL_AGENT_MODEL: model }),
      COMPAZIO_V2_DATA_DIR: join(userData, "compazio", "v2")
    },
    true
  );
  process.exitCode = code;
} finally {
  await rm(userData, { recursive: true, force: true });
}

function run(label, command, args, extraEnvironment, tolerateExitCode = false) {
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
    }, 30 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (tolerateExitCode) resolve(code ?? 1);
      else if (code === 0) resolve(0);
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}
