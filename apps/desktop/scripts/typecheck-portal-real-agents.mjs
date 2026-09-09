import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Typechecks the real-agent harness. The V2 modules it imports predate any typecheck and still
 * carry their own errors, so this gate reports only diagnostics inside the harness files — enough
 * to make a bug like `session is not defined` impossible to commit, without pretending the wider
 * V2 debt is paid.
 */
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const owned = [
  "src/v2/main/e2e/portal-real-agents.ts",
  "src/v2/main/e2e/portal-mcp-real-agents.ts",
  "src/v2/main/portal-agent-harness.ts",
  "src/v2/main/portal-agent-commands.ts",
  "src/v2/main/portal-mcp-agent-config.ts",
  "src/v2/main/compazio-mcp-gateway.ts"
];

const result = spawnSync(
  process.execPath,
  [
    join(desktopRoot, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(desktopRoot, "tsconfig.v2portal-real-agents.json"),
    "--noEmit"
  ],
  { cwd: desktopRoot, encoding: "utf8" }
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const normalized = output.replace(/\\/g, "/");
const lines = normalized.split(/\r?\n/).filter((line) => line.includes("error TS"));
const mine = lines.filter((line) => owned.some((file) => line.includes(file)));
const inherited = lines.length - mine.length;

if (mine.length > 0) {
  console.error(mine.join("\n"));
  console.error(`\n${mine.length} erro(s) no harness de agentes reais.`);
  process.exit(1);
}
console.info(
  `Harness de agentes reais sem erros de tipo (${inherited} erro(s) herdado(s) de módulos V2 ainda não tipados).`
);
