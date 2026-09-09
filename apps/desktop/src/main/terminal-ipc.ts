import { randomUUID } from "node:crypto";

import type { IpcMain } from "electron";

import { AgentBridge } from "@forgedeck/agent-adapters";
import type {
  AgentAdapter,
  CommandRunner,
  ExecutableDetector,
  RuntimePlatform
} from "@forgedeck/agent-sdk";
import type { GitProject } from "@forgedeck/git";
import { redactTerminalText, redactText } from "@forgedeck/logger";
import {
  TERMINAL_BUFFER_CHANNEL,
  TERMINAL_CANCEL_CHANNEL,
  TERMINAL_CLEAR_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_LIST_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  terminalBufferResponseSchema,
  terminalCreateRequestSchema,
  terminalEventSchema,
  terminalListResponseSchema,
  terminalResizeRequestSchema,
  terminalSessionRequestSchema,
  terminalSessionSchema,
  terminalWriteRequestSchema
} from "@forgedeck/schemas";
import type { TerminalCreateRequest, TerminalEvent, TerminalSession } from "@forgedeck/schemas";
import type {
  ProcessSessionSnapshot,
  ProcessSupervisorEvent,
  StartProcessSessionInput
} from "@forgedeck/terminal";

import { grantsTeamOrchestration } from "@forgedeck/orchestration";

import { prependToPath } from "./cli-provisioning";
import {
  buildTerminalContextPrompt,
  type StagedTerminalContext,
  type TerminalContextUnavailable
} from "./terminal-context-staging";

interface TerminalSupervisor {
  start(input: StartProcessSessionInput): Promise<ProcessSessionSnapshot>;
  listSessions(): readonly ProcessSessionSnapshot[];
  getBufferSnapshot(sessionId: string): { readonly data: string; readonly sequence: number };
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): void;
  clearBuffer(sessionId: string): void;
  cancel(sessionId: string): Promise<ProcessSessionSnapshot>;
}

interface TerminalProjectResolver {
  get(projectId: string): Promise<GitProject | null>;
}

interface TerminalAdapterResolver {
  get(adapterId: string): AgentAdapter;
}

export interface TerminalIpcServices {
  readonly supervisor: TerminalSupervisor;
  readonly projects: TerminalProjectResolver;
  readonly adapters: TerminalAdapterResolver;
  readonly detector: ExecutableDetector;
  readonly commandRunner: CommandRunner;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: RuntimePlatform;
  readonly createSessionId?: () => string;
  readonly sessionAccess?: {
    bind(
      sessionId: string,
      access: {
        readonly projectId: string;
        readonly adapterId: TerminalCreateRequest["adapterId"];
        readonly workspaceId?: string;
        readonly canvasNodeId?: string;
        readonly workflow?: {
          readonly runId: string;
          readonly nodeId: string;
          readonly attempt: number;
        };
        readonly readOnly?: boolean;
      }
    ): void;
    get(sessionId: string): {
      readonly projectId: string;
      readonly adapterId: string;
      readonly workspaceId?: string;
      readonly canvasNodeId?: string;
      readonly workflow?: {
        readonly runId: string;
        readonly nodeId: string;
        readonly attempt: number;
      };
      readonly readOnly?: boolean;
    } | null;
    belongsToProject(sessionId: string, projectId: string): boolean;
  };
  readonly maxActiveSessionsPerProject?: number;
  /**
   * Makes the `compazio` command reachable from inside the session and tells the process which
   * canvas node it is. Without it a terminal can still run, but nothing inside it can talk back to
   * the runtime. Omitted in tests that do not exercise the bridge.
   */
  readonly cliBridge?: {
    /** Directory holding the installed `compazio` command; prepended to the session PATH. */
    readonly binDirectory: string;
  };
  /**
   * Stages notes/attachments connected to a terminal node into a per-session inputs folder and
   * builds the prompt typed into the PTY at spawn. Omitted for plain shell terminals, which have
   * no agent to read a prompt.
   */
  readonly contextStaging?: {
    stage(input: {
      readonly workspaceId: string;
      readonly nodeId: string;
      readonly projectRoot: string;
      readonly sessionId: string;
    }): StagedTerminalContext | TerminalContextUnavailable;
  };
  readonly agentEndpoints?: {
    assertEndpoint?(input: {
      readonly workspaceId: string;
      readonly nodeId: string;
      readonly projectId: string;
      readonly adapterId: TerminalCreateRequest["adapterId"];
    }): void;
    bindEndpoint(input: {
      readonly workspaceId: string;
      readonly nodeId: string;
      readonly projectId: string;
      readonly sessionId: string;
      readonly adapterId: TerminalCreateRequest["adapterId"];
    }): void;
  };
  readonly agentIdentities?: {
    ensureAgentIdentity(input: { readonly workspaceId: string; readonly nodeId: string }): void;
  };
}

export function registerTerminalIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  services: TerminalIpcServices
): void {
  register(ipc, TERMINAL_CREATE_CHANNEL, async (payload) =>
    createTerminalSession(terminalCreateRequestSchema.parse(payload), services)
  );
  register(ipc, TERMINAL_LIST_CHANNEL, async (payload) => {
    assertNoPayload(payload);
    const sessions = services.supervisor
      .listSessions()
      .filter((session) => services.sessionAccess?.get(session.id) !== null);
    return terminalListResponseSchema.parse(
      sessions.map((session) => toTerminalSession(session, services.sessionAccess?.get(session.id)))
    );
  });
  register(ipc, TERMINAL_BUFFER_CHANNEL, async (payload) => {
    const request = terminalSessionRequestSchema.parse(payload);
    assertRendererSessionAccess(request.sessionId, services.sessionAccess);
    const snapshot = services.supervisor.getBufferSnapshot(request.sessionId);
    return terminalBufferResponseSchema.parse({
      data: redactTerminalText(snapshot.data),
      sequence: snapshot.sequence
    });
  });
  register(ipc, TERMINAL_WRITE_CHANNEL, async (payload) => {
    const request = terminalWriteRequestSchema.parse(payload);
    assertRendererSessionAccess(request.sessionId, services.sessionAccess);
    if (services.sessionAccess?.get(request.sessionId)?.readOnly === true) {
      throw new Error("Official workflow output is read-only while the agent is running");
    }
    await services.supervisor.write(request.sessionId, request.data);
    return undefined;
  });
  register(ipc, TERMINAL_RESIZE_CHANNEL, async (payload) => {
    const request = terminalResizeRequestSchema.parse(payload);
    assertRendererSessionAccess(request.sessionId, services.sessionAccess);
    services.supervisor.resize(request.sessionId, request.cols, request.rows);
    return undefined;
  });
  register(ipc, TERMINAL_CLEAR_CHANNEL, async (payload) => {
    const request = terminalSessionRequestSchema.parse(payload);
    assertRendererSessionAccess(request.sessionId, services.sessionAccess);
    services.supervisor.clearBuffer(request.sessionId);
    return undefined;
  });
  register(ipc, TERMINAL_CANCEL_CHANNEL, async (payload) => {
    const request = terminalSessionRequestSchema.parse(payload);
    assertRendererSessionAccess(request.sessionId, services.sessionAccess);
    return terminalSessionSchema.parse(
      toTerminalSession(
        await services.supervisor.cancel(request.sessionId),
        services.sessionAccess?.get(request.sessionId)
      )
    );
  });
}

export async function createTerminalSession(
  request: TerminalCreateRequest,
  services: TerminalIpcServices
): Promise<TerminalSession> {
  const project = await services.projects.get(request.projectId);
  if (project === null) {
    throw new Error("The selected project is no longer available. Reopen it from Workspaces.");
  }
  const maximumSessions = services.maxActiveSessionsPerProject ?? 8;
  const activeForProject = services.supervisor
    .listSessions()
    .filter(
      (session) =>
        !["succeeded", "failed", "cancelled", "interrupted"].includes(session.state) &&
        services.sessionAccess?.belongsToProject(session.id, request.projectId) === true
    ).length;
  if (activeForProject >= maximumSessions) {
    throw new Error("This project has reached its active terminal limit");
  }

  // Endpoint binding requires a persisted agent node. Verify it before starting a process so an
  // invalid or stale canvas reference cannot briefly launch an orphan terminal session.
  if (request.endpoint !== undefined) {
    services.agentEndpoints?.assertEndpoint?.({
      ...request.endpoint,
      projectId: request.projectId,
      adapterId: request.adapterId
    });
  }

  const adapter = resolveAdapter(request.adapterId, services.adapters);
  const context = {
    platform: services.platform,
    environment: services.environment,
    cwd: project.canonicalRootPath,
    detector: services.detector,
    commandRunner: services.commandRunner
  };
  const functionalStatus = await new AgentBridge(services.adapters).status(
    request.adapterId,
    context
  );
  if (!functionalStatus.available) {
    const issue = functionalStatus.issue;
    throw new Error(
      issue === null
        ? `${adapter.manifest.displayName} is not available on this machine.`
        : `${issue.message} ${issue.remediation}`
    );
  }
  const detection = await adapter.detect(context);
  if (!detection.available || detection.executable === null) {
    throw new Error(`${adapter.manifest.displayName} could not be prepared for this session.`);
  }

  // Generated up front (rather than inside supervisor.start) so the per-session staging
  // directory can be named after it before the process exists.
  const sessionId = (services.createSessionId ?? randomUUID)();
  let initialMessage: { readonly id: string; readonly content: string } | undefined;
  if (request.endpoint !== undefined && request.adapterId !== "shell") {
    const staged = services.contextStaging?.stage({
      workspaceId: request.endpoint.workspaceId,
      nodeId: request.endpoint.nodeId,
      projectRoot: project.canonicalRootPath,
      sessionId
    });
    if (staged !== undefined) {
      if (!staged.ok) {
        throw new Error(staged.reason);
      }
      // A role alone is worth sending: an agent told it is the Reviewer behaves differently from
      // the same agent told nothing, even with no material connected yet. An orchestrator with
      // neither is worth sending too — the team surface is the whole reason it exists.
      if (
        staged.role !== undefined ||
        grantsTeamOrchestration(staged.permissions) ||
        staged.notes.length > 0 ||
        staged.attachments.length > 0 ||
        staged.links.length > 0
      ) {
        initialMessage = { id: randomUUID(), content: buildTerminalContextPrompt(staged) };
      }
    }
  }

  const bridge = buildBridgeEnvironment(request, services, sessionId);
  const launch = await adapter.buildLaunch({
    executable: detection.executable,
    cwd: project.canonicalRootPath,
    environment: bridge.environment,
    mode: "interactive",
    workspaceAccess: "workspace-write",
    cols: request.cols,
    rows: request.rows,
    ...(initialMessage === undefined ? {} : { initialMessage })
  });
  const session = await services.supervisor.start({
    sessionId,
    adapterId: request.adapterId,
    launch,
    allowedCwdRoots: [project.canonicalRootPath],
    additionalAllowedEnvKeys: bridge.allowedEnvKeys
  });
  if (request.endpoint !== undefined) {
    try {
      services.agentIdentities?.ensureAgentIdentity({
        workspaceId: request.endpoint.workspaceId,
        nodeId: request.endpoint.nodeId
      });
      services.agentEndpoints?.bindEndpoint({
        ...request.endpoint,
        projectId: request.projectId,
        sessionId: session.id,
        adapterId: request.adapterId
      });
    } catch (error: unknown) {
      await services.supervisor.cancel(session.id);
      throw error;
    }
  }
  const access = {
    projectId: request.projectId,
    adapterId: request.adapterId,
    ...(request.endpoint === undefined
      ? {}
      : {
          workspaceId: request.endpoint.workspaceId,
          canvasNodeId: request.endpoint.nodeId
        })
  };
  services.sessionAccess?.bind(session.id, access);
  return terminalSessionSchema.parse(toTerminalSession(session, access));
}

export function sanitizeTerminalEvent(
  event: ProcessSupervisorEvent,
  access?: TerminalIpcServices["sessionAccess"]
): TerminalEvent {
  switch (event.type) {
    case "session.state":
      return terminalEventSchema.parse({
        type: event.type,
        session: toTerminalSession(event.session, access?.get(event.session.id))
      });
    case "session.output":
      return terminalEventSchema.parse({ ...event, data: redactTerminalText(event.data) });
    case "session.error":
      return terminalEventSchema.parse({ ...event, message: redactText(event.message) });
  }
}

function resolveAdapter(adapterId: string, adapters: TerminalAdapterResolver): AgentAdapter {
  try {
    return adapters.get(adapterId);
  } catch {
    throw new Error(
      `The ${adapterId} adapter is not available in this build. Reinstall the desktop app.`
    );
  }
}

function toTerminalSession(
  session: ProcessSessionSnapshot,
  access?: ReturnType<NonNullable<TerminalIpcServices["sessionAccess"]>["get"]>
): TerminalSession {
  return terminalSessionSchema.parse({
    id: session.id,
    adapterId: access?.adapterId ?? session.adapterId,
    state: session.state,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    ...(access?.workspaceId === undefined ? {} : { workspaceId: access.workspaceId }),
    ...(access?.canvasNodeId === undefined ? {} : { canvasNodeId: access.canvasNodeId }),
    ...(access?.workflow === undefined
      ? {}
      : {
          workflowRunId: access.workflow.runId,
          workflowNodeId: access.workflow.nodeId,
          workflowAttempt: access.workflow.attempt
        }),
    readOnly: access?.readOnly ?? false
  });
}

/** Environment keys the bridge adds. Each must be declared so the launch allowlist admits it. */
export const COMPAZIO_TERMINAL_ID_ENV = "COMPAZIO_TERMINAL_ID";
export const COMPAZIO_WORKSPACE_ID_ENV = "COMPAZIO_WORKSPACE_ID";
export const COMPAZIO_SESSION_ID_ENV = "COMPAZIO_SESSION_ID";

/**
 * Builds what a session needs to reach the runtime from inside itself: the `compazio` command on
 * PATH, and the identity of the canvas node it is running as.
 *
 * `COMPAZIO_TERMINAL_ID` carries the canvas node id, not the process session id, because the node is
 * the stable identity a connection, a role and a message are addressed to; the session id is only
 * useful for correlating one process run. This identity is structural — it tells an agent who it is,
 * and is not an authentication boundary between processes of the same local profile (see
 * `docs/23-current-capabilities.md`). Authorization stays with the Policy Engine.
 *
 * A plain shell terminal gets the same treatment: a person typing in it benefits from the command
 * just as much, and a shell has no canvas identity to leak.
 */
function buildBridgeEnvironment(
  request: TerminalCreateRequest,
  services: TerminalIpcServices,
  sessionId: string
): {
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedEnvKeys: readonly string[];
} {
  const base = compactEnvironment(services.environment);
  if (services.cliBridge === undefined) {
    return { environment: base, allowedEnvKeys: [] };
  }
  const identity: Record<string, string> = { ...base, [COMPAZIO_SESSION_ID_ENV]: sessionId };
  if (request.endpoint !== undefined) {
    identity[COMPAZIO_TERMINAL_ID_ENV] = request.endpoint.nodeId;
    identity[COMPAZIO_WORKSPACE_ID_ENV] = request.endpoint.workspaceId;
  }
  return {
    // Prepended, not replaced: the agent's own toolchain must stay reachable.
    environment: prependToPath(identity, services.cliBridge.binDirectory, services.platform),
    allowedEnvKeys: [COMPAZIO_TERMINAL_ID_ENV, COMPAZIO_WORKSPACE_ID_ENV, COMPAZIO_SESSION_ID_ENV]
  };
}

function compactEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => Promise<unknown>
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}

function assertNoPayload(payload: unknown): void {
  if (payload !== undefined) {
    throw new Error("This terminal IPC channel does not accept a payload");
  }
}

function assertRendererSessionAccess(
  sessionId: string,
  access: TerminalIpcServices["sessionAccess"]
): void {
  if (access !== undefined && access.get(sessionId) === null) {
    throw new Error("Terminal session is not available to the renderer");
  }
}
