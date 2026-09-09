import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const owned = [
  "src/v2/main/team-coordinator.ts",
  "src/v2/main/compazio-mcp-gateway.ts",
  "src/v2/main/e2e/compazio-real-agents.ts",
  "src/v2/main/workspace-service.ts",
  "src/v2/main/orchestrator-bridge.ts"
];

const result = spawnSync(
  process.execPath,
  [
    join(desktopRoot, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(desktopRoot, "tsconfig.v2compazio-teams.json"),
    "--noEmit"
  ],
  { cwd: desktopRoot, encoding: "utf8" }
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const lines = output
  .replace(/\\/g, "/")
  .split(/\r?\n/)
  .filter((line) => line.includes("error TS"));
const mine = lines.filter((line) => owned.some((file) => line.includes(file)));

if (mine.length > 0) {
  console.error(mine.join("\n"));
  console.error(`\n${mine.length} erro(s) nos módulos Compazio.`);
  process.exit(1);
}

console.info(
  `Módulos Compazio centrais sem erros de tipo (${lines.length - mine.length} erro(s) herdado(s) de módulos V2 fora da fatia).`
);
