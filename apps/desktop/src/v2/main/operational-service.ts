import { randomUUID } from "node:crypto";

import {
  OPERATIONAL_SCHEMA_VERSION,
  OperationalDomainError,
  agentAssignmentSchema,
  agentMessageSchema,
  attentionRequestSchema,
  connectionActivitySchema,
  getExecutionPolicy,
  organizeTeam,
  orchestrationRunSchema,
  orchestrationTaskSchema,
  recoveryActionSchema,
  retainOperationalHistory,
  runEventSchema,
  sanitizeEventMetadata,
  ORCHESTRATOR_LABEL,
  teamLayoutSchema,
  teamMemberSchema,
  teamRunSchema,
  teamTaskSchema,
  teamUserInputRequestSchema,
  transitionRun,
  transitionTask,
  workspaceOperationalStateSchema,
  type AttentionRequest,
  type AgentMessage,
  type ExecutionPolicy,
  type ExecutionPolicyId,
  type OrchestrationRun,
  type OrchestrationRunStatus,
  type OrchestrationTask,
  type RecoveryAction,
  type RunEvent,
  type RunEventType,
  type StructuredFailure,
  type TeamLayout,
  type TeamMember,
  type TeamRun,
  type TeamRunMissionContract,
  type TeamRunStatus,
  type TeamTask,
  type TeamTaskStatus,
  type TeamUserInputRequest,
  type WorkspaceOperationalState
} from "@forgedeck/compazio-v2-domain";
import type { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";

import type { V2WorkspaceService } from "./workspace-service";

export interface OperationalNotification {
  readonly kind: "completed" | "attention" | "failure" | "background";
  readonly title: string;
  readonly body: string;
  readonly workspaceId: string;
  readonly runId?: string;
  readonly terminalId?: string;
}

export interface V2OperationalServiceOptions {
  readonly repository: V2WorkspaceRepository;
  readonly workspaces: V2WorkspaceService;
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly notify?: (notification: OperationalNotification) => boolean | Promise<boolean>;
}

interface MutationResult<T> {
  readonly state: WorkspaceOperationalState;
  readonly result: T;
}

interface PreparedTaskRecovery {
  readonly action: RecoveryAction;
  readonly task: OrchestrationTask | undefined;
}

interface PreparedRunRecovery {
  readonly action: RecoveryAction;
  readonly run: OrchestrationRun | undefined;
}

export class V2OperationalService {
  private readonly cache = new Map<string, WorkspaceOperationalState>();
  private readonly loads = new Map<string, Promise<WorkspaceOperationalState>>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(state: WorkspaceOperationalState) => void>();
  private readonly recoveryTasksBySession = new Map<
    string,
    { readonly workspaceId: string; readonly taskId: string }
  >();
  private readonly createId: () => string;
  private readonly now: () => string;

  public constructor(private readonly options: V2OperationalServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    options.workspaces.subscribe((event) => {
      if (
        event.type === "terminal.state" &&
        ["completed", "failed", "stopped"].includes(event.session.state)
      ) {
        const recoveryTask = this.recoveryTasksBySession.get(event.session.id);
        if (recoveryTask !== undefined) {
          this.recoveryTasksBySession.delete(event.session.id);
          void this.recordTaskTerminalState(
            recoveryTask.workspaceId,
            recoveryTask.taskId,
            event.session.state as "completed" | "failed" | "stopped"
          ).catch(() => undefined);
        }
      }
      if (
        event.type === "terminal.state" &&
        ["failed", "disconnected"].includes(event.session.state)
      ) {
        void this.recordProcessFailure(
          event.session.workspaceId,
          event.session.terminalNodeId
        ).catch(() => undefined);
      }
    });
  }

  public subscribe(listener: (state: WorkspaceOperationalState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async get(workspaceId: string): Promise<WorkspaceOperationalState> {
    const cached = this.cache.get(workspaceId);
    if (cached !== undefined) return cached;
    const pending = this.loads.get(workspaceId);
    if (pending !== undefined) return pending;
    const load = this.loadAndRecover(workspaceId).finally(() => this.loads.delete(workspaceId));
    this.loads.set(workspaceId, load);
    return load;
  }

  public async policy(workspaceId: string): Promise<ExecutionPolicy> {
    return getExecutionPolicy((await this.get(workspaceId)).policyId);
  }

  public async updatePolicy(
    workspaceId: string,
    policyId: ExecutionPolicyId,
    actor = "user"
  ): Promise<WorkspaceOperationalState> {
    getExecutionPolicy(policyId);
    return this.mutate(workspaceId, (state) => {
      if (state.policyId === policyId) return { state, result: state };
      const correlationId = this.createId();
      const next = {
        ...state,
        policyId,
        events: [
          ...state.events,
          this.event("policy.changed", workspaceId, actor, policyId, correlationId, {
            previousPolicyId: state.policyId,
            policyId
          })
        ]
      };
      return { state: next, result: next };
    });
  }

  public async assertAdministrativeAction(
    workspaceId: string,
    orchestratorTerminalId: string
  ): Promise<OrchestrationRun> {
    return this.mutate(workspaceId, (state) => {
      const ensured = this.ensureRunInState(state, orchestratorTerminalId);
      if (["paused", "cancelled", "failed", "completed"].includes(ensured.run.status)) {
        throw this.error(
          "ORCHESTRATOR_PERMISSION_DENIED",
          "O Orquestrador está pausado ou esta execução já terminou.",
          "Retome a execução ou inicie uma nova antes de administrar o canvas.",
          false
        );
      }
      return { state: ensured.state, result: ensured.run };
    });
  }

  public async assertCanRecruit(
    workspaceId: string,
    orchestratorTerminalId: string
  ): Promise<OrchestrationRun> {
    const run = await this.assertAdministrativeAction(workspaceId, orchestratorTerminalId);
    const state = await this.get(workspaceId);
    const activeAssignments = state.assignments.filter(
      (assignment) => assignment.runId === run.id && assignment.releasedAt === undefined
    );
    const policy = getExecutionPolicy(run.policyId);
    if (activeAssignments.length >= policy.maxConcurrentAgents) {
      throw this.error(
        "AGENT_LIMIT_REACHED",
        `A política ${policy.id} permite até ${policy.maxConcurrentAgents} agentes recrutados nesta execução.`,
        "Reutilize ou dispense um agente, ou altere a política do workspace.",
        false
      );
    }
    return run;
  }

  public async recordRecruit(input: {
    readonly workspaceId: string;
    readonly orchestratorTerminalId: string;
    readonly terminalId: string;
    readonly roleId?: string;
  }): Promise<OrchestrationRun> {
    const run = await this.mutate(input.workspaceId, (state) => {
      const ensured = this.ensureRunInState(state, input.orchestratorTerminalId);
      const duplicate = ensured.state.assignments.find(
        (assignment) =>
          assignment.runId === ensured.run.id && assignment.terminalId === input.terminalId
      );
      if (duplicate !== undefined) return { state: ensured.state, result: ensured.run };
      const policy = getExecutionPolicy(ensured.run.policyId);
      const activeCount = ensured.state.assignments.filter(
        (assignment) => assignment.runId === ensured.run.id && assignment.releasedAt === undefined
      ).length;
      if (activeCount >= policy.maxConcurrentAgents) {
        throw this.error(
          "AGENT_LIMIT_REACHED",
          `O limite de ${policy.maxConcurrentAgents} agentes da política atual foi atingido.`,
          "Dispense um agente ou altere a política.",
          false
        );
      }
      const now = this.now();
      const correlationId = this.createId();
      const assignment = agentAssignmentSchema.parse({
        id: this.createId(),
        runId: ensured.run.id,
        terminalId: input.terminalId,
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        taskIds: [],
        recruitedByTerminalId: input.orchestratorTerminalId,
        createdAt: now
      });
      const updatedRun = orchestrationRunSchema.parse({
        ...ensured.run,
        recruitedTerminalIds: [...ensured.run.recruitedTerminalIds, input.terminalId],
        updatedAt: now
      });
      const next = {
        ...ensured.state,
        runs: replaceById(ensured.state.runs, updatedRun),
        assignments: [...ensured.state.assignments, assignment],
        events: [
          ...ensured.state.events,
          this.event(
            "agent.recruited",
            input.workspaceId,
            input.orchestratorTerminalId,
            input.terminalId,
            correlationId,
            { roleId: input.roleId ?? null },
            ensured.run.id
          )
        ]
      };
      return { state: next, result: updatedRun };
    });
    await this.organizeTeam(input.workspaceId, run.id, false);
    return run;
  }

  public async recordEdge(input: {
    readonly workspaceId: string;
    readonly orchestratorTerminalId: string;
    readonly edgeId: string;
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
  }): Promise<void> {
    await this.recordSimpleEvent(
      input.workspaceId,
      input.orchestratorTerminalId,
      "edge.created",
      input.edgeId,
      { sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId }
    );
    const workspace = await this.options.workspaces.snapshot(input.workspaceId);
    const connectsSharedNote = workspace.nodes.some(
      (node) =>
        node.type === "note" && (node.id === input.sourceNodeId || node.id === input.targetNodeId)
    );
    if (connectsSharedNote) {
      const run = this.activeRun(await this.get(input.workspaceId), input.orchestratorTerminalId);
      if (run !== undefined) await this.organizeTeam(input.workspaceId, run.id, false);
    }
  }

  public async recordRole(input: {
    readonly workspaceId: string;
    readonly orchestratorTerminalId: string;
    readonly terminalId: string;
    readonly roleId: string;
  }): Promise<void> {
    await this.mutate(input.workspaceId, (state) => {
      const run = this.activeRun(state, input.orchestratorTerminalId);
      const correlationId = this.createId();
      return {
        state: {
          ...state,
          assignments: state.assignments.map((assignment) =>
            assignment.runId === run?.id && assignment.terminalId === input.terminalId
              ? { ...assignment, roleId: input.roleId }
              : assignment
          ),
          events: [
            ...state.events,
            this.event(
              "role.assigned",
              input.workspaceId,
              input.orchestratorTerminalId,
              input.terminalId,
              correlationId,
              { roleId: input.roleId },
              run?.id
            )
          ]
        },
        result: undefined
      };
    });
  }

  /** Creates the durable envelope for one Compazio team without retaining runtime processes. */
  public async createTeamRun(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly title: string;
    readonly objective: string;
    readonly idempotencyKey: string;
    readonly missionContract?: TeamRunMissionContract;
    readonly policyId?: ExecutionPolicyId;
  }): Promise<TeamRun> {
    return this.mutate(input.workspaceId, (state) => {
      const existing = state.teamRuns.find(
        (run) =>
          run.compazioTerminalId === input.compazioTerminalId &&
          run.idempotencyKey === input.idempotencyKey
      );
      if (existing !== undefined) return { state, result: existing };
      const active = state.teamRuns.find(
        (run) =>
          run.compazioTerminalId === input.compazioTerminalId &&
          !["completed", "failed", "cancelled"].includes(run.status)
      );
      if (active !== undefined) {
        throw this.error(
          "TEAM_RUN_ALREADY_FINISHED",
          `Este ${ORCHESTRATOR_LABEL} já possui uma execução de equipe ativa.`,
          "Conclua ou cancele a execução atual antes de iniciar outra.",
          false
        );
      }
      const now = this.now();
      const correlationId = this.createId();
      const run = teamRunSchema.parse({
        id: this.createId(),
        workspaceId: input.workspaceId,
        compazioTerminalId: input.compazioTerminalId,
        title: input.title,
        objective: input.objective,
        policyId: input.policyId ?? state.policyId,
        status: "planning",
        ...(input.missionContract === undefined ? {} : { missionContract: input.missionContract }),
        memberIds: [],
        taskIds: [],
        idempotencyKey: input.idempotencyKey,
        createdAt: now
      });
      return {
        state: {
          ...state,
          teamRuns: [...state.teamRuns, run],
          events: [
            ...state.events,
            this.event(
              "team.run.created",
              input.workspaceId,
              input.compazioTerminalId,
              run.id,
              correlationId,
              {},
              run.id
            )
          ]
        },
        result: run
      };
    });
  }

  public async updateTeamRun(
    workspaceId: string,
    runId: string,
    status: TeamRunStatus,
    actor: string,
    patch: Partial<Pick<TeamRun, "memberIds" | "taskIds" | "groupId">> = {}
  ): Promise<TeamRun> {
    return this.mutate(workspaceId, (state) => {
      const current = state.teamRuns.find((run) => run.id === runId);
      if (current === undefined) {
        throw this.error(
          "TEAM_RUN_NOT_FOUND",
          "A execução da equipe não foi encontrada.",
          "Atualize a equipe.",
          false
        );
      }
      const now = this.now();
      const completed = ["completed", "failed", "cancelled"].includes(status);
      const next = teamRunSchema.parse({
        ...current,
        ...patch,
        status,
        ...(status === "running" && current.startedAt === undefined ? { startedAt: now } : {}),
        ...(completed && current.completedAt === undefined ? { completedAt: now } : {}),
        ...(status === "cancelled" ? { cancelledAt: now } : {})
      });
      const eventType: RunEventType =
        status === "completed"
          ? "team.run.completed"
          : status === "cancelled"
            ? "team.run.cancelled"
            : status === "blocked"
              ? "team.run.blocked"
              : status === "review"
                ? "team.run.review"
                : "team.run.started";
      return {
        state: {
          ...state,
          teamRuns: replaceById(state.teamRuns, next),
          events: [
            ...state.events,
            this.event(eventType, workspaceId, actor, runId, this.createId(), { status }, runId)
          ]
        },
        result: next
      };
    });
  }

  public async cancelTeamRun(workspaceId: string, runId: string, actor: string): Promise<TeamRun> {
    const run = await this.updateTeamRun(workspaceId, runId, "cancelled", actor);
    await this.mutate(workspaceId, (state) => {
      const now = this.now();
      const taskIds = new Set(
        state.teamTasks.filter((task) => task.runId === runId).map((task) => task.id)
      );
      const memberTerminalIds = new Set(
        state.teamMembers
          .filter((member) => run.memberIds.includes(member.id))
          .map((member) => member.terminalId)
      );
      memberTerminalIds.add(run.compazioTerminalId);
      return {
        state: {
          ...state,
          teamTasks: state.teamTasks.map((task) =>
            task.runId === runId && !["completed", "failed", "cancelled"].includes(task.status)
              ? teamTaskSchema.parse({ ...task, status: "cancelled", completedAt: now })
              : task
          ),
          messages: state.messages.map((message) =>
            (message.status === "queued" || message.status === "delivering") &&
            ((message.taskId !== undefined && taskIds.has(message.taskId)) ||
              (memberTerminalIds.has(message.fromTerminalId) &&
                memberTerminalIds.has(message.toTerminalId)))
              ? agentMessageSchema.parse({ ...message, status: "cancelled" })
              : message
          )
        },
        result: undefined
      };
    });
    return run;
  }

  /** Durable TeamCoordinator projection.  It intentionally has no runtime process references. */
  public async upsertTeamMember(
    input: Omit<TeamMember, "id" | "createdAt"> & {
      readonly id?: string;
      readonly createdAt?: string;
    }
  ): Promise<TeamMember> {
    return this.mutate(input.workspaceId, (state) => {
      const existing = state.teamMembers.find(
        (member) => member.terminalId === input.terminalId && member.dismissedAt === undefined
      );
      const member = teamMemberSchema.parse({
        ...input,
        id: existing?.id ?? input.id ?? this.createId(),
        createdAt: existing?.createdAt ?? input.createdAt ?? this.now()
      });
      const run =
        member.runId === undefined
          ? this.activeTeamRun(state, input.recruitedByTerminalId)
          : state.teamRuns.find((candidate) => candidate.id === member.runId);
      const eventType: RunEventType =
        member.status === "creating" || member.status === "starting"
          ? "team.member.recruit.started"
          : member.status === "ready"
            ? "team.member.ready"
            : member.status === "failed"
              ? "team.member.failed"
              : existing === undefined
                ? "team.member.recruited"
                : "team.member.ready";
      const correlationId = this.createId();
      return {
        state: {
          ...state,
          teamMembers:
            existing === undefined
              ? [...state.teamMembers, member]
              : replaceById(state.teamMembers, member),
          events: [
            ...state.events,
            this.event(
              eventType,
              input.workspaceId,
              input.recruitedByTerminalId,
              input.terminalId,
              correlationId,
              { agentType: input.agentType, status: member.status },
              run?.id
            )
          ]
        },
        result: member
      };
    });
  }

  /**
   * Atomically consumes one TeamRun recruitment slot and persists the member projection. The
   * coordinator authorizes the capability; this transaction is the final guard against two
   * otherwise-valid recruiters passing a stale capacity check at the same time.
   */
  public async reserveTeamRecruitment(
    input: Omit<TeamMember, "id" | "createdAt"> & {
      readonly runId: string;
      readonly id?: string;
      readonly createdAt?: string;
    }
  ): Promise<TeamMember> {
    return this.mutate(input.workspaceId, (state) => {
      const run = state.teamRuns.find((candidate) => candidate.id === input.runId);
      if (run === undefined)
        throw this.error(
          "TEAM_RUN_NOT_FOUND",
          "A execução de equipe não está disponível para recrutamento.",
          "Atualize o canvas e tente novamente.",
          false
        );
      if (["completed", "failed", "cancelled"].includes(run.status))
        throw this.error(
          "TEAM_RECRUIT_BUDGET_EXCEEDED",
          "A execução já foi encerrada e não aceita novos integrantes.",
          "Inicie uma nova execução de equipe.",
          false
        );
      const members = state.teamMembers.filter(
        (member) => member.runId === run.id || run.memberIds.includes(member.id)
      );
      const active = members.filter(
        (member) => !["dismissed", "failed", "dismissing"].includes(member.status)
      );
      if (active.length >= run.recruitmentPolicy.maxActiveAgentsPerRun)
        throw this.error(
          "TEAM_RECRUIT_ACTIVE_LIMIT",
          "A execução atingiu o limite de agentes ativos.",
          "Finalize ou dispense um integrante antes de recrutar outro.",
          false
        );
      if (members.length >= run.recruitmentPolicy.maxTotalRecruitmentsPerRun)
        throw this.error(
          "TEAM_RECRUIT_BUDGET_EXCEEDED",
          "A execução atingiu o orçamento total de recrutamentos.",
          "Conclua esta execução ou reduza a árvore de agentes.",
          false
        );
      const children = members.filter(
        (member) =>
          member.parentTerminalId === input.parentTerminalId &&
          !["dismissed", "failed", "dismissing"].includes(member.status)
      );
      if (children.length >= run.recruitmentPolicy.maxChildrenPerAgent)
        throw this.error(
          "TEAM_RECRUIT_CHILD_LIMIT",
          "O agente já possui o número máximo de filhos ativos.",
          "Finalize ou dispense um filho antes de recrutar outro.",
          false
        );
      if (input.depth > run.recruitmentPolicy.maxDepth)
        throw this.error(
          "TEAM_RECRUIT_DEPTH_LIMIT",
          "A profundidade máxima da execução foi atingida.",
          "Peça a revisão por meio de um agente já autorizado.",
          false
        );
      const existing = state.teamMembers.find(
        (member) => member.terminalId === input.terminalId && member.dismissedAt === undefined
      );
      const member = teamMemberSchema.parse({
        ...input,
        id: existing?.id ?? input.id ?? this.createId(),
        createdAt: existing?.createdAt ?? input.createdAt ?? this.now()
      });
      const nextRun = teamRunSchema.parse({
        ...run,
        memberIds: existing === undefined ? [...run.memberIds, member.id] : run.memberIds
      });
      return {
        state: {
          ...state,
          teamRuns: replaceById(state.teamRuns, nextRun),
          teamMembers:
            existing === undefined
              ? [...state.teamMembers, member]
              : replaceById(state.teamMembers, member),
          events: [
            ...state.events,
            this.event(
              "team.member.recruited",
              input.workspaceId,
              input.recruitedByTerminalId,
              input.terminalId,
              this.createId(),
              { agentType: input.agentType, depth: input.depth },
              run.id
            )
          ]
        },
        result: member
      };
    });
  }

  public async dismissTeamMember(
    workspaceId: string,
    terminalId: string,
    actor: string
  ): Promise<void> {
    await this.mutate(workspaceId, (state) => {
      const member = state.teamMembers.find(
        (candidate) => candidate.terminalId === terminalId && candidate.dismissedAt === undefined
      );
      if (member === undefined) return { state, result: undefined };
      const now = this.now();
      const correlationId = this.createId();
      const run =
        member.runId === undefined
          ? this.activeTeamRun(state, actor)
          : state.teamRuns.find((candidate) => candidate.id === member.runId);
      return {
        state: {
          ...state,
          teamMembers: replaceById(
            state.teamMembers,
            teamMemberSchema.parse({ ...member, status: "dismissed", dismissedAt: now })
          ),
          teamTasks: state.teamTasks.map((task) =>
            task.assignedToTerminalId === terminalId &&
            !["completed", "cancelled", "failed"].includes(task.status)
              ? teamTaskSchema.parse({ ...task, status: "cancelled", completedAt: now })
              : task
          ),
          events: [
            ...state.events,
            this.event(
              "team.member.dismissed",
              workspaceId,
              actor,
              terminalId,
              correlationId,
              {},
              run?.id
            )
          ]
        },
        result: undefined
      };
    });
  }

  /** Releases a failed spawn without leaving it counted by a bounded TeamRun. */
  public async releaseTeamRecruitment(
    workspaceId: string,
    terminalId: string,
    actor: string
  ): Promise<void> {
    await this.mutate(workspaceId, (state) => {
      const member = state.teamMembers.find((candidate) => candidate.terminalId === terminalId);
      if (member === undefined || member.runId === undefined) return { state, result: undefined };
      const run = state.teamRuns.find((candidate) => candidate.id === member.runId);
      if (run === undefined) return { state, result: undefined };
      const now = this.now();
      const released = teamMemberSchema.parse({
        ...member,
        runId: undefined,
        grantedCapabilities: [],
        status: "failed",
        dismissedAt: now
      });
      const nextRun = teamRunSchema.parse({
        ...run,
        memberIds: run.memberIds.filter((memberId) => memberId !== member.id)
      });
      return {
        state: {
          ...state,
          teamMembers: replaceById(state.teamMembers, released),
          teamRuns: replaceById(state.teamRuns, nextRun),
          events: [
            ...state.events,
            this.event(
              "team.member.recruitment.released",
              workspaceId,
              actor,
              terminalId,
              this.createId(),
              { reason: "spawn-failed" },
              run.id
            )
          ]
        },
        result: undefined
      };
    });
  }

  /** The coordinator is the sole caller; grants are persisted and non-inheritable. */
  public async setTeamMemberCapabilities(
    workspaceId: string,
    teamMemberId: string,
    grantedCapabilities: TeamMember["grantedCapabilities"],
    actor: string
  ): Promise<TeamMember> {
    return this.mutate(workspaceId, (state) => {
      const member = state.teamMembers.find((candidate) => candidate.id === teamMemberId);
      if (member === undefined)
        throw this.error(
          "TEAM_MEMBER_NOT_FOUND",
          "Team member was not found.",
          "Refresh the team and try again.",
          false
        );
      const next = teamMemberSchema.parse({ ...member, grantedCapabilities });
      return {
        state: {
          ...state,
          teamMembers: replaceById(state.teamMembers, next),
          events: [
            ...state.events,
            this.event(
              "team.member.capabilities.updated",
              workspaceId,
              actor,
              member.terminalId,
              this.createId(),
              { capabilities: grantedCapabilities },
              member.runId
            )
          ]
        },
        result: next
      };
    });
  }

  public async markTeamMemberDismissing(
    workspaceId: string,
    terminalId: string,
    actor: string
  ): Promise<TeamMember | undefined> {
    return this.mutate(workspaceId, (state) => {
      const member = state.teamMembers.find((candidate) => candidate.terminalId === terminalId);
      if (member === undefined || member.status === "dismissed")
        return { state, result: undefined };
      if (member.status === "dismissing") return { state, result: member };
      const next = teamMemberSchema.parse({ ...member, status: "dismissing" });
      return {
        state: {
          ...state,
          teamMembers: replaceById(state.teamMembers, next),
          events: [
            ...state.events,
            this.event(
              "team.member.dismiss.started",
              workspaceId,
              actor,
              terminalId,
              this.createId(),
              {}
            )
          ]
        },
        result: next
      };
    });
  }

  public async createTeamTask(input: {
    readonly workspaceId: string;
    readonly createdByTerminalId: string;
    readonly title: string;
    readonly description: string;
    readonly assignedToTerminalId?: string;
    readonly contextRefs?: readonly string[];
    readonly runId?: string;
    readonly dependsOn?: readonly string[];
    readonly resultRefs?: readonly string[];
    readonly reviewOf?: string;
    readonly priority?: "low" | "normal" | "high";
    readonly maxAttempts?: number;
    readonly idempotencyKey: string;
  }): Promise<TeamTask> {
    return this.mutate(input.workspaceId, (state) => {
      const existing = state.teamTasks.find((task) => task.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return { state, result: existing };
      const run = this.activeRun(state, input.createdByTerminalId);
      const correlationId = this.createId();
      const dependsOn = [...new Set(input.dependsOn ?? [])];
      if (dependsOn.length > 3) {
        throw this.error(
          "TEAM_TASK_DEPENDENCY_CYCLE",
          "Uma tarefa pode ter no máximo três dependências.",
          "Simplifique o grafo de tarefas.",
          false
        );
      }
      const missingDependency = dependsOn.find(
        (dependencyId) => !state.teamTasks.some((task) => task.id === dependencyId)
      );
      if (missingDependency !== undefined) {
        throw this.error(
          "TEAM_TASK_DEPENDENCY_NOT_FOUND",
          "Uma dependência de tarefa não foi encontrada.",
          "Crie a dependência antes da tarefa dependente.",
          false
        );
      }
      const teamRun =
        input.runId === undefined
          ? undefined
          : state.teamRuns.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && teamRun === undefined) {
        throw this.error(
          "TEAM_RUN_NOT_FOUND",
          "A execução da equipe não foi encontrada.",
          "Atualize a equipe.",
          false
        );
      }
      if (teamRun !== undefined && teamRun.taskIds.length >= 10) {
        throw this.error(
          "TEAM_TASK_ASSIGNMENT_CONFLICT",
          "Esta execução já atingiu o limite de dez tarefas.",
          "Conclua ou cancele a execução antes de adicionar tarefas.",
          false
        );
      }
      const blockedBy = dependsOn.filter((dependencyId) => {
        const dependency = state.teamTasks.find((task) => task.id === dependencyId);
        return dependency?.status !== "completed";
      });
      const task = teamTaskSchema.parse({
        id: this.createId(),
        workspaceId: input.workspaceId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        title: input.title,
        description: input.description,
        status:
          blockedBy.length > 0
            ? "blocked"
            : input.assignedToTerminalId === undefined
              ? "queued"
              : "assigned",
        createdByTerminalId: input.createdByTerminalId,
        ...(input.assignedToTerminalId === undefined
          ? {}
          : { assignedToTerminalId: input.assignedToTerminalId }),
        contextRefs: input.contextRefs ?? [],
        dependsOn,
        blockedBy,
        resultRefs: input.resultRefs ?? [],
        ...(input.reviewOf === undefined ? {} : { reviewOf: input.reviewOf }),
        priority: input.priority ?? "normal",
        maxAttempts: input.maxAttempts ?? 1,
        idempotencyKey: input.idempotencyKey,
        createdAt: this.now()
      });
      const teamRuns =
        teamRun === undefined
          ? state.teamRuns
          : replaceById(
              state.teamRuns,
              teamRunSchema.parse({ ...teamRun, taskIds: [...teamRun.taskIds, task.id] })
            );
      return {
        state: {
          ...state,
          teamRuns,
          teamTasks: [...state.teamTasks, task],
          events: [
            ...state.events,
            this.event(
              "task.created",
              input.workspaceId,
              input.createdByTerminalId,
              task.id,
              correlationId,
              {},
              run?.id
            ),
            ...(task.status === "queued"
              ? []
              : task.status === "blocked"
                ? [
                    this.event(
                      "task.blocked",
                      input.workspaceId,
                      input.createdByTerminalId,
                      task.id,
                      correlationId,
                      { dependencyCount: blockedBy.length },
                      input.runId ?? run?.id
                    )
                  ]
                : [
                    this.event(
                      "task.assigned",
                      input.workspaceId,
                      input.createdByTerminalId,
                      task.id,
                      correlationId,
                      { assigneeCount: 1 },
                      input.runId ?? run?.id
                    )
                  ])
          ]
        },
        result: task
      };
    });
  }

  public async updateTeamTask(input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly actor: string;
    readonly status?: TeamTaskStatus;
    readonly assignedToTerminalId?: string;
    readonly contextRefs?: readonly string[];
    readonly dependsOn?: readonly string[];
    readonly blockedBy?: readonly string[];
    readonly resultRefs?: readonly string[];
    readonly reviewOf?: string;
    readonly result?: TeamTask["result"];
  }): Promise<TeamTask> {
    return this.mutate(input.workspaceId, (state) => {
      const current = state.teamTasks.find((task) => task.id === input.taskId);
      if (current === undefined)
        throw this.error(
          "TEAM_TASK_NOT_FOUND",
          "A tarefa da equipe não foi encontrada.",
          "Atualize a equipe.",
          false
        );
      const status = input.status ?? current.status;
      const now = this.now();
      const task = teamTaskSchema.parse({
        ...current,
        status,
        ...(input.assignedToTerminalId === undefined
          ? {}
          : { assignedToTerminalId: input.assignedToTerminalId }),
        ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
        ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy }),
        ...(input.resultRefs === undefined ? {} : { resultRefs: input.resultRefs }),
        ...(input.reviewOf === undefined ? {} : { reviewOf: input.reviewOf }),
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(status === "running" && current.startedAt === undefined ? { startedAt: now } : {}),
        ...(["completed", "failed", "cancelled"].includes(status) ? { completedAt: now } : {})
      });
      const run =
        task.runId === undefined
          ? this.activeTeamRun(state, input.actor)
          : state.teamRuns.find((candidate) => candidate.id === task.runId);
      const eventType =
        status === "completed"
          ? "task.completed"
          : status === "failed"
            ? "task.failed"
            : status === "cancelled"
              ? "task.cancelled"
              : status === "running"
                ? "task.started"
                : status === "blocked"
                  ? "task.blocked"
                  : "task.assigned";
      return {
        state: {
          ...state,
          teamTasks: replaceById(state.teamTasks, task),
          events: [
            ...state.events,
            this.event(
              eventType,
              input.workspaceId,
              input.actor,
              task.id,
              this.createId(),
              { status },
              run?.id
            )
          ]
        },
        result: task
      };
    });
  }

  public async createTeamUserInputRequest(input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly question: string;
    readonly reason: string;
    readonly expectedAnswerType: TeamUserInputRequest["expectedAnswerType"];
    readonly context?: string;
    readonly idempotencyKey: string;
  }): Promise<TeamUserInputRequest> {
    return this.mutate(input.workspaceId, (state) => {
      const existing = state.teamUserInputRequests.find(
        (request) =>
          request.agentId === input.agentId && request.idempotencyKey === input.idempotencyKey
      );
      if (existing !== undefined) return { state, result: existing };
      const task = state.teamTasks.find((candidate) => candidate.id === input.taskId);
      const run =
        task?.runId === undefined
          ? undefined
          : state.teamRuns.find((candidate) => candidate.id === task.runId);
      if (
        task === undefined ||
        run === undefined ||
        task.assignedToTerminalId !== input.agentId ||
        task.status !== "running"
      )
        throw this.error(
          "TEAM_TASK_ASSIGNMENT_DENIED",
          "A pergunta precisa pertencer à tarefa ativa deste integrante.",
          "Atualize a tarefa antes de solicitar informação ao usuário.",
          false
        );
      const now = this.now();
      const request = teamUserInputRequestSchema.parse({
        id: this.createId(),
        workspaceId: input.workspaceId,
        runId: run.id,
        taskId: task.id,
        agentId: input.agentId,
        compazioTerminalId: run.compazioTerminalId,
        question: input.question,
        reason: input.reason,
        expectedAnswerType: input.expectedAnswerType,
        ...(input.context === undefined ? {} : { context: input.context }),
        status: "waiting-for-user-input",
        idempotencyKey: input.idempotencyKey,
        createdAt: now
      });
      const waitingTask = teamTaskSchema.parse({ ...task, status: "waiting-for-user-input" });
      const member = state.teamMembers.find((candidate) => candidate.terminalId === input.agentId);
      const blockedRun = teamRunSchema.parse({ ...run, status: "blocked" });
      return {
        state: {
          ...state,
          teamUserInputRequests: [...state.teamUserInputRequests, request],
          teamTasks: replaceById(state.teamTasks, waitingTask),
          teamMembers:
            member === undefined
              ? state.teamMembers
              : replaceById(
                  state.teamMembers,
                  teamMemberSchema.parse({ ...member, status: "waiting" })
                ),
          teamRuns: replaceById(state.teamRuns, blockedRun),
          events: [
            ...state.events,
            this.event(
              "attention.created",
              input.workspaceId,
              input.agentId,
              request.id,
              this.createId(),
              { kind: "waiting-for-user-input", taskId: task.id },
              run.id
            )
          ]
        },
        result: request
      };
    });
  }

  public async answerTeamUserInputRequest(input: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly actor: string;
  }): Promise<TeamUserInputRequest> {
    return this.mutate(input.workspaceId, (state) => {
      const current = state.teamUserInputRequests.find((request) => request.id === input.requestId);
      if (current === undefined)
        throw this.error(
          "TEAM_TASK_NOT_FOUND",
          "A solicitação de informação não foi encontrada.",
          "Atualize a equipe.",
          false
        );
      if (current.status === "answered") {
        if (current.answer === input.answer) return { state, result: current };
        throw this.error(
          "TEAM_TASK_ALREADY_COMPLETED",
          "Esta solicitação já recebeu uma resposta diferente.",
          "Consulte o histórico da missão.",
          false
        );
      }
      const now = this.now();
      const answered = teamUserInputRequestSchema.parse({
        ...current,
        status: "answered",
        answer: input.answer,
        answeredAt: now
      });
      const task = state.teamTasks.find((candidate) => candidate.id === current.taskId);
      const member = state.teamMembers.find(
        (candidate) => candidate.terminalId === current.agentId
      );
      const run = state.teamRuns.find((candidate) => candidate.id === current.runId);
      return {
        state: {
          ...state,
          teamUserInputRequests: replaceById(state.teamUserInputRequests, answered),
          teamTasks:
            task?.status === "waiting-for-user-input"
              ? replaceById(state.teamTasks, teamTaskSchema.parse({ ...task, status: "running" }))
              : state.teamTasks,
          teamMembers:
            member === undefined
              ? state.teamMembers
              : replaceById(
                  state.teamMembers,
                  teamMemberSchema.parse({ ...member, status: "working" })
                ),
          teamRuns:
            run === undefined
              ? state.teamRuns
              : replaceById(
                  state.teamRuns,
                  teamRunSchema.parse({
                    ...run,
                    status: task?.reviewOf === undefined ? "running" : "review"
                  })
                ),
          events: [
            ...state.events,
            this.event(
              "attention.resolved",
              input.workspaceId,
              input.actor,
              answered.id,
              this.createId(),
              { kind: "user-input-answered", taskId: current.taskId },
              current.runId
            )
          ]
        },
        result: answered
      };
    });
  }

  /** The durable side of AgentMessageBus. Delivery is performed by TeamCoordinator afterwards. */
  public async enqueueAgentMessage(
    input: Omit<AgentMessage, "id" | "createdAt" | "status" | "attempt" | "maxAttempts"> & {
      readonly id?: string;
      readonly createdAt?: string;
    }
  ): Promise<AgentMessage> {
    return this.mutate(input.workspaceId, (state) => {
      const existing = state.messages.find(
        (message) =>
          message.idempotencyKey === input.idempotencyKey &&
          message.fromTerminalId === input.fromTerminalId
      );
      if (existing !== undefined) return { state, result: existing };
      const message = agentMessageSchema.parse({
        ...input,
        id: input.id ?? this.createId(),
        status: "queued",
        createdAt: input.createdAt ?? this.now()
      });
      const taskRunId =
        input.taskId === undefined
          ? undefined
          : state.teamTasks.find((task) => task.id === input.taskId)?.runId;
      const run =
        taskRunId === undefined
          ? this.activeTeamRun(state, input.fromTerminalId)
          : state.teamRuns.find((candidate) => candidate.id === taskRunId);
      return {
        state: {
          ...state,
          messages: [...state.messages, message],
          events: [
            ...state.events,
            this.event(
              "message.sent",
              input.workspaceId,
              input.fromTerminalId,
              message.id,
              message.correlationId,
              { type: message.type },
              run?.id
            )
          ]
        },
        result: message
      };
    });
  }

  public async updateAgentMessage(
    workspaceId: string,
    messageId: string,
    status: AgentMessage["status"],
    actor: string
  ): Promise<AgentMessage> {
    return this.mutate(workspaceId, (state) => {
      const current = state.messages.find((message) => message.id === messageId);
      if (current === undefined)
        throw this.error(
          "MESSAGE_NOT_FOUND",
          "A mensagem não foi encontrada.",
          "Atualize o histórico.",
          false
        );
      const now = this.now();
      const message = agentMessageSchema.parse({
        ...current,
        status,
        ...(status === "delivered" ? { deliveredAt: now } : {}),
        ...(status === "acknowledged" ? { acknowledgedAt: now } : {})
      });
      const event =
        status === "acknowledged"
          ? "message.acknowledged"
          : status === "failed"
            ? "message.failed"
            : "message.delivered";
      return {
        state: {
          ...state,
          messages: replaceById(state.messages, message),
          events: [
            ...state.events,
            this.event(
              event,
              workspaceId,
              actor,
              message.id,
              message.correlationId,
              { status },
              current.taskId === undefined
                ? this.activeTeamRun(state, actor)?.id
                : state.teamTasks.find((task) => task.id === current.taskId)?.runId
            )
          ]
        },
        result: message
      };
    });
  }

  public async recordNote(input: {
    readonly workspaceId: string;
    readonly actorTerminalId: string;
    readonly noteId: string;
    readonly action: "created" | "updated";
  }): Promise<void> {
    await this.recordSimpleEvent(
      input.workspaceId,
      input.actorTerminalId,
      input.action === "created" ? "note.created" : "note.updated",
      input.noteId
    );
  }

  /** Records safe file/Git activity without retaining file contents or absolute personal paths. */
  public async recordOperationalEvent(input: {
    readonly workspaceId: string;
    readonly actor?: string;
    readonly type: RunEventType;
    readonly target: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    await this.recordSimpleEvent(
      input.workspaceId,
      input.actor ?? "user",
      input.type,
      input.target,
      input.metadata
    );
  }

  public async recordTaskSent(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly orchestratorTerminalId: string;
    readonly targetTerminalId: string;
    readonly edgeId: string;
    readonly title: string;
    readonly description: string;
  }): Promise<OrchestrationTask> {
    return this.mutate(input.workspaceId, (state) => {
      const existing = state.tasks.find((task) => task.id === input.id);
      if (existing !== undefined) return { state, result: existing };
      const ensured = this.ensureRunInState(state, input.orchestratorTerminalId);
      const now = this.now();
      const correlationId = this.createId();
      const policy = getExecutionPolicy(ensured.run.policyId);
      let task = orchestrationTaskSchema.parse({
        id: input.id,
        runId: ensured.run.id,
        title: input.title,
        description: input.description,
        assignedTerminalId: input.targetTerminalId,
        status: "queued",
        dependencyIds: [],
        attempt: 1,
        maxAttempts: policy.maxAutomaticRetries + 1,
        attempts: [
          {
            number: 1,
            terminalId: input.targetTerminalId,
            status: "running",
            startedAt: now
          }
        ],
        createdAt: now
      });
      task = transitionTask(task, "assigned", now, correlationId);
      task = transitionTask(task, "running", now, correlationId);
      const activity = connectionActivitySchema.parse({
        id: this.createId(),
        runId: ensured.run.id,
        edgeId: input.edgeId,
        sourceNodeId: input.orchestratorTerminalId,
        targetNodeId: input.targetTerminalId,
        kind: "task",
        status: "processing",
        preview: safePreview(input.description),
        attempt: 1,
        correlationId,
        createdAt: now,
        updatedAt: now,
        unread: true
      });
      const updatedRun = orchestrationRunSchema.parse({
        ...ensured.run,
        taskIds: [...ensured.run.taskIds, task.id],
        updatedAt: now
      });
      const eventTypes: readonly RunEventType[] = ["task.created", "task.assigned", "task.started"];
      const next = {
        ...ensured.state,
        runs: replaceById(ensured.state.runs, updatedRun),
        tasks: [...ensured.state.tasks, task],
        assignments: ensured.state.assignments.map((assignment) =>
          assignment.runId === ensured.run.id && assignment.terminalId === input.targetTerminalId
            ? { ...assignment, taskIds: [...new Set([...assignment.taskIds, task.id])] }
            : assignment
        ),
        activities: [...ensured.state.activities, activity],
        events: [
          ...ensured.state.events,
          ...eventTypes.map((type) =>
            this.event(
              type,
              input.workspaceId,
              input.orchestratorTerminalId,
              task.id,
              correlationId,
              { terminalId: input.targetTerminalId, attempt: 1 },
              ensured.run.id
            )
          )
        ]
      };
      return { state: next, result: task };
    });
  }

  public async recordTaskTerminalState(
    workspaceId: string,
    taskId: string,
    terminalState: "completed" | "failed" | "stopped"
  ): Promise<void> {
    let notification: OperationalNotification | undefined;
    await this.mutate(workspaceId, (state) => {
      const current = state.tasks.find((task) => task.id === taskId);
      if (current === undefined || current.status !== "running")
        return { state, result: undefined };
      const now = this.now();
      const correlationId = this.createId();
      const succeeded = terminalState === "completed";
      const failure = succeeded
        ? undefined
        : this.failure(
            "TASK_ASSIGNMENT_FAILED",
            "O agente encerrou antes de concluir a tarefa.",
            "Reinicie o agente, tente novamente ou reatribua a tarefa.",
            true,
            correlationId
          );
      const task = transitionTask(
        current,
        succeeded ? "completed" : "failed",
        now,
        correlationId,
        failure
      );
      const completedTask = {
        ...task,
        attempts: task.attempts.map((attempt) =>
          attempt.number === task.attempt
            ? {
                ...attempt,
                status: succeeded ? ("completed" as const) : ("failed" as const),
                completedAt: now,
                ...(failure === undefined ? {} : { failure })
              }
            : attempt
        )
      };
      const run = state.runs.find((candidate) => candidate.id === task.runId);
      const activityStatus = succeeded ? ("responded" as const) : ("failed" as const);
      let next: WorkspaceOperationalState = {
        ...state,
        tasks: replaceById(state.tasks, orchestrationTaskSchema.parse(completedTask)),
        activities: state.activities.map((activity) =>
          activity.runId === task.runId &&
          activity.targetNodeId === task.assignedTerminalId &&
          activity.status === "processing"
            ? {
                ...activity,
                status: activityStatus,
                updatedAt: now,
                completedAt: now,
                ...(failure === undefined ? {} : { error: failure })
              }
            : activity
        ),
        events: [
          ...state.events,
          this.event(
            succeeded ? "task.completed" : "task.failed",
            workspaceId,
            task.assignedTerminalId ?? "system",
            task.id,
            correlationId,
            { attempt: task.attempt },
            task.runId
          )
        ]
      };
      if (!succeeded && run !== undefined && run.status !== "needs-attention") {
        const updatedRun = transitionRun(run, "needs-attention", now, correlationId, failure);
        const attention = this.attention(
          workspaceId,
          "process-failure",
          "blocking",
          "Um agente falhou durante a execução",
          correlationId,
          task.runId,
          task.assignedTerminalId,
          failure?.message
        );
        next = {
          ...next,
          runs: replaceById(next.runs, updatedRun),
          attention: [...next.attention, attention],
          events: [
            ...next.events,
            this.event(
              "attention.created",
              workspaceId,
              "system",
              attention.id,
              correlationId,
              {},
              task.runId
            )
          ]
        };
        notification = {
          kind: "failure",
          title: "Agente precisa de atenção",
          body: "Uma tarefa falhou. Abra o Compazio para recuperar a execução.",
          workspaceId,
          runId: task.runId,
          ...(task.assignedTerminalId === undefined ? {} : { terminalId: task.assignedTerminalId })
        };
      } else if (succeeded && run !== undefined) {
        const runTasks = next.tasks.filter((candidate) => candidate.runId === run.id);
        const activeTerminalIds = next.assignments
          .filter(
            (assignment) => assignment.runId === run.id && assignment.releasedAt === undefined
          )
          .map((assignment) => assignment.terminalId);
        const everyAssignedAgentReceivedWork = activeTerminalIds.every((terminalId) =>
          runTasks.some((candidate) => candidate.assignedTerminalId === terminalId)
        );
        if (
          runTasks.length > 0 &&
          everyAssignedAgentReceivedWork &&
          runTasks.every((candidate) => candidate.status === "completed") &&
          ["running", "waiting"].includes(run.status)
        ) {
          next = {
            ...next,
            runs: replaceById(next.runs, transitionRun(run, "completed", now, correlationId)),
            events: [
              ...next.events,
              this.event("run.completed", workspaceId, "system", run.id, correlationId, {}, run.id)
            ]
          };
          notification = {
            kind: "completed",
            title: "Equipe concluída",
            body: "A execução terminou. Abra o Compazio para revisar o resultado.",
            workspaceId,
            runId: run.id
          };
        }
      }
      return { state: next, result: undefined };
    });
    if (notification !== undefined) await this.sendNotification(notification);
  }

  public async recordTaskTimeout(workspaceId: string, taskId: string): Promise<void> {
    let notification: OperationalNotification | undefined;
    await this.mutate(workspaceId, (state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined || task.status !== "running") return { state, result: undefined };
      const now = this.now();
      const correlationId = this.createId();
      const failure = this.failure(
        "TASK_TIMEOUT",
        "A tarefa excedeu o tempo de espera.",
        "Tente novamente, reatribua ou continue acompanhando manualmente.",
        true,
        correlationId
      );
      const failed = transitionTask(task, "failed", now, correlationId, failure);
      const run = state.runs.find((candidate) => candidate.id === task.runId);
      const attention = this.attention(
        workspaceId,
        "timeout",
        "warning",
        "Tarefa sem resposta",
        correlationId,
        task.runId,
        task.assignedTerminalId,
        "A ausência de resposta foi registrada; o terminal continua disponível."
      );
      notification = {
        kind: "attention",
        title: "Tarefa sem resposta",
        body: "Uma tarefa excedeu o tempo configurado.",
        workspaceId,
        runId: task.runId,
        ...(task.assignedTerminalId === undefined ? {} : { terminalId: task.assignedTerminalId })
      };
      return {
        state: {
          ...state,
          tasks: replaceById(state.tasks, failed),
          runs:
            run === undefined || run.status === "needs-attention"
              ? state.runs
              : replaceById(
                  state.runs,
                  transitionRun(run, "needs-attention", now, correlationId, failure)
                ),
          activities: state.activities.map((activity) =>
            activity.runId === task.runId &&
            activity.targetNodeId === task.assignedTerminalId &&
            activity.status === "processing"
              ? {
                  ...activity,
                  status: "timed-out" as const,
                  updatedAt: now,
                  completedAt: now,
                  error: failure
                }
              : activity
          ),
          attention: [...state.attention, attention],
          events: [
            ...state.events,
            this.event(
              "task.failed",
              workspaceId,
              "system",
              task.id,
              correlationId,
              { reason: "timeout", attempt: task.attempt },
              task.runId
            ),
            this.event(
              "attention.created",
              workspaceId,
              "system",
              attention.id,
              correlationId,
              {},
              task.runId
            )
          ]
        },
        result: undefined
      };
    });
    if (notification !== undefined) await this.sendNotification(notification);
  }

  public async retryTask(
    workspaceId: string,
    taskId: string,
    idempotencyKey: string
  ): Promise<RecoveryAction> {
    const prepared = await this.mutate<PreparedTaskRecovery>(workspaceId, (state) => {
      const duplicate = state.recoveryActions.find(
        (action) => action.idempotencyKey === idempotencyKey
      );
      if (duplicate !== undefined) return { state, result: { action: duplicate, task: undefined } };
      const current = state.tasks.find((task) => task.id === taskId);
      if (current === undefined)
        throw this.error(
          "ORCHESTRATION_RUN_NOT_FOUND",
          "A tarefa não foi encontrada.",
          "Atualize o histórico e tente novamente.",
          false
        );
      if (current.status !== "failed") {
        throw this.error(
          "ORCHESTRATION_INVALID_TRANSITION",
          "Somente tarefas que falharam podem ser tentadas novamente.",
          "Aguarde a tarefa terminar ou escolha cancelar.",
          false
        );
      }
      if (current.attempt >= current.maxAttempts) {
        throw this.error(
          "TASK_RETRY_EXHAUSTED",
          `A tarefa já usou ${current.attempt} de ${current.maxAttempts} tentativas.`,
          "Reatribua a tarefa ou altere a política para decisões futuras.",
          false
        );
      }
      const now = this.now();
      const correlationId = this.createId();
      let nextTask = transitionTask(current, "queued", now, correlationId);
      nextTask = {
        ...nextTask,
        attempt: current.attempt + 1,
        completedAt: undefined,
        failure: undefined
      };
      nextTask = transitionTask(nextTask, "assigned", now, correlationId);
      nextTask = transitionTask(nextTask, "running", now, correlationId);
      nextTask = orchestrationTaskSchema.parse({
        ...nextTask,
        attempts: [
          ...current.attempts,
          {
            number: nextTask.attempt,
            ...(nextTask.assignedTerminalId === undefined
              ? {}
              : { terminalId: nextTask.assignedTerminalId }),
            status: "running",
            startedAt: now
          }
        ]
      });
      const action = recoveryActionSchema.parse({
        id: this.createId(),
        workspaceId,
        runId: current.runId,
        taskId,
        type: "retry-task",
        idempotencyKey,
        correlationId,
        previousState: current.status,
        resultState: nextTask.status,
        status: "started",
        createdAt: now
      });
      const previousActivity = [...state.activities]
        .reverse()
        .find(
          (activity) =>
            activity.runId === current.runId &&
            activity.targetNodeId === current.assignedTerminalId &&
            activity.kind === "task"
        );
      const retryActivity =
        previousActivity === undefined
          ? undefined
          : connectionActivitySchema.parse({
              id: this.createId(),
              runId: current.runId,
              edgeId: previousActivity.edgeId,
              sourceNodeId: previousActivity.sourceNodeId,
              targetNodeId: previousActivity.targetNodeId,
              kind: "task",
              status: "processing",
              preview: previousActivity.preview,
              attempt: nextTask.attempt,
              correlationId,
              createdAt: now,
              updatedAt: now,
              unread: true
            });
      const next = {
        ...state,
        tasks: replaceById(state.tasks, nextTask),
        activities:
          retryActivity === undefined ? state.activities : [...state.activities, retryActivity],
        recoveryActions: [...state.recoveryActions, action],
        events: [
          ...state.events,
          this.event(
            "task.retried",
            workspaceId,
            "user",
            taskId,
            correlationId,
            { attempt: nextTask.attempt },
            current.runId
          )
        ]
      };
      return { state: next, result: { action, task: nextTask } };
    });
    if (prepared.task === undefined) return prepared.action;
    return this.dispatchRecovery(prepared.action, prepared.task);
  }

  public async reassignTask(
    workspaceId: string,
    taskId: string,
    terminalId: string,
    idempotencyKey: string
  ): Promise<RecoveryAction> {
    const prepared = await this.mutate<PreparedTaskRecovery>(workspaceId, (state) => {
      const duplicate = state.recoveryActions.find(
        (action) => action.idempotencyKey === idempotencyKey
      );
      if (duplicate !== undefined) return { state, result: { action: duplicate, task: undefined } };
      const current = state.tasks.find((task) => task.id === taskId);
      if (current === undefined)
        throw this.error(
          "ORCHESTRATION_RUN_NOT_FOUND",
          "A tarefa não foi encontrada.",
          "Atualize o histórico.",
          false
        );
      if (!["failed", "waiting-input", "waiting-dependency", "assigned"].includes(current.status)) {
        throw this.error(
          "TASK_REASSIGNMENT_FAILED",
          "A tarefa não está em um estado seguro para reatribuição.",
          "Interrompa a tentativa atual antes de reatribuir.",
          false
        );
      }
      const now = this.now();
      const correlationId = this.createId();
      const manual = terminalId === "manual";
      const reassigned = orchestrationTaskSchema.parse({
        ...current,
        assignedTerminalId: manual ? undefined : terminalId,
        status: manual ? "waiting-input" : "running",
        attempt: current.attempt + 1,
        maxAttempts: Math.max(current.maxAttempts, current.attempt + 1),
        completedAt: undefined,
        failure: undefined,
        attempts: [
          ...current.attempts,
          {
            number: current.attempt + 1,
            ...(manual ? {} : { terminalId }),
            status: "running",
            startedAt: now
          }
        ]
      });
      const action = recoveryActionSchema.parse({
        id: this.createId(),
        workspaceId,
        runId: current.runId,
        taskId,
        type: "reassign-task",
        idempotencyKey,
        correlationId,
        previousState: `${current.status}:${current.assignedTerminalId ?? "manual"}`,
        resultState: `${manual ? "waiting-input" : "running"}:${terminalId}`,
        status: manual ? "completed" : "started",
        createdAt: now,
        ...(manual ? { completedAt: now } : {})
      });
      return {
        state: {
          ...state,
          tasks: replaceById(state.tasks, reassigned),
          assignments: state.assignments.map((assignment) =>
            !manual && assignment.runId === current.runId && assignment.terminalId === terminalId
              ? { ...assignment, taskIds: [...new Set([...assignment.taskIds, taskId])] }
              : assignment
          ),
          recoveryActions: [...state.recoveryActions, action],
          events: [
            ...state.events,
            this.event(
              "task.reassigned",
              workspaceId,
              "user",
              taskId,
              correlationId,
              {
                previousTerminalId: current.assignedTerminalId ?? null,
                terminalId,
                attempt: reassigned.attempt
              },
              current.runId
            )
          ]
        },
        result: { action, task: manual ? undefined : reassigned }
      };
    });
    if (prepared.task === undefined) return prepared.action;
    return this.dispatchRecovery(prepared.action, prepared.task);
  }

  public async pauseRun(workspaceId: string, runId: string): Promise<OrchestrationRun> {
    return this.changeRunState(workspaceId, runId, "paused", "run.paused");
  }

  public async resumeRun(workspaceId: string, runId: string): Promise<OrchestrationRun> {
    return this.changeRunState(workspaceId, runId, "running", "run.resumed");
  }

  public async cancelRun(workspaceId: string, runId: string): Promise<OrchestrationRun> {
    return this.mutate(workspaceId, (state) => {
      const run = this.requireRun(state, runId);
      const now = this.now();
      const correlationId = this.createId();
      const cancelled = transitionRun(run, "cancelled", now, correlationId);
      const tasks = state.tasks.map((task) => {
        if (
          task.runId !== runId ||
          task.status === "completed" ||
          task.status === "cancelled" ||
          task.status === "failed"
        )
          return task;
        return transitionTask(task, "cancelled", now, correlationId);
      });
      return {
        state: {
          ...state,
          runs: replaceById(state.runs, cancelled),
          tasks,
          events: [
            ...state.events,
            this.event("run.cancelled", workspaceId, "user", runId, correlationId, {}, runId)
          ]
        },
        result: cancelled
      };
    });
  }

  public async cancelTask(workspaceId: string, taskId: string): Promise<OrchestrationTask> {
    return this.mutate(workspaceId, (state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined)
        throw this.error(
          "ORCHESTRATION_RUN_NOT_FOUND",
          "A tarefa não foi encontrada.",
          "Atualize o histórico.",
          false
        );
      if (["completed", "failed", "cancelled"].includes(task.status))
        return { state, result: task };
      const now = this.now();
      const correlationId = this.createId();
      const cancelled = transitionTask(task, "cancelled", now, correlationId);
      return {
        state: {
          ...state,
          tasks: replaceById(state.tasks, cancelled),
          events: [
            ...state.events,
            this.event("task.cancelled", workspaceId, "user", taskId, correlationId, {}, task.runId)
          ]
        },
        result: cancelled
      };
    });
  }

  public async recoverRun(
    workspaceId: string,
    runId: string,
    action: "resume" | "restart-agents" | "end" | "canvas-only",
    idempotencyKey: string
  ): Promise<RecoveryAction> {
    const prepared = await this.mutate<PreparedRunRecovery>(workspaceId, (state) => {
      const duplicate = state.recoveryActions.find(
        (candidate) => candidate.idempotencyKey === idempotencyKey
      );
      if (duplicate !== undefined) return { state, result: { action: duplicate, run: undefined } };
      const run = this.requireRun(state, runId);
      if (run.status !== "needs-attention" && action !== "end" && action !== "canvas-only") {
        throw this.error(
          "RUN_RECOVERY_REQUIRED",
          "Esta execução não está aguardando recuperação.",
          "Atualize o histórico da execução.",
          false
        );
      }
      const now = this.now();
      const correlationId = this.createId();
      const targetStatus = action === "end" || action === "canvas-only" ? "cancelled" : "running";
      const updatedRun = transitionRun(run, targetStatus, now, correlationId);
      const recovery = recoveryActionSchema.parse({
        id: this.createId(),
        workspaceId,
        runId,
        type: "recover-run",
        idempotencyKey,
        correlationId,
        previousState: run.status,
        resultState: targetStatus,
        status: action === "restart-agents" ? "started" : "completed",
        createdAt: now,
        ...(action === "restart-agents" ? {} : { completedAt: now })
      });
      return {
        state: {
          ...state,
          runs: replaceById(state.runs, updatedRun),
          attention: state.attention.map((request) =>
            request.runId === runId && request.type === "recovery" && request.status === "open"
              ? { ...request, status: "resolved" as const, resolvedAt: now }
              : request
          ),
          recoveryActions: [...state.recoveryActions, recovery],
          events: [
            ...state.events,
            this.event(
              "recovery.performed",
              workspaceId,
              "user",
              recovery.id,
              correlationId,
              { action, status: targetStatus },
              runId
            )
          ]
        },
        result: { action: recovery, run }
      };
    });
    if (prepared.run === undefined || action !== "restart-agents") return prepared.action;
    try {
      const state = await this.get(workspaceId);
      const terminalIds = [
        prepared.run.orchestratorTerminalId,
        ...state.assignments
          .filter((assignment) => assignment.runId === runId && assignment.releasedAt === undefined)
          .map((assignment) => assignment.terminalId)
      ];
      for (const terminalId of terminalIds) {
        const session = this.options.workspaces.sessionForNode(workspaceId, terminalId);
        if (session === null) await this.options.workspaces.startTerminal(workspaceId, terminalId);
        else await this.options.workspaces.restartTerminal(workspaceId, terminalId, session.id);
      }
      return this.finishRecovery(prepared.action, "completed");
    } catch (cause: unknown) {
      await this.finishRecovery(prepared.action, "failed", cause);
      throw this.error(
        "RECOVERY_ACTION_FAILED",
        "Não foi possível reiniciar todos os agentes.",
        "Abra os terminais individualmente e retome quando estiverem prontos.",
        true,
        cause
      );
    }
  }

  public async updateNotificationPreferences(
    workspaceId: string,
    preferences: WorkspaceOperationalState["notificationPreferences"]
  ): Promise<WorkspaceOperationalState> {
    return this.mutate(workspaceId, (state) => {
      const next = workspaceOperationalStateSchema.parse({
        ...state,
        notificationPreferences: preferences
      });
      return { state: next, result: next };
    });
  }

  public async recordProcessFailure(
    workspaceId: string,
    terminalId: string,
    description = "O processo do agente encerrou inesperadamente."
  ): Promise<AttentionRequest | null> {
    let notification: OperationalNotification | undefined;
    const request = await this.mutate(workspaceId, (state) => {
      const duplicate = state.attention.find(
        (candidate) =>
          candidate.terminalId === terminalId &&
          candidate.type === "process-failure" &&
          candidate.status === "open"
      );
      if (duplicate !== undefined) return { state, result: duplicate };
      const run = [...state.runs]
        .reverse()
        .find(
          (candidate) =>
            candidate.orchestratorTerminalId === terminalId ||
            state.assignments.some(
              (assignment) =>
                assignment.runId === candidate.id &&
                assignment.terminalId === terminalId &&
                assignment.releasedAt === undefined
            )
        );
      if (run === undefined || ["completed", "failed", "cancelled"].includes(run.status))
        return { state, result: null };
      const now = this.now();
      const correlationId = this.createId();
      const orchestratorDisconnected = run.orchestratorTerminalId === terminalId;
      const failure = this.failure(
        orchestratorDisconnected ? "ORCHESTRATOR_DISCONNECTED" : "TASK_ASSIGNMENT_FAILED",
        description,
        orchestratorDisconnected
          ? "Reinicie o Orquestrador e escolha como recuperar a execução."
          : "Reinicie o agente, tente novamente ou reatribua a tarefa.",
        true,
        correlationId
      );
      const attention = this.attention(
        workspaceId,
        "process-failure",
        "blocking",
        orchestratorDisconnected ? "Orquestrador desconectado" : "Agente encerrou inesperadamente",
        correlationId,
        run.id,
        terminalId,
        description
      );
      const updatedRun =
        run.status === "needs-attention"
          ? run
          : transitionRun(run, "needs-attention", now, correlationId, failure);
      notification = {
        kind: "failure",
        title: "Agente falhou",
        body: "Um agente encerrou inesperadamente e precisa de atenção.",
        workspaceId,
        runId: run.id,
        terminalId
      };
      return {
        state: {
          ...state,
          runs: replaceById(state.runs, updatedRun),
          attention: [...state.attention, attention],
          events: [
            ...state.events,
            this.event(
              "agent.failed",
              workspaceId,
              "system",
              terminalId,
              correlationId,
              {},
              run.id
            ),
            this.event(
              "attention.created",
              workspaceId,
              "system",
              attention.id,
              correlationId,
              {},
              run.id
            )
          ]
        },
        result: attention
      };
    });
    if (notification !== undefined) await this.sendNotification(notification);
    return request;
  }

  public async recordTerminalDeleted(workspaceId: string, terminalId: string): Promise<void> {
    await this.mutate(workspaceId, (state) => {
      const run = [...state.runs]
        .reverse()
        .find(
          (candidate) =>
            !["completed", "failed", "cancelled"].includes(candidate.status) &&
            (candidate.orchestratorTerminalId === terminalId ||
              state.assignments.some(
                (assignment) =>
                  assignment.runId === candidate.id && assignment.terminalId === terminalId
              ))
        );
      if (run === undefined) return { state, result: undefined };
      const now = this.now();
      const correlationId = this.createId();
      const failure = this.failure(
        "TASK_ASSIGNMENT_FAILED",
        "O agente atribuído foi excluído do canvas.",
        "Reatribua a tarefa ou continue manualmente.",
        true,
        correlationId
      );
      const tasks = state.tasks.map((task) => {
        if (
          task.runId !== run.id ||
          task.assignedTerminalId !== terminalId ||
          !["assigned", "running", "waiting-input", "waiting-dependency"].includes(task.status)
        )
          return task;
        const running =
          task.status === "assigned"
            ? transitionTask(task, "running", now, correlationId)
            : task.status === "waiting-input" || task.status === "waiting-dependency"
              ? transitionTask(task, "running", now, correlationId)
              : task;
        return transitionTask(running, "failed", now, correlationId, failure);
      });
      const attention = this.attention(
        workspaceId,
        "missing-agent",
        "blocking",
        "Agente atribuído foi excluído",
        correlationId,
        run.id,
        terminalId,
        failure.message
      );
      return {
        state: {
          ...state,
          runs:
            run.status === "needs-attention"
              ? state.runs
              : replaceById(
                  state.runs,
                  transitionRun(run, "needs-attention", now, correlationId, failure)
                ),
          tasks,
          assignments: state.assignments.map((assignment) =>
            assignment.runId === run.id &&
            assignment.terminalId === terminalId &&
            assignment.releasedAt === undefined
              ? { ...assignment, releasedAt: now }
              : assignment
          ),
          attention: [...state.attention, attention],
          events: [
            ...state.events,
            this.event(
              "agent.dismissed",
              workspaceId,
              "user",
              terminalId,
              correlationId,
              { reason: "deleted" },
              run.id
            ),
            this.event(
              "attention.created",
              workspaceId,
              "system",
              attention.id,
              correlationId,
              {},
              run.id
            )
          ]
        },
        result: undefined
      };
    });
  }

  public async resolveAttention(
    workspaceId: string,
    attentionId: string,
    disposition: "resolved" | "dismissed"
  ): Promise<AttentionRequest> {
    return this.mutate(workspaceId, (state) => {
      const current = state.attention.find((request) => request.id === attentionId);
      if (current === undefined)
        throw this.error(
          "ATTENTION_REQUEST_NOT_FOUND",
          "A solicitação de atenção não foi encontrada.",
          "Atualize a lista de atividades.",
          false
        );
      if (current.status !== "open") return { state, result: current };
      const now = this.now();
      const correlationId = this.createId();
      const updated = attentionRequestSchema.parse({
        ...current,
        status: disposition,
        resolvedAt: now
      });
      return {
        state: {
          ...state,
          attention: replaceById(state.attention, updated),
          events: [
            ...state.events,
            this.event(
              disposition === "resolved" ? "attention.resolved" : "attention.dismissed",
              workspaceId,
              "user",
              attentionId,
              correlationId,
              {},
              current.runId
            )
          ]
        },
        result: updated
      };
    });
  }

  public async createAttention(input: {
    readonly workspaceId: string;
    readonly terminalId: string;
    readonly severity: AttentionRequest["severity"];
    readonly type: AttentionRequest["type"];
    readonly title: string;
    readonly description?: string;
    readonly idempotencyKey?: string;
  }): Promise<AttentionRequest> {
    let notification: OperationalNotification | undefined;
    const request = await this.mutate(input.workspaceId, (state) => {
      const duplicate =
        input.idempotencyKey === undefined
          ? undefined
          : state.attention.find(
              (candidate) =>
                candidate.correlationId === input.idempotencyKey &&
                candidate.terminalId === input.terminalId
            );
      if (duplicate !== undefined) return { state, result: duplicate };
      const run = this.activeRun(state, input.terminalId);
      const now = this.now();
      const correlationId = input.idempotencyKey ?? this.createId();
      const attention = this.attention(
        input.workspaceId,
        input.type,
        input.severity,
        input.title,
        correlationId,
        run?.id,
        input.terminalId,
        input.description
      );
      const canBlockRun =
        input.severity === "blocking" &&
        run !== undefined &&
        ["running", "waiting"].includes(run.status);
      const nextRun =
        canBlockRun && run !== undefined
          ? transitionRun(run, "needs-attention", now, correlationId)
          : run;
      notification = {
        kind: "attention",
        title: input.title,
        body: "Um agente solicitou sua atenção. Abra o Compazio para revisar.",
        workspaceId: input.workspaceId,
        ...(run === undefined ? {} : { runId: run.id }),
        terminalId: input.terminalId
      };
      return {
        state: {
          ...state,
          runs: nextRun === undefined ? state.runs : replaceById(state.runs, nextRun),
          attention: [...state.attention, attention],
          events: [
            ...state.events,
            this.event(
              "attention.created",
              input.workspaceId,
              input.terminalId,
              attention.id,
              correlationId,
              { severity: input.severity, type: input.type },
              run?.id
            )
          ]
        },
        result: attention
      };
    });
    if (notification !== undefined) await this.sendNotification(notification);
    return request;
  }

  public async recordDismiss(
    workspaceId: string,
    orchestratorTerminalId: string,
    terminalId: string
  ): Promise<void> {
    await this.mutate(workspaceId, (state) => {
      const assignment = [...state.assignments]
        .reverse()
        .find(
          (candidate) => candidate.terminalId === terminalId && candidate.releasedAt === undefined
        );
      const run = state.runs.find(
        (candidate) =>
          candidate.id === assignment?.runId &&
          candidate.orchestratorTerminalId === orchestratorTerminalId
      );
      const now = this.now();
      const correlationId = this.createId();
      return {
        state: {
          ...state,
          assignments: state.assignments.map((assignment) =>
            assignment.runId === run?.id &&
            assignment.terminalId === terminalId &&
            assignment.releasedAt === undefined
              ? { ...assignment, releasedAt: now }
              : assignment
          ),
          events: [
            ...state.events,
            this.event(
              "agent.dismissed",
              workspaceId,
              orchestratorTerminalId,
              terminalId,
              correlationId,
              {},
              run?.id
            )
          ]
        },
        result: undefined
      };
    });
  }

  public async markNodeManual(workspaceId: string, nodeId: string): Promise<void> {
    await this.mutate(workspaceId, (state) => ({
      state: {
        ...state,
        teamLayouts: state.teamLayouts.map((layout) =>
          layout.nodeIds.includes(nodeId)
            ? {
                ...layout,
                manualNodeIds: [...new Set([...layout.manualNodeIds, nodeId])],
                updatedAt: this.now()
              }
            : layout
        )
      },
      result: undefined
    }));
  }

  public async organizeTeam(
    workspaceId: string,
    runId: string,
    force: boolean
  ): Promise<{ readonly layout: TeamLayout; readonly bounds: TeamLayoutBounds }> {
    const state = await this.get(workspaceId);
    const run = this.requireRun(state, runId);
    const workspace = await this.options.workspaces.snapshot(workspaceId);
    const assignmentIds = state.assignments
      .filter((assignment) => assignment.runId === runId && assignment.releasedAt === undefined)
      .map((assignment) => assignment.terminalId);
    const connectedNoteIds = workspace.edges.flatMap((edge) => {
      if (
        [...assignmentIds, run.orchestratorTerminalId].includes(edge.sourceNodeId) &&
        workspace.nodes.some((node) => node.id === edge.targetNodeId && node.type === "note")
      )
        return [edge.targetNodeId];
      return [];
    });
    const nodeIds = [
      ...new Set([run.orchestratorTerminalId, ...assignmentIds, ...connectedNoteIds])
    ];
    const previous = state.teamLayouts.find((layout) => layout.runId === runId);
    const result = organizeTeam({
      orchestratorId: run.orchestratorTerminalId,
      teamNodeIds: nodeIds,
      force,
      nodes: workspace.nodes.map((node) => ({
        id: node.id,
        kind:
          node.id === run.orchestratorTerminalId
            ? "orchestrator"
            : node.type === "note"
              ? "note"
              : assignmentIds.includes(node.id)
                ? "agent"
                : "other",
        position: node.position,
        size: node.size,
        manual:
          node.id === run.orchestratorTerminalId ||
          (previous?.manualNodeIds.includes(node.id) ?? false)
      }))
    });
    const positions = Object.fromEntries(
      Object.entries(result.positions).filter(([nodeId]) => nodeId !== run.orchestratorTerminalId)
    );
    if (Object.keys(positions).length > 0)
      await this.options.workspaces.moveNodes(workspaceId, positions);
    const layout = await this.mutate(workspaceId, (current) => {
      const now = this.now();
      const correlationId = this.createId();
      const nextLayout = teamLayoutSchema.parse({
        id: previous?.id ?? this.createId(),
        runId,
        orchestratorTerminalId: run.orchestratorTerminalId,
        nodeIds,
        manualNodeIds: force ? [] : (previous?.manualNodeIds ?? []),
        positions: result.positions,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: now
      });
      return {
        state: {
          ...current,
          teamLayouts: replaceLayout(current.teamLayouts, nextLayout),
          events: [
            ...current.events,
            this.event(
              "layout.organized",
              workspaceId,
              "system",
              nextLayout.id,
              correlationId,
              { force, nodeCount: nodeIds.length },
              runId
            )
          ]
        },
        result: nextLayout
      };
    });
    return { layout, bounds: result.bounds };
  }

  public async teamBounds(workspaceId: string, runId: string): Promise<TeamLayoutBounds> {
    const state = await this.get(workspaceId);
    const run = this.requireRun(state, runId);
    const workspace = await this.options.workspaces.snapshot(workspaceId);
    const layout = state.teamLayouts.find((candidate) => candidate.runId === runId);
    const nodeIds = layout?.nodeIds ?? [
      run.orchestratorTerminalId,
      ...state.assignments
        .filter((assignment) => assignment.runId === runId)
        .map((assignment) => assignment.terminalId)
    ];
    const nodes = workspace.nodes.filter((node) => nodeIds.includes(node.id));
    if (nodes.length === 0)
      throw this.error(
        "LAYOUT_CONFLICT",
        "A equipe não possui nós visíveis.",
        "Restaure o canvas ou encerre a execução.",
        false
      );
    const x = Math.min(...nodes.map((node) => node.position.x));
    const y = Math.min(...nodes.map((node) => node.position.y));
    const right = Math.max(...nodes.map((node) => node.position.x + node.size.width));
    const bottom = Math.max(...nodes.map((node) => node.position.y + node.size.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  public async deleteTeam(workspaceId: string, runId: string): Promise<void> {
    const state = await this.get(workspaceId);
    this.requireRun(state, runId);
    const terminalIds = state.assignments
      .filter((assignment) => assignment.runId === runId)
      .map((assignment) => assignment.terminalId);
    for (const terminalId of terminalIds) {
      await this.options.workspaces.deleteNode(workspaceId, terminalId);
    }
    await this.mutate(workspaceId, (current) => ({
      state: {
        ...current,
        runs: current.runs.filter((candidate) => candidate.id !== runId),
        tasks: current.tasks.filter((task) => task.runId !== runId),
        assignments: current.assignments.filter((assignment) => assignment.runId !== runId),
        activities: current.activities.filter((activity) => activity.runId !== runId),
        attention: current.attention.filter((request) => request.runId !== runId),
        events: current.events.filter((event) => event.runId !== runId),
        recoveryActions: current.recoveryActions.filter((action) => action.runId !== runId),
        teamLayouts: current.teamLayouts.filter((layout) => layout.runId !== runId),
        lastSelectedRunId:
          current.lastSelectedRunId === runId ? undefined : current.lastSelectedRunId
      },
      result: undefined
    }));
  }

  public clearWorkspace(workspaceId: string): void {
    this.cache.delete(workspaceId);
    this.loads.delete(workspaceId);
    this.mutationTails.delete(workspaceId);
  }

  private async dispatchRecovery(
    action: RecoveryAction,
    task: OrchestrationTask
  ): Promise<RecoveryAction> {
    try {
      if (task.assignedTerminalId === undefined)
        throw new Error("A recuperação manual não possui terminal de destino");
      const execution = await this.options.workspaces.startBackgroundAgentTask({
        workspaceId: action.workspaceId,
        terminalId: task.assignedTerminalId,
        prompt: recoveryTaskPrompt(task),
        workspaceAccess: "write"
      });
      this.recoveryTasksBySession.set(execution.session.id, {
        workspaceId: action.workspaceId,
        taskId: task.id
      });
      void execution.completion.then(({ session }) => {
        const pending = this.recoveryTasksBySession.get(session.id);
        if (pending === undefined) return;
        this.recoveryTasksBySession.delete(session.id);
        void this.recordTaskTerminalState(
          pending.workspaceId,
          pending.taskId,
          session.state as "completed" | "failed" | "stopped"
        ).catch(() => undefined);
      });
      return this.finishRecovery(action, "completed");
    } catch (cause: unknown) {
      for (const [sessionId, pending] of this.recoveryTasksBySession) {
        if (pending.workspaceId === action.workspaceId && pending.taskId === task.id) {
          this.recoveryTasksBySession.delete(sessionId);
        }
      }
      await this.finishRecovery(action, "failed", cause);
      throw this.error(
        "RECOVERY_ACTION_FAILED",
        "Não foi possível reenviar a tarefa.",
        "Verifique o agente e tente reatribuir a tarefa.",
        true,
        cause
      );
    }
  }

  private async finishRecovery(
    action: RecoveryAction,
    status: "completed" | "failed",
    cause?: unknown
  ): Promise<RecoveryAction> {
    return this.mutate(action.workspaceId, (state) => {
      const now = this.now();
      const failure =
        status === "failed"
          ? this.failure(
              "RECOVERY_ACTION_FAILED",
              "A ação de recuperação falhou.",
              "Inspecione o agente e tente outra ação.",
              true,
              action.correlationId,
              cause
            )
          : undefined;
      const finished = recoveryActionSchema.parse({
        ...action,
        status,
        completedAt: now,
        ...(failure === undefined ? {} : { failure })
      });
      return {
        state: {
          ...state,
          recoveryActions: replaceById(state.recoveryActions, finished),
          events: [
            ...state.events,
            this.event(
              "recovery.performed",
              action.workspaceId,
              "user",
              action.id,
              action.correlationId,
              { type: action.type, status },
              action.runId
            )
          ]
        },
        result: finished
      };
    });
  }

  private async changeRunState(
    workspaceId: string,
    runId: string,
    status: OrchestrationRunStatus,
    eventType: RunEventType
  ): Promise<OrchestrationRun> {
    return this.mutate(workspaceId, (state) => {
      const run = this.requireRun(state, runId);
      const correlationId = this.createId();
      const updated = transitionRun(run, status, this.now(), correlationId);
      return {
        state: {
          ...state,
          runs: replaceById(state.runs, updated),
          events: [
            ...state.events,
            this.event(eventType, workspaceId, "user", runId, correlationId, {}, runId)
          ]
        },
        result: updated
      };
    });
  }

  private async recordSimpleEvent(
    workspaceId: string,
    actor: string,
    type: RunEventType,
    target: string,
    metadata: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    await this.mutate(workspaceId, (state) => {
      const run = this.activeRun(state, actor);
      const correlationId = this.createId();
      return {
        state: {
          ...state,
          events: [
            ...state.events,
            this.event(type, workspaceId, actor, target, correlationId, metadata, run?.id)
          ]
        },
        result: undefined
      };
    });
  }

  private ensureRunInState(
    state: WorkspaceOperationalState,
    orchestratorTerminalId: string
  ): { readonly state: WorkspaceOperationalState; readonly run: OrchestrationRun } {
    const existing = this.activeRun(state, orchestratorTerminalId);
    if (existing !== undefined) return { state, run: existing };
    const now = this.now();
    const correlationId = this.createId();
    let run = orchestrationRunSchema.parse({
      id: this.createId(),
      workspaceId: state.workspaceId,
      orchestratorTerminalId,
      status: "created",
      policyId: state.policyId,
      taskIds: [],
      recruitedTerminalIds: [],
      startedAt: now,
      updatedAt: now
    });
    const created = this.event(
      "run.created",
      state.workspaceId,
      orchestratorTerminalId,
      run.id,
      correlationId,
      { policyId: state.policyId },
      run.id
    );
    run = transitionRun(run, "planning", now, correlationId);
    run = transitionRun(run, "running", now, correlationId);
    const started = this.event(
      "run.started",
      state.workspaceId,
      orchestratorTerminalId,
      run.id,
      correlationId,
      {},
      run.id
    );
    return {
      state: {
        ...state,
        runs: [...state.runs, run],
        events: [...state.events, created, started],
        lastSelectedRunId: run.id
      },
      run
    };
  }

  private activeRun(
    state: WorkspaceOperationalState,
    orchestratorTerminalId: string
  ): OrchestrationRun | undefined {
    return [...state.runs]
      .reverse()
      .find(
        (run) =>
          run.orchestratorTerminalId === orchestratorTerminalId &&
          !["completed", "failed", "cancelled"].includes(run.status)
      );
  }

  private activeTeamRun(state: WorkspaceOperationalState, terminalId: string): TeamRun | undefined {
    const member = state.teamMembers.find(
      (candidate) => candidate.terminalId === terminalId && candidate.status !== "dismissed"
    );
    return [...state.teamRuns]
      .reverse()
      .find(
        (run) =>
          !["completed", "failed", "cancelled"].includes(run.status) &&
          (run.compazioTerminalId === terminalId ||
            member?.runId === run.id ||
            (member !== undefined && run.memberIds.includes(member.id)))
      );
  }

  private requireRun(state: WorkspaceOperationalState, runId: string): OrchestrationRun {
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (run === undefined)
      throw this.error(
        "ORCHESTRATION_RUN_NOT_FOUND",
        "A execução não foi encontrada.",
        "Atualize o histórico do workspace.",
        false
      );
    return run;
  }

  private event(
    type: RunEventType,
    workspaceId: string,
    actor: string,
    target: string,
    correlationId: string,
    metadata: Readonly<Record<string, unknown>>,
    runId?: string
  ): RunEvent {
    return runEventSchema.parse({
      id: this.createId(),
      type,
      workspaceId,
      ...(runId === undefined ? {} : { runId }),
      actor,
      target,
      timestamp: this.now(),
      correlationId,
      metadata: sanitizeEventMetadata(metadata),
      schemaVersion: OPERATIONAL_SCHEMA_VERSION
    });
  }

  private attention(
    workspaceId: string,
    type: AttentionRequest["type"],
    severity: AttentionRequest["severity"],
    title: string,
    correlationId: string,
    runId?: string,
    terminalId?: string,
    description?: string
  ): AttentionRequest {
    return attentionRequestSchema.parse({
      id: this.createId(),
      workspaceId,
      ...(runId === undefined ? {} : { runId }),
      ...(terminalId === undefined ? {} : { terminalId }),
      severity,
      type,
      title,
      ...(description === undefined ? {} : { description }),
      status: "open",
      correlationId,
      createdAt: this.now()
    });
  }

  private failure(
    code: StructuredFailure["code"],
    message: string,
    suggestedAction: string,
    retryable: boolean,
    correlationId: string,
    cause?: unknown
  ): StructuredFailure {
    return {
      code,
      message,
      ...(cause instanceof Error ? { technicalDetails: cause.message.slice(0, 4_000) } : {}),
      suggestedAction,
      retryable,
      correlationId
    };
  }

  private error(
    code: StructuredFailure["code"],
    message: string,
    suggestedAction: string,
    retryable: boolean,
    causeOrCorrelation?: unknown
  ): OperationalDomainError {
    const correlationId =
      typeof causeOrCorrelation === "string" ? causeOrCorrelation : this.createId();
    return new OperationalDomainError(
      this.failure(code, message, suggestedAction, retryable, correlationId, causeOrCorrelation),
      typeof causeOrCorrelation === "string" ? undefined : causeOrCorrelation
    );
  }

  private async loadAndRecover(workspaceId: string): Promise<WorkspaceOperationalState> {
    let state = await this.options.repository.loadOperationalState(workspaceId);
    const activeRuns = state.runs.filter((run) =>
      ["planning", "running", "waiting", "needs-attention"].includes(run.status)
    );
    if (activeRuns.length > 0) {
      const now = this.now();
      for (const run of activeRuns) {
        const correlationId = this.createId();
        const failure = this.failure(
          "RUN_RECOVERY_REQUIRED",
          "Esta execução foi interrompida quando o aplicativo fechou.",
          "Retome, reinicie os agentes, encerre a execução ou mantenha somente o canvas.",
          true,
          correlationId
        );
        const updatedRun =
          run.status === "needs-attention"
            ? { ...run, failure, updatedAt: now }
            : transitionRun(run, "needs-attention", now, correlationId, failure);
        const existingAttention = state.attention.some(
          (request) =>
            request.runId === run.id && request.type === "recovery" && request.status === "open"
        );
        state = {
          ...state,
          runs: replaceById(state.runs, orchestrationRunSchema.parse(updatedRun)),
          tasks: state.tasks.map((task) => {
            if (task.runId !== run.id || !["assigned", "running"].includes(task.status))
              return task;
            const running =
              task.status === "assigned"
                ? transitionTask(task, "running", now, correlationId)
                : task;
            return transitionTask(running, "failed", now, correlationId, failure);
          }),
          attention: existingAttention
            ? state.attention
            : [
                ...state.attention,
                this.attention(
                  workspaceId,
                  "recovery",
                  "blocking",
                  "Execução interrompida",
                  correlationId,
                  run.id,
                  run.orchestratorTerminalId,
                  failure.message
                )
              ],
          events: [
            ...state.events,
            this.event(
              "run.recovery-required",
              workspaceId,
              "system",
              run.id,
              correlationId,
              {},
              run.id
            )
          ],
          updatedAt: now
        };
      }
      state = await this.options.repository.saveOperationalState(
        workspaceOperationalStateSchema.parse(state)
      );
    }
    const activeTeamRuns = state.teamRuns.filter((run) =>
      ["planning", "recruiting", "running", "review"].includes(run.status)
    );
    if (activeTeamRuns.length > 0) {
      const now = this.now();
      for (const run of activeTeamRuns) {
        const correlationId = this.createId();
        state = {
          ...state,
          teamRuns: replaceById(state.teamRuns, teamRunSchema.parse({ ...run, status: "blocked" })),
          teamTasks: state.teamTasks.map((task) =>
            task.runId === run.id && ["assigned", "running"].includes(task.status)
              ? teamTaskSchema.parse({ ...task, status: "blocked", blockedBy: task.blockedBy })
              : task
          ),
          messages: state.messages.map((message) =>
            message.status === "delivering"
              ? agentMessageSchema.parse({ ...message, status: "failed" })
              : message
          ),
          events: [
            ...state.events,
            this.event(
              "team.run.blocked",
              workspaceId,
              "system",
              run.id,
              correlationId,
              { recovered: true },
              run.id
            )
          ],
          updatedAt: now
        };
      }
      state = await this.options.repository.saveOperationalState(
        workspaceOperationalStateSchema.parse(state)
      );
    }
    this.cache.set(workspaceId, state);
    return state;
  }

  private async mutate<T>(
    workspaceId: string,
    operation: (state: WorkspaceOperationalState) => MutationResult<T> | Promise<MutationResult<T>>
  ): Promise<T> {
    const previous = this.mutationTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    this.mutationTails.set(
      workspaceId,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    await previous;
    try {
      const current = await this.get(workspaceId);
      const mutation = await operation(current);
      if (mutation.state === current) return mutation.result;
      const next = retainOperationalHistory(
        workspaceOperationalStateSchema.parse({
          ...mutation.state,
          updatedAt: this.now()
        })
      );
      await this.options.repository.saveOperationalState(next);
      this.cache.set(workspaceId, next);
      for (const listener of this.listeners) listener(next);
      return mutation.result;
    } finally {
      release();
    }
  }

  private async sendNotification(notification: OperationalNotification): Promise<void> {
    const state = await this.get(notification.workspaceId);
    const preferences = state.notificationPreferences;
    const enabled =
      (notification.kind === "completed" && preferences.executionCompleted) ||
      (notification.kind === "attention" && preferences.attentionRequired) ||
      (notification.kind === "failure" && preferences.failures) ||
      (notification.kind === "background" && preferences.backgroundActivity);
    if (!enabled || this.options.notify === undefined) return;
    const delivered = await Promise.resolve(this.options.notify(notification)).catch(() => false);
    if (delivered) return;
    await this.mutate(notification.workspaceId, (current) => {
      const correlationId = this.createId();
      return {
        state: {
          ...current,
          events: [
            ...current.events,
            this.event(
              "notification.failed",
              notification.workspaceId,
              "system",
              notification.runId ?? notification.terminalId ?? notification.workspaceId,
              correlationId,
              {
                code: "NOTIFICATION_FAILED",
                kind: notification.kind,
                retryable: false
              },
              notification.runId
            )
          ]
        },
        result: undefined
      };
    });
  }
}

export interface TeamLayoutBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function replaceById<T extends { readonly id: string }>(items: readonly T[], replacement: T): T[] {
  return items.some((item) => item.id === replacement.id)
    ? items.map((item) => (item.id === replacement.id ? replacement : item))
    : [...items, replacement];
}

function replaceLayout(items: readonly TeamLayout[], replacement: TeamLayout): TeamLayout[] {
  return items.some((item) => item.runId === replacement.runId)
    ? items.map((item) => (item.runId === replacement.runId ? replacement : item))
    : [...items, replacement];
}

function safePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}

/** Recovery is a fresh isolated agent turn, never a line written into a person's terminal. */
function recoveryTaskPrompt(task: OrchestrationTask): string {
  return [
    "Execute this recovered Compazio task in the authorized workspace.",
    "This is a private background process, not an interactive user terminal.",
    `Task: ${task.title}`,
    task.description ?? task.title,
    "Do not emit operational chatter into any terminal. Complete the requested work and exit."
  ].join("\n");
}
