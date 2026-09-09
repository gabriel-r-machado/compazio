import { randomUUID } from "node:crypto";

import {
  AUTONOMY_WORKER_BUDGETS,
  ORCHESTRATOR_LABEL,
  type ExecutionPolicyId
} from "@forgedeck/compazio-v2-domain";
import type {
  CanvasEdge,
  CanvasNode,
  EdgeCapability,
  TeamMember,
  TeamMemberCapability,
  TeamRole,
  TeamRun,
  TeamRunMissionContract,
  TeamTask,
  TeamUserInputRequest,
  TerminalSession,
  Workspace
} from "@forgedeck/compazio-v2-domain";
import { AgentAvailabilityService, type AgentRuntime } from "@forgedeck/compazio-v2-runtime";

import type { V2OperationalService } from "./operational-service";
import type { PortalRuntimeManager } from "./portal-runtime-manager";
import type { V2WorkspaceService } from "./workspace-service";

/** The complete and intentionally small MCP surface for the 5A vertical slice. */
export const teamMcpToolNames = [
  "team_list",
  "team_recruit",
  "team_status",
  "team_dismiss",
  "team_run_create",
  "team_run_instruct",
  "team_run_status",
  "team_run_cancel",
  "task_create",
  "task_assign",
  "task_list",
  "task_status",
  "task_result",
  "task_request_user_input",
  "task_wait",
  "team_user_input_list",
  "team_user_input_answer",
  "message_send",
  "message_list",
  "message_read",
  "message_acknowledge",
  "team_connect",
  "team_disconnect"
] as const;

export type TeamMcpToolName = (typeof teamMcpToolNames)[number];
export type TeamMcpCapability =
  | "team-read"
  | "team-recruit"
  | "team-manage"
  | "team-run-manage"
  | "task-create"
  | "task-assign"
  | "task-cancel"
  | "connection-manage"
  | "message-send"
  | "result-return"
  /** Legacy session capability names retained only so pre-5A sessions can be revoked safely. */
  | "team-admin"
  | "task-read"
  | "task-update"
  | "context-read";

export function teamToolsForCapabilities(
  capabilities: readonly TeamMcpCapability[]
): readonly TeamMcpToolName[] {
  const granted = new Set(capabilities);
  const allowed = new Set<TeamMcpToolName>();
  if (granted.has("team-read")) {
    allowed.add("team_list");
    allowed.add("team_status");
    allowed.add("task_status");
    allowed.add("task_result");
    allowed.add("task_list");
    allowed.add("task_wait");
    allowed.add("team_user_input_list");
  }
  if (granted.has("team-recruit")) allowed.add("team_recruit");
  if (granted.has("team-manage")) allowed.add("team_dismiss");
  if (granted.has("team-run-manage")) {
    allowed.add("team_run_create");
    allowed.add("team_run_instruct");
    allowed.add("team_run_status");
    allowed.add("team_run_cancel");
    allowed.add("team_user_input_answer");
  }
  if (granted.has("task-create")) allowed.add("task_create");
  if (granted.has("task-assign")) allowed.add("task_assign");
  if (granted.has("message-send")) {
    allowed.add("message_send");
    allowed.add("message_list");
    allowed.add("message_read");
    allowed.add("message_acknowledge");
  }
  if (granted.has("connection-manage")) {
    allowed.add("team_connect");
    allowed.add("team_disconnect");
  }
  if (granted.has("result-return")) {
    allowed.add("task_status");
    allowed.add("task_result");
    allowed.add("task_request_user_input");
  }
  return teamMcpToolNames.filter((tool) => allowed.has(tool));
}

/**
 * This only controls MCP discovery. Every operation rechecks workspace ownership, terminal state,
 * Compazio state, edge capabilities and task assignment immediately before mutating durable state.
 */
export function teamCapabilitiesForTerminal(
  workspace: Workspace,
  terminalId: string
): readonly TeamMcpCapability[] {
  const terminal = findTerminal(workspace, terminalId);
  if (terminal === undefined) return [];
  if (isCompazio(terminal)) {
    return [
      "team-read",
      "team-recruit",
      "team-manage",
      "team-run-manage",
      "task-create",
      "task-assign",
      "task-cancel",
      "message-send",
      "connection-manage"
    ];
  }
  return terminal.orchestratorOwnerNodeId === undefined
    ? []
    : ["message-send", "result-return", "team-read"];
}

export type TeamCoordinatorErrorCode =
  | "TEAM_CAPABILITY_DENIED"
  | "TEAM_RECRUIT_LIMIT_REACHED"
  | "TEAM_RECRUIT_DEPTH_EXCEEDED"
  | "TEAM_RECRUIT_CAPABILITY_DENIED"
  | "TEAM_RECRUIT_DEPTH_LIMIT"
  | "TEAM_RECRUIT_ACTIVE_LIMIT"
  | "TEAM_RECRUIT_CHILD_LIMIT"
  | "TEAM_RECRUIT_BUDGET_EXCEEDED"
  | "TEAM_MEMBER_NOT_FOUND"
  | "TEAM_MEMBER_ALREADY_EXISTS"
  | "TEAM_MEMBER_NOT_READY"
  | "TEAM_MEMBER_DISMISSED"
  | "AGENT_NOT_AVAILABLE"
  | "AGENT_PROVIDER_UNAVAILABLE"
  | "AGENT_NOT_AUTHENTICATED"
  | "AGENT_START_FAILED"
  | "AGENT_READY_TIMEOUT"
  | "TEAM_CONNECTION_REQUIRED"
  | "TEAM_TASK_NOT_FOUND"
  | "TEAM_TASK_ALREADY_COMPLETED"
  | "TEAM_TASK_ASSIGNMENT_DENIED"
  | "TEAM_MESSAGE_DELIVERY_FAILED"
  | "TEAM_RESULT_INVALID"
  | "TEAM_OPERATION_CANCELLED"
  | "TEAM_CLEANUP_FAILED"
  | "TEAM_RUN_NOT_FOUND"
  | "TEAM_RUN_ALREADY_FINISHED"
  | "TEAM_TASK_DEPENDENCY_NOT_FOUND"
  | "TEAM_TASK_DEPENDENCY_CYCLE"
  | "TEAM_TASK_BLOCKED"
  | "TEAM_TASK_DEPENDENCY_FAILED"
  | "TEAM_TASK_ASSIGNMENT_CONFLICT"
  | "WORKSPACE_ACCESS_DENIED";

export class TeamCoordinatorError extends Error {
  public readonly suggestedAction: string;
  public readonly technicalDetails?: string;

  public constructor(
    public readonly code: TeamCoordinatorErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly correlationId: string = randomUUID(),
    options: { readonly suggestedAction?: string; readonly technicalDetails?: string } = {}
  ) {
    super(message);
    this.name = "TeamCoordinatorError";
    this.suggestedAction =
      options.suggestedAction ?? "Revise o estado da equipe e tente novamente.";
    if (options.technicalDetails !== undefined) this.technicalDetails = options.technicalDetails;
  }
}

interface CoordinatorDependencies {
  readonly workspaces: V2WorkspaceService;
  readonly operations: V2OperationalService;
  readonly agents: AgentRuntime;
  readonly portals?: PortalRuntimeManager;
  readonly createId?: () => string;
  readonly readinessTimeoutMs?: number;
}

type RecruitedAgentType = "claude-code" | "codex" | "opencode";
type SupportedRecruitmentAgentType = RecruitedAgentType;

/**
 * The MCP request selects only a trusted adapter ID. Commands, environment and launch arguments
 * are always resolved by the production adapter through AgentRuntime.
 */
interface AgentRecruitmentStrategy {
  readonly agentType: SupportedRecruitmentAgentType;
  readonly displayName: string;
  readonly unavailableMessage: string;
  readonly authenticationMessage: string;
}

const recruitmentStrategies: Readonly<
  Record<SupportedRecruitmentAgentType, AgentRecruitmentStrategy>
> = {
  "claude-code": {
    agentType: "claude-code",
    displayName: "Claude Code",
    unavailableMessage: "Claude Code não está disponível neste computador.",
    authenticationMessage:
      "O Claude Code precisa estar instalado e autenticado antes do recrutamento."
  },
  codex: {
    agentType: "codex",
    displayName: "Codex",
    unavailableMessage: "Codex não está disponível neste computador.",
    authenticationMessage: "O Codex precisa estar instalado e autenticado antes do recrutamento."
  },
  opencode: {
    agentType: "opencode",
    displayName: "OpenCode",
    unavailableMessage: "OpenCode não está disponível neste computador.",
    authenticationMessage: "O OpenCode precisa estar instalado e autenticado antes do recrutamento."
  }
};

function recruitmentStrategyFor(
  agentType: RecruitedAgentType
): AgentRecruitmentStrategy | undefined {
  return recruitmentStrategies[agentType];
}

/**
 * Single operational authority for the Compazio vertical slice. It never runs a shell and it never
 * accepts executable, command, environment, workspace or requester identity from an MCP payload.
 */
export class TeamCoordinator {
  private readonly createId: () => string;
  private readonly availability: AgentAvailabilityService;
  /** One hidden provider turn per TeamTask. Handles are runtime-only and are never persisted. */
  private readonly activeTaskExecutions = new Set<string>();
  private readonly userInputWaiters = new Map<string, (request: TeamUserInputRequest) => void>();

  public constructor(private readonly dependencies: CoordinatorDependencies) {
    this.createId = dependencies.createId ?? randomUUID;
    this.availability = new AgentAvailabilityService(dependencies.agents);
  }

  /** Runtime MCP discovery mirrors the persisted, non-inheritable member grant. */
  public async capabilitiesForTerminal(
    workspaceId: string,
    terminalId: string
  ): Promise<readonly TeamMcpCapability[]> {
    const workspace = await this.dependencies.workspaces.snapshot(workspaceId);
    const base = teamCapabilitiesForTerminal(workspace, terminalId);
    const member = (await this.dependencies.operations.get(workspaceId)).teamMembers.find(
      (candidate) => candidate.terminalId === terminalId && candidate.status !== "dismissed"
    );
    if (member?.grantedCapabilities.includes("recruit-limited") !== true) return base;
    const run = (await this.dependencies.operations.get(workspaceId)).teamRuns.find(
      (candidate) =>
        candidate.id === member.runId &&
        !["completed", "failed", "cancelled"].includes(candidate.status)
    );
    if (run === undefined) return base;
    return [
      ...new Set([...base, "team-recruit", "task-create", "task-assign"])
    ] as readonly TeamMcpCapability[];
  }

  public async list(
    workspaceId: string,
    requesterId: string
  ): Promise<{
    readonly compazio: boolean;
    readonly runs: readonly TeamRun[];
    readonly members: readonly TeamMember[];
    readonly tasks: readonly TeamTask[];
    readonly userInputRequests: readonly TeamUserInputRequest[];
    readonly messages: readonly unknown[];
  }> {
    const workspace = await this.requireActiveTerminal(workspaceId, requesterId);
    const state = await this.dependencies.operations.get(workspaceId);
    const compazio = isCompazio(requireTerminal(workspace, requesterId));
    return {
      compazio,
      runs: compazio
        ? state.teamRuns.filter((run) => run.compazioTerminalId === requesterId)
        : state.teamRuns.filter((run) => {
            const memberId = this.memberIdForTerminal(state, requesterId);
            return memberId !== undefined && run.memberIds.includes(memberId);
          }),
      members: compazio
        ? state.teamMembers
        : state.teamMembers.filter((member) => member.terminalId === requesterId),
      tasks: state.teamTasks.filter((task) => this.canReadTask(task, requesterId, compazio)),
      userInputRequests: state.teamUserInputRequests.filter(
        (request) =>
          (compazio && request.compazioTerminalId === requesterId) ||
          request.agentId === requesterId
      ),
      messages: state.messages.filter(
        (message) => message.fromTerminalId === requesterId || message.toTerminalId === requesterId
      )
    };
  }

  /**
   * Creates a bounded, persistent execution graph. Recruitment, task creation and delivery reuse
   * the existing Coordinator paths so MCP and CLI cannot diverge in authority or cleanup.
   */
  private async createRunLegacy(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly title: string;
    readonly objective: string;
    readonly members: readonly {
      readonly agentType: RecruitedAgentType;
      readonly displayName: string;
      readonly role: TeamRole;
      readonly grantRecruitLimited?: boolean;
    }[];
    readonly tasks: readonly {
      readonly key: string;
      readonly title: string;
      readonly description: string;
      readonly assignedMemberName: string;
      readonly contextRefs?: readonly string[];
      readonly dependsOn?: readonly string[];
      readonly reviewOf?: string;
    }[];
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<{
    readonly run: TeamRun;
    readonly members: readonly TeamMember[];
    readonly tasks: readonly TeamTask[];
  }> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    if (
      input.members.length === 0 ||
      input.members.length > 3 ||
      input.tasks.length === 0 ||
      input.tasks.length > 10
    ) {
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_CONFLICT",
        "A execução deve ter entre um e três integrantes e entre uma e dez tarefas.",
        correlationId,
        false
      );
    }
    const keys = new Set<string>();
    for (const task of input.tasks) {
      if (keys.has(task.key)) {
        throw this.error(
          "TEAM_TASK_DEPENDENCY_CYCLE",
          "As chaves das tarefas devem ser únicas.",
          correlationId,
          false
        );
      }
      keys.add(task.key);
      if (
        (task.dependsOn?.length ?? 0) > 3 ||
        task.dependsOn?.some((dependency) => dependency === task.key)
      ) {
        throw this.error(
          "TEAM_TASK_DEPENDENCY_CYCLE",
          "O grafo de tarefas contém uma dependência inválida.",
          correlationId,
          false
        );
      }
    }
    for (const task of input.tasks) {
      for (const dependency of task.dependsOn ?? []) {
        if (!keys.has(dependency)) {
          throw this.error(
            "TEAM_TASK_DEPENDENCY_NOT_FOUND",
            "Uma dependência indicada não existe nesta execução.",
            correlationId,
            false
          );
        }
      }
    }
    if (hasKeyCycle(input.tasks)) {
      throw this.error(
        "TEAM_TASK_DEPENDENCY_CYCLE",
        "O grafo de tarefas contém um ciclo.",
        correlationId,
        false
      );
    }
    const persistedRun = await this.dependencies.operations.createTeamRun({
      workspaceId: input.workspaceId,
      compazioTerminalId: input.compazioTerminalId,
      title: input.title,
      objective: input.objective,
      idempotencyKey: input.idempotencyKey,
      missionContract: {
        requiredMembers: [],
        requiredTasks: [],
        requiresQa: false,
        requiresPortal: false
      }
    });
    if (persistedRun.memberIds.length > 0 || persistedRun.taskIds.length > 0) {
      const state = await this.dependencies.operations.get(input.workspaceId);
      return {
        run: persistedRun,
        members: state.teamMembers.filter((member) => persistedRun.memberIds.includes(member.id)),
        tasks: state.teamTasks.filter((task) => persistedRun.taskIds.includes(task.id))
      };
    }
    await this.dependencies.operations.updateTeamRun(
      input.workspaceId,
      persistedRun.id,
      "recruiting",
      input.compazioTerminalId
    );
    const members: TeamMember[] = [];
    try {
      for (const [index, specification] of input.members.entries()) {
        const recruitment = await this.recruit({
          workspaceId: input.workspaceId,
          compazioTerminalId: input.compazioTerminalId,
          agentType: specification.agentType,
          displayName: specification.displayName,
          role: specification.role,
          ...(specification.grantRecruitLimited === undefined
            ? {}
            : { grantRecruitLimited: specification.grantRecruitLimited }),
          positionHint: { direction: index === 0 ? "right" : "below" },
          idempotencyKey: `${input.idempotencyKey}-member-${index + 1}`,
          correlationId
        });
        members.push(recruitment.member);
      }
      let run = await this.dependencies.operations.updateTeamRun(
        input.workspaceId,
        persistedRun.id,
        "planning",
        input.compazioTerminalId,
        { memberIds: members.map((member) => member.id) }
      );
      const byName = new Map(members.map((member) => [member.displayName, member]));
      const byKey = new Map<string, TeamTask>();
      const pendingTasks = [...input.tasks];
      while (pendingTasks.length > 0) {
        const nextIndex = pendingTasks.findIndex((specification) =>
          (specification.dependsOn ?? []).every((key) => byKey.has(key))
        );
        if (nextIndex < 0) {
          throw this.error(
            "TEAM_TASK_DEPENDENCY_CYCLE",
            "As dependências da execução não puderam ser ordenadas.",
            correlationId,
            false
          );
        }
        const [specification] = pendingTasks.splice(nextIndex, 1);
        if (specification === undefined) continue;
        const assignee = byName.get(specification.assignedMemberName);
        if (assignee === undefined) {
          throw this.error(
            "TEAM_MEMBER_NOT_FOUND",
            "Uma tarefa referencia um integrante inexistente.",
            correlationId,
            false
          );
        }
        const task = await this.dependencies.operations.createTeamTask({
          workspaceId: input.workspaceId,
          createdByTerminalId: input.compazioTerminalId,
          runId: run.id,
          title: specification.title,
          description: specification.description,
          dependsOn: (specification.dependsOn ?? []).map((key) => byKey.get(key)?.id ?? key),
          ...(specification.reviewOf === undefined
            ? {}
            : { reviewOf: byKey.get(specification.reviewOf)?.id ?? specification.reviewOf }),
          idempotencyKey: `${input.idempotencyKey}-task-${specification.key}`
        });
        byKey.set(specification.key, task);
      }
      const tasks: TeamTask[] = [];
      for (const specification of input.tasks) {
        const task = byKey.get(specification.key);
        const assignee = byName.get(specification.assignedMemberName);
        if (task === undefined || assignee === undefined)
          throw new Error("Team run task mapping was lost");
        tasks.push(
          await this.assignTask({
            workspaceId: input.workspaceId,
            compazioTerminalId: input.compazioTerminalId,
            taskId: task.id,
            teamMemberId: assignee.id,
            idempotencyKey: `${input.idempotencyKey}-assign-${specification.key}`,
            correlationId
          })
        );
      }
      const workspace = await this.dependencies.workspaces.snapshot(input.workspaceId);
      const group = await this.createRunGroup(
        input.workspaceId,
        input.title,
        [input.compazioTerminalId, ...members.map((member) => member.terminalId)],
        workspace
      );
      run = await this.dependencies.operations.updateTeamRun(
        input.workspaceId,
        run.id,
        tasks.some((task) => task.status === "running") ? "running" : "blocked",
        input.compazioTerminalId,
        {
          taskIds: tasks.map((task) => task.id),
          ...(group === undefined ? {} : { groupId: group })
        }
      );
      return { run, members, tasks };
    } catch (cause) {
      await this.dependencies.operations
        .updateTeamRun(input.workspaceId, persistedRun.id, "failed", input.compazioTerminalId)
        .catch(() => undefined);
      await Promise.all(
        members.map((member) =>
          this.dismiss({
            workspaceId: input.workspaceId,
            compazioTerminalId: input.compazioTerminalId,
            teamMemberId: member.id,
            reason: "Falha ao criar a execução"
          }).catch(() => undefined)
        )
      );
      throw cause;
    }
  }

  /**
   * Creates a durable mission before attempting recruitment. A transient provider failure therefore
   * leaves a resumable TeamRun with the original graph intact instead of inviting an untracked
   * manual fallback.
   */
  public async createRun(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly title: string;
    readonly objective: string;
    readonly members: readonly {
      readonly agentType: RecruitedAgentType;
      readonly displayName: string;
      readonly role: TeamRole;
      readonly grantRecruitLimited?: boolean;
    }[];
    readonly tasks: readonly {
      readonly key: string;
      readonly title: string;
      readonly description: string;
      readonly assignedMemberName: string;
      readonly contextRefs?: readonly string[];
      readonly dependsOn?: readonly string[];
      readonly reviewOf?: string;
    }[];
    readonly acceptance?: { readonly requirePortal: boolean; readonly requireQa: boolean };
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<{
    readonly run: TeamRun;
    readonly members: readonly TeamMember[];
    readonly tasks: readonly TeamTask[];
  }> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    const operationalState = await this.dependencies.operations.get(input.workspaceId);
    this.assertMissionPlan(input, operationalState.policyId, correlationId);
    const missionContract: TeamRunMissionContract = {
      requiredMembers: input.members.map((member) => ({
        agentType: member.agentType,
        displayName: member.displayName,
        role: member.role,
        grantRecruitLimited: member.grantRecruitLimited ?? false
      })),
      requiredTasks: input.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        description: task.description,
        assignedMemberName: task.assignedMemberName,
        contextRefs: [...(task.contextRefs ?? [])],
        dependsOn: [...(task.dependsOn ?? [])],
        ...(task.reviewOf === undefined ? {} : { reviewOf: task.reviewOf })
      })),
      requiresQa:
        input.acceptance?.requireQa ?? input.tasks.some((task) => task.reviewOf !== undefined),
      requiresPortal: input.acceptance?.requirePortal ?? false
    };
    const persisted = await this.dependencies.operations.createTeamRun({
      workspaceId: input.workspaceId,
      compazioTerminalId: input.compazioTerminalId,
      title: input.title,
      objective: input.objective,
      idempotencyKey: input.idempotencyKey,
      policyId: operationalState.policyId,
      missionContract
    });
    const run = await this.reconcileMissionContract(
      input.workspaceId,
      persisted.id,
      input.compazioTerminalId,
      correlationId
    );
    const state = await this.dependencies.operations.get(input.workspaceId);
    return {
      run,
      members: state.teamMembers.filter((member) => run.memberIds.includes(member.id)),
      tasks: state.teamTasks.filter((task) => run.taskIds.includes(task.id))
    };
  }

  public async runStatus(
    workspaceId: string,
    requesterId: string,
    runId: string
  ): Promise<TeamRun> {
    const workspace = await this.requireActiveTerminal(workspaceId, requesterId);
    const run = (await this.dependencies.operations.get(workspaceId)).teamRuns.find(
      (candidate) => candidate.id === runId
    );
    if (run === undefined)
      throw this.error(
        "TEAM_RUN_NOT_FOUND",
        "A execução não está disponível.",
        this.createId(),
        false
      );
    const requesterMemberId = this.memberIdForTerminal(
      await this.dependencies.operations.get(workspaceId),
      requesterId
    );
    if (
      !isCompazio(requireTerminal(workspace, requesterId)) &&
      (requesterMemberId === undefined || !run.memberIds.includes(requesterMemberId))
    ) {
      throw this.error(
        "TEAM_CAPABILITY_DENIED",
        "Este terminal não pode consultar a execução.",
        this.createId(),
        false
      );
    }
    if (!isCompazio(requireTerminal(workspace, requesterId))) return run;
    const reconciled = await this.reconcileMissionContract(
      workspaceId,
      run.id,
      requesterId,
      this.createId()
    );
    await this.completeRunIfReady(workspaceId, reconciled.id, requesterId);
    return (
      (await this.dependencies.operations.get(workspaceId)).teamRuns.find(
        (candidate) => candidate.id === reconciled.id
      ) ?? reconciled
    );
  }

  /**
   * Converts a human adjustment into durable Builder work and keeps a pending review behind it.
   * The person addresses only Compazio; workers never become separate human chat endpoints.
   */
  public async instructRun(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly runId: string;
    readonly affectedMemberName: string;
    readonly instruction: string;
    readonly contextRefs?: readonly string[];
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<{ readonly adjustment: TeamTask; readonly review?: TeamTask }> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    let state = await this.dependencies.operations.get(input.workspaceId);
    const run = state.teamRuns.find(
      (candidate) =>
        candidate.id === input.runId &&
        candidate.compazioTerminalId === input.compazioTerminalId &&
        !["completed", "failed", "cancelled"].includes(candidate.status)
    );
    if (run === undefined)
      throw this.error(
        "TEAM_RUN_NOT_FOUND",
        "A missão ativa não foi encontrada para receber o ajuste.",
        correlationId,
        false
      );
    const member = state.teamMembers.find(
      (candidate) =>
        candidate.runId === run.id &&
        candidate.displayName === input.affectedMemberName &&
        !["dismissed", "failed"].includes(candidate.status)
    );
    if (member === undefined)
      throw this.error(
        "TEAM_MEMBER_NOT_FOUND",
        "O integrante afetado não pertence a esta missão.",
        correlationId,
        false
      );
    const current = state.teamTasks
      .filter(
        (task) =>
          task.runId === run.id &&
          task.assignedToTerminalId === member.terminalId &&
          task.reviewOf === undefined &&
          task.status !== "cancelled"
      )
      .at(-1);
    if (current === undefined)
      throw this.error(
        "TEAM_TASK_NOT_FOUND",
        "Não existe trabalho do integrante que possa receber este ajuste.",
        correlationId,
        false
      );
    const contextRefs = [...new Set([...current.contextRefs, ...(input.contextRefs ?? [])])];
    const adjustment = await this.createTask({
      workspaceId: input.workspaceId,
      creatorId: input.compazioTerminalId,
      runId: run.id,
      title: `Ajuste da missão — ${current.title}`,
      description: [
        "Aplique esta nova instrução ao trabalho existente sem desfazer partes válidas:",
        input.instruction,
        "Atualize o Caderno com a decisão e devolva task_result estruturado."
      ].join("\n"),
      contextRefs,
      ...(current.status === "completed" ? {} : { dependsOn: [current.id] }),
      resultRefs: current.result === undefined ? [] : [current.id],
      priority: "high",
      idempotencyKey: input.idempotencyKey,
      correlationId
    });
    state = await this.dependencies.operations.get(input.workspaceId);
    let review = state.teamTasks.find(
      (task) =>
        task.runId === run.id &&
        task.reviewOf === current.id &&
        ["queued", "blocked", "assigned"].includes(task.status)
    );
    if (review !== undefined) {
      review = await this.dependencies.operations.updateTeamTask({
        workspaceId: input.workspaceId,
        taskId: review.id,
        actor: input.compazioTerminalId,
        status: "blocked",
        dependsOn: [adjustment.id],
        blockedBy: [adjustment.id],
        reviewOf: adjustment.id,
        contextRefs: [...new Set([...review.contextRefs, ...contextRefs])]
      });
    } else if (run.missionContract.requiresQa) {
      const reviewer = state.teamMembers.find(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.id !== member.id &&
          !["dismissed", "failed"].includes(candidate.status)
      );
      if (reviewer === undefined)
        throw this.error(
          "TEAM_TASK_ASSIGNMENT_CONFLICT",
          "A missão exige revisão, mas não possui Reviewer independente disponível.",
          correlationId,
          false
        );
      review = await this.createTask({
        workspaceId: input.workspaceId,
        creatorId: input.compazioTerminalId,
        runId: run.id,
        title: `Revisão após ajuste — ${current.title}`,
        description: "Revise o resultado já com o ajuste aplicado e devolva QA PASS ou QA FAIL.",
        contextRefs,
        dependsOn: [adjustment.id],
        reviewOf: adjustment.id,
        priority: "high",
        idempotencyKey: `${input.idempotencyKey}-review`,
        correlationId
      });
      await this.assignTask({
        workspaceId: input.workspaceId,
        compazioTerminalId: input.compazioTerminalId,
        taskId: review.id,
        teamMemberId: reviewer.id,
        idempotencyKey: `${input.idempotencyKey}-review-assign`,
        correlationId
      });
    }
    await this.assignTask({
      workspaceId: input.workspaceId,
      compazioTerminalId: input.compazioTerminalId,
      taskId: adjustment.id,
      teamMemberId: member.id,
      idempotencyKey: `${input.idempotencyKey}-assign`,
      correlationId
    });
    await this.dependencies.operations.updateTeamRun(
      input.workspaceId,
      run.id,
      "running",
      input.compazioTerminalId
    );
    const finalState = await this.dependencies.operations.get(input.workspaceId);
    const persistedAdjustment =
      finalState.teamTasks.find((task) => task.id === adjustment.id) ?? adjustment;
    const persistedReview =
      review === undefined
        ? undefined
        : (finalState.teamTasks.find((task) => task.id === review.id) ?? review);
    return {
      adjustment: persistedAdjustment,
      ...(persistedReview === undefined ? {} : { review: persistedReview })
    };
  }

  public async cancelRun(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly runId: string;
    readonly dismissMembers?: boolean;
    readonly correlationId?: string;
  }): Promise<TeamRun> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    const run = await this.dependencies.operations.cancelTeamRun(
      input.workspaceId,
      input.runId,
      input.compazioTerminalId
    );
    if (input.dismissMembers === true) {
      const state = await this.dependencies.operations.get(input.workspaceId);
      await Promise.all(
        state.teamMembers
          .filter((member) => run.memberIds.includes(member.id) && member.status !== "dismissed")
          .map((member) =>
            this.dismiss({
              workspaceId: input.workspaceId,
              compazioTerminalId: input.compazioTerminalId,
              teamMemberId: member.id,
              reason: "Execução cancelada"
            })
          )
      );
    }
    return run;
  }

  public async recruit(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly agentType: RecruitedAgentType;
    readonly displayName?: string;
    readonly role?: TeamRole;
    /** Legacy bridge callers may still refer to a catalog role. MCP never accepts this property. */
    readonly roleId?: string;
    readonly initialTask?: {
      readonly title: string;
      readonly description: string;
      readonly contextRefs?: readonly string[];
    };
    readonly grantRecruitLimited?: boolean;
    readonly positionHint?: { readonly direction?: "left" | "right" | "above" | "below" };
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<{
    readonly member: TeamMember;
    readonly terminal: Record<string, unknown>;
    readonly task?: TeamTask;
  }> {
    const correlationId = input.correlationId ?? this.createId();
    const authorization = await this.canRecruit(
      input.workspaceId,
      input.compazioTerminalId,
      correlationId
    );
    const workspace = authorization.workspace;
    const compazio = authorization.terminal;
    if (input.grantRecruitLimited === true && !authorization.root) {
      throw this.error(
        "TEAM_RECRUIT_CAPABILITY_DENIED",
        "Um agente recrutado não pode recrutar outro agente.",
        correlationId,
        false
      );
    }
    const strategy = recruitmentStrategyFor(input.agentType);
    if (strategy === undefined) {
      throw this.error(
        "AGENT_NOT_AVAILABLE",
        "Esta fatia oferece recrutamento real apenas para Claude Code e Codex.",
        correlationId,
        false
      );
    }
    const current = await this.dependencies.operations.get(input.workspaceId);
    const replay = current.teamMembers.find(
      (member) =>
        member.recruitedByTerminalId === input.compazioTerminalId &&
        member.idempotencyKey === input.idempotencyKey
    );
    if (replay !== undefined) {
      const terminal = findTerminal(workspace, replay.terminalId);
      if (terminal === undefined) {
        throw this.error(
          "TEAM_MEMBER_NOT_FOUND",
          "O recrutamento anterior não possui mais um terminal no canvas.",
          correlationId,
          false
        );
      }
      const task = current.teamTasks.find(
        (candidate) => candidate.assignedToTerminalId === replay.terminalId
      );
      return {
        member: replay,
        terminal: serializeTerminal(terminal),
        ...(task === undefined ? {} : { task })
      };
    }
    const recruited = current.teamMembers.filter(
      (member) =>
        member.recruitedByTerminalId === input.compazioTerminalId && member.status !== "dismissed"
    );
    if (authorization.run === undefined && recruited.length >= 3) {
      throw this.error(
        "TEAM_RECRUIT_LIMIT_REACHED",
        `O ${ORCHESTRATOR_LABEL} já possui o limite de três agentes recrutados simultaneamente.`,
        correlationId,
        false
      );
    }

    const [definition, availability] = await Promise.all([
      this.dependencies.agents
        .listDefinitions()
        .then((definitions) =>
          definitions.find((candidate) => candidate.id === strategy.agentType)
        ),
      this.availability.check(strategy.agentType)
    ]);
    if (definition === undefined || !availability.available) {
      if (availability.state === "not-authenticated") {
        throw this.error(
          "AGENT_NOT_AUTHENTICATED",
          strategy.authenticationMessage,
          correlationId,
          true,
          JSON.stringify(availability)
        );
      }
      throw this.error(
        "AGENT_PROVIDER_UNAVAILABLE",
        strategy.unavailableMessage,
        correlationId,
        false,
        JSON.stringify(availability)
      );
    }

    const role = await this.resolveRole(input.role, input.roleId);
    const injectedRole = await this.dependencies.agents.createRole({
      name: role.name,
      ...(role.description === undefined ? {} : { description: role.description }),
      instructions: roleInstructions(
        role,
        input.initialTask,
        input.compazioTerminalId,
        input.grantRecruitLimited === true
      )
    });
    const direction = input.positionHint?.direction ?? "right";
    const position = relativePosition(compazio, direction);
    const created = await this.dependencies.workspaces.addTerminal(input.workspaceId, {
      title: input.displayName?.trim() || `${strategy.displayName} — ${role.name}`,
      position,
      agentConfig: { agentId: strategy.agentType, roleId: injectedRole.id },
      orchestratorOwnerNodeId: input.compazioTerminalId
    });
    const terminal = created.nodes.find(
      (node): node is Extract<CanvasNode, { readonly type: "terminal" }> =>
        node.type === "terminal" && !workspace.nodes.some((before) => before.id === node.id)
    );
    if (terminal === undefined) {
      throw this.error(
        "AGENT_START_FAILED",
        `Não foi possível criar o terminal ${strategy.displayName}.`,
        correlationId,
        true
      );
    }

    let member: TeamMember | undefined;
    let notebookNodeId: string | undefined;
    try {
      notebookNodeId = await this.createMemberNotebook({
        workspaceId: input.workspaceId,
        rootTerminalId: authorization.rootTerminalId,
        terminal,
        role
      });
      const memberInput = {
        workspaceId: input.workspaceId,
        terminalId: terminal.id,
        agentType: strategy.agentType,
        displayName: terminal.title,
        role,
        recruitedByTerminalId: input.compazioTerminalId,
        notebookNodeId,
        parentTerminalId: input.compazioTerminalId,
        depth: authorization.childDepth,
        grantedCapabilities: (input.grantRecruitLimited === true
          ? ["recruit-limited"]
          : []) as TeamMemberCapability[],
        status: "creating",
        idempotencyKey: input.idempotencyKey
      } as const;
      member =
        authorization.run === undefined
          ? await this.dependencies.operations.upsertTeamMember(memberInput)
          : await this.dependencies.operations.reserveTeamRecruitment({
              ...memberInput,
              runId: authorization.run.id
            });
      const connection = await this.ensureConnection(
        input.workspaceId,
        authorization.rootTerminalId,
        input.compazioTerminalId,
        terminal.id
      );
      await this.dependencies.operations.recordOperationalEvent({
        workspaceId: input.workspaceId,
        actor: input.compazioTerminalId,
        type: "team.connection.created",
        target: connection.id
      });
      // Recruitment configures a worker identity; execution starts only when a structured task is
      // assigned. Opening a second interactive TUI here produced the misleading "Welcome back"
      // terminals seen beside an actually running background task and consumed provider capacity.
      member = await this.dependencies.operations.upsertTeamMember({ ...member, status: "ready" });
      const readyMember = member;
      if (readyMember === undefined)
        throw this.error(
          "TEAM_MEMBER_NOT_READY",
          "O integrante não foi persistido.",
          correlationId,
          true
        );
      const task =
        input.initialTask === undefined
          ? undefined
          : await this.createAndAssignInitialTask({
              workspaceId: input.workspaceId,
              compazioTerminalId: input.compazioTerminalId,
              member: readyMember,
              title: input.initialTask.title,
              description: input.initialTask.description,
              contextRefs: input.initialTask.contextRefs ?? [],
              idempotencyKey: `${input.idempotencyKey}-task`,
              correlationId
            });
      const persistedMember = (
        await this.dependencies.operations.get(input.workspaceId)
      ).teamMembers.find((candidate) => candidate.id === readyMember.id);
      return {
        member: persistedMember ?? readyMember,
        terminal: serializeTerminal(terminal),
        ...(task === undefined ? {} : { task })
      };
    } catch (cause: unknown) {
      if (member !== undefined) {
        await this.dependencies.operations
          .releaseTeamRecruitment(input.workspaceId, terminal.id, input.compazioTerminalId)
          .catch(() => undefined);
      }
      await this.dependencies.workspaces
        .dismissTeamTerminal(input.workspaceId, terminal.id)
        .catch(() => undefined);
      if (notebookNodeId !== undefined) {
        await this.dependencies.workspaces
          .deleteNode(input.workspaceId, notebookNodeId)
          .catch(() => undefined);
      }
      if (cause instanceof TeamCoordinatorError) throw cause;
      throw this.error(
        "AGENT_START_FAILED",
        `${strategy.displayName} não pôde ser iniciado como integrante da equipe.`,
        correlationId,
        true,
        safeStartFailureDetail(cause)
      );
    }
  }

  public async createTask(input: {
    readonly workspaceId: string;
    readonly creatorId: string;
    readonly title: string;
    readonly description: string;
    readonly contextRefs?: readonly string[];
    readonly runId?: string;
    readonly dependsOn?: readonly string[];
    readonly resultRefs?: readonly string[];
    readonly reviewOf?: string;
    readonly priority?: "low" | "normal" | "high";
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<TeamTask> {
    const correlationId = input.correlationId ?? this.createId();
    // A limited recruiter acts inside the TeamRun that granted the capability.  The MCP contract
    // intentionally does not let an agent choose an arbitrary run id, so derive it from the
    // durable authorization rather than creating an orphan task that could be skipped when the
    // parent task completes.
    const authorization = await this.canRecruit(input.workspaceId, input.creatorId, correlationId);
    if (!authorization.root && input.runId !== undefined && input.runId !== authorization.run?.id) {
      throw this.error(
        "TEAM_CAPABILITY_DENIED",
        "Um agente com recruit-limited sÃ³ pode criar tarefas na sua prÃ³pria execuÃ§Ã£o ativa.",
        correlationId,
        false
      );
    }
    return this.dependencies.operations.createTeamTask({
      workspaceId: input.workspaceId,
      createdByTerminalId: input.creatorId,
      title: input.title,
      description: input.description,
      ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
      ...(input.runId === undefined
        ? authorization.run === undefined
          ? {}
          : { runId: authorization.run.id }
        : { runId: input.runId }),
      ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      ...(input.resultRefs === undefined ? {} : { resultRefs: input.resultRefs }),
      ...(input.reviewOf === undefined ? {} : { reviewOf: input.reviewOf }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      idempotencyKey: input.idempotencyKey
    });
  }

  public async assignTask(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly taskId: string;
    readonly teamMemberId: string;
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<TeamTask> {
    const correlationId = input.correlationId ?? this.createId();
    const authorization = await this.canRecruit(
      input.workspaceId,
      input.compazioTerminalId,
      correlationId
    );
    const state = await this.dependencies.operations.get(input.workspaceId);
    const task = state.teamTasks.find((candidate) => candidate.id === input.taskId);
    if (task === undefined)
      throw this.error("TEAM_TASK_NOT_FOUND", "A tarefa não foi encontrada.", correlationId, false);
    if (task.status === "completed")
      throw this.error(
        "TEAM_TASK_ALREADY_COMPLETED",
        "A tarefa já foi concluída.",
        correlationId,
        false
      );
    const member = state.teamMembers.find((candidate) => candidate.id === input.teamMemberId);
    if (member === undefined)
      throw this.error(
        "TEAM_MEMBER_NOT_FOUND",
        "O integrante não foi encontrado.",
        correlationId,
        false
      );
    if (!authorization.root && member.parentTerminalId !== input.compazioTerminalId)
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_DENIED",
        "A worker may assign a task only to its own explicit child.",
        correlationId,
        false
      );
    if (
      task.assignedToTerminalId !== undefined &&
      task.assignedToTerminalId !== member.terminalId &&
      !["queued", "blocked"].includes(task.status)
    ) {
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_CONFLICT",
        "A tarefa já está atribuída a outro integrante ativo.",
        correlationId,
        false
      );
    }
    if (member.status === "dismissed" || member.status === "dismissing")
      throw this.error(
        "TEAM_MEMBER_DISMISSED",
        "O integrante já foi dispensado.",
        correlationId,
        false
      );
    if (!["ready", "working", "waiting", "completed"].includes(member.status))
      throw this.error(
        "TEAM_MEMBER_NOT_READY",
        "O integrante ainda não está pronto.",
        correlationId,
        true
      );
    const dependencies = task.dependsOn.map((dependencyId) =>
      state.teamTasks.find((candidate) => candidate.id === dependencyId)
    );
    if (dependencies.some((dependency) => dependency === undefined)) {
      throw this.error(
        "TEAM_TASK_DEPENDENCY_NOT_FOUND",
        "Uma dependência da tarefa não está disponível.",
        correlationId,
        false
      );
    }
    const failedDependency = dependencies.find(
      (dependency) => dependency?.status === "failed" || dependency?.status === "cancelled"
    );
    if (failedDependency !== undefined) {
      await this.dependencies.operations.updateTeamTask({
        workspaceId: input.workspaceId,
        taskId: task.id,
        actor: input.compazioTerminalId,
        status: "blocked",
        assignedToTerminalId: member.terminalId,
        blockedBy: [failedDependency.id]
      });
      throw this.error(
        "TEAM_TASK_DEPENDENCY_FAILED",
        "A tarefa depende de uma tarefa que falhou ou foi cancelada.",
        correlationId,
        false
      );
    }
    const pendingDependencies = dependencies.filter(
      (dependency) => dependency?.status !== "completed"
    );
    if (pendingDependencies.length > 0) {
      const blocked = await this.dependencies.operations.updateTeamTask({
        workspaceId: input.workspaceId,
        taskId: task.id,
        actor: input.compazioTerminalId,
        status: "blocked",
        assignedToTerminalId: member.terminalId,
        blockedBy: pendingDependencies.map((dependency) => dependency?.id ?? "")
      });
      await this.dependencies.operations.upsertTeamMember({ ...member, status: "blocked" });
      return blocked;
    }
    await this.ensureConnection(
      input.workspaceId,
      authorization.rootTerminalId,
      input.compazioTerminalId,
      member.terminalId
    );
    await this.ensureTaskContextConnections(
      input.workspaceId,
      input.compazioTerminalId,
      member.terminalId,
      task.contextRefs,
      correlationId
    );
    const assigned = await this.dependencies.operations.updateTeamTask({
      workspaceId: input.workspaceId,
      taskId: task.id,
      actor: input.compazioTerminalId,
      status: "assigned",
      assignedToTerminalId: member.terminalId
    });
    await this.dependencies.operations.upsertTeamMember({ ...member, status: "working" });
    await this.sendMessage({
      workspaceId: input.workspaceId,
      fromTerminalId: input.compazioTerminalId,
      toTerminalId: member.terminalId,
      taskId: assigned.id,
      type: "task",
      content: taskDelivery(assigned),
      idempotencyKey: `${input.idempotencyKey}-delivery`,
      correlationId
    });
    const running = await this.dependencies.operations.updateTeamTask({
      workspaceId: input.workspaceId,
      taskId: assigned.id,
      actor: input.compazioTerminalId,
      status: "running"
    });
    await this.dispatchTaskExecution(input.workspaceId, running, member, correlationId);
    return running;
  }

  public async taskStatus(
    workspaceId: string,
    requesterId: string,
    taskId: string
  ): Promise<TeamTask> {
    const workspace = await this.requireActiveTerminal(workspaceId, requesterId);
    const task = (await this.dependencies.operations.get(workspaceId)).teamTasks.find(
      (candidate) => candidate.id === taskId
    );
    if (task === undefined)
      throw this.error(
        "TEAM_TASK_NOT_FOUND",
        "A tarefa não está disponível.",
        this.createId(),
        false
      );
    if (!this.canReadTask(task, requesterId, isCompazio(requireTerminal(workspace, requesterId)))) {
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_DENIED",
        "Este terminal não pode consultar a tarefa.",
        this.createId(),
        false
      );
    }
    return task;
  }

  /**
   * Suspends the MCP tool call while the human answers in the Compazio surface. The worker process
   * stays alive, but its private terminal never becomes the human communication channel.
   */
  public async requestUserInput(input: {
    readonly workspaceId: string;
    readonly requesterId: string;
    readonly taskId: string;
    readonly question: string;
    readonly reason: string;
    readonly expectedAnswerType: TeamUserInputRequest["expectedAnswerType"];
    readonly context?: string;
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<TeamUserInputRequest> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireActiveTerminal(input.workspaceId, input.requesterId);
    const request = await this.dependencies.operations.createTeamUserInputRequest({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      agentId: input.requesterId,
      question: input.question,
      reason: input.reason,
      expectedAnswerType: input.expectedAnswerType,
      ...(input.context === undefined ? {} : { context: input.context }),
      idempotencyKey: input.idempotencyKey
    });
    if (request.status === "answered") return request;
    await this.ensureConnection(
      input.workspaceId,
      request.compazioTerminalId,
      input.requesterId,
      request.compazioTerminalId
    );
    await this.sendMessage({
      workspaceId: input.workspaceId,
      fromTerminalId: input.requesterId,
      toTerminalId: request.compazioTerminalId,
      taskId: request.taskId,
      type: "system",
      content: `Informação necessária do usuário: ${request.question}\nMotivo: ${request.reason}`,
      idempotencyKey: `${request.idempotencyKey}-to-compazio`,
      correlationId
    });
    return new Promise<TeamUserInputRequest>((resolve) => {
      this.userInputWaiters.set(request.id, resolve);
      void this.dependencies.operations.get(input.workspaceId).then((state) => {
        const latest = state.teamUserInputRequests.find((candidate) => candidate.id === request.id);
        if (latest?.status !== "answered") return;
        this.userInputWaiters.delete(request.id);
        resolve(latest);
      });
    });
  }

  public async listUserInputRequests(
    workspaceId: string,
    requesterId: string
  ): Promise<readonly TeamUserInputRequest[]> {
    const workspace = await this.requireActiveTerminal(workspaceId, requesterId);
    const compazio = isCompazio(requireTerminal(workspace, requesterId));
    const state = await this.dependencies.operations.get(workspaceId);
    return state.teamUserInputRequests.filter(
      (request) =>
        (compazio && request.compazioTerminalId === requesterId) || request.agentId === requesterId
    );
  }

  public async answerUserInput(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly correlationId?: string;
  }): Promise<TeamUserInputRequest> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    const state = await this.dependencies.operations.get(input.workspaceId);
    const current = state.teamUserInputRequests.find((request) => request.id === input.requestId);
    if (current === undefined || current.compazioTerminalId !== input.compazioTerminalId)
      throw this.error(
        "TEAM_TASK_NOT_FOUND",
        "A pergunta não pertence a este Compazio.",
        correlationId,
        false
      );
    const answered = await this.dependencies.operations.answerTeamUserInputRequest({
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      answer: input.answer,
      actor: input.compazioTerminalId
    });
    await this.sendMessage({
      workspaceId: input.workspaceId,
      fromTerminalId: input.compazioTerminalId,
      toTerminalId: answered.agentId,
      taskId: answered.taskId,
      type: "system",
      content: `Resposta do usuário: ${answered.answer ?? input.answer}`,
      idempotencyKey: `${answered.idempotencyKey}-answer`,
      correlationId
    });
    const waiter = this.userInputWaiters.get(answered.id);
    if (waiter !== undefined) {
      this.userInputWaiters.delete(answered.id);
      waiter(answered);
    }
    return answered;
  }

  public async taskResult(input: {
    readonly workspaceId: string;
    readonly requesterId: string;
    readonly taskId: string;
    readonly result?: { readonly summary: string; readonly artifacts?: readonly string[] };
    readonly idempotencyKey?: string;
    readonly correlationId?: string;
  }): Promise<TeamTask> {
    const correlationId = input.correlationId ?? this.createId();
    const workspace = await this.requireActiveTerminal(input.workspaceId, input.requesterId);
    const state = await this.dependencies.operations.get(input.workspaceId);
    const task = state.teamTasks.find((candidate) => candidate.id === input.taskId);
    if (task === undefined)
      throw this.error(
        "TEAM_TASK_NOT_FOUND",
        "A tarefa não está disponível.",
        correlationId,
        false
      );
    const compazio = isCompazio(requireTerminal(workspace, input.requesterId));
    if (input.result === undefined) {
      if (!this.canReadTask(task, input.requesterId, compazio))
        throw this.error(
          "TEAM_TASK_ASSIGNMENT_DENIED",
          "Este terminal não pode consultar o resultado.",
          correlationId,
          false
        );
      return task;
    }
    if (task.assignedToTerminalId !== input.requesterId)
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_DENIED",
        "Somente o integrante atribuído pode devolver o resultado.",
        correlationId,
        false
      );
    if (task.status === "completed") {
      if (sameResult(task.result, input.result)) return task;
      if (!isBlockedTaskResult(task.result?.summary ?? ""))
        throw this.error(
          "TEAM_TASK_ALREADY_COMPLETED",
          "A tarefa já possui um resultado diferente.",
          correlationId,
          false
        );
    }
    if (input.result.summary.trim() === "")
      throw this.error(
        "TEAM_RESULT_INVALID",
        "O resultado precisa conter um resumo.",
        correlationId,
        false
      );
    if (isBlockedTaskResult(input.result.summary))
      throw this.error(
        "TEAM_RESULT_INVALID",
        "Um bloqueio não conclui a tarefa. Registre o impedimento e tente novamente após corrigi-lo.",
        correlationId,
        true
      );
    if (
      task.reviewOf !== undefined &&
      !isPassingReviewResult(input.result.summary) &&
      !isFailingReviewResult(input.result.summary)
    )
      throw this.error(
        "TEAM_RESULT_INVALID",
        "Uma tarefa de revisao so pode concluir com um veredito explicito de QA PASS ou QA FAIL.",
        correlationId,
        true
      );
    const completed = await this.dependencies.operations.updateTeamTask({
      workspaceId: input.workspaceId,
      taskId: task.id,
      actor: input.requesterId,
      status: "completed",
      result: {
        summary: input.result.summary,
        ...(input.result.artifacts === undefined ? {} : { artifacts: [...input.result.artifacts] })
      }
    });
    const member = state.teamMembers.find(
      (candidate) => candidate.terminalId === input.requesterId
    );
    if (member !== undefined) {
      await this.dependencies.operations.upsertTeamMember({ ...member, status: "completed" });
    }
    await this.sendMessage({
      workspaceId: input.workspaceId,
      fromTerminalId: input.requesterId,
      toTerminalId: completed.createdByTerminalId,
      taskId: completed.id,
      type: "result",
      content: completed.result?.summary ?? "Resultado estruturado disponível.",
      idempotencyKey: input.idempotencyKey ?? `${completed.id}-result`,
      correlationId
    });
    if (
      completed.reviewOf !== undefined &&
      !isPassingReviewResult(completed.result?.summary ?? "")
    ) {
      await this.scheduleQaRemediation(input.workspaceId, completed, correlationId);
      return completed;
    }
    // A wakeup always reconciles the durable plan first. A Builder result cannot bypass a
    // reviewer that was already required but whose recruitment had to be retried.
    if (completed.runId !== undefined) {
      await this.reconcileMissionContract(
        input.workspaceId,
        completed.runId,
        input.requesterId,
        correlationId
      );
    }
    await this.releaseDependentTasks(
      input.workspaceId,
      completed,
      input.requesterId,
      correlationId
    );
    await this.completeRunIfReady(input.workspaceId, completed.runId, input.requesterId);
    return completed;
  }

  private async scheduleQaRemediation(
    workspaceId: string,
    failedReview: TeamTask,
    correlationId: string
  ): Promise<void> {
    if (failedReview.runId === undefined || failedReview.reviewOf === undefined) return;
    const state = await this.dependencies.operations.get(workspaceId);
    const run = state.teamRuns.find((candidate) => candidate.id === failedReview.runId);
    const reviewedTask = state.teamTasks.find(
      (candidate) => candidate.id === failedReview.reviewOf
    );
    const builder = state.teamMembers.find(
      (candidate) => candidate.terminalId === reviewedTask?.assignedToTerminalId
    );
    const reviewer = state.teamMembers.find(
      (candidate) => candidate.terminalId === failedReview.assignedToTerminalId
    );
    if (
      run === undefined ||
      reviewedTask === undefined ||
      builder === undefined ||
      reviewer === undefined
    ) {
      await this.dependencies.operations.updateTeamRun(
        workspaceId,
        failedReview.runId,
        "blocked",
        run?.compazioTerminalId ?? failedReview.createdByTerminalId
      );
      return;
    }
    const correctionPrefix = `${run.id}-qa-correction-`;
    const completedCorrections = state.teamTasks.filter((task) =>
      task.idempotencyKey?.startsWith(correctionPrefix)
    ).length;
    const maximumCorrections = 3;
    if (completedCorrections >= maximumCorrections) {
      await this.dependencies.operations.updateTeamRun(
        workspaceId,
        run.id,
        "blocked",
        run.compazioTerminalId
      );
      return;
    }
    const cycle = completedCorrections + 1;
    const contextRefs = [...new Set([...reviewedTask.contextRefs, ...failedReview.contextRefs])];
    const correction = await this.dependencies.operations.createTeamTask({
      workspaceId,
      runId: run.id,
      createdByTerminalId: run.compazioTerminalId,
      title: `Correção incremental de QA — ciclo ${cycle}`,
      description: [
        "Corrija apenas os problemas encontrados pelo Reviewer; preserve a implementação válida.",
        `Veredito recebido: ${failedReview.result?.summary ?? "QA FAIL"}`,
        "Após editar os arquivos, recarregue o Portal e devolva um task_result estruturado."
      ].join("\n"),
      contextRefs,
      resultRefs: [failedReview.id],
      priority: "high",
      idempotencyKey: `${correctionPrefix}${cycle}`
    });
    const nextReview = await this.dependencies.operations.createTeamTask({
      workspaceId,
      runId: run.id,
      createdByTerminalId: builder.terminalId,
      title: `Revisão independente após correção — ciclo ${cycle}`,
      description: [
        "Revise novamente a correção incremental no Portal em desktop 1440 e mobile 390.",
        "Valide overflow, spacing, typography, CTA/WhatsApp, console, interações e acessibilidade básica.",
        "Use portal_viewport com width e height antes de cada captura e devolva QA PASS ou QA FAIL."
      ].join("\n"),
      contextRefs,
      dependsOn: [correction.id],
      reviewOf: correction.id,
      resultRefs: [failedReview.id],
      priority: "high",
      idempotencyKey: `${run.id}-qa-review-${cycle}`
    });
    // Arm the dependency before the Builder starts: a very fast corrective result cannot skip QA.
    await this.assignTask({
      workspaceId,
      compazioTerminalId: run.compazioTerminalId,
      taskId: nextReview.id,
      teamMemberId: reviewer.id,
      idempotencyKey: `${run.id}-qa-review-assign-${cycle}`,
      correlationId
    });
    await this.assignTask({
      workspaceId,
      compazioTerminalId: run.compazioTerminalId,
      taskId: correction.id,
      teamMemberId: builder.id,
      idempotencyKey: `${run.id}-qa-correction-assign-${cycle}`,
      correlationId
    });
    await this.dependencies.operations.updateTeamRun(
      workspaceId,
      run.id,
      "running",
      run.compazioTerminalId
    );
  }

  /** Event-driven scheduler: task completion is the sole trigger for dependent task delivery. */
  private async releaseDependentTasks(
    workspaceId: string,
    completed: TeamTask,
    sourceTerminalId: string,
    correlationId: string
  ): Promise<void> {
    if (completed.runId === undefined) return;
    const state = await this.dependencies.operations.get(workspaceId);
    const run = state.teamRuns.find((candidate) => candidate.id === completed.runId);
    if (run === undefined || ["cancelled", "failed", "completed"].includes(run.status)) return;
    const dependents = state.teamTasks.filter(
      (task) =>
        task.runId === completed.runId &&
        task.dependsOn.includes(completed.id) &&
        task.status === "blocked"
    );
    for (const dependent of dependents) {
      const fresh = await this.dependencies.operations.get(workspaceId);
      const current = fresh.teamTasks.find((task) => task.id === dependent.id);
      if (current === undefined) continue;
      const dependencies = current.dependsOn
        .map((dependencyId) => fresh.teamTasks.find((task) => task.id === dependencyId))
        .filter((task): task is TeamTask => task !== undefined);
      if (dependencies.some((task) => task.status === "failed" || task.status === "cancelled")) {
        await this.dependencies.operations.updateTeamTask({
          workspaceId,
          taskId: current.id,
          actor: sourceTerminalId,
          status: "blocked",
          blockedBy: dependencies
            .filter((task) => task.status !== "completed")
            .map((task) => task.id)
        });
        continue;
      }
      if (!dependencies.every((task) => task.status === "completed")) continue;
      const targetId = current.assignedToTerminalId;
      if (targetId === undefined) continue;
      const targetMember = fresh.teamMembers.find((member) => member.terminalId === targetId);
      if (targetMember === undefined || targetMember.status === "dismissed") continue;
      const deliverySourceId =
        sourceTerminalId === targetId ? run.compazioTerminalId : sourceTerminalId;
      await this.ensureWorkerConnection(
        workspaceId,
        run.compazioTerminalId,
        deliverySourceId,
        targetId
      );
      await this.ensureTaskContextConnections(
        workspaceId,
        deliverySourceId,
        targetId,
        current.contextRefs,
        correlationId
      );
      const context = buildDependencyContext(completed, current);
      await this.sendMessage({
        workspaceId,
        fromTerminalId: deliverySourceId,
        toTerminalId: targetId,
        taskId: current.id,
        type: "result",
        content: context,
        idempotencyKey: `${current.id}-dependency-${completed.id}`,
        correlationId
      });
      await this.dependencies.operations.updateTeamTask({
        workspaceId,
        taskId: current.id,
        actor: run.compazioTerminalId,
        status: "assigned",
        blockedBy: [],
        resultRefs: [...new Set([...current.resultRefs, completed.id])]
      });
      await this.dependencies.operations.upsertTeamMember({ ...targetMember, status: "working" });
      await this.sendMessage({
        workspaceId,
        // A dependent task is owned by the terminal that created it.  For a nested reviewer,
        // that is the limited builder, not the root Compazio terminal; using the root here would
        // bypass the explicit Builder -> Reviewer connection that grants delivery and context.
        fromTerminalId: deliverySourceId,
        toTerminalId: targetId,
        taskId: current.id,
        type: "task",
        content: taskDelivery({ ...current, blockedBy: [] }),
        idempotencyKey: `${current.id}-release-delivery`,
        correlationId
      });
      const running = await this.dependencies.operations.updateTeamTask({
        workspaceId,
        taskId: current.id,
        actor: run.compazioTerminalId,
        status: "running",
        blockedBy: []
      });
      await this.dispatchTaskExecution(workspaceId, running, targetMember, correlationId);
      await this.dependencies.operations.updateTeamRun(
        workspaceId,
        run.id,
        current.reviewOf === completed.id ? "review" : "running",
        run.compazioTerminalId
      );
    }
  }

  private assertMissionPlan(
    input: {
      readonly members: readonly { readonly displayName: string }[];
      readonly tasks: readonly {
        readonly key: string;
        readonly assignedMemberName: string;
        readonly dependsOn?: readonly string[];
        readonly reviewOf?: string;
      }[];
      readonly acceptance?: { readonly requireQa: boolean };
    },
    policyId: ExecutionPolicyId,
    correlationId: string
  ): void {
    const workerBudget = AUTONOMY_WORKER_BUDGETS[policyId];
    if (
      input.members.length === 0 ||
      input.members.length > workerBudget ||
      input.tasks.length === 0 ||
      input.tasks.length > 10
    )
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_CONFLICT",
        `O modo ${policyId} permite entre um e ${workerBudget} integrante(s) nesta missão e entre uma e dez tarefas.`,
        correlationId,
        false
      );
    const names = new Set(input.members.map((member) => member.displayName));
    if (names.size !== input.members.length)
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_CONFLICT",
        "Cada integrante do plano precisa ter um nome lógico único.",
        correlationId,
        false
      );
    const keys = new Set<string>();
    for (const task of input.tasks) {
      if (keys.has(task.key) || !names.has(task.assignedMemberName))
        throw this.error(
          "TEAM_TASK_ASSIGNMENT_CONFLICT",
          "Cada tarefa precisa ter uma chave única e um integrante previsto no plano.",
          correlationId,
          false
        );
      keys.add(task.key);
      if ((task.dependsOn?.length ?? 0) > 3 || task.dependsOn?.some((key) => key === task.key))
        throw this.error(
          "TEAM_TASK_DEPENDENCY_CYCLE",
          "O grafo de tarefas contém uma dependência inválida.",
          correlationId,
          false
        );
      if (
        task.dependsOn?.some(
          (key) => !keys.has(key) && !input.tasks.some((item) => item.key === key)
        )
      )
        throw this.error(
          "TEAM_TASK_DEPENDENCY_NOT_FOUND",
          "Uma dependência indicada não existe nesta execução.",
          correlationId,
          false
        );
    }
    if (hasKeyCycle(input.tasks))
      throw this.error(
        "TEAM_TASK_DEPENDENCY_CYCLE",
        "O grafo de tarefas contém um ciclo.",
        correlationId,
        false
      );
    const reviews = input.tasks.filter((task) => task.reviewOf !== undefined);
    const requiresQa = input.acceptance?.requireQa ?? reviews.length > 0;
    if (requiresQa && reviews.length === 0)
      throw this.error(
        "TEAM_TASK_ASSIGNMENT_CONFLICT",
        "QA foi exigido, mas o plano não possui uma tarefa de revisão ligada por reviewOf.",
        correlationId,
        false
      );
    const reviewedKeys = new Set<string>();
    for (const review of reviews) {
      const reviewed = input.tasks.find((task) => task.key === review.reviewOf);
      if (
        reviewed === undefined ||
        reviewed.reviewOf !== undefined ||
        reviewed.assignedMemberName === review.assignedMemberName ||
        !(review.dependsOn ?? []).includes(reviewed.key) ||
        reviewedKeys.has(reviewed.key)
      )
        throw this.error(
          "TEAM_TASK_ASSIGNMENT_CONFLICT",
          "Cada QA deve revisar exatamente uma tarefa anterior, depender dela e usar outro integrante; QA duplicado não é permitido.",
          correlationId,
          false
        );
      reviewedKeys.add(reviewed.key);
    }
  }

  /** Rehydrates the original graph after any retryable recruitment failure. */
  private async reconcileMissionContract(
    workspaceId: string,
    runId: string,
    actor: string,
    correlationId: string
  ): Promise<TeamRun> {
    let state = await this.dependencies.operations.get(workspaceId);
    let run = state.teamRuns.find((candidate) => candidate.id === runId);
    if (run === undefined)
      throw this.error(
        "TEAM_RUN_NOT_FOUND",
        "A execução da equipe não foi encontrada.",
        correlationId,
        false
      );
    if (["completed", "cancelled", "failed"].includes(run.status)) return run;
    const contract = run.missionContract;
    let recruitmentPending = false;
    for (const required of contract.requiredMembers) {
      state = await this.dependencies.operations.get(workspaceId);
      const present = state.teamMembers.some(
        (member) =>
          member.runId === runId &&
          member.agentType === required.agentType &&
          member.displayName === required.displayName &&
          !["dismissed", "failed"].includes(member.status)
      );
      if (present) continue;
      try {
        await this.recruit({
          workspaceId,
          compazioTerminalId: run.compazioTerminalId,
          agentType: required.agentType,
          displayName: required.displayName,
          role: required.role,
          ...(required.grantRecruitLimited ? { grantRecruitLimited: true } : {}),
          positionHint: { direction: "right" },
          idempotencyKey: `${run.id}-contract-member-${required.displayName}`,
          correlationId
        });
      } catch (cause) {
        if (!(cause instanceof TeamCoordinatorError)) throw cause;
        recruitmentPending = true;
      }
    }

    const taskByKey = new Map<string, TeamTask>();
    const pendingTasks = [...contract.requiredTasks];
    while (pendingTasks.length > 0) {
      state = await this.dependencies.operations.get(workspaceId);
      const nextIndex = pendingTasks.findIndex((task) =>
        (task.dependsOn ?? []).every((key) => taskByKey.has(key))
      );
      if (nextIndex < 0)
        throw this.error(
          "TEAM_TASK_DEPENDENCY_CYCLE",
          "O contrato persistido contém um ciclo de dependências.",
          correlationId,
          false
        );
      const [required] = pendingTasks.splice(nextIndex, 1);
      if (required === undefined) continue;
      const idempotencyKey = `${run.id}-contract-task-${required.key}`;
      const existing = state.teamTasks.find((task) => task.idempotencyKey === idempotencyKey);
      const task =
        existing ??
        (await this.createTask({
          workspaceId,
          creatorId: run.compazioTerminalId,
          runId,
          title: required.title,
          description: required.description,
          ...(required.contextRefs === undefined ? {} : { contextRefs: required.contextRefs }),
          dependsOn: (required.dependsOn ?? []).map((key) => taskByKey.get(key)?.id ?? key),
          ...(required.reviewOf === undefined
            ? {}
            : { reviewOf: taskByKey.get(required.reviewOf)?.id ?? required.reviewOf }),
          idempotencyKey,
          correlationId
        }));
      taskByKey.set(required.key, task);
    }

    state = await this.dependencies.operations.get(workspaceId);
    // Arm blocked dependents before launching their prerequisite. This preserves the graph even
    // when a short-lived worker returns immediately after its result.
    for (const required of [...contract.requiredTasks].sort(
      (left, right) => (right.dependsOn?.length ?? 0) - (left.dependsOn?.length ?? 0)
    )) {
      const task = state.teamTasks.find(
        (candidate) => candidate.idempotencyKey === `${runId}-contract-task-${required.key}`
      );
      const member = state.teamMembers.find(
        (candidate) =>
          candidate.runId === runId &&
          candidate.displayName === required.assignedMemberName &&
          !["dismissed", "failed"].includes(candidate.status)
      );
      if (
        task === undefined ||
        member === undefined ||
        task.assignedToTerminalId !== undefined ||
        ["completed", "cancelled", "failed"].includes(task.status)
      )
        continue;
      await this.assignTask({
        workspaceId,
        compazioTerminalId: run.compazioTerminalId,
        taskId: task.id,
        teamMemberId: member.id,
        idempotencyKey: `${run.id}-contract-assign-${required.key}`,
        correlationId
      });
    }

    // A member recovered after its prerequisite finished must start immediately; there will be no
    // second Builder result to wake the scheduler again.
    state = await this.dependencies.operations.get(workspaceId);
    for (const completed of state.teamTasks.filter(
      (task) => task.runId === runId && task.status === "completed"
    )) {
      await this.releaseDependentTasks(
        workspaceId,
        completed,
        completed.assignedToTerminalId ?? run.compazioTerminalId,
        correlationId
      );
    }

    state = await this.dependencies.operations.get(workspaceId);
    run = state.teamRuns.find((candidate) => candidate.id === runId);
    if (run === undefined)
      throw this.error(
        "TEAM_RUN_NOT_FOUND",
        "A execução da equipe não foi encontrada.",
        correlationId,
        false
      );
    const activeMembers = state.teamMembers.filter(
      (member) => member.runId === runId && !["dismissed", "failed"].includes(member.status)
    );
    if (
      activeMembers.length === contract.requiredMembers.length &&
      contract.requiredMembers.length > 0
    ) {
      const nodeIds = [
        run.compazioTerminalId,
        ...activeMembers.flatMap((member) => [
          member.terminalId,
          ...(member.notebookNodeId === undefined ? [] : [member.notebookNodeId])
        ])
      ];
      const workspace = await this.dependencies.workspaces.snapshot(workspaceId);
      if (run.groupId === undefined) {
        const groupId = await this.createRunGroup(workspaceId, run.title, nodeIds, workspace);
        if (groupId !== undefined)
          run = await this.dependencies.operations.updateTeamRun(
            workspaceId,
            runId,
            run.status,
            actor,
            { groupId }
          );
      } else {
        await this.dependencies.workspaces.updateGroup(workspaceId, run.groupId, { nodeIds });
      }
    }
    const tasks = state.teamTasks.filter((task) => task.runId === runId);
    const status = tasks.some(
      (task) => ["assigned", "running"].includes(task.status) && task.reviewOf !== undefined
    )
      ? "review"
      : tasks.some((task) => ["assigned", "running"].includes(task.status))
        ? "running"
        : recruitmentPending ||
            tasks.some((task) => task.status === "blocked" || task.status === "queued")
          ? "blocked"
          : run.status;
    return this.dependencies.operations.updateTeamRun(workspaceId, runId, status, actor);
  }

  /** The domain, never an agent's prose, is the sole authority for mission completion. */
  private canCompleteTeamRun(
    workspaceId: string,
    state: Awaited<ReturnType<V2OperationalService["get"]>>,
    run: TeamRun
  ): boolean {
    const contract = run.missionContract;
    const requiredMembersPresent = contract.requiredMembers.every((required) =>
      state.teamMembers.some(
        (member) =>
          member.runId === run.id &&
          member.agentType === required.agentType &&
          member.displayName === required.displayName &&
          !["dismissed", "failed"].includes(member.status)
      )
    );
    if (!requiredMembersPresent) return false;
    const requiredTasks = contract.requiredTasks.map((required) =>
      state.teamTasks.find(
        (task) => task.idempotencyKey === `${run.id}-contract-task-${required.key}`
      )
    );
    if (requiredTasks.some((task) => task?.status !== "completed" || task.result === undefined))
      return false;
    // A corrective or delegated review task belongs to the same mission even when it was created
    // after the initial plan. It cannot be skipped merely because the original Builder returned.
    if (
      state.teamTasks
        .filter((task) => task.runId === run.id)
        .some((task) => task.status !== "completed" || task.result === undefined)
    )
      return false;
    if (contract.requiresQa) {
      const reviews = state.teamTasks.filter(
        (task) => task.runId === run.id && task.reviewOf !== undefined
      );
      const latestReview = reviews.at(-1);
      if (
        latestReview === undefined ||
        latestReview.status !== "completed" ||
        latestReview.result === undefined ||
        !isPassingReviewResult(latestReview.result.summary)
      )
        return false;
    }
    if (contract.requiresPortal) {
      const portalReady = this.dependencies.portals
        ?.list(workspaceId)
        .some((portal) => portal.state === "ready" && !portal.loading);
      if (portalReady !== true) return false;
    }
    return true;
  }

  private async completeRunIfReady(
    workspaceId: string,
    runId: string | undefined,
    actor: string
  ): Promise<void> {
    if (runId === undefined) return;
    const state = await this.dependencies.operations.get(workspaceId);
    const run = state.teamRuns.find((candidate) => candidate.id === runId);
    if (run === undefined || ["completed", "cancelled", "failed"].includes(run.status)) return;
    const tasks = state.teamTasks.filter((task) => task.runId === runId);
    if (this.canCompleteTeamRun(workspaceId, state, run)) {
      await this.dependencies.operations.updateTeamRun(workspaceId, runId, "completed", actor);
      await this.cleanupCompletedRun(workspaceId, run);
    } else if (
      tasks.some((task) => task.status === "blocked") ||
      (tasks.length > 0 && tasks.every((task) => task.status === "completed"))
    ) {
      await this.dependencies.operations.updateTeamRun(workspaceId, runId, "blocked", actor);
    }
  }

  /**
   * A team task is a provider-native, non-interactive turn, not a keystroke in a worker terminal.
   * Its only durable effects are MCP task/message operations and append-only events.
   */
  private async dispatchTaskExecution(
    workspaceId: string,
    task: TeamTask,
    member: TeamMember,
    correlationId: string
  ): Promise<void> {
    const executionKey = `${workspaceId}:${task.id}`;
    if (this.activeTaskExecutions.has(executionKey)) return;
    const startTask = this.dependencies.workspaces.startBackgroundAgentTask;
    // Test doubles predating the isolated runtime intentionally have no process capability. The
    // production V2WorkspaceService always provides it; this preserves pure coordinator tests.
    if (typeof startTask !== "function") return;
    this.activeTaskExecutions.add(executionKey);
    try {
      const execution = await startTask.call(this.dependencies.workspaces, {
        workspaceId,
        terminalId: member.terminalId,
        prompt: taskExecutionPrompt(task, member),
        workspaceAccess: "write"
      });
      void execution.completion.then(
        (outcome) =>
          this.finishTaskExecution(
            workspaceId,
            task.id,
            member.terminalId,
            correlationId,
            outcome.session.state
          ),
        () =>
          this.finishTaskExecution(workspaceId, task.id, member.terminalId, correlationId, "failed")
      );
    } catch (cause: unknown) {
      this.activeTaskExecutions.delete(executionKey);
      await this.failTaskExecution(workspaceId, task.id, member.terminalId, correlationId, cause);
    }
  }

  private async finishTaskExecution(
    workspaceId: string,
    taskId: string,
    terminalId: string,
    correlationId: string,
    processState: TerminalSession["state"]
  ): Promise<void> {
    this.activeTaskExecutions.delete(`${workspaceId}:${taskId}`);
    const state = await this.dependencies.operations.get(workspaceId);
    const task = state.teamTasks.find((candidate) => candidate.id === taskId);
    if (task === undefined || ["completed", "cancelled", "failed"].includes(task.status)) return;
    const cause = new Error(
      processState === "completed"
        ? "O agente encerrou sem devolver task_result."
        : "O processo isolado do agente encerrou antes do task_result."
    );
    await this.failTaskExecution(workspaceId, taskId, terminalId, correlationId, cause);
  }

  private async failTaskExecution(
    workspaceId: string,
    taskId: string,
    terminalId: string,
    correlationId: string,
    cause: unknown
  ): Promise<void> {
    const state = await this.dependencies.operations.get(workspaceId);
    const task = state.teamTasks.find((candidate) => candidate.id === taskId);
    if (task === undefined || ["completed", "cancelled", "failed"].includes(task.status)) return;
    await this.dependencies.operations.updateTeamTask({
      workspaceId,
      taskId,
      actor: terminalId,
      status: "failed"
    });
    const member = state.teamMembers.find((candidate) => candidate.terminalId === terminalId);
    if (member !== undefined && member.status !== "dismissed") {
      await this.dependencies.operations.upsertTeamMember({ ...member, status: "failed" });
    }
    await this.sendMessage({
      workspaceId,
      fromTerminalId: terminalId,
      toTerminalId: task.createdByTerminalId,
      taskId,
      type: "error",
      content: taskExecutionFailureMessage(cause),
      idempotencyKey: `${taskId}-execution-failed`,
      correlationId
    }).catch(() => undefined);
    if (task.runId !== undefined) {
      const run = state.teamRuns.find((candidate) => candidate.id === task.runId);
      if (run !== undefined && !["completed", "failed", "cancelled"].includes(run.status)) {
        await this.dependencies.operations.updateTeamRun(
          workspaceId,
          run.id,
          "blocked",
          task.createdByTerminalId
        );
      }
    }
  }

  /** Completion is terminal for a TeamRun: descendants are stopped before their parents. */
  private async cleanupCompletedRun(workspaceId: string, run: TeamRun): Promise<void> {
    const state = await this.dependencies.operations.get(workspaceId);
    const members = state.teamMembers.filter(
      (member) => member.runId === run.id && member.status !== "dismissed"
    );
    const roots = members.filter(
      (member) =>
        member.parentTerminalId === run.compazioTerminalId ||
        !members.some((candidate) => candidate.terminalId === member.parentTerminalId)
    );
    for (const member of roots) {
      await this.dismiss({
        workspaceId,
        compazioTerminalId: run.compazioTerminalId,
        teamMemberId: member.id,
        reason: "TeamRun completed"
      });
    }
  }

  /**
   * Persistent control-plane mailbox. Agent-to-agent coordination must never type into an
   * interactive PTY: that line belongs to the person currently speaking with the selected agent.
   * MCP clients consume this durable mailbox with message_list/message_read instead.
   */
  public async sendMessage(input: {
    readonly workspaceId: string;
    readonly fromTerminalId: string;
    readonly toTerminalId: string;
    readonly content: string;
    readonly type: "task" | "progress" | "result" | "error" | "system";
    readonly taskId?: string;
    readonly correlationId?: string;
    readonly idempotencyKey: string;
  }): Promise<unknown> {
    const correlationId = input.correlationId ?? this.createId();
    const workspace = await this.requireActiveTerminal(input.workspaceId, input.fromTerminalId);
    await this.requireActiveTerminal(input.workspaceId, input.toTerminalId);
    if (!hasMessageConnection(workspace, input.fromTerminalId, input.toTerminalId, input.type)) {
      throw this.error(
        "TEAM_CONNECTION_REQUIRED",
        "Não existe uma conexão de equipe autorizada para esta entrega.",
        correlationId,
        false
      );
    }
    const content = sanitizeMessage(input.content, correlationId);
    const message = await this.dependencies.operations.enqueueAgentMessage({
      workspaceId: input.workspaceId,
      fromTerminalId: input.fromTerminalId,
      toTerminalId: input.toTerminalId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      correlationId,
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      content
    });
    if (message.status !== "queued") return message;
    // "Delivered" means that the control plane durably exposed the message to the recipient's
    // MCP mailbox. It intentionally does not mean "written to the terminal"; doing that caused
    // internal status and task text to race with the user's active command.
    const delivered = await this.dependencies.operations.updateAgentMessage(
      input.workspaceId,
      message.id,
      "delivered",
      input.fromTerminalId
    );
    // A worker's progress message acknowledges the last task envelope it received. Keep this
    // compatibility behavior for existing agents while the explicit message_acknowledge tool is
    // also available to newer clients.
    if (input.type === "progress" && input.taskId !== undefined) {
      const taskDelivery = [...(await this.dependencies.operations.get(input.workspaceId)).messages]
        .reverse()
        .find(
          (candidate) =>
            candidate.type === "task" &&
            candidate.taskId === input.taskId &&
            candidate.fromTerminalId === input.toTerminalId &&
            candidate.toTerminalId === input.fromTerminalId &&
            candidate.status === "delivered"
        );
      if (taskDelivery !== undefined)
        await this.dependencies.operations.updateAgentMessage(
          input.workspaceId,
          taskDelivery.id,
          "acknowledged",
          input.fromTerminalId
        );
    }
    return delivered;
  }

  public async messageList(workspaceId: string, terminalId: string): Promise<readonly unknown[]> {
    await this.requireActiveTerminal(workspaceId, terminalId);
    return (await this.dependencies.operations.get(workspaceId)).messages.filter(
      (message) => message.fromTerminalId === terminalId || message.toTerminalId === terminalId
    );
  }

  public async acknowledgeMessage(
    workspaceId: string,
    terminalId: string,
    messageId: string
  ): Promise<unknown> {
    await this.requireActiveTerminal(workspaceId, terminalId);
    const message = (await this.dependencies.operations.get(workspaceId)).messages.find(
      (candidate) => candidate.id === messageId
    );
    if (message === undefined)
      throw this.error(
        "TEAM_MESSAGE_DELIVERY_FAILED",
        "A mensagem não foi encontrada.",
        this.createId(),
        false
      );
    if (message.toTerminalId !== terminalId)
      throw this.error(
        "TEAM_CAPABILITY_DENIED",
        "Somente o destinatário pode confirmar a mensagem.",
        this.createId(),
        false
      );
    return this.dependencies.operations.updateAgentMessage(
      workspaceId,
      messageId,
      "acknowledged",
      terminalId
    );
  }

  public async messageRead(
    workspaceId: string,
    terminalId: string,
    messageId: string
  ): Promise<unknown> {
    await this.requireActiveTerminal(workspaceId, terminalId);
    const message = (await this.dependencies.operations.get(workspaceId)).messages.find(
      (candidate) =>
        candidate.id === messageId &&
        (candidate.toTerminalId === terminalId || candidate.fromTerminalId === terminalId)
    );
    if (message === undefined) {
      throw this.error(
        "TEAM_CAPABILITY_DENIED",
        "A mensagem não está disponível para este terminal.",
        this.createId(),
        false
      );
    }
    return message;
  }

  public async dismiss(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly teamMemberId: string;
    readonly reason?: string;
    readonly correlationId?: string;
  }): Promise<{ readonly teamMemberId: string; readonly dismissed: boolean }> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    const state = await this.dependencies.operations.get(input.workspaceId);
    const member = state.teamMembers.find((candidate) => candidate.id === input.teamMemberId);
    if (member === undefined)
      throw this.error(
        "TEAM_MEMBER_NOT_FOUND",
        "O integrante não foi encontrado.",
        correlationId,
        false
      );
    const run = state.teamRuns.find(
      (candidate) =>
        candidate.compazioTerminalId === input.compazioTerminalId &&
        candidate.memberIds.includes(member.id)
    );
    if (run === undefined && member.recruitedByTerminalId !== input.compazioTerminalId)
      throw this.error(
        "WORKSPACE_ACCESS_DENIED",
        `Este ${ORCHESTRATOR_LABEL} não recrutou o integrante solicitado.`,
        correlationId,
        false
      );
    if (member.status === "dismissed") return { teamMemberId: member.id, dismissed: true };
    try {
      const descendants: TeamMember[] = [];
      const pending = [member.terminalId];
      while (pending.length > 0) {
        const parentTerminalId = pending.pop();
        for (const child of state.teamMembers.filter(
          (candidate) =>
            candidate.parentTerminalId === parentTerminalId && candidate.status !== "dismissed"
        )) {
          descendants.push(child);
          pending.push(child.terminalId);
        }
      }
      for (const current of [...descendants.reverse(), member]) {
        await this.dependencies.operations.markTeamMemberDismissing(
          input.workspaceId,
          current.terminalId,
          input.compazioTerminalId
        );
        await this.dependencies.workspaces.dismissTeamTerminal(
          input.workspaceId,
          current.terminalId
        );
        await this.dependencies.operations.dismissTeamMember(
          input.workspaceId,
          current.terminalId,
          input.compazioTerminalId
        );
      }
      await this.dependencies.operations.recordOperationalEvent({
        workspaceId: input.workspaceId,
        actor: input.compazioTerminalId,
        type: "team.cleanup.completed",
        target: member.terminalId,
        ...(input.reason === undefined ? {} : { metadata: { reason: input.reason.slice(0, 240) } })
      });
      return { teamMemberId: member.id, dismissed: true };
    } catch {
      throw this.error(
        "TEAM_CLEANUP_FAILED",
        "O Compazio não conseguiu encerrar todos os recursos do integrante.",
        correlationId,
        true
      );
    }
  }

  /** Revocation is root-only, durable, and effective before the next MCP capability request. */
  public async revokeRecruitLimited(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly teamMemberId: string;
    readonly correlationId?: string;
  }): Promise<TeamMember> {
    const correlationId = input.correlationId ?? this.createId();
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, correlationId);
    const state = await this.dependencies.operations.get(input.workspaceId);
    const member = state.teamMembers.find((candidate) => candidate.id === input.teamMemberId);
    if (member === undefined)
      throw this.error("TEAM_MEMBER_NOT_FOUND", "Team member was not found.", correlationId, false);
    const run = state.teamRuns.find(
      (candidate) =>
        candidate.id === member.runId && candidate.compazioTerminalId === input.compazioTerminalId
    );
    if (run === undefined)
      throw this.error(
        "TEAM_RECRUIT_CAPABILITY_DENIED",
        "The grant does not belong to this terminal's active TeamRun.",
        correlationId,
        false
      );
    return this.dependencies.operations.setTeamMemberCapabilities(
      input.workspaceId,
      member.id,
      [],
      input.compazioTerminalId
    );
  }

  /** Compatibility entry point for the internal legacy bridge; MCP does not expose this operation. */
  public async connect(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly sourceTerminalId: string;
    readonly targetTerminalId: string;
    readonly capabilities?: readonly EdgeCapability[];
  }): Promise<CanvasEdge> {
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, this.createId());
    const workspace = await this.dependencies.workspaces.addEdge(
      input.workspaceId,
      input.sourceTerminalId,
      input.targetTerminalId,
      input.capabilities ?? ["send-message", "share-context"]
    );
    const edge = workspace.edges.find(
      (candidate) =>
        candidate.sourceNodeId === input.sourceTerminalId &&
        candidate.targetNodeId === input.targetTerminalId
    );
    if (edge === undefined)
      throw this.error(
        "TEAM_CONNECTION_REQUIRED",
        "A conexão não foi criada.",
        this.createId(),
        true
      );
    return edge;
  }

  public async disconnect(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly edgeId: string;
  }): Promise<void> {
    await this.requireCompazio(input.workspaceId, input.compazioTerminalId, this.createId());
    const workspace = await this.dependencies.workspaces.snapshot(input.workspaceId);
    const edge = workspace.edges.find((candidate) => candidate.id === input.edgeId);
    if (edge === undefined) return;
    const state = await this.dependencies.operations.get(input.workspaceId);
    const owned = state.teamMembers.filter(
      (member) => member.recruitedByTerminalId === input.compazioTerminalId
    );
    const allowed = new Set([
      input.compazioTerminalId,
      ...owned.map((member) => member.terminalId)
    ]);
    if (!allowed.has(edge.sourceNodeId) || !allowed.has(edge.targetNodeId)) {
      throw this.error(
        "WORKSPACE_ACCESS_DENIED",
        `Esta conexão não pertence à equipe do ${ORCHESTRATOR_LABEL}.`,
        this.createId(),
        false
      );
    }
    await this.dependencies.workspaces.removeEdge(input.workspaceId, edge.id);
    await this.dependencies.operations.recordOperationalEvent({
      workspaceId: input.workspaceId,
      actor: input.compazioTerminalId,
      type: "team.connection.removed",
      target: edge.id
    });
  }

  private async createAndAssignInitialTask(input: {
    readonly workspaceId: string;
    readonly compazioTerminalId: string;
    readonly member: TeamMember;
    readonly title: string;
    readonly description: string;
    readonly contextRefs: readonly string[];
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<TeamTask> {
    const task = await this.createTask({
      workspaceId: input.workspaceId,
      creatorId: input.compazioTerminalId,
      title: input.title,
      description: input.description,
      contextRefs: input.contextRefs,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId
    });
    return this.assignTask({
      workspaceId: input.workspaceId,
      compazioTerminalId: input.compazioTerminalId,
      taskId: task.id,
      teamMemberId: input.member.id,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId
    });
  }

  private async ensureConnection(
    workspaceId: string,
    compazioTerminalId: string,
    sourceTerminalId: string,
    workerTerminalId: string
  ): Promise<CanvasEdge> {
    const workspace = await this.dependencies.workspaces.snapshot(workspaceId);
    const existing = workspace.edges.find(
      (edge) => edge.sourceNodeId === sourceTerminalId && edge.targetNodeId === workerTerminalId
    );
    if (existing !== undefined) return existing;
    return this.connect({
      workspaceId,
      compazioTerminalId,
      sourceTerminalId,
      targetTerminalId: workerTerminalId,
      capabilities: ["send-message", "share-context", "task-delegate", "result-return"]
    });
  }

  /**
   * Every recruited agent gets one explicit markdown surface for durable progress, decisions,
   * blockers and evidence. It is connected before the process starts, so the adapter stages the
   * same source of truth the canvas shows instead of asking the agent to talk through its TUI.
   */
  private async createMemberNotebook(input: {
    readonly workspaceId: string;
    readonly rootTerminalId: string;
    readonly terminal: Extract<CanvasNode, { readonly type: "terminal" }>;
    readonly role: TeamRole;
  }): Promise<string> {
    const before = await this.dependencies.workspaces.snapshot(input.workspaceId);
    const updated = await this.dependencies.workspaces.addNote(input.workspaceId, {
      title: `Caderno — ${input.terminal.title}`,
      content: memberNotebookContent(input.terminal.title, input.role),
      position: {
        x: input.terminal.position.x,
        y: input.terminal.position.y + input.terminal.size.height + 32
      }
    });
    const note = updated.nodes.find(
      (node): node is Extract<CanvasNode, { readonly type: "note" }> =>
        node.type === "note" && !before.nodes.some((candidate) => candidate.id === node.id)
    );
    if (note === undefined) throw new Error("The recruited agent notebook was not created");
    const capabilities = ["share-context", "read-note", "write-note"] as const;
    await this.dependencies.workspaces.addEdge(
      input.workspaceId,
      input.rootTerminalId,
      note.id,
      capabilities
    );
    if (input.terminal.id !== input.rootTerminalId) {
      await this.dependencies.workspaces.addEdge(
        input.workspaceId,
        input.terminal.id,
        note.id,
        capabilities
      );
    }
    return note.id;
  }

  /** A task's context refs become explicit least-privilege canvas grants for its assignee. */
  private async ensureTaskContextConnections(
    workspaceId: string,
    delegatorTerminalId: string,
    workerTerminalId: string,
    contextRefs: readonly string[],
    correlationId: string
  ): Promise<void> {
    for (const contextId of [...new Set(contextRefs)]) {
      const workspace = await this.dependencies.workspaces.snapshot(workspaceId);
      const context = workspace.nodes.find((node) => node.id === contextId);
      if (context === undefined || context.type === "terminal")
        throw this.error(
          "TEAM_CAPABILITY_DENIED",
          "A tarefa referencia um contexto inexistente ou nao delegavel.",
          correlationId,
          false
        );
      const delegatorIds = new Set(delegatedContextTerminalIds(workspace, delegatorTerminalId));
      const grant = workspace.edges.find(
        (edge) =>
          delegatorIds.has(edge.sourceNodeId) &&
          edge.targetNodeId === contextId &&
          edge.capabilities.some((capability) =>
            [
              "share-context",
              "read-note",
              "write-note",
              "portal-read",
              "portal-control",
              "portal-screenshot"
            ].includes(capability)
          )
      );
      if (grant === undefined)
        throw this.error(
          "TEAM_CAPABILITY_DENIED",
          "O agente so pode delegar contextos aos quais possui acesso explicito.",
          correlationId,
          false
        );
      const capabilities = delegatedContextCapabilities(context, grant.capabilities);
      const existing = workspace.edges.find(
        (edge) => edge.sourceNodeId === workerTerminalId && edge.targetNodeId === contextId
      );
      if (existing !== undefined) {
        if (capabilities.every((capability) => existing.capabilities.includes(capability)))
          continue;
        throw this.error(
          "TEAM_CAPABILITY_DENIED",
          "A conexao de contexto existente nao possui as capacidades exigidas pela tarefa.",
          correlationId,
          false
        );
      }
      await this.dependencies.workspaces.addEdge(
        workspaceId,
        workerTerminalId,
        contextId,
        capabilities
      );
    }
  }

  private async ensureWorkerConnection(
    workspaceId: string,
    compazioTerminalId: string,
    sourceTerminalId: string,
    targetTerminalId: string
  ): Promise<CanvasEdge> {
    const workspace = await this.dependencies.workspaces.snapshot(workspaceId);
    const existing = workspace.edges.find(
      (edge) => edge.sourceNodeId === sourceTerminalId && edge.targetNodeId === targetTerminalId
    );
    if (existing !== undefined) return existing;
    const edge = await this.connect({
      workspaceId,
      compazioTerminalId,
      sourceTerminalId,
      targetTerminalId,
      capabilities: ["send-message", "share-context", "result-return", "review-request"]
    });
    await this.dependencies.operations.recordOperationalEvent({
      workspaceId,
      actor: compazioTerminalId,
      type: "team.connection.created",
      target: edge.id,
      metadata: { review: true }
    });
    return edge;
  }

  private async createRunGroup(
    workspaceId: string,
    title: string,
    nodeIds: readonly string[],
    workspace: Workspace
  ): Promise<string | undefined> {
    if (nodeIds.some((nodeId) => workspace.groups.some((group) => group.nodeIds.includes(nodeId))))
      return undefined;
    const nodes = workspace.nodes.filter((node) => nodeIds.includes(node.id));
    if (nodes.length !== nodeIds.length) return undefined;
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const maxX = Math.max(...nodes.map((node) => node.position.x + node.size.width));
    const maxY = Math.max(...nodes.map((node) => node.position.y + node.size.height));
    const updated = await this.dependencies.workspaces.createGroup(workspaceId, {
      title: `Equipe — ${title}`,
      nodeIds,
      position: { x: minX - 24, y: minY - 48 },
      size: { width: maxX - minX + 48, height: maxY - minY + 72 },
      color: "blue"
    });
    return updated.groups.find(
      (group) =>
        group.nodeIds.length === nodeIds.length && group.nodeIds.every((id) => nodeIds.includes(id))
    )?.id;
  }

  private memberIdForTerminal(
    state: { readonly teamMembers: readonly TeamMember[] },
    terminalId: string
  ): string | undefined {
    return state.teamMembers.find((member) => member.terminalId === terminalId)?.id;
  }

  /** Canonical recruitment authorization. Capacity is rechecked atomically by reserveTeamRecruitment. */
  private async canRecruit(
    workspaceId: string,
    terminalId: string,
    correlationId: string
  ): Promise<{
    readonly workspace: Workspace;
    readonly terminal: Extract<CanvasNode, { readonly type: "terminal" }>;
    readonly run: TeamRun | undefined;
    readonly root: boolean;
    readonly rootTerminalId: string;
    readonly childDepth: number;
  }> {
    const workspace = await this.requireActiveTerminal(workspaceId, terminalId);
    const terminal = requireTerminal(workspace, terminalId);
    const state = await this.dependencies.operations.get(workspaceId);
    if (isCompazio(terminal)) {
      const run = state.teamRuns.find(
        (candidate) =>
          candidate.compazioTerminalId === terminalId &&
          !["completed", "failed", "cancelled"].includes(candidate.status)
      );
      return { workspace, terminal, run, root: true, rootTerminalId: terminalId, childDepth: 1 };
    }
    const member = state.teamMembers.find(
      (candidate) => candidate.terminalId === terminalId && candidate.status !== "dismissed"
    );
    if (member === undefined)
      throw this.error(
        "TEAM_RECRUIT_CAPABILITY_DENIED",
        "This worker was not granted recruit-limited.",
        correlationId,
        false
      );
    const run = state.teamRuns.find(
      (candidate) =>
        (member.runId === candidate.id || candidate.memberIds.includes(member.id)) &&
        !["completed", "failed", "cancelled"].includes(candidate.status)
    );
    if (run === undefined)
      throw this.error(
        "TEAM_RECRUIT_CAPABILITY_DENIED",
        "The recruit-limited grant does not belong to an active TeamRun.",
        correlationId,
        false
      );
    if (member.depth >= run.recruitmentPolicy.maxDepth)
      throw this.error(
        "TEAM_RECRUIT_DEPTH_LIMIT",
        "The TeamRun maximum depth has been reached.",
        correlationId,
        false
      );
    if (!member.grantedCapabilities.includes("recruit-limited"))
      throw this.error(
        "TEAM_RECRUIT_CAPABILITY_DENIED",
        "This worker was not granted recruit-limited.",
        correlationId,
        false
      );
    return {
      workspace,
      terminal,
      run,
      root: false,
      rootTerminalId: run.compazioTerminalId,
      childDepth: member.depth + 1
    };
  }

  private async requireCompazio(
    workspaceId: string,
    terminalId: string,
    correlationId: string
  ): Promise<Workspace> {
    const workspace = await this.requireActiveTerminal(workspaceId, terminalId);
    if (!isCompazio(requireTerminal(workspace, terminalId))) {
      throw this.error(
        "TEAM_CAPABILITY_DENIED",
        `Ative ${ORCHESTRATOR_LABEL} neste terminal para administrar a equipe.`,
        correlationId,
        false
      );
    }
    return workspace;
  }

  private async requireActiveTerminal(workspaceId: string, terminalId: string): Promise<Workspace> {
    const workspace = await this.dependencies.workspaces.snapshot(workspaceId);
    requireTerminal(workspace, terminalId);
    const session = this.dependencies.workspaces.sessionForNode(workspaceId, terminalId);
    if (session === null || !["starting", "running", "waiting-input"].includes(session.state)) {
      const member = (await this.dependencies.operations.get(workspaceId)).teamMembers.find(
        (candidate) => candidate.terminalId === terminalId
      );
      // Managed workers intentionally have no person-facing PTY. Their authenticated background
      // MCP session is the runtime authority; the durable member record is the control-plane
      // identity used while assigning and routing tasks.
      if (member !== undefined) return workspace;
      throw this.error(
        "TEAM_MEMBER_NOT_READY",
        "O terminal solicitante não está ativo.",
        this.createId(),
        true
      );
    }
    return workspace;
  }

  private async resolveRole(
    role: TeamRole | undefined,
    roleId: string | undefined
  ): Promise<TeamRole> {
    if (role !== undefined) return role;
    if (roleId !== undefined) {
      const catalogRole = (await this.dependencies.agents.listRoles()).find(
        (candidate) => candidate.id === roleId
      );
      if (catalogRole !== undefined) {
        return {
          name: catalogRole.name,
          ...(catalogRole.description === undefined
            ? {}
            : { description: catalogRole.description }),
          responsibilities: [catalogRole.instructions.slice(0, 1_000)]
        };
      }
    }
    return {
      name: "Test Engineer",
      responsibilities: [
        "Revisar a fixture indicada.",
        "Identificar problemas.",
        `Retornar um relatório objetivo ao ${ORCHESTRATOR_LABEL}.`
      ]
    };
  }

  private canReadTask(task: TeamTask, terminalId: string, compazio: boolean): boolean {
    return (
      compazio ||
      task.assignedToTerminalId === terminalId ||
      task.createdByTerminalId === terminalId
    );
  }

  private error(
    code: TeamCoordinatorErrorCode,
    message: string,
    correlationId: string,
    retryable: boolean,
    technicalDetails?: string
  ): TeamCoordinatorError {
    return new TeamCoordinatorError(code, message, retryable, correlationId, {
      ...(technicalDetails === undefined ? {} : { technicalDetails })
    });
  }
}

function findTerminal(
  workspace: Workspace,
  terminalId: string
): Extract<CanvasNode, { readonly type: "terminal" }> | undefined {
  const node = workspace.nodes.find((candidate) => candidate.id === terminalId);
  return node?.type === "terminal" ? node : undefined;
}

function requireTerminal(
  workspace: Workspace,
  terminalId: string
): Extract<CanvasNode, { readonly type: "terminal" }> {
  const terminal = findTerminal(workspace, terminalId);
  if (terminal === undefined) {
    throw new TeamCoordinatorError(
      "TEAM_MEMBER_NOT_FOUND",
      "O terminal não está disponível nesta equipe.",
      false
    );
  }
  return terminal;
}

function isCompazio(terminal: Extract<CanvasNode, { readonly type: "terminal" }>): boolean {
  return terminal.isCompazio || terminal.orchestrator;
}

function safeStartFailureDetail(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  return cause.message
    .replace(/[A-Za-z]:\\Users\\[^\s]+/g, "[LOCAL_PATH]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 600);
}

function relativePosition(
  compazio: Extract<CanvasNode, { readonly type: "terminal" }>,
  direction: "left" | "right" | "above" | "below"
): { readonly x: number; readonly y: number } {
  const gap = 56;
  if (direction === "left")
    return { x: compazio.position.x - compazio.size.width - gap, y: compazio.position.y };
  if (direction === "above")
    return { x: compazio.position.x, y: compazio.position.y - compazio.size.height - gap };
  if (direction === "below")
    return { x: compazio.position.x, y: compazio.position.y + compazio.size.height + gap };
  return { x: compazio.position.x + compazio.size.width + gap, y: compazio.position.y };
}

function memberNotebookContent(displayName: string, role: TeamRole): string {
  return [
    `# Caderno — ${displayName}`,
    "",
    `**Papel:** ${role.name}`,
    "",
    "> Memória persistente deste agente. Registre aqui progresso verificável, decisões, bloqueios e evidências. Perguntas ao usuário são enviadas pela entrada estruturada do Compazio, nunca pela TUI privada.",
    "",
    "## Tarefa atual",
    "",
    "Aguardando atribuição estruturada.",
    "",
    "## Progresso e ações",
    "",
    "- Nenhuma ação registrada.",
    "",
    "## Decisões",
    "",
    "- Nenhuma decisão registrada.",
    "",
    "## Bloqueios e perguntas",
    "",
    "- Nenhum bloqueio registrado.",
    "",
    "## Evidências e entrega",
    "",
    "- Nenhuma evidência registrada."
  ].join("\n");
}

function roleInstructions(
  role: TeamRole,
  task: { readonly title: string; readonly description: string } | undefined,
  compazioTerminalId: string,
  canRecruitLimited: boolean
): string {
  return [
    `Identidade: Você é o ${role.name} da equipe.`,
    ...(role.description === undefined ? [] : [`Descrição: ${role.description}`]),
    "Responsabilidades:",
    ...role.responsibilities.map((responsibility) => `- ${responsibility}`),
    `Você responde ao ${ORCHESTRATOR_LABEL} por um identificador lógico seguro.`,
    `${ORCHESTRATOR_LABEL}: ${compazioTerminalId}`,
    canRecruitLimited
      ? "Ferramentas permitidas: team_recruit, task_create, task_assign, task_status, task_result, message_send, message_list e message_acknowledge."
      : "Ferramentas permitidas: task_status, task_result, message_send, message_list e message_acknowledge.",
    canRecruitLimited
      ? "Limites: você pode recrutar somente um subworker pela capability recruit-limited, dentro desta equipe e tarefa. Não conceda recruit-limited ao subworker, não acesse outros workspaces e não use ferramentas não concedidas."
      : "Limites: não recrute agentes, não acesse outros workspaces, não altere arquivos fora do contexto autorizado e não use ferramentas não concedidas.",
    "A coordenação usa a caixa MCP (message_list, message_read e message_acknowledge), nunca texto injetado no terminal.",
    "O terminal é observabilidade e controle manual, não um chat privado do agente. Registre progresso, decisões, ações, bloqueios e evidências no Caderno conectado ao seu terminal.",
    "Se precisar de informação humana durante uma tarefa, chame task_request_user_input e aguarde a resposta no control plane; nunca faça a pergunta na TUI privada.",
    ...(task === undefined
      ? [`Tarefa atual: aguarde uma tarefa estruturada do ${ORCHESTRATOR_LABEL}.`]
      : ["Tarefa atual:", task.title, task.description])
  ].join("\n");
}

function taskDelivery(task: TeamTask): string {
  return [
    `Tarefa estruturada do ${ORCHESTRATOR_LABEL}:`,
    `ID: ${task.id}`,
    `Título: ${task.title}`,
    `Descrição: ${task.description}`,
    "Leia e confirme a tarefa pela caixa MCP (message_list, message_read e message_acknowledge); ela nunca serÃ¡ digitada no terminal. Devolva o resultado estruturado por task_result.",
    "Trabalhe somente dentro do workspace autorizado, preserve o que já existe e aplique apenas as mudanças pedidas pela tarefa."
  ].join("\n");
}

/** The hidden turn is explicit so external CLIs never need a synthetic terminal keystroke. */
function taskExecutionPrompt(task: TeamTask, member: TeamMember): string {
  return [
    "You are running one bounded Compazio team task in a private background process.",
    "This process is not the user's terminal. Never attempt to communicate through terminal text.",
    `Your team role is ${member.role.name}.`,
    "Responsibilities:",
    ...member.role.responsibilities.map((responsibility) => `- ${responsibility}`),
    taskDelivery(task),
    "Use the Compazio MCP tools to read and acknowledge the task mailbox, then complete the work.",
    ...(member.notebookNodeId === undefined
      ? []
      : [
          `Your persistent notebook is note ${member.notebookNodeId}. Keep durable progress, decisions, blockers and evidence there with note_update.`,
          "Do not use the notebook as a raw chat transcript."
        ]),
    "If human information is required, call task_request_user_input and wait. Never ask through the private terminal UI.",
    `Before exiting, you MUST call task_result for task ${task.id} with a concise summary and any relevant artifacts.`,
    "Use note tools only for deliberate, durable project knowledge; do not turn notes into a communication log."
  ].join("\n");
}

function taskExecutionFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : "O executor isolado falhou.";
  return `Execucao da tarefa interrompida: ${detail}`.slice(0, 1_000);
}

function isBlockedTaskResult(summary: string): boolean {
  const verdict = normalizeVerdict(summary);
  return (
    /^\s*(?:bloquead[ao]|blocked|falh(?:a|ou)|failed|nao (?:foi|pude|consegui))\b/i.test(verdict) ||
    /\b(?:resultado\s+qa|qa|status|veredito)\s*[-:—–/]\s*(?:bloquead[ao]|blocked|nao avaliad[ao]|not evaluated)\b/i.test(
      verdict
    )
  );
}

function isPassingReviewResult(summary: string): boolean {
  const verdict = normalizeVerdict(summary);
  return (
    /\bqa\s*(?:[-:—–]\s*)?pass\b/i.test(verdict) ||
    /\b(?:approved|aprovad[ao]s?|passed)\b/i.test(verdict) ||
    /["']approved["']\s*:\s*true/i.test(verdict)
  );
}

function isFailingReviewResult(summary: string): boolean {
  const verdict = normalizeVerdict(summary);
  return (
    /\bqa\s*(?:[-:—–]\s*)?fail(?:ed)?\b/i.test(verdict) ||
    /\b(?:final\s+)?verdict\s*[-:—–]\s*fail(?:ed)?\b/i.test(verdict) ||
    /["']approved["']\s*:\s*false/i.test(verdict)
  );
}

function normalizeVerdict(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function delegatedContextTerminalIds(workspace: Workspace, terminalId: string): readonly string[] {
  const ids = new Set<string>([terminalId]);
  let currentId = terminalId;
  for (let depth = 0; depth < 3; depth += 1) {
    const terminal = workspace.nodes.find(
      (node) => node.id === currentId && node.type === "terminal"
    );
    if (terminal?.type !== "terminal" || terminal.orchestratorOwnerNodeId === undefined) break;
    const ownerId = terminal.orchestratorOwnerNodeId;
    const sharesContext = workspace.edges.some(
      (edge) =>
        ((edge.sourceNodeId === currentId && edge.targetNodeId === ownerId) ||
          (edge.targetNodeId === currentId && edge.sourceNodeId === ownerId)) &&
        edge.capabilities.includes("share-context")
    );
    if (!sharesContext) break;
    ids.add(ownerId);
    currentId = ownerId;
  }
  return [...ids];
}

function delegatedContextCapabilities(
  context: Exclude<CanvasNode, { readonly type: "terminal" }>,
  available: readonly EdgeCapability[]
): readonly EdgeCapability[] {
  const allowed =
    context.type === "note"
      ? (["share-context", "read-note", "write-note"] as const)
      : context.type === "portal"
        ? (["share-context", "portal-read", "portal-control", "portal-screenshot"] as const)
        : (["share-context"] as const);
  return allowed.filter((capability) => available.includes(capability));
}

function hasMessageConnection(
  workspace: Workspace,
  fromTerminalId: string,
  toTerminalId: string,
  type: "task" | "progress" | "result" | "error" | "system"
): boolean {
  const direct = workspace.edges.find(
    (edge) => edge.sourceNodeId === fromTerminalId && edge.targetNodeId === toTerminalId
  );
  if (direct?.capabilities.includes("send-message") === true) return true;
  if (type !== "result" && type !== "progress" && type !== "error") return false;
  return workspace.edges.some(
    (edge) =>
      edge.sourceNodeId === toTerminalId &&
      edge.targetNodeId === fromTerminalId &&
      edge.capabilities.includes("result-return")
  );
}

function sanitizeMessage(value: string, correlationId: string): string {
  const content = value.trim();
  if (content.length === 0 || content.length > 16_000) {
    throw new TeamCoordinatorError(
      "TEAM_MESSAGE_DELIVERY_FAILED",
      "A mensagem deve ter entre 1 e 16.000 caracteres.",
      false,
      correlationId
    );
  }
  if (/(?:bearer\s+[a-z0-9._-]{12,}|api[_-]?key\s*[=:]|password\s*[=:])/i.test(content)) {
    throw new TeamCoordinatorError(
      "TEAM_MESSAGE_DELIVERY_FAILED",
      "A mensagem parece conter uma credencial e foi bloqueada.",
      false,
      correlationId
    );
  }
  return content;
}

function serializeTerminal(
  terminal: Extract<CanvasNode, { readonly type: "terminal" }>
): Record<string, unknown> {
  return {
    id: terminal.id,
    type: terminal.type,
    title: terminal.title,
    agentType: terminal.agentConfig.agentId,
    isCompazio: isCompazio(terminal)
  };
}

function sameResult(
  current: TeamTask["result"],
  proposed: { readonly summary: string; readonly artifacts?: readonly string[] }
): boolean {
  if (current === undefined || current.summary !== proposed.summary) return false;
  return JSON.stringify(current.artifacts ?? []) === JSON.stringify(proposed.artifacts ?? []);
}

function hasKeyCycle(
  tasks: readonly { readonly key: string; readonly dependsOn?: readonly string[] }[]
): boolean {
  const dependencies = new Map(tasks.map((task) => [task.key, task.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return tasks.some((task) => visit(task.key));
}

function buildDependencyContext(completed: TeamTask, dependent: TeamTask): string {
  const summary = completed.result?.summary ?? "Resultado estruturado disponível.";
  return [
    `Contexto de tarefa dependente autorizado pelo ${ORCHESTRATOR_LABEL}:`,
    `Tarefa concluída: ${completed.title}`,
    `Referência: ${completed.id}`,
    `Resumo: ${summary.slice(0, 4_000)}`,
    ...(completed.result?.artifacts === undefined
      ? []
      : [`Artefatos permitidos: ${completed.result.artifacts.slice(0, 20).join(", ")}`]),
    ...(dependent.reviewOf === completed.id
      ? ["Critério: revise a proposta recebida e devolva uma opinião estruturada."]
      : [])
  ].join("\n");
}
