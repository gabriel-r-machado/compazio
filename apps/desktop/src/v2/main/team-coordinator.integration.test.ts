import { mkdtemp, rm } from "node:fs/promises";
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
  TransportProcessFactory
} from "@forgedeck/terminal";
import { afterEach, describe, expect, it } from "vitest";

import { V2OperationalService } from "./operational-service";
import { TeamCoordinator, type TeamCoordinatorError } from "./team-coordinator";
import { isolatedTestEntitlement } from "./testing/isolated-entitlement";
import { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamCoordinator", () => {
  it("proves the persisted Claude Compazio → Codex fake flow through dismissal and reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-compazio-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 75 }
    );
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "roles"))
    });
    await agents.setExecutablePath("claude-code", process.execPath);
    await agents.setExecutablePath("codex", process.execPath);
    const workspaces = new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement: isolatedTestEntitlement(root)
    });
    Object.defineProperty(workspaces, "startBackgroundAgentTask", { value: undefined });
    const operations = new V2OperationalService({ repository, workspaces });
    const teams = new TeamCoordinator({
      workspaces,
      operations,
      agents,
      createId: deterministicIds(),
      readinessTimeoutMs: 2_000
    });

    try {
      const workspace = await workspaces.create({
        name: "Equipe",
        workingDirectory: process.cwd()
      });
      const withCompazio = await workspaces.addTerminal(workspace.id, {
        title: "Claude Compazio",
        isCompazio: true,
        agentConfig: { agentId: "claude-code" }
      });
      const compazio = terminalByTitle(withCompazio, "Claude Compazio");
      await workspaces.startTerminal(workspace.id, compazio.id);
      const withCommon = await workspaces.addTerminal(workspace.id, {
        title: "Claude comum",
        agentConfig: { agentId: "claude-code" }
      });
      const common = terminalByTitle(withCommon, "Claude comum");
      await workspaces.startTerminal(workspace.id, common.id);
      const withFixture = await workspaces.addNote(workspace.id, {
        title: "Fixture autorizada",
        content: "Contexto determinístico da revisão."
      });
      const fixtureNote = withFixture.nodes.find(
        (node) => node.type === "note" && node.title === "Fixture autorizada"
      );
      if (fixtureNote?.type !== "note") throw new Error("fixture note missing");
      await workspaces.addEdge(workspace.id, compazio.id, fixtureNote.id, [
        "share-context",
        "read-note"
      ]);

      await expect(
        teams.recruit({
          workspaceId: workspace.id,
          compazioTerminalId: common.id,
          agentType: "codex",
          role: { name: "Test Engineer", responsibilities: ["Revisar a fixture."] },
          idempotencyKey: "common-terminal-denied-0001"
        })
      ).rejects.toMatchObject({
        code: "TEAM_RECRUIT_CAPABILITY_DENIED"
      } satisfies Partial<TeamCoordinatorError>);

      const recruited = await teams.recruit({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        agentType: "codex",
        displayName: "Codex Test Engineer",
        role: {
          name: "Test Engineer",
          description: "Valida a fixture offline.",
          responsibilities: ["Revisar a fixture.", "Devolver um relatório curto."]
        },
        initialTask: {
          title: "Revisar fixture determinística",
          description: "Leia a fixture autorizada e devolva um relatório JSON curto.",
          contextRefs: [fixtureNote.id]
        },
        idempotencyKey: "claude-recruit-codex-0001"
      });
      expect(recruited.member).toMatchObject({
        agentType: "codex",
        role: { name: "Test Engineer" },
        status: "working",
        recruitedByTerminalId: compazio.id
      });
      expect(recruited.task).toMatchObject({
        status: "running",
        assignedToTerminalId: recruited.member.terminalId
      });
      expect(workspaces.sessionForNode(workspace.id, recruited.member.terminalId)).toBeNull();
      const notebookNodeId = (
        recruited.member as typeof recruited.member & { readonly notebookNodeId?: string }
      ).notebookNodeId;
      expect(notebookNodeId).toBeTypeOf("string");
      const workspaceWithNotebook = await workspaces.snapshot(workspace.id);
      expect(workspaceWithNotebook.nodes).toContainEqual(
        expect.objectContaining({
          id: notebookNodeId,
          type: "note",
          title: "Caderno — Codex Test Engineer",
          content: expect.stringContaining("## Bloqueios e perguntas")
        })
      );
      expect(workspaceWithNotebook.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceNodeId: compazio.id,
            targetNodeId: notebookNodeId,
            capabilities: expect.arrayContaining(["share-context", "read-note", "write-note"])
          }),
          expect.objectContaining({
            sourceNodeId: recruited.member.terminalId,
            targetNodeId: notebookNodeId,
            capabilities: expect.arrayContaining(["share-context", "read-note", "write-note"])
          })
        ])
      );

      const replay = await teams.recruit({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        agentType: "codex",
        role: { name: "Test Engineer", responsibilities: ["Revisar a fixture."] },
        idempotencyKey: "claude-recruit-codex-0001"
      });
      expect(replay.member.id).toBe(recruited.member.id);

      const beforeResult = await operations.get(workspace.id);
      const taskMessage = beforeResult.messages.find(
        (message) =>
          message.taskId === recruited.task?.id &&
          message.toTerminalId === recruited.member.terminalId
      );
      if (taskMessage === undefined || recruited.task === undefined)
        throw new Error("fixture task delivery missing");
      await teams.sendMessage({
        workspaceId: workspace.id,
        fromTerminalId: recruited.member.terminalId,
        toTerminalId: compazio.id,
        taskId: recruited.task.id,
        type: "progress",
        content: "Recebido; iniciando a revisÃ£o da fixture.",
        idempotencyKey: "codex-fixture-ack-0001"
      });
      const completed = await teams.taskResult({
        workspaceId: workspace.id,
        requesterId: recruited.member.terminalId,
        taskId: recruited.task.id,
        result: {
          summary:
            '{"totalFiles":3,"hasForm":true,"hasCounter":true,"hasDownload":true,"recommendation":"ok"}'
        },
        idempotencyKey: "codex-fixture-result-0001"
      });
      expect(completed).toMatchObject({
        status: "completed",
        result: { summary: expect.stringContaining("totalFiles") }
      });

      const delivered = await operations.get(workspace.id);
      expect(delivered.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: taskMessage.id, status: "acknowledged" }),
          expect.objectContaining({
            type: "progress",
            toTerminalId: compazio.id,
            status: "delivered"
          }),
          expect.objectContaining({
            type: "result",
            toTerminalId: compazio.id,
            status: "delivered"
          })
        ])
      );
      const connection = (await workspaces.snapshot(workspace.id)).edges.find(
        (edge) =>
          edge.sourceNodeId === compazio.id && edge.targetNodeId === recruited.member.terminalId
      );
      expect(connection?.capabilities).toEqual(
        expect.arrayContaining(["send-message", "task-delegate", "result-return", "share-context"])
      );

      await teams.dismiss({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        teamMemberId: recruited.member.id,
        reason: "Resultado recebido"
      });
      expect(workspaces.sessionForNode(workspace.id, recruited.member.terminalId)).toBeNull();
      const dismissed = await operations.get(workspace.id);
      expect(dismissed.teamMembers).toContainEqual(
        expect.objectContaining({ id: recruited.member.id, status: "dismissed" })
      );
      expect(dismissed.teamTasks).toContainEqual(
        expect.objectContaining({ id: completed.id, result: completed.result, status: "completed" })
      );
      expect((await workspaces.snapshot(workspace.id)).nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: recruited.member.terminalId, type: "terminal" })
        ])
      );
      expect(
        terminalByTitle(await workspaces.snapshot(workspace.id), "Codex Test Engineer")
      ).toMatchObject({
        orchestratorOwnerNodeId: undefined
      });
      expect(
        (await workspaces.snapshot(workspace.id)).edges.some((edge) => edge.id === connection?.id)
      ).toBe(false);

      const reloaded = new V2OperationalService({ repository, workspaces });
      expect((await reloaded.get(workspace.id)).teamTasks).toContainEqual(
        expect.objectContaining({ id: completed.id, status: "completed", result: completed.result })
      );
    } finally {
      await workspaces.shutdown();
    }
  }, 20_000);

  it("proves the persisted Codex Compazio → Claude fake flow through result, dismissal and reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-compazio-codex-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 75 }
    );
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "roles"))
    });
    await agents.setExecutablePath("claude-code", process.execPath);
    await agents.setExecutablePath("codex", process.execPath);
    const workspaces = new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement: isolatedTestEntitlement(root)
    });
    Object.defineProperty(workspaces, "startBackgroundAgentTask", { value: undefined });
    const operations = new V2OperationalService({ repository, workspaces });
    const teams = new TeamCoordinator({
      workspaces,
      operations,
      agents,
      createId: deterministicIds(),
      readinessTimeoutMs: 2_000
    });

    try {
      const workspace = await workspaces.create({
        name: "Equipe Codex",
        workingDirectory: process.cwd()
      });
      const withTerminals = await workspaces.addTerminal(workspace.id, {
        title: "Codex Compazio",
        isCompazio: true,
        agentConfig: { agentId: "codex" }
      });
      const compazio = terminalByTitle(withTerminals, "Codex Compazio");
      await workspaces.startTerminal(workspace.id, compazio.id);
      const withCommon = await workspaces.addTerminal(workspace.id, {
        title: "Codex comum",
        agentConfig: { agentId: "codex" }
      });
      const common = terminalByTitle(withCommon, "Codex comum");
      await workspaces.startTerminal(workspace.id, common.id);
      const withFixture = await workspaces.addNote(workspace.id, {
        title: "Fixture de arquitetura autorizada",
        content: "Contexto determinístico de autorização, lifecycle e cleanup."
      });
      const fixtureNote = withFixture.nodes.find(
        (node) => node.type === "note" && node.title === "Fixture de arquitetura autorizada"
      );
      if (fixtureNote?.type !== "note") throw new Error("architecture fixture note missing");
      await workspaces.addEdge(workspace.id, compazio.id, fixtureNote.id, [
        "share-context",
        "read-note"
      ]);

      await expect(
        teams.recruit({
          workspaceId: workspace.id,
          compazioTerminalId: common.id,
          agentType: "claude-code",
          role: { name: "Architecture Reviewer", responsibilities: ["Revisar limites."] },
          idempotencyKey: "codex-common-denied-0001"
        })
      ).rejects.toMatchObject({
        code: "TEAM_RECRUIT_CAPABILITY_DENIED"
      } satisfies Partial<TeamCoordinatorError>);

      const recruited = await teams.recruit({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        agentType: "claude-code",
        displayName: "Claude Architecture Reviewer",
        role: {
          name: "Architecture Reviewer",
          description: "Revisa arquitetura e limites da fixture.",
          responsibilities: ["Identificar riscos.", "Devolver recomendação estruturada."]
        },
        initialTask: {
          title: "Revisar arquitetura da fixture",
          description: "Analise a autorização, lifecycle e cleanup; devolva a revisão estruturada.",
          contextRefs: [fixtureNote.id]
        },
        idempotencyKey: "codex-recruit-claude-0001"
      });
      expect(recruited.member).toMatchObject({
        agentType: "claude-code",
        role: { name: "Architecture Reviewer" },
        status: "working",
        recruitedByTerminalId: compazio.id
      });
      expect(recruited.task).toMatchObject({
        status: "running",
        assignedToTerminalId: recruited.member.terminalId
      });
      expect(workspaces.sessionForNode(workspace.id, recruited.member.terminalId)).toBeNull();

      if (recruited.task === undefined) throw new Error("fixture task missing");
      await teams.sendMessage({
        workspaceId: workspace.id,
        fromTerminalId: recruited.member.terminalId,
        toTerminalId: compazio.id,
        taskId: recruited.task.id,
        type: "progress",
        content: "Revisão recebida; analisando a fixture.",
        idempotencyKey: "claude-fixture-ack-0001"
      });
      const completed = await teams.taskResult({
        workspaceId: workspace.id,
        requesterId: recruited.member.terminalId,
        taskId: recruited.task.id,
        result: {
          summary:
            '{"summary":"Arquitetura aprovada","risks":["nenhum bloqueio"],"recommendations":["manter capability"],"approved":true}'
        },
        idempotencyKey: "claude-fixture-result-0001"
      });
      expect(completed.status).toBe("completed");
      expect((await operations.get(workspace.id)).messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "result",
            fromTerminalId: recruited.member.terminalId,
            toTerminalId: compazio.id,
            status: "delivered"
          })
        ])
      );

      await teams.dismiss({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        teamMemberId: recruited.member.id,
        reason: "Revisão recebida"
      });
      expect(workspaces.sessionForNode(workspace.id, recruited.member.terminalId)).toBeNull();
      const reloaded = new V2OperationalService({ repository, workspaces });
      expect((await reloaded.get(workspace.id)).teamMembers).toContainEqual(
        expect.objectContaining({
          id: recruited.member.id,
          agentType: "claude-code",
          status: "dismissed"
        })
      );
      expect((await reloaded.get(workspace.id)).teamTasks).toContainEqual(
        expect.objectContaining({ id: completed.id, status: "completed", result: completed.result })
      );
    } finally {
      await workspaces.shutdown();
    }
  }, 20_000);

  it("runs a mixed dependent team through worker context, review, reload and cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-compazio-mixed-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 75 }
    );
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "roles"))
    });
    await agents.setExecutablePath("claude-code", process.execPath);
    await agents.setExecutablePath("codex", process.execPath);
    const workspaces = new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement: isolatedTestEntitlement(root)
    });
    Object.defineProperty(workspaces, "startBackgroundAgentTask", { value: undefined });
    const operations = new V2OperationalService({ repository, workspaces });
    const teams = new TeamCoordinator({
      workspaces,
      operations,
      agents,
      createId: deterministicIds(),
      readinessTimeoutMs: 2_000
    });
    try {
      const workspace = await workspaces.create({
        name: "Equipe mista",
        workingDirectory: process.cwd()
      });
      const created = await workspaces.addTerminal(workspace.id, {
        title: "Claude Compazio",
        isCompazio: true,
        agentConfig: { agentId: "claude-code" }
      });
      const compazio = terminalByTitle(created, "Claude Compazio");
      await workspaces.startTerminal(workspace.id, compazio.id);

      const run = await teams.createRun({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        title: "API Tasks",
        objective: "Produzir e revisar uma proposta de contrato de API para tarefas.",
        idempotencyKey: "mixed-dependent-run-0001",
        members: [
          {
            agentType: "codex",
            displayName: "Codex Implementation Engineer",
            role: {
              name: "Implementation Engineer",
              responsibilities: ["Definir contrato de API."]
            }
          },
          {
            agentType: "claude-code",
            displayName: "Claude Architecture Reviewer",
            role: { name: "Architecture Reviewer", responsibilities: ["Revisar o contrato."] }
          }
        ],
        tasks: [
          {
            key: "implementation",
            title: "Definir POST /tasks",
            description: "Retorne o contrato estruturado.",
            assignedMemberName: "Codex Implementation Engineer"
          },
          {
            key: "review",
            title: "Revisar contrato de tarefas",
            description: "Revise a proposta e devolva uma opinião estruturada.",
            assignedMemberName: "Claude Architecture Reviewer",
            dependsOn: ["implementation"],
            reviewOf: "implementation"
          }
        ]
      });
      expect(run.run.status).toBe("running");
      expect(run.members.map((member) => member.agentType).sort()).toEqual([
        "claude-code",
        "codex"
      ]);
      const implementation = run.tasks.find((task) => task.title === "Definir POST /tasks");
      const review = run.tasks.find((task) => task.title === "Revisar contrato de tarefas");
      if (implementation === undefined || review === undefined)
        throw new Error("mixed run task fixture missing");
      expect(implementation.status).toBe("running");
      expect(review.status).toBe("blocked");
      expect(review.blockedBy).toEqual([implementation.id]);

      const implementer = run.members.find((member) => member.agentType === "codex");
      const reviewer = run.members.find((member) => member.agentType === "claude-code");
      if (implementer === undefined || reviewer === undefined)
        throw new Error("mixed run members missing");
      await expect(
        teams.sendMessage({
          workspaceId: workspace.id,
          fromTerminalId: implementer.terminalId,
          toTerminalId: reviewer.terminalId,
          type: "progress",
          content: "Tentativa sem conexão autorizada.",
          idempotencyKey: "worker-worker-denied-0001"
        })
      ).rejects.toMatchObject({
        code: "TEAM_CONNECTION_REQUIRED"
      } satisfies Partial<TeamCoordinatorError>);
      const instructed = await teams.instructRun({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        runId: run.run.id,
        affectedMemberName: implementer.displayName,
        instruction: "Simplifique o contrato e mantenha somente os campos essenciais.",
        idempotencyKey: "mixed-run-instruction-0001"
      });
      expect(instructed.adjustment).toMatchObject({
        status: "blocked",
        blockedBy: [implementation.id],
        assignedToTerminalId: implementer.terminalId
      });
      expect(instructed.review).toMatchObject({
        id: review.id,
        status: "blocked",
        reviewOf: instructed.adjustment.id,
        blockedBy: [instructed.adjustment.id]
      });
      await teams.taskResult({
        workspaceId: workspace.id,
        requesterId: implementer.terminalId,
        taskId: implementation.id,
        idempotencyKey: "implementation-result-0001",
        result: {
          summary:
            '{"endpoint":"/tasks","method":"POST","requestFields":["title"],"responseStatus":201,"testsSuggested":["missing title","valid title"]}'
        }
      });
      const released = await operations.get(workspace.id);
      const releasedAdjustment = released.teamTasks.find(
        (task) => task.id === instructed.adjustment.id
      );
      const stillBlockedReview = released.teamTasks.find((task) => task.id === review.id);
      expect(releasedAdjustment).toMatchObject({
        status: "running",
        resultRefs: [implementation.id]
      });
      expect(stillBlockedReview).toMatchObject({
        status: "blocked",
        blockedBy: [instructed.adjustment.id]
      });
      if (releasedAdjustment === undefined) throw new Error("adjustment was not released");
      await teams.taskResult({
        workspaceId: workspace.id,
        requesterId: implementer.terminalId,
        taskId: releasedAdjustment.id,
        idempotencyKey: "adjustment-result-0001",
        result: { summary: '{"updated":true,"fields":["title"]}' }
      });
      const afterAdjustment = await operations.get(workspace.id);
      const releasedReview = afterAdjustment.teamTasks.find((task) => task.id === review.id);
      expect(releasedReview).toMatchObject({
        status: "running",
        resultRefs: [instructed.adjustment.id]
      });
      const reviewConnection = (await workspaces.snapshot(workspace.id)).edges.find(
        (edge) =>
          edge.sourceNodeId === implementer.terminalId && edge.targetNodeId === reviewer.terminalId
      );
      expect(reviewConnection?.capabilities).toEqual(
        expect.arrayContaining(["send-message", "review-request"])
      );
      const contextMessage = afterAdjustment.messages.find(
        (message) =>
          message.fromTerminalId === implementer.terminalId &&
          message.toTerminalId === reviewer.terminalId
      );
      expect(contextMessage).toMatchObject({ type: "result", status: "delivered" });
      if (contextMessage === undefined) throw new Error("dependency context missing");
      await teams.acknowledgeMessage(workspace.id, reviewer.terminalId, contextMessage.id);

      await teams.taskResult({
        workspaceId: workspace.id,
        requesterId: reviewer.terminalId,
        taskId: review.id,
        idempotencyKey: "review-result-0001",
        result: {
          summary:
            '{"approved":true,"risks":["versioning"],"recommendations":["document errors"],"reviewedEndpoint":"/tasks"}'
        }
      });
      const complete = await operations.get(workspace.id);
      expect(complete.teamRuns.find((candidate) => candidate.id === run.run.id)?.status).toBe(
        "completed"
      );
      expect(complete.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: contextMessage.id, status: "acknowledged" })
        ])
      );

      await operations.updatePolicy(workspace.id, "economy", compazio.id);
      const nodesBeforeRejectedPlan = (await workspaces.snapshot(workspace.id)).nodes.length;
      await expect(
        teams.createRun({
          workspaceId: workspace.id,
          compazioTerminalId: compazio.id,
          title: "Equipe acima do orçamento",
          objective: "O Econômico deve impedir dois workers antes do recrutamento.",
          idempotencyKey: "economy-budget-rejection-0001",
          members: [
            {
              agentType: "codex",
              displayName: "Builder econômico",
              role: { name: "Builder", responsibilities: ["Construir"] }
            },
            {
              agentType: "claude-code",
              displayName: "QA econômico",
              role: { name: "Reviewer", responsibilities: ["Revisar"] }
            }
          ],
          tasks: [
            {
              key: "build",
              title: "Construir",
              description: "Construir",
              assignedMemberName: "Builder econômico"
            }
          ]
        })
      ).rejects.toMatchObject({ code: "TEAM_TASK_ASSIGNMENT_CONFLICT" });
      expect((await workspaces.snapshot(workspace.id)).nodes).toHaveLength(nodesBeforeRejectedPlan);

      await expect(
        teams.createRun({
          workspaceId: workspace.id,
          compazioTerminalId: compazio.id,
          title: "Ciclo",
          objective: "Não deve criar.",
          idempotencyKey: "cycle-run-0001",
          members: [
            {
              agentType: "codex",
              displayName: "Duplicado",
              role: { name: "Worker", responsibilities: ["Nada"] }
            }
          ],
          tasks: [
            {
              key: "a",
              title: "A",
              description: "A",
              assignedMemberName: "Duplicado",
              dependsOn: ["b"]
            },
            {
              key: "b",
              title: "B",
              description: "B",
              assignedMemberName: "Duplicado",
              dependsOn: ["a"]
            }
          ]
        })
      ).rejects.toMatchObject({
        code: "TEAM_TASK_DEPENDENCY_CYCLE"
      } satisfies Partial<TeamCoordinatorError>);

      await teams.cancelRun({
        workspaceId: workspace.id,
        compazioTerminalId: compazio.id,
        runId: run.run.id,
        dismissMembers: true
      });
      expect(workspaces.sessionForNode(workspace.id, implementer.terminalId)).toBeNull();
      expect(workspaces.sessionForNode(workspace.id, reviewer.terminalId)).toBeNull();
      const reloaded = new V2OperationalService({ repository, workspaces });
      await expect(reloaded.get(workspace.id)).resolves.toMatchObject({
        teamRuns: [expect.objectContaining({ id: run.run.id, status: "cancelled" })],
        teamTasks: expect.arrayContaining([
          expect.objectContaining({ id: review.id, status: "completed" })
        ])
      });
    } finally {
      await workspaces.shutdown();
    }
  }, 30_000);
  it("persists a bounded root → recruit-limited worker → subworker tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-hierarchy-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 75 }
    );
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "roles"))
    });
    await agents.setExecutablePath("claude-code", process.execPath);
    await agents.setExecutablePath("codex", process.execPath);
    const workspaces = new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement: isolatedTestEntitlement(root)
    });
    Object.defineProperty(workspaces, "startBackgroundAgentTask", { value: undefined });
    const operations = new V2OperationalService({ repository, workspaces });
    const teams = new TeamCoordinator({
      workspaces,
      operations,
      agents,
      readinessTimeoutMs: 2_000
    });
    try {
      const workspace = await workspaces.create({ name: "Hierarchy", workingDirectory: root });
      const configured = await workspaces.addTerminal(workspace.id, {
        title: "Claude COMPAZIO",
        isCompazio: true,
        agentConfig: { agentId: "claude-code" }
      });
      const rootTerminal = terminalByTitle(configured, "Claude COMPAZIO");
      await workspaces.startTerminal(workspace.id, rootTerminal.id);
      const run = await teams.createRun({
        workspaceId: workspace.id,
        compazioTerminalId: rootTerminal.id,
        title: "Hierarchy",
        objective: "Implement and independently review one visual change.",
        members: [
          {
            agentType: "codex",
            displayName: "Codex Worker",
            grantRecruitLimited: true,
            role: { name: "Worker", responsibilities: ["Implement the visual change."] }
          }
        ],
        tasks: [
          {
            key: "implement",
            title: "Implement",
            description: "Make the visual change.",
            assignedMemberName: "Codex Worker"
          }
        ],
        idempotencyKey: "hierarchy-run-0001"
      });
      const worker = run.members[0];
      if (worker === undefined) throw new Error("worker fixture missing");
      expect(worker).toMatchObject({
        depth: 1,
        grantedCapabilities: ["recruit-limited"],
        runId: run.run.id
      });
      expect(await teams.capabilitiesForTerminal(workspace.id, worker.terminalId)).toEqual(
        expect.arrayContaining(["team-recruit", "task-create", "task-assign"])
      );
      const subworker = await teams.recruit({
        workspaceId: workspace.id,
        compazioTerminalId: worker.terminalId,
        agentType: "claude-code",
        displayName: "Claude Subreviewer",
        role: { name: "Subreviewer", responsibilities: ["Review the implementation."] },
        idempotencyKey: "hierarchy-subreview-0001"
      });
      expect(subworker.member).toMatchObject({
        parentTerminalId: worker.terminalId,
        recruitedByTerminalId: worker.terminalId,
        depth: 2,
        grantedCapabilities: [],
        runId: run.run.id
      });
      expect(
        await teams.capabilitiesForTerminal(workspace.id, subworker.member.terminalId)
      ).not.toContain("team-recruit");
      await expect(
        teams.recruit({
          workspaceId: workspace.id,
          compazioTerminalId: subworker.member.terminalId,
          agentType: "codex",
          role: { name: "Forbidden", responsibilities: ["Must not recruit."] },
          idempotencyKey: "hierarchy-depth-denied-0001"
        })
      ).rejects.toMatchObject({ code: "TEAM_RECRUIT_DEPTH_LIMIT" });
      const reloaded = await operations.get(workspace.id);
      expect(reloaded.teamRuns.find((candidate) => candidate.id === run.run.id)).toMatchObject({
        recruitmentPolicy: {
          maxDepth: 2,
          maxActiveAgentsPerRun: 5,
          maxChildrenPerAgent: 2,
          maxTotalRecruitmentsPerRun: 8
        }
      });
      await teams.dismiss({
        workspaceId: workspace.id,
        compazioTerminalId: rootTerminal.id,
        teamMemberId: worker.id,
        reason: "recursive cleanup fixture"
      });
      expect(workspaces.sessionForNode(workspace.id, worker.terminalId)).toBeNull();
      expect(workspaces.sessionForNode(workspace.id, subworker.member.terminalId)).toBeNull();
      expect((await operations.get(workspace.id)).teamMembers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: worker.id, status: "dismissed" }),
          expect.objectContaining({ id: subworker.member.id, status: "dismissed" })
        ])
      );
    } finally {
      await workspaces.shutdown();
    }
  }, 30_000);
});

function terminalByTitle(
  workspace: Awaited<ReturnType<V2WorkspaceService["snapshot"]>>,
  title: string
) {
  const terminal = workspace.nodes.find((node) => node.type === "terminal" && node.title === title);
  if (terminal?.type !== "terminal") throw new Error(`terminal fixture missing: ${title}`);
  return terminal;
}

function deterministicIds(): () => string {
  let counter = 0;
  return () => `team_${++counter}`;
}
