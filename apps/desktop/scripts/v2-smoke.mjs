import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");
const smokeElectronPath = process.env.COMPAZIO_V2_SMOKE_EXECUTABLE ?? electronPath;
const packagedSmoke = process.env.COMPAZIO_V2_PACKAGED_SMOKE === "true";
const terminalOnly = process.env.COMPAZIO_V2_TERMINAL_ONLY === "true";
const realTui = process.env.COMPAZIO_V2_REAL_TUI === "true";
const focusedTerminalJourney = terminalOnly || realTui;
// Historical TeamRun probes are retained for migration diagnostics, but they are not part of the
// public real-terminal runtime. Opt in explicitly when maintaining that compatibility surface.
const legacyTeamSmoke = process.env.COMPAZIO_V2_LEGACY_TEAM_SMOKE === "true";
const smokeMainEntry = join(desktopRoot, "out-v2", "main", "index.js");
const userData = await mkdtemp(join(tmpdir(), "compazio-v2-electron-smoke-user-"));
const browserUserData = await mkdtemp(join(tmpdir(), "compazio-v2-electron-smoke-profile-"));
const smokeApplicationArgs = (argumentsBeforeEntry = []) => {
  const profileArguments = argumentsBeforeEntry.some((argument) =>
    argument.startsWith("--user-data-dir=")
  )
    ? argumentsBeforeEntry
    : [`--user-data-dir=${browserUserData}`, ...argumentsBeforeEntry];
  return packagedSmoke ? profileArguments : [...profileArguments, smokeMainEntry];
};
const dataDirectory = join(userData, "compazio", "v2");
const freeLicenseUserData = await mkdtemp(join(tmpdir(), "compazio-v2-free-license-user-"));
const freeLicenseDataDirectory = join(freeLicenseUserData, "compazio", "v2");
const singleInstanceUserData = await mkdtemp(join(tmpdir(), "compazio-v2-single-instance-user-"));
const installedDataDirectory = join(
  process.env.APPDATA ?? join(tmpdir(), "compazio-absent"),
  "Compazio",
  "compazio",
  "v2"
);
const installedWorkspacesBefore = await workspaceFiles(installedDataDirectory);
// Multi-phase smoke runs create several workspaces. The marker plus the environment below is the
// only combination that lifts the free limit, and it works only because dataDirectory is temporary.
const harnessId = `v2-smoke-${randomUUID()}`;
await mkdir(dataDirectory, { recursive: true });
await writeFile(join(dataDirectory, ".compazio-test-harness"), harnessId, "utf8");
const workspace = await mkdtemp(join(tmpdir(), "compazio-v2-electron-smoke-workspace-"));
const fakeAgentPath = join(workspace, "fake-agent.mjs");
const fakeMcpAgentPath = join(workspace, "fake-mcp-agent.mjs");
const fakeMcpCommand = join(
  workspace,
  process.platform === "win32" ? "fake-mcp-agent.cmd" : "fake-mcp-agent"
);
const retryMarkerPath = join(workspace, "reviewer-retried");
const licenseFixture = await startLicenseFixture();

try {
  await writeFile(
    fakeAgentPath,
    `import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(retryMarkerPath)};
let input = "";
process.stdin.on("data", chunk => {
  input += String(chunk);
  if (input.includes("[Compazio: contexto de arquivo autorizado pelo usuário]")) {
    process.stdout.write("SMOKE_FILE_CONTEXT");
    input = "";
    return;
  }
  if (!input.includes("SMOKE_TASK")) return;
  if (input.includes("SMOKE_TASK_FAIL") && !existsSync(marker)) {
    writeFileSync(marker, "failed-once");
    process.stdout.write("fake-agent:controlled-failure");
    process.exit(1);
  }
  setTimeout(() => {
    process.stdout.write("fake-agent:completed");
    process.exit(0);
  }, 600);
});
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  await writeFile(
    fakeMcpAgentPath,
    `import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("compazio-smoke-mcp 1.0.0\\n");
  process.exit(0);
}

function endpointFromArgs() {
  const configIndex = args.indexOf("--mcp-config");
  if (configIndex >= 0) {
    const value = JSON.parse(readFileSync(args[configIndex + 1], "utf8"));
    return value.mcpServers.compazio.url;
  }
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c") continue;
    const match = /^mcp_servers\\.compazio\\.url=(.+)$/.exec(args[index + 1]);
    if (match !== null) return JSON.parse(match[1]);
  }
  throw new Error("Compazio MCP endpoint missing from fake agent arguments");
}

const endpoint = endpointFromArgs();
const token = process.env.COMPAZIO_MCP_TOKEN;
if (!token) throw new Error("Compazio MCP token missing");
let mcpSessionId;
let sequence = 0;
function payload(response) {
  const text = response.text.trim();
  const data = text.split(/\\r?\\n/).find(line => line.startsWith("data:"));
  if (data !== undefined) return JSON.parse(data.slice(5).trim());
  return text.length === 0 ? {} : JSON.parse(text);
}
async function rpc(method, params, notification = false) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++sequence }), method, ...(params === undefined ? {} : { params }) })
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) mcpSessionId = nextSession;
  const result = payload({ text: await response.text() });
  if (!response.ok || result.error) throw new Error(JSON.stringify(result.error ?? result));
  return result.result;
}
async function main() {
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "compazio-smoke-fake", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  const listed = await rpc("tools/list", {});
  const tools = listed.tools.map(tool => tool.name);
  if (tools.includes("team_run_create") && process.env.COMPAZIO_V2_SMOKE_MIXED === "true") {
    await rpc("tools/call", { name: "team_run_create", arguments: {
      title: "API Tasks",
      objective: "Produzir e revisar uma proposta de contrato de API para um serviço de tarefas.",
      members: [
        { agentType: "codex", displayName: "Codex Implementation Engineer", role: { name: "Implementation Engineer", responsibilities: ["Definir o contrato de API."] } },
        { agentType: "claude-code", displayName: "Claude Architecture Reviewer", role: { name: "Architecture Reviewer", responsibilities: ["Revisar a proposta de API."] } }
      ],
      tasks: [
        { key: "implementation", title: "Definir POST /tasks", description: "Retorne a proposta estruturada do contrato.", assignedMemberName: "Codex Implementation Engineer" },
        { key: "review", title: "Revisar contrato de tarefas", description: "Revise a proposta e devolva uma opinião estruturada.", assignedMemberName: "Claude Architecture Reviewer", dependsOn: ["implementation"], reviewOf: "implementation" }
      ]
    }});
    process.stdout.write("SMOKE_MIXED_TEAM_CREATED");
    void (async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const status = await rpc("tools/call", { name: "team_list", arguments: {} });
        const data = status.structuredContent?.data;
        const run = data?.runs?.find(candidate => candidate.status === "completed");
        if (run) {
          for (const member of data.members ?? []) {
            await rpc("tools/call", { name: "team_dismiss", arguments: { teamMemberId: member.id, reason: "Mixed smoke completed" } });
          }
          process.stdout.write("SMOKE_MIXED_TEAM_DISMISSED");
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("fake Compazio did not observe the mixed team completion");
    })().catch(error => { console.error(error); process.exit(2); });
    setInterval(() => {}, 1000);
    return;
  }
  if (tools.includes("team_recruit")) {
    const recruitedAgent = process.env.COMPAZIO_V2_SMOKE_RECRUIT_AGENT || "codex";
    const architectureReview = recruitedAgent === "claude-code";
    await rpc("tools/call", { name: "team_recruit", arguments: {
      agentType: recruitedAgent,
      displayName: architectureReview ? "Claude Architecture Reviewer" : "Codex smoke",
      role: { name: architectureReview ? "Architecture Reviewer" : "Test Engineer", responsibilities: ["Return the fixture report."] },
      initialTask: { title: architectureReview ? "Review fixture architecture" : "Analyze fixture", description: "Return a structured fixture report." },
      positionHint: { direction: "right" }
    }});
    process.stdout.write("SMOKE_COMPAZIO_RECRUITED");
    void (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = await rpc("tools/call", { name: "team_status", arguments: {} });
        const member = status.structuredContent?.data?.members?.find(candidate => candidate.status === "completed");
        if (member) {
          await rpc("tools/call", { name: "team_dismiss", arguments: { teamMemberId: member.id, reason: "Smoke completed" } });
          process.stdout.write("SMOKE_COMPAZIO_DISMISSED");
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("fake Compazio did not observe a completed task");
    })().catch(error => { console.error(error); process.exit(2); });
    setInterval(() => {}, 1000);
    return;
  }
  let taskId;
  for (let attempt = 0; attempt < 100 && !taskId; attempt += 1) {
    const messages = await rpc("tools/call", { name: "message_list", arguments: {} });
    taskId = messages.structuredContent?.data?.messages?.find(message => message.type === "task")?.taskId;
    if (!taskId) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!taskId) throw new Error("task delivery was not visible to fake Codex");
  const task = await rpc("tools/call", { name: "task_status", arguments: { taskId } });
  const title = task.structuredContent?.data?.title || "";
  const review = /Revisar contrato/.test(title);
  if (review) {
    const messages = await rpc("tools/call", { name: "message_list", arguments: {} });
    const context = messages.structuredContent?.data?.messages?.find(message => message.type === "result");
    if (!context) throw new Error("reviewer did not receive the implementation context");
    await rpc("tools/call", { name: "message_acknowledge", arguments: { messageId: context.id } });
  }
  const mixedImplementation = /Definir POST/.test(title);
  if (mixedImplementation && process.env.COMPAZIO_V2_SMOKE_CLARIFICATION === "true") {
    const clarification = await rpc("tools/call", { name: "task_request_user_input", arguments: {
      taskId,
      question: "Qual número de WhatsApp devo usar?",
      reason: "O CTA não pode usar um destino inventado.",
      expectedAnswerType: "text",
      context: "Landing page Bella Pele"
    } });
    if (clarification.structuredContent?.data?.answer !== "+55 11 99999-1234")
      throw new Error("structured human answer did not return to the worker: " + JSON.stringify(clarification.structuredContent));
  }
  if (process.env.COMPAZIO_V2_SMOKE_SLOW === "true") {
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
  // Keep the RUNNING checkpoint observable across the real Electron/IPC polling interval. A fake
  // provider that creates and completes a task in the same frame makes the recovery fixture race
  // the renderer even though production providers are long-lived processes.
  await new Promise(resolve => setTimeout(resolve, 500));
  await rpc("tools/call", { name: "task_result", arguments: { taskId, result: review
    ? { summary: '{"approved":true,"risks":["versioning"],"recommendations":["document errors"],"reviewedEndpoint":"/tasks"}', artifacts: ["review-report"] }
    : mixedImplementation
      ? { summary: '{"endpoint":"/tasks","method":"POST","requestFields":["title"],"responseStatus":201,"testsSuggested":["missing title","valid title"]}', artifacts: ["implementation-report"] }
      : { summary: "Fixture validated by fake worker", artifacts: ["smoke-report"] }
  } });
  process.stdout.write("SMOKE_WORKER_RESULT");
  setInterval(() => {}, 1000);
}
main().catch(error => { console.error(error); process.exit(2); });
`,
    "utf8"
  );
  if (process.platform === "win32") {
    await writeFile(
      fakeMcpCommand,
      `@echo off\r\n"%COMPAZIO_V2_SMOKE_NODE%" "%~dp0fake-mcp-agent.mjs" %*\r\n`,
      "utf8"
    );
  } else {
    await writeFile(
      fakeMcpCommand,
      `#!/bin/sh\nexec "$COMPAZIO_V2_SMOKE_NODE" "$(dirname "$0")/fake-mcp-agent.mjs" "$@"\n`,
      "utf8"
    );
    await chmod(fakeMcpCommand, 0o700);
  }
  await writeFile(
    join(workspace, "fixture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2wQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
  await writeFile(join(workspace, "example.ts"), "export const smoke = 1;\n", "utf8");
  await run("Git init", "git", ["init", workspace], false);
  await run(
    "Git user email",
    "git",
    ["-C", workspace, "config", "user.email", "smoke@compazio.local"],
    false
  );
  await run(
    "Git user name",
    "git",
    ["-C", workspace, "config", "user.name", "Compazio Smoke"],
    false
  );
  await run(
    "Git fixture stage",
    "git",
    ["-C", workspace, "add", "--", "fixture.png", "example.ts", "fake-agent.mjs"],
    false
  );
  await run("Git fixture commit", "git", ["-C", workspace, "commit", "-m", "smoke fixture"], false);
  if (!packagedSmoke) {
    await run(
      "build:v2",
      process.platform === "win32"
        ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
        : "pnpm",
      process.platform === "win32" ? ["/d", "/s", "/c", "pnpm run build:v2"] : ["run", "build:v2"],
      false
    );
  }
  // This launch deliberately has no test-harness marker and no unlimited flag. It crosses the
  // real renderer → preload → typed IPC boundary with the product's free entitlement and proves
  // the second workspace is denied before the repository writes it.
  if (!focusedTerminalJourney)
    await run(
      "Electron V2 free-license acceptance",
      smokeElectronPath,
      smokeApplicationArgs(),
      false,
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "license-free",
        NODE_ENV: "test",
        COMPAZIO_V2_DATA_DIR: freeLicenseDataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      }
    );
  const freeWorkspaceFiles = focusedTerminalJourney
    ? []
    : await workspaceFiles(freeLicenseDataDirectory);
  if (!focusedTerminalJourney && freeWorkspaceFiles.length !== 1)
    throw new Error(
      `Free-license acceptance expected exactly one persisted workspace, found ${freeWorkspaceFiles.length}.`
    );
  const installedWorkspacesAfter = focusedTerminalJourney
    ? installedWorkspacesBefore
    : await workspaceFiles(installedDataDirectory);
  if (
    !focusedTerminalJourney &&
    installedWorkspacesAfter.join("\u0000") !== installedWorkspacesBefore.join("\u0000")
  )
    throw new Error("Free-license acceptance wrote a workspace into the installed user data.");
  if (!packagedSmoke && !focusedTerminalJourney) {
    await run(
      "Electron V2 license activation/revocation acceptance",
      smokeElectronPath,
      smokeApplicationArgs(),
      false,
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "license-cycle",
        NODE_ENV: "test",
        COMPAZIO_V2_DATA_DIR: join(freeLicenseUserData, "license-cycle", "v2"),
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand,
        COMPAZIO_SUPABASE_URL: licenseFixture.url,
        COMPAZIO_LICENSE_PUBLIC_KEY: licenseFixture.publicKey
      }
    );
    const singleInstanceProcess = await runUntilReady(
      "Electron V2 first instance",
      smokeElectronPath,
      smokeApplicationArgs([`--user-data-dir=${singleInstanceUserData}`]),
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "single-instance-hold",
        NODE_ENV: "test",
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      },
      "COMPAZIO_V2_SINGLE_INSTANCE_READY"
    );
    await run(
      "Electron V2 second instance is refused",
      smokeElectronPath,
      smokeApplicationArgs([`--user-data-dir=${singleInstanceUserData}`]),
      false,
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "single-instance-hold",
        NODE_ENV: "test",
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      }
    );
    await terminateAbruptly(singleInstanceProcess);
  }
  // Persist through the real Electron boundary, then terminate the process without Electron's
  // normal shutdown path. A fresh launch below must recover both the workspace JSON and
  // agents.json from the same isolated profile. The AppImage runtime forks its launcher on
  // Linux, so this abrupt-recovery pair is covered by the native smoke and omitted only from
  // the packaged Linux launch to avoid mistaking the launcher exit code for an app failure.
  if (!focusedTerminalJourney && !(packagedSmoke && process.platform === "linux")) {
    const recoveryProcess = await runUntilReady(
      "Electron V2 abrupt recovery write",
      smokeElectronPath,
      smokeApplicationArgs(),
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "recovery-write",
        NODE_ENV: "test",
        COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
        COMPAZIO_TEST_HARNESS_ID: harnessId,
        COMPAZIO_V2_DATA_DIR: dataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      }
    );
    await terminateAbruptly(recoveryProcess);
    await run(
      "Electron V2 abrupt recovery verify",
      smokeElectronPath,
      smokeApplicationArgs(),
      false,
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "recovery-verify",
        NODE_ENV: "test",
        COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
        COMPAZIO_TEST_HARNESS_ID: harnessId,
        COMPAZIO_V2_DATA_DIR: dataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      }
    );
  }
  if (!packagedSmoke && !focusedTerminalJourney) {
    const atomicRecoveryProcess = await runUntilReady(
      "Electron V2 atomic replace interruption",
      smokeElectronPath,
      smokeApplicationArgs(),
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "atomic-recovery-write",
        COMPAZIO_V2_SMOKE_PAUSE_AFTER_REPLACE: "saveAgentCatalog",
        COMPAZIO_V2_SMOKE_PAUSE_AFTER_REPLACE_CONTAINS: "Preset instalado no replace interrompido",
        NODE_ENV: "test",
        COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
        COMPAZIO_TEST_HARNESS_ID: harnessId,
        COMPAZIO_V2_DATA_DIR: dataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      },
      "COMPAZIO_V2_ATOMIC_REPLACE_READY:saveAgentCatalog"
    );
    await terminateAbruptly(atomicRecoveryProcess);
    await run(
      "Electron V2 atomic replace recovery verify",
      smokeElectronPath,
      smokeApplicationArgs(),
      false,
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "atomic-recovery-verify",
        NODE_ENV: "test",
        COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
        COMPAZIO_TEST_HARNESS_ID: harnessId,
        COMPAZIO_V2_DATA_DIR: dataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      }
    );
  }
  if (!packagedSmoke && !focusedTerminalJourney && legacyTeamSmoke) {
    // A TeamRun has more state than a terminal session: assignments, dependent tasks and a
    // recovery attention request. Kill it while a worker is still processing, then prove the
    // persisted run is made explicitly recoverable on the next launch.
    const teamRecoveryProcess = await runUntilReady(
      "Electron V2 abrupt TeamRun recovery write",
      smokeElectronPath,
      smokeApplicationArgs(),
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "team-recovery-write",
        COMPAZIO_V2_SMOKE_SLOW: "true",
        NODE_ENV: "test",
        COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
        COMPAZIO_TEST_HARNESS_ID: harnessId,
        COMPAZIO_V2_DATA_DIR: dataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      },
      "COMPAZIO_V2_TEAM_RECOVERY_READY"
    );
    await terminateAbruptly(teamRecoveryProcess);
    await run(
      "Electron V2 abrupt TeamRun recovery verify",
      smokeElectronPath,
      smokeApplicationArgs(),
      false,
      {
        COMPAZIO_V2_SMOKE: "true",
        COMPAZIO_V2_SMOKE_PHASE: "team-recovery-verify",
        NODE_ENV: "test",
        COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
        COMPAZIO_TEST_HARNESS_ID: harnessId,
        COMPAZIO_V2_DATA_DIR: dataDirectory,
        COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
        COMPAZIO_V2_SMOKE_NODE: process.execPath,
        COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
        COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand
      }
    );
  }
  const phases = realTui
    ? ["real-tui"]
    : packagedSmoke
      ? []
      : process.env.COMPAZIO_V2_TERMINAL_ONLY === "true"
        ? ["terminal", "cleanup"]
        : process.env.COMPAZIO_V2_MULTI_SELECT_ONLY === "true"
          ? ["multi-select", "cleanup"]
          : process.env.COMPAZIO_V2_UX_ONLY === "true"
            ? ["ux", "cleanup"]
            : process.env.COMPAZIO_V2_REAL_AGENT
              ? ["real"]
              : legacyTeamSmoke
                ? [
                    "compazio",
                    "compazio-reload",
                    "compazio-codex",
                    "compazio-reload",
                    "compazio-mixed",
                    "compazio-reload",
                    "cleanup"
                  ]
                : ["terminal", "cleanup"];
  for (const phase of phases) {
    await run(`Electron V2 smoke (${phase})`, smokeElectronPath, smokeApplicationArgs(), false, {
      COMPAZIO_V2_SMOKE: "true",
      COMPAZIO_V2_SMOKE_PHASE: phase,
      NODE_ENV: "test",
      COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
      COMPAZIO_TEST_HARNESS_ID: harnessId,
      COMPAZIO_V2_DATA_DIR: dataDirectory,
      COMPAZIO_V2_SMOKE_WORKSPACE: workspace,
      COMPAZIO_V2_SMOKE_NODE: process.execPath,
      COMPAZIO_V2_SMOKE_FAKE_AGENT: fakeAgentPath,
      COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND: fakeMcpCommand,
      ...(phase === "compazio-mixed" ? { COMPAZIO_V2_SMOKE_CLARIFICATION: "true" } : {}),
      ...(process.env.COMPAZIO_V2_UI_SMOKE === undefined
        ? {}
        : { COMPAZIO_V2_UI_SMOKE: process.env.COMPAZIO_V2_UI_SMOKE }),
      ...(process.env.COMPAZIO_V2_SMOKE_WIDTH === undefined
        ? {}
        : { COMPAZIO_V2_SMOKE_WIDTH: process.env.COMPAZIO_V2_SMOKE_WIDTH }),
      ...(process.env.COMPAZIO_V2_SMOKE_HEIGHT === undefined
        ? {}
        : { COMPAZIO_V2_SMOKE_HEIGHT: process.env.COMPAZIO_V2_SMOKE_HEIGHT }),
      ...(process.env.COMPAZIO_V2_SMOKE_SCALE === undefined
        ? {}
        : { COMPAZIO_V2_SMOKE_SCALE: process.env.COMPAZIO_V2_SMOKE_SCALE }),
      ...(process.env.COMPAZIO_V2_UI_CAPTURE_DIR === undefined
        ? {}
        : { COMPAZIO_V2_UI_CAPTURE_DIR: process.env.COMPAZIO_V2_UI_CAPTURE_DIR }),
      ...(process.env.COMPAZIO_V2_REAL_TUI_RENDER_ONLY === undefined
        ? {}
        : { COMPAZIO_V2_REAL_TUI_RENDER_ONLY: process.env.COMPAZIO_V2_REAL_TUI_RENDER_ONLY }),
      ...(process.env.COMPAZIO_V2_REAL_TUI_RESIZE_STRESS === undefined
        ? {}
        : { COMPAZIO_V2_REAL_TUI_RESIZE_STRESS: process.env.COMPAZIO_V2_REAL_TUI_RESIZE_STRESS }),
      ...(process.env.COMPAZIO_V2_SMOKE_DOM_TERMINAL === undefined
        ? {}
        : { COMPAZIO_V2_SMOKE_DOM_TERMINAL: process.env.COMPAZIO_V2_SMOKE_DOM_TERMINAL })
    });
  }
} finally {
  await licenseFixture.close();
  await removeWithRetry(userData);
  await removeWithRetry(browserUserData);
  await removeWithRetry(freeLicenseUserData);
  await removeWithRetry(singleInstanceUserData);
  await removeWithRetry(workspace);
}

async function startLicenseFixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.url === "/functions/v1/license-activate" && request.method === "POST") {
      const input = JSON.parse(body);
      const payload = {
        schemaVersion: 1,
        keyId: "electron-smoke",
        plan: "beta_unlimited",
        installationId: input.installationId,
        maxWorkspaces: null,
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        activationId: "electron-smoke-activation",
        licenseVersion: 1
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = sign(null, Buffer.from(encoded), keys.privateKey).toString("base64url");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ entitlement: `${encoded}.${signature}` }));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("License fixture has no TCP address.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    publicKey,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function workspaceFiles(dataDirectory) {
  try {
    return (await readdir(join(dataDirectory, "workspaces"))).filter((entry) =>
      entry.endsWith(".json")
    );
  } catch {
    return [];
  }
}

function run(label, command, args, shell, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      shell,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, ...extraEnvironment }
    });
    const timeout = setTimeout(
      () => {
        child.kill();
        reject(new Error(`${label} timed out`));
      },
      process.env.COMPAZIO_V2_REAL_AGENT ? 180_000 : 60_000
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}

function runUntilReady(
  label,
  command,
  args,
  extraEnvironment,
  readyMarker = "COMPAZIO_V2_RECOVERY_READY"
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnvironment }
    });
    let output = "";
    const receive = (chunk) => {
      const text = String(chunk);
      output = `${output}${text}`.slice(-8_000);
      process.stdout.write(text);
      if (output.includes(readyMarker)) finish();
    };
    const receiveError = (chunk) => {
      const text = String(chunk);
      output = `${output}${text}`.slice(-8_000);
      process.stderr.write(text);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not reach its durable recovery checkpoint: ${output}`));
    }, 45_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", receive);
      child.stderr?.off("data", receiveError);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = () => {
      cleanup();
      resolve(child);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `${label} exited before its recovery checkpoint with ${signal ?? `code ${code ?? "unknown"}`}: ${output}`
        )
      );
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receiveError);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function terminateAbruptly(child) {
  if (child.pid === undefined) throw new Error("Recovery Electron process did not expose a pid.");
  if (child.exitCode !== null)
    throw new Error("Recovery Electron process exited before force kill.");
  if (!child.kill("SIGKILL"))
    throw new Error("Could not force-kill the recovery Electron process.");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Recovery Electron process did not exit after force kill."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function removeWithRetry(path) {
  let lastError;
  const maximumAttempts = process.platform === "win32" ? 12 : 4;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (
        !error ||
        !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code) ||
        attempt === maximumAttempts
      )
        break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_000, attempt * (process.platform === "win32" ? 150 : 50)))
      );
    }
  }
  throw lastError;
}
