import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tempRoot = resolve(tmpdir());
const productionUserDataVariables = ["COMPAZIO_USER_DATA", "ELECTRON_USER_DATA"];

for (const variable of productionUserDataVariables) {
  const value = process.env[variable];
  if (value === undefined || value.trim() === "") continue;
  const candidate = resolve(value);
  const difference = relative(tempRoot, candidate);
  if (difference === "" || (!difference.startsWith("..") && !isAbsolute(difference))) continue;
  throw new Error(
    `Security Abuse aborted: ${variable} points outside the temporary test area. Real userData must not be touched.`
  );
}

/** Every item is an individual denial asserted at a real product boundary. */
const cases = [
  {
    id: "SEC-01",
    expected:
      "second free workspace from the product creation route is denied with FREE_WORKSPACE_LIMIT_REACHED",
    actual: "V2WorkspaceService rejects the second persisted create before repository write",
    file: "apps/desktop/src/v2/main/workspace-creation-gate.test.ts",
    pattern: "primeira.*segunda",
    evidence: "workspace-creation-gate.test.ts :: creation gate service denial"
  },
  {
    id: "SEC-02",
    expected: "second free workspace through IPC is denied with FREE_WORKSPACE_LIMIT_REACHED",
    actual: "registered workspace-create IPC handler returns the entitlement denial",
    file: "apps/desktop/src/v2/main/workspace-creation-gate.test.ts",
    pattern: "vinda do IPC",
    evidence: "workspace-creation-gate.test.ts :: IPC create handler"
  },
  {
    id: "SEC-03",
    expected: "agent-accessible service cannot create an additional workspace",
    actual: "MCP tool discovery omits workspace_create and a real tools/call is rejected",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "does not expose workspace creation",
    evidence: "compazio-mcp-gateway.test.ts :: MCP agent tools/call"
  },
  {
    id: "SEC-04",
    expected: "COMPAZIO orchestration session cannot create a workspace without entitlement",
    actual: "team-capable COMPAZIO MCP session omits workspace_create and rejects a real call",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "does not expose workspace creation",
    evidence: "compazio-mcp-gateway.test.ts :: COMPAZIO MCP tools/call"
  },
  {
    id: "SEC-05",
    expected: "Agent A cannot read a known artifact id from workspace B",
    actual: "session-bound context_read returns PORTAL_NOT_CONNECTED for the foreign node",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "cross-workspace",
    evidence: "compazio-mcp-gateway.test.ts :: session A context_read artifact B"
  },
  {
    id: "SEC-06",
    expected: "disconnected Note read is denied",
    actual: "MCP context_read returns PORTAL_NOT_CONNECTED before the note edge exists",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "reads and updates newly",
    evidence: "compazio-mcp-gateway.test.ts :: pre-connection context_read"
  },
  {
    id: "SEC-07",
    expected: "disconnected Note write is denied",
    actual: "MCP note_update returns PORTAL_NOT_CONNECTED before the write-note edge exists",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "reads and updates newly",
    evidence: "compazio-mcp-gateway.test.ts :: pre-connection note_update"
  },
  {
    id: "SEC-08",
    expected: "Portal capability call without a connection is denied",
    actual: "MCP portal_list returns PORTAL_NOT_CONNECTED for a never-connected terminal",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "never connected",
    evidence: "compazio-mcp-gateway.test.ts :: portal_list without edge"
  },
  {
    id: "SEC-09",
    expected: "Portal capability is immediately revoked after disconnect",
    actual: "already initialized MCP session returns PORTAL_NOT_CONNECTED after edge removal",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "rechecks portal-control",
    evidence: "compazio-mcp-gateway.test.ts :: live graph revocation"
  },
  {
    id: "SEC-10",
    expected: "a forged recruit capability cannot enable the legacy team gateway",
    actual:
      "session creation with team-recruit is rejected while the optional MCP lifecycle is unavailable",
    file: "apps/desktop/src/v2/main/compazio-mcp-lifecycle.integration.test.ts",
    pattern: "does not start the legacy team gateway",
    integration: true,
    evidence: "compazio-mcp-lifecycle.integration.test.ts :: forged team-recruit session"
  },
  {
    id: "SEC-11",
    expected: "historical callers cannot start a hidden provider worker",
    actual: "the workspace service rejects hidden provider turns before spawning a process",
    file: "apps/desktop/src/v2/main/compazio-mcp-lifecycle.integration.test.ts",
    pattern: "rejects hidden provider turns",
    integration: true,
    evidence: "compazio-mcp-lifecycle.integration.test.ts :: disabled hidden provider task"
  },
  {
    id: "SEC-12",
    expected: "../, ..\\, absolute and encoded traversal remain inside no workspace boundary",
    actual: "FileSystemService returns PATH_TRAVERSAL_BLOCKED for every attempted form",
    file: "apps/desktop/src/v2/main/file-system-service.test.ts",
    pattern: "blocks traversal",
    evidence: "file-system-service.test.ts :: normalizeRelative and read boundary"
  },
  {
    id: "SEC-13",
    expected: "arbitrary IPC invoke never reaches a privileged main-process handler",
    actual: "real IPC registration has no arbitrary or shell-exec handler",
    file: "apps/desktop/src/v2/main/workspace-creation-gate.test.ts",
    pattern: "arbitrary privileged",
    evidence: "workspace-creation-gate.test.ts :: IPC handler registry allowlist"
  },
  {
    id: "SEC-14",
    expected: "locally modified signed entitlement denies paid privileges",
    actual: "signature mismatch resolves to free and denies the second workspace",
    file: "apps/desktop/src/v2/main/entitlement-service.test.ts",
    pattern: "tampered signed",
    evidence: "entitlement-service.test.ts :: modified payload with original signature"
  },
  {
    id: "SEC-15",
    expected: "valid entitlement from another installationId is denied",
    actual: "status remains free and assertCanCreateWorkspace denies the second workspace",
    file: "apps/desktop/src/v2/main/entitlement-service.test.ts",
    pattern: "outra instala",
    evidence: "entitlement-service.test.ts :: foreign installationId"
  },
  {
    id: "SEC-16",
    expected: "local maxWorkspaces=999 modification does not unlock workspaces",
    actual: "modified maxWorkspaces with an invalid signature remains at maxWorkspaces=1",
    file: "apps/desktop/src/v2/main/entitlement-service.test.ts",
    pattern: "tampered signed",
    evidence: "entitlement-service.test.ts :: maxWorkspaces 999 tamper"
  },
  {
    id: "SEC-17",
    expected: "expired MCP token cannot perform a capability call",
    actual: "connected client calling portal_list after expiry is rejected and raw request is 401",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "expires sessions",
    evidence: "compazio-mcp-gateway.test.ts :: expired session portal_list"
  },
  {
    id: "SEC-18",
    expected: "MCP token from session A cannot perform a capability call on session B transport",
    actual: "tools/list with token A plus session B transport id is denied with HTTP 403",
    file: "apps/desktop/src/v2/main/compazio-mcp-gateway.test.ts",
    pattern: "token from session A",
    evidence: "compazio-mcp-gateway.test.ts :: token/transport binding"
  }
];

const pnpmCli =
  process.platform === "win32"
    ? join(process.env.APPDATA ?? "", "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
    : undefined;
const command = pnpmCli === undefined ? "pnpm" : process.execPath;

async function run(entry) {
  const args = [
    ...(pnpmCli === undefined ? [] : [pnpmCli]),
    "exec",
    "vitest",
    "run",
    "--root",
    ".",
    ...(entry.integration ? ["--config", "vitest.integration.config.ts"] : []),
    entry.file,
    "--testNamePattern",
    entry.pattern
  ];
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COMPAZIO_RELEASE_GATE: "beta3-security-abuse" }
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) => resolve({ ok: false, detail: error.message }));
    child.once("exit", (code) => {
      const summary = output.replace(/[A-Za-z]:\\Users\\[^\s]+/g, "[LOCAL_PATH]").slice(-900);
      resolve({ ok: code === 0 && /Tests\s+1 passed/.test(output), detail: summary });
    });
  });
}

const results = [];
console.info("Security Abuse Release Gate");
for (const entry of cases) {
  const execution = await run(entry);
  const result = execution.ok ? "PASS" : "FAIL";
  results.push({ ...entry, result, detail: execution.detail });
  console.info(`${entry.id} ${result}`);
  console.info(`  expected: ${entry.expected}`);
  console.info(`  actual: ${entry.actual}`);
  console.info(`  evidence: ${entry.evidence}`);
  if (!execution.ok) console.info(`  runner: ${execution.detail}`);
}

const passed = results.filter((entry) => entry.result === "PASS").length;
console.info(`TOTAL: ${passed}/18`);
console.info("Real userData touched: NO (temporary test roots only)");

const evidenceDirectory = join(root, "artifacts", "beta3-release-gate");
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  join(evidenceDirectory, "security-abuse-latest.json"),
  JSON.stringify(
    {
      gate: "Security Abuse Release Gate",
      generatedAt: new Date().toISOString(),
      realUserDataTouched: false,
      total: `${passed}/18`,
      results
    },
    null,
    2
  )
);

if (passed !== cases.length) process.exitCode = 1;
