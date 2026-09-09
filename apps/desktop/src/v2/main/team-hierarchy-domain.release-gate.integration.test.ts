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
import { afterEach, describe, expect, it, vi } from "vitest";

import { V2OperationalService } from "./operational-service";
import type { PortalRuntimeManager } from "./portal-runtime-manager";
import { TeamCoordinator, TeamCoordinatorError } from "./team-coordinator";
import { isolatedTestEntitlement } from "./testing/isolated-entitlement";
import { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("beta.3 hierarchical delegation domain", () => {
  it("HIER-05 through HIER-07 enforce child, active, and lifetime recruitment limits atomically", async () => {
    const fixture = await operationFixture();
    try {
      const parent = "root-parent";
      const workerA = await reserve(fixture, "worker-a", parent, 1);
      await reserve(fixture, "worker-a-child-1", workerA.terminalId, 2);
      await reserve(fixture, "worker-a-child-2", workerA.terminalId, 2);
      await expect(
        reserve(fixture, "worker-a-child-3", workerA.terminalId, 2)
      ).rejects.toMatchObject({
        failure: { code: "TEAM_RECRUIT_CHILD_LIMIT" }
      });

      const workerB = await reserve(fixture, "worker-b", parent, 1);
      await reserve(fixture, "worker-b-child-1", workerB.terminalId, 2);
      await expect(
        reserve(fixture, "worker-b-child-2", workerB.terminalId, 2)
      ).rejects.toMatchObject({
        failure: { code: "TEAM_RECRUIT_ACTIVE_LIMIT" }
      });

      for (const member of (await fixture.operations.get(fixture.workspace.id)).teamMembers) {
        await fixture.operations.dismissTeamMember(fixture.workspace.id, member.terminalId, parent);
      }
      await reserve(fixture, "budget-6", "budget-parent-6", 1);
      await reserve(fixture, "budget-7", "budget-parent-7", 1);
      await reserve(fixture, "budget-8", "budget-parent-8", 1);
      await expect(reserve(fixture, "budget-9", "budget-parent-9", 1)).rejects.toMatchObject({
        failure: { code: "TEAM_RECRUIT_BUDGET_EXCEEDED" }
      });
    } finally {
      await fixture.close();
    }
  });

  it("HIER-11 allows exactly one concurrent reservation for the final active slot", async () => {
    const fixture = await operationFixture();
    try {
      const parent = "root-parent";
      const a = await reserve(fixture, "concurrent-a", parent, 1);
      const b = await reserve(fixture, "concurrent-b", parent, 1);
      await reserve(fixture, "concurrent-a-child", a.terminalId, 2);
      await reserve(fixture, "concurrent-b-child", b.terminalId, 2);
      const results = await Promise.allSettled([
        reserve(fixture, "concurrent-final-a", a.terminalId, 2),
        reserve(fixture, "concurrent-final-b", b.terminalId, 2)
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: { failure: { code: "TEAM_RECRUIT_ACTIVE_LIMIT" } }
      });
    } finally {
      await fixture.close();
    }
  });

  it("HIER-12 recruits without spawning a duplicate person-facing TUI", async () => {
    const fixture = await runtimeFixture();
    try {
      const failedRun = await fixture.operations.createTeamRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "forced failure",
        objective: "verify reservation release",
        idempotencyKey: "hier-spawn-fail-0001"
      });
      const startTerminal = vi.spyOn(fixture.workspaces, "startTerminal");
      const recruited = await fixture.teams.recruit({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        agentType: "codex",
        displayName: "managed worker",
        role: role("worker"),
        idempotencyKey: "hier-managed-worker-0001"
      });
      expect(startTerminal).not.toHaveBeenCalled();
      expect(recruited.member.status).toBe("ready");
      const state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((candidate) => candidate.id === failedRun.id)?.memberIds).toEqual([
        recruited.member.id
      ]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("HIER-10 revokes a persisted grant before the next recruit request", async () => {
    const fixture = await runtimeFixture();
    try {
      const run = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "revocation",
        objective: "verify revocation",
        members: [
          {
            agentType: "codex",
            displayName: "limited",
            role: role("worker"),
            grantRecruitLimited: true
          }
        ],
        tasks: [{ key: "task", title: "task", description: "task", assignedMemberName: "limited" }],
        idempotencyKey: "hier-revoke-run-0001"
      });
      const worker = run.members[0];
      if (worker === undefined) throw new Error("missing worker");
      await fixture.teams.revokeRecruitLimited({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        teamMemberId: worker.id
      });
      expect(
        await fixture.teams.capabilitiesForTerminal(fixture.workspace.id, worker.terminalId)
      ).not.toContain("team-recruit");
      await expect(
        fixture.teams.recruit({
          workspaceId: fixture.workspace.id,
          compazioTerminalId: worker.terminalId,
          agentType: "claude-code",
          role: role("subworker"),
          idempotencyKey: "hier-revoked-denial-0001"
        })
      ).rejects.toMatchObject({ code: "TEAM_RECRUIT_CAPABILITY_DENIED" });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("HIER-03 and HIER-09 deny a worker without a grant and self-assigned recruit-limited", async () => {
    const fixture = await runtimeFixture();
    try {
      const run = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "capability denial",
        objective: "verify bounded grants",
        members: [
          { agentType: "codex", displayName: "plain", role: role("plain") },
          {
            agentType: "claude-code",
            displayName: "limited",
            role: role("limited"),
            grantRecruitLimited: true
          }
        ],
        tasks: [
          { key: "plain", title: "plain", description: "plain", assignedMemberName: "plain" },
          {
            key: "limited",
            title: "limited",
            description: "limited",
            assignedMemberName: "limited"
          }
        ],
        idempotencyKey: "hier-capability-run-0001"
      });
      const plain = run.members.find((member) => member.displayName === "plain");
      const limited = run.members.find((member) => member.displayName === "limited");
      if (plain === undefined || limited === undefined) throw new Error("workers missing");
      await expect(
        fixture.teams.recruit({
          workspaceId: fixture.workspace.id,
          compazioTerminalId: plain.terminalId,
          agentType: "claude-code",
          role: role("forbidden"),
          idempotencyKey: "hier-plain-denied-0001"
        })
      ).rejects.toMatchObject({ code: "TEAM_RECRUIT_CAPABILITY_DENIED" });
      await expect(
        fixture.teams.recruit({
          workspaceId: fixture.workspace.id,
          compazioTerminalId: limited.terminalId,
          agentType: "codex",
          role: role("forbidden"),
          grantRecruitLimited: true,
          idempotencyKey: "hier-self-grant-denied-0001"
        })
      ).rejects.toMatchObject({ code: "TEAM_RECRUIT_CAPABILITY_DENIED" });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("HIER-14 cleans an entire nested tree once its TeamRun completes", async () => {
    const fixture = await runtimeFixture();
    try {
      const run = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "completion cleanup",
        objective: "complete then cleanup",
        members: [
          {
            agentType: "codex",
            displayName: "worker",
            role: role("worker"),
            grantRecruitLimited: true
          }
        ],
        tasks: [
          {
            key: "implement",
            title: "implement",
            description: "implement",
            assignedMemberName: "worker"
          }
        ],
        idempotencyKey: "hier-completion-run-0001"
      });
      const worker = run.members[0];
      const task = run.tasks[0];
      if (worker === undefined || task === undefined) throw new Error("run fixture missing");
      const subworker = await fixture.teams.recruit({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: worker.terminalId,
        agentType: "claude-code",
        displayName: "subworker",
        role: role("subworker"),
        idempotencyKey: "hier-completion-subworker-0001"
      });
      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: worker.terminalId,
        taskId: task.id,
        result: { summary: "completed" },
        idempotencyKey: "hier-completion-result-0001"
      });
      const state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((candidate) => candidate.id === run.run.id)?.status).toBe(
        "completed"
      );
      expect(state.teamMembers.filter((member) => member.runId === run.run.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: worker.id, status: "dismissed" }),
          expect.objectContaining({ id: subworker.member.id, status: "dismissed" })
        ])
      );
      expect(fixture.workspaces.sessionForNode(fixture.workspace.id, worker.terminalId)).toBeNull();
      expect(
        fixture.workspaces.sessionForNode(fixture.workspace.id, subworker.member.terminalId)
      ).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("HIER-08 denies a root trying to administer a grant owned by another TeamRun", async () => {
    const fixture = await runtimeFixture();
    try {
      const run = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "owner A",
        objective: "grant ownership",
        members: [
          {
            agentType: "codex",
            displayName: "worker",
            role: role("worker"),
            grantRecruitLimited: true
          }
        ],
        tasks: [{ key: "task", title: "task", description: "task", assignedMemberName: "worker" }],
        idempotencyKey: "hier-owner-a-0001"
      });
      const worker = run.members[0];
      if (worker === undefined) throw new Error("worker missing");
      const second = await fixture.workspaces.addTerminal(fixture.workspace.id, {
        title: "Second COMPAZIO",
        isCompazio: true,
        agentConfig: { agentId: "claude-code" }
      });
      const secondRoot = second.nodes.find(
        (node) =>
          node.type === "terminal" && node.isCompazio === true && node.id !== fixture.rootTerminalId
      );
      if (secondRoot?.type !== "terminal") throw new Error("second root missing");
      await fixture.workspaces.startTerminal(fixture.workspace.id, secondRoot.id);
      await fixture.operations.createTeamRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: secondRoot.id,
        title: "owner B",
        objective: "separate grant",
        idempotencyKey: "hier-owner-b-0001"
      });
      await expect(
        fixture.teams.revokeRecruitLimited({
          workspaceId: fixture.workspace.id,
          compazioTerminalId: secondRoot.id,
          teamMemberId: worker.id
        })
      ).rejects.toMatchObject({ code: "TEAM_RECRUIT_CAPABILITY_DENIED" });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("HIER-15 reload preserves policy, parent, depth and a non-inherited grant", async () => {
    const fixture = await runtimeFixture();
    try {
      const run = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "reload",
        objective: "persist hierarchy",
        members: [
          {
            agentType: "codex",
            displayName: "worker",
            role: role("worker"),
            grantRecruitLimited: true
          }
        ],
        tasks: [{ key: "task", title: "task", description: "task", assignedMemberName: "worker" }],
        idempotencyKey: "hier-reload-run-0001"
      });
      const worker = run.members[0];
      if (worker === undefined) throw new Error("worker missing");
      const subworker = await fixture.teams.recruit({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: worker.terminalId,
        agentType: "claude-code",
        displayName: "subworker",
        role: role("subworker"),
        idempotencyKey: "hier-reload-subworker-0001"
      });
      const reloaded = new V2OperationalService({
        repository: fixture.repository,
        workspaces: fixture.workspaces
      });
      const state = await reloaded.get(fixture.workspace.id);
      expect(state.teamRuns.find((candidate) => candidate.id === run.run.id)).toMatchObject({
        recruitmentPolicy: {
          maxDepth: 2,
          maxActiveAgentsPerRun: 5,
          maxChildrenPerAgent: 2,
          maxTotalRecruitmentsPerRun: 8
        }
      });
      expect(state.teamMembers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: worker.id,
            parentTerminalId: fixture.rootTerminalId,
            depth: 1,
            grantedCapabilities: ["recruit-limited"]
          }),
          expect.objectContaining({
            id: subworker.member.id,
            parentTerminalId: worker.terminalId,
            depth: 2,
            grantedCapabilities: []
          })
        ])
      );
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("HIER-16 keeps a subrecruited QA task in its parent TeamRun until the reviewer returns a result", async () => {
    const fixture = await runtimeFixture();
    try {
      // This corrective state-machine proof drives task_result explicitly; it must not race a
      // disposable process that is intentionally not returning a real MCP result in this fixture.
      Object.defineProperty(fixture.workspaces, "startBackgroundAgentTask", { value: undefined });
      let contexts = await fixture.workspaces.addNote(fixture.workspace.id, {
        title: "QA notes",
        content: "QA pending"
      });
      const note = contexts.nodes.find((node) => node.type === "note");
      contexts = await fixture.workspaces.addPortal(fixture.workspace.id, {
        title: "QA portal",
        url: "http://127.0.0.1:41800/"
      });
      const portal = contexts.nodes.find((node) => node.type === "portal");
      if (note?.type !== "note" || portal?.type !== "portal")
        throw new Error("review contexts missing");
      await fixture.workspaces.addEdge(fixture.workspace.id, fixture.rootTerminalId, note.id, [
        "share-context",
        "read-note",
        "write-note"
      ]);
      await fixture.workspaces.addEdge(fixture.workspace.id, fixture.rootTerminalId, portal.id, [
        "share-context",
        "portal-read",
        "portal-control",
        "portal-screenshot"
      ]);
      const created = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "builder and reviewer",
        objective: "implement then independently review",
        members: [
          {
            agentType: "opencode",
            displayName: "OpenCode Builder",
            role: role("builder"),
            grantRecruitLimited: true
          }
        ],
        tasks: [
          {
            key: "build",
            title: "Implement landing page",
            description: "Create the initial implementation.",
            contextRefs: [note.id, portal.id],
            assignedMemberName: "OpenCode Builder"
          }
        ],
        idempotencyKey: "hier-builder-reviewer-run-0001"
      });
      const builder = created.members[0];
      const build = created.tasks[0];
      if (builder === undefined || build === undefined)
        throw new Error("builder run missing members");

      const reviewer = await fixture.teams.recruit({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: builder.terminalId,
        agentType: "codex",
        displayName: "Codex Reviewer",
        role: role("reviewer"),
        idempotencyKey: "hier-builder-recruit-reviewer-0001"
      });
      const qa = await fixture.teams.createTask({
        workspaceId: fixture.workspace.id,
        creatorId: builder.terminalId,
        title: "QA Review Task",
        description: "Review the implementation at desktop and mobile sizes.",
        contextRefs: [note.id, portal.id],
        dependsOn: [build.id],
        reviewOf: build.id,
        idempotencyKey: "hier-builder-create-qa-0001"
      });
      await expect(
        fixture.teams.createTask({
          workspaceId: fixture.workspace.id,
          creatorId: builder.terminalId,
          title: "Out-of-run task",
          description: "This must not be attached to another execution.",
          runId: "another-run",
          idempotencyKey: "hier-builder-cross-run-denied-0001"
        })
      ).rejects.toMatchObject({ code: "TEAM_CAPABILITY_DENIED" });
      await fixture.teams.assignTask({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: builder.terminalId,
        taskId: qa.id,
        teamMemberId: reviewer.member.id,
        idempotencyKey: "hier-builder-assign-qa-0001"
      });

      let state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)).toMatchObject({
        memberIds: expect.arrayContaining([builder.id, reviewer.member.id]),
        taskIds: expect.arrayContaining([build.id, qa.id])
      });
      expect(state.teamTasks.find((task) => task.id === qa.id)).toMatchObject({
        runId: created.run.id,
        status: "blocked",
        assignedToTerminalId: reviewer.member.terminalId
      });
      expect((await fixture.workspaces.snapshot(fixture.workspace.id)).edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceNodeId: builder.terminalId,
            targetNodeId: reviewer.member.terminalId,
            capabilities: expect.arrayContaining(["send-message", "result-return"])
          })
        ])
      );

      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: builder.terminalId,
        taskId: build.id,
        result: { summary: "Implementation completed." }
      });
      state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("review");
      expect(state.teamTasks.find((task) => task.id === qa.id)?.status).toBe("running");
      expect((await fixture.workspaces.snapshot(fixture.workspace.id)).edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceNodeId: reviewer.member.terminalId,
            targetNodeId: note.id,
            capabilities: expect.arrayContaining(["read-note", "write-note"])
          }),
          expect.objectContaining({
            sourceNodeId: reviewer.member.terminalId,
            targetNodeId: portal.id,
            capabilities: expect.arrayContaining([
              "portal-read",
              "portal-control",
              "portal-screenshot"
            ])
          })
        ])
      );

      await expect(
        fixture.teams.taskResult({
          workspaceId: fixture.workspace.id,
          requesterId: reviewer.member.terminalId,
          taskId: qa.id,
          result: { summary: "Resultado QA: BLOQUEADO / NÃO AVALIADO." }
        })
      ).rejects.toMatchObject({ code: "TEAM_RESULT_INVALID", retryable: true });
      state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("review");
      expect(state.teamTasks.find((task) => task.id === qa.id)?.status).toBe("running");

      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: reviewer.member.terminalId,
        taskId: qa.id,
        result: {
          summary: "FINAL verdict: FAIL. Mobile navigation needs one incremental correction."
        }
      });
      state = await fixture.operations.get(fixture.workspace.id);
      const correction = state.teamTasks.find((task) =>
        task.idempotencyKey?.startsWith(`${created.run.id}-qa-correction-`)
      );
      const secondQa = state.teamTasks.find((task) =>
        task.idempotencyKey?.startsWith(`${created.run.id}-qa-review-`)
      );
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("running");
      expect(state.teamTasks.find((task) => task.id === qa.id)).toMatchObject({
        status: "completed",
        result: { summary: expect.stringContaining("FAIL") }
      });
      expect(correction).toMatchObject({
        status: "running",
        assignedToTerminalId: builder.terminalId,
        resultRefs: [qa.id]
      });
      expect(secondQa).toMatchObject({
        status: "blocked",
        assignedToTerminalId: reviewer.member.terminalId,
        dependsOn: [correction?.id],
        reviewOf: correction?.id
      });
      if (correction === undefined || secondQa === undefined)
        throw new Error("corrective QA cycle was not persisted");

      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: builder.terminalId,
        taskId: correction.id,
        result: { summary: "Incremental mobile navigation correction completed." }
      });
      state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("review");
      expect(state.teamTasks.find((task) => task.id === secondQa.id)?.status).toBe("running");

      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: reviewer.member.terminalId,
        taskId: secondQa.id,
        result: { summary: "Desktop and mobile QA PASS after the incremental correction." }
      });
      state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("completed");
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("keeps the Bella Pele Builder → Reviewer contract after a retryable reviewer fallback", async () => {
    const fixture = await runtimeFixture();
    try {
      Object.defineProperty(fixture.workspaces, "startBackgroundAgentTask", { value: undefined });
      const recruit = fixture.teams.recruit.bind(fixture.teams);
      let reviewerUnavailable = true;
      vi.spyOn(fixture.teams, "recruit").mockImplementation(async (input) => {
        if (reviewerUnavailable && input.agentType === "opencode") {
          throw new TeamCoordinatorError(
            "AGENT_START_FAILED",
            "OpenCode temporarily unavailable.",
            true,
            "bella-pele-retryable-fallback"
          );
        }
        return recruit(input);
      });
      const created = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "Landing page Bella Pele",
        objective: "Criar a landing page, revisar o resultado e concluir somente após QA.",
        members: [
          {
            agentType: "claude-code",
            displayName: "Builder Bella Pele",
            role: role("builder")
          },
          {
            agentType: "opencode",
            displayName: "Reviewer Bella Pele",
            role: role("reviewer")
          }
        ],
        tasks: [
          {
            key: "build",
            title: "Implementar landing page Bella Pele",
            description: "Criar index.html, styles.css e main.js.",
            assignedMemberName: "Builder Bella Pele"
          },
          {
            key: "review",
            title: "Revisar landing page Bella Pele",
            description: "Executar QA da implementação antes da conclusão.",
            assignedMemberName: "Reviewer Bella Pele",
            dependsOn: ["build"],
            reviewOf: "build"
          }
        ],
        acceptance: { requirePortal: true, requireQa: true },
        idempotencyKey: "bella-pele-contract-fallback-0001"
      });
      const builder = created.members.find((member) => member.displayName === "Builder Bella Pele");
      const build = created.tasks.find(
        (task) => task.title === "Implementar landing page Bella Pele"
      );
      const review = created.tasks.find((task) => task.title === "Revisar landing page Bella Pele");
      if (builder === undefined || build === undefined || review === undefined)
        throw new Error("Bella Pele contract was not materialized");
      expect(created.run.missionContract).toMatchObject({
        requiredMembers: [
          { displayName: "Builder Bella Pele" },
          { displayName: "Reviewer Bella Pele" }
        ],
        requiredTasks: [{ key: "build" }, { key: "review", reviewOf: "build" }],
        requiresQa: true,
        requiresPortal: true
      });
      expect(review.status).toBe("blocked");

      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: builder.terminalId,
        taskId: build.id,
        result: { summary: "index.html, styles.css e main.js criados." }
      });
      let state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("blocked");
      expect(state.teamTasks.find((task) => task.id === review.id)?.status).toBe("blocked");

      reviewerUnavailable = false;
      const resumed = await fixture.teams.runStatus(
        fixture.workspace.id,
        fixture.rootTerminalId,
        created.run.id
      );
      state = await fixture.operations.get(fixture.workspace.id);
      const reviewer = state.teamMembers.find(
        (member) => member.displayName === "Reviewer Bella Pele"
      );
      const runningReview = state.teamTasks.find((task) => task.id === review.id);
      expect(resumed.status).toBe("review");
      expect(reviewer?.status).toBe("working");
      expect(runningReview?.status).toBe("running");

      if (reviewer === undefined) throw new Error("Bella Pele reviewer was not recruited");
      await fixture.teams.taskResult({
        workspaceId: fixture.workspace.id,
        requesterId: reviewer.terminalId,
        taskId: review.id,
        result: { summary: "QA aprovado para desktop e mobile." }
      });
      state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamRuns.find((run) => run.id === created.run.id)?.status).toBe("blocked");

      fixture.markPortalReady();
      const completed = await fixture.teams.runStatus(
        fixture.workspace.id,
        fixture.rootTerminalId,
        created.run.id
      );
      expect(completed.status).toBe("completed");
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("routes a worker clarification through Compazio and resumes the same task", async () => {
    const fixture = await runtimeFixture();
    try {
      Object.defineProperty(fixture.workspaces, "startBackgroundAgentTask", { value: undefined });
      const created = await fixture.teams.createRun({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        title: "Clarificação Bella Pele",
        objective: "Confirmar o WhatsApp antes de implementar.",
        members: [
          {
            agentType: "claude-code",
            displayName: "Builder Bella Pele",
            role: role("builder")
          }
        ],
        tasks: [
          {
            key: "build",
            title: "Implementar CTA",
            description: "Configurar o CTA somente após obter o WhatsApp.",
            assignedMemberName: "Builder Bella Pele"
          }
        ],
        idempotencyKey: "bella-pele-user-input-0001"
      });
      const builder = created.members[0];
      const task = created.tasks[0];
      if (builder === undefined || task === undefined)
        throw new Error("clarification fixture missing");

      const waiting = fixture.teams.requestUserInput({
        workspaceId: fixture.workspace.id,
        requesterId: builder.terminalId,
        taskId: task.id,
        question: "Qual número de WhatsApp devo usar?",
        reason: "O CTA não pode apontar para um destino inventado.",
        expectedAnswerType: "text",
        context: "Landing page Bella Pele",
        idempotencyKey: "builder-whatsapp-question-0001"
      });
      await vi.waitFor(async () => {
        const state = await fixture.operations.get(fixture.workspace.id);
        expect(state.teamTasks.find((candidate) => candidate.id === task.id)?.status).toBe(
          "waiting-for-user-input"
        );
        expect(state.teamUserInputRequests[0]).toMatchObject({
          taskId: task.id,
          agentId: builder.terminalId,
          question: "Qual número de WhatsApp devo usar?",
          status: "waiting-for-user-input"
        });
      });
      const request = (await fixture.operations.get(fixture.workspace.id)).teamUserInputRequests[0];
      if (request === undefined) throw new Error("structured user-input request missing");
      await fixture.teams.answerUserInput({
        workspaceId: fixture.workspace.id,
        compazioTerminalId: fixture.rootTerminalId,
        requestId: request.id,
        answer: "+55 11 99999-1234"
      });
      const answered = await waiting;
      expect(answered).toMatchObject({ status: "answered", answer: "+55 11 99999-1234" });
      const state = await fixture.operations.get(fixture.workspace.id);
      expect(state.teamTasks.find((candidate) => candidate.id === task.id)?.status).toBe("running");
      expect(state.teamMembers.find((candidate) => candidate.id === builder.id)?.status).toBe(
        "working"
      );
      expect(
        state.messages.some(
          (message) =>
            message.fromTerminalId === fixture.rootTerminalId &&
            message.toTerminalId === builder.terminalId &&
            message.content.includes("+55 11 99999-1234")
        )
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

function role(name: string) {
  return { name, responsibilities: ["Deterministic hierarchy gate."] };
}

async function operationFixture() {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-hier-domain-"));
  roots.push(root);
  const repository = new V2WorkspaceRepository({ rootDirectory: root });
  const supervisor = new V2ProcessSupervisor(
    new TransportProcessFactory({ pty: new PipeProcessFactory(), pipe: new PipeProcessFactory() }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 75 }
  );
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "roles"))
  });
  const workspaces = new V2WorkspaceService({
    repository,
    supervisor,
    agents,
    entitlement: isolatedTestEntitlement(root)
  });
  const operations = new V2OperationalService({ repository, workspaces });
  const workspace = await workspaces.create({ name: "hierarchy domain", workingDirectory: root });
  const run = await operations.createTeamRun({
    workspaceId: workspace.id,
    compazioTerminalId: "root-parent",
    title: "hierarchy domain",
    objective: "bounded recruitment",
    idempotencyKey: "hier-domain-run-0001"
  });
  return {
    repository,
    workspace,
    run,
    operations,
    close: () => workspaces.shutdown()
  };
}

async function reserve(
  fixture: Awaited<ReturnType<typeof operationFixture>>,
  terminalId: string,
  parentTerminalId: string,
  depth: number
) {
  return fixture.operations.reserveTeamRecruitment({
    workspaceId: fixture.workspace.id,
    runId: fixture.run.id,
    terminalId,
    agentType: "codex",
    displayName: terminalId,
    role: role("worker"),
    recruitedByTerminalId: parentTerminalId,
    parentTerminalId,
    depth,
    grantedCapabilities: [],
    status: "ready",
    idempotencyKey: `hier-reserve-${terminalId}`
  });
}

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-hier-runtime-"));
  roots.push(root);
  const repository = new V2WorkspaceRepository({ rootDirectory: root });
  const supervisor = new V2ProcessSupervisor(
    new TransportProcessFactory({ pty: new PipeProcessFactory(), pipe: new PipeProcessFactory() }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 75 }
  );
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "roles"))
  });
  await agents.setExecutablePath("claude-code", process.execPath);
  await agents.setExecutablePath("codex", process.execPath);
  await agents.setExecutablePath("opencode", process.execPath);
  const workspaces = new V2WorkspaceService({
    repository,
    supervisor,
    agents,
    entitlement: isolatedTestEntitlement(root)
  });
  const operations = new V2OperationalService({ repository, workspaces });
  let portalReady = false;
  const portals = {
    list: () => (portalReady ? [{ state: "ready", loading: false }] : [])
  } as unknown as PortalRuntimeManager;
  const teams = new TeamCoordinator({
    workspaces,
    operations,
    agents,
    portals,
    readinessTimeoutMs: 2_000
  });
  const workspace = await workspaces.create({ name: "hierarchy runtime", workingDirectory: root });
  const configured = await workspaces.addTerminal(workspace.id, {
    title: "Claude COMPAZIO",
    isCompazio: true,
    agentConfig: { agentId: "claude-code" }
  });
  const rootTerminal = configured.nodes.find(
    (node) => node.type === "terminal" && node.isCompazio === true
  );
  if (rootTerminal?.type !== "terminal") throw new Error("root terminal missing");
  await workspaces.startTerminal(workspace.id, rootTerminal.id);
  return {
    repository,
    workspace,
    rootTerminalId: rootTerminal.id,
    workspaces,
    agents,
    operations,
    teams,
    markPortalReady: () => {
      portalReady = true;
    },
    close: () => workspaces.shutdown()
  };
}
