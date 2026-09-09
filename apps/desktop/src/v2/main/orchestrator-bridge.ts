import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import {
  type AgentDefinition,
  type AgentRole,
  type CanvasNode,
  type EdgeCapability,
  type TerminalSession,
  type Workspace
} from "@forgedeck/compazio-v2-domain";
import type { AgentRuntime } from "@forgedeck/compazio-v2-runtime";

import type {
  V2OrchestratorBridge as V2OrchestratorBridgeContract,
  V2WorkspaceService
} from "./workspace-service";
import type { V2OperationalService } from "./operational-service";
import type { GitService } from "./git-service";
import type { PortalAutomationInput, PortalRuntimeManager } from "./portal-runtime-manager";
import {
  authorizePortalControl,
  hasPortalControl,
  listPortalCapabilities
} from "./portal-authorization";
import { PortalError } from "./portal-operations";
import {
  CompazioMcpGateway,
  compazioToolsForCapabilities,
  type CompazioMcpBootstrap,
  type CompazioMcpCapability,
  type CompazioMcpHttpRequest,
  type CompazioMcpToolCall
} from "./compazio-mcp-gateway";
import {
  createPortalMcpLaunch,
  type PortalMcpAgentId,
  type PortalMcpLaunch
} from "./portal-mcp-agent-config";
import {
  buildTerminalPromptDelivery,
  ConnectionBroker,
  ConnectionBrokerError,
  type ConnectionRequest
} from "./connection-broker";

const maximumRequestBytes = 64 * 1024;
const defaultWaitTimeoutMs = 30_000;
const maximumWaitTimeoutSeconds = 3_600;
const maximumOwnedAgents = 6;
const maximumRunningOwnedAgents = 4;
const codingAgentIds = new Set(["claude-code", "codex", "opencode"]);

function shutdownTrace(stage: string, metadata: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.COMPAZIO_V2_SHUTDOWN_TRACE !== "1") return;
  console.info(
    `COMPAZIO_SHUTDOWN_TRACE ${JSON.stringify({ stage, at: new Date().toISOString(), ...metadata })}`
  );
}

interface BridgeSession {
  readonly token: string;
  readonly mode: "agent" | "orchestrator";
  readonly workspaceId: string;
  readonly terminalNodeId: string;
  readonly sessionId: string;
  readonly shimDirectory: string;
  readonly protocol: string;
}

interface AgentMcpLaunchSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly terminalNodeId: string;
  readonly mcpSessionId?: string;
  readonly directory: string;
  readonly launch: PortalMcpLaunch;
  state: "connecting" | "connected" | "limited" | "disconnected" | "error";
}

export type AgentMcpConnectionState = AgentMcpLaunchSession["state"];

interface BridgeCommandRequest {
  readonly args: readonly string[];
}

export interface V2OrchestratorBridgeOptions {
  readonly workspaces: V2WorkspaceService;
  readonly agents: AgentRuntime;
  readonly storageDirectory: string;
  /** Node-compatible executable used by the POSIX session shim. Windows uses system PowerShell. */
  readonly nodeExecutable: string;
  readonly notify?: (input: { readonly title: string; readonly body: string }) => void;
  readonly operations?: V2OperationalService;
  readonly git?: GitService;
  readonly portals?: PortalRuntimeManager;
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly orchestratorMode?: boolean;
}

/**
 * Internal, loopback-only command bridge for an orchestrator or one of its restricted recruits.
 * Tokens and shims live only for the owning process session and are not persisted with a workspace.
 */
export class V2OrchestratorBridge implements V2OrchestratorBridgeContract {
  private readonly sessionsByToken = new Map<string, BridgeSession>();
  private readonly sessionsById = new Map<string, BridgeSession>();
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly connections: ConnectionBroker;
  private readonly agentMcpLaunches = new Map<string, AgentMcpLaunchSession>();
  private readonly mcpStateListeners = new Set<
    (input: { readonly terminalId: string; readonly state: AgentMcpConnectionState }) => void
  >();
  /** Keep only this bridge's loopback sockets so shutdown/reload cannot wait on a live CLI client. */
  private readonly serverSockets = new Set<Socket>();
  private server: Server | null = null;
  private endpoint: string | null = null;
  private mcpGateway: CompazioMcpGateway | null = null;

  public constructor(private readonly options: V2OrchestratorBridgeOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.connections = new ConnectionBroker({
      storageDirectory: options.storageDirectory,
      createId: this.createId,
      now: this.now
    });
  }

  public async start(): Promise<void> {
    if (this.server !== null) return;
    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    server.on("connection", (socket) => {
      this.serverSockets.add(socket);
      socket.once("close", () => this.serverSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("The local orchestration bridge did not receive a TCP port");
    }
    this.server = server;
    this.endpoint = `http://127.0.0.1:${address.port}/v1/command`;
    if (this.options.portals !== undefined) {
      this.mcpGateway = new CompazioMcpGateway(this.options.workspaces, this.options.portals);
      await this.mcpGateway.start();
      await this.mcpGateway.restoreManagedWorkspaceServer();
      this.mcpGateway.subscribeHttpRequests((request) => {
        if (request.outcome !== "accepted" || request.compazioSessionId === undefined) return;
        const launch = [...this.agentMcpLaunches.values()].find(
          (candidate) => candidate.mcpSessionId === request.compazioSessionId
        );
        if (launch === undefined || launch.state === "connected") return;
        launch.state = "connected";
        this.publishMcpState(launch.terminalNodeId, launch.state);
      });
    }
  }

  /** Legacy UI boundary retained while old operational state remains readable. */
  public async answerTeamUserInput(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly requestId: string;
    readonly answer: string;
  }): Promise<never> {
    void input;
    throw new Error("A coordenação automática está desativada no núcleo real do Compazio.");
  }

  public diagnostics(): {
    readonly listening: boolean;
    readonly sessionCount: number;
    readonly taskCount: number;
    readonly waitingTaskCount: number;
  } {
    return {
      listening: this.server !== null,
      sessionCount: this.sessionsById.size,
      taskCount: 0,
      waitingTaskCount: 0
    };
  }

  /** Runtime-only UI state. Tokens, URLs and transport ids intentionally never cross this boundary. */
  public mcpState(terminalId: string): AgentMcpConnectionState {
    return (
      [...this.agentMcpLaunches.values()].find((launch) => launch.terminalNodeId === terminalId)
        ?.state ?? "disconnected"
    );
  }

  public subscribeMcpState(
    listener: (input: {
      readonly terminalId: string;
      readonly state: AgentMcpConnectionState;
    }) => void
  ): () => void {
    this.mcpStateListeners.add(listener);
    return () => this.mcpStateListeners.delete(listener);
  }

  public async prepare(input: {
    readonly workspace: Workspace;
    readonly terminal: Extract<CanvasNode, { readonly type: "terminal" }>;
    readonly sessionId: string;
  }): Promise<{
    readonly environment: Readonly<Record<string, string>>;
    readonly initialInput: string;
  }> {
    if (
      input.terminal.agentConfig.agentId !== "claude-code" &&
      input.terminal.agentConfig.agentId !== "codex" &&
      input.terminal.agentConfig.agentId !== "opencode"
    ) {
      throw new BridgeError(
        "BRIDGE_NOT_ENABLED",
        "Somente terminais de coding agents recebem o protocolo Compazio."
      );
    }
    const mode: BridgeSession["mode"] =
      this.options.orchestratorMode === true &&
      (input.terminal.isCompazio || input.terminal.orchestrator)
        ? "orchestrator"
        : "agent";
    if (this.endpoint === null) throw new Error("The local orchestration bridge has not started");
    const token = randomBytes(32).toString("base64url");
    const shimDirectory = join(
      this.options.storageDirectory,
      "connection-sessions",
      input.sessionId
    );
    await mkdir(shimDirectory, { recursive: true });
    const protocolPath = join(shimDirectory, "COMPAZIO_PROTOCOL.md");
    const protocol =
      mode === "orchestrator"
        ? buildCoordinatorProtocol({
            base: orchestratorProtocol,
            terminal: input.terminal,
            definitions: await this.options.agents.listDefinitions(),
            roles: await this.options.agents.listRoles()
          })
        : orchestratorProtocol;
    await writeBridgeShim(shimDirectory);
    await writeFile(protocolPath, protocol, "utf8");
    const session: BridgeSession = {
      token,
      mode,
      workspaceId: input.workspace.id,
      terminalNodeId: input.terminal.id,
      sessionId: input.sessionId,
      shimDirectory,
      protocol
    };
    this.sessionsByToken.set(token, session);
    this.sessionsById.set(input.sessionId, session);
    return {
      environment: {
        COMPAZIO_BRIDGE_ENDPOINT: this.endpoint,
        COMPAZIO_BRIDGE_TOKEN: token,
        COMPAZIO_BRIDGE_NODE: this.options.nodeExecutable,
        COMPAZIO_BRIDGE_CLI: join(
          shimDirectory,
          process.platform === "win32" ? "compazio.ps1" : "compazio"
        ),
        COMPAZIO_BRIDGE_SESSION_ID: input.sessionId,
        COMPAZIO_ORCHESTRATOR: mode === "orchestrator" ? "true" : "false",
        COMPAZIO_PROTOCOL: protocolPath,
        COMPAZIO_ORCHESTRATOR_PROTOCOL: protocolPath,
        PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`
      },
      /**
       * Deliberately empty: a terminal opens ready for the person to type.
       *
       * Briefing the agent by typing into its stdin also submitted the text, so the session began
       * with a turn nobody asked for and the input line came up already full. The same instructions
       * remain available to the agent through COMPAZIO_PROTOCOL, alongside the private
       * session-scoped `compazio` CLI.
       */
      initialInput: ""
    };
  }

  /**
   * Creates process-scoped MCP configuration for either a person-owned terminal or an isolated
   * background task. The only secret is placed in the child environment; renderer and workspace
   * persistence never see it.
   */
  public async prepareAgentMcp(input: {
    readonly workspace: Workspace;
    readonly terminal: Extract<CanvasNode, { readonly type: "terminal" }>;
    readonly sessionId: string;
    readonly mode?: "interactive" | "task";
    readonly prompt?: string;
    readonly workspaceAccess?: "read" | "write";
  }): Promise<
    | {
        readonly environment: Readonly<Record<string, string>>;
        readonly args: readonly string[];
      }
    | undefined
  > {
    if (
      input.terminal.agentConfig.agentId !== "claude-code" &&
      input.terminal.agentConfig.agentId !== "codex" &&
      input.terminal.agentConfig.agentId !== "opencode"
    )
      return undefined;
    const portalCapabilities = listPortalCapabilities(input.workspace, input.terminal.id);
    const capabilities: readonly CompazioMcpCapability[] = [...portalCapabilities];
    // Context tools re-authorize against the live canvas graph on every call. Every coding-agent
    // session therefore receives the ephemeral local MCP transport even when it starts with no
    // Portal edge; a coordinator can connect a note/image/Portal later without restarting its TUI.
    const bootstrap =
      this.mcpGateway === null
        ? undefined
        : this.mcpGateway.createAgentSession({
            workspaceId: input.workspace.id,
            terminalId: input.terminal.id,
            capabilities
          });
    const directory = join(this.options.storageDirectory, "mcp-agent-sessions", input.sessionId);
    await mkdir(directory, { recursive: true });
    try {
      const bridgeSession = this.sessionsById.get(input.sessionId);
      const orchestratorInstructionsPath =
        input.mode !== "task" && bridgeSession !== undefined
          ? join(bridgeSession.shimDirectory, "COMPAZIO_PROTOCOL.md")
          : undefined;
      const launch = await createPortalMcpLaunch({
        agentId: input.terminal.agentConfig.agentId as PortalMcpAgentId,
        directory,
        workingDirectory: input.terminal.workingDirectory ?? input.workspace.workingDirectory,
        ...(bootstrap === undefined
          ? {}
          : { endpoint: bootstrap.endpoint, token: bootstrap.token }),
        interactive: input.mode !== "task",
        ...(orchestratorInstructionsPath === undefined
          ? {}
          : {
              orchestratorInstructionsPath,
              orchestratorInstructions: bridgeSession?.protocol ?? orchestratorProtocol
            }),
        ...(input.mode === "task" ? { prompt: input.prompt } : {}),
        ...(input.mode === "task" ? { workspaceAccess: input.workspaceAccess ?? "write" } : {}),
        tools: compazioToolsForCapabilities(capabilities)
      });
      const state: AgentMcpConnectionState = bootstrap === undefined ? "limited" : "connecting";
      this.agentMcpLaunches.set(input.sessionId, {
        sessionId: input.sessionId,
        workspaceId: input.workspace.id,
        terminalNodeId: input.terminal.id,
        ...(bootstrap === undefined ? {} : { mcpSessionId: bootstrap.sessionId }),
        directory,
        launch,
        state
      });
      this.publishMcpState(input.terminal.id, state);
      return { environment: launch.environment, args: launch.args };
    } catch (error) {
      if (bootstrap !== undefined) await this.mcpGateway?.revokeAgentSession(bootstrap.sessionId);
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  public async revoke(sessionId: string): Promise<void> {
    const launch = this.agentMcpLaunches.get(sessionId);
    if (launch !== undefined) {
      this.agentMcpLaunches.delete(sessionId);
      if (launch.mcpSessionId !== undefined)
        await this.mcpGateway?.revokeAgentSession(launch.mcpSessionId);
      await launch.launch.cleanup().catch(() => undefined);
      await rm(launch.directory, { force: true, recursive: true });
      this.publishMcpState(launch.terminalNodeId, "disconnected");
    }
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) return;
    await this.mcpGateway?.revokeSessionsForTerminal(session.terminalNodeId);
    this.sessionsById.delete(sessionId);
    this.sessionsByToken.delete(session.token);
    await rm(session.shimDirectory, { force: true, recursive: true });
  }

  public async shutdown(): Promise<void> {
    shutdownTrace("bridge-shutdown-start");
    await Promise.all([...this.sessionsById.keys()].map((sessionId) => this.revoke(sessionId)));
    await Promise.all([...this.agentMcpLaunches.keys()].map((sessionId) => this.revoke(sessionId)));
    shutdownTrace("bridge-mcp-sessions-revoked");
    await this.mcpGateway?.shutdown();
    this.mcpGateway = null;
    shutdownTrace("bridge-mcp-gateway-closed");
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    for (const socket of this.serverSockets) socket.destroy();
    this.serverSockets.clear();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    shutdownTrace("bridge-server-closed");
  }

  /** Trusted main-process bootstrap for a real agent MCP configuration. Never expose its token to IPC. */
  public createAgentMcpSession(input: {
    readonly workspaceId: string;
    readonly terminalId: string;
    readonly capabilities: readonly CompazioMcpCapability[];
  }): CompazioMcpBootstrap {
    if (this.mcpGateway === null)
      throw new BridgeError("MCP_UNAVAILABLE", "O gateway MCP não está disponível.");
    return this.mcpGateway.createAgentSession(input);
  }

  public async revokeAgentMcpSession(sessionId: string): Promise<void> {
    await this.mcpGateway?.revokeAgentSession(sessionId);
  }

  public async revokeMcpSessionsForTerminal(terminalId: string): Promise<void> {
    await Promise.all(
      [...this.agentMcpLaunches.values()]
        .filter((launch) => launch.terminalNodeId === terminalId)
        .map((launch) => this.revoke(launch.sessionId))
    );
    await this.mcpGateway?.revokeSessionsForTerminal(terminalId);
  }

  public async revokeMcpSessionsForWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.agentMcpLaunches.values()]
        .filter((launch) => launch.workspaceId === workspaceId)
        .map((launch) => this.revoke(launch.sessionId))
    );
    await this.mcpGateway?.revokeSessionsForWorkspace(workspaceId);
  }

  public subscribeMcpToolCalls(listener: (call: CompazioMcpToolCall) => void): () => void {
    return this.mcpGateway?.subscribeToolCalls(listener) ?? (() => undefined);
  }

  public subscribeMcpHttpRequests(listener: (request: CompazioMcpHttpRequest) => void): () => void {
    return this.mcpGateway?.subscribeHttpRequests(listener) ?? (() => undefined);
  }

  private publishMcpState(terminalId: string, state: AgentMcpConnectionState): void {
    for (const listener of this.mcpStateListeners) listener({ terminalId, state });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/v1/command") {
        this.respond(response, 404, {
          ok: false,
          error: { code: "NOT_FOUND", message: "Not found" }
        });
        return;
      }
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const session = token === undefined ? undefined : this.sessionsByToken.get(token);
      if (session === undefined) {
        this.respond(response, 401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Sessão do orquestrador não autorizada." }
        });
        return;
      }
      const payload = parseBridgeRequest(await readRequestBody(request));
      const result = await this.execute(session, payload.args);
      this.respond(response, 200, { ok: true, result });
    } catch (error) {
      const bridgeError = toBridgeError(error);
      this.respond(response, bridgeError.status, {
        ok: false,
        error: { code: bridgeError.code, message: bridgeError.message }
      });
    }
  }

  private async execute(session: BridgeSession, args: readonly string[]): Promise<unknown> {
    const workspace = await this.assertActiveBridgeSession(session);
    if (args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h")) {
      return bridgeHelp(session.mode === "orchestrator" && this.options.orchestratorMode === true);
    }
    const command = args[0];
    switch (command) {
      case "me":
        return this.me(workspace, session);
      case "list":
        return this.list(workspace, session);
      case "send":
        return this.send(workspace, session, args.slice(1));
      case "reply":
        return this.reply(workspace, session, args.slice(1));
      case "inbox":
        return this.inbox(workspace, session);
      case "wait":
        return this.wait(workspace, session, args.slice(1));
      case "note":
        return this.note(workspace, session, args.slice(1));
      case "portal":
        return this.portal(workspace, session, args.slice(1));
    }
    if (session.mode !== "orchestrator" || this.options.orchestratorMode !== true) {
      throw new BridgeError(
        "ORCHESTRATOR_MODE_DISABLED",
        "A administração automática está desativada. Use conexões manuais no canvas.",
        403
      );
    }
    switch (command) {
      case "spawn":
        return this.spawn(workspace, session, args.slice(1));
      case "connect":
        return this.connect(workspace, session, args.slice(1));
      case "disconnect":
        return this.disconnect(workspace, session, args.slice(1));
      case "assign-role":
        return this.assignRole(workspace, session, args.slice(1));
      case "close":
        return this.close(workspace, session, args.slice(1));
      case "notify":
        return this.notify(session, args.slice(1));
      default:
        throw new BridgeError("UNKNOWN_COMMAND", `Comando desconhecido: ${command}`);
    }
  }

  private async assertActiveBridgeSession(session: BridgeSession): Promise<Workspace> {
    const workspace = await this.options.workspaces.snapshot(session.workspaceId);
    const terminal = requireTerminal(workspace, session.terminalNodeId);
    if (session.mode === "orchestrator" && !terminal.isCompazio && !terminal.orchestrator) {
      throw new BridgeError(
        "ORCHESTRATOR_NOT_ENABLED",
        "O modo orquestrador foi desativado para este terminal."
      );
    }
    const active = this.options.workspaces.sessionForNode(
      session.workspaceId,
      session.terminalNodeId
    );
    if (
      active?.id !== session.sessionId ||
      !["starting", "running", "waiting-input"].includes(active.state)
    ) {
      throw new BridgeError(
        "SESSION_INACTIVE",
        "A sessão com acesso à bridge não está em execução."
      );
    }
    return workspace;
  }

  private async me(workspace: Workspace, session: BridgeSession): Promise<unknown> {
    const terminal = requireTerminal(workspace, session.terminalNodeId);
    const coordinatorEnabled =
      session.mode === "orchestrator" && this.options.orchestratorMode === true;
    return {
      workspaceId: workspace.id,
      terminal: serializeNode(
        terminal,
        this.options.workspaces.sessionForNode(workspace.id, terminal.id)
      ),
      workspacePermissions: workspace.permissions,
      permissions: [
        "list",
        "send",
        "reply",
        "inbox",
        "wait",
        "note:read",
        "note:write",
        "note:append",
        "portal:connected",
        ...(coordinatorEnabled
          ? ["spawn", "connect", "disconnect", "assign-role", "close", "notify", "note:create"]
          : [])
      ],
      ...(coordinatorEnabled ? { limits: { maximumOwnedAgents, maximumRunningOwnedAgents } } : {})
    };
  }

  private list(workspace: Workspace, session: BridgeSession): unknown {
    const edges = workspace.edges.filter(
      (edge) =>
        edge.sourceNodeId === session.terminalNodeId || edge.targetNodeId === session.terminalNodeId
    );
    const connectedNodeIds = new Set(
      edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId])
    );
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        workingDirectory: workspace.workingDirectory
      },
      selfNodeId: session.terminalNodeId,
      nodes: workspace.nodes
        .filter((node) => connectedNodeIds.has(node.id))
        .map((node) =>
          serializeNode(
            node,
            node.type === "terminal"
              ? this.options.workspaces.sessionForNode(workspace.id, node.id)
              : null
          )
        ),
      edges: edges.map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        capabilities: edge.capabilities
      }))
    };
  }

  private async spawn(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const parsed = parseOptions(args, ["agent", "role", "title", "preset"]);
    if (parsed.positionals.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Use spawn [--agent <id>] [--role <id|nome>] [--title <nome>]."
      );
    }
    const parent = requireTerminal(workspace, session.terminalNodeId);
    const owned = workspace.nodes.filter(
      (node) => node.type === "terminal" && node.orchestratorOwnerNodeId === parent.id
    );
    if (owned.length >= maximumOwnedAgents) {
      throw new BridgeError(
        "AGENT_LIMIT_REACHED",
        `Este coordenador pode manter no máximo ${maximumOwnedAgents} agentes criados por ele.`,
        409
      );
    }
    const activeOwned = owned.filter((node) => {
      const active = this.options.workspaces.sessionForNode(workspace.id, node.id);
      return active !== null && ["starting", "running", "waiting-input"].includes(active.state);
    });
    if (activeOwned.length >= maximumRunningOwnedAgents) {
      throw new BridgeError(
        "CONCURRENT_AGENT_LIMIT_REACHED",
        `Encerre ou reutilize um agente antes de ultrapassar ${maximumRunningOwnedAgents} terminais ativos.`,
        409
      );
    }
    const agentId = parsed.options.agent ?? parent.agentConfig.agentId;
    const definition = (await this.options.agents.listDefinitions()).find(
      (agent) => agent.id === agentId
    );
    if (definition === undefined || !codingAgentIds.has(agentId)) {
      throw new BridgeError("AGENT_NOT_FOUND", `Coding agent não encontrado: ${agentId}`);
    }
    const preset =
      parsed.options.preset === undefined
        ? undefined
        : (await this.options.agents.listPresets()).find(
            (candidate) => candidate.id === parsed.options.preset
          );
    if (parsed.options.preset !== undefined && preset === undefined) {
      throw new BridgeError("PRESET_NOT_FOUND", `Preset não encontrado: ${parsed.options.preset}`);
    }
    if (preset !== undefined && preset.agentId !== agentId) {
      throw new BridgeError("INVALID_ARGUMENT", "O preset pertence a outro tipo de agente.");
    }
    const role =
      parsed.options.role === undefined
        ? undefined
        : resolveRole(await this.options.agents.listRoles(), parsed.options.role);
    const title = parsed.options.title?.trim() || role?.name || definition.name;
    if (title.length > 240) {
      throw new BridgeError("INVALID_ARGUMENT", "O nome do terminal excede 240 caracteres.");
    }
    const index = owned.length;
    const created = await this.options.workspaces.addTerminal(workspace.id, {
      title,
      position: {
        x: parent.position.x + (index % 2) * (parent.size.width + 48),
        y: parent.position.y + parent.size.height + 72 + Math.floor(index / 2) * 472
      },
      agentConfig: {
        agentId,
        ...(preset === undefined ? {} : { presetId: preset.id }),
        ...(role === undefined ? {} : { roleId: role.id })
      },
      orchestratorOwnerNodeId: session.terminalNodeId
    });
    const terminal = created.nodes.find(
      (node) =>
        node.type === "terminal" &&
        node.id !== session.terminalNodeId &&
        !workspace.nodes.some((old) => old.id === node.id)
    );
    if (terminal === undefined || terminal.type !== "terminal") {
      throw new Error("The spawned terminal could not be located after persistence");
    }
    try {
      const active = await this.options.workspaces.startTerminal(workspace.id, terminal.id);
      const connected = await this.options.workspaces.addEdge(
        workspace.id,
        session.terminalNodeId,
        terminal.id,
        ["send-message", "share-context"]
      );
      const edge = connected.edges.find(
        (candidate) =>
          candidate.sourceNodeId === session.terminalNodeId &&
          candidate.targetNodeId === terminal.id
      );
      if (edge === undefined) throw new Error("The spawned terminal connection is missing");
      const arranged = await this.options.workspaces.snapshot(workspace.id);
      return {
        terminal: serializeNode(
          requireTerminal(arranged, terminal.id),
          this.options.workspaces.sessionForNode(workspace.id, terminal.id)
        ),
        session: active,
        edge,
        limits: { maximumOwnedAgents, maximumRunningOwnedAgents }
      };
    } catch (error) {
      await this.options.workspaces.deleteNode(workspace.id, terminal.id).catch(() => undefined);
      throw error;
    }
  }

  private async connect(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const parsed = parseOptions(args, ["capabilities"]);
    if (parsed.positionals.length === 0 || parsed.positionals.length > 2) {
      throw new BridgeError("INVALID_ARGUMENT", "Use connect <nó> ou connect <origem> <destino>.");
    }
    const sourceReference =
      parsed.positionals.length > 1 ? parsed.positionals[0] : session.terminalNodeId;
    const targetReference =
      parsed.positionals.length > 1 ? parsed.positionals[1] : parsed.positionals[0];
    if (sourceReference === undefined || targetReference === undefined) {
      throw new BridgeError("INVALID_ARGUMENT", "Informe o nó que deve ser conectado.");
    }
    const source = resolveWorkspaceNode(workspace, sourceReference);
    const target = resolveWorkspaceNode(workspace, targetReference);
    if (source.type !== "terminal") {
      throw new BridgeError("INVALID_ARGUMENT", "A origem da conexão precisa ser um terminal.");
    }
    assertCoordinatorCanConnect(workspace, session.terminalNodeId, source, target);
    const capabilities = connectionCapabilitiesForNodes(
      source,
      target,
      parsed.options.capabilities
    );
    const existing = workspace.edges.find(
      (edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id
    );
    if (existing !== undefined) {
      const missing = capabilities.filter(
        (capability) => !existing.capabilities.includes(capability)
      );
      if (missing.length > 0) {
        throw new BridgeError(
          "CONNECTION_ALREADY_EXISTS",
          `A conexão já existe, mas não concede: ${missing.join(", ")}.`
        );
      }
      return { edge: existing, created: false };
    }
    const updated = await this.options.workspaces.addEdge(
      workspace.id,
      source.id,
      target.id,
      capabilities
    );
    const edge = updated.edges.find(
      (candidate) => candidate.sourceNodeId === source.id && candidate.targetNodeId === target.id
    );
    if (edge === undefined) throw new Error("The created bridge connection could not be located");
    return { edge, created: true };
  }

  private async disconnect(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    if (args.length === 0 || args.length > 2) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Use disconnect <edge-id> ou disconnect <origem> <destino>."
      );
    }
    const edge =
      args.length === 1
        ? workspace.edges.find((candidate) => candidate.id === args[0])
        : resolveEdgeByEndpoints(
            workspace,
            resolveWorkspaceNode(workspace, args[0] ?? "").id,
            resolveWorkspaceNode(workspace, args[1] ?? "").id
          );
    if (edge === undefined) throw new BridgeError("EDGE_NOT_FOUND", "Conexão não encontrada.");
    assertCoordinatorOwnsEdge(workspace, session.terminalNodeId, edge);
    await this.options.workspaces.removeEdge(workspace.id, edge.id);
    return { edgeId: edge.id, disconnected: true };
  }

  private async assignRole(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const terminalReference = args[0];
    const roleReference = args[1];
    if (terminalReference === undefined || roleReference === undefined || args.length !== 2) {
      throw new BridgeError("INVALID_ARGUMENT", "Use assign-role <terminal> <papel>.");
    }
    const terminal = resolveOwnedTerminal(workspace, session.terminalNodeId, terminalReference);
    const role = resolveRole(await this.options.agents.listRoles(), roleReference);
    const result = await this.options.workspaces.assignTerminalRole(
      workspace.id,
      terminal.id,
      role.id
    );
    return { terminalNodeId: terminal.id, roleId: role.id, session: result.session };
  }

  private async send(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const parsed = parseOptions(args, ["wait", "timeout"]);
    const targetReference = parsed.positionals[0];
    const message = parsed.positionals.slice(1).join(" ").trim();
    if (targetReference === undefined || message === "") {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Use send <destino> <mensagem> [--wait] [--timeout <segundos>]."
      );
    }
    if (message.length > 32_000)
      throw new BridgeError("INVALID_ARGUMENT", "A mensagem excede 32 KB.");
    const { terminal: target, edge } = resolveConnectedTerminal(
      workspace,
      session.terminalNodeId,
      targetReference
    );
    if (target.agentConfig.agentId === "shell" || target.agentConfig.agentId === "custom") {
      throw new BridgeError(
        "TARGET_NOT_AGENT",
        "Shell e terminais customizados não aceitam mensagens automáticas."
      );
    }
    const targetSession = this.options.workspaces.sessionForNode(workspace.id, target.id);
    if (
      targetSession === null ||
      !["starting", "running", "waiting-input"].includes(targetSession.state)
    ) {
      throw new BridgeError(
        "TARGET_NOT_RUNNING",
        `O terminal ${target.title} está parado ou indisponível.`,
        409
      );
    }
    const source = requireTerminal(workspace, session.terminalNodeId);
    const request = await this.connections.create({
      workspaceId: workspace.id,
      edgeId: edge.id,
      sourceTerminalId: source.id,
      targetTerminalId: target.id,
      message
    });
    try {
      await this.options.workspaces.deliverConnectionPrompt(
        workspace.id,
        target.id,
        buildTerminalPromptDelivery({
          requestId: request.id,
          sourceTitle: source.title,
          message: request.message
        })
      );
      await this.connections.markDelivered(workspace.id, request.id);
    } catch (error) {
      await this.connections.fail(
        workspace.id,
        request.id,
        error instanceof Error ? error.message : "Falha ao escrever no PTY de destino."
      );
      throw error;
    }
    if (parsed.options.wait !== undefined) {
      const result = await this.connections.waitForResponse(
        workspace.id,
        request.id,
        parseTimeout(parsed.options.timeout)
      );
      return serializeConnectionRequest(result.request, result.timedOut);
    }
    return serializeConnectionRequest(await this.connections.get(workspace.id, request.id), false);
  }

  private async wait(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const parsed = parseOptions(args, ["timeout"]);
    const requestId = parsed.positionals[0];
    if (requestId === undefined)
      throw new BridgeError("INVALID_ARGUMENT", "Use wait <request-id> [--timeout <segundos>].");
    const request = await this.connections.get(workspace.id, requestId);
    if (request.sourceTerminalId !== session.terminalNodeId) {
      throw new BridgeError(
        "REQUEST_PERMISSION_DENIED",
        "Esta solicitação pertence a outro terminal."
      );
    }
    const result = await this.connections.waitForResponse(
      workspace.id,
      request.id,
      parseTimeout(parsed.options.timeout)
    );
    return serializeConnectionRequest(result.request, result.timedOut);
  }

  private async reply(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const requestId = args[0];
    const response = args.slice(1).join(" ").trim();
    if (requestId === undefined || response === "") {
      throw new BridgeError("INVALID_ARGUMENT", "Use reply <request-id> <resultado>.");
    }
    return serializeConnectionRequest(
      await this.connections.reply({
        workspaceId: workspace.id,
        requestId,
        actorTerminalId: session.terminalNodeId,
        response
      }),
      false
    );
  }

  private async inbox(workspace: Workspace, session: BridgeSession): Promise<unknown> {
    const requests = await this.connections.inbox(workspace.id, session.terminalNodeId);
    return {
      requests: requests.map((request) => ({
        ...serializeConnectionRequest(request, false),
        message: request.message
      }))
    };
  }

  private async note(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const action = args[0];
    const noteId = args[1];
    if (action === "create") {
      if (session.mode !== "orchestrator" || this.options.orchestratorMode !== true)
        throw new BridgeError(
          "ORCHESTRATOR_MODE_DISABLED",
          "Crie a nota no canvas e conecte-a explicitamente ao terminal.",
          403
        );
      const createArgs = args.slice(1);
      const usesOptions = createArgs.some((value) => value.startsWith("--"));
      const parsed = usesOptions ? parseOptions(createArgs, ["title", "content"]) : null;
      if (parsed !== null && parsed.positionals.length > 0) {
        throw new BridgeError(
          "INVALID_ARGUMENT",
          "Não misture argumentos posicionais com --title/--content."
        );
      }
      const title = (parsed?.options.title ?? noteId)?.trim();
      if (title === undefined || title === "") {
        throw new BridgeError(
          "INVALID_ARGUMENT",
          "Use note create <título> [conteúdo] ou note create --title <título> [--content <conteúdo>]."
        );
      }
      const content = parsed?.options.content ?? args.slice(2).join(" ");
      const updated = await this.options.workspaces.addNote(workspace.id, {
        title: title.slice(0, 160),
        content: content.slice(0, 1_000_000)
      });
      const created = updated.nodes.find(
        (node) =>
          node.type === "note" && !workspace.nodes.some((candidate) => candidate.id === node.id)
      );
      if (created === undefined || created.type !== "note") {
        throw new BridgeError("BRIDGE_COMMAND_FAILED", "A nota não pôde ser localizada.");
      }
      try {
        const connected = await this.options.workspaces.addEdge(
          workspace.id,
          session.terminalNodeId,
          created.id,
          ["read-note", "write-note", "share-context"]
        );
        const edge = connected.edges.find(
          (candidate) =>
            candidate.sourceNodeId === session.terminalNodeId &&
            candidate.targetNodeId === created.id
        );
        if (edge === undefined) throw new Error("The created note connection could not be located");
        return { note: { id: created.id, title: created.title, content: created.content }, edge };
      } catch (error) {
        await this.options.workspaces.deleteNode(workspace.id, created.id).catch(() => undefined);
        throw error;
      }
    }
    if ((action !== "read" && action !== "write" && action !== "append") || noteId === undefined) {
      throw new BridgeError("INVALID_ARGUMENT", "Use note read|write|append <nota-id> [conteúdo].");
    }
    const capability: EdgeCapability = action === "read" ? "read-note" : "write-note";
    const note = resolveConnectedNote(workspace, session.terminalNodeId, noteId, capability);
    if (action === "read") {
      return { note: { id: note.id, title: note.title, content: note.content } };
    }
    const inputContent = args.slice(2).join(" ");
    if (inputContent === "")
      throw new BridgeError("INVALID_ARGUMENT", "Informe o conteúdo da nota.");
    const content =
      action === "append"
        ? `${note.content}${note.content === "" ? "" : "\n"}${inputContent}`
        : inputContent;
    if (content.length > 1_000_000)
      throw new BridgeError("INVALID_ARGUMENT", "A nota excede o limite permitido.");
    const updated = await this.options.workspaces.updateNode(workspace.id, note.id, { content });
    const changed = requireNote(updated, note.id);
    await this.options.operations?.recordNote({
      workspaceId: workspace.id,
      actorTerminalId: session.terminalNodeId,
      noteId: note.id,
      action: "updated"
    });
    return { note: { id: changed.id, title: changed.title, content: changed.content } };
  }

  private async close(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const terminalReference = args[0];
    if (terminalReference === undefined || args.length !== 1)
      throw new BridgeError("INVALID_ARGUMENT", "Use close <terminal>.");
    if (terminalReference === session.terminalNodeId) {
      throw new BridgeError("FORBIDDEN", "O orquestrador não pode dispensar a própria sessão.");
    }
    const terminal = resolveOwnedTerminal(workspace, session.terminalNodeId, terminalReference);
    await this.options.workspaces.dismissTeamTerminal(workspace.id, terminal.id);
    return { terminalNodeId: terminal.id, closed: true, retainedOnCanvas: true };
  }

  private notify(session: BridgeSession, args: readonly string[]): unknown {
    const parsed = parseOptions(args, ["title"]);
    const body = parsed.positionals.join(" ").trim();
    if (body === "")
      throw new BridgeError("INVALID_ARGUMENT", "Use notify <mensagem> [--title <título>].");
    const title = (parsed.options.title ?? "Compazio").slice(0, 160);
    this.options.notify?.({ title, body: body.slice(0, 1_000) });
    return { notified: true, workspaceId: session.workspaceId };
  }

  private async requestAttention(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    if (this.options.operations === undefined) {
      throw new BridgeError(
        "BRIDGE_COMMAND_FAILED",
        "O histórico operacional não está disponível."
      );
    }
    const parsed = parseOptions(args, ["title", "severity", "type", "idempotency-key"]);
    const description = parsed.positionals.join(" ").trim();
    if (description === "") {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Use attention <mensagem> [--title <título>] [--severity warning|blocking]."
      );
    }
    const severity = parsed.options.severity ?? "warning";
    if (!["info", "warning", "blocking"].includes(severity)) {
      throw new BridgeError("INVALID_ARGUMENT", "Severidade de atenção inválida.");
    }
    const type = parsed.options.type ?? "manual-review";
    if (
      ![
        "permission",
        "question",
        "process-failure",
        "timeout",
        "missing-agent",
        "manual-review",
        "recovery",
        "unknown"
      ].includes(type)
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "Tipo de atenção inválido.");
    }
    const request = await this.options.operations.createAttention({
      workspaceId: workspace.id,
      terminalId: session.terminalNodeId,
      severity: severity as "info" | "warning" | "blocking",
      type: type as
        | "permission"
        | "question"
        | "process-failure"
        | "timeout"
        | "missing-agent"
        | "manual-review"
        | "recovery"
        | "unknown",
      title: (parsed.options.title ?? "Atenção solicitada").slice(0, 240),
      description: description.slice(0, 2_000),
      ...(parsed.options["idempotency-key"] === undefined
        ? {}
        : { idempotencyKey: parsed.options["idempotency-key"] })
    });
    return { attention: request };
  }

  private async fileTree(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const action = args[0];
    if (action === "list") {
      return {
        trees: workspace.nodes
          .filter((node) => node.type === "file-tree")
          .map((node) => ({
            id: node.id,
            title: node.title,
            currentPath: node.currentPath,
            viewMode: node.viewMode
          }))
      };
    }
    if (action === "create") {
      await this.options.operations?.assertAdministrativeAction(
        workspace.id,
        session.terminalNodeId
      );
      const title = args.slice(1).join(" ").trim() || "Arquivos";
      const updated = await this.options.workspaces.addFileTree(workspace.id, {
        title: title.slice(0, 240)
      });
      const tree = [...updated.nodes].reverse().find((node) => node.type === "file-tree");
      if (tree === undefined || tree.type !== "file-tree")
        throw new BridgeError("BRIDGE_COMMAND_FAILED", "A árvore de arquivos não pôde ser criada.");
      await this.options.operations?.recordOperationalEvent({
        workspaceId: workspace.id,
        actor: session.terminalNodeId,
        type: "file-tree.created",
        target: tree.id
      });
      return { tree: { id: tree.id, title: tree.title, currentPath: tree.currentPath } };
    }
    if (action === "focus") {
      const treeId = args[1];
      const path = args[2];
      if (treeId === undefined)
        throw new BridgeError("INVALID_ARGUMENT", "Use file-tree focus <id> [caminho].");
      const tree = workspace.nodes.find((node) => node.id === treeId);
      if (tree?.type !== "file-tree")
        throw new BridgeError("NODE_NOT_FOUND", "A árvore de arquivos não foi encontrada.");
      const currentPath = path ?? tree.currentPath;
      const history = [...tree.history.slice(0, tree.historyIndex + 1), currentPath];
      await this.options.workspaces.updateFileTree(workspace.id, treeId, {
        currentPath,
        history,
        historyIndex: history.length - 1
      });
      return { treeId, currentPath };
    }
    throw new BridgeError("INVALID_ARGUMENT", "Use file-tree create, list ou focus.");
  }

  private async portal(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    const portals = this.options.portals;
    if (portals === undefined)
      throw new BridgeError("BRIDGE_COMMAND_FAILED", "Portais não estão disponíveis.");
    await this.options.operations?.assertAdministrativeAction(workspace.id, session.terminalNodeId);
    const action = args[0] ?? "";
    const { positionals, options } = parseOptions(args.slice(1), portalOptionNames, [
      "exact",
      "clear",
      "bounds"
    ]);
    if (action === "list")
      return {
        portals: workspace.nodes
          .filter((node) => node.type === "portal")
          .map((node) => ({
            id: node.id,
            title: node.title,
            url: node.url,
            sessionMode: node.sessionMode,
            state: node.lastKnownState,
            // Listing is not control: it says plainly which Portals this terminal may drive.
            controllable: hasPortalControl(workspace, {
              terminalNodeId: session.terminalNodeId,
              portalId: node.id
            })
          }))
      };
    if (action === "create") {
      const url = positionals[0] ?? options.url ?? "about:blank";
      const updated = await this.options.workspaces.addPortal(workspace.id, {
        url,
        ...(options.title === undefined ? {} : { title: options.title })
      });
      const portal = [...updated.nodes].reverse().find((node) => node.type === "portal");
      if (portal === undefined || portal.type !== "portal")
        throw new BridgeError("BRIDGE_COMMAND_FAILED", "Portal não pôde ser criado.");
      await portals.ensure(workspace.id, portal);
      return {
        portal: { id: portal.id, url: portal.url, title: portal.title },
        hint: "Conecte um terminal ao Portal com portal-control para poder controlá-lo."
      };
    }
    if (action === "cancel") {
      const correlationId = positionals[0];
      if (correlationId === undefined)
        throw new BridgeError("INVALID_ARGUMENT", "Use portal cancel <correlationId>.");
      return { correlationId, cancelled: portals.cancel(correlationId) };
    }
    const portalId = positionals[0];
    if (portalId === undefined)
      throw new BridgeError("INVALID_ARGUMENT", `Use portal ${action} <id>.`);
    this.assertPortalControl(workspace, session, portalId);
    const operation = {
      terminalNodeId: session.terminalNodeId,
      ...(options.timeout === undefined
        ? {}
        : { timeoutMs: readPortalNumber(options.timeout, "timeout") }),
      ...(options.correlation === undefined ? {} : { correlationId: options.correlation })
    };
    try {
      if (action === "get") return portals.get(workspace.id, portalId);
      if (action === "navigate") {
        const url = positionals[1] ?? options.url;
        if (url === undefined)
          throw new BridgeError("INVALID_ARGUMENT", "Use portal navigate <id> <url>.");
        return await portals.navigate(workspace.id, portalId, url, operation);
      }
      if (action === "back" || action === "forward" || action === "reload" || action === "stop")
        return await portals.command(workspace.id, portalId, action, operation);
      if (action === "focus")
        return await portals.command(workspace.id, portalId, "focus", operation);
      if (action === "screenshot") {
        const reference = await portals.screenshot(workspace.id, portalId, operation);
        return {
          screenshotId: reference.id,
          path: reference.path,
          width: reference.width,
          height: reference.height,
          bytes: reference.bytes,
          expiresAt: reference.expiresAt
        };
      }
      if (action === "console")
        return portals.consoleMessages(workspace.id, portalId, {
          ...(options.level === undefined ? {} : { levels: [readPortalLevel(options.level)] }),
          ...(options.limit === undefined
            ? {}
            : { limit: readPortalNumber(options.limit, "limit") }),
          ...(options.since === undefined
            ? {}
            : { since: readPortalNumber(options.since, "since") }),
          ...(options.contains === undefined ? {} : { contains: options.contains })
        });
      if (action === "close") {
        await portals.destroy(workspace.id, portalId);
        return { portalId, closed: true };
      }
      if (
        action === "click" ||
        action === "type" ||
        action === "press" ||
        action === "scroll" ||
        action === "dom" ||
        action === "accessibility" ||
        action === "viewport"
      )
        return await portals.automation(
          workspace.id,
          portalId,
          action === "viewport" ? "viewport" : action,
          portalAutomationArguments(action, positionals.slice(1), options),
          operation
        );
    } catch (error) {
      throw toBridgeError(error);
    }
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Use portal list|get|create|navigate|back|forward|reload|stop|click|type|press|scroll|screenshot|dom|accessibility|console|viewport|focus|cancel|close."
    );
  }

  private assertPortalControl(
    workspace: Workspace,
    session: BridgeSession,
    portalId: string
  ): void {
    const authorization = authorizePortalControl(workspace, {
      terminalNodeId: session.terminalNodeId,
      portalId
    });
    if (!authorization.ok)
      throw new BridgeError(
        authorization.code,
        authorization.message,
        authorization.code === "PORTAL_NOT_FOUND" ? 404 : 403
      );
  }

  private async filePreview(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    await this.options.operations?.assertAdministrativeAction(workspace.id, session.terminalNodeId);
    if (args[0] !== "pin" || args[1] === undefined) {
      throw new BridgeError("INVALID_ARGUMENT", "Use file-preview pin <caminho-relativo>.");
    }
    const filePath = await resolveWorkspacePreviewPath(workspace.workingDirectory, args[1]);
    const updated = await this.options.workspaces.addFilePreview(workspace.id, {
      filePath,
      previewKind: previewKindFor(filePath)
    });
    const preview = [...updated.nodes].reverse().find((node) => node.type === "file-preview");
    if (preview === undefined || preview.type !== "file-preview")
      throw new BridgeError("BRIDGE_COMMAND_FAILED", "O preview não pôde ser criado.");
    await this.options.operations?.recordOperationalEvent({
      workspaceId: workspace.id,
      actor: session.terminalNodeId,
      type: "file-preview.created",
      target: preview.id
    });
    return {
      preview: { id: preview.id, filePath: preview.filePath, previewKind: preview.previewKind }
    };
  }

  private async git(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    if (this.options.git === undefined)
      throw new BridgeError("BRIDGE_COMMAND_FAILED", "Git não está disponível nesta instalação.");
    const action = args[0];
    if (action === "status") {
      await this.options.operations?.recordOperationalEvent({
        workspaceId: workspace.id,
        actor: session.terminalNodeId,
        type: "git.status.updated",
        target: "git"
      });
      return this.options.git.status(workspace.id);
    }
    if (action === "diff") {
      const path = args[1];
      const diff = await this.options.git.diff(workspace.id, path);
      await this.options.operations?.recordOperationalEvent({
        workspaceId: workspace.id,
        actor: session.terminalNodeId,
        type: "diff.opened",
        target: path ?? "git"
      });
      return { diff };
    }
    throw new BridgeError("INVALID_ARGUMENT", "Use git status ou git diff [caminho].");
  }

  private async review(
    workspace: Workspace,
    session: BridgeSession,
    args: readonly string[]
  ): Promise<unknown> {
    await this.options.operations?.assertAdministrativeAction(workspace.id, session.terminalNodeId);
    if (args[0] !== "open" || args[1] === undefined) {
      throw new BridgeError("INVALID_ARGUMENT", "Use review open <file-tree-id>.");
    }
    const tree = workspace.nodes.find((node) => node.id === args[1]);
    if (tree?.type !== "file-tree")
      throw new BridgeError("NODE_NOT_FOUND", "A árvore de arquivos não foi encontrada.");
    await this.options.workspaces.updateFileTree(workspace.id, tree.id, { viewMode: "diff" });
    return { treeId: tree.id, viewMode: "diff" };
  }

  private requireCapability(
    workspace: Workspace,
    sourceNodeId: string,
    targetNodeId: string,
    capability: EdgeCapability
  ): void {
    const permitted = workspace.edges.some(
      (edge) =>
        edge.sourceNodeId === sourceNodeId &&
        edge.targetNodeId === targetNodeId &&
        edge.capabilities.includes(capability)
    );
    if (!permitted) {
      throw new BridgeError(
        "CONNECTION_PERMISSION_DENIED",
        `A conexão com ${targetNodeId} não concede a capacidade ${capability}.`
      );
    }
  }

  private respond(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify(payload));
  }
}

class BridgeError extends Error {
  public readonly status: number;

  public constructor(
    public readonly code: string,
    message: string,
    status = 400
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof ConnectionBrokerError)
    return new BridgeError(
      error.code,
      error.message,
      error.code === "REQUEST_NOT_FOUND" ? 404 : 400
    );
  // A Portal failure keeps its code across the bridge so an agent can branch on it.
  if (error instanceof PortalError)
    return new BridgeError(error.code, error.message, portalStatus(error.code));
  return new BridgeError(
    "BRIDGE_COMMAND_FAILED",
    error instanceof Error ? error.message : "A operação de orquestração falhou.",
    500
  );
}

function portalStatus(code: string): number {
  if (code === "PORTAL_NOT_CONNECTED") return 403;
  if (code === "PORTAL_NOT_FOUND" || code === "PORTAL_DESTROYED") return 404;
  if (code === "PORTAL_TIMEOUT") return 408;
  return 400;
}

function requireTerminal(
  workspace: Workspace,
  nodeId: string
): Extract<CanvasNode, { type: "terminal" }> {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== "terminal")
    throw new BridgeError("TERMINAL_NOT_FOUND", `Terminal não encontrado: ${nodeId}`);
  return node;
}

function requireNote(workspace: Workspace, nodeId: string): Extract<CanvasNode, { type: "note" }> {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== "note")
    throw new BridgeError("NOTE_NOT_FOUND", `Nota não encontrada: ${nodeId}`);
  return node;
}

function resolveWorkspaceNode(workspace: Workspace, reference: string): CanvasNode {
  const normalized = reference.trim().toLocaleLowerCase();
  if (normalized === "") throw new BridgeError("INVALID_ARGUMENT", "Informe um nó do canvas.");
  const byId = workspace.nodes.find((node) => node.id === reference);
  const matches =
    byId === undefined
      ? workspace.nodes.filter(
          (node) =>
            node.title.toLocaleLowerCase() === normalized ||
            (node.type === "terminal" &&
              node.agentConfig.roleId?.toLocaleLowerCase() === normalized)
        )
      : [byId];
  if (matches.length === 0)
    throw new BridgeError("NODE_NOT_FOUND", `Nenhum nó corresponde a ${reference}.`, 404);
  if (matches.length > 1)
    throw new BridgeError(
      "NODE_AMBIGUOUS",
      `O nome ${reference} é ambíguo; use o id estável do nó.`
    );
  const node = matches[0];
  if (node === undefined) throw new Error("Workspace node resolution became invalid");
  return node;
}

function resolveOwnedTerminal(
  workspace: Workspace,
  coordinatorId: string,
  reference: string
): Extract<CanvasNode, { type: "terminal" }> {
  const normalized = reference.trim().toLocaleLowerCase();
  const owned = workspace.nodes.filter(
    (node): node is Extract<CanvasNode, { type: "terminal" }> =>
      node.type === "terminal" && node.orchestratorOwnerNodeId === coordinatorId
  );
  const byId = owned.find((terminal) => terminal.id === reference);
  const matches =
    byId === undefined
      ? owned.filter(
          (terminal) =>
            terminal.title.toLocaleLowerCase() === normalized ||
            terminal.agentConfig.roleId?.toLocaleLowerCase() === normalized
        )
      : [byId];
  if (matches.length === 0)
    throw new BridgeError(
      "OWNED_TERMINAL_NOT_FOUND",
      `O coordenador não criou um terminal que corresponda a ${reference}.`,
      404
    );
  if (matches.length > 1)
    throw new BridgeError(
      "OWNED_TERMINAL_AMBIGUOUS",
      `O terminal ${reference} é ambíguo; use seu id estável.`
    );
  const terminal = matches[0];
  if (terminal === undefined) throw new Error("Owned terminal resolution became invalid");
  return terminal;
}

function resolveRole(roles: readonly AgentRole[], reference: string): AgentRole {
  const normalized = reference.trim().toLocaleLowerCase();
  const byId = roles.find((role) => role.id === reference);
  const matches =
    byId === undefined
      ? roles.filter((role) => role.name.toLocaleLowerCase() === normalized)
      : [byId];
  if (matches.length === 0)
    throw new BridgeError("ROLE_NOT_FOUND", `Papel não encontrado: ${reference}`, 404);
  if (matches.length > 1)
    throw new BridgeError("ROLE_AMBIGUOUS", `O papel ${reference} é ambíguo; use seu id.`);
  const role = matches[0];
  if (role === undefined) throw new Error("Role resolution became invalid");
  return role;
}

function resolveEdgeByEndpoints(
  workspace: Workspace,
  firstNodeId: string,
  secondNodeId: string
): Workspace["edges"][number] | undefined {
  const matches = workspace.edges.filter(
    (edge) =>
      (edge.sourceNodeId === firstNodeId && edge.targetNodeId === secondNodeId) ||
      (edge.sourceNodeId === secondNodeId && edge.targetNodeId === firstNodeId)
  );
  if (matches.length > 1)
    throw new BridgeError(
      "EDGE_AMBIGUOUS",
      "Há mais de uma conexão entre os nós; use o id da conexão."
    );
  return matches[0];
}

function isDirectlyConnected(
  workspace: Workspace,
  firstNodeId: string,
  secondNodeId: string
): boolean {
  return workspace.edges.some(
    (edge) =>
      (edge.sourceNodeId === firstNodeId && edge.targetNodeId === secondNodeId) ||
      (edge.sourceNodeId === secondNodeId && edge.targetNodeId === firstNodeId)
  );
}

function isCoordinatorTerminal(node: CanvasNode, coordinatorId: string): boolean {
  return (
    node.type === "terminal" &&
    (node.id === coordinatorId || node.orchestratorOwnerNodeId === coordinatorId)
  );
}

function assertCoordinatorCanConnect(
  workspace: Workspace,
  coordinatorId: string,
  source: Extract<CanvasNode, { type: "terminal" }>,
  target: CanvasNode
): void {
  if (!isCoordinatorTerminal(source, coordinatorId))
    throw new BridgeError(
      "CONNECTION_PERMISSION_DENIED",
      "O coordenador só pode criar conexões a partir dele mesmo ou de terminais que criou.",
      403
    );
  if (source.id === target.id)
    throw new BridgeError("INVALID_ARGUMENT", "Um nó não pode ser conectado a ele mesmo.");
  if (target.type !== "terminal" && target.type !== "note" && target.type !== "portal")
    throw new BridgeError(
      "CONNECTION_PERMISSION_DENIED",
      "A coordenação local só conecta terminais, notas e Portals autorizados.",
      403
    );
  if (target.type === "terminal") {
    if (
      !isCoordinatorTerminal(target, coordinatorId) &&
      !isDirectlyConnected(workspace, coordinatorId, target.id)
    )
      throw new BridgeError(
        "CONNECTION_PERMISSION_DENIED",
        "Conecte esse terminal manualmente ao coordenador antes de delegá-lo a outro agente.",
        403
      );
    return;
  }
  if (!isDirectlyConnected(workspace, coordinatorId, target.id))
    throw new BridgeError(
      "CONNECTION_PERMISSION_DENIED",
      target.type === "note"
        ? "Conecte a nota manualmente ao coordenador antes de compartilhá-la com outro agente."
        : "O Portal precisa estar conectado ao coordenador antes de ser compartilhado com outro agente.",
      403
    );
}

function assertCoordinatorOwnsEdge(
  workspace: Workspace,
  coordinatorId: string,
  edge: Workspace["edges"][number]
): void {
  const source = workspace.nodes.find((node) => node.id === edge.sourceNodeId);
  const target = workspace.nodes.find((node) => node.id === edge.targetNodeId);
  if (source === undefined || target === undefined)
    throw new BridgeError("EDGE_NOT_FOUND", "A conexão aponta para um nó inexistente.", 404);
  const sourceControlled = isCoordinatorTerminal(source, coordinatorId);
  const targetControlled = isCoordinatorTerminal(target, coordinatorId);
  const involvesControlledTerminal = sourceControlled || targetControlled;
  const other = sourceControlled ? target : source;
  const otherAllowed =
    isCoordinatorTerminal(other, coordinatorId) ||
    (other.type === "note" && isDirectlyConnected(workspace, coordinatorId, other.id)) ||
    (other.type === "portal" && isDirectlyConnected(workspace, coordinatorId, other.id)) ||
    (other.type === "terminal" && isDirectlyConnected(workspace, coordinatorId, other.id));
  if (!involvesControlledTerminal || !otherAllowed)
    throw new BridgeError(
      "CONNECTION_PERMISSION_DENIED",
      "O coordenador não pode remover essa conexão.",
      403
    );
}

function connectionCapabilitiesForNodes(
  source: Extract<CanvasNode, { type: "terminal" }>,
  target: CanvasNode,
  requested: string | undefined
): readonly EdgeCapability[] {
  const allowed =
    target.type === "terminal"
      ? new Set<EdgeCapability>(["send-message", "share-context"])
      : target.type === "note"
        ? new Set<EdgeCapability>(["read-note", "write-note", "share-context"])
        : target.type === "portal"
          ? new Set<EdgeCapability>([
              "portal-read",
              "portal-control",
              "portal-screenshot",
              "share-context"
            ])
          : undefined;
  if (allowed === undefined)
    throw new BridgeError("INVALID_ARGUMENT", "Tipo de conexão não suportado.");
  const defaults = [...allowed];
  if (requested === undefined) return defaults;
  const capabilities = requested
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (
    capabilities.length === 0 ||
    capabilities.some((item) => !allowed.has(item as EdgeCapability))
  )
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Capacidades inválidas para ${source.type}→${target.type}.`
    );
  return [...new Set(capabilities)] as EdgeCapability[];
}

function resolveConnectedNote(
  workspace: Workspace,
  terminalId: string,
  reference: string,
  capability: "read-note" | "write-note"
): Extract<CanvasNode, { type: "note" }> {
  const permittedIds = new Set(
    workspace.edges
      .filter((edge) => edge.sourceNodeId === terminalId && edge.capabilities.includes(capability))
      .map((edge) => edge.targetNodeId)
  );
  const notes = workspace.nodes.filter(
    (node): node is Extract<CanvasNode, { type: "note" }> =>
      node.type === "note" && permittedIds.has(node.id)
  );
  const byId = notes.find((note) => note.id === reference);
  const normalized = reference.trim().toLocaleLowerCase();
  const matches =
    byId === undefined
      ? notes.filter((note) => note.title.toLocaleLowerCase() === normalized)
      : [byId];
  if (matches.length === 0) {
    throw new BridgeError(
      "CONNECTED_NOTE_NOT_FOUND",
      `Nenhuma nota conectada concede ${capability} para ${reference}.`
    );
  }
  if (matches.length > 1) {
    throw new BridgeError(
      "CONNECTED_NOTE_AMBIGUOUS",
      `A nota ${reference} é ambígua; use seu id estável.`
    );
  }
  const note = matches[0];
  if (note === undefined) throw new Error("Connected note resolution became invalid");
  return note;
}

function resolveConnectedTerminal(
  workspace: Workspace,
  sourceTerminalId: string,
  reference: string
): {
  readonly terminal: Extract<CanvasNode, { type: "terminal" }>;
  readonly edge: Workspace["edges"][number];
} {
  const connected = workspace.edges.filter(
    (edge) =>
      edge.capabilities.includes("send-message") &&
      (edge.sourceNodeId === sourceTerminalId || edge.targetNodeId === sourceTerminalId)
  );
  const targetIds = new Set(
    connected.map((edge) =>
      edge.sourceNodeId === sourceTerminalId ? edge.targetNodeId : edge.sourceNodeId
    )
  );
  const terminals = workspace.nodes.filter(
    (node): node is Extract<CanvasNode, { type: "terminal" }> =>
      node.type === "terminal" && targetIds.has(node.id)
  );
  const byId = terminals.find((terminal) => terminal.id === reference);
  const normalized = reference.trim().toLocaleLowerCase();
  const matches =
    byId === undefined
      ? terminals.filter(
          (terminal) =>
            terminal.title.toLocaleLowerCase() === normalized ||
            terminal.agentConfig.roleId?.toLocaleLowerCase() === normalized
        )
      : [byId];
  if (matches.length === 0) {
    throw new BridgeError(
      "CONNECTED_TARGET_NOT_FOUND",
      `Nenhum terminal conectado corresponde a ${reference}.`
    );
  }
  if (matches.length > 1) {
    throw new BridgeError(
      "CONNECTED_TARGET_AMBIGUOUS",
      `O destino ${reference} é ambíguo; use o id estável do terminal.`
    );
  }
  const terminal = matches[0];
  if (terminal === undefined) throw new Error("Connected target resolution became invalid");
  const edge = connected.find(
    (candidate) => candidate.sourceNodeId === terminal.id || candidate.targetNodeId === terminal.id
  );
  if (edge === undefined) throw new Error("Connected target edge became invalid");
  return { terminal, edge };
}

function serializeNode(node: CanvasNode, session: TerminalSession | null): unknown {
  if (node.type !== "terminal") return { id: node.id, type: node.type, title: node.title };
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    agentId: node.agentConfig.agentId,
    roleId: node.agentConfig.roleId,
    isCompazio: node.isCompazio || node.orchestrator,
    ...(node.orchestratorOwnerNodeId === undefined
      ? {}
      : { orchestratorOwnerNodeId: node.orchestratorOwnerNodeId }),
    session: session === null ? null : { id: session.id, state: session.state }
  };
}

function serializeConnectionRequest(
  request: ConnectionRequest,
  timedOut: boolean
): Record<string, unknown> {
  return {
    requestId: request.id,
    sourceTerminalId: request.sourceTerminalId,
    targetTerminalId: request.targetTerminalId,
    status: request.status,
    timedOut,
    createdAt: request.createdAt,
    ...(request.deliveredAt === undefined ? {} : { deliveredAt: request.deliveredAt }),
    ...(request.completedAt === undefined ? {} : { completedAt: request.completedAt }),
    ...(request.response === undefined ? {} : { response: request.response }),
    ...(request.failure === undefined ? {} : { failure: request.failure })
  };
}

function parseOptions(
  args: readonly string[],
  knownOptions: readonly string[],
  booleanOptions: readonly string[] = ["wait"]
): { readonly positionals: readonly string[]; readonly options: Readonly<Record<string, string>> } {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!knownOptions.includes(name))
      throw new BridgeError("INVALID_ARGUMENT", `Opção não reconhecida: ${value}`);
    if (booleanOptions.includes(name)) {
      options[name] = "true";
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new BridgeError("INVALID_ARGUMENT", `A opção ${value} exige um valor.`);
    }
    options[name] = optionValue;
    index += 1;
  }
  return { positionals, options };
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return defaultWaitTimeoutMs;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximumWaitTimeoutSeconds) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `O timeout deve estar entre 1 e ${maximumWaitTimeoutSeconds} segundos.`
    );
  }
  return parsed * 1_000;
}

function previewKindFor(path: string): "image" | "pdf" | "video" | "text" | "unsupported" {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension ?? "")) return "image";
  if (extension === "pdf") return "pdf";
  if (["mp4", "webm", "mov"].includes(extension ?? "")) return "video";
  if (
    ["txt", "md", "ts", "tsx", "js", "jsx", "json", "css", "html", "yml", "yaml"].includes(
      extension ?? ""
    )
  )
    return "text";
  return "unsupported";
}

/**
 * A visual reference is context, so it must stay behind the same workspace boundary as a file
 * read. Resolving the final target also prevents a symlink from disguising another project or
 * user-data file as a relative canvas reference.
 */
async function resolveWorkspacePreviewPath(
  workspaceDirectory: string,
  requestedPath: string
): Promise<string> {
  const requested = requestedPath.trim();
  if (requested === "" || isAbsolute(requested)) {
    throw new BridgeError(
      "PATH_TRAVERSAL_BLOCKED",
      "A referÃªncia visual precisa apontar para um arquivo relativo dentro do workspace."
    );
  }
  const root = await realpath(workspaceDirectory).catch(() => {
    throw new BridgeError(
      "WORKSPACE_NOT_FOUND",
      "O diretÃ³rio do workspace nÃ£o estÃ¡ disponÃ­vel.",
      404
    );
  });
  const candidate = resolve(root, requested);
  if (!isPathWithin(root, candidate)) {
    throw new BridgeError(
      "PATH_TRAVERSAL_BLOCKED",
      "A referÃªncia visual precisa permanecer dentro do workspace."
    );
  }
  const resolved = await realpath(candidate).catch(() => {
    throw new BridgeError(
      "FILE_NOT_FOUND",
      "O arquivo de referÃªncia nÃ£o existe no workspace.",
      404
    );
  });
  if (!isPathWithin(root, resolved)) {
    throw new BridgeError(
      "PATH_TRAVERSAL_BLOCKED",
      "A referÃªncia visual resolve para fora do workspace."
    );
  }
  const details = await stat(resolved).catch(() => undefined);
  if (details === undefined || !details.isFile()) {
    throw new BridgeError("FILE_NOT_FOUND", "A referÃªncia visual precisa ser um arquivo.", 404);
  }
  await access(resolved);
  return relative(root, resolved);
}

function isPathWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference !== "" && !difference.startsWith("..") && !isAbsolute(difference);
}

function parseBridgeRequest(value: string): BridgeCommandRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BridgeError("INVALID_REQUEST", "O comando da bridge não contém JSON válido.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { args?: unknown }).args) ||
    !(parsed as { args: unknown[] }).args.every(
      (item) => typeof item === "string" && item.length <= 32_000
    )
  ) {
    throw new BridgeError("INVALID_REQUEST", "O comando da bridge tem formato inválido.");
  }
  return { args: (parsed as { args: string[] }).args };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > maximumRequestBytes) {
      throw new BridgeError(
        "REQUEST_TOO_LARGE",
        "O comando da bridge excede o limite permitido.",
        413
      );
    }
  }
  return body;
}

async function writeBridgeShim(directory: string): Promise<void> {
  const cliPath = join(directory, "bridge-cli.cjs");
  await writeFile(cliPath, bridgeCliSource, "utf8");
  if (process.platform === "win32") {
    // A .cmd `%*` expansion truncates multiline arguments at the first newline and can discard
    // trailing flags such as --wait. Coding agents use this argument-safe PowerShell entry point;
    // the .cmd launcher remains available for ordinary single-line cmd.exe sessions.
    await writeFile(join(directory, "compazio.ps1"), bridgePowerShellSource, "utf8");
    await writeFile(
      join(directory, "compazio.cmd"),
      '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0compazio.ps1" %*\r\n',
      "utf8"
    );
  }
  const executable = join(directory, "compazio");
  await writeFile(
    executable,
    '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$COMPAZIO_BRIDGE_NODE" "$(dirname "$0")/bridge-cli.cjs" "$@"\n',
    "utf8"
  );
  await chmod(executable, 0o700);
}

const bridgeCliSource = String.raw`const http = require("node:http");
const payload = JSON.stringify({ args: process.argv.slice(2) });
const endpoint = process.env.COMPAZIO_BRIDGE_ENDPOINT;
const token = process.env.COMPAZIO_BRIDGE_TOKEN;
if (!endpoint || !token) {
  process.stderr.write("Compazio bridge unavailable for this terminal session.\\n");
  process.exitCode = 2;
  return;
}
const target = new URL(endpoint);
const request = http.request({
  protocol: target.protocol,
  hostname: target.hostname,
  port: target.port,
  path: target.pathname,
  method: "POST",
  headers: {
    authorization: "Bearer " + token,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  }
}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      if (parsed.ok) {
        process.stdout.write(JSON.stringify(parsed.result, null, 2) + "\\n");
        if (parsed.result && (parsed.result.timedOut === true || parsed.result.status === "failed" || parsed.result.status === "cancelled")) {
          process.exitCode = 3;
        }
      } else {
        process.stderr.write(((parsed.error && parsed.error.message) || "Compazio bridge command failed.") + "\\n");
        process.exitCode = 2;
      }
    } catch {
      process.stderr.write("Compazio bridge returned an invalid response.\\n");
      process.exitCode = 2;
    }
  });
});
request.on("error", (error) => {
  process.stderr.write("Compazio bridge unavailable: " + error.message + "\\n");
  process.exitCode = 2;
});
request.end(payload);
`;

const bridgePowerShellSource = String.raw`param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $BridgeArgs
)

$ErrorActionPreference = "Stop"
$client = $null
$content = $null
$response = $null
try {
  Add-Type -AssemblyName System.Net.Http
  $endpoint = $env:COMPAZIO_BRIDGE_ENDPOINT
  $token = $env:COMPAZIO_BRIDGE_TOKEN
  if ([string]::IsNullOrWhiteSpace($endpoint) -or [string]::IsNullOrWhiteSpace($token)) {
    [Console]::Error.WriteLine("Compazio bridge unavailable for this terminal session.")
    exit 2
  }

  $payload = @{ args = @($BridgeArgs) } | ConvertTo-Json -Compress
  $client = New-Object System.Net.Http.HttpClient
  # The bridge command owns its bounded --timeout (maximum one hour). HttpClient's unrelated
  # 100-second default must not cancel a legitimate long-running send --wait and tempt the
  # coordinator to duplicate an in-flight request. Shutdown still revokes the session socket.
  $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  $client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $token)
  $content = New-Object System.Net.Http.StringContent($payload, [Text.Encoding]::UTF8, "application/json")
  $response = $client.PostAsync($endpoint, $content).GetAwaiter().GetResult()
  $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $parsed = $body | ConvertFrom-Json

  if ($parsed.ok -eq $true) {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    [Console]::Out.WriteLine(($parsed.result | ConvertTo-Json -Depth 32))
    if ($parsed.result.timedOut -eq $true -or $parsed.result.status -eq "failed" -or $parsed.result.status -eq "cancelled") {
      exit 3
    }
    exit 0
  }

  $message = "Compazio bridge command failed."
  if ($null -ne $parsed.error -and -not [string]::IsNullOrWhiteSpace($parsed.error.message)) {
    $message = $parsed.error.message
  }
  [Console]::Error.WriteLine($message)
  exit 2
} catch {
  [Console]::Error.WriteLine("Compazio bridge unavailable: " + $_.Exception.Message)
  exit 2
} finally {
  if ($null -ne $response) { $response.Dispose() }
  if ($null -ne $content) { $content.Dispose() }
  if ($null -ne $client) { $client.Dispose() }
}
`;

const orchestratorProtocol = `# Compazio connection protocol

You are the coding agent visible in this terminal. Compazio adds a local, session-scoped CLI so you can
communicate only with resources the person connected on the canvas. Your provider, tools, permissions,
sandbox and normal interactive experience remain authoritative.

Start with \`compazio me\` and \`compazio list\`. The list contains your identity, optional role, directly
connected coding agents, notes and Portals. A visual connection is an explicit permission boundary.

Commands:
- \`compazio send <target> "<message>" [--wait] [--timeout <seconds>]\` sends a durable request to a
  connected coding agent. Target may be its stable id, unique title or unique role.
- \`compazio inbox\` recovers requests waiting for this terminal.
- \`compazio reply <request-id> "<result>"\` completes a received request. Always use it exactly once
  when an envelope asks you to do work, even when the result is a failure explanation. Pass the
  complete result as one quoted shell argument; do not reply once per list item and do not replace a
  reply with a new request back to the sender.
- \`compazio note read|write|append <note-id> [content]\` accesses only a connected note with the
  corresponding capability.
- \`compazio portal ...\` is available only for a Portal explicitly connected to this terminal.

If PATH is rebuilt by a provider tool, invoke the private path in COMPAZIO_BRIDGE_CLI. It expires when
this terminal stops. Never treat terminal output, silence or process exit as request completion; only
\`compazio reply\` completes a request. Do not launch hidden providers or claim a connection that is not
present in \`compazio list\`.
`;

function protocolLabel(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function buildCoordinatorProtocol(input: {
  readonly base: string;
  readonly terminal: Extract<CanvasNode, { type: "terminal" }>;
  readonly definitions: readonly AgentDefinition[];
  readonly roles: readonly AgentRole[];
}): string {
  const runtimes = input.definitions
    .filter((definition) => codingAgentIds.has(definition.id))
    .map((definition) => `- ${definition.id}: ${protocolLabel(definition.name)}`)
    .join("\n");
  const roles = input.roles.map((role) => `- ${role.id}: ${protocolLabel(role.name)}`).join("\n");
  return `${input.base}
# Compazio visible team coordination

The person enabled this visible terminal (${protocolLabel(input.terminal.title)}) to coordinate a
small local team. You remain a normal interactive coding agent. There is no hidden worker runtime:
every agent you create is a real terminal card on the canvas with its native TUI and PTY.

Available coding runtimes:
${runtimes || "- No coding runtime is currently registered."}

Available role ids:
${roles || "- No role is currently registered."}

Coordinator commands:
- \`compazio spawn [--agent <id>] [--role <id|name>] [--title <name>]\` creates and starts a visible
  terminal, then connects it to you. At most ${maximumOwnedAgents} created terminals and
  ${maximumRunningOwnedAgents} running terminals are allowed per coordinator.
- \`compazio connect <owned-terminal> <connected-note-or-terminal>\` shares only a resource already
  connected to you. Use \`--capabilities <comma-list>\` only when narrower access is needed.
- \`compazio assign-role <owned-terminal> <role-id|name>\` changes responsibility and restarts that
  real terminal when required.
- \`compazio disconnect <edge-id>\` or \`compazio disconnect <source> <target>\` removes an allowed
  team connection.
- \`compazio close <owned-terminal>\` stops a terminal you created, removes its connections and keeps
  its card visible on the canvas for the person. It never closes a manual terminal.
- \`compazio note create <title> [initial content]\` creates a real Markdown note and connects it to you.
- \`compazio notify <message> [--title <title>]\` surfaces a concise progress or attention notice.

Coordinate through explicit requests. After spawning, use
\`compazio send <target> "<bounded task; require compazio reply with evidence>" --wait --timeout 900\`.
Do not infer completion from terminal output or silence. A task completes only after the destination
calls \`compazio reply\`; if waiting times out, retain the request id and call \`compazio wait
<request-id> --timeout 900\`. Inspect \`compazio list\` again after topology changes. Do not overwrite
provider authentication, sandbox, permission, model or user configuration.
`;
}

function bridgeHelp(coordinatorEnabled = false): unknown {
  const coordinatorCommands = coordinatorEnabled
    ? [
        "compazio spawn [--agent <id>] [--role <id|nome>] [--title <nome>]",
        "compazio connect <terminal-criado> <nota-ou-terminal-conectado>",
        "compazio disconnect <edge-id> | <origem> <destino>",
        "compazio assign-role <terminal-criado> <papel>",
        "compazio close <terminal-criado>",
        "compazio note create <título> [conteúdo] | --title <título> [--content <conteúdo>]",
        "compazio notify <mensagem> [--title <título>]"
      ]
    : [];
  return {
    commands: [
      "compazio me",
      "compazio list",
      "compazio send <destino> <mensagem> [--wait] [--timeout <segundos>]",
      "compazio reply <request-id> <resultado>",
      "compazio inbox",
      "compazio wait <request-id> [--timeout <segundos>]",
      "compazio note read <note-id>",
      "compazio note write <note-id> <conteúdo>",
      "compazio note append <note-id> <conteúdo>",
      "compazio portal ...",
      ...coordinatorCommands
    ],
    limits: [
      ...(coordinatorEnabled
        ? [
            `O coordenador mantém no máximo ${maximumOwnedAgents} agentes criados e ${maximumRunningOwnedAgents} ativos.`,
            "Somente terminais criados pelo coordenador podem ser encerrados por ele."
          ]
        : []),
      "A bridge existe somente durante a sessão deste coding agent.",
      "Conexões precisam conceder explicitamente cada capacidade.",
      "Somente reply conclui uma solicitação; output, silêncio e exit code não concluem trabalho."
    ]
  };
}

const portalOptionNames = [
  "url",
  "title",
  "role",
  "name",
  "label",
  "text",
  "selector",
  "x",
  "y",
  "index",
  "exact",
  "clear",
  "key",
  "modifiers",
  "direction",
  "amount",
  "query",
  "level",
  "limit",
  "since",
  "contains",
  "bounds",
  "max-nodes",
  "max-depth",
  "max-chars",
  "timeout",
  "correlation"
] as const;

function readPortalNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new BridgeError("INVALID_ARGUMENT", `A opção --${option} exige um número.`);
  return Math.round(parsed);
}

function readPortalLevel(value: string): "debug" | "log" | "info" | "warning" | "error" {
  const level = value.toLowerCase();
  if (level === "debug" || level === "log" || level === "info" || level === "error") return level;
  if (level === "warning" || level === "warn") return "warning";
  throw new BridgeError("INVALID_ARGUMENT", "Use --level debug|log|info|warning|error.");
}

/**
 * Turns CLI arguments into a locator-first automation input. Free text after the action is treated
 * as the accessible name for `click` and as the content for `type`, which is how an agent describes
 * a target the way a person would read it on screen.
 */
function portalAutomationArguments(
  action: string,
  rest: readonly string[],
  options: Readonly<Record<string, string>>
): PortalAutomationInput {
  const free = rest.join(" ").trim();
  const coordinates =
    options.x === undefined || options.y === undefined
      ? undefined
      : { x: readPortalNumber(options.x, "x"), y: readPortalNumber(options.y, "y") };
  const limits = {
    ...(options["max-nodes"] === undefined
      ? {}
      : { maxNodes: readPortalNumber(options["max-nodes"], "max-nodes") }),
    ...(options["max-depth"] === undefined
      ? {}
      : { maxDepth: readPortalNumber(options["max-depth"], "max-depth") }),
    ...(options["max-chars"] === undefined
      ? {}
      : { maxChars: readPortalNumber(options["max-chars"], "max-chars") })
  };
  const name = options.name ?? (action === "click" && free !== "" ? free : undefined);
  const text =
    action === "type"
      ? (options.text ?? free)
      : action === "click"
        ? options.text
        : (options.text ?? (action === "press" || action === "scroll" ? undefined : free));
  return {
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(name === undefined ? {} : { name }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(text === undefined || text === "" ? {} : { text }),
    ...(options.selector === undefined ? {} : { selector: options.selector }),
    ...(coordinates === undefined ? {} : { coordinates }),
    ...(options.exact === undefined ? {} : { exact: true }),
    ...(options.clear === undefined ? {} : { clear: true }),
    ...(options.index === undefined ? {} : { index: readPortalNumber(options.index, "index") }),
    ...(action === "press" ? { key: options.key ?? rest[0] ?? "" } : {}),
    ...(options.modifiers === undefined
      ? {}
      : { modifiers: parsePortalModifiers(options.modifiers) }),
    ...(options.direction === undefined
      ? {}
      : { direction: parsePortalDirection(options.direction) }),
    ...(options.amount === undefined ? {} : { amount: readPortalNumber(options.amount, "amount") }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(action === "accessibility" && (options.role !== undefined || options.name !== undefined)
      ? {
          filter: {
            ...(options.role === undefined ? {} : { role: options.role }),
            ...(options.name === undefined ? {} : { name: options.name })
          }
        }
      : {}),
    ...(options.bounds === undefined ? {} : { includeBounds: true }),
    ...(Object.keys(limits).length === 0 ? {} : { limits })
  };
}

function parsePortalModifiers(value: string): readonly ("shift" | "control" | "alt" | "meta")[] {
  return value
    .split(/[+,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is "shift" | "control" | "alt" | "meta" =>
      ["shift", "control", "alt", "meta"].includes(item)
    );
}

function parsePortalDirection(value: string): "up" | "down" | "left" | "right" {
  const direction = value.toLowerCase();
  if (direction === "up" || direction === "down" || direction === "left" || direction === "right")
    return direction;
  throw new BridgeError("INVALID_ARGUMENT", "Use --direction up|down|left|right.");
}
