import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addTerminalNode,
  addVisualEdge,
  createWorkspace,
  type DomainDependencies,
  type TerminalSession,
  type V2TerminalEvent,
  type Workspace
} from "@forgedeck/compazio-v2-domain";
import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import { afterEach, describe, expect, it } from "vitest";

import { V2OperationalService } from "./operational-service";
import type { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];
const timestamp = "2026-07-28T12:00:00.000Z";

function domainDependencies(): DomainDependencies {
  let sequence = 0;
  return { createId: () => `node_${++sequence}`, now: () => timestamp };
}

class FakeWorkspaces {
  public workspace: Workspace;
  public readonly writes: string[] = [];
  public readonly deleted: string[] = [];
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly backgroundCompletions = new Map<
    string,
    (result: { readonly session: TerminalSession; readonly output: string }) => void
  >();
  private readonly listeners = new Set<(event: V2TerminalEvent) => void>();

  public constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  public subscribe(listener: (event: V2TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async snapshot(): Promise<Workspace> {
    return this.workspace;
  }

  public async moveNodes(
    _workspaceId: string,
    positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  ): Promise<Workspace> {
    this.workspace = {
      ...this.workspace,
      nodes: this.workspace.nodes.map((node) =>
        positions[node.id] === undefined
          ? node
          : { ...node, position: requireValue(positions[node.id]) }
      )
    };
    return this.workspace;
  }

  public sessionForNode(_workspaceId: string, nodeId: string): TerminalSession | null {
    return this.sessions.get(nodeId) ?? null;
  }

  public async startTerminal(workspaceId: string, nodeId: string): Promise<TerminalSession> {
    const session: TerminalSession = {
      id: `session_${nodeId}`,
      workspaceId,
      terminalNodeId: nodeId,
      state: "running",
      startedAt: timestamp,
      lastActivityAt: timestamp,
      exitCode: null,
      exitSignal: null
    };
    this.sessions.set(nodeId, session);
    return session;
  }

  public async restartTerminal(workspaceId: string, nodeId: string): Promise<TerminalSession> {
    return this.startTerminal(workspaceId, nodeId);
  }

  public async writeTerminal(
    _workspaceId: string,
    _nodeId: string,
    _sessionId: string,
    data: string
  ): Promise<void> {
    this.writes.push(data);
  }

  public async startBackgroundAgentTask(input: {
    readonly workspaceId: string;
    readonly terminalId: string;
    readonly prompt: string;
  }): Promise<{
    readonly session: TerminalSession;
    readonly completion: Promise<{ readonly session: TerminalSession; readonly output: string }>;
  }> {
    const session = await this.startTerminal(input.workspaceId, input.terminalId);
    let resolveCompletion!: (result: {
      readonly session: TerminalSession;
      readonly output: string;
    }) => void;
    const completion = new Promise<{ readonly session: TerminalSession; readonly output: string }>(
      (resolve) => {
        resolveCompletion = resolve;
      }
    );
    this.backgroundCompletions.set(session.id, resolveCompletion);
    return { session, completion };
  }

  public finish(nodeId: string, state: "completed" | "failed" | "stopped"): void {
    const current = this.sessions.get(nodeId);
    if (current === undefined) throw new Error(`Missing fake session for ${nodeId}`);
    const session: TerminalSession = {
      ...current,
      state,
      endedAt: timestamp,
      exitCode: state === "completed" ? 0 : 1
    };
    this.sessions.set(nodeId, session);
    for (const listener of this.listeners) listener({ type: "terminal.state", session });
    this.backgroundCompletions.get(session.id)?.({ session, output: "" });
    this.backgroundCompletions.delete(session.id);
  }

  public async deleteNode(_workspaceId: string, nodeId: string): Promise<Workspace> {
    this.deleted.push(nodeId);
    this.workspace = {
      ...this.workspace,
      nodes: this.workspace.nodes.filter((node) => node.id !== nodeId),
      edges: this.workspace.edges.filter(
        (edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId
      )
    };
    this.sessions.delete(nodeId);
    return this.workspace;
  }
}

async function fixture(
  policy: "economy" | "standard" = "standard",
  notify?: () => boolean | Promise<boolean>
) {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-operations-"));
  roots.push(root);
  const repository = new V2WorkspaceRepository({ rootDirectory: root, now: () => timestamp });
  const domain = domainDependencies();
  let workspace = createWorkspace({ name: "Operations", workingDirectory: root }, domain);
  workspace = addTerminalNode(workspace, { title: "Orchestrator", orchestrator: true }, domain);
  workspace = addTerminalNode(
    workspace,
    { title: "Developer", orchestratorOwnerNodeId: "node_1" },
    domain
  );
  const orchestrator = requireValue(workspace.nodes[0]);
  const developer = requireValue(workspace.nodes[1]);
  workspace = addVisualEdge(workspace, orchestrator.id, developer.id, domain, [
    "send-message",
    "share-context"
  ]);
  await repository.create(workspace);
  const workspaces = new FakeWorkspaces(workspace);
  let sequence = 0;
  const service = new V2OperationalService({
    repository,
    workspaces: workspaces as unknown as V2WorkspaceService,
    createId: () => `operation_${++sequence}`,
    now: () => timestamp,
    ...(notify === undefined ? {} : { notify })
  });
  if (policy !== "standard") await service.updatePolicy(workspace.id, policy);
  return {
    repository,
    service,
    workspaces,
    workspace,
    orchestratorId: orchestrator.id,
    developerId: developer.id,
    edgeId: requireValue(workspace.edges[0]).id
  };
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("test fixture is incomplete");
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 operational service", () => {
  it("creates one run, records assignments and enforces the economy agent limit", async () => {
    const { service, workspace, orchestratorId, developerId } = await fixture("economy");
    const run = await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: developerId,
      roleId: "developer"
    });
    await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: "reviewer"
    });

    await expect(service.assertCanRecruit(workspace.id, orchestratorId)).rejects.toMatchObject({
      failure: { code: "AGENT_LIMIT_REACHED" }
    });
    const state = await service.get(workspace.id);
    expect(state.runs).toHaveLength(1);
    expect(state.assignments).toHaveLength(2);
    expect(run.policyId).toBe("economy");
  });

  it("keeps failed attempts and makes retry idempotent", async () => {
    const { service, workspaces, workspace, orchestratorId, developerId, edgeId } = await fixture();
    await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: developerId
    });
    await workspaces.startTerminal(workspace.id, developerId);
    await service.recordTaskSent({
      id: "task_1",
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      targetTerminalId: developerId,
      edgeId,
      title: "Implement",
      description: "Implement the landing page"
    });
    await service.recordTaskTerminalState(workspace.id, "task_1", "failed");

    const first = await service.retryTask(workspace.id, "task_1", "retry-key-0001");
    const repeated = await service.retryTask(workspace.id, "task_1", "retry-key-0001");
    const state = await service.get(workspace.id);
    const task = requireValue(state.tasks[0]);
    expect(first.id).toBe(repeated.id);
    expect(task).toMatchObject({ status: "running", attempt: 2, maxAttempts: 2 });
    expect(task.attempts).toHaveLength(2);
    expect(task.attempts[0]).toMatchObject({ status: "failed" });
    expect(workspaces.writes).toHaveLength(0);

    workspaces.finish(developerId, "completed");
    await expect
      .poll(async () => (await service.get(workspace.id)).tasks[0]?.status)
      .toBe("completed");
    expect((await service.get(workspace.id)).tasks[0]?.attempts[1]).toMatchObject({
      status: "completed"
    });
  });

  it("preserves history while reassigning a failed task", async () => {
    const { service, workspaces, workspace, orchestratorId, developerId, edgeId } = await fixture();
    await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: developerId
    });
    await service.recordTaskSent({
      id: "task_1",
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      targetTerminalId: developerId,
      edgeId,
      title: "Review",
      description: "Review the implementation"
    });
    await service.recordTaskTerminalState(workspace.id, "task_1", "failed");
    await workspaces.startTerminal(workspace.id, orchestratorId);
    await service.reassignTask(workspace.id, "task_1", orchestratorId, "reassign-key-0001");

    const state = await service.get(workspace.id);
    expect(state.tasks[0]).toMatchObject({
      assignedTerminalId: orchestratorId,
      attempt: 2,
      status: "running"
    });
    expect(state.events.some((event) => event.type === "task.reassigned")).toBe(true);
    expect(state.recoveryActions[0]).toMatchObject({ status: "completed" });
  });

  it("pauses administrative actions without stopping existing terminals", async () => {
    const { service, workspace, orchestratorId } = await fixture();
    const run = await service.assertAdministrativeAction(workspace.id, orchestratorId);
    await service.pauseRun(workspace.id, run.id);
    await expect(
      service.assertAdministrativeAction(workspace.id, orchestratorId)
    ).rejects.toMatchObject({ failure: { code: "ORCHESTRATOR_PERMISSION_DENIED" } });
    await service.resumeRun(workspace.id, run.id);
    await expect(
      service.assertAdministrativeAction(workspace.id, orchestratorId)
    ).resolves.toMatchObject({ status: "running" });
  });

  it("restores interrupted runs as recoverable instead of pretending processes survived", async () => {
    const { repository, service, workspaces, workspace, orchestratorId } = await fixture();
    const run = await service.assertAdministrativeAction(workspace.id, orchestratorId);
    const reloaded = new V2OperationalService({
      repository,
      workspaces: workspaces as unknown as V2WorkspaceService,
      createId: (() => {
        let sequence = 100;
        return () => `recovery_${++sequence}`;
      })(),
      now: () => timestamp
    });
    const restored = await reloaded.get(workspace.id);
    expect(restored.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: "needs-attention",
      failure: { code: "RUN_RECOVERY_REQUIRED" }
    });
    expect(restored.attention).toContainEqual(
      expect.objectContaining({ type: "recovery", status: "open" })
    );
  });

  it("deletes a recruited team and its associated operational persistence", async () => {
    const { service, workspaces, workspace, orchestratorId, developerId } = await fixture();
    const run = await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: developerId
    });
    await service.deleteTeam(workspace.id, run.id);
    const state = await service.get(workspace.id);
    expect(workspaces.deleted).toEqual([developerId]);
    expect(state.runs).toEqual([]);
    expect(state.assignments).toEqual([]);
    expect(state.events.filter((event) => event.runId === run.id)).toEqual([]);
  });

  it("records a controlled diagnostic event when native notification delivery is unavailable", async () => {
    const { service, workspace, orchestratorId, developerId, edgeId } = await fixture(
      "standard",
      () => false
    );
    await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: developerId
    });
    await service.recordTaskSent({
      id: "task_notification",
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      targetTerminalId: developerId,
      edgeId,
      title: "Finish",
      description: "Finish safely"
    });
    await service.recordTaskTerminalState(workspace.id, "task_notification", "completed");

    expect((await service.get(workspace.id)).events).toContainEqual(
      expect.objectContaining({
        type: "notification.failed",
        metadata: expect.objectContaining({ code: "NOTIFICATION_FAILED" })
      })
    );
  });

  it("creates, deduplicates and dismisses structured attention requests", async () => {
    const { service, workspace, orchestratorId } = await fixture();
    const run = await service.assertAdministrativeAction(workspace.id, orchestratorId);
    const first = await service.createAttention({
      workspaceId: workspace.id,
      terminalId: orchestratorId,
      severity: "blocking",
      type: "question",
      title: "Decisão necessária",
      description: "Escolha a alternativa segura.",
      idempotencyKey: "attention-key-0001"
    });
    const duplicate = await service.createAttention({
      workspaceId: workspace.id,
      terminalId: orchestratorId,
      severity: "blocking",
      type: "question",
      title: "Decisão necessária",
      idempotencyKey: "attention-key-0001"
    });

    expect(duplicate.id).toBe(first.id);
    expect((await service.get(workspace.id)).runs.find((item) => item.id === run.id)?.status).toBe(
      "needs-attention"
    );
    await service.resolveAttention(workspace.id, first.id, "dismissed");
    expect((await service.get(workspace.id)).attention).toContainEqual(
      expect.objectContaining({ id: first.id, status: "dismissed" })
    );
  });

  it("enforces economy retry exhaustion and applies a later performance policy to new runs", async () => {
    const { service, workspace, orchestratorId, developerId, edgeId } = await fixture("economy");
    const economyRun = await service.recordRecruit({
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      terminalId: developerId
    });
    await service.recordTaskSent({
      id: "task_economy",
      workspaceId: workspace.id,
      orchestratorTerminalId: orchestratorId,
      targetTerminalId: developerId,
      edgeId,
      title: "Economy task",
      description: "Economy task"
    });
    await service.recordTaskTerminalState(workspace.id, "task_economy", "failed");
    await expect(
      service.retryTask(workspace.id, "task_economy", "economy-retry-1")
    ).rejects.toMatchObject({ failure: { code: "TASK_RETRY_EXHAUSTED" } });

    await service.cancelRun(workspace.id, economyRun.id);
    await service.updatePolicy(workspace.id, "high-performance");
    const performanceRun = await service.assertAdministrativeAction(workspace.id, orchestratorId);
    expect(performanceRun.policyId).toBe("high-performance");
    expect((await service.get(workspace.id)).events.map((event) => event.type)).toContain(
      "policy.changed"
    );
  });

  it("keeps independent runs for two orchestrators in the same workspace", async () => {
    const { service, workspaces, workspace, orchestratorId } = await fixture();
    workspaces.workspace = addTerminalNode(
      workspaces.workspace,
      { title: "Second orchestrator", orchestrator: true },
      { createId: () => "second_orchestrator", now: () => timestamp }
    );
    const secondOrchestrator = requireValue(
      workspaces.workspace.nodes.find(
        (node) => node.type === "terminal" && node.id !== orchestratorId && node.orchestrator
      )
    );
    const first = await service.assertAdministrativeAction(workspace.id, orchestratorId);
    const second = await service.assertAdministrativeAction(workspace.id, secondOrchestrator.id);

    expect(first.id).not.toBe(second.id);
    expect((await service.get(workspace.id)).runs).toHaveLength(2);
  });

  it("marks an orchestrator process loss as a recoverable disconnection", async () => {
    const { service, workspace, orchestratorId } = await fixture();
    const run = await service.assertAdministrativeAction(workspace.id, orchestratorId);
    await service.recordProcessFailure(workspace.id, orchestratorId);

    expect((await service.get(workspace.id)).runs.find((item) => item.id === run.id)).toMatchObject(
      {
        status: "needs-attention",
        failure: { code: "ORCHESTRATOR_DISCONNECTED", retryable: true }
      }
    );
  });
});
