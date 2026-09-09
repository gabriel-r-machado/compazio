import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import {
  PipeProcessFactory,
  PlatformProcessTreeKiller,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import type { PortalNode, TerminalSession, Workspace } from "@forgedeck/compazio-v2-domain";
import type { BrowserWindow } from "electron";

import { V2OrchestratorBridge } from "../orchestrator-bridge";
import { PortalRuntimeManager } from "../portal-runtime-manager";
import { isolatedTestEntitlement } from "../testing/isolated-entitlement";
import { V2WorkspaceService } from "../workspace-service";
import { authorizePortalControl } from "../portal-authorization";
import {
  buildPortalAgentCommand,
  buildPortalAgentVersionCommand,
  buildPortalAgentAuthCommand
} from "../portal-agent-commands";
import {
  portalAgentExitCode,
  runPortalAgentProbe,
  sanitizePortalAgentProbe,
  type PortalAgentEnvironment,
  type PortalAgentId,
  type RealPortalAgentProbe
} from "../portal-agent-harness";
import { startPortalFixture, type PortalFixture } from "./portal-fixture";

const agentIds: readonly PortalAgentId[] = ["claude-code", "codex", "opencode"];
const turnTimeoutMs = Number(process.env.COMPAZIO_V2_PORTAL_AGENT_TIMEOUT_MS ?? 300_000);
const readyTimeoutMs = 30_000;

/**
 * Runs the real, locally installed agent CLIs through the Portal flow. Each agent gets a throwaway
 * workspace, a local fixture and a Portal it may only touch through an explicit `portal-control`
 * connection; nothing here reaches the internet except the agent's own provider.
 */
export async function runPortalRealAgents(window: BrowserWindow): Promise<void> {
  const requested = (process.env.COMPAZIO_V2_PORTAL_AGENT ?? "").trim();
  const selected =
    requested === "" || requested === "all"
      ? agentIds
      : agentIds.filter((agent) => agent === requested);
  if (selected.length === 0) throw new Error(`Agente desconhecido: ${requested}`);
  const probes: RealPortalAgentProbe[] = [];
  for (const agentId of selected) probes.push(await probeAgent(window, agentId));
  const report = probes.map(sanitizePortalAgentProbe);
  const reportPath = join(
    process.env.COMPAZIO_V2_PORTAL_AGENT_REPORT ?? tmpdir(),
    `portal-real-agents-${Date.now()}.json`
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  for (const probe of report)
    console.info(
      `${probe.status.toUpperCase()} ${probe.agentId} ${probe.version ?? ""} ${JSON.stringify(probe.steps)}${
        probe.failure === undefined
          ? ""
          : ` — ${probe.failure.category}/${probe.failure.code ?? ""}: ${probe.failure.message}`
      }`
    );
  console.info(`Relatório sanitizado: ${reportPath}`);
  process.exitCode = portalAgentExitCode(report);
}

async function probeAgent(
  window: BrowserWindow,
  agentId: PortalAgentId
): Promise<RealPortalAgentProbe> {
  const root = await mkdtemp(join(tmpdir(), `compazio-portal-agent-${agentId}-`));
  const fixture: PortalFixture = await startPortalFixture();
  const repository = new V2WorkspaceRepository({ rootDirectory: join(root, "state") });
  const supervisor = new V2ProcessSupervisor(
    // npm installs these CLIs as shims; only the PTY transport can launch a shim on Windows.
    new TransportProcessFactory({ pty: new PtyProcessFactory(), pipe: new PipeProcessFactory() }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 200 }
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
  const bridge = new V2OrchestratorBridge({
    workspaces,
    agents,
    storageDirectory: join(root, "bridge"),
    nodeExecutable: process.execPath
  });
  const portals = new PortalRuntimeManager({
    getWindow: () => window,
    tempDirectory: join(root, "shots"),
    downloadDirectory: join(root, "downloads"),
    persist: async () => undefined,
    requestDownloadDecision: async () => ({ accepted: false })
  });
  const output: string[] = [];
  const release = workspaces.subscribe((event) => {
    if (event.type === "terminal.output") output.push(event.data);
  });
  let workspace: Workspace | null = null;
  let terminalId = "";
  let portal: PortalNode | null = null;
  let installation: { executable: string; version?: string } | null = null;
  const sessions: string[] = [];

  const environment: PortalAgentEnvironment = {
    detect: async () => {
      const found = await agents.detectOne(agentId).catch(() => null);
      if (found === null || found.executablePath === undefined || found.executablePath === "")
        return { installed: false, authenticated: false, issue: `${agentId} não foi encontrado.` };
      installation = {
        executable: found.executablePath,
        ...(found.version === undefined ? {} : { version: found.version })
      };
      const versionProbe = await runCommand(
        found.executablePath,
        [...buildPortalAgentVersionCommand(agentId).args],
        root,
        20_000
      );
      if (versionProbe.exitCode !== 0)
        return {
          installed: false,
          authenticated: false,
          issue: `${agentId} não respondeu a --version.`
        };
      const version = versionProbe.stdout.trim().split(/\s+/)[0] ?? found.version;
      const auth = buildPortalAgentAuthCommand(agentId);
      if (auth === null)
        return {
          installed: true,
          authenticated: true,
          ...(version === undefined ? {} : { version })
        };
      const status = await runCommand(found.executablePath, [...auth.args], root, 30_000);
      const rejected = auth.reject?.test(`${status.stdout}${status.stderr}`) ?? false;
      return {
        installed: true,
        authenticated: status.exitCode === 0 && !rejected,
        ...(version === undefined ? {} : { version }),
        ...(status.exitCode === 0 && !rejected ? {} : { issue: "Login do agente indisponível." })
      };
    },

    runTurn: async (prompt) => {
      if (installation === null) throw new Error("Agente não detectado.");
      if (workspace === null || portal === null) throw new Error("Cenário não preparado.");
      const command = buildPortalAgentCommand(agentId, {
        executable: installation.executable,
        workingDirectory: root,
        ...(process.env.COMPAZIO_V2_PORTAL_AGENT_MODEL === undefined
          ? {}
          : { model: process.env.COMPAZIO_V2_PORTAL_AGENT_MODEL })
      });
      const withTerminal = await workspaces.addTerminal(workspace.id, {
        title: `Agente ${agentId}`,
        orchestrator: true,
        agentConfig: { agentId },
        launchConfig: {
          command: command.executable,
          args: [...command.args, ...(command.promptOnStdin ? [] : [prompt])],
          env: {},
          processMode: "pty"
        }
      });
      const terminal = [...withTerminal.nodes].reverse().find((node) => node.type === "terminal");
      if (terminal === undefined) throw new Error("Terminal não criado.");
      terminalId = terminal.id;
      // The connection is what grants control; the orchestrator flag above grants nothing. It is
      // created before the agent starts so the very first `portal list` already sees the Portal.
      workspace = await workspaces.addEdge(workspace.id, terminalId, portal.id, ["portal-control"]);
      const grant = authorizePortalControl(workspace, {
        terminalNodeId: terminalId,
        portalId: portal.id
      });
      if (!grant.ok) throw new Error(`Conexão portal-control não persistiu: ${grant.code}`);
      const readyScope = { workspaceId: workspace.id, portalId: portal.id };
      await waitFor(
        "Portal pronto",
        () => portals.get(readyScope.workspaceId, readyScope.portalId).state === "ready",
        readyTimeoutMs
      );
      const startedAt = Date.now();
      const startedSession: TerminalSession = await workspaces.startTerminal(
        workspace.id,
        terminalId
      );
      const sessionId = startedSession.id;
      if (sessionId === "") throw new Error("A sessão do terminal não retornou identificador.");
      if (startedSession.terminalNodeId !== terminalId)
        throw new Error("A sessão retornada pertence a outro terminal.");
      sessions.push(sessionId);
      await waitFor(
        "sessão do agente em execução",
        () =>
          supervisor
            .list()
            .some(
              (item) =>
                item.id === sessionId &&
                ["starting", "running", "waiting-input"].includes(item.state)
            ),
        readyTimeoutMs
      );
      if (command.promptOnStdin)
        await workspaces.writeTerminal(
          workspace.id,
          terminalId,
          sessionId,
          `${prompt}
`
        );
      const finished = await waitForTerminalExit(
        workspaces,
        workspace.id,
        terminalId,
        sessionId,
        turnTimeoutMs
      );
      const transcript = output.join("");
      // Opt-in diagnosis: the sanitized report never carries agent output, but a failing local run
      // needs to show why the turn ended the way it did.
      if (process.env.COMPAZIO_V2_PORTAL_AGENT_DEBUG === "1")
        console.info(`[${agentId}] últimos 2000 caracteres:
${transcript.slice(-2_000)}`);
      return {
        stdout: transcript,
        stderr: "",
        exitCode: finished.exitCode,
        timedOut: finished.timedOut,
        durationMs: Date.now() - startedAt
      };
    },

    observe: async () => {
      if (workspace === null || portal === null) throw new Error("Cenário incompleto.");
      const scope = { workspaceId: workspace.id, portalId: portal.id };
      const read = async (query: string): Promise<string> => {
        const result = await portals
          .automation(scope.workspaceId, scope.portalId, "dom", { query })
          .catch(() => null);
        const tree = (result as { tree?: { text?: string; value?: string } } | null)?.tree;
        return tree?.text ?? tree?.value ?? "";
      };
      const snapshot = portals.get(workspace.id, portal.id);
      const nameValue = await portals
        .automation(workspace.id, portal.id, "dom", { query: "#name" })
        .then((value) => (value as { tree?: { value?: string } }).tree?.value ?? "")
        .catch(() => "");
      return {
        counter: Number((await read("#count")) || 0),
        nameValue,
        visibleResult: await read("#result"),
        navigatedUrl: snapshot.url,
        screenshotCount: portals.diagnostics().screenshots,
        consoleEntries: portals.consoleMessages(workspace.id, portal.id, { limit: 200 }).stored,
        listedByAgent: /portal list|portals/i.test(output.join(""))
      };
    },

    revoke: async () => {
      if (workspace === null || portal === null)
        return { attempted: false, code: "", fixtureUnchanged: false };
      const before = portals.get(workspace.id, portal.id).url;
      const portalId = portal.id;
      const edge = workspace.edges.find((item) => item.targetNodeId === portalId);
      if (edge !== undefined) workspace = await workspaces.removeEdge(workspace.id, edge.id);
      const terminal = workspace.nodes.find((node) => node.id === terminalId);
      if (terminal === undefined || terminal.type !== "terminal")
        return { attempted: false, code: "", fixtureUnchanged: false };
      // The same private CLI the agent used, with a session for the same terminal: only the
      // connection is gone, so the refusal has to come from the bridge itself.
      const sessionId = `revocation-${Date.now()}`;
      const prepared = await bridge.prepare({ workspace, terminal, sessionId });
      const result = await runCommand(
        prepared.environment.COMPAZIO_BRIDGE_CLI ?? "compazio",
        ["portal", "navigate", portal.id, `${fixture.baseUrl}/second`],
        root,
        60_000,
        prepared.environment
      );
      await bridge.revoke(sessionId).catch(() => undefined);
      const text = `${result.stdout}${result.stderr}`;
      return {
        attempted: true,
        code: /PORTAL_NOT_CONNECTED/.test(text) ? "PORTAL_NOT_CONNECTED" : text.slice(0, 120),
        fixtureUnchanged: portals.get(workspace.id, portal.id).url === before
      };
    },

    cleanup: async () => {
      if (workspace !== null) {
        for (const id of sessions)
          await workspaces.stopTerminal(workspace.id, terminalId, id).catch(() => undefined);
        if (portal !== null) await portals.destroy(workspace.id, portal.id).catch(() => undefined);
        await workspaces.close(workspace.id).catch(() => undefined);
      }
      await portals.shutdown().catch(() => undefined);
      await bridge.shutdown().catch(() => undefined);
      await workspaces.shutdown().catch(() => undefined);
      release();
      await fixture.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      const diagnostics = portals.diagnostics();
      return {
        views: diagnostics.views,
        webContents: diagnostics.webContents,
        listeners: diagnostics.listeners,
        pendingOperations: diagnostics.pendingOperations,
        screenshots: diagnostics.screenshots,
        agentProcesses: supervisor.list().filter((session) => session.state === "running").length,
        temporaryRemoved: true
      };
    }
  };

  try {
    // The Portal has to exist before the probe builds the prompt: the instruction names its id.
    workspace = await workspaces.create({ name: `Portal ${agentId}`, workingDirectory: root });
    const withPortal = await workspaces.addPortal(workspace.id, { url: fixture.baseUrl });
    const created = [...withPortal.nodes]
      .reverse()
      .find((node): node is PortalNode => node.type === "portal");
    if (created === undefined) throw new Error("Portal não criado.");
    portal = created;
    await portals.ensure(workspace.id, created);
    portals.setWindowState({ activeWorkspaceId: workspace.id });
    return await runPortalAgentProbe(agentId, environment, {
      fixtureUrl: fixture.baseUrl,
      portalId: created.id
    });
  } finally {
    await environment.cleanup().catch(() => undefined);
  }
}

async function waitForTerminalExit(
  workspaces: V2WorkspaceService,
  workspaceId: string,
  terminalNodeId: string,
  sessionId: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      release();
      void workspaces.stopTerminal(workspaceId, terminalNodeId, sessionId).catch(() => undefined);
      resolve({ exitCode: null, timedOut: true });
    }, timeoutMs);
    const release = workspaces.subscribe((event) => {
      if (event.type !== "terminal.state") return;
      const session = event.session;
      if (session.workspaceId !== workspaceId || session.terminalNodeId !== terminalNodeId) return;
      if (!["completed", "failed", "stopped", "disconnected"].includes(session.state)) return;
      clearTimeout(timer);
      release();
      resolve({
        exitCode: session.exitCode ?? (session.state === "completed" ? 0 : 1),
        timedOut: false
      });
    });
  });
}

function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  extraEnvironment: Readonly<Record<string, string>> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        shell: executable.endsWith(".cmd") || executable.endsWith(".bat"),
        env: { ...process.env, ...extraEnvironment }
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : error.code === undefined
                ? 1
                : 1;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code });
      }
    );
  });
}

/** Deterministic readiness: poll a real predicate on a short interval instead of sleeping blindly. */
async function waitFor(
  what: string,
  ready: () => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let satisfied: boolean;
    try {
      satisfied = ready();
    } catch {
      satisfied = false;
    }
    if (satisfied) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Estado não ficou pronto a tempo: ${what}`);
}
