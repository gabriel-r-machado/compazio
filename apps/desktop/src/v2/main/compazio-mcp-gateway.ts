import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, resolve, sep } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ORCHESTRATOR_LABEL } from "@forgedeck/compazio-v2-domain";
import type { CanvasNode, PortalNode, Workspace } from "@forgedeck/compazio-v2-domain";
import { z } from "zod";

import {
  authorizePortalControl,
  hasPortalCapability,
  type PortalAccessCapability
} from "./portal-authorization";
import { PortalError } from "./portal-operations";
import type { PortalAutomationInput, PortalRuntimeManager } from "./portal-runtime-manager";
import { extractPdfText } from "./pdf-text";
import type { V2WorkspaceService } from "./workspace-service";
import {
  TeamCoordinatorError,
  teamToolsForCapabilities,
  type TeamCoordinator,
  type TeamMcpCapability,
  type TeamMcpToolName
} from "./team-coordinator";

const maximumRequestBytes = 64 * 1024;
const maximumPortalListItems = 50;
const maximumResponseBytes = 64 * 1024;
const maximumConnectedDocumentBytes = 5 * 1_024 * 1_024;
const defaultSessionLifetimeMs = 30 * 60_000;
const mcpBindingCloseGraceMs = 500;

function shutdownTrace(stage: string, metadata: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.COMPAZIO_V2_SHUTDOWN_TRACE !== "1") return;
  console.info(
    `COMPAZIO_SHUTDOWN_TRACE ${JSON.stringify({ stage, at: new Date().toISOString(), ...metadata })}`
  );
}

const portalToolNames = [
  "portal_list",
  "portal_get",
  "portal_dom",
  "portal_accessibility",
  "portal_console",
  "portal_viewport",
  "portal_navigate",
  "portal_back",
  "portal_forward",
  "portal_reload",
  "portal_stop",
  "portal_click",
  "portal_type",
  "portal_press",
  "portal_scroll",
  "portal_focus",
  "portal_screenshot",
  "portal_close"
] as const;

export type PortalMcpToolName = (typeof portalToolNames)[number];
export const contextMcpToolNames = [
  "context_list",
  "context_read",
  "note_create",
  "note_update",
  "note_check",
  "file_tree_create",
  "file_preview_create",
  "portal_create"
] as const;
export type ContextMcpToolName = (typeof contextMcpToolNames)[number];
export type CompazioMcpToolName = PortalMcpToolName | TeamMcpToolName | ContextMcpToolName;
export type CompazioMcpCapability = PortalAccessCapability | TeamMcpCapability;

/** Capability-to-tool mapping shared by automatic adapter bootstrap and the local gateway. */
export function portalToolsForCapabilities(
  capabilities: readonly PortalAccessCapability[]
): readonly PortalMcpToolName[] {
  const allowed = new Set<PortalMcpToolName>();
  if (capabilities.includes("portal-read")) {
    for (const tool of [
      "portal_list",
      "portal_get",
      "portal_dom",
      "portal_accessibility",
      "portal_console",
      "portal_viewport"
    ] as const)
      allowed.add(tool);
  }
  if (capabilities.includes("portal-control")) {
    for (const tool of [
      "portal_navigate",
      "portal_back",
      "portal_forward",
      "portal_reload",
      "portal_stop",
      "portal_click",
      "portal_type",
      "portal_press",
      "portal_scroll",
      "portal_focus"
    ] as const)
      allowed.add(tool);
  }
  if (capabilities.includes("portal-screenshot")) allowed.add("portal_screenshot");
  if (capabilities.includes("portal-close")) allowed.add("portal_close");
  return portalToolNames.filter((tool) => allowed.has(tool));
}

export function compazioToolsForCapabilities(
  capabilities: readonly CompazioMcpCapability[]
): readonly CompazioMcpToolName[] {
  const teamCapabilities = capabilities.filter(isTeamCapability);
  return [
    // Portal grants are rechecked from the current graph at call time. Advertising the stable
    // surface lets a running agent use a Portal that was connected or created after startup.
    ...portalToolNames,
    ...teamToolsForCapabilities(teamCapabilities),
    // These tools authorize against the current graph on every call. Keeping them discoverable is
    // what lets a running agent notice a newly connected note, image or Portal without restarting.
    ...contextMcpToolNames
  ];
}

const boundedText = z.string().trim().min(1).max(4_096);
const boundedId = z.string().trim().min(1).max(256);
const optionalOperationFields = {
  timeoutMs: z.number().int().min(250).max(120_000).optional(),
  correlationId: z.string().uuid().optional()
};
const emptySchema = z.object({}).strict();
const contextNodeSchema = z.object({ nodeId: boundedId }).strict();
const noteCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    content: z.string().max(64_000).optional()
  })
  .strict();
const noteUpdateSchema = z
  .object({
    noteId: boundedId,
    content: z.string().max(64_000),
    mode: z.enum(["replace", "append"]).default("replace")
  })
  .strict();
const noteCheckSchema = z
  .object({ noteId: boundedId, line: z.number().int().min(0).max(10_000), checked: z.boolean() })
  .strict();
const portalCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    url: z.string().trim().min(1).max(4_096).optional(),
    serveWorkspace: z.boolean().optional(),
    port: z.number().int().min(41_800).max(41_899).optional()
  })
  .refine((input) => input.port === undefined || input.serveWorkspace === true, {
    message: "port requires serveWorkspace"
  })
  .strict();
const fileTreeCreateSchema = z
  .object({ title: z.string().trim().min(1).max(240).optional() })
  .strict();
const filePreviewCreateSchema = z
  .object({
    filePath: z.string().trim().min(1).max(4_096),
    title: z.string().trim().min(1).max(240).optional()
  })
  .strict();
const portalSchema = z.object({ portalId: boundedId, ...optionalOperationFields }).strict();
const portalViewportSchema = portalSchema
  .extend({
    width: z.number().int().min(320).max(2_560).optional(),
    height: z.number().int().min(240).max(2_000).optional()
  })
  .strict()
  .refine(
    (input) => (input.width === undefined) === (input.height === undefined),
    "Informe width e height juntos."
  );
const locatorSchema = z
  .object({
    role: boundedText.optional(),
    name: boundedText.optional(),
    label: boundedText.optional(),
    text: boundedText.optional(),
    selector: boundedText.optional(),
    coordinates: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
    exact: z.boolean().optional(),
    index: z.number().int().min(0).max(100).optional()
  })
  .strict()
  .refine(
    (target) =>
      target.role !== undefined ||
      target.name !== undefined ||
      target.label !== undefined ||
      target.text !== undefined ||
      target.selector !== undefined ||
      target.coordinates !== undefined,
    "Informe role/name, label, texto, selector ou coordenadas."
  );
const navigateSchema = portalSchema.extend({ url: z.string().trim().min(1).max(2_048) }).strict();
const clickSchema = portalSchema.extend({ target: locatorSchema }).strict();
const typeSchema = portalSchema
  .extend({ target: locatorSchema, text: boundedText, clear: z.boolean().optional() })
  .strict();
const pressSchema = portalSchema
  .extend({
    key: z.enum([
      "Enter",
      "Escape",
      "Tab",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space"
    ]),
    modifiers: z
      .array(z.enum(["shift", "control", "alt", "meta"]))
      .max(4)
      .optional()
  })
  .strict();
const scrollSchema = portalSchema
  .extend({
    target: locatorSchema.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().finite().min(1).max(10_000).optional()
  })
  .strict();
const readLimits = {
  query: boundedText.optional(),
  maxNodes: z.number().int().min(1).max(1_500).optional(),
  maxDepth: z.number().int().min(1).max(24).optional(),
  maxChars: z.number().int().min(128).max(64_000).optional(),
  includeBounds: z.boolean().optional()
};
const domSchema = portalSchema.extend(readLimits).strict();
const accessibilitySchema = portalSchema
  .extend({ ...readLimits, role: boundedText.optional(), name: boundedText.optional() })
  .strict();
const consoleSchema = portalSchema
  .extend({
    levels: z
      .array(z.enum(["debug", "log", "info", "warning", "error"]))
      .max(5)
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
    since: z.number().int().nonnegative().optional(),
    contains: boundedText.optional()
  })
  .strict();

// Team schemas intentionally never accept a workspace id, terminal id, capability or token. Those
// values are bound to the authenticated Compazio session, not supplied by a model.
const teamIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const teamEmptySchema = z.object({}).strict();
const teamRecruitSchema = z
  .object({
    agentType: z.enum(["claude-code", "codex", "opencode"]),
    displayName: z.string().trim().min(1).max(240).optional(),
    grantRecruitLimited: z.boolean().optional(),
    role: z
      .object({
        name: boundedText,
        description: z.string().trim().min(1).max(1_000).optional(),
        responsibilities: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32)
      })
      .strict(),
    initialTask: z
      .object({
        title: boundedText,
        description: z.string().trim().min(1).max(16_000),
        contextRefs: z.array(z.string().trim().min(1).max(1_024)).max(100).optional()
      })
      .strict()
      .optional(),
    positionHint: z
      .object({
        relativeTo: teamIdSchema.optional(),
        direction: z.enum(["left", "right", "above", "below"]).optional()
      })
      .strict()
      .optional()
  })
  .strict();
const teamMemberSchema = z
  .object({ teamMemberId: teamIdSchema, reason: z.string().trim().min(1).max(1_000).optional() })
  .strict();
const taskCreateSchema = z
  .object({
    title: boundedText,
    description: z.string().trim().min(1).max(16_000),
    contextRefs: z.array(z.string().trim().min(1).max(1_024)).max(100).optional(),
    dependsOn: z.array(teamIdSchema).max(3).optional(),
    reviewOf: teamIdSchema.optional(),
    priority: z.enum(["low", "normal", "high"]).optional()
  })
  .strict();
const taskAssignSchema = z
  .object({
    taskId: teamIdSchema,
    teamMemberId: teamIdSchema
  })
  .strict();
const taskIdSchema = z.object({ taskId: teamIdSchema }).strict();
const taskResultSchema = z
  .object({
    taskId: teamIdSchema,
    result: z
      .object({
        summary: z.string().trim().min(1).max(4_000),
        artifacts: z.array(z.string().trim().min(1).max(1_024)).max(100).optional()
      })
      .strict()
      .optional()
  })
  .strict();
const taskRequestUserInputSchema = z
  .object({
    taskId: teamIdSchema,
    question: z.string().trim().min(1).max(2_000),
    reason: z.string().trim().min(1).max(2_000),
    expectedAnswerType: z.enum(["text", "url", "number", "choice"]),
    context: z.string().trim().min(1).max(4_000).optional()
  })
  .strict();
const teamUserInputAnswerSchema = z
  .object({ requestId: teamIdSchema, answer: z.string().trim().min(1).max(16_000) })
  .strict();
const messageSendSchema = z
  .object({
    toTerminalId: teamIdSchema,
    content: z.string().trim().min(1).max(16_000),
    type: z.enum(["task", "progress", "result", "error", "system"]),
    taskId: teamIdSchema.optional()
  })
  .strict();
const teamRunCreateSchema = z
  .object({
    title: boundedText,
    objective: z.string().trim().min(1).max(16_000),
    members: z
      .array(
        z
          .object({
            agentType: z.enum(["claude-code", "codex", "opencode"]),
            displayName: z.string().trim().min(1).max(240),
            role: z
              .object({
                name: boundedText,
                description: z.string().trim().min(1).max(1_000).optional(),
                responsibilities: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32)
              })
              .strict(),
            grantRecruitLimited: z.boolean().optional()
          })
          .strict()
      )
      .min(1)
      .max(3),
    tasks: z
      .array(
        z
          .object({
            key: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9_-]+$/),
            title: boundedText,
            description: z.string().trim().min(1).max(16_000),
            assignedMemberName: z.string().trim().min(1).max(240),
            contextRefs: z.array(teamIdSchema).max(32).optional(),
            dependsOn: z.array(z.string().trim().min(1).max(128)).max(3).optional(),
            reviewOf: z.string().trim().min(1).max(128).optional()
          })
          .strict()
      )
      .min(1)
      .max(10),
    acceptance: z
      .object({
        requirePortal: z.boolean().optional(),
        requireQa: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict();
const teamRunIdSchema = z.object({ runId: teamIdSchema }).strict();
const teamRunInstructSchema = teamRunIdSchema
  .extend({
    affectedMemberName: z.string().trim().min(1).max(240),
    instruction: z.string().trim().min(1).max(16_000),
    contextRefs: z.array(teamIdSchema).max(32).optional()
  })
  .strict();
const teamRunCancelSchema = teamRunIdSchema
  .extend({ dismissMembers: z.boolean().optional() })
  .strict();
const taskListSchema = z.object({ runId: teamIdSchema.optional() }).strict();
const messageIdSchema = z.object({ messageId: teamIdSchema }).strict();
const teamConnectSchema = z
  .object({
    sourceTerminalId: teamIdSchema,
    targetTerminalId: teamIdSchema,
    capabilities: z
      .array(
        z.enum([
          "send-message",
          "share-context",
          "task-delegate",
          "result-return",
          "review-request"
        ])
      )
      .min(1)
      .max(5)
  })
  .strict();
const teamDisconnectSchema = z.object({ edgeId: teamIdSchema }).strict();

export interface CompazioMcpSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly tokenHash: string;
  readonly capabilities: readonly CompazioMcpCapability[];
  readonly createdAt: string;
  readonly expiresAt: string;
  revokedAt?: string;
}

export interface CompazioMcpBootstrap {
  readonly endpoint: string;
  /** Kept only by the trusted caller that launches an agent. Never persist or send to a renderer. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly tools: readonly CompazioMcpToolName[];
}

export interface CompazioMcpToolCall {
  readonly tool: CompazioMcpToolName;
  readonly transportSessionId?: string;
  readonly compazioSessionId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly correlationId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly durationMs: number;
}

/** Sanitized transport telemetry for real-client validation. It never contains credentials. */
export interface CompazioMcpHttpRequest {
  readonly method: string;
  /** Sanitized JSON-RPC method. It is limited to the MCP lifecycle methods used by this gateway. */
  readonly rpcMethod?: "initialize" | "notifications/initialized" | "tools/list" | "tools/call";
  readonly transportSessionId?: string;
  readonly compazioSessionId?: string;
  /** Protocol version claimed only by the initialize request; this is safe diagnostic metadata. */
  readonly protocolVersion?: string;
  /** The exact capability-scoped list returned for an accepted tools/list request. */
  readonly advertisedTools?: readonly CompazioMcpToolName[];
  readonly outcome: "accepted" | "forbidden" | "unauthorized" | "unknown-session" | "rejected";
}

interface TransportBinding {
  readonly compazioSessionId: string;
  readonly tokenHash: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

interface ManagedStaticServer {
  readonly server: Server;
  readonly sockets: Set<Socket>;
  readonly rootDirectory: string;
  readonly url: string;
}

/**
 * The local MCP boundary only owns protocol, authentication and lifecycle. Portal permission and
 * execution stay in their existing application services; this prevents CLI and MCP from drifting.
 */
export class CompazioMcpGateway {
  private readonly sessions = new Map<string, CompazioMcpSession>();
  private readonly tokenToSessionId = new Map<string, string>();
  private readonly transports = new Map<string, TransportBinding>();
  private readonly toolCallListeners = new Set<(call: CompazioMcpToolCall) => void>();
  private readonly httpRequestListeners = new Set<(request: CompazioMcpHttpRequest) => void>();
  /** Loopback sockets owned by this gateway cannot keep reload/recovery waiting indefinitely. */
  private readonly httpSockets = new Set<Socket>();
  /** Static preview servers are process-owned and always die with this gateway. */
  private readonly staticServers = new Map<string, ManagedStaticServer>();
  private http: Server | null = null;
  private endpoint: string | null = null;

  public constructor(
    private readonly workspaces: V2WorkspaceService,
    // Retained as a trusted main-process dependency for the follow-up tool groups. portal_list is
    // intentionally read-only and derives its source of truth from the persisted workspace.
    private readonly portals: PortalRuntimeManager,
    private readonly teams?: TeamCoordinator
  ) {}

  public async start(): Promise<void> {
    if (this.http !== null) return;
    const server = createServer((request, response) => void this.handle(request, response));
    server.on("connection", (socket) => {
      this.httpSockets.add(socket);
      socket.once("close", () => this.httpSockets.delete(socket));
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
      throw new Error("O gateway MCP local não recebeu uma porta TCP.");
    }
    this.http = server;
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
  }

  /**
   * Recreates the process-owned static server for the last workspace after an application restart.
   * Ports 41800-41899 are reserved by portal_create(serveWorkspace), so this does not claim an
   * arbitrary localhost Portal. If the persisted port is busy, the Portal is atomically moved to
   * another port in the same reserved range before the renderer restores it.
   */
  public async restoreManagedWorkspaceServer(): Promise<void> {
    const listing = await this.workspaces.list();
    if (listing.lastOpenedWorkspaceId === null) return;
    const workspace = await this.workspaces.snapshot(listing.lastOpenedWorkspaceId);
    const managedPortals = workspace.nodes
      .filter(
        (node): node is Extract<Workspace["nodes"][number], { type: "portal" }> =>
          node.type === "portal"
      )
      .map((portal) => ({ portal, port: managedWorkspaceServerPort(portal.url) }))
      .filter(
        (entry): entry is { readonly portal: typeof entry.portal; readonly port: number } =>
          entry.port !== undefined
      );
    if (managedPortals.length === 0) return;
    const managed = await this.ensureWorkspaceStaticServer(workspace, managedPortals[0]?.port);
    for (const { portal } of managedPortals) {
      if (portal.url !== managed.url)
        await this.workspaces.updatePortal(workspace.id, portal.id, { url: managed.url });
    }
  }

  public createAgentSession(input: {
    readonly workspaceId: string;
    readonly terminalId: string;
    readonly capabilities: readonly CompazioMcpCapability[];
    readonly lifetimeMs?: number;
  }): CompazioMcpBootstrap {
    if (this.endpoint === null) throw new Error("O gateway MCP não foi iniciado.");
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() +
        Math.min(
          Math.max(input.lifetimeMs ?? defaultSessionLifetimeMs, 1_000),
          defaultSessionLifetimeMs
        )
    );
    const session: CompazioMcpSession = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      terminalId: input.terminalId,
      tokenHash: hash(token),
      capabilities: [...new Set(input.capabilities)],
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    this.sessions.set(session.id, session);
    this.tokenToSessionId.set(token, session.id);
    return {
      endpoint: this.endpoint,
      token,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      tools: compazioToolsForCapabilities(session.capabilities)
    };
  }

  public async revokeAgentSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.revokedAt !== undefined) return;
    session.revokedAt = new Date().toISOString();
    await this.closeTransportsFor(session.id);
  }

  public async revokeSessionsForTerminal(terminalId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.terminalId === terminalId)
        .map((session) => this.revokeAgentSession(session.id))
    );
  }

  public async revokeSessionsForWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => this.revokeAgentSession(session.id))
    );
  }

  public diagnostics(): {
    readonly listening: boolean;
    readonly activeSessionCount: number;
    readonly transportCount: number;
  } {
    this.pruneExpiredSessions();
    return {
      listening: this.http !== null,
      activeSessionCount: [...this.sessions.values()].filter(
        (session) => !isRevokedOrExpired(session)
      ).length,
      transportCount: this.transports.size
    };
  }

  /** Trusted, sanitized audit stream for the real-client harness. */
  public subscribeToolCalls(listener: (call: CompazioMcpToolCall) => void): () => void {
    this.toolCallListeners.add(listener);
    return () => this.toolCallListeners.delete(listener);
  }

  public subscribeHttpRequests(listener: (request: CompazioMcpHttpRequest) => void): () => void {
    this.httpRequestListeners.add(listener);
    return () => this.httpRequestListeners.delete(listener);
  }

  public async shutdown(): Promise<void> {
    shutdownTrace("mcp-gateway-shutdown-start", { socketCount: this.httpSockets.size });
    for (const managed of this.staticServers.values())
      for (const socket of managed.sockets) socket.destroy();
    await Promise.all(
      [...this.staticServers.values()].map(
        (managed) => new Promise<void>((resolve) => managed.server.close(() => resolve()))
      )
    );
    this.staticServers.clear();
    for (const socket of this.httpSockets) socket.destroy();
    this.httpSockets.clear();
    await Promise.all([...this.transports.values()].map((binding) => this.closeBinding(binding)));
    this.transports.clear();
    shutdownTrace("mcp-transports-closed");
    this.sessions.clear();
    this.tokenToSessionId.clear();
    const server = this.http;
    this.http = null;
    this.endpoint = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    shutdownTrace("mcp-server-closed");
  }

  private async ensureWorkspaceStaticServer(
    workspace: Workspace,
    preferredPort?: number
  ): Promise<ManagedStaticServer> {
    const rootDirectory = await realpath(workspace.workingDirectory);
    const existing = this.staticServers.get(workspace.id);
    if (existing !== undefined) {
      if (existing.rootDirectory !== rootDirectory)
        throw new PortalError(
          "PORTAL_OPERATION_FAILED",
          "O servidor gerenciado já pertence a outra pasta deste workspace."
        );
      return existing;
    }
    const ports = [
      ...(preferredPort === undefined ? [] : [preferredPort]),
      ...Array.from({ length: 100 }, (_, index) => 41_800 + index).filter(
        (port) => port !== preferredPort
      )
    ];
    for (const port of ports) {
      const sockets = new Set<Socket>();
      const server = createServer((request, response) => {
        void serveManagedStaticFile(rootDirectory, request, response);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (error: Error): void => rejectListen(error);
          server.once("error", onError);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", onError);
            resolveListen();
          });
        });
        const managed = {
          server,
          sockets,
          rootDirectory,
          url: `http://localhost:${port}/`
        } satisfies ManagedStaticServer;
        this.staticServers.set(workspace.id, managed);
        return managed;
      } catch (error) {
        for (const socket of sockets) socket.destroy();
        server.close();
        if (!isAddressInUse(error)) throw error;
      }
    }
    throw new PortalError(
      "PORTAL_OPERATION_FAILED",
      "Nenhuma porta livre está disponível entre 41800 e 41899."
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (
        request.url !== "/mcp" ||
        !this.isExpectedHost(request) ||
        !this.isExpectedOrigin(request)
      ) {
        this.recordHttpRequest({ method: request.method ?? "UNKNOWN", outcome: "forbidden" });
        response.writeHead(403);
        response.end();
        return;
      }
      const authenticated = this.authenticate(request);
      if (authenticated === undefined) {
        this.recordHttpRequest({ method: request.method ?? "UNKNOWN", outcome: "unauthorized" });
        response.writeHead(401);
        response.end();
        return;
      }
      const mcpSessionId = headerValue(request, "mcp-session-id");
      let binding: TransportBinding;
      if (mcpSessionId !== undefined) {
        const existing = this.transports.get(mcpSessionId);
        if (existing === undefined) {
          this.recordHttpRequest({
            method: request.method ?? "UNKNOWN",
            transportSessionId: mcpSessionId,
            compazioSessionId: authenticated.id,
            outcome: "unknown-session"
          });
          response.writeHead(404);
          response.end();
          return;
        }
        if (
          existing.compazioSessionId !== authenticated.id ||
          existing.tokenHash !== authenticated.tokenHash
        ) {
          this.recordHttpRequest({
            method: request.method ?? "UNKNOWN",
            transportSessionId: mcpSessionId,
            compazioSessionId: authenticated.id,
            outcome: "forbidden"
          });
          response.writeHead(403);
          response.end();
          return;
        }
        binding = existing;
      } else {
        if (request.method !== "POST") {
          this.recordHttpRequest({
            method: request.method ?? "UNKNOWN",
            compazioSessionId: authenticated.id,
            outcome: "rejected"
          });
          response.writeHead(400);
          response.end();
          return;
        }
        binding = await this.createTransport(authenticated);
      }
      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      await binding.transport.handleRequest(request, response, body);
      const protocolVersion = initializeProtocolVersion(body);
      const rpcMethod = safeMcpRequestMethod(body);
      this.recordHttpRequest({
        method: request.method ?? "UNKNOWN",
        ...(mcpSessionId === undefined ? {} : { transportSessionId: mcpSessionId }),
        compazioSessionId: authenticated.id,
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(rpcMethod === undefined ? {} : { rpcMethod }),
        ...(rpcMethod === "tools/list"
          ? { advertisedTools: compazioToolsForCapabilities(authenticated.capabilities) }
          : {}),
        outcome: "accepted"
      });
      const createdSessionId = binding.transport.sessionId;
      if (createdSessionId !== undefined) this.transports.set(createdSessionId, binding);
    } catch {
      // Protocol errors are deliberately compact. The gateway never reflects credentials or stacks.
      this.recordHttpRequest({ method: request.method ?? "UNKNOWN", outcome: "rejected" });
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  }

  private authenticate(request: IncomingMessage): CompazioMcpSession | undefined {
    this.pruneExpiredSessions();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    if (token === undefined) return undefined;
    const sessionId = this.tokenToSessionId.get(token);
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (session === undefined || session.tokenHash !== hash(token) || isRevokedOrExpired(session))
      return undefined;
    return session;
  }

  private async createTransport(session: CompazioMcpSession): Promise<TransportBinding> {
    const server = new McpServer({ name: "compazio", version: "2" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    this.registerPortalTools(server, session.id, transport);
    this.registerContextTools(server, session.id, transport);
    if (this.teams !== undefined) this.registerTeamTools(server, session.id, transport);
    const binding: TransportBinding = {
      compazioSessionId: session.id,
      tokenHash: session.tokenHash,
      server,
      transport
    };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) this.transports.delete(id);
    };
    // SDK 1.30 declares optional transport callbacks differently under exactOptionalPropertyTypes.
    // The runtime object is the official transport; this bridges only that declaration mismatch.
    await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
    return binding;
  }

  private registerPortalTools(
    server: McpServer,
    sessionId: string,
    transport: StreamableHTTPServerTransport
  ): void {
    const invoke = <T>(
      tool: CompazioMcpToolName,
      operation: (context: {
        readonly session: CompazioMcpSession;
        readonly correlationId: string;
      }) => Promise<T>
    ): Promise<CallToolResult> => this.invokeTool(sessionId, transport.sessionId, tool, operation);

    server.registerTool(
      "portal_list",
      {
        description: "Lista somente os Portais que este terminal pode ler.",
        inputSchema: emptySchema
      },
      async () =>
        invoke("portal_list", async ({ session }) => {
          const workspace = await this.requireWorkspaceTerminal(session);
          const portals = workspace.nodes
            .filter((node) => node.type === "portal")
            .filter((node) =>
              hasEffectivePortalCapability(workspace, session.terminalId, node.id, "portal-read")
            )
            .slice(0, maximumPortalListItems)
            .map((node) => sanitizePortalNode(node));
          if (portals.length === 0)
            throw new PortalError(
              "PORTAL_NOT_CONNECTED",
              "O terminal não está conectado a um Portal legível."
            );
          return { portals };
        })
    );
    server.registerTool(
      "portal_get",
      { description: "Lê o estado seguro de um Portal conectado.", inputSchema: portalSchema },
      async (input) =>
        invoke("portal_get", async ({ session }) =>
          sanitizePortalSnapshot(await this.withPortal(session, input.portalId, "portal-read"))
        )
    );
    server.registerTool(
      "portal_dom",
      { description: "Lê uma representação limitada e sanitizada do DOM.", inputSchema: domSchema },
      async (input) =>
        invoke("portal_dom", async ({ session, correlationId }) => {
          await this.withPortal(session, input.portalId, "portal-read");
          return this.portals.automation(
            session.workspaceId,
            input.portalId,
            "dom",
            portalReadInput(input),
            operationOptions(input, session, correlationId)
          );
        })
    );
    server.registerTool(
      "portal_accessibility",
      {
        description: "Lê a árvore de acessibilidade limitada do Portal.",
        inputSchema: accessibilitySchema
      },
      async (input) =>
        invoke("portal_accessibility", async ({ session, correlationId }) => {
          await this.withPortal(session, input.portalId, "portal-read");
          return this.portals.automation(
            session.workspaceId,
            input.portalId,
            "accessibility",
            portalReadInput(input),
            operationOptions(input, session, correlationId)
          );
        })
    );
    server.registerTool(
      "portal_console",
      {
        description: "Lê mensagens recentes e sanitizadas do console.",
        inputSchema: consoleSchema
      },
      async (input) =>
        invoke("portal_console", async ({ session }) => {
          await this.withPortal(session, input.portalId, "portal-read");
          return this.portals.consoleMessages(session.workspaceId, input.portalId, {
            ...(input.levels === undefined ? {} : { levels: input.levels }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.since === undefined ? {} : { since: input.since }),
            ...(input.contains === undefined ? {} : { contains: input.contains })
          });
        })
    );
    server.registerTool(
      "portal_viewport",
      {
        description:
          "Lê ou define, com width e height, as dimensões controladas do viewport do Portal.",
        inputSchema: portalViewportSchema
      },
      async (input) =>
        invoke("portal_viewport", async ({ session, correlationId }) => {
          await this.withPortal(
            session,
            input.portalId,
            input.width === undefined ? "portal-read" : "portal-control"
          );
          if (input.width !== undefined && input.height !== undefined)
            return this.portals.setViewport(
              session.workspaceId,
              input.portalId,
              { width: input.width, height: input.height },
              operationOptions(input, session, correlationId)
            );
          return this.portals.automation(
            session.workspaceId,
            input.portalId,
            "viewport",
            {},
            operationOptions(input, session, correlationId)
          );
        })
    );

    server.registerTool(
      "portal_navigate",
      {
        description: "Navega o Portal conectado para uma URL permitida.",
        inputSchema: navigateSchema
      },
      async (input) =>
        invoke("portal_navigate", async ({ session, correlationId }) => {
          await this.withPortal(session, input.portalId, "portal-control");
          return sanitizePortalSnapshot(
            await this.portals.navigate(
              session.workspaceId,
              input.portalId,
              input.url,
              operationOptions(input, session, correlationId)
            )
          );
        })
    );
    for (const action of ["back", "forward", "reload", "stop", "focus"] as const) {
      server.registerTool(
        `portal_${action}`,
        { description: `Executa ${action} no Portal conectado.`, inputSchema: portalSchema },
        async (input) =>
          invoke(`portal_${action}` as CompazioMcpToolName, async ({ session, correlationId }) => {
            await this.withPortal(session, input.portalId, "portal-control");
            return sanitizePortalSnapshot(
              await this.portals.command(
                session.workspaceId,
                input.portalId,
                action,
                operationOptions(input, session, correlationId)
              )
            );
          })
      );
    }
    server.registerTool(
      "portal_click",
      { description: "Clica em um alvo localizável do Portal.", inputSchema: clickSchema },
      async (input) =>
        this.automationTool(
          invoke,
          "portal_click",
          input,
          "click",
          compactAutomationInput(input.target)
        )
    );
    server.registerTool(
      "portal_type",
      { description: "Digita texto em um campo editável do Portal.", inputSchema: typeSchema },
      async (input) =>
        this.automationTool(invoke, "portal_type", input, "type", {
          ...compactAutomationInput(input.target),
          text: input.text,
          ...(input.clear === undefined ? {} : { clear: input.clear })
        })
    );
    server.registerTool(
      "portal_press",
      { description: "Pressiona uma tecla permitida no Portal.", inputSchema: pressSchema },
      async (input) =>
        this.automationTool(invoke, "portal_press", input, "press", {
          key: input.key,
          ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers })
        })
    );
    server.registerTool(
      "portal_scroll",
      { description: "Rola o viewport ou um elemento do Portal.", inputSchema: scrollSchema },
      async (input) =>
        this.automationTool(invoke, "portal_scroll", input, "scroll", {
          ...(input.target === undefined ? {} : compactAutomationInput(input.target)),
          direction: input.direction,
          ...(input.amount === undefined ? {} : { amount: input.amount })
        })
    );
    server.registerTool(
      "portal_screenshot",
      {
        description: "Captura uma imagem temporária e gerenciada do viewport.",
        inputSchema: portalSchema
      },
      async (input) =>
        invoke("portal_screenshot", async ({ session, correlationId }) => {
          await this.withPortal(session, input.portalId, "portal-screenshot");
          const screenshot = await this.portals.screenshot(
            session.workspaceId,
            input.portalId,
            operationOptions(input, session, correlationId)
          );
          return {
            screenshotId: screenshot.id,
            mimeType: "image/png",
            width: screenshot.width,
            height: screenshot.height,
            bytes: screenshot.bytes,
            expiresAt: screenshot.expiresAt
          };
        })
    );
    server.registerTool(
      "portal_close",
      {
        description: "Fecha um Portal quando a conexão concede portal-close.",
        inputSchema: portalSchema
      },
      async (input) =>
        invoke("portal_close", async ({ session }) => {
          await this.withPortal(session, input.portalId, "portal-close");
          await this.portals.destroy(session.workspaceId, input.portalId);
          return { portalId: input.portalId, closed: true };
        })
    );
  }

  /** Context tools stay registered and re-read the graph for every call, so new links are live. */
  private registerContextTools(
    server: McpServer,
    sessionId: string,
    transport: StreamableHTTPServerTransport
  ): void {
    const invoke = <T>(
      tool: ContextMcpToolName,
      operation: (context: { readonly session: CompazioMcpSession }) => Promise<T>
    ): Promise<CallToolResult> =>
      this.invokeTool(sessionId, transport.sessionId, tool, ({ session }) =>
        operation({ session })
      );
    const register = <T extends z.ZodType>(
      name: ContextMcpToolName,
      description: string,
      schema: T,
      handler: (input: z.infer<T>, session: CompazioMcpSession) => Promise<unknown>
    ): void => {
      const registerTool = server.registerTool.bind(server) as unknown as (
        toolName: string,
        config: { readonly description: string; readonly inputSchema: z.ZodType },
        callback: (input: unknown) => Promise<CallToolResult>
      ) => void;
      registerTool(name, { description, inputSchema: schema }, async (input) =>
        invoke(name, ({ session }) => handler(input as z.infer<T>, session))
      );
    };

    register(
      "context_list",
      "Lista notas, arquivos, imagens e Portais atualmente conectados a este agente.",
      emptySchema,
      async (_, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        return {
          workspace: {
            id: workspace.id,
            name: workspace.name,
            directory: workspace.workingDirectory
          },
          contexts: connectedContextNodes(workspace, session.terminalId).map((node) =>
            contextNodeSummary(workspace, node)
          )
        };
      }
    );
    register(
      "context_read",
      "Lê uma nota ou descreve com caminho absoluto um arquivo/imagem conectado.",
      contextNodeSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        const node = requireConnectedContext(workspace, session.terminalId, input.nodeId);
        const detail = contextNodeDetail(workspace, node);
        if (node.type !== "file-preview" || !["image", "pdf"].includes(node.previewKind))
          return detail;
        const file = await readConnectedDocument(workspace, node.filePath);
        if (node.previewKind === "pdf") {
          return {
            ...detail,
            pdf: await extractPdfText(file.bytes)
          };
        }
        const mimeType = contextImageMime(file.path);
        if (mimeType === undefined) return detail;
        return richToolData(detail, [
          { type: "image", data: file.bytes.toString("base64"), mimeType }
        ]);
      }
    );
    register(
      "note_create",
      `Cria uma Nota conectada no canvas; disponÃ­vel somente ao ${ORCHESTRATOR_LABEL} autenticado.`,
      noteCreateSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        requireCompazioTerminal(workspace, session.terminalId);
        const updated = await this.workspaces.addNote(workspace.id, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.content === undefined ? {} : { content: input.content })
        });
        const note = [...updated.nodes].reverse().find((node) => node.type === "note");
        if (note === undefined) return { note: null };
        await this.workspaces.addEdge(workspace.id, session.terminalId, note.id, [
          "share-context",
          "read-note",
          "write-note"
        ]);
        return { note: { id: note.id, title: note.title }, connected: true };
      }
    );
    register(
      "note_update",
      "Substitui ou acrescenta conteúdo a uma nota conectada com permissão de escrita.",
      noteUpdateSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        const note = requireWritableNote(workspace, session.terminalId, input.noteId);
        const updated =
          input.mode === "append"
            ? await this.workspaces.appendToNote(workspace.id, note.id, input.content)
            : await this.workspaces.updateNode(workspace.id, note.id, { content: input.content });
        const changed = updated.nodes.find((node) => node.id === note.id && node.type === "note");
        return { note: changed };
      }
    );
    register(
      "note_check",
      "Marca ou desmarca uma linha de checklist de uma nota conectada.",
      noteCheckSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        const note = requireWritableNote(workspace, session.terminalId, input.noteId);
        const lines = note.content.split(/\r?\n/);
        const current = lines[input.line];
        if (current === undefined || !/^\s*- \[[ xX]\]/.test(current))
          throw new PortalError(
            "PORTAL_NOT_CONNECTED",
            "A linha indicada não é um item de checklist."
          );
        lines[input.line] = current.replace(
          /^([\s]*- \[)[ xX](\])/,
          `$1${input.checked ? "x" : " "}$2`
        );
        const updated = await this.workspaces.setNoteChecklistItem(
          workspace.id,
          note.id,
          input.line,
          input.checked
        );
        return {
          noteId: note.id,
          line: input.line,
          checked: input.checked,
          updatedAt: updated.updatedAt
        };
      }
    );
    register(
      "file_tree_create",
      `Cria os Arquivos do projeto no canvas; disponÃ­vel somente ao ${ORCHESTRATOR_LABEL} autenticado.`,
      fileTreeCreateSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        requireCompazioTerminal(workspace, session.terminalId);
        const updated = await this.workspaces.addFileTree(workspace.id, {
          ...(input.title === undefined ? {} : { title: input.title }),
          rootPath: ".",
          currentPath: "."
        });
        const tree = [...updated.nodes].reverse().find((node) => node.type === "file-tree");
        if (tree === undefined) return { fileTree: null };
        await this.workspaces.addEdge(workspace.id, session.terminalId, tree.id, ["share-context"]);
        return { fileTree: { id: tree.id, title: tree.title }, connected: true };
      }
    );
    register(
      "file_preview_create",
      `Cria um contexto Image para um arquivo real dentro do workspace; disponível somente ao ${ORCHESTRATOR_LABEL} autenticado.`,
      filePreviewCreateSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        requireCompazioTerminal(workspace, session.terminalId);
        const root = await realpath(workspace.workingDirectory);
        const candidate = resolve(root, input.filePath);
        const canonical = await realpath(candidate);
        if (canonical === root || !canonical.startsWith(`${root}${sep}`))
          throw new PortalError(
            "PORTAL_NOT_CONNECTED",
            "A imagem precisa estar dentro do workspace autorizado."
          );
        const metadata = await stat(canonical);
        if (!metadata.isFile() || !isImagePreviewPath(canonical))
          throw new PortalError(
            "PORTAL_NOT_CONNECTED",
            "O contexto Image exige um arquivo SVG, PNG, JPEG, GIF ou WebP."
          );
        const relativePath = canonical.slice(root.length + 1).replaceAll("\\", "/");
        const updated = await this.workspaces.addFilePreview(workspace.id, {
          ...(input.title === undefined ? {} : { title: input.title }),
          filePath: relativePath,
          previewKind: "image",
          fileRevision: `${metadata.size}:${Math.trunc(metadata.mtimeMs)}`
        });
        const preview = [...updated.nodes].reverse().find((node) => node.type === "file-preview");
        if (preview === undefined) return { filePreview: null };
        await this.workspaces.addEdge(workspace.id, session.terminalId, preview.id, [
          "share-context"
        ]);
        return {
          filePreview: { id: preview.id, title: preview.title, filePath: preview.filePath },
          connected: true
        };
      }
    );
    register(
      "portal_create",
      `Cria um Portal no canvas; serveWorkspace inicia um servidor estático localhost gerenciado pelo ${ORCHESTRATOR_LABEL} e encerrado com a sessão.`,
      portalCreateSchema,
      async (input, session) => {
        const workspace = await this.requireWorkspaceTerminal(session);
        const terminal = workspace.nodes.find((node) => node.id === session.terminalId);
        if (terminal?.type !== "terminal" || (!terminal.isCompazio && !terminal.orchestrator))
          throw new PortalError(
            "PORTAL_NOT_CONNECTED",
            `Somente o ${ORCHESTRATOR_LABEL} pode criar um Portal.`
          );
        const managedServer =
          input.serveWorkspace === true
            ? await this.ensureWorkspaceStaticServer(workspace, input.port)
            : undefined;
        const updated = await this.workspaces.addPortal(workspace.id, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.url === undefined && managedServer === undefined
            ? {}
            : { url: input.url ?? managedServer?.url ?? "" })
        });
        const portal = [...updated.nodes].reverse().find((node) => node.type === "portal");
        if (portal === undefined) return { portal: null };
        await this.workspaces.addEdge(workspace.id, session.terminalId, portal.id, [
          "portal-read",
          "portal-control",
          "portal-screenshot",
          "share-context"
        ]);
        return {
          portal: sanitizePortalNode(portal),
          connected: true,
          ...(managedServer === undefined
            ? {}
            : { managedServer: { url: managedServer.url, rootDirectory: "." } })
        };
      }
    );
  }

  /** Registers only the team tools this Compazio session can discover. Authorization is checked again per call. */
  private registerTeamTools(
    server: McpServer,
    sessionId: string,
    transport: StreamableHTTPServerTransport
  ): void {
    const teams = this.teams;
    if (teams === undefined) return;
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    const allowed = new Set(
      teamToolsForCapabilities(session.capabilities.filter(isTeamCapability))
    );
    const invoke = <T>(
      tool: TeamMcpToolName,
      operation: (context: {
        readonly session: CompazioMcpSession;
        readonly correlationId: string;
      }) => Promise<T>
    ): Promise<CallToolResult> => this.invokeTool(sessionId, transport.sessionId, tool, operation);
    const require = (capability: TeamMcpCapability, current: CompazioMcpSession): void =>
      this.requireSessionCapability(current, capability);
    const register = <T extends z.ZodType>(
      name: TeamMcpToolName,
      description: string,
      schema: T,
      handler: (
        input: z.infer<T>,
        context: { readonly session: CompazioMcpSession; readonly correlationId: string }
      ) => Promise<unknown>
    ): void => {
      if (!allowed.has(name)) return;
      const registerTool = server.registerTool.bind(server) as unknown as (
        toolName: string,
        config: { readonly description: string; readonly inputSchema: z.ZodType },
        callback: (input: unknown) => Promise<CallToolResult>
      ) => void;
      registerTool(name, { description, inputSchema: schema }, async (input) =>
        invoke(name, (context) => handler(input as z.infer<T>, context))
      );
    };
    const list = async (current: CompazioMcpSession): Promise<Record<string, unknown>> =>
      (await teams.list(current.workspaceId, current.terminalId)) as Record<string, unknown>;

    register(
      "team_list",
      `Lista o estado persistido da equipe do ${ORCHESTRATOR_LABEL}.`,
      teamEmptySchema,
      async (_, context) => {
        require("team-read", context.session);
        return list(context.session);
      }
    );
    register(
      "team_status",
      "Reads visible team members and task states.",
      teamEmptySchema,
      async (_, context) => {
        require("team-read", context.session);
        const result = await list(context.session);
        return { members: result.members, tasks: result.tasks };
      }
    );
    register(
      "team_recruit",
      "Recruits a supported real agent through the Compazio coordinator.",
      teamRecruitSchema,
      async (input, context) => {
        require("team-recruit", context.session);
        if (
          input.positionHint?.relativeTo !== undefined &&
          input.positionHint.relativeTo !== context.session.terminalId
        ) {
          throw new TeamCoordinatorError(
            "TEAM_CAPABILITY_DENIED",
            `A posição do recrutado só pode ser relativa ao ${ORCHESTRATOR_LABEL} autenticado.`,
            false,
            context.correlationId
          );
        }
        return teams.recruit({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          agentType: input.agentType,
          role: input.role,
          idempotencyKey: `team-recruit-${context.correlationId}`,
          correlationId: context.correlationId,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.grantRecruitLimited === undefined
            ? {}
            : { grantRecruitLimited: input.grantRecruitLimited }),
          ...(input.initialTask === undefined
            ? {}
            : {
                initialTask: {
                  title: input.initialTask.title,
                  description: input.initialTask.description,
                  ...(input.initialTask.contextRefs === undefined
                    ? {}
                    : { contextRefs: input.initialTask.contextRefs })
                }
              }),
          ...(input.positionHint === undefined
            ? {}
            : {
                positionHint: {
                  ...(input.positionHint.direction === undefined
                    ? {}
                    : { direction: input.positionHint.direction })
                }
              })
        });
      }
    );
    register(
      "team_dismiss",
      "Dismisses a member and cleans ephemeral resources.",
      teamMemberSchema,
      async (input, context) => {
        require("team-manage", context.session);
        return teams.dismiss({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          teamMemberId: input.teamMemberId,
          correlationId: context.correlationId,
          ...(input.reason === undefined ? {} : { reason: input.reason })
        });
      }
    );
    register(
      "team_run_create",
      "Transforma o objetivo humano em uma missão persistente completa. Escolha a menor equipe permitida pelo modo, gere prompts autônomos por tarefa, inclua contextRefs e gates. QA só pode existir com reviewOf, dependência explícita e outro integrante; nunca crie QA por padrão ou em duplicidade.",
      teamRunCreateSchema,
      async (input, context) => {
        require("team-run-manage", context.session);
        return teams.createRun({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          title: input.title,
          objective: input.objective,
          members: input.members.map((member) => ({
            agentType: member.agentType,
            displayName: member.displayName,
            role: {
              name: member.role.name,
              ...(member.role.description === undefined
                ? {}
                : { description: member.role.description }),
              responsibilities: member.role.responsibilities
            },
            ...(member.grantRecruitLimited === undefined
              ? {}
              : { grantRecruitLimited: member.grantRecruitLimited })
          })),
          tasks: input.tasks.map((task) => ({
            key: task.key,
            title: task.title,
            description: task.description,
            assignedMemberName: task.assignedMemberName,
            ...(task.contextRefs === undefined ? {} : { contextRefs: task.contextRefs }),
            ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn }),
            ...(task.reviewOf === undefined ? {} : { reviewOf: task.reviewOf })
          })),
          acceptance: {
            requirePortal: input.acceptance?.requirePortal ?? false,
            requireQa:
              input.acceptance?.requireQa ?? input.tasks.some((task) => task.reviewOf !== undefined)
          },
          idempotencyKey: `team-run-create-${context.correlationId}`,
          correlationId: context.correlationId
        });
      }
    );
    register(
      "team_run_instruct",
      "Aplica uma nova instrução humana à missão ativa. O Coordinator cria trabalho corretivo durável para o integrante afetado e mantém a revisão depois do ajuste.",
      teamRunInstructSchema,
      async (input, context) => {
        require("team-run-manage", context.session);
        return teams.instructRun({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          runId: input.runId,
          affectedMemberName: input.affectedMemberName,
          instruction: input.instruction,
          ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
          idempotencyKey: `team-run-instruct-${context.correlationId}`,
          correlationId: context.correlationId
        });
      }
    );
    register(
      "team_run_status",
      "Lê o estado de uma execução de equipe visível ao terminal.",
      teamRunIdSchema,
      async (input, context) => {
        require("team-read", context.session);
        return teams.runStatus(
          context.session.workspaceId,
          context.session.terminalId,
          input.runId
        );
      }
    );
    register(
      "team_run_cancel",
      "Cancela uma execução sem apagar o seu histórico.",
      teamRunCancelSchema,
      async (input, context) => {
        require("team-run-manage", context.session);
        return teams.cancelRun({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          runId: input.runId,
          correlationId: context.correlationId,
          ...(input.dismissMembers === undefined ? {} : { dismissMembers: input.dismissMembers })
        });
      }
    );
    register(
      "team_connect",
      "Cria uma conexão explícita entre integrantes desta equipe.",
      teamConnectSchema,
      async (input, context) => {
        require("connection-manage", context.session);
        return teams.connect({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          sourceTerminalId: input.sourceTerminalId,
          targetTerminalId: input.targetTerminalId,
          capabilities: input.capabilities
        });
      }
    );
    register(
      "team_disconnect",
      "Revoga uma conexão sem apagar o histórico de tarefas ou mensagens.",
      teamDisconnectSchema,
      async (input, context) => {
        require("connection-manage", context.session);
        await teams.disconnect({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          edgeId: input.edgeId
        });
        return { edgeId: input.edgeId, disconnected: true };
      }
    );
    register(
      "task_create",
      "Creates a task durably before delivery.",
      taskCreateSchema,
      async (input, context) => {
        require("task-create", context.session);
        return teams.createTask({
          workspaceId: context.session.workspaceId,
          creatorId: context.session.terminalId,
          title: input.title,
          description: input.description,
          idempotencyKey: `task-create-${context.correlationId}`,
          correlationId: context.correlationId,
          ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          ...(input.reviewOf === undefined ? {} : { reviewOf: input.reviewOf }),
          ...(input.priority === undefined ? {} : { priority: input.priority })
        });
      }
    );
    register(
      "task_list",
      "Lista tarefas disponíveis para este terminal.",
      taskListSchema,
      async (input, context) => {
        require("team-read", context.session);
        const visible = await list(context.session);
        const tasks = (visible.tasks as readonly { readonly runId?: string }[]).filter(
          (task) => input.runId === undefined || task.runId === input.runId
        );
        return { tasks };
      }
    );
    register(
      "task_assign",
      "Assigns and delivers a task to a ready member.",
      taskAssignSchema,
      async (input, context) => {
        require("task-assign", context.session);
        return teams.assignTask({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          taskId: input.taskId,
          teamMemberId: input.teamMemberId,
          idempotencyKey: `task-assign-${context.correlationId}`,
          correlationId: context.correlationId
        });
      }
    );
    register(
      "task_status",
      "Reads a structured task state.",
      taskIdSchema,
      async (input, context) => {
        if (!context.session.capabilities.includes("result-return"))
          require("team-read", context.session);
        return teams.taskStatus(
          context.session.workspaceId,
          context.session.terminalId,
          input.taskId
        );
      }
    );
    register(
      "task_wait",
      "Consulta o estado atual sem iniciar polling oculto.",
      taskIdSchema,
      async (input, context) => {
        if (!context.session.capabilities.includes("result-return"))
          require("team-read", context.session);
        return teams.taskStatus(
          context.session.workspaceId,
          context.session.terminalId,
          input.taskId
        );
      }
    );
    register(
      "task_result",
      "Reads or returns a structured task result.",
      taskResultSchema,
      async (input, context) => {
        if (input.result === undefined) require("team-read", context.session);
        else require("result-return", context.session);
        return teams.taskResult({
          workspaceId: context.session.workspaceId,
          requesterId: context.session.terminalId,
          taskId: input.taskId,
          correlationId: context.correlationId,
          idempotencyKey: `task-result-${context.correlationId}`,
          ...(input.result === undefined
            ? {}
            : {
                result: {
                  summary: input.result.summary,
                  ...(input.result.artifacts === undefined
                    ? {}
                    : { artifacts: input.result.artifacts })
                }
              })
        });
      }
    );
    register(
      "task_request_user_input",
      "Pausa a tarefa e encaminha uma pergunta estruturada ao usuário pelo Compazio. A chamada aguarda a resposta e então devolve o texto ao worker; nunca peça a resposta na TUI privada.",
      taskRequestUserInputSchema,
      async (input, context) => {
        require("result-return", context.session);
        return teams.requestUserInput({
          workspaceId: context.session.workspaceId,
          requesterId: context.session.terminalId,
          taskId: input.taskId,
          question: input.question,
          reason: input.reason,
          expectedAnswerType: input.expectedAnswerType,
          ...(input.context === undefined ? {} : { context: input.context }),
          idempotencyKey: `task-user-input-${context.correlationId}`,
          correlationId: context.correlationId
        });
      }
    );
    register(
      "team_user_input_list",
      "Lista perguntas estruturadas que pertencem a este Compazio ou worker.",
      teamEmptySchema,
      async (_, context) => {
        require("team-read", context.session);
        return {
          requests: await teams.listUserInputRequests(
            context.session.workspaceId,
            context.session.terminalId
          )
        };
      }
    );
    register(
      "team_user_input_answer",
      "Registra a resposta humana no canal principal do Compazio e retoma a tarefa bloqueada.",
      teamUserInputAnswerSchema,
      async (input, context) => {
        require("team-run-manage", context.session);
        return teams.answerUserInput({
          workspaceId: context.session.workspaceId,
          compazioTerminalId: context.session.terminalId,
          requestId: input.requestId,
          answer: input.answer,
          correlationId: context.correlationId
        });
      }
    );
    register(
      "message_send",
      "Persists a connection-authorized control-plane message; it is never typed into a terminal.",
      messageSendSchema,
      async (input, context) => {
        require("message-send", context.session);
        return teams.sendMessage({
          workspaceId: context.session.workspaceId,
          fromTerminalId: context.session.terminalId,
          toTerminalId: input.toTerminalId,
          content: input.content,
          type: input.type,
          idempotencyKey: `message-send-${context.correlationId}`,
          correlationId: context.correlationId,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId })
        });
      }
    );
    register(
      "message_list",
      "Lists persisted messages visible to this terminal.",
      teamEmptySchema,
      async (_, context) => {
        require("message-send", context.session);
        return {
          messages: await teams.messageList(context.session.workspaceId, context.session.terminalId)
        };
      }
    );
    register(
      "message_read",
      "Lê uma mensagem já visível para este terminal.",
      messageIdSchema,
      async (input, context) => {
        require("message-send", context.session);
        return teams.messageRead(
          context.session.workspaceId,
          context.session.terminalId,
          input.messageId
        );
      }
    );
    register(
      "message_acknowledge",
      "Confirma uma mensagem recebida sem duplicar a entrega.",
      messageIdSchema,
      async (input, context) => {
        require("message-send", context.session);
        return teams.acknowledgeMessage(
          context.session.workspaceId,
          context.session.terminalId,
          input.messageId
        );
      }
    );
    return;

    /* Legacy broad team tools are intentionally disabled for the 5A vertical slice.

    register("team_list", "Lista equipe, tarefas e mensagens disponíveis ao terminal.", teamEmptySchema, async (_, context) => {
      require("team-read", context.session);
      return list(context.session);
    });
    register("team_get", "Lê o estado seguro da equipe do terminal.", teamEmptySchema, async (_, context) => {
      require("team-read", context.session);
      return list(context.session);
    });
    register("team_status", "Lê o resumo operacional da equipe.", teamEmptySchema, async (_, context) => {
      require("team-read", context.session);
      const result = await list(context.session);
      return { members: result.members, tasks: result.tasks };
    });
    register("team_recruit", "Recruta e inicia um agente real no canvas.", teamRecruitSchema, async (input, context) => {
      require("team-admin", context.session);
      return teams.recruit({
        workspaceId: context.session.workspaceId,
        compazioTerminalId: context.session.terminalId,
        agentType: input.agentType,
        idempotencyKey: input.idempotencyKey,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        ...(input.initialTask === undefined
          ? {}
          : {
              initialTask: {
                title: input.initialTask.title,
                ...(input.initialTask.description === undefined
                  ? {}
                  : { description: input.initialTask.description })
              }
            }),
        ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs })
      });
    });
    register("team_assign_role", "Atribui uma responsabilidade operacional a um integrante.", teamMemberSchema.extend({ roleId: teamIdSchema }).strict(), async (input, context) => {
      require("team-admin", context.session);
      await teams.assignRole(context.session.workspaceId, context.session.terminalId, input.terminalId, input.roleId);
      return { terminalId: input.terminalId, roleId: input.roleId };
    });
    register("team_connect", "Cria uma conexão autorizada entre dois terminais.", teamConnectSchema, async (input, context) => {
      require("team-admin", context.session);
      return teams.connect({
        workspaceId: context.session.workspaceId,
        compazioTerminalId: context.session.terminalId,
        sourceTerminalId: input.sourceTerminalId,
        targetTerminalId: input.targetTerminalId,
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities })
      });
    });
    register("team_disconnect", "Revoga uma conexão de equipe.", teamDisconnectSchema, async (input, context) => {
      require("team-admin", context.session);
      await teams.disconnect(context.session.workspaceId, context.session.terminalId, input.edgeId);
      return { edgeId: input.edgeId, disconnected: true };
    });
    register("team_dismiss", `Dispensa um agente e limpa seus recursos controlados pelo ${ORCHESTRATOR_LABEL}.`, teamMemberSchema, async (input, context) => {
      require("team-admin", context.session);
      await teams.dismiss(context.session.workspaceId, context.session.terminalId, input.terminalId);
      return { terminalId: input.terminalId, dismissed: true };
    });

    register("task_list", "Lista tarefas visíveis ao terminal.", teamEmptySchema, async (_, context) => {
      require("task-read", context.session);
      return { tasks: (await list(context.session)).tasks ?? [] };
    });
    register("task_create", "Cria uma tarefa persistente de equipe.", taskCreateSchema, async (input, context) => {
      require("team-admin", context.session);
      return teams.createTask({
        workspaceId: context.session.workspaceId,
        creatorId: context.session.terminalId,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo }),
        ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
        ...(input.priority === undefined ? {} : { priority: input.priority })
      });
    });
    const updateTask = async (input: z.infer<typeof taskUpdateSchema>, context: { readonly session: CompazioMcpSession; readonly correlationId: string }, status?: z.infer<typeof taskUpdateSchema>["status"]): Promise<unknown> => {
      if (status === undefined) require("task-update", context.session);
      else require("team-admin", context.session);
      return teams.updateTask({
        workspaceId: context.session.workspaceId,
        actorId: context.session.terminalId,
        taskId: input.taskId,
        ...(status === undefined ? input.status === undefined ? {} : { status: input.status } : { status }),
        ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo }),
        ...(input.resultRefs === undefined ? {} : { resultRefs: input.resultRefs })
      });
    };
    register("task_assign", "Atribui uma tarefa a terminais da equipe.", taskUpdateSchema, async (input, context) => updateTask(input, context, "assigned"));
    register("task_start", "Inicia uma tarefa atribuída.", taskIdSchema, async (input, context) => updateTask({ taskId: input.taskId }, context, "running"));
    register("task_update", "Atualiza o estado de uma tarefa atribuída.", taskUpdateSchema, async (input, context) => updateTask(input, context));
    register("task_complete", "Conclui uma tarefa e preserva resultados referenciados.", taskUpdateSchema, async (input, context) => updateTask(input, context, "completed"));
    register("task_fail", "Marca uma tarefa como falha recuperável.", taskUpdateSchema, async (input, context) => updateTask(input, context, "failed"));
    register("task_cancel", "Cancela uma tarefa sem apagar seu histórico.", taskUpdateSchema, async (input, context) => updateTask(input, context, "cancelled"));
    register("task_result", "Lê o resultado e o estado seguro de uma tarefa.", taskIdSchema, async (input, context) => {
      require("task-read", context.session);
      const tasks = ((await list(context.session)).tasks as readonly { readonly id: string }[] | undefined) ?? [];
      const task = tasks.find((candidate) => candidate.id === input.taskId);
      if (task === undefined) throw new TeamCoordinatorError("TEAM_TASK_NOT_FOUND", "A tarefa não está disponível para este terminal.");
      return task;
    });
    register("task_wait", "Consulta o estado atual de uma tarefa sem criar polling oculto.", taskIdSchema, async (input, context) => {
      require("task-read", context.session);
      const tasks = ((await list(context.session)).tasks as readonly { readonly id: string }[] | undefined) ?? [];
      const task = tasks.find((candidate) => candidate.id === input.taskId);
      if (task === undefined) throw new TeamCoordinatorError("TEAM_TASK_NOT_FOUND", "A tarefa não está disponível para este terminal.");
      return task;
    });

    register("message_send", "Registra uma mensagem operacional persistente; ela nunca é digitada no terminal.", messageSendSchema, async (input, context) => {
      require("message-send", context.session);
      return teams.sendMessage({
        workspaceId: context.session.workspaceId,
        fromTerminalId: context.session.terminalId,
        toTerminalId: input.toTerminalId,
        content: input.content,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId })
      });
    });
    register("message_reply", "Responde uma mensagem recebida pela conexão de retorno.", messageIdSchema.extend({ content: z.string().trim().min(1).max(16_000), idempotencyKey: z.string().trim().min(8).max(240) }).strict(), async (input, context) => {
      require("message-send", context.session);
      const messages = ((await list(context.session)).messages as readonly { readonly id: string; readonly fromTerminalId: string; readonly taskId?: string }[] | undefined) ?? [];
      const original = messages.find((message) => message.id === input.messageId);
      if (original === undefined) throw new TeamCoordinatorError("MESSAGE_NOT_FOUND", "A mensagem original não está disponível.");
      return teams.sendMessage({
        workspaceId: context.session.workspaceId,
        fromTerminalId: context.session.terminalId,
        toTerminalId: original.fromTerminalId,
        ...(original.taskId === undefined ? {} : { taskId: original.taskId }),
        content: input.content,
        type: "result",
        idempotencyKey: input.idempotencyKey
      });
    });
    register("message_acknowledge", "Confirma o recebimento de uma mensagem.", messageIdSchema, async (input, context) => {
      require("message-send", context.session);
      return teams.acknowledgeMessage(context.session.workspaceId, context.session.terminalId, input.messageId);
    });
    register("message_list", "Lista mensagens visíveis ao terminal.", teamEmptySchema, async (_, context) => {
      require("message-send", context.session);
      return { messages: (await list(context.session)).messages ?? [] };
    });
    register("message_read", "Lê uma mensagem visível ao terminal.", messageIdSchema, async (input, context) => {
      require("message-send", context.session);
      const messages = ((await list(context.session)).messages as readonly { readonly id: string }[] | undefined) ?? [];
      const message = messages.find((candidate) => candidate.id === input.messageId);
      if (message === undefined) throw new TeamCoordinatorError("MESSAGE_NOT_FOUND", "A mensagem não está disponível.");
      return message;
    });

    register("canvas_get_context", "Lê uma visão segura do canvas atual.", teamEmptySchema, async (_, context) => {
      require("context-read", context.session);
      return teams.canvasContext(context.session.workspaceId, context.session.terminalId);
    });
    register("canvas_create_group", "Agrupa nós existentes do canvas.", canvasGroupSchema, async (input, context) => {
      require("team-admin", context.session);
      return teams.createCanvasGroup(context.session.workspaceId, context.session.terminalId, input.title, input.nodeIds);
    });
    register("canvas_move_node", `Move um nó por uma ação explícita do ${ORCHESTRATOR_LABEL}.`, canvasMoveSchema, async (input, context) => {
      require("team-admin", context.session);
      await teams.moveCanvasNode(context.session.workspaceId, context.session.terminalId, input.nodeId, input.x, input.y);
      return { nodeId: input.nodeId, moved: true };
    });
    register("canvas_focus_nodes", "Retorna os nós solicitados para que a UI os enquadre.", canvasFocusSchema, async (input, context) => {
      require("team-admin", context.session);
      return { nodeIds: input.nodeIds };
    });
    for (const name of ["context_attach_note", "context_attach_file", "context_attach_node"] as const) {
      register(name, "Anexa um nó de contexto existente a uma tarefa.", contextAttachSchema, async (input, context) => {
        require("team-admin", context.session);
        return teams.attachContext(context.session.workspaceId, context.session.terminalId, input.taskId, input.nodeId);
      });
    }
    register("context_list", "Lista contexto conectado que pode ser referenciado por tarefas.", teamEmptySchema, async (_, context) => {
      require("context-read", context.session);
      return teams.contextList(context.session.workspaceId, context.session.terminalId);
    });
  }

    */
  }

  private async automationTool(
    invoke: <T>(
      tool: CompazioMcpToolName,
      operation: (context: {
        readonly session: CompazioMcpSession;
        readonly correlationId: string;
      }) => Promise<T>
    ) => Promise<CallToolResult>,
    tool: CompazioMcpToolName,
    input: {
      readonly portalId: string;
      readonly timeoutMs?: number | undefined;
      readonly correlationId?: string | undefined;
    },
    action: "click" | "type" | "press" | "scroll",
    automationInput: PortalAutomationInput
  ): Promise<CallToolResult> {
    return invoke(tool, async ({ session, correlationId }) => {
      await this.withPortal(session, input.portalId, "portal-control");
      return this.portals.automation(
        session.workspaceId,
        input.portalId,
        action,
        automationInput,
        operationOptions(input, session, correlationId)
      );
    });
  }

  private async invokeTool<T>(
    sessionId: string,
    transportSessionId: string | undefined,
    tool: CompazioMcpToolName,
    operation: (context: {
      readonly session: CompazioMcpSession;
      readonly correlationId: string;
    }) => Promise<T>
  ): Promise<CallToolResult> {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    const session = this.sessions.get(sessionId);
    try {
      if (session === undefined || isRevokedOrExpired(session))
        throw new PortalError("PORTAL_OPERATION_CANCELLED", "A sessão MCP foi revogada.");
      const result = await operation({ session, correlationId });
      const rich = isRichToolData(result) ? result : undefined;
      const data = limitResponse(rich === undefined ? result : rich.data, tool);
      this.recordToolCall({
        tool,
        ...(transportSessionId === undefined ? {} : { transportSessionId }),
        compazioSessionId: session.id,
        workspaceId: session.workspaceId,
        terminalId: session.terminalId,
        correlationId,
        ok: true,
        durationMs: Date.now() - startedAt
      });
      return toolSuccess(tool, data, correlationId, rich?.content);
    } catch (error) {
      const failure = asToolFailure(error);
      this.recordToolCall({
        tool,
        ...(transportSessionId === undefined ? {} : { transportSessionId }),
        compazioSessionId: session?.id ?? sessionId,
        workspaceId: session?.workspaceId ?? "revoked",
        terminalId: session?.terminalId ?? "revoked",
        correlationId,
        ok: false,
        code: failure.code,
        durationMs: Date.now() - startedAt
      });
      return toolError(failure.code, failure.message, correlationId, failure.retryable, failure);
    }
  }

  private requireSessionCapability(
    session: CompazioMcpSession,
    capability: CompazioMcpCapability
  ): void {
    if (!session.capabilities.includes(capability))
      throw new PortalError(
        "PORTAL_NOT_CONNECTED",
        "Esta sessão não possui a capability necessária para este Portal."
      );
  }

  private async requireWorkspaceTerminal(session: CompazioMcpSession) {
    const workspace = await this.workspaces.snapshot(session.workspaceId);
    if (!workspace.nodes.some((node) => node.id === session.terminalId && node.type === "terminal"))
      throw new PortalError("PORTAL_NOT_CONNECTED", "O terminal desta sessão não está disponível.");
    return workspace;
  }

  private async withPortal(
    session: CompazioMcpSession,
    portalId: string,
    capability: PortalAccessCapability
  ) {
    const workspace = await this.requireWorkspaceTerminal(session);
    const portal = workspace.nodes.find(
      (node): node is PortalNode => node.id === portalId && node.type === "portal"
    );
    if (portal === undefined)
      throw new PortalError("PORTAL_NOT_FOUND", "O Portal solicitado não está disponível.");
    const authorizedTerminalId = contextTerminalIds(workspace, session.terminalId).find(
      (terminalId) =>
        hasPortalCapability(workspace, { terminalNodeId: terminalId, portalId }, capability)
    );
    if (authorizedTerminalId === undefined)
      throw new PortalError(
        "PORTAL_NOT_CONNECTED",
        "A conexão deste terminal não concede essa capability ao Portal."
      );
    if (capability === "portal-control") {
      const authorization = authorizePortalControl(workspace, {
        terminalNodeId: authorizedTerminalId,
        portalId
      });
      if (!authorization.ok) throw new PortalError(authorization.code, authorization.message);
    }
    await this.portals.ensure(workspace.id, portal);
    return this.portals.get(workspace.id, portalId);
  }

  private isExpectedHost(request: IncomingMessage): boolean {
    if (this.endpoint === null) return false;
    return request.headers.host === new URL(this.endpoint).host;
  }

  private isExpectedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return origin === undefined || origin === new URL(this.endpoint ?? "http://127.0.0.1").origin;
  }

  private async closeTransportsFor(compazioSessionId: string): Promise<void> {
    const bindings = [...this.transports.values()].filter(
      (binding) => binding.compazioSessionId === compazioSessionId
    );
    await Promise.all(bindings.map((binding) => this.closeBinding(binding)));
  }

  private async closeBinding(binding: TransportBinding): Promise<void> {
    const sessionId = binding.transport.sessionId;
    try {
      // A live CLI can keep the SDK's stream close pending. The socket is already revoked, so this
      // cleanup must be bounded: reload/recovery cannot be held hostage by a remote client.
      await Promise.race([
        Promise.allSettled([binding.transport.close(), binding.server.close()]),
        timeout(mcpBindingCloseGraceMs)
      ]);
    } finally {
      if (sessionId !== undefined) this.transports.delete(sessionId);
    }
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) <= now && session.revokedAt === undefined)
        session.revokedAt = new Date(now).toISOString();
    }
  }

  private recordToolCall(call: CompazioMcpToolCall): void {
    for (const listener of this.toolCallListeners) listener(call);
  }

  private recordHttpRequest(request: CompazioMcpHttpRequest): void {
    for (const listener of this.httpRequestListeners) listener(request);
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isPortalCapability(
  capability: CompazioMcpCapability
): capability is PortalAccessCapability {
  return capability.startsWith("portal-");
}

function isTeamCapability(capability: CompazioMcpCapability): capability is TeamMcpCapability {
  return !isPortalCapability(capability);
}

async function serveManagedStaticFile(
  rootDirectory: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const host = request.headers.host?.toLowerCase() ?? "";
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const root = resolve(rootDirectory);
    let target = resolve(root, relativePath === "" ? "index.html" : relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if ((await stat(target)).isDirectory()) target = resolve(target, "index.html");
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== root && !canonicalTarget.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const contents = await readFile(canonicalTarget);
    response.writeHead(200, {
      "Content-Type": managedStaticContentType(extname(canonicalTarget)),
      "Content-Length": contents.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    response.writeHead(code === "ENOENT" || code === "ENOTDIR" ? 404 : 500).end();
  }
}

function managedStaticContentType(extension: string): string {
  return (
    (
      {
        ".css": "text/css; charset=utf-8",
        ".gif": "image/gif",
        ".html": "text/html; charset=utf-8",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml; charset=utf-8",
        ".webp": "image/webp"
      } as Readonly<Record<string, string>>
    )[extension.toLowerCase()] ?? "application/octet-stream"
  );
}

function isImagePreviewPath(filePath: string): boolean {
  return [".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(
    extname(filePath).toLowerCase()
  );
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === "EADDRINUSE"
  );
}

function managedWorkspaceServerPort(value: string): number | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/" ||
      url.search !== ""
    )
      return undefined;
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 41_800 && port <= 41_899 ? port : undefined;
  } catch {
    return undefined;
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isRevokedOrExpired(session: CompazioMcpSession): boolean {
  return session.revokedAt !== undefined || Date.parse(session.expiresAt) <= Date.now();
}

function initializeProtocolVersion(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const request = body as { readonly method?: unknown; readonly params?: unknown };
  if (
    request.method !== "initialize" ||
    request.params === null ||
    typeof request.params !== "object"
  )
    return undefined;
  const protocolVersion = (request.params as { readonly protocolVersion?: unknown })
    .protocolVersion;
  return typeof protocolVersion === "string" ? protocolVersion : undefined;
}

function safeMcpRequestMethod(
  body: unknown
): "initialize" | "notifications/initialized" | "tools/list" | "tools/call" | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const method = (body as { readonly method?: unknown }).method;
  return method === "initialize" ||
    method === "notifications/initialized" ||
    method === "tools/list" ||
    method === "tools/call"
    ? method
    : undefined;
}

function toolSuccess(
  tool: CompazioMcpToolName,
  data: unknown,
  correlationId: string,
  additionalContent: readonly CallToolResult["content"][number][] = []
): CallToolResult {
  const serialized = JSON.stringify(data) ?? "null";
  const visibleData = serialized.length > 24_000 ? `${serialized.slice(0, 24_000)}…` : serialized;
  return {
    // Some real MCP clients currently expose only `content` to the model. Mirror the already
    // authorized and size-limited structured payload so human answers and teammate messages never
    // force an agent to inspect persistence internals or a private TUI.
    content: [
      { type: "text" as const, text: `Compazio ${tool}: ${visibleData}` },
      ...additionalContent
    ],
    structuredContent: { ok: true, correlationId, data }
  };
}

function toolError(
  code: string,
  message: string,
  correlationId: string,
  retryable = false,
  details: {
    readonly suggestedAction?: string;
    readonly technicalDetails?: string;
  } = {}
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: {
      ok: false,
      correlationId,
      error: {
        code,
        message,
        retryable,
        ...(details.suggestedAction === undefined
          ? {}
          : { suggestedAction: details.suggestedAction }),
        ...(details.technicalDetails === undefined
          ? {}
          : { technicalDetails: details.technicalDetails })
      }
    }
  };
}

function operationOptions(
  input: { readonly timeoutMs?: number | undefined; readonly correlationId?: string | undefined },
  session: CompazioMcpSession,
  correlationId: string
) {
  return {
    terminalNodeId: session.terminalId,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    correlationId: input.correlationId ?? correlationId
  };
}

function portalReadInput(input: {
  readonly query?: string | undefined;
  readonly maxNodes?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxChars?: number | undefined;
  readonly includeBounds?: boolean | undefined;
  readonly role?: string | undefined;
  readonly name?: string | undefined;
}): PortalAutomationInput {
  return {
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.includeBounds === undefined ? {} : { includeBounds: input.includeBounds }),
    ...(input.role === undefined && input.name === undefined
      ? {}
      : {
          filter: {
            ...(input.role === undefined ? {} : { role: input.role }),
            ...(input.name === undefined ? {} : { name: input.name })
          }
        }),
    ...(input.maxNodes === undefined && input.maxDepth === undefined && input.maxChars === undefined
      ? {}
      : {
          limits: {
            ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
            ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
            ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars })
          }
        })
  };
}

function compactAutomationInput(input: {
  readonly role?: string | undefined;
  readonly name?: string | undefined;
  readonly label?: string | undefined;
  readonly text?: string | undefined;
  readonly selector?: string | undefined;
  readonly coordinates?: { readonly x: number; readonly y: number } | undefined;
  readonly exact?: boolean | undefined;
  readonly index?: number | undefined;
}): PortalAutomationInput {
  return {
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.selector === undefined ? {} : { selector: input.selector }),
    ...(input.coordinates === undefined ? {} : { coordinates: input.coordinates }),
    ...(input.exact === undefined ? {} : { exact: input.exact }),
    ...(input.index === undefined ? {} : { index: input.index })
  };
}

function connectedContextNodes(workspace: Workspace, terminalId: string): readonly CanvasNode[] {
  const allowedTerminalIds = new Set(contextTerminalIds(workspace, terminalId));
  const ids = new Set(
    workspace.edges.flatMap((edge) => {
      const connectedTerminalId = allowedTerminalIds.has(edge.sourceNodeId)
        ? edge.sourceNodeId
        : allowedTerminalIds.has(edge.targetNodeId)
          ? edge.targetNodeId
          : undefined;
      if (connectedTerminalId === undefined) return [];
      if (
        !edge.capabilities.some((capability) =>
          ["share-context", "read-note", "write-note", "portal-read", "portal-control"].includes(
            capability
          )
        )
      )
        return [];
      return [edge.sourceNodeId === connectedTerminalId ? edge.targetNodeId : edge.sourceNodeId];
    })
  );
  return workspace.nodes.filter((node) => ids.has(node.id) && node.type !== "terminal");
}

function requireCompazioTerminal(
  workspace: Workspace,
  terminalId: string
): Extract<CanvasNode, { readonly type: "terminal" }> {
  const terminal = workspace.nodes.find((node) => node.id === terminalId);
  if (terminal?.type !== "terminal" || (!terminal.isCompazio && !terminal.orchestrator)) {
    throw new PortalError(
      "PORTAL_NOT_CONNECTED",
      `Somente o ${ORCHESTRATOR_LABEL} pode criar recursos no canvas.`
    );
  }
  return terminal;
}

function requireConnectedContext(
  workspace: Workspace,
  terminalId: string,
  nodeId: string
): CanvasNode {
  const node = connectedContextNodes(workspace, terminalId).find(
    (candidate) => candidate.id === nodeId
  );
  if (node === undefined)
    throw new PortalError(
      "PORTAL_NOT_CONNECTED",
      "Este contexto não está conectado ao agente. Conecte o canvas e tente novamente."
    );
  return node;
}

function requireWritableNote(
  workspace: Workspace,
  terminalId: string,
  noteId: string
): Extract<CanvasNode, { readonly type: "note" }> {
  const note = workspace.nodes.find((node) => node.id === noteId);
  const allowedTerminalIds = new Set(contextTerminalIds(workspace, terminalId));
  const writable = workspace.edges.some(
    (edge) =>
      ((allowedTerminalIds.has(edge.sourceNodeId) && edge.targetNodeId === noteId) ||
        (allowedTerminalIds.has(edge.targetNodeId) && edge.sourceNodeId === noteId)) &&
      edge.capabilities.includes("write-note")
  );
  if (note?.type !== "note" || !writable)
    throw new PortalError(
      "PORTAL_NOT_CONNECTED",
      "A nota não está conectada com permissão de escrita."
    );
  return note;
}

/** A recruited worker inherits the orchestrator's live context while their team edge shares context. */
function contextTerminalIds(workspace: Workspace, terminalId: string): readonly string[] {
  const terminal = workspace.nodes.find((node) => node.id === terminalId);
  if (terminal?.type !== "terminal" || terminal.orchestratorOwnerNodeId === undefined)
    return [terminalId];
  const ownerId = terminal.orchestratorOwnerNodeId;
  const sharesOwnerContext = workspace.edges.some(
    (edge) =>
      ((edge.sourceNodeId === terminalId && edge.targetNodeId === ownerId) ||
        (edge.targetNodeId === terminalId && edge.sourceNodeId === ownerId)) &&
      edge.capabilities.includes("share-context")
  );
  return sharesOwnerContext ? [terminalId, ownerId] : [terminalId];
}

function hasEffectivePortalCapability(
  workspace: Workspace,
  terminalId: string,
  portalId: string,
  capability: PortalAccessCapability
): boolean {
  return contextTerminalIds(workspace, terminalId).some((candidateId) =>
    hasPortalCapability(workspace, { terminalNodeId: candidateId, portalId }, capability)
  );
}

function contextNodeSummary(workspace: Workspace, node: CanvasNode): Record<string, unknown> {
  if (node.type === "note") {
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      checklist: node.content.split(/\r?\n/).filter((line) => /^\s*- \[[ xX]\]/.test(line))
    };
  }
  if (node.type === "file-preview") {
    return {
      id: node.id,
      type: node.previewKind === "image" ? "image" : "file",
      title: node.title,
      path: resolve(workspace.workingDirectory, node.filePath),
      previewKind: node.previewKind,
      missing: node.missing
    };
  }
  if (node.type === "file-tree") {
    return {
      id: node.id,
      type: "directory",
      title: node.title,
      path: resolve(workspace.workingDirectory, node.currentPath)
    };
  }
  if (node.type === "portal") return { ...sanitizePortalNode(node), type: "portal" };
  return { id: node.id, type: node.type, title: node.title };
}

function contextNodeDetail(workspace: Workspace, node: CanvasNode): Record<string, unknown> {
  const summary = contextNodeSummary(workspace, node);
  return node.type === "note" ? { ...summary, content: node.content } : summary;
}

const richToolDataMarker = Symbol("compazio-rich-tool-data");

interface RichToolData {
  readonly [richToolDataMarker]: true;
  readonly data: unknown;
  readonly content: readonly CallToolResult["content"][number][];
}

function richToolData(
  data: unknown,
  content: readonly CallToolResult["content"][number][]
): RichToolData {
  return { [richToolDataMarker]: true, data, content };
}

function isRichToolData(value: unknown): value is RichToolData {
  return (
    typeof value === "object" &&
    value !== null &&
    richToolDataMarker in value &&
    value[richToolDataMarker] === true
  );
}

async function readConnectedDocument(
  workspace: Workspace,
  filePath: string
): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const root = await realpath(workspace.workingDirectory);
  const candidate = resolve(root, filePath);
  const canonical = await realpath(candidate).catch(() => {
    throw new PortalError("PORTAL_NOT_CONNECTED", "O arquivo conectado não foi encontrado.");
  });
  if (canonical === root || !canonical.startsWith(`${root}${sep}`))
    throw new PortalError(
      "PORTAL_NOT_CONNECTED",
      "O arquivo conectado sai do workspace autorizado."
    );
  const metadata = await stat(canonical);
  if (!metadata.isFile())
    throw new PortalError("PORTAL_NOT_CONNECTED", "O contexto conectado não é um arquivo.");
  if (metadata.size > maximumConnectedDocumentBytes)
    throw new PortalError(
      "PORTAL_OPERATION_FAILED",
      "A leitura semântica é limitada a documentos de até 5 MB."
    );
  return { path: canonical, bytes: await readFile(canonical) };
}

function contextImageMime(filePath: string): string | undefined {
  return (
    {
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp"
    } as Readonly<Record<string, string>>
  )[extname(filePath).toLowerCase()];
}

function sanitizePortalNode(node: PortalNode) {
  return { id: node.id, title: node.title.slice(0, 256), url: sanitizeUrl(node.url) };
}

function sanitizePortalSnapshot(snapshot: {
  readonly portalId: string;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly focused: boolean;
  readonly failure: unknown;
}) {
  return {
    portalId: snapshot.portalId,
    title: snapshot.title.slice(0, 256),
    url: sanitizeUrl(snapshot.url),
    state: snapshot.state,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    loading: snapshot.loading,
    focused: snapshot.focused,
    failure: snapshot.failure
  };
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 2_048);
  } catch {
    return "about:blank";
  }
}

function limitResponse<T>(data: T, tool: CompazioMcpToolName): T {
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes <= maximumResponseBytes) return data;
  throw new PortalError(
    tool === "portal_dom" || tool === "portal_accessibility"
      ? "PORTAL_DOM_LIMIT_EXCEEDED"
      : "PORTAL_OPERATION_FAILED",
    "A resposta do Portal excede o limite seguro.",
    { tool, maximumResponseBytes }
  );
}

function asToolFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedAction?: string;
  readonly technicalDetails?: string;
} {
  if (error instanceof PortalError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "PORTAL_TIMEOUT" || error.code === "PORTAL_LOADING_FAILED"
    };
  if (error instanceof TeamCoordinatorError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      suggestedAction: error.suggestedAction,
      ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails })
    };
  return {
    code: "PORTAL_OPERATION_FAILED",
    message: "A operação do Portal não pôde ser concluída.",
    retryable: false
  };
}

function timeout(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > maximumRequestBytes) throw new Error("MCP request is too large");
  }
  return JSON.parse(body);
}
