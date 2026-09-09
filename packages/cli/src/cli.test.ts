import { describe, expect, it, vi } from "vitest";

import type {
  AgentDirectoryEntry,
  AgentWorkspace,
  WorkflowRunCommandAction,
  WorkspaceHistoryEntry
} from "@forgedeck/local-db";
import type {
  AgentMessage,
  AgentMessageResponse,
  AgentProfile,
  AgentSpawn,
  ArtifactMemory,
  ArtifactMemoryComparison,
  ArtifactImpact,
  ArtifactFeedback,
  CanvasHandoff,
  CanvasHandoffEvent,
  DeliveryContract,
  EffectiveExecutionContext,
  ExecutionCheckpoint,
  Mission,
  OrchestrationProposal,
  WorkspaceAgentContext,
  WorkspaceArtifact,
  WorkspaceConnectionCanvasEvent,
  WorkspaceMemory,
  WorkspaceNote
} from "@forgedeck/schemas";
import { defaultAutonomyConfig } from "@forgedeck/schemas";
import type { RunEvent, WorkflowRunSnapshot } from "@forgedeck/orchestration";

import { runCompassoCli } from "./cli";

const workspace: AgentWorkspace = {
  id: "workspace-1",
  canvasId: "canvas-1",
  projectId: "00000000-0000-4000-8000-000000000001",
  projectName: "Compasso",
  projectRoot: "C:\\work\\compasso",
  title: "Principal"
};

const agents = [
  {
    workspaceId: workspace.id,
    nodeId: "reviewer",
    name: "Revisor",
    roleName: "Revisor de código",
    adapterId: "codex",
    online: true,
    sessionId: "00000000-0000-4000-8000-000000000002"
  },
  {
    workspaceId: workspace.id,
    nodeId: "qa",
    name: "QA",
    roleName: "Quality assurance",
    adapterId: "claude-code",
    online: false,
    sessionId: null
  }
] as const satisfies readonly AgentDirectoryEntry[];

describe("runCompassoCli", () => {
  it("tells an agent who it is and what it is connected to, from the terminal identity alone", () => {
    const output: string[] = [];
    const cliStore = {
      ...store(),
      listConnections: vi.fn().mockReturnValue([
        {
          connectionId: "connection-1",
          canvasId: workspace.canvasId,
          sourceNodeId: "briefing",
          targetNodeId: "reviewer",
          type: "context",
          permission: "connect_context",
          label: "briefing",
          createdBy: null,
          createdAt: "2026-07-26T12:00:00.000Z",
          revision: 1
        },
        {
          connectionId: "connection-2",
          canvasId: workspace.canvasId,
          sourceNodeId: "reviewer",
          targetNodeId: "qa",
          type: "handoff",
          permission: "connect_context",
          label: null,
          createdBy: null,
          createdAt: "2026-07-26T12:00:00.000Z",
          revision: 1
        },
        {
          connectionId: "connection-3",
          canvasId: workspace.canvasId,
          sourceNodeId: "briefing",
          targetNodeId: "qa",
          type: "context",
          permission: "connect_context",
          label: null,
          createdAt: "2026-07-26T12:00:00.000Z",
          createdBy: null,
          revision: 1
        }
      ])
    };

    const result = runCompassoCli(["list"], {
      // Deliberately a subdirectory: a session identity must survive the agent running `cd`.
      cwd: "C:\\work\\compasso\\packages\\cli",
      store: cliStore,
      env: { COMPAZIO_TERMINAL_ID: "reviewer", COMPAZIO_WORKSPACE_ID: workspace.id },
      write: (line) => output.push(line)
    });

    expect(result).toBe(0);
    const text = output.join("\n");
    expect(text).toContain("Revisor de código");
    expect(text).toContain("<-\tcontext\tbriefing");
    expect(text).toContain("->\thandoff\tqa");
    // A connection between two other nodes is not this agent's business.
    expect(text).not.toContain("connection-3");
  });

  it("prefers an explicit --from over the injected terminal identity", () => {
    const output: string[] = [];

    runCompassoCli(["list", "--from", "qa"], {
      cwd: workspace.projectRoot,
      store: store(),
      env: { COMPAZIO_TERMINAL_ID: "reviewer" },
      write: (line) => output.push(line)
    });

    expect(output.join("\n")).toContain("Quality assurance");
  });

  it("explains itself when run outside an agent terminal and given no --from", () => {
    expect(() =>
      runCompassoCli(["list"], {
        cwd: workspace.projectRoot,
        store: store(),
        write: () => undefined
      })
    ).toThrow("no Compazio identity");
  });

  it("blocks until the recipient answers, then prints the reply", () => {
    const output: string[] = [];
    const responses: AgentMessageResponse[] = [];
    const cliStore = {
      ...store(),
      enqueue: vi.fn().mockReturnValue(message(3, "qa")),
      // The answer only lands on the third poll: proof this waits for a correlated response
      // instead of reading whatever happened to be there when the command started.
      listResponses: vi.fn(() => responses)
    };
    let slept = 0;
    let clock = 0;

    const result = runCompassoCli(["ask", "qa", "Revise o login", "--from", "reviewer", "--wait"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line),
      clock: {
        now: () => clock,
        sleep: (milliseconds) => {
          slept += 1;
          clock += milliseconds;
          if (slept === 2) responses.push(response());
        }
      }
    });

    expect(result).toBe(0);
    expect(slept).toBe(2);
    expect(output.join("\n")).toContain("Encontrei dois problemas.");
  });

  it("stops waiting the moment a delivery fails, instead of burning the timeout", () => {
    const cliStore = {
      ...store(),
      enqueue: vi.fn().mockReturnValue(message(3, "qa")),
      listResponses: vi.fn().mockReturnValue([]),
      getMessage: vi.fn().mockReturnValue({
        ...message(3, "qa"),
        status: "failed",
        errorCode: "endpoint_unavailable"
      })
    };
    let slept = 0;

    expect(() =>
      runCompassoCli(["ask", "qa", "Revise o login", "--wait"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: () => undefined,
        clock: {
          now: () => 0,
          sleep: () => {
            slept += 1;
          }
        }
      })
    ).toThrow("endpoint_unavailable");
    expect(slept).toBe(0);
  });

  it("reports a timeout as still waiting, never as an empty answer", () => {
    const cliStore = {
      ...store(),
      enqueue: vi.fn().mockReturnValue(message(3, "qa")),
      listResponses: vi.fn().mockReturnValue([]),
      getMessage: vi.fn().mockReturnValue(message(3, "qa"))
    };
    let clock = 0;

    expect(() =>
      runCompassoCli(["ask", "qa", "Revise o login", "--wait", "--timeout", "2"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: () => undefined,
        clock: {
          now: () => clock,
          sleep: (milliseconds) => {
            clock += milliseconds;
          }
        }
      })
    ).toThrow("No response from qa within 2s");
  });

  it("refuses a wait that one stdout cannot honestly represent", () => {
    expect(() =>
      runCompassoCli(["ask", "--batch", "qa,reviewer", "Revisem", "--wait"], {
        cwd: workspace.projectRoot,
        store: store(),
        write: () => undefined
      })
    ).toThrow("--wait cannot be combined with --batch");

    expect(() =>
      runCompassoCli(["ask", "qa", "Revise", "--timeout", "30"], {
        cwd: workspace.projectRoot,
        store: store(),
        write: () => undefined
      })
    ).toThrow("--timeout only applies with --wait");
  });

  it("queues a dismissal for the runtime instead of pretending the CLI closed a terminal", () => {
    const output: string[] = [];
    const createLifecycleCommand = vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-0000000000c1",
      workspaceId: workspace.id,
      canvasId: workspace.canvasId,
      projectId: workspace.projectId,
      targetNodeId: "qa",
      action: "remove",
      role: null,
      requestedByNodeId: "reviewer",
      status: "queued",
      idempotencyKey: "dismiss-1",
      sessionId: null,
      errorCode: null,
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z"
    });

    const result = runCompassoCli(
      ["terminal", "remove", "qa", "--from", "reviewer", "--idempotency-key", "dismiss-1"],
      {
        cwd: workspace.projectRoot,
        store: { ...store(), createLifecycleCommand },
        write: (line) => output.push(line)
      }
    );

    expect(result).toBe(0);
    expect(createLifecycleCommand).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      targetNodeId: "qa",
      action: "remove",
      role: null,
      requestedByNodeId: "reviewer",
      idempotencyKey: "dismiss-1"
    });
    // "queued", not "removed": only the desktop runtime owns the terminal.
    expect(output.join("\n")).toContain("queued");
  });

  it("carries the whole responsibility when reassigning a role", () => {
    const createLifecycleCommand = vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-0000000000c2",
      workspaceId: workspace.id,
      canvasId: workspace.canvasId,
      projectId: workspace.projectId,
      targetNodeId: "qa",
      action: "assign_role",
      role: null,
      requestedByNodeId: null,
      status: "queued",
      idempotencyKey: "assign-1",
      sessionId: null,
      errorCode: null,
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z"
    });

    runCompassoCli(
      [
        "terminal",
        "assign-role",
        "qa",
        "--role",
        "Testador",
        "--content",
        "Escrever cobertura",
        "--role-constraints",
        "Nunca faz merge"
      ],
      {
        cwd: workspace.projectRoot,
        store: { ...store(), createLifecycleCommand },
        write: () => undefined
      }
    );

    expect(createLifecycleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assign_role",
        role: {
          name: "Testador",
          responsibilities: "Escrever cobertura",
          constraints: "Nunca faz merge",
          expectedDeliverable: "",
          completionCriteria: ""
        }
      })
    );
  });

  it("refuses a reassignment that would leave the agent told nothing", () => {
    expect(() =>
      runCompassoCli(["terminal", "assign-role", "qa", "--role", "Testador"], {
        cwd: workspace.projectRoot,
        store: store(),
        write: () => undefined
      })
    ).toThrow("--content");
  });

  it("reports each agent's terminal without claiming to know what it is doing", () => {
    const output: string[] = [];

    runCompassoCli(["agent", "status"], {
      cwd: workspace.projectRoot,
      store: store(),
      write: (line) => output.push(line)
    });

    const text = output.join("\n");
    expect(text).toContain("reviewer");
    expect(text).toContain("online");
    expect(text).toContain("qa");
    expect(text).toContain("offline");
  });

  it("reads a note from disk, where an agent may have just edited it", () => {
    const output: string[] = [];
    const readNoteContent = vi.fn(() => "# Briefing\n\nEditado pelo agente.");

    runCompassoCli(["note", "read", "Briefing"], {
      cwd: workspace.projectRoot,
      store: { ...store(), readNoteContent },
      write: (line) => output.push(line)
    });

    expect(readNoteContent).toHaveBeenCalled();
    expect(output.join("\n")).toContain("Editado pelo agente.");
  });

  it("replaces a note's whole content on write", () => {
    const writeNote = vi.fn().mockReturnValue(note());

    runCompassoCli(["note", "write", "Briefing", "conteúdo novo", "--from", "reviewer"], {
      cwd: workspace.projectRoot,
      store: { ...store(), writeNote },
      write: () => undefined
    });

    expect(writeNote).toHaveBeenCalledWith(
      expect.objectContaining({ content: "conteúdo novo", writtenByNodeId: "reviewer" })
    );
  });

  it("lists discoverable agents in the workspace selected by cwd", () => {
    const output: string[] = [];
    const result = runCompassoCli(["agents"], {
      cwd: "C:\\work\\compasso\\packages\\cli",
      store: store(),
      write: (line) => output.push(line)
    });

    expect(result).toBe(0);
    expect(output.join("\n")).toContain("reviewer");
    expect(output.join("\n")).toContain("online");
  });

  it("reads the versioned agent profile and creates detailed mission and memory versions", () => {
    const getAgentProfile = vi.fn().mockReturnValue(profile());
    const setMission = vi.fn().mockReturnValue(mission());
    const setWorkspaceMemory = vi.fn().mockReturnValue(memory());
    const profileOutput: string[] = [];
    const missionOutput: string[] = [];
    const memoryOutput: string[] = [];
    const cliStore = {
      ...store(),
      getAgentProfile,
      setMission,
      setWorkspaceMemory
    };

    expect(
      runCompassoCli(["profile", "show", "reviewer"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: (line) => profileOutput.push(line)
      })
    ).toBe(0);
    expect(getAgentProfile).toHaveBeenCalledWith(workspace.id, "reviewer");
    expect(profileOutput.join("\n")).toContain("version=1");

    expect(
      runCompassoCli(
        [
          "mission",
          "set",
          "Ship the local beta",
          "--scope",
          "runtime,canvas",
          "--constraints",
          "no cloud"
        ],
        {
          cwd: workspace.projectRoot,
          store: cliStore,
          write: (line) => missionOutput.push(line)
        }
      )
    ).toBe(0);
    expect(setMission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        objective: "Ship the local beta",
        scope: ["runtime", "canvas"],
        constraints: ["no cloud"]
      })
    );
    expect(missionOutput.join("\n")).toContain("version=1");

    expect(
      runCompassoCli(["memory", "set", "--stack", "TypeScript,SQLite", "--commands", "pnpm test"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: (line) => memoryOutput.push(line)
      })
    ).toBe(0);
    expect(setWorkspaceMemory).toHaveBeenCalledWith(
      expect.objectContaining({ stack: ["TypeScript", "SQLite"], commands: ["pnpm test"] })
    );
    expect(memoryOutput.join("\n")).toContain("version=1");
  });

  it("manages versioned artifact metadata, contracts and immutable execution checkpoints", () => {
    const setArtifactMemory = vi.fn().mockReturnValue(artifactMemory());
    const compareArtifactMemories = vi.fn().mockReturnValue(artifactMemoryComparison());
    const restoreArtifactMemory = vi.fn().mockReturnValue({
      ...artifactMemory(),
      version: 3,
      restoredFromVersion: 1
    });
    const createArtifactFeedback = vi.fn().mockReturnValue(artifactFeedback());
    const createDeliveryContract = vi.fn().mockReturnValue(deliveryContract());
    const buildExecutionContext = vi.fn().mockReturnValue(effectiveExecutionContext());
    const checkpointExecutionContext = vi.fn().mockReturnValue(executionCheckpoint());
    const cliStore = {
      ...store(),
      setArtifactMemory,
      compareArtifactMemories,
      restoreArtifactMemory,
      createArtifactFeedback,
      createDeliveryContract,
      buildExecutionContext,
      checkpointExecutionContext
    };

    expect(
      runCompassoCli(
        [
          "artifact",
          "memory",
          "set",
          artifact().id,
          "--relevance",
          "required",
          "--artifact-status",
          "active",
          "--relationships",
          "00000000-0000-4000-8000-000000000015:supports"
        ],
        { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
      )
    ).toBe(0);
    expect(setArtifactMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        artifactId: artifact().id,
        relevance: "required",
        relationships: [{ artifactId: "00000000-0000-4000-8000-000000000015", kind: "supports" }]
      })
    );

    expect(
      runCompassoCli(["artifact", "memory", "compare", artifact().id, "1", "2", "--json"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: vi.fn()
      })
    ).toBe(0);
    expect(compareArtifactMemories).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      artifactId: artifact().id,
      baseVersion: 1,
      targetVersion: 2
    });

    expect(
      runCompassoCli(["artifact", "memory", "restore", artifact().id, "1"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: vi.fn()
      })
    ).toBe(0);
    expect(restoreArtifactMemory).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      artifactId: artifact().id,
      sourceVersion: 1
    });

    const memoryOutput: string[] = [];
    expect(
      runCompassoCli(["artifact", "memory", "show", artifact().id, "--json"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: (line) => memoryOutput.push(line)
      })
    ).toBe(0);
    expect(memoryOutput.join("\n")).not.toContain("reports/test-report.json");

    expect(
      runCompassoCli(
        ["artifact", "feedback", "create", artifact().id, "1", "Add a regression test"],
        { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
      )
    ).toBe(0);
    expect(createArtifactFeedback).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      artifactId: artifact().id,
      artifactVersion: 1,
      content: "Add a regression test"
    });

    expect(
      runCompassoCli(
        [
          "contract",
          "create",
          "reviewer",
          "qa",
          "--inputs",
          "implementation",
          "--outputs",
          "review",
          "--criteria",
          "tests-pass",
          "--evidence",
          "test:pnpm test"
        ],
        { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
      )
    ).toBe(0);
    expect(createDeliveryContract).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceNodeId: "reviewer",
        targetNodeId: "qa",
        declaredEvidence: [{ kind: "test", reference: "pnpm test" }]
      })
    );

    expect(
      runCompassoCli(
        [
          "context",
          "build",
          "reviewer",
          "--task",
          "Review the change",
          "--context-mode",
          "economical",
          "--contract",
          deliveryContract().id
        ],
        { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
      )
    ).toBe(0);
    expect(buildExecutionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentNodeId: "reviewer",
        task: "Review the change",
        contextMode: "economical"
      })
    );

    expect(
      runCompassoCli(
        [
          "checkpoint",
          "create",
          "function",
          "reviewer",
          "--task",
          "Review the change",
          "--contract",
          deliveryContract().id
        ],
        { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
      )
    ).toBe(0);
    expect(checkpointExecutionContext).toHaveBeenCalledWith(
      expect.objectContaining({ type: "function", agentNodeId: "reviewer" })
    );
  });

  it("inspects a safe impact graph from the artifact selected by ID or name", () => {
    const getArtifactImpact = vi.fn().mockReturnValue(artifactImpact());
    const output: string[] = [];

    expect(
      runCompassoCli(["impact", "test-report.json", "--json"], {
        cwd: workspace.projectRoot,
        store: { ...store(), getArtifactImpact },
        write: (line) => output.push(line)
      })
    ).toBe(0);

    expect(getArtifactImpact).toHaveBeenCalledWith(workspace.id, artifact().id);
    expect(output.join("\n")).toContain('"affectedArtifactIds"');
    expect(output.join("\n")).not.toContain("reports/test-report.json");
  });

  it("resolves a role alias and queues an idempotent ask", () => {
    const enqueue = vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-000000000003",
      status: "queued"
    });
    const result = runCompassoCli(
      ["ask", "Revisor de código", "Revise a autenticação.", "--idempotency-key", "auth-review-1"],
      {
        cwd: workspace.projectRoot,
        store: store(enqueue),
        write: vi.fn()
      }
    );

    expect(result).toBe(0);
    expect(enqueue).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      recipientNodeId: "reviewer",
      senderNodeId: null,
      content: "Revise a autenticação.",
      idempotencyKey: "auth-review-1",
      // Without --wait nobody is blocked on the answer, so it is delivered normally.
      awaitedBySender: false
    });
  });

  it("records the structural sender selected with --from", () => {
    const enqueue = vi.fn().mockReturnValue(message(3, "reviewer"));
    runCompassoCli(["ask", "reviewer", "Revise.", "--from", "qa"], {
      cwd: workspace.projectRoot,
      store: store(enqueue),
      write: vi.fn()
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ recipientNodeId: "reviewer", senderNodeId: "qa" })
    );
  });

  it("refuses ambiguous agent names", () => {
    const write = vi.fn();
    expect(() =>
      runCompassoCli(["ask", "Revisor", "Review"], {
        cwd: workspace.projectRoot,
        store: store(vi.fn(), [...agents, { ...agents[0], nodeId: "reviewer-2", online: false }]),
        write
      })
    ).toThrow("ambiguous");
  });

  it("queues an atomic batch with one idempotency key per agent", () => {
    const enqueueBatch = vi
      .fn()
      .mockImplementation((inputs: readonly { recipientNodeId: string }[]) =>
        inputs.map((input, index) => message(index + 3, input.recipientNodeId))
      );
    const output: string[] = [];

    const result = runCompassoCli(
      ["ask", "--batch", "reviewer,qa", "Revise a implementação.", "--idempotency-key", "review-1"],
      {
        cwd: workspace.projectRoot,
        store: store(vi.fn(), agents, enqueueBatch),
        write: (line) => output.push(line)
      }
    );

    expect(result).toBe(0);
    expect(enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({ recipientNodeId: "reviewer", idempotencyKey: "review-1:reviewer" }),
      expect.objectContaining({ recipientNodeId: "qa", idempotencyKey: "review-1:qa" })
    ]);
    expect(output).toHaveLength(2);
  });

  it("shows the latest auditable message states", () => {
    const output: string[] = [];
    const result = runCompassoCli(["status"], {
      cwd: workspace.projectRoot,
      store: store(vi.fn(), agents, vi.fn(), () => [message(3, "reviewer", "failed")]),
      write: (line) => output.push(line)
    });

    expect(result).toBe(0);
    expect(output.join("\n")).toContain("reviewer\tfailed\tattempt=1\tsession_write_failed");
  });

  it("queues only explicit local runtime lifecycle commands and exposes their status", () => {
    const requestRuntimeLifecycle = vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-000000000011",
      action: "pause",
      requestedBy: "compasso-cli",
      createdAt: "2026-07-20T12:01:00.000Z"
    });
    const output: string[] = [];
    runCompassoCli(["runtime", "pause"], {
      cwd: workspace.projectRoot,
      store: { ...store(), requestRuntimeLifecycle },
      write: (line) => output.push(line)
    });
    expect(requestRuntimeLifecycle).toHaveBeenCalledWith("pause");
    expect(output.join("\n")).toContain("pause\tqueued");

    const getRuntimeLifecycleStatus = vi.fn().mockReturnValue({
      state: "paused",
      revision: 4,
      updatedBy: "compasso-cli",
      updatedAt: "2026-07-20T12:01:00.000Z"
    });
    runCompassoCli(["runtime", "status", "--json"], {
      cwd: workspace.projectRoot,
      store: { ...store(), getRuntimeLifecycleStatus },
      write: (line) => output.push(line)
    });
    expect(getRuntimeLifecycleStatus).toHaveBeenCalledOnce();
    expect(output.join("\n")).toContain('"state": "paused"');

    expect(() =>
      runCompassoCli(["runtime", "pause", "--from", "reviewer"], {
        cwd: workspace.projectRoot,
        store: store(),
        write: vi.fn()
      })
    ).toThrow("Usage: compasso runtime");
  });

  it("controls the supervised-autonomy kill switch as a human-only local action", () => {
    const engageAutonomyKillSwitch = vi.fn();
    const releaseAutonomyKillSwitch = vi.fn();
    const isAutonomyKillSwitchEngaged = vi.fn().mockReturnValue(true);
    const listAutonomyDecisions = vi.fn().mockReturnValue([
      {
        id: "00000000-0000-4000-8000-000000000040",
        workspaceId: workspace.id,
        runId: null,
        proposalId: null,
        actor: "runtime",
        action: "retry_node",
        outcome: "stop",
        rule: "retry_limit",
        context: { config: {}, state: {} },
        createdAt: "2026-07-21T12:00:00.000Z"
      }
    ]);
    const cliStore = {
      ...store(),
      engageAutonomyKillSwitch,
      releaseAutonomyKillSwitch,
      isAutonomyKillSwitchEngaged,
      listAutonomyDecisions
    };
    const output: string[] = [];
    runCompassoCli(["autonomy", "kill"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    expect(engageAutonomyKillSwitch).toHaveBeenCalledWith(workspace.id, "local-user");
    runCompassoCli(["autonomy", "status"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    expect(output.join("\n")).toContain("ENGAJADO");
    runCompassoCli(["autonomy", "release"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    expect(releaseAutonomyKillSwitch).toHaveBeenCalledWith(workspace.id);
    expect(output.join("\n")).toContain("Nada é retomado automaticamente");
    runCompassoCli(["autonomy", "decisions", "--limit", "10"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    expect(listAutonomyDecisions).toHaveBeenCalledWith(workspace.id, 10);
    expect(output.join("\n")).toContain("retry_node\tstop\tretry_limit");

    // The kill switch is never an agent capability: --from is rejected before any store call.
    expect(() =>
      runCompassoCli(["autonomy", "kill", "--from", "reviewer"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: vi.fn()
      })
    ).toThrow("Usage: compasso autonomy");
  });

  it("lists persisted workflow runs and queues typed manual controls without exposing a command surface", () => {
    const listWorkflowRuns = vi.fn().mockReturnValue([workflowRun()]);
    const getWorkflowRun = vi.fn().mockReturnValue(workflowRun());
    const listWorkflowRunEvents = vi.fn().mockReturnValue([workflowRunEvent()]);
    const cliStore = {
      ...store(),
      listWorkflowRuns,
      getWorkflowRun,
      listWorkflowRunEvents
    };
    const output: string[] = [];

    expect(
      runCompassoCli(["run", "list"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: (line) => output.push(line)
      })
    ).toBe(0);
    expect(listWorkflowRuns).toHaveBeenCalledWith({ limit: 50 });
    expect(output.join("\n")).toContain("workflow-run-1\tworkflow-demo\tsucceeded");

    expect(
      runCompassoCli(["run", "show", "workflow-run-1", "--json"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: vi.fn()
      })
    ).toBe(0);
    expect(getWorkflowRun).toHaveBeenCalledWith("workflow-run-1");

    expect(
      runCompassoCli(["run", "events", "workflow-run-1"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: vi.fn()
      })
    ).toBe(0);
    expect(listWorkflowRunEvents).toHaveBeenCalledWith("workflow-run-1", 500);

    const requestWorkflowRunStart = vi.fn().mockReturnValue(workflowRunCommand("start"));
    const requestWorkflowRunControl = vi.fn().mockReturnValue(workflowRunCommand("approve"));
    const agents = vi.fn().mockReturnValue([
      {
        nodeId: "reviewer",
        name: "reviewer",
        roleName: null,
        adapterId: "codex",
        online: true
      }
    ]);
    runCompassoCli(
      [
        "run",
        "start",
        "delivery-report",
        "--dry-run",
        "--agent",
        "reviewer",
        "--task",
        "Prepare the delivery report"
      ],
      {
        cwd: workspace.projectRoot,
        store: {
          ...store(),
          requestWorkflowRunStart,
          requestWorkflowRunControl,
          listAgents: agents
        },
        write: (line) => output.push(line)
      }
    );
    expect(requestWorkflowRunStart).toHaveBeenCalledWith({
      templateId: "delivery-report",
      workspaceId: workspace.id,
      dryRun: true,
      agentNodeId: "reviewer",
      task: "Prepare the delivery report",
      contextMode: "full"
    });
    expect(output.join("\n")).toContain("start\tqueued");

    runCompassoCli(
      [
        "run",
        "start",
        "local-agent-delivery",
        "--agent",
        "reviewer",
        "--task",
        "Deliver the approved workflow request"
      ],
      {
        cwd: workspace.projectRoot,
        store: {
          ...store(),
          requestWorkflowRunStart,
          requestWorkflowRunControl,
          listAgents: vi.fn().mockReturnValue([
            {
              nodeId: "reviewer",
              name: "reviewer",
              roleName: null,
              adapterId: "codex",
              online: true
            }
          ])
        },
        write: vi.fn()
      }
    );
    expect(requestWorkflowRunStart).toHaveBeenLastCalledWith({
      templateId: "local-agent-delivery",
      workspaceId: workspace.id,
      dryRun: false,
      agentNodeId: "reviewer",
      task: "Deliver the approved workflow request",
      contextMode: "full"
    });

    runCompassoCli(["run", "approve", "workflow-run-1", "review", "--summary", "looks good"], {
      cwd: workspace.projectRoot,
      store: { ...store(), requestWorkflowRunControl },
      write: vi.fn()
    });
    expect(requestWorkflowRunControl).toHaveBeenCalledWith({
      action: "approve",
      runId: "workflow-run-1",
      nodeId: "review",
      decisionNote: "looks good"
    });

    runCompassoCli(
      ["run", "retry", "workflow-run-1", "implementation", "--rerun-scope", "dependents"],
      {
        cwd: workspace.projectRoot,
        store: { ...store(), requestWorkflowRunControl },
        write: vi.fn()
      }
    );
    expect(requestWorkflowRunControl).toHaveBeenLastCalledWith({
      action: "retry",
      runId: "workflow-run-1",
      nodeId: "implementation",
      retryScope: "dependents"
    });

    const listWorkflowRunAlternatives = vi.fn().mockReturnValue([workflowRun()]);
    runCompassoCli(
      ["run", "alternative", "workflow-run-1", "implementation", "--alternative-label", "fast"],
      {
        cwd: workspace.projectRoot,
        store: { ...store(), requestWorkflowRunControl },
        write: vi.fn()
      }
    );
    expect(requestWorkflowRunControl).toHaveBeenLastCalledWith({
      action: "alternative",
      runId: "workflow-run-1",
      nodeId: "implementation",
      alternativeLabel: "fast"
    });
    runCompassoCli(["run", "alternatives", "workflow-run-1", "implementation"], {
      cwd: workspace.projectRoot,
      store: { ...store(), listWorkflowRunAlternatives },
      write: vi.fn()
    });
    expect(listWorkflowRunAlternatives).toHaveBeenCalledWith("workflow-run-1", "implementation");
  });

  it("keeps objective proposals reviewable and separate from workflow execution", () => {
    const createOrchestrationProposal = vi.fn().mockReturnValue(proposal());
    const getOrchestrationProposal = vi.fn().mockReturnValue(proposal());
    const listOrchestrationProposals = vi.fn().mockReturnValue([proposal()]);
    const listOrchestrationProposalEvents = vi.fn().mockReturnValue([
      {
        id: "00000000-0000-4000-8000-000000000017",
        proposalId: proposal().id,
        sequence: 1,
        type: "created",
        actor: "local-user",
        details: "Proposal draft created",
        createdAt: "2026-07-21T12:00:00.000Z"
      }
    ]);
    const updateOrchestrationProposal = vi.fn().mockReturnValue({ ...proposal(), revision: 2 });
    const approveOrchestrationProposal = vi.fn().mockReturnValue({
      ...proposal(),
      status: "approved",
      revision: 2,
      reviewedBy: "local-user",
      approvedAt: "2026-07-21T12:00:00.000Z"
    });
    const output: string[] = [];
    const cliStore = {
      ...store(),
      createOrchestrationProposal,
      getOrchestrationProposal,
      listOrchestrationProposals,
      listOrchestrationProposalEvents,
      updateOrchestrationProposal,
      approveOrchestrationProposal
    };

    expect(
      runCompassoCli(["proposal", "create", "Prepare the reviewed delivery"], {
        cwd: workspace.projectRoot,
        store: cliStore,
        write: (line) => output.push(line)
      })
    ).toBe(0);
    expect(createOrchestrationProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        objective: "Prepare the reviewed delivery",
        workflowTemplateId: null,
        requestedPermissions: [],
        autonomyLevel: "assisted"
      })
    );

    runCompassoCli(["proposal", "list"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    runCompassoCli(["proposal", "events", proposal().id], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    runCompassoCli(
      ["proposal", "revise", proposal().id, "Prepare a revised delivery", "--revision", "1"],
      { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
    );
    runCompassoCli(["proposal", "approve", proposal().id, "--revision", "1"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: vi.fn()
    });

    expect(listOrchestrationProposals).toHaveBeenCalledWith(workspace.id, 50);
    expect(listOrchestrationProposalEvents).toHaveBeenCalledWith(workspace.id, proposal().id);
    expect(updateOrchestrationProposal).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: proposal().id, expectedRevision: 1 })
    );
    expect(approveOrchestrationProposal).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      proposalId: proposal().id,
      expectedRevision: 1
    });
    expect(cliStore.requestWorkflowRunStart).not.toHaveBeenCalled();
  });

  it("shows an agent inbox and keeps cancellation scoped to its workspace", () => {
    const output: string[] = [];
    const listInbox = vi.fn().mockReturnValue([message(3, "reviewer", "queued")]);
    const result = runCompassoCli(["inbox", "reviewer"], {
      cwd: workspace.projectRoot,
      store: { ...store(), listInbox },
      write: (line) => output.push(line)
    });

    expect(result).toBe(0);
    expect(listInbox).toHaveBeenCalledWith(workspace.id, "reviewer", 100);
    expect(output.join("\n")).toContain("queued");

    const cancelMessage = vi.fn().mockReturnValue(message(3, "reviewer", "cancelled"));
    runCompassoCli(["message", "cancel", "00000000-0000-4000-8000-000000000003"], {
      cwd: workspace.projectRoot,
      store: {
        ...store(),
        getMessage: vi.fn().mockReturnValue(message(3, "reviewer", "queued")),
        cancelMessage
      },
      write: vi.fn()
    });
    expect(cancelMessage).toHaveBeenCalledOnce();
  });

  it("lists unified history with workspace, agent, type, period and state filters", () => {
    const listHistory = vi.fn().mockReturnValue([
      {
        id: "event-1",
        workspaceId: workspace.id,
        agentNodeId: "reviewer",
        kind: "failure",
        eventType: "delivery_failed",
        state: "failed",
        subjectId: "message-1",
        occurredAt: "2026-07-20T12:00:00.000Z"
      } satisfies WorkspaceHistoryEntry
    ]);
    const output: string[] = [];
    const result = runCompassoCli(
      [
        "history",
        "--agent",
        "reviewer",
        "--type",
        "failure",
        "--state",
        "failed",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--until",
        "2026-07-31T00:00:00.000Z",
        "--limit",
        "20"
      ],
      {
        cwd: workspace.projectRoot,
        store: { ...store(), listHistory },
        write: (line) => output.push(line)
      }
    );

    expect(result).toBe(0);
    expect(listHistory).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      agentNodeId: "reviewer",
      kind: "failure",
      state: "failed",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-31T00:00:00.000Z",
      limit: 20
    });
    expect(output.join("\n")).toContain("delivery_failed");
  });

  it("records a correlated response from the request recipient", () => {
    const recordResponse = vi.fn().mockReturnValue(response());
    const requestMessageId = "00000000-0000-4000-8000-000000000003";
    const result = runCompassoCli(
      [
        "respond",
        requestMessageId,
        "--from",
        "reviewer",
        "Encontrei dois problemas.",
        "--idempotency-key",
        "response-1"
      ],
      {
        cwd: workspace.projectRoot,
        store: store(vi.fn(), agents, vi.fn(), () => [], recordResponse),
        write: vi.fn()
      }
    );

    expect(result).toBe(0);
    expect(recordResponse).toHaveBeenCalledWith({
      requestMessageId,
      workspaceId: workspace.id,
      responderNodeId: "reviewer",
      content: "Encontrei dois problemas.",
      idempotencyKey: "response-1"
    });
  });

  it("lists responses for one correlated request", () => {
    const output: string[] = [];
    const requestMessageId = "00000000-0000-4000-8000-000000000003";
    const listResponses = vi.fn().mockReturnValue([response()]);
    const result = runCompassoCli(["responses", requestMessageId], {
      cwd: workspace.projectRoot,
      store: store(vi.fn(), agents, vi.fn(), () => [], vi.fn(), listResponses),
      write: (line) => output.push(line)
    });

    expect(result).toBe(0);
    expect(listResponses).toHaveBeenCalledWith(workspace.id, requestMessageId, 50);
    expect(output.join("\n")).toContain("reviewer\trecorded\tlocal");
  });

  it("queues a typed Codex agent spawn for the selected workspace", () => {
    const createSpawn = vi.fn().mockReturnValue(spawn());
    const output: string[] = [];
    const result = runCompassoCli(
      [
        "spawn",
        "--agent",
        "codex",
        "--role",
        "tester",
        "--name",
        "qa-auth",
        "--idempotency-key",
        "spawn-1"
      ],
      {
        cwd: workspace.projectRoot,
        store: store(
          vi.fn(),
          agents,
          vi.fn(),
          () => [],
          vi.fn(),
          () => [],
          createSpawn
        ),
        write: (line) => output.push(line)
      }
    );

    expect(result).toBe(0);
    expect(createSpawn).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      adapterId: "codex",
      roleName: "tester",
      name: "qa-auth",
      requestedByNodeId: null,
      idempotencyKey: "spawn-1"
    });
    expect(output.join("\n")).toContain("queued\tagent-");
  });

  it("records the structural requester for permission checks", () => {
    const createSpawn = vi.fn().mockReturnValue(spawn());
    runCompassoCli(
      ["spawn", "--agent", "claude", "--role", "tester", "--name", "qa-auth", "--from", "reviewer"],
      {
        cwd: workspace.projectRoot,
        store: store(
          vi.fn(),
          agents,
          vi.fn(),
          () => [],
          vi.fn(),
          () => [],
          createSpawn
        ),
        write: vi.fn()
      }
    );

    expect(createSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "claude-code", requestedByNodeId: "reviewer" })
    );
  });

  it("requeues an interrupted spawn only through an explicit local retry", () => {
    const getSpawn = vi.fn().mockReturnValue({ ...spawn(), status: "interrupted" });
    const retrySpawn = vi.fn().mockReturnValue(spawn());
    const output: string[] = [];

    const result = runCompassoCli(["spawn", "retry", spawn().id], {
      cwd: workspace.projectRoot,
      store: {
        ...store(),
        getSpawn,
        retrySpawn
      },
      write: (line) => output.push(line)
    });

    expect(result).toBe(0);
    expect(getSpawn).toHaveBeenCalledWith(spawn().id);
    expect(retrySpawn).toHaveBeenCalledWith(spawn().id, null);
    expect(output.join("\n")).toContain("queued\tagent-");
  });

  it("does not let a structural agent identity request a spawn retry", () => {
    expect(() =>
      runCompassoCli(["spawn", "retry", spawn().id, "--from", "reviewer"], {
        cwd: workspace.projectRoot,
        store: store(),
        write: vi.fn()
      })
    ).toThrow("Usage: compasso spawn retry");
  });

  it("creates a durable workspace note from the CLI", () => {
    const createNote = vi.fn().mockReturnValue(note());
    const output: string[] = [];

    const result = runCompassoCli(
      [
        "note",
        "create",
        "--title",
        "DecisÃµes",
        "--content",
        "Usar SQLite.",
        "--idempotency-key",
        "note-create-1"
      ],
      {
        cwd: workspace.projectRoot,
        store: store(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
          createNote
        }),
        write: (line) => output.push(line)
      }
    );

    expect(result).toBe(0);
    expect(createNote).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      title: "DecisÃµes",
      content: "Usar SQLite.",
      createdByNodeId: null,
      idempotencyKey: "note-create-1"
    });
    expect(output.join("\n")).toContain("note-");
  });

  it("resolves and appends to a named workspace note", () => {
    const resolveNote = vi.fn().mockReturnValue(note());
    const appendNote = vi.fn().mockReturnValue({ ...note(), revision: 2 });

    runCompassoCli(["note", "append", "DecisÃµes", "Registrar o ADR.", "--from", "reviewer"], {
      cwd: workspace.projectRoot,
      store: store(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        appendNote,
        resolveNote
      }),
      write: vi.fn()
    });

    expect(resolveNote).toHaveBeenCalledWith(workspace.id, "DecisÃµes");
    expect(appendNote).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        noteId: note().id,
        content: "Registrar o ADR.",
        appendedByNodeId: "reviewer"
      })
    );
  });

  it("lists and shows persisted workspace notes", () => {
    const output: string[] = [];
    const listNotes = vi.fn().mockReturnValue([note()]);
    const resolveNote = vi.fn().mockReturnValue(note());
    const cliStore = store(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        listNotes,
        resolveNote
      }
    );

    runCompassoCli(["note", "list"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    runCompassoCli(["note", "show", "DecisÃµes", "--json"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });

    expect(listNotes).toHaveBeenCalledWith(workspace.id, 50);
    expect(resolveNote).toHaveBeenCalledWith(workspace.id, "DecisÃµes");
    expect(output.join("\n")).toContain("Usar SQLite.");
  });

  it("publishes an artifact from the selected workspace", () => {
    const publishArtifact = vi.fn().mockReturnValue(artifact());
    const output: string[] = [];
    const cliStore = store();
    cliStore.publishArtifact = publishArtifact;

    const result = runCompassoCli(
      [
        "artifact",
        "publish",
        "reports/test-report.json",
        "--kind",
        "test-report",
        "--idempotency-key",
        "artifact-publish-1"
      ],
      { cwd: workspace.projectRoot, store: cliStore, write: (line) => output.push(line) }
    );

    expect(result).toBe(0);
    expect(publishArtifact).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      sourcePath: "reports/test-report.json",
      kind: "test-report",
      publishedByNodeId: null,
      idempotencyKey: "artifact-publish-1"
    });
    expect(output.join("\n")).toContain(".forgedeck/artifacts/");
  });

  it("lists and shows persisted workspace artifacts", () => {
    const output: string[] = [];
    const cliStore = store();
    const listArtifacts = vi.fn().mockReturnValue([artifact()]);
    const resolveArtifact = vi.fn().mockReturnValue(artifact());
    cliStore.listArtifacts = listArtifacts;
    cliStore.resolveArtifact = resolveArtifact;

    runCompassoCli(["artifact", "list"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    runCompassoCli(["artifact", "show", "test-report.json", "--json"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });

    expect(listArtifacts).toHaveBeenCalledWith(workspace.id, 50);
    expect(resolveArtifact).toHaveBeenCalledWith(workspace.id, "test-report.json");
    expect(output.join("\n")).toContain("test-report.json");
  });

  it("creates a reviewed handoff draft without delivering it", () => {
    const createHandoff = vi.fn().mockReturnValue(handoff());
    const cliStore = store();
    cliStore.createHandoff = createHandoff;

    runCompassoCli(
      [
        "handoff",
        "reviewer",
        "qa",
        "--summary",
        "Revisar o relatorio.",
        "--artifact",
        "test-report.json"
      ],
      { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
    );

    expect(createHandoff).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      sourceNodeId: "reviewer",
      targetNodeId: "qa",
      summary: "Revisar o relatorio.",
      artifact: artifact(),
      createdByNodeId: null
    });
  });

  it("manages reviewed handoffs without submitting a delivery from the CLI", () => {
    const cliStore = store();
    const ready = { ...handoff(), status: "ready" as const, revision: 2 };
    const rejected = { ...handoff(), status: "rejected" as const, revision: 2 };
    cliStore.approveHandoff = vi.fn().mockReturnValue(ready);
    cliStore.rejectHandoff = vi.fn().mockReturnValue(rejected);
    cliStore.cancelHandoff = vi.fn().mockReturnValue({ ...ready, status: "cancelled" as const });
    cliStore.retryHandoff = vi.fn().mockReturnValue(handoff());
    cliStore.listHandoffEvents = vi.fn().mockReturnValue([
      {
        id: "event-1",
        handoffId: handoff().id,
        sequence: 2,
        type: "handoff_rejected",
        fromStatus: "draft",
        toStatus: "rejected",
        error: "Evidence is incomplete.",
        deliveryAttemptId: null,
        responsible: "local_user",
        createdAt: "2026-07-20T12:00:00.000Z"
      } satisfies CanvasHandoffEvent
    ]);

    runCompassoCli(
      ["handoff", "approve", handoff().id, "--revision", "1", "--summary", "Approved"],
      { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
    );
    runCompassoCli(
      [
        "handoff",
        "reject",
        handoff().id,
        "--revision",
        "1",
        "--summary",
        "Evidence is incomplete."
      ],
      { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
    );
    runCompassoCli(["handoff", "cancel", handoff().id, "--revision", "2"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: vi.fn()
    });
    runCompassoCli(["handoff", "retry", handoff().id, "--revision", "2"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: vi.fn()
    });
    const output: string[] = [];
    runCompassoCli(["handoff", "history", handoff().id], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });

    expect(cliStore.approveHandoff).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      handoffId: handoff().id,
      expectedRevision: 1,
      actedByNodeId: null,
      summary: "Approved"
    });
    expect(cliStore.rejectHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Evidence is incomplete." })
    );
    expect(cliStore.cancelHandoff).toHaveBeenCalledOnce();
    expect(cliStore.retryHandoff).toHaveBeenCalledOnce();
    expect(output.join("\n")).toContain("handoff_rejected");
  });

  it("resolves only the context connected to the selected agent", () => {
    const resolveContext = vi.fn().mockReturnValue(workspaceContext());
    const output: string[] = [];
    const cliStore = store();
    cliStore.resolveContext = resolveContext;

    runCompassoCli(["context", "reviewer", "--from", "reviewer"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });

    expect(resolveContext).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      agentNodeId: "reviewer",
      requesterNodeId: "reviewer"
    });
    expect(output.join("\n")).toContain("Decisões de arquitetura");
    expect(output.join("\n")).toContain("Usar SQLite local.");
  });

  it("creates a context connection by resolving source and target through the canvas", () => {
    const createConnection = vi.fn().mockReturnValue(connectionEvent());
    const resolveConnectionNode = vi
      .fn()
      .mockReturnValueOnce({ nodeId: note().nodeId, title: "Decisões", type: "note" })
      .mockReturnValueOnce({ nodeId: "reviewer", title: "Revisor", type: "agent" });
    const cliStore = store();
    cliStore.createConnection = createConnection;
    cliStore.resolveConnectionNode = resolveConnectionNode;

    runCompassoCli(
      [
        "connect",
        "create",
        "Decisões",
        "Revisor",
        "--from",
        "reviewer",
        "--idempotency-key",
        "connect-1"
      ],
      { cwd: workspace.projectRoot, store: cliStore, write: vi.fn() }
    );

    expect(resolveConnectionNode).toHaveBeenNthCalledWith(1, workspace.id, "Decisões");
    expect(resolveConnectionNode).toHaveBeenNthCalledWith(2, workspace.id, "Revisor");
    expect(createConnection).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      sourceNodeId: note().nodeId,
      targetNodeId: "reviewer",
      type: "context",
      label: null,
      createdByNodeId: "reviewer",
      expectedCanvasRevision: null,
      idempotencyKey: "connect-1"
    });
  });

  it("supports list, show and remove with public connection data only", () => {
    const cliStore = store();
    const output: string[] = [];
    cliStore.listConnections = vi.fn().mockReturnValue([connectionEvent().connection]);
    cliStore.showConnection = vi.fn().mockReturnValue(connectionEvent().connection);
    cliStore.removeConnection = vi
      .fn()
      .mockReturnValue({ ...connectionEvent(), type: "connection_removed" });

    runCompassoCli(["connect", "list"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    runCompassoCli(["connect", "show", "edge-context-reviewer"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });
    runCompassoCli(["connect", "remove", "edge-context-reviewer", "--revision", "2"], {
      cwd: workspace.projectRoot,
      store: cliStore,
      write: (line) => output.push(line)
    });

    expect(cliStore.listConnections).toHaveBeenCalledWith(workspace.id, 500);
    expect(cliStore.showConnection).toHaveBeenCalledWith(workspace.id, "edge-context-reviewer");
    expect(cliStore.removeConnection).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      connectionId: "edge-context-reviewer",
      removedByNodeId: null,
      expectedCanvasRevision: 2,
      idempotencyKey: expect.any(String)
    });
    expect(output.join("\n")).not.toContain(".forgedeck");
  });
});

function store(
  enqueue = vi.fn(),
  directory: readonly AgentDirectoryEntry[] = agents,
  enqueueBatch = vi.fn(),
  listMessages: () => readonly AgentMessage[] = () => [],
  recordResponse = vi.fn(),
  listResponses: () => readonly AgentMessageResponse[] = () => [],
  createSpawn = vi.fn(),
  noteMethods: Partial<
    Pick<
      Parameters<typeof runCompassoCli>[1]["store"],
      "createNote" | "appendNote" | "resolveNote" | "listNotes"
    >
  > = {}
): Parameters<typeof runCompassoCli>[1]["store"] {
  return {
    listWorkspaces: () => [workspace],
    listAgents: () => directory,
    enqueue,
    enqueueBatch,
    listMessages,
    getMessage: vi.fn().mockReturnValue(null),
    listInbox: vi.fn().mockReturnValue([]),
    cancelMessage: vi.fn(),
    retryMessage: vi.fn(),
    recordResponse,
    listResponses,
    getAgentProfile: vi.fn().mockReturnValue(profile()),
    getMission: vi.fn().mockReturnValue(mission()),
    setMission: vi.fn().mockReturnValue(mission()),
    getWorkspaceMemory: vi.fn().mockReturnValue(memory()),
    setWorkspaceMemory: vi.fn().mockReturnValue(memory()),
    createSpawn,
    getSpawn: vi.fn().mockReturnValue(spawn()),
    retrySpawn: vi.fn().mockReturnValue(spawn()),
    createLifecycleCommand: vi.fn(),
    listLifecycleCommands: vi.fn().mockReturnValue([]),
    publishArtifact: vi.fn().mockReturnValue(artifact()),
    resolveArtifact: vi.fn().mockReturnValue(artifact()),
    listArtifacts: vi.fn().mockReturnValue([]),
    createArtifactFeedback: vi.fn().mockReturnValue(artifactFeedback()),
    listArtifactFeedback: vi.fn().mockReturnValue([artifactFeedback()]),
    getArtifactMemory: vi.fn().mockReturnValue(artifactMemory()),
    setArtifactMemory: vi.fn().mockReturnValue(artifactMemory()),
    listArtifactMemories: vi.fn().mockReturnValue([artifactMemory()]),
    compareArtifactMemories: vi.fn().mockReturnValue(artifactMemoryComparison()),
    restoreArtifactMemory: vi.fn().mockReturnValue(artifactMemory()),
    getArtifactImpact: vi.fn().mockReturnValue(artifactImpact()),
    createDeliveryContract: vi.fn().mockReturnValue(deliveryContract()),
    getDeliveryContract: vi.fn().mockReturnValue(deliveryContract()),
    listDeliveryContracts: vi.fn().mockReturnValue([deliveryContract()]),
    verifyDeliveryContract: vi.fn().mockReturnValue(deliveryContract()),
    buildExecutionContext: vi.fn().mockReturnValue(effectiveExecutionContext()),
    checkpointExecutionContext: vi.fn().mockReturnValue(executionCheckpoint()),
    getExecutionCheckpoint: vi.fn().mockReturnValue(executionCheckpoint()),
    listExecutionCheckpoints: vi.fn().mockReturnValue([executionCheckpoint()]),
    createHandoff: vi.fn().mockReturnValue(handoff()),
    getHandoff: vi.fn().mockReturnValue(handoff()),
    listHandoffs: vi.fn().mockReturnValue([]),
    listHandoffEvents: vi.fn().mockReturnValue([]),
    approveHandoff: vi.fn().mockReturnValue(handoff()),
    rejectHandoff: vi.fn().mockReturnValue(handoff()),
    cancelHandoff: vi.fn().mockReturnValue(handoff()),
    retryHandoff: vi.fn().mockReturnValue(handoff()),
    resolveContext: vi.fn().mockReturnValue(workspaceContext()),
    createConnection: vi.fn().mockReturnValue(connectionEvent()),
    listConnections: vi.fn().mockReturnValue([]),
    showConnection: vi.fn().mockReturnValue(connectionEvent().connection),
    removeConnection: vi.fn().mockReturnValue(connectionEvent()),
    resolveConnectionNode: vi.fn((_, reference: string) => ({
      nodeId: reference,
      title: reference,
      type: reference === "reviewer" ? "agent" : "note"
    })),
    createNote: noteMethods.createNote ?? vi.fn().mockReturnValue(note()),
    writeNote: vi.fn().mockReturnValue(note()),
    readNoteContent: vi.fn(() => "conteúdo em disco"),
    appendNote: noteMethods.appendNote ?? vi.fn().mockReturnValue(note()),
    resolveNote: noteMethods.resolveNote ?? vi.fn().mockReturnValue(note()),
    listNotes: noteMethods.listNotes ?? vi.fn().mockReturnValue([]),
    listHistory: vi.fn().mockReturnValue([]),
    getWorkflowRun: vi.fn().mockReturnValue(workflowRun()),
    listWorkflowRuns: vi.fn().mockReturnValue([workflowRun()]),
    listWorkflowRunAlternatives: vi.fn().mockReturnValue([workflowRun()]),
    listWorkflowRunEvents: vi.fn().mockReturnValue([workflowRunEvent()]),
    createOrchestrationProposal: vi.fn().mockReturnValue(proposal()),
    getOrchestrationProposal: vi.fn().mockReturnValue(proposal()),
    listOrchestrationProposals: vi.fn().mockReturnValue([proposal()]),
    listOrchestrationProposalEvents: vi.fn().mockReturnValue([]),
    updateOrchestrationProposal: vi.fn().mockReturnValue(proposal()),
    approveOrchestrationProposal: vi.fn().mockReturnValue(proposal()),
    rejectOrchestrationProposal: vi.fn().mockReturnValue(proposal()),
    requestWorkflowRunStart: vi.fn().mockReturnValue(workflowRunCommand("start")),
    requestWorkflowRunControl: vi.fn().mockReturnValue(workflowRunCommand("pause")),
    getRuntimeLifecycleStatus: vi.fn().mockReturnValue({
      state: "running",
      revision: 3,
      updatedBy: "desktop-runtime",
      updatedAt: "2026-07-20T12:00:00.000Z"
    }),
    requestRuntimeLifecycle: vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-000000000011",
      action: "pause",
      requestedBy: "compasso-cli",
      createdAt: "2026-07-20T12:01:00.000Z"
    }),
    isAutonomyKillSwitchEngaged: vi.fn().mockReturnValue(false),
    engageAutonomyKillSwitch: vi.fn(),
    releaseAutonomyKillSwitch: vi.fn(),
    listAutonomyDecisions: vi.fn().mockReturnValue([])
  };
}

function proposal(): OrchestrationProposal {
  return {
    id: "00000000-0000-4000-8000-000000000016",
    workspaceId: workspace.id,
    objective: "Prepare the reviewed delivery",
    understanding: "A local human review is required.",
    questions: ["Which template applies?"],
    requiredMaterials: ["Current canvas"],
    suggestedTeam: [{ nodeId: "reviewer", role: "Reviewer" }],
    workflowTemplateId: null,
    executionAgentNodeId: null,
    dependencies: [],
    requestedPermissions: [],
    gates: ["human_approval"],
    risks: ["Scope needs review"],
    estimatedCost: null,
    estimatedDuration: null,
    autonomyLevel: "assisted",
    autonomy: defaultAutonomyConfig,
    status: "draft",
    checksum: "f".repeat(64),
    revision: 1,
    createdBy: "local-user",
    reviewedBy: null,
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
    approvedAt: null,
    rejectedAt: null
  };
}

function workflowRunCommand(action: WorkflowRunCommandAction) {
  return {
    id: "00000000-0000-4000-8000-000000000012",
    action,
    status: "queued",
    runId: null,
    workspaceId: action === "start" ? workspace.id : null,
    agentNodeId: action === "start" ? "reviewer" : null,
    task: action === "start" ? "Create a delivery report" : null,
    contractId: null,
    nodeId: null,
    retryScope: "run",
    alternativeLabel: null,
    templateId: action === "start" ? "delivery-report" : null,
    dryRun: action === "start" ? false : null,
    decisionNote: null,
    requestedBy: "compasso-cli",
    createdAt: "2026-07-20T12:02:00.000Z",
    appliedAt: null,
    resultRunId: null,
    errorCode: null
  };
}

function connectionEvent(): WorkspaceConnectionCanvasEvent {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    type: "connection_created",
    workspaceId: workspace.id,
    canvasId: workspace.canvasId,
    connection: {
      connectionId: "edge-context-reviewer",
      canvasId: workspace.canvasId,
      sourceNodeId: note().nodeId,
      targetNodeId: "reviewer",
      type: "context",
      permission: "connect_context",
      label: "Context",
      createdBy: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      revision: 2
    },
    edge: {
      id: "edge-context-reviewer",
      source: note().nodeId,
      target: "reviewer",
      contract: {
        schemaVersion: "1.0",
        kind: "context",
        label: "Context",
        requiredEvidenceTypes: []
      }
    },
    actorNodeId: null,
    canvasRevision: 2
  };
}

function workspaceContext(): WorkspaceAgentContext {
  return {
    workspaceId: workspace.id,
    agentNodeId: "reviewer",
    mission: "Ship a reviewed change",
    sources: [
      {
        nodeId: "note-architecture",
        title: "Decisões de arquitetura",
        kind: "note",
        content: "Usar SQLite local.",
        edgeId: "edge-note-reviewer",
        contract: {
          schemaVersion: "1.0",
          kind: "dependency",
          label: "Contexto",
          requiredEvidenceTypes: []
        }
      }
    ]
  };
}

function handoff(): CanvasHandoff {
  const role = {
    name: "Reviewer",
    responsibilities: "Review",
    constraints: "Stay scoped",
    expectedDeliverable: "Report",
    completionCriteria: "Evidence reviewed"
  };
  return {
    id: "handoff-1",
    canvasId: workspace.canvasId,
    projectId: workspace.projectId,
    status: "draft",
    revision: 1,
    mission: "Review the implementation",
    source: { nodeId: "reviewer", title: "Revisor", role },
    target: { nodeId: "qa", title: "QA", role },
    edge: {
      edgeId: "edge-1",
      contract: {
        schemaVersion: "1.0",
        kind: "handoff",
        label: "Review",
        requiredEvidenceTypes: []
      }
    },
    content: {
      summary: "Revisar o relatorio.",
      completedWork: [],
      decisions: [],
      evidence: [],
      openQuestions: [],
      risks: []
    },
    error: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    readyAt: null,
    deliveredAt: null,
    deliveryAttempts: []
  };
}

function artifact(): WorkspaceArtifact {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    kind: "test-report",
    sourceRelativePath: "reports/test-report.json",
    relativePath: ".forgedeck/artifacts/00000000-0000-4000-8000-000000000009/test-report.json",
    filename: "test-report.json",
    sha256: "a".repeat(64),
    byteSize: 16,
    mediaType: "application/json",
    publishedByNodeId: null,
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function artifactMemory(): ArtifactMemory {
  return {
    id: "00000000-0000-4000-8000-000000000015",
    workspaceId: workspace.id,
    artifactId: artifact().id,
    version: 1,
    origin: "reports/test-report.json",
    sha256: "a".repeat(64),
    relationships: [],
    relevance: "relevant",
    status: "active",
    restoredFromVersion: null,
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function artifactFeedback(): ArtifactFeedback {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    workspaceId: workspace.id,
    artifactId: artifact().id,
    artifactVersion: 1,
    content: "Add a regression test",
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function artifactImpact(): ArtifactImpact {
  return {
    workspaceId: workspace.id,
    rootArtifactId: artifact().id,
    nodes: [
      {
        artifactId: artifact().id,
        kind: artifact().kind,
        filename: artifact().filename,
        sha256: artifact().sha256,
        memoryVersion: 1,
        relevance: "relevant",
        status: "active"
      },
      {
        artifactId: "00000000-0000-4000-8000-000000000015",
        kind: "review",
        filename: "review.json",
        sha256: "b".repeat(64),
        memoryVersion: 2,
        relevance: "required",
        status: "active"
      }
    ],
    edges: [
      {
        sourceArtifactId: "00000000-0000-4000-8000-000000000015",
        targetArtifactId: artifact().id,
        kind: "derived_from"
      }
    ],
    affectedArtifactIds: ["00000000-0000-4000-8000-000000000015"]
  };
}

function artifactMemoryComparison(): ArtifactMemoryComparison {
  return {
    workspaceId: workspace.id,
    artifactId: artifact().id,
    baseVersion: 1,
    targetVersion: 2,
    addedRelationships: [{ artifactId: "00000000-0000-4000-8000-000000000015", kind: "supports" }],
    removedRelationships: [],
    relevance: { from: "relevant", to: "required" },
    status: null
  };
}

function deliveryContract(): DeliveryContract {
  return {
    id: "00000000-0000-4000-8000-000000000016",
    revisionId: "00000000-0000-4000-8000-000000000017",
    workspaceId: workspace.id,
    sourceNodeId: "reviewer",
    targetNodeId: "qa",
    version: 1,
    inputs: ["implementation"],
    outputs: ["review"],
    completionCriteria: ["tests-pass"],
    declaredEvidence: [{ kind: "test", reference: "pnpm test" }],
    verifiedEvidence: [],
    state: "draft",
    limits: { maxAttempts: 1, maxContextBytes: 1024 * 1024 },
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function effectiveExecutionContext(): EffectiveExecutionContext {
  return {
    workspaceId: workspace.id,
    agentNodeId: "reviewer",
    task: "Review the change",
    profile: profile(),
    mission: mission(),
    memory: memory(),
    connectedContext: workspaceContext(),
    artifactMemories: [artifactMemory()],
    previousHandoff: null,
    deliveryContract: deliveryContract()
  };
}

function executionCheckpoint(): ExecutionCheckpoint {
  return {
    id: "00000000-0000-4000-8000-000000000018",
    workspaceId: workspace.id,
    agentNodeId: "reviewer",
    type: "function",
    task: "Review the change",
    contractId: deliveryContract().id,
    snapshot: {
      id: "00000000-0000-4000-8000-000000000019",
      context: effectiveExecutionContext(),
      sha256: "b".repeat(64),
      createdAt: "2026-07-20T12:00:00.000Z"
    },
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function workflowRun(): WorkflowRunSnapshot {
  return {
    id: "workflow-run-1",
    workflowId: "workflow-demo",
    workflowVersion: "1.0",
    workflowHash: "c".repeat(64),
    inputHash: "d".repeat(64),
    effectivePermissions: { process: true },
    state: "succeeded",
    dryRun: false,
    concurrency: 1,
    startedAt: "2026-07-20T12:00:00.000Z",
    endedAt: "2026-07-20T12:01:00.000Z",
    nodeRuns: [
      {
        id: "workflow-node-run-1",
        runId: "workflow-run-1",
        nodeId: "review",
        state: "succeeded",
        attempt: 1,
        inputHash: "e".repeat(64),
        idempotencyKey: "workflow-run-1:review:1",
        evidence: [
          {
            id: "evidence-1",
            type: "test",
            summary: "Tests passed",
            metadata: {}
          }
        ],
        failureReason: null
      }
    ],
    reportArtifact: null
  };
}

function workflowRunEvent(): RunEvent {
  return {
    id: "workflow-event-1",
    runId: "workflow-run-1",
    nodeRunId: null,
    sequence: 1,
    type: "run.completed",
    timestamp: "2026-07-20T12:01:00.000Z",
    schemaVersion: "1.0",
    payload: {}
  };
}

function note(): WorkspaceNote {
  return {
    id: "00000000-0000-4000-8000-000000000007",
    workspaceId: workspace.id,
    canvasId: workspace.canvasId,
    projectId: workspace.projectId,
    nodeId: "note-00000000-0000-4000-8000-000000000008",
    title: "DecisÃµes",
    content: "Usar SQLite.",
    revision: 1,
    createdByNodeId: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z"
  };
}

function spawn(): AgentSpawn {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    workspaceId: workspace.id,
    canvasId: workspace.canvasId,
    projectId: workspace.projectId,
    nodeId: "agent-00000000-0000-4000-8000-000000000006",
    adapterId: "codex",
    roleName: "tester",
    name: "qa-auth",
    requestedByNodeId: null,
    status: "queued",
    idempotencyKey: "spawn-1",
    attempt: 0,
    sessionId: null,
    errorCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z"
  };
}

function profile(): AgentProfile {
  return {
    id: "00000000-0000-4000-8000-000000000012",
    workspaceId: workspace.id,
    nodeId: "reviewer",
    version: 1,
    identity: "Revisor",
    adapterId: "codex",
    responsibilities: "Review",
    limits: "Stay scoped",
    capabilities: ["send_messages"],
    expectedDeliverables: ["Report"],
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function mission(): Mission {
  return {
    id: "00000000-0000-4000-8000-000000000013",
    workspaceId: workspace.id,
    version: 1,
    objective: "Ship the local beta",
    scope: ["runtime"],
    decisions: [],
    constraints: ["no cloud"],
    progress: "",
    blockers: [],
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function memory(): WorkspaceMemory {
  return {
    id: "00000000-0000-4000-8000-000000000014",
    workspaceId: workspace.id,
    version: 1,
    stack: ["TypeScript", "SQLite"],
    architecture: "",
    patterns: [],
    commands: ["pnpm test"],
    conventions: [],
    technicalDecisions: [],
    createdBy: "local-user",
    createdAt: "2026-07-20T12:00:00.000Z"
  };
}

function response(): AgentMessageResponse {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    requestMessageId: "00000000-0000-4000-8000-000000000003",
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    responderNodeId: "reviewer",
    content: "Encontrei dois problemas.",
    status: "recorded",
    idempotencyKey: "response-1",
    deliveryMessageId: null,
    createdAt: "2026-07-20T12:00:02.000Z"
  };
}

function message(
  suffix: number,
  recipientNodeId: string,
  status: AgentMessage["status"] = "queued"
): AgentMessage {
  return {
    id: `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`,
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    recipientNodeId,
    senderNodeId: null,
    content: "Revise a implementação.",
    status,
    idempotencyKey: `request-${suffix}`,
    attempt: status === "queued" ? 0 : 1,
    sessionId: null,
    adapterId: null,
    errorCode: status === "failed" ? "session_write_failed" : null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:01.000Z",
    sentAt: null
  };
}
