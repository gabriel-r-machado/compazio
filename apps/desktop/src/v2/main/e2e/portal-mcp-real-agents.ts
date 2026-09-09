import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import {
  PipeProcessFactory,
  PlatformProcessTreeKiller,
  TransportProcessFactory
} from "@forgedeck/terminal";
import type { BrowserWindow } from "electron";

import { V2OrchestratorBridge } from "../orchestrator-bridge";
import { PortalRuntimeManager } from "../portal-runtime-manager";
import { isolatedTestEntitlement } from "../testing/isolated-entitlement";
import { V2WorkspaceService } from "../workspace-service";
import {
  buildPortalDeniedPrompt,
  buildPortalFlowPrompt,
  createPortalMcpLaunch,
  inspectPortalMcpTranscript,
  safePortalMcpFailureExcerpt,
  safePortalMcpDebugEvents,
  type PortalMcpAgentId
} from "../portal-mcp-agent-config";
import { startPortalFixture } from "./portal-fixture";

const timeoutMs = Number(process.env.COMPAZIO_V2_MCP_AGENT_TIMEOUT_MS ?? 180_000);

export async function runPortalMcpRealAgents(window: BrowserWindow): Promise<void> {
  const selected = (process.env.COMPAZIO_V2_MCP_AGENT ?? "all").trim();
  const agents: readonly PortalMcpAgentId[] =
    selected === "all"
      ? ["claude-code", "codex", "opencode"]
      : selected === "claude-code" || selected === "codex" || selected === "opencode"
        ? [selected]
        : [];
  if (agents.length === 0) throw new Error(`Agente MCP desconhecido: ${selected}`);
  const reports = [];
  for (const agentId of agents) reports.push(await probe(window, agentId));
  for (const report of reports)
    console.info(`MCP ${report.agentId}: ${report.status} ${JSON.stringify(report)}`);
  if (reports.some((report) => report.status !== "passed")) process.exitCode = 1;
}

async function probe(
  window: BrowserWindow,
  agentId: PortalMcpAgentId
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), `compazio-mcp-${agentId}-`));
  const fixture = await startPortalFixture();
  const repository = new V2WorkspaceRepository({ rootDirectory: join(root, "state") });
  const supervisor = new V2ProcessSupervisor(
    new TransportProcessFactory({ pty: new PipeProcessFactory(), pipe: new PipeProcessFactory() }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
  );
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "roles")),
    environment: process.env
  });
  const workspaces = new V2WorkspaceService({
    repository,
    supervisor,
    agents,
    entitlement: isolatedTestEntitlement(join(root, "state"))
  });
  const portals = new PortalRuntimeManager({
    getWindow: () => window,
    tempDirectory: join(root, "shots"),
    downloadDirectory: join(root, "downloads"),
    persist: async () => undefined,
    requestDownloadDecision: async () => ({ accepted: false })
  });
  const bridge = new V2OrchestratorBridge({
    workspaces,
    agents,
    portals,
    storageDirectory: join(root, "bridge"),
    nodeExecutable: process.execPath
  });
  const reports: Record<string, unknown> = { agentId, status: "failed" };
  const calls: unknown[] = [];
  const requests: unknown[] = [];
  let unsubscribe: () => void = () => undefined;
  let unsubscribeRequests: () => void = () => undefined;
  try {
    const detected = await agents.detectOne(agentId).catch(() => null);
    if (detected?.executablePath === undefined || detected.executablePath === "")
      return { ...reports, status: "not-installed" };
    const command = await resolveAgentCommand(agentId, detected.executablePath);
    reports.version =
      detected.version ??
      (await runVersion(
        command.executable,
        command.prefixArgs,
        command.environment,
        agentId === "codex"
      ));
    await bridge.start();
    unsubscribe = bridge.subscribeMcpToolCalls((call) => calls.push(call));
    unsubscribeRequests = bridge.subscribeMcpHttpRequests((request) => requests.push(request));
    let workspace = await workspaces.create({ name: `MCP ${agentId}`, workingDirectory: root });
    workspace = await workspaces.addPortal(workspace.id, { url: fixture.baseUrl });
    const portal = workspace.nodes.find((node) => node.type === "portal");
    if (portal === undefined) throw new Error("Portal fixture missing");
    await portals.ensure(workspace.id, portal);
    portals.setWindowState({
      activeWorkspaceId: workspace.id,
      canvasViewport: { x: 0, y: 0, width: 1_200, height: 800 }
    });
    portals.setBounds(workspace.id, portal.id, {
      x: 24,
      y: 24,
      width: 900,
      height: 620,
      visible: true
    });
    await portals.navigate(workspace.id, portal.id, `${fixture.baseUrl}/visual-reference`);
    const visualReference = await portals.screenshot(workspace.id, portal.id);
    await portals.navigate(workspace.id, portal.id, fixture.baseUrl);
    const pdfCode = `COMPAZIO-PDF-${randomUUID()}`;
    await writeFile(join(root, "connected-brief.pdf"), simplePdf(pdfCode));
    workspace = await workspaces.addFilePreview(workspace.id, {
      title: "Referência visual",
      filePath: relative(root, visualReference.path).replaceAll("\\", "/"),
      previewKind: "image"
    });
    const image = [...workspace.nodes]
      .reverse()
      .find((node) => node.type === "file-preview" && node.previewKind === "image");
    workspace = await workspaces.addFilePreview(workspace.id, {
      title: "Brief PDF",
      filePath: "connected-brief.pdf",
      previewKind: "pdf"
    });
    const pdf = [...workspace.nodes]
      .reverse()
      .find((node) => node.type === "file-preview" && node.previewKind === "pdf");
    workspace = await workspaces.addNote(workspace.id, {
      title: "Leitura multimodal",
      content: "Aguardando leitura real."
    });
    const note = [...workspace.nodes].reverse().find((node) => node.type === "note");
    if (image === undefined || pdf === undefined || note === undefined)
      throw new Error("Connected media fixture missing");
    const requestedCase = process.env.COMPAZIO_V2_MCP_AGENT_CASE ?? "all";
    if (requestedCase !== "all" && requestedCase !== "positive" && requestedCase !== "negative")
      throw new Error(`Caso MCP desconhecido: ${requestedCase}`);
    const positive =
      requestedCase === "negative"
        ? { ok: true, skipped: true }
        : await runCase({
            agentId,
            root,
            executable: command.executable,
            prefixArgs: command.prefixArgs,
            environment: command.environment,
            bridge,
            workspaces,
            workspaceId: workspace.id,
            portalId: portal.id,
            imageId: image.id,
            pdfId: pdf.id,
            noteId: note.id,
            pdfCode,
            fixtureUrl: fixture.baseUrl,
            portals,
            connected: true,
            calls,
            requests
          });
    const negative =
      requestedCase === "positive"
        ? { ok: true, skipped: true }
        : await runCase({
            agentId,
            root,
            executable: command.executable,
            prefixArgs: command.prefixArgs,
            environment: command.environment,
            bridge,
            workspaces,
            workspaceId: workspace.id,
            portalId: portal.id,
            imageId: image.id,
            pdfId: pdf.id,
            noteId: note.id,
            pdfCode,
            fixtureUrl: fixture.baseUrl,
            portals,
            connected: false,
            calls,
            requests
          });
    reports.positive = positive;
    reports.negative = negative;
    reports.status = positive.ok && negative.ok ? "passed" : "failed";
    return reports;
  } catch (error) {
    reports.error = error instanceof Error ? error.message : "unknown failure";
    return reports;
  } finally {
    unsubscribe();
    unsubscribeRequests();
    await portals.shutdown().catch(() => undefined);
    await bridge.shutdown().catch(() => undefined);
    await workspaces.shutdown().catch(() => undefined);
    await fixture.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runCase(input: {
  readonly agentId: PortalMcpAgentId;
  readonly root: string;
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly bridge: V2OrchestratorBridge;
  readonly workspaces: V2WorkspaceService;
  readonly workspaceId: string;
  readonly portalId: string;
  readonly imageId: string;
  readonly pdfId: string;
  readonly noteId: string;
  readonly pdfCode: string;
  readonly fixtureUrl: string;
  readonly portals: PortalRuntimeManager;
  readonly connected: boolean;
  readonly calls: unknown[];
  readonly requests: unknown[];
}): Promise<Record<string, unknown>> {
  let workspace = await input.workspaces.addTerminal(input.workspaceId, {
    title: `${input.agentId} MCP`,
    agentConfig: { agentId: input.agentId }
  });
  const terminal = [...workspace.nodes].reverse().find((node) => node.type === "terminal");
  if (terminal === undefined) throw new Error("Agent terminal missing");
  if (input.connected) {
    workspace = await input.workspaces.addEdge(workspace.id, terminal.id, input.portalId, [
      "portal-control",
      "portal-screenshot"
    ]);
    workspace = await input.workspaces.addEdge(workspace.id, terminal.id, input.imageId, [
      "share-context"
    ]);
    workspace = await input.workspaces.addEdge(workspace.id, terminal.id, input.pdfId, [
      "share-context"
    ]);
    workspace = await input.workspaces.addEdge(workspace.id, terminal.id, input.noteId, [
      "share-context",
      "read-note",
      "write-note"
    ]);
  }
  const bootstrap = input.bridge.createAgentMcpSession({
    workspaceId: workspace.id,
    terminalId: terminal.id,
    capabilities: input.connected ? ["portal-read", "portal-control", "portal-screenshot"] : []
  });
  const launch = await createPortalMcpLaunch({
    agentId: input.agentId,
    directory: input.root,
    endpoint: bootstrap.endpoint,
    token: bootstrap.token,
    tools: input.connected ? bootstrap.tools : ["portal_navigate"],
    prompt: input.connected
      ? buildPortalFlowPrompt({
          portalId: input.portalId,
          url: input.fixtureUrl,
          connectedMedia: {
            imageId: input.imageId,
            pdfId: input.pdfId,
            noteId: input.noteId
          }
        })
      : buildPortalDeniedPrompt({ portalId: input.portalId })
  });
  try {
    const agentArgs = [...input.prefixArgs, ...launch.args];
    if (process.env.COMPAZIO_V2_MCP_AGENT_DEBUG === "1" && input.agentId === "opencode") {
      const runIndex = agentArgs.indexOf("run");
      agentArgs.splice(runIndex < 0 ? 0 : runIndex + 1, 0, "--print-logs", "--log-level", "DEBUG");
    }
    const turn = await runAgent(
      input.executable,
      agentArgs,
      input.root,
      { ...input.environment, ...launch.environment },
      input.agentId === "codex" || input.agentId === "opencode"
    );
    const transcript = inspectPortalMcpTranscript(turn.output);
    const calls = input.calls.filter(
      (value) => (value as { compazioSessionId?: string }).compazioSessionId === bootstrap.sessionId
    ) as readonly {
      readonly tool?: string;
      readonly workspaceId?: string;
      readonly terminalId?: string;
      readonly ok?: boolean;
      readonly code?: string;
    }[];
    const expectedCode = input.connected ? undefined : "PORTAL_NOT_CONNECTED";
    const requests = input.requests.filter(
      (value) => (value as { compazioSessionId?: string }).compazioSessionId === bootstrap.sessionId
    ) as readonly {
      readonly method?: string;
      readonly outcome?: string;
      readonly transportSessionId?: string;
      readonly protocolVersion?: string;
    }[];
    const protocolVersion = requests.find(
      (request): request is { readonly protocolVersion: string } =>
        typeof request.protocolVersion === "string"
    )?.protocolVersion;
    const expectedTools = input.connected
      ? [
          "portal_list",
          "portal_navigate",
          "portal_click",
          "portal_type",
          "portal_dom",
          "portal_accessibility",
          "portal_screenshot",
          "portal_console",
          "context_read",
          "note_update"
        ]
      : ["portal_navigate"];
    const calledTools = new Set(calls.map((entry) => entry.tool));
    const trusted = input.connected
      ? await observeFullFlow(input.portals, workspace.id, input.portalId)
      : { ok: true };
    const persisted = input.connected ? await input.workspaces.snapshot(workspace.id) : workspace;
    const mediaNote = persisted.nodes.find((node) => node.id === input.noteId);
    const mediaNoteContent = mediaNote?.type === "note" ? mediaNote.content : "";
    const pdfObserved = !input.connected || mediaNoteContent.includes(input.pdfCode);
    const imageObserved = !input.connected || mediaNoteContent.includes("FAROL AZUL");
    // OpenCode can be configured with a text-only model. In that case the product must preserve
    // the real image block and the agent must state the limitation instead of hallucinating.
    const imageUnsupported =
      input.connected &&
      input.agentId === "opencode" &&
      /não suporta (?:leitura|entrada) de imagem|does not support image/i.test(mediaNoteContent);
    const mediaAccepted =
      !input.connected ||
      (pdfObserved &&
        (imageObserved || imageUnsupported) &&
        calls.filter((entry) => entry.tool === "context_read" && entry.ok).length >= 2);
    const callsHaveExpectedIdentity = calls.every(
      (entry) => entry.workspaceId === workspace.id && entry.terminalId === terminal.id
    );
    const ok =
      turn.exitCode === 0 &&
      expectedTools.every((tool) => calledTools.has(tool)) &&
      !transcript.usedForbiddenTool &&
      callsHaveExpectedIdentity &&
      trusted.ok &&
      mediaAccepted &&
      (input.connected
        ? calls.filter((entry) => entry.ok).length >= expectedTools.length
        : calls.some((entry) => entry.tool === "portal_navigate" && entry.code === expectedCode));
    if (process.env.COMPAZIO_V2_MCP_AGENT_DEBUG === "1")
      console.info(
        `[${input.agentId}] ${input.connected ? "positive" : "negative"} ${debugExcerpt(
          sanitize(turn.output, bootstrap.token)
        )}`
      );
    return {
      ok,
      exitCode: turn.exitCode,
      timedOut: turn.timedOut,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      transcript,
      calls: calls.map((entry) => ({
        tool: entry.tool,
        ok: entry.ok,
        code: entry.code,
        workspaceId: entry.workspaceId,
        terminalId: entry.terminalId
      })),
      trusted,
      media: { accepted: mediaAccepted, pdfObserved, imageObserved, imageUnsupported },
      ...(mediaNote?.type === "note" ? { mediaNoteContent: mediaNoteContent.slice(0, 1_000) } : {}),
      requests
    };
  } finally {
    await launch.cleanup();
    await input.bridge.revokeAgentMcpSession(bootstrap.sessionId);
  }
}

async function observeFullFlow(
  portals: PortalRuntimeManager,
  workspaceId: string,
  portalId: string
): Promise<Record<string, unknown>> {
  const [dom, accessibility] = await Promise.all([
    portals.automation(workspaceId, portalId, "dom", { query: "#result" }),
    portals.automation(workspaceId, portalId, "accessibility", { filter: { role: "status" } })
  ]);
  const consoleMessages = portals.consoleMessages(workspaceId, portalId, { limit: 50 });
  const domText = JSON.stringify(dom);
  const accessibilityText = JSON.stringify(accessibility);
  const diagnostics = portals.diagnostics();
  const ok =
    domText.includes("Olá, Compazio Agent Test") &&
    accessibilityText.length > 16 &&
    JSON.stringify(consoleMessages).includes("fixture log") &&
    diagnostics.screenshots >= 1;
  return {
    ok,
    resultObserved: domText.includes("Olá, Compazio Agent Test"),
    accessibilityObserved: accessibilityText.length > 16,
    consoleObserved: JSON.stringify(consoleMessages).includes("fixture log"),
    screenshots: diagnostics.screenshots
  };
}

function runAgent(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  closeStandardInput = false
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  if (!closeStandardInput) return runBufferedAgent(executable, args, cwd, environment);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
      env: { ...process.env, ...environment },
      // Codex and OpenCode keep a command-line turn alive while stdin is open. Claude 2.1.220,
      // however, completes MCP discovery through its regular stdin pipe. This is client lifecycle
      // only and never gives the model a shell or an input channel from the harness.
      stdio: [closeStandardInput ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ output, exitCode: code, timedOut });
    });
  });
}

function runBufferedAgent(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
        env: { ...process.env, ...environment }
      },
      (error, stdout, stderr) => {
        if (error !== null && error.killed)
          return resolve({ output: `${stdout}${stderr}`, exitCode: null, timedOut: true });
        if (error !== null && error.code === undefined) return reject(error);
        resolve({
          output: `${stdout}${stderr}`,
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          timedOut: false
        });
      }
    );
  });
}

function simplePdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let contents = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents));
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(contents);
  contents += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  contents += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  contents += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(contents, "latin1");
}

async function runVersion(
  executable: string,
  prefixArgs: readonly string[],
  environment: Readonly<Record<string, string>>,
  closeStandardInput: boolean
): Promise<string> {
  const turn = await runAgent(
    executable,
    [...prefixArgs, "--version"],
    tmpdir(),
    environment,
    closeStandardInput
  );
  return turn.output.trim().split(/\s+/)[0] ?? "unknown";
}

function sanitize(value: string, token: string): string {
  return value.replaceAll(token, "[REDACTED]");
}

function debugExcerpt(value: string): string {
  const events = safePortalMcpDebugEvents(value);
  return events.length > 0
    ? JSON.stringify(events).slice(-6000)
    : safePortalMcpFailureExcerpt(value) || "No sanitized MCP event was emitted.";
}

async function resolveAgentCommand(
  agentId: PortalMcpAgentId,
  executable: string
): Promise<{
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}> {
  if (process.platform !== "win32" || !/\.(cmd|bat|ps1)$/i.test(executable))
    return { executable, prefixArgs: [], environment: {} };
  const npmRoot = dirname(executable);
  if (agentId === "claude-code") {
    const native = join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    await access(native);
    return { executable: native, prefixArgs: [], environment: {} };
  }
  if (agentId === "opencode") {
    const native = join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
    await access(native);
    return { executable: native, prefixArgs: [], environment: {} };
  }
  const entry = join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  await access(entry);
  // The npm shim delegates through a shell and a bare `node` command. Resolve the concrete host
  // Node executable once in the trusted harness instead; the model receives neither a shell nor
  // a path-based capability.
  return {
    executable: await resolveHostNodeExecutable(),
    prefixArgs: [entry],
    environment: {}
  };
}

async function resolveHostNodeExecutable(): Promise<string> {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "node.exe" : "node");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next trusted host path entry.
    }
  }
  throw new Error("Node host nÃ£o foi encontrado para iniciar o cliente Codex.");
}
