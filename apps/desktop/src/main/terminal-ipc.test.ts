import { describe, expect, it, vi } from "vitest";

import type {
  AgentAdapter,
  CommandRunner,
  ExecutableDetector,
  LaunchInput
} from "@forgedeck/agent-sdk";
import type { GitProject } from "@forgedeck/git";
import type { StartProcessSessionInput } from "@forgedeck/terminal";

import { createTerminalSession, registerTerminalIpc, sanitizeTerminalEvent } from "./terminal-ipc";
import type { TerminalIpcServices } from "./terminal-ipc";
import type { StagedTerminalContext } from "./terminal-context-staging";

const projectId = "d092aaa1-7eaf-4e98-9fa4-76f688df121c";
const sessionId = "a0c0bab2-8eaf-4e98-9fa4-76f688df121c";
const project: GitProject = {
  id: projectId,
  name: "Safe project",
  rootPath: "C:\\Projects\\Safe project",
  canonicalRootPath: "C:\\Projects\\Safe project",
  defaultBranch: "main",
  headCommit: "a".repeat(40),
  createdAt: "2026-07-17T16:00:00.000Z",
  updatedAt: "2026-07-17T16:00:00.000Z"
};

describe("terminal IPC service", () => {
  it("opens the selected agent directly in an approved local PTY", async () => {
    let startInput: StartProcessSessionInput | null = null;
    let launchInput: LaunchInput | null = null;
    const adapter = createAdapter((input) => {
      launchInput = input;
    });
    const sessionAccess = {
      bind: vi.fn(),
      get: vi.fn().mockReturnValue(null),
      belongsToProject: vi.fn().mockReturnValue(false)
    };
    const agentEndpoints = { bindEndpoint: vi.fn() };
    const agentIdentities = { ensureAgentIdentity: vi.fn() };
    const services = {
      ...createServices(adapter, (input) => {
        startInput = input;
      }),
      sessionAccess,
      agentEndpoints,
      agentIdentities
    };

    const session = await createTerminalSession(
      {
        projectId,
        adapterId: "claude-code",
        endpoint: { workspaceId: "workspace-1", nodeId: "planner" },
        cols: 132,
        rows: 42
      },
      services
    );

    expect(session).toMatchObject({
      id: sessionId,
      adapterId: "claude-code",
      state: "running",
      workspaceId: "workspace-1",
      canvasNodeId: "planner"
    });
    expect(launchInput).toMatchObject({
      cwd: project.canonicalRootPath,
      mode: "interactive",
      workspaceAccess: "workspace-write",
      cols: 132,
      rows: 42
    });
    expect(startInput).toMatchObject({
      sessionId,
      adapterId: "claude-code",
      allowedCwdRoots: [project.canonicalRootPath],
      launch: {
        executable: { path: "C:\\Program Files\\ForgeDeck\\claude.exe", kind: "native" },
        args: ["--interactive"],
        cwd: project.canonicalRootPath
      }
    });
    expect(sessionAccess.bind).toHaveBeenCalledWith(sessionId, {
      projectId,
      adapterId: "claude-code",
      workspaceId: "workspace-1",
      canvasNodeId: "planner"
    });
    expect(agentEndpoints.bindEndpoint).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodeId: "planner",
      projectId,
      sessionId,
      adapterId: "claude-code"
    });
    expect(agentIdentities.ensureAgentIdentity).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodeId: "planner"
    });
  });

  it("requires the selected adapter for every interactive terminal preset", async () => {
    const services = createServices(createAdapter(), () => undefined, {
      get: () => {
        throw new Error("missing");
      }
    });

    await expect(
      createTerminalSession({ projectId, adapterId: "codex", cols: 120, rows: 30 }, services)
    ).rejects.toThrow("codex adapter is not available");
  });

  it("validates a canvas endpoint before spawning its terminal process", async () => {
    let startInput: StartProcessSessionInput | null = null;
    const agentEndpoints = {
      assertEndpoint: vi.fn(() => {
        throw new Error("Message recipient is not an agent");
      }),
      bindEndpoint: vi.fn()
    };
    const services = {
      ...createServices(createAdapter(), (input) => {
        startInput = input;
      }),
      agentEndpoints
    };

    await expect(
      createTerminalSession(
        {
          projectId,
          adapterId: "codex",
          endpoint: { workspaceId: "workspace-1", nodeId: "missing-agent" },
          cols: 120,
          rows: 30
        },
        services
      )
    ).rejects.toThrow("Message recipient is not an agent");

    expect(agentEndpoints.assertEndpoint).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodeId: "missing-agent",
      projectId,
      adapterId: "codex"
    });
    expect(startInput).toBeNull();
    expect(agentEndpoints.bindEndpoint).not.toHaveBeenCalled();
  });

  it("refuses a new terminal when the project quota is already active", async () => {
    const services: TerminalIpcServices = {
      ...createServices(createAdapter(), () => undefined),
      maxActiveSessionsPerProject: 1,
      sessionAccess: { bind: vi.fn(), get: () => null, belongsToProject: () => true },
      supervisor: {
        ...createServices(createAdapter(), () => undefined).supervisor,
        listSessions: () => [
          {
            id: "a0c0bab2-8eaf-4e98-9fa4-76f688df121c",
            adapterId: "codex",
            state: "running",
            processId: 100,
            startedAt: "2026-07-17T16:00:00.000Z",
            endedAt: null,
            exitCode: null,
            exitSignal: null
          }
        ]
      }
    };
    await expect(
      createTerminalSession({ projectId, adapterId: "codex", cols: 120, rows: 30 }, services)
    ).rejects.toThrow("active terminal limit");
  });

  it("does not launch an adapter that fails its functional authentication check", async () => {
    const adapter = createAdapter();
    adapter.validateAuth = async () => ({
      authenticated: false,
      issue: {
        code: "adapter_auth_unavailable",
        message: "Claude Code is not authenticated",
        remediation: "Sign in first."
      }
    });
    const services = createServices(adapter, () => undefined);

    await expect(
      createTerminalSession({ projectId, adapterId: "claude-code", cols: 120, rows: 30 }, services)
    ).rejects.toThrow("Claude Code is not authenticated");
  });

  it("does not queue a command for a plain terminal", async () => {
    let startInput: StartProcessSessionInput | null = null;
    const services = createServices(createAdapter(), (input) => {
      startInput = input;
    });

    await createTerminalSession({ projectId, adapterId: "shell", cols: 100, rows: 28 }, services);

    const captured = startInput as StartProcessSessionInput | null;
    expect(captured?.launch.initialInput).toBeUndefined();
  });

  it("fails before spawning when an agent CLI cannot be validated", async () => {
    let startInput: StartProcessSessionInput | null = null;
    const shell = createAdapter();
    const unavailable = {
      ...createAdapter(),
      detect: async () => ({
        available: false as const,
        executable: null,
        version: null,
        issue: {
          code: "adapter_executable_not_found" as const,
          message: "missing",
          remediation: "repair it"
        }
      })
    } satisfies AgentAdapter;
    const services = createServices(
      shell,
      (input) => {
        startInput = input;
      },
      {
        get: (adapterId) => (adapterId === "shell" ? shell : unavailable)
      }
    );

    await expect(
      createTerminalSession({ projectId, adapterId: "claude-code", cols: 100, rows: 28 }, services)
    ).rejects.toThrow("missing repair it");

    const captured = startInput as StartProcessSessionInput | null;
    expect(captured).toBeNull();
  });

  it("starts Codex directly instead of injecting a command into a shell", async () => {
    let startInput: StartProcessSessionInput | null = null;
    const shell = createAdapter();
    const codex = {
      ...createAdapter(),
      detect: async () => ({
        available: true as const,
        executable: { path: "C:\\Tools\\codex.cmd", kind: "command-shim" as const },
        version: "1",
        issue: null
      })
    } satisfies AgentAdapter;
    const services = createServices(
      shell,
      (input) => {
        startInput = input;
      },
      { get: (adapterId) => (adapterId === "shell" ? shell : codex) }
    );

    await createTerminalSession({ projectId, adapterId: "codex", cols: 100, rows: 28 }, services);

    const captured = startInput as StartProcessSessionInput | null;
    expect(captured?.launch).toMatchObject({
      executable: { path: "C:\\Tools\\codex.cmd", kind: "command-shim" },
      args: ["--interactive"]
    });
    expect(captured?.launch.initialInput).toBeUndefined();
  });

  it("blocks starting the terminal when connected materials cannot be staged", async () => {
    let startInput: StartProcessSessionInput | null = null;
    const stage = vi.fn(() => ({
      ok: false as const,
      reason: "Materiais indisponíveis: foto.png"
    }));
    const services = {
      ...createServices(createAdapter(), (input) => {
        startInput = input;
      }),
      contextStaging: { stage }
    };

    await expect(
      createTerminalSession(
        {
          projectId,
          adapterId: "claude-code",
          endpoint: { workspaceId: "workspace-1", nodeId: "planner" },
          cols: 120,
          rows: 30
        },
        services
      )
    ).rejects.toThrow("Materiais indisponíveis: foto.png");

    expect(stage).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodeId: "planner",
      projectRoot: project.canonicalRootPath,
      sessionId
    });
    expect(startInput).toBeNull();
  });

  it("injects the prepared context prompt into the freshly spawned terminal", async () => {
    let capturedInitialMessage: LaunchInput["initialMessage"];
    const adapter: AgentAdapter = createAdapter((input) => {
      capturedInitialMessage = input.initialMessage;
    });
    const stage = vi.fn((): StagedTerminalContext => ({
      ok: true,
      sessionId,
      nodeId: "terminal-1",
      permissions: [],
      mission: "Lançar a landing page",
      notes: [{ nodeId: "note-1", title: "Briefing", content: "Use tom direto." }],
      links: [],
      attachments: [],
      inputsDirectory: "C:\\Projects\\Safe project\\.compazio\\runs\\a0c0bab2\\inputs",
      manifestPath: "C:\\Projects\\Safe project\\.compazio\\runs\\a0c0bab2\\context-manifest.json"
    }));
    const services: TerminalIpcServices = {
      ...createServices(adapter, () => undefined),
      contextStaging: { stage }
    };

    await createTerminalSession(
      {
        projectId,
        adapterId: "claude-code",
        endpoint: { workspaceId: "workspace-1", nodeId: "planner" },
        cols: 120,
        rows: 30
      },
      services
    );

    expect(capturedInitialMessage?.content).toContain("Use tom direto.");
    expect(capturedInitialMessage?.content).toContain("Lançar a landing page");
  });

  it("puts the compazio command on PATH and tells the session which canvas node it is", async () => {
    let launchEnvironment: LaunchInput["environment"] | null = null;
    const started: StartProcessSessionInput[] = [];
    const adapter = createAdapter((input) => {
      launchEnvironment = input.environment;
    });
    const services: TerminalIpcServices = {
      ...createServices(adapter, (input) => started.push(input)),
      cliBridge: { binDirectory: "C:\\Users\\dev\\AppData\\Local\\Compazio\\bin" }
    };

    await createTerminalSession(
      {
        projectId,
        adapterId: "claude-code",
        endpoint: { workspaceId: "workspace-1", nodeId: "planner" },
        cols: 120,
        rows: 30
      },
      services
    );

    const environment = launchEnvironment as unknown as Record<string, string>;
    // Prepended, so `compazio` wins, and the agent's own toolchain stays reachable.
    expect(environment.PATH).toBe(
      "C:\\Users\\dev\\AppData\\Local\\Compazio\\bin;C:\\Windows\\System32"
    );
    // The canvas node id, not the process session id: that is the identity a message, a role and a
    // connection are addressed to.
    expect(environment.COMPAZIO_TERMINAL_ID).toBe("planner");
    expect(environment.COMPAZIO_WORKSPACE_ID).toBe("workspace-1");
    expect(environment.COMPAZIO_SESSION_ID).toBe(sessionId);
    // Declared, or the launch allowlist would reject the session before it starts.
    expect(started[0]?.additionalAllowedEnvKeys).toEqual([
      "COMPAZIO_TERMINAL_ID",
      "COMPAZIO_WORKSPACE_ID",
      "COMPAZIO_SESSION_ID"
    ]);
  });

  it("gives a shell terminal the command without a canvas identity it does not have", async () => {
    let launchEnvironment: LaunchInput["environment"] | null = null;
    const adapter = createAdapter((input) => {
      launchEnvironment = input.environment;
    });
    const services: TerminalIpcServices = {
      ...createServices(adapter, () => undefined, { get: () => adapter }),
      cliBridge: { binDirectory: "/home/dev/.compazio/bin" },
      platform: "linux",
      environment: { PATH: "/usr/bin" }
    };

    await createTerminalSession({ projectId, adapterId: "shell", cols: 120, rows: 30 }, services);

    const environment = launchEnvironment as unknown as Record<string, string>;
    expect(environment.PATH).toBe("/home/dev/.compazio/bin:/usr/bin");
    expect(environment.COMPAZIO_SESSION_ID).toBe(sessionId);
    expect(environment.COMPAZIO_TERMINAL_ID).toBeUndefined();
    expect(environment.COMPAZIO_WORKSPACE_ID).toBeUndefined();
  });

  it("leaves the environment untouched when no bridge is configured", async () => {
    let launchEnvironment: LaunchInput["environment"] | null = null;
    const adapter = createAdapter((input) => {
      launchEnvironment = input.environment;
    });

    await createTerminalSession(
      {
        projectId,
        adapterId: "claude-code",
        endpoint: { workspaceId: "workspace-1", nodeId: "planner" },
        cols: 120,
        rows: 30
      },
      createServices(adapter, () => undefined)
    );

    expect(launchEnvironment as unknown as Record<string, string>).toEqual({
      PATH: "C:\\Windows\\System32"
    });
  });

  it("never stages context for a plain shell terminal", async () => {
    const stage = vi.fn(() => ({ ok: true as const, reason: "" }) as never);
    const services = {
      ...createServices(createAdapter(), () => undefined),
      contextStaging: { stage }
    };

    await createTerminalSession(
      {
        projectId,
        adapterId: "shell",
        endpoint: { workspaceId: "workspace-1", nodeId: "planner" },
        cols: 120,
        rows: 30
      },
      services
    );

    expect(stage).not.toHaveBeenCalled();
  });

  it("redacts marked secrets before terminal events leave the main process", () => {
    const secret = "FORGEDECK_TEST_SECRET_terminal-event";
    const cursorControls = "\u001b[?25l\b\u001b[6;58H";

    const event = sanitizeTerminalEvent({
      type: "session.output",
      sessionId,
      sequence: 1,
      data: `${cursorControls}value ${secret}`,
      timestamp: "2026-07-17T16:00:00.000Z"
    });

    expect(JSON.stringify(event)).not.toContain(secret);
    expect(event).toMatchObject({
      type: "session.output",
      data: `${cursorControls}value [REDACTED]`
    });
  });

  it("does not expose internal workflow sessions through terminal IPC", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const getBufferSnapshot = vi.fn();
    const services: TerminalIpcServices = {
      ...createServices(createAdapter(), () => undefined),
      supervisor: {
        ...createServices(createAdapter(), () => undefined).supervisor,
        listSessions: () => [
          {
            id: sessionId,
            adapterId: "workflow-shell",
            state: "running",
            processId: 100,
            startedAt: "2026-07-17T16:00:00.000Z",
            endedAt: null,
            exitCode: null,
            exitSignal: null
          }
        ],
        getBufferSnapshot
      },
      sessionAccess: { bind: vi.fn(), get: () => null, belongsToProject: () => false }
    };
    registerTerminalIpc(
      {
        removeHandler: (channel) => handlers.delete(channel),
        handle: (channel, handler) => handlers.set(channel, handler as never)
      },
      services
    );

    await expect(handlers.get("terminal:list")?.({}, undefined)).resolves.toEqual([]);
    await expect(handlers.get("terminal:buffer")?.({}, { sessionId })).rejects.toThrow(
      "not available to the renderer"
    );
    expect(getBufferSnapshot).not.toHaveBeenCalled();
  });

  it("exposes an explicitly bound workflow worker as a read-only node terminal", () => {
    const workflowSessionId = "workflow-agent-run-1-agent-codex-1";
    const access = {
      bind: vi.fn(),
      get: vi.fn().mockReturnValue({
        projectId,
        adapterId: "codex",
        workspaceId: "workspace-1",
        canvasNodeId: "agent-codex",
        workflow: { runId: "run-1", nodeId: "agent-codex", attempt: 1 },
        readOnly: true
      }),
      belongsToProject: vi.fn()
    };
    const event = sanitizeTerminalEvent(
      {
        type: "session.state",
        session: {
          id: workflowSessionId,
          adapterId: "agent:codex",
          state: "running",
          processId: 100,
          startedAt: "2026-07-17T16:00:00.000Z",
          endedAt: null,
          exitCode: null,
          exitSignal: null
        }
      },
      access
    );

    expect(event).toMatchObject({
      type: "session.state",
      session: {
        id: workflowSessionId,
        adapterId: "codex",
        workspaceId: "workspace-1",
        canvasNodeId: "agent-codex",
        workflowRunId: "run-1",
        workflowNodeId: "agent-codex",
        workflowAttempt: 1,
        readOnly: true
      }
    });
  });
});

function createServices(
  adapter: AgentAdapter,
  onStart: (input: StartProcessSessionInput) => void,
  adapters: { readonly get: (adapterId: string) => AgentAdapter } = { get: () => adapter }
): TerminalIpcServices {
  return {
    supervisor: {
      start: async (input) => {
        onStart(input);
        return {
          id: input.sessionId,
          adapterId: input.adapterId,
          state: "running",
          processId: 100,
          startedAt: "2026-07-17T16:00:00.000Z",
          endedAt: null,
          exitCode: null,
          exitSignal: null
        };
      },
      listSessions: () => [],
      getBufferSnapshot: () => ({ data: "", sequence: 0 }),
      write: async () => undefined,
      resize: () => undefined,
      clearBuffer: () => undefined,
      cancel: async () => {
        throw new Error("not used");
      }
    },
    projects: { get: async () => project },
    adapters,
    detector: createDetector(),
    commandRunner: createCommandRunner(),
    environment: { PATH: "C:\\Windows\\System32" },
    platform: "win32",
    createSessionId: () => sessionId
  };
}

function createAdapter(onLaunch?: (input: LaunchInput) => void): AgentAdapter {
  return {
    manifest: {
      id: "claude-code",
      displayName: "Claude Code",
      version: "1",
      executables: ["claude"],
      platforms: ["win32", "darwin", "linux"],
      capabilities: {
        interactive: true,
        nonInteractive: true,
        resume: true,
        structuredOutput: true,
        mcp: true,
        imageInput: true,
        messageQueue: true
      },
      permissions: ["workspace-process"]
    },
    detect: async () => ({
      available: true,
      executable: { path: "C:\\Program Files\\ForgeDeck\\claude.exe", kind: "native" },
      version: "1",
      issue: null
    }),
    validateAuth: async () => ({ authenticated: true, issue: null }),
    buildLaunch: async (input) => {
      onLaunch?.(input);
      return {
        executable: input.executable,
        args: ["--interactive"],
        cwd: input.cwd,
        environment: input.environment,
        cols: input.cols ?? 120,
        rows: input.rows ?? 30
      };
    },
    parseOutput: (chunk, state) => ({ outputs: [{ kind: "text", data: chunk.data }], state }),
    encodeMessage: (message) => message.content,
    sendMessage: async () => undefined,
    isReadyForReviewedHandoff: () => true,
    submitReviewedHandoff: async () => ({ confirmation: "response_detected", responseSequence: 1 }),
    requestStop: async () => undefined,
    forceKill: async () => undefined
  };
}

function createDetector(): ExecutableDetector {
  return { find: async () => null };
}

function createCommandRunner(): CommandRunner {
  return { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) };
}
