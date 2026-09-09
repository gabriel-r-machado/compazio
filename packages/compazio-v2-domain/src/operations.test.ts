import { describe, expect, it } from "vitest";

import {
  EXECUTION_POLICIES,
  LEGACY_COORDINATOR_ENABLED_EVENT,
  LEGACY_COORDINATOR_TERMINAL_ID,
  OPERATIONAL_SCHEMA_VERSION,
  OperationalDomainError,
  createEmptyOperationalState,
  migrateOperationalState,
  retainOperationalHistory,
  sanitizeEventMetadata,
  transitionRun,
  transitionTask,
  type OrchestrationRun,
  type OrchestrationTask,
  type RunEvent
} from "./index";

const now = "2026-07-28T12:00:00.000Z";

function run(status: OrchestrationRun["status"] = "created"): OrchestrationRun {
  return {
    id: "run_1",
    workspaceId: "workspace_1",
    orchestratorTerminalId: "terminal_1",
    status,
    policyId: "standard",
    taskIds: [],
    recruitedTerminalIds: [],
    startedAt: now,
    updatedAt: now
  };
}

function task(status: OrchestrationTask["status"] = "queued"): OrchestrationTask {
  return {
    id: "task_1",
    runId: "run_1",
    title: "Implementar",
    status,
    dependencyIds: [],
    attempt: 0,
    maxAttempts: 2,
    attempts: [],
    createdAt: now
  };
}

describe("Phase 4 operational domain", () => {
  it("supports the full run lifecycle with explicit pause and resume", () => {
    let current = transitionRun(run(), "planning", now, "correlation_1");
    current = transitionRun(current, "running", now, "correlation_2");
    current = transitionRun(current, "waiting", now, "correlation_3");
    current = transitionRun(current, "needs-attention", now, "correlation_4");
    current = transitionRun(current, "paused", now, "correlation_5");
    current = transitionRun(current, "running", now, "correlation_6");
    current = transitionRun(current, "completed", now, "correlation_7");
    expect(current).toMatchObject({ status: "completed", completedAt: now });
  });

  it.each([
    ["running", "failed"],
    ["planning", "cancelled"],
    ["waiting", "completed"]
  ] as const)("accepts run transition %s -> %s", (from, to) => {
    expect(transitionRun(run(from), to, now, "correlation_1").status).toBe(to);
  });

  it("rejects resurrection of a completed run", () => {
    expect(() => transitionRun(run("completed"), "running", now, "correlation_1")).toThrow(
      OperationalDomainError
    );
  });

  it("supports task assignment, execution, waiting and completion", () => {
    let current = transitionTask(task(), "assigned", now, "correlation_1");
    current = transitionTask(current, "running", now, "correlation_2");
    current = transitionTask(current, "waiting-input", now, "correlation_3");
    current = transitionTask(current, "running", now, "correlation_4");
    current = transitionTask(current, "completed", now, "correlation_5");
    expect(current).toMatchObject({ status: "completed", startedAt: now, completedAt: now });
  });

  it("permits a failed task to become a new queued attempt but not a completed one", () => {
    expect(transitionTask(task("failed"), "queued", now, "correlation_1").status).toBe("queued");
    expect(() => transitionTask(task("completed"), "running", now, "correlation_2")).toThrow(
      /Não é possível/
    );
  });

  it("defines behaviorally different validated policies", () => {
    expect(EXECUTION_POLICIES.economy).toMatchObject({
      maxConcurrentAgents: 2,
      maxAutomaticRetries: 0,
      preferExistingAgents: true
    });
    expect(EXECUTION_POLICIES.standard.maxConcurrentAgents).toBe(4);
    expect(EXECUTION_POLICIES["high-performance"]).toMatchObject({
      maxConcurrentAgents: 6,
      maxAutomaticRetries: 2,
      contextSharing: "broad"
    });
  });

  it("sanitizes secrets and high-volume content from events", () => {
    expect(
      sanitizeEventMetadata({
        status: "failed",
        token: "secret",
        prompt: "private",
        filePath: "C:\\Users\\person",
        durationMs: 42,
        preview: "x".repeat(2_000)
      })
    ).toEqual({ status: "failed", durationMs: 42, preview: "x".repeat(1_000) });
  });

  it("retains only the configured event and activity tail", () => {
    const state = createEmptyOperationalState("workspace_1", now);
    const events = Array.from({ length: 5 }, (_, index): RunEvent => ({
      id: `event_${index}`,
      type: "run.created",
      workspaceId: "workspace_1",
      actor: "system",
      target: "run",
      timestamp: now,
      correlationId: `correlation_${index}`,
      metadata: {},
      schemaVersion: OPERATIONAL_SCHEMA_VERSION
    }));
    const retained = retainOperationalHistory({ ...state, events }, { events: 2 });
    expect(retained.events.map((event) => event.id)).toEqual(["event_3", "event_4"]);
  });

  it("upgrades Phase 4 operational history without inventing team runtime state", () => {
    const current = createEmptyOperationalState("workspace_1", now);
    const legacy = {
      ...current,
      schemaVersion: 1,
      events: [
        {
          id: "event_1",
          type: "run.created",
          workspaceId: "workspace_1",
          actor: "terminal_1",
          target: "run_1",
          timestamp: now,
          correlationId: "corr_1",
          metadata: {},
          schemaVersion: 1
        }
      ]
    } as Record<string, unknown>;
    delete legacy.teamMembers;
    delete legacy.teamTasks;
    delete legacy.messages;
    const migrated = migrateOperationalState(legacy, now);
    expect(migrated.schemaVersion).toBe(OPERATIONAL_SCHEMA_VERSION);
    expect(migrated.events[0]?.schemaVersion).toBe(OPERATIONAL_SCHEMA_VERSION);
    expect(migrated.teamMembers).toEqual([]);
    expect(migrated.teamTasks).toEqual([]);
    expect(migrated.messages).toEqual([]);
  });

  it("migrates persisted team history from schema 2 without keeping connection or retry internals", () => {
    const current = createEmptyOperationalState("workspace_1", now);
    const legacy = {
      ...current,
      schemaVersion: 2,
      teamMembers: [
        {
          id: "member_1",
          workspaceId: "workspace_1",
          terminalId: "terminal_2",
          agentType: "codex",
          roleId: "qa_role",
          displayName: "QA",
          status: "ready",
          recruitedBy: "terminal_1",
          createdAt: now
        }
      ],
      teamTasks: [
        {
          id: "team_task_1",
          workspaceId: "workspace_1",
          title: "Verificar",
          description: "Executar a verificaÃ§Ã£o.",
          status: "assigned",
          createdBy: "terminal_1",
          assignedTo: ["terminal_2"],
          contextRefs: ["note_1"],
          resultRefs: [],
          createdAt: now
        }
      ],
      messages: [
        {
          id: "message_1",
          workspaceId: "workspace_1",
          connectionId: "edge_1",
          fromTerminalId: "terminal_1",
          toTerminalId: "terminal_2",
          taskId: "team_task_1",
          correlationId: "corr_1",
          idempotencyKey: "legacy-message-0001",
          type: "task",
          content: "Verifique a fixture.",
          status: "delivered",
          attempt: 1,
          createdAt: now
        }
      ]
    } as Record<string, unknown>;

    const migrated = migrateOperationalState(legacy, now);
    expect(migrated.teamMembers[0]).toMatchObject({
      role: { name: "qa_role" },
      recruitedByTerminalId: "terminal_1",
      status: "ready"
    });
    expect(migrated.teamTasks[0]).toMatchObject({
      createdByTerminalId: "terminal_1",
      assignedToTerminalId: "terminal_2",
      status: "assigned"
    });
    expect(migrated.messages[0]).toMatchObject({
      id: "message_1",
      type: "task",
      status: "delivered"
    });
    expect(migrated.messages[0]).not.toHaveProperty("connectionId");
  });

  it("upgrades schema 3 team history with no runtime state and preserves safe task extensions", () => {
    const current = createEmptyOperationalState("workspace_1", now);
    const legacy = {
      ...current,
      schemaVersion: 3,
      teamTasks: [
        {
          id: "team_task_1",
          workspaceId: "workspace_1",
          runId: "team_run_1",
          title: "Revisar",
          description: "Revisar o resultado.",
          status: "blocked",
          createdByTerminalId: "terminal_1",
          assignedToTerminalId: "terminal_2",
          contextRefs: [],
          dependsOn: ["team_task_0"],
          blockedBy: ["team_task_0"],
          resultRefs: [],
          attempt: 1,
          maxAttempts: 2,
          priority: "high",
          createdAt: now
        }
      ],
      teamRuns: [
        {
          id: "team_run_1",
          workspaceId: "workspace_1",
          compazioTerminalId: "terminal_1",
          title: "API Tasks",
          objective: "Revisar contrato.",
          status: "blocked",
          memberIds: [],
          taskIds: ["team_task_1"],
          createdAt: now
        }
      ]
    };
    const migrated = migrateOperationalState(legacy, now);
    expect(migrated.schemaVersion).toBe(OPERATIONAL_SCHEMA_VERSION);
    expect(migrated.teamRuns).toContainEqual(
      expect.objectContaining({ id: "team_run_1", status: "blocked" })
    );
    expect(migrated.teamTasks).toContainEqual(
      expect.objectContaining({
        id: "team_task_1",
        runId: "team_run_1",
        status: "blocked",
        dependsOn: ["team_task_0"],
        priority: "high"
      })
    );
  });

  it("migrates the v4 coordinator vocabulary into compazio", () => {
    const current = createEmptyOperationalState("workspace_1", now);
    const legacy = {
      ...current,
      schemaVersion: 4,
      teamRuns: [
        {
          id: "team_run_1",
          workspaceId: "workspace_1",
          [LEGACY_COORDINATOR_TERMINAL_ID]: "terminal_1",
          title: "API Tasks",
          objective: "Revisar contrato.",
          status: "running",
          memberIds: [],
          taskIds: [],
          createdAt: now
        }
      ],
      events: [
        {
          id: "event_1",
          type: LEGACY_COORDINATOR_ENABLED_EVENT,
          workspaceId: "workspace_1",
          actor: "terminal_1",
          target: "terminal_1",
          timestamp: now,
          correlationId: "corr_1",
          metadata: {},
          schemaVersion: 4
        }
      ]
    } as Record<string, unknown>;

    const migrated = migrateOperationalState(legacy, now);

    expect(migrated.schemaVersion).toBe(OPERATIONAL_SCHEMA_VERSION);
    expect(migrated.teamRuns[0]).toMatchObject({
      id: "team_run_1",
      compazioTerminalId: "terminal_1"
    });
    expect(migrated.teamRuns[0]).not.toHaveProperty(LEGACY_COORDINATOR_TERMINAL_ID);
    expect(migrated.events[0]?.type).toBe("compazio.enabled");
  });
});
