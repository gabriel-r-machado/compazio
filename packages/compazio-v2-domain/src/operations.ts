import { z } from "zod";

import {
  LEGACY_COORDINATOR_DISABLED_EVENT,
  LEGACY_COORDINATOR_ENABLED_EVENT,
  LEGACY_COORDINATOR_TERMINAL_ID
} from "./legacy-coordinator-compat";

/**
 * Version 2 adds the durable team layer.  It deliberately lives beside the Phase 4 run state:
 * a canvas workspace remains the source of truth for nodes and edges, while this file keeps the
 * serializable coordination history which must survive a renderer or process restart.
 */
export const OPERATIONAL_SCHEMA_VERSION = 5;

/**
 * v5 renamed the coordinating-terminal vocabulary. Documents written before it carry the old run
 * event types and the old team-run field name.
 */
const LEGACY_COORDINATOR_EVENT_TYPES: Readonly<Record<string, string>> = {
  [LEGACY_COORDINATOR_ENABLED_EVENT]: "compazio.enabled",
  [LEGACY_COORDINATOR_DISABLED_EVENT]: "compazio.disabled"
};

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const timestampSchema = z.iso.datetime();
const safeTextSchema = z.string().trim().min(1).max(2_000);

export const operationalErrorCodeSchema = z.enum([
  "ORCHESTRATION_RUN_NOT_FOUND",
  "ORCHESTRATION_INVALID_TRANSITION",
  "ORCHESTRATOR_PERMISSION_DENIED",
  "ORCHESTRATOR_DISCONNECTED",
  "AGENT_RECRUIT_FAILED",
  "AGENT_LIMIT_REACHED",
  "TASK_ASSIGNMENT_FAILED",
  "TASK_TIMEOUT",
  "TASK_RETRY_EXHAUSTED",
  "TASK_REASSIGNMENT_FAILED",
  "CONNECTION_DELIVERY_FAILED",
  "CONNECTION_TIMEOUT",
  "ATTENTION_REQUEST_NOT_FOUND",
  "RECOVERY_ACTION_FAILED",
  "LAYOUT_CONFLICT",
  "RUN_RECOVERY_REQUIRED",
  "NOTIFICATION_FAILED",
  "POLICY_INVALID",
  "POLICY_LIMIT_REACHED",
  "TEAM_CAPABILITY_DENIED",
  "TEAM_MEMBER_NOT_FOUND",
  "TEAM_TASK_NOT_FOUND",
  "AGENT_NOT_CONNECTED",
  "AGENT_NOT_AVAILABLE",
  "MESSAGE_NOT_FOUND",
  "MESSAGE_DELIVERY_FAILED",
  "MESSAGE_TIMEOUT",
  "TEAM_RECRUIT_LIMIT_REACHED",
  "TEAM_RECRUIT_DEPTH_EXCEEDED",
  "TEAM_RECRUIT_CAPABILITY_DENIED",
  "TEAM_RECRUIT_DEPTH_LIMIT",
  "TEAM_RECRUIT_ACTIVE_LIMIT",
  "TEAM_RECRUIT_CHILD_LIMIT",
  "TEAM_RECRUIT_BUDGET_EXCEEDED",
  "TEAM_MEMBER_ALREADY_EXISTS",
  "TEAM_MEMBER_NOT_READY",
  "TEAM_MEMBER_DISMISSED",
  "AGENT_NOT_AUTHENTICATED",
  "AGENT_START_FAILED",
  "AGENT_READY_TIMEOUT",
  "TEAM_CONNECTION_REQUIRED",
  "TEAM_TASK_ALREADY_COMPLETED",
  "TEAM_TASK_ASSIGNMENT_DENIED",
  "TEAM_MESSAGE_DELIVERY_FAILED",
  "TEAM_RESULT_INVALID",
  "TEAM_OPERATION_CANCELLED",
  "TEAM_CLEANUP_FAILED",
  "WORKSPACE_ACCESS_DENIED",
  "TEAM_RUN_NOT_FOUND",
  "TEAM_RUN_ALREADY_FINISHED",
  "TEAM_TASK_DEPENDENCY_NOT_FOUND",
  "TEAM_TASK_DEPENDENCY_CYCLE",
  "TEAM_TASK_BLOCKED",
  "TEAM_TASK_DEPENDENCY_FAILED",
  "TEAM_TASK_ASSIGNMENT_CONFLICT"
]);
export type OperationalErrorCode = z.infer<typeof operationalErrorCodeSchema>;

export const structuredFailureSchema = z
  .object({
    code: operationalErrorCodeSchema,
    message: safeTextSchema,
    technicalDetails: z.string().max(4_000).optional(),
    suggestedAction: z.string().max(1_000),
    retryable: z.boolean(),
    correlationId: idSchema
  })
  .strict();
export type StructuredFailure = z.infer<typeof structuredFailureSchema>;

export class OperationalDomainError extends Error {
  public readonly failure: StructuredFailure;
  public override readonly cause?: unknown;

  public constructor(failure: StructuredFailure, cause?: unknown) {
    super(failure.message);
    this.name = "OperationalDomainError";
    this.failure = structuredFailureSchema.parse(failure);
    this.cause = cause;
  }
}

export const executionPolicyIdSchema = z.enum(["economy", "standard", "high-performance"]);
export type ExecutionPolicyId = z.infer<typeof executionPolicyIdSchema>;

export const executionPolicySchema = z
  .object({
    id: executionPolicyIdSchema,
    maxConcurrentAgents: z.number().int().min(1).max(12),
    maxDelegationDepth: z.number().int().min(0).max(8),
    maxAutomaticRetries: z.number().int().min(0).max(5),
    preferExistingAgents: z.boolean(),
    autoDismissCompletedAgents: z.boolean(),
    messageDetail: z.enum(["compact", "balanced", "detailed"]),
    contextSharing: z.enum(["minimal", "relevant", "broad"]),
    idleTimeoutMinutes: z.number().int().min(1).max(1_440).optional(),
    taskTimeoutMinutes: z.number().int().min(1).max(1_440).optional()
  })
  .strict();
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export const EXECUTION_POLICIES: Readonly<Record<ExecutionPolicyId, ExecutionPolicy>> = {
  economy: {
    id: "economy",
    maxConcurrentAgents: 2,
    maxDelegationDepth: 1,
    maxAutomaticRetries: 0,
    preferExistingAgents: true,
    autoDismissCompletedAgents: true,
    messageDetail: "compact",
    contextSharing: "minimal",
    idleTimeoutMinutes: 20,
    taskTimeoutMinutes: 45
  },
  standard: {
    id: "standard",
    maxConcurrentAgents: 4,
    maxDelegationDepth: 2,
    maxAutomaticRetries: 1,
    preferExistingAgents: true,
    autoDismissCompletedAgents: false,
    messageDetail: "balanced",
    contextSharing: "relevant",
    idleTimeoutMinutes: 30,
    taskTimeoutMinutes: 60
  },
  "high-performance": {
    id: "high-performance",
    maxConcurrentAgents: 6,
    maxDelegationDepth: 3,
    maxAutomaticRetries: 2,
    preferExistingAgents: false,
    autoDismissCompletedAgents: false,
    messageDetail: "detailed",
    contextSharing: "broad",
    idleTimeoutMinutes: 45,
    taskTimeoutMinutes: 90
  }
};

/** Maximum number of workers the Compazio may plan autonomously for one mission. */
export const AUTONOMY_WORKER_BUDGETS: Readonly<Record<ExecutionPolicyId, number>> = {
  economy: 1,
  standard: 2,
  "high-performance": 3
};

export function getExecutionPolicy(id: ExecutionPolicyId): ExecutionPolicy {
  return executionPolicySchema.parse(EXECUTION_POLICIES[id]);
}

export const orchestrationRunStatusSchema = z.enum([
  "created",
  "planning",
  "running",
  "waiting",
  "needs-attention",
  "paused",
  "completed",
  "failed",
  "cancelled"
]);
export type OrchestrationRunStatus = z.infer<typeof orchestrationRunStatusSchema>;

export const orchestrationTaskStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "waiting-input",
  "waiting-dependency",
  "completed",
  "failed",
  "cancelled"
]);
export type OrchestrationTaskStatus = z.infer<typeof orchestrationTaskStatusSchema>;

export const taskAttemptSchema = z
  .object({
    number: z.number().int().min(1),
    terminalId: idSchema.optional(),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    failure: structuredFailureSchema.optional()
  })
  .strict();
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

export const orchestrationRunSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    orchestratorTerminalId: idSchema,
    status: orchestrationRunStatusSchema,
    policyId: executionPolicyIdSchema,
    taskIds: z.array(idSchema),
    recruitedTerminalIds: z.array(idSchema),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    failure: structuredFailureSchema.optional()
  })
  .strict();
export type OrchestrationRun = z.infer<typeof orchestrationRunSchema>;

export const orchestrationTaskSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    title: z.string().trim().min(1).max(240),
    description: z.string().max(16_000).optional(),
    assignedTerminalId: idSchema.optional(),
    roleId: idSchema.optional(),
    status: orchestrationTaskStatusSchema,
    dependencyIds: z.array(idSchema),
    attempt: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(10),
    attempts: z.array(taskAttemptSchema),
    createdAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    failure: structuredFailureSchema.optional()
  })
  .strict();
export type OrchestrationTask = z.infer<typeof orchestrationTaskSchema>;

export const agentAssignmentSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    terminalId: idSchema,
    roleId: idSchema.optional(),
    taskIds: z.array(idSchema),
    recruitedByTerminalId: idSchema,
    createdAt: timestampSchema,
    releasedAt: timestampSchema.optional()
  })
  .strict();
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>;

export const teamRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(1_000).optional(),
    responsibilities: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32)
  })
  .strict();
export type TeamRole = z.infer<typeof teamRoleSchema>;

/** Explicit, non-inheritable authority that lets one worker recruit bounded children. */
export const teamMemberCapabilitySchema = z.enum(["recruit-limited"]);
export type TeamMemberCapability = z.infer<typeof teamMemberCapabilitySchema>;

/** Persisted with each TeamRun so a reload cannot silently change delegation limits. */
export const teamRecruitmentPolicySchema = z
  .object({
    maxDepth: z.number().int().min(0).max(8),
    maxActiveAgentsPerRun: z.number().int().min(1).max(12),
    maxChildrenPerAgent: z.number().int().min(1).max(8),
    maxTotalRecruitmentsPerRun: z.number().int().min(1).max(32)
  })
  .strict();
export type TeamRecruitmentPolicy = z.infer<typeof teamRecruitmentPolicySchema>;

export const BETA3_TEAM_RECRUITMENT_POLICY: TeamRecruitmentPolicy = {
  maxDepth: 2,
  maxActiveAgentsPerRun: 5,
  maxChildrenPerAgent: 2,
  maxTotalRecruitmentsPerRun: 8
};

/** A durable projection of a recruited terminal, intentionally without a process or MCP token. */
export const teamMemberSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    terminalId: idSchema,
    agentType: z.enum(["claude-code", "codex", "opencode"]),
    displayName: z.string().trim().min(1).max(240),
    role: teamRoleSchema,
    recruitedByTerminalId: idSchema,
    /** Nota markdown persistente criada e conectada exclusivamente para este integrante. */
    notebookNodeId: idSchema.optional(),
    runId: idSchema.optional(),
    parentTerminalId: idSchema.optional(),
    depth: z.number().int().min(1).max(8).default(1),
    grantedCapabilities: z.array(teamMemberCapabilitySchema).max(1).default([]),
    status: z.enum([
      "creating",
      "starting",
      "ready",
      "working",
      "waiting",
      "blocked",
      "completed",
      "failed",
      "dismissing",
      "dismissed"
    ]),
    idempotencyKey: z.string().trim().min(8).max(240).optional(),
    createdAt: timestampSchema,
    dismissedAt: timestampSchema.optional()
  })
  .strict();
export type TeamMember = z.infer<typeof teamMemberSchema>;

/**
 * A TeamRun is the durable, provider-neutral envelope for one Compazio execution.  It owns no
 * process handles or MCP state: those remain runtime-only and are deliberately rebuilt on start.
 */
export const teamRunStatusSchema = z.enum([
  "planning",
  "recruiting",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled"
]);
export type TeamRunStatus = z.infer<typeof teamRunStatusSchema>;

/** Immutable mission plan. Recruitment may retry, but it cannot redefine completion. */
export const teamRunMissionMemberSchema = z
  .object({
    agentType: z.enum(["claude-code", "codex", "opencode"]),
    displayName: z.string().trim().min(1).max(240),
    role: teamRoleSchema,
    grantRecruitLimited: z.boolean().default(false)
  })
  .strict();
export type TeamRunMissionMember = z.infer<typeof teamRunMissionMemberSchema>;

export const teamRunMissionTaskSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(16_000),
    assignedMemberName: z.string().trim().min(1).max(240),
    contextRefs: z.array(idSchema).max(32).optional(),
    dependsOn: z.array(z.string().trim().min(1).max(128)).max(3).default([]),
    reviewOf: z.string().trim().min(1).max(128).optional()
  })
  .strict();
export type TeamRunMissionTask = z.infer<typeof teamRunMissionTaskSchema>;

export const teamRunMissionContractSchema = z
  .object({
    requiredMembers: z.array(teamRunMissionMemberSchema).max(3).default([]),
    requiredTasks: z.array(teamRunMissionTaskSchema).max(10).default([]),
    requiresQa: z.boolean().default(false),
    requiresPortal: z.boolean().default(false)
  })
  .strict();
export type TeamRunMissionContract = z.infer<typeof teamRunMissionContractSchema>;

export const teamRunSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    compazioTerminalId: idSchema,
    title: z.string().trim().min(1).max(240),
    objective: z.string().trim().min(1).max(16_000),
    policyId: executionPolicyIdSchema.optional(),
    status: teamRunStatusSchema,
    missionContract: teamRunMissionContractSchema.default({
      requiredMembers: [],
      requiredTasks: [],
      requiresQa: false,
      requiresPortal: false
    }),
    memberIds: z.array(idSchema).max(BETA3_TEAM_RECRUITMENT_POLICY.maxTotalRecruitmentsPerRun),
    taskIds: z.array(idSchema).max(10),
    groupId: idSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(240).optional(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    cancelledAt: timestampSchema.optional(),
    recruitmentPolicy: teamRecruitmentPolicySchema.default(BETA3_TEAM_RECRUITMENT_POLICY)
  })
  .strict();
export type TeamRun = z.infer<typeof teamRunSchema>;

export const teamTaskStatusSchema = z.enum([
  "queued",
  "blocked",
  "assigned",
  "running",
  "waiting-for-user-input",
  "completed",
  "failed",
  "cancelled"
]);
export type TeamTaskStatus = z.infer<typeof teamTaskStatusSchema>;

/** Task shape used by the Compazio API.  Old orchestration tasks remain intact for Phase 4 history. */
export const teamTaskSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    runId: idSchema.optional(),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(16_000),
    status: teamTaskStatusSchema,
    createdByTerminalId: idSchema,
    assignedToTerminalId: idSchema.optional(),
    contextRefs: z.array(z.string().trim().min(1).max(1_024)).max(100),
    dependsOn: z.array(idSchema).max(3).default([]),
    blockedBy: z.array(idSchema).max(3).default([]),
    resultRefs: z.array(z.string().trim().min(1).max(1_024)).max(100).default([]),
    reviewOf: idSchema.optional(),
    attempt: z.number().int().min(1).max(10).default(1),
    maxAttempts: z.number().int().min(1).max(10).default(1),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    result: z
      .object({
        summary: z.string().trim().min(1).max(4_000),
        artifacts: z.array(z.string().trim().min(1).max(1_024)).max(100).optional()
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().trim().min(8).max(240).optional(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    failure: structuredFailureSchema.optional()
  })
  .strict();
export type TeamTask = z.infer<typeof teamTaskSchema>;

/** A worker can pause its task without opening a private human conversation in its terminal. */
export const teamUserInputRequestSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    runId: idSchema,
    taskId: idSchema,
    agentId: idSchema,
    compazioTerminalId: idSchema,
    question: z.string().trim().min(1).max(2_000),
    reason: z.string().trim().min(1).max(2_000),
    expectedAnswerType: z.enum(["text", "url", "number", "choice"]),
    context: z.string().trim().min(1).max(4_000).optional(),
    status: z.enum(["waiting-for-user-input", "answered", "cancelled"]),
    answer: z.string().trim().min(1).max(16_000).optional(),
    idempotencyKey: z.string().trim().min(8).max(240),
    createdAt: timestampSchema,
    answeredAt: timestampSchema.optional()
  })
  .strict();
export type TeamUserInputRequest = z.infer<typeof teamUserInputRequestSchema>;

export const teamMessageSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    fromTerminalId: idSchema,
    toTerminalId: idSchema,
    taskId: idSchema.optional(),
    correlationId: idSchema,
    idempotencyKey: z.string().trim().min(8).max(240),
    type: z.enum(["task", "progress", "result", "error", "system"]),
    /** Bounded text is retained for the recipient and audit trail; credentials are rejected by the service. */
    content: z.string().trim().min(1).max(16_000),
    status: z.enum(["queued", "delivering", "delivered", "acknowledged", "failed", "cancelled"]),
    attempt: z.number().int().min(1).max(3).default(1),
    maxAttempts: z.number().int().min(1).max(3).default(1),
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.optional(),
    acknowledgedAt: timestampSchema.optional()
  })
  .strict();
export type TeamMessage = z.infer<typeof teamMessageSchema>;
/** Compatibility alias for callers that have not yet adopted the team terminology. */
export const agentMessageSchema = teamMessageSchema;
export type AgentMessage = TeamMessage;

export const connectionActivityStatusSchema = z.enum([
  "queued",
  "sending",
  "delivered",
  "processing",
  "responded",
  "failed",
  "timed-out",
  "cancelled"
]);
export type ConnectionActivityStatus = z.infer<typeof connectionActivityStatusSchema>;

export const connectionActivitySchema = z
  .object({
    id: idSchema,
    runId: idSchema.optional(),
    edgeId: idSchema,
    sourceNodeId: idSchema,
    targetNodeId: idSchema,
    kind: z.enum(["task", "response", "note-read", "note-write", "control", "notification"]),
    status: connectionActivityStatusSchema,
    preview: z.string().max(280).optional(),
    attempt: z.number().int().min(1).default(1),
    correlationId: idSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    error: structuredFailureSchema.optional(),
    unread: z.boolean().default(true)
  })
  .strict();
export type ConnectionActivity = z.infer<typeof connectionActivitySchema>;

export const attentionRequestSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    runId: idSchema.optional(),
    terminalId: idSchema.optional(),
    severity: z.enum(["info", "warning", "blocking"]),
    type: z.enum([
      "permission",
      "question",
      "process-failure",
      "timeout",
      "missing-agent",
      "manual-review",
      "recovery",
      "unknown"
    ]),
    title: z.string().trim().min(1).max(240),
    description: z.string().max(2_000).optional(),
    status: z.enum(["open", "resolved", "dismissed"]),
    correlationId: idSchema,
    createdAt: timestampSchema,
    resolvedAt: timestampSchema.optional()
  })
  .strict();
export type AttentionRequest = z.infer<typeof attentionRequestSchema>;

export const runEventTypeSchema = z.enum([
  "run.created",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.recovery-required",
  "agent.recruited",
  "agent.started",
  "agent.stopped",
  "agent.failed",
  "agent.dismissed",
  "compazio.enabled",
  "compazio.disabled",
  "team.member.recruit.started",
  "team.member.recruited",
  "team.member.ready",
  "team.member.failed",
  "team.member.recruitment.released",
  "team.member.capabilities.updated",
  "team.member.dismiss.started",
  "team.member.dismissed",
  "team.run.created",
  "team.run.started",
  "team.run.blocked",
  "team.run.review",
  "team.run.completed",
  "team.run.cancelled",
  "team.connection.created",
  "team.connection.removed",
  "role.assigned",
  "task.created",
  "task.assigned",
  "task.started",
  "task.completed",
  "task.failed",
  "task.retried",
  "task.reassigned",
  "task.cancelled",
  "task.blocked",
  "message.sent",
  "message.delivered",
  "message.acknowledged",
  "message.failed",
  "team.cleanup.completed",
  "edge.created",
  "edge.activity",
  "note.created",
  "note.updated",
  "attention.created",
  "attention.resolved",
  "attention.dismissed",
  "policy.changed",
  "layout.organized",
  "notification.failed",
  "recovery.performed",
  "file-tree.created",
  "file.opened",
  "file.saved",
  "file.renamed",
  "file.moved",
  "file.deleted",
  "file.external-change",
  "file-preview.created",
  "file-preview.missing",
  "file-context.sent",
  "git.status.updated",
  "git.stage",
  "git.unstage",
  "git.commit",
  "git.fetch",
  "git.pull",
  "git.push",
  "git.checkout",
  "git.branch.created",
  "git.stash.created",
  "diff.opened",
  "diff.sent-to-agent"
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

const safeMetadataValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null()
]);
export const runEventSchema = z
  .object({
    id: idSchema,
    type: runEventTypeSchema,
    workspaceId: idSchema,
    runId: idSchema.optional(),
    actor: z.string().trim().min(1).max(128),
    target: z.string().trim().min(1).max(128),
    timestamp: timestampSchema,
    correlationId: idSchema,
    metadata: z.record(z.string().max(100), safeMetadataValueSchema),
    schemaVersion: z.literal(OPERATIONAL_SCHEMA_VERSION)
  })
  .strict();
export type RunEvent = z.infer<typeof runEventSchema>;

export const recoveryActionSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    runId: idSchema.optional(),
    taskId: idSchema.optional(),
    type: z.enum([
      "retry-task",
      "reassign-task",
      "restart-agent",
      "replace-agent",
      "cancel-task",
      "continue-manually",
      "recover-run"
    ]),
    idempotencyKey: z.string().trim().min(8).max(240),
    correlationId: idSchema,
    previousState: z.string().max(100),
    resultState: z.string().max(100),
    status: z.enum(["started", "completed", "failed"]),
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    failure: structuredFailureSchema.optional()
  })
  .strict();
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const teamLayoutSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    orchestratorTerminalId: idSchema,
    nodeIds: z.array(idSchema),
    manualNodeIds: z.array(idSchema),
    positions: z.record(idSchema, z.object({ x: z.number().finite(), y: z.number().finite() })),
    revision: z.number().int().min(1),
    updatedAt: timestampSchema
  })
  .strict();
export type TeamLayout = z.infer<typeof teamLayoutSchema>;

export const notificationPreferencesSchema = z
  .object({
    executionCompleted: z.boolean(),
    attentionRequired: z.boolean(),
    failures: z.boolean(),
    backgroundActivity: z.boolean()
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const defaultNotificationPreferences = (): NotificationPreferences => ({
  executionCompleted: true,
  attentionRequired: true,
  failures: true,
  backgroundActivity: false
});

export const workspaceOperationalStateSchema = z
  .object({
    schemaVersion: z.literal(OPERATIONAL_SCHEMA_VERSION),
    workspaceId: idSchema,
    policyId: executionPolicyIdSchema,
    runs: z.array(orchestrationRunSchema),
    tasks: z.array(orchestrationTaskSchema),
    assignments: z.array(agentAssignmentSchema),
    teamRuns: z.array(teamRunSchema).default([]),
    teamMembers: z.array(teamMemberSchema).default([]),
    teamTasks: z.array(teamTaskSchema).default([]),
    teamUserInputRequests: z.array(teamUserInputRequestSchema).default([]),
    messages: z.array(teamMessageSchema).default([]),
    activities: z.array(connectionActivitySchema),
    attention: z.array(attentionRequestSchema),
    events: z.array(runEventSchema),
    recoveryActions: z.array(recoveryActionSchema),
    teamLayouts: z.array(teamLayoutSchema),
    notificationPreferences: notificationPreferencesSchema,
    lastSelectedRunId: idSchema.optional(),
    updatedAt: timestampSchema
  })
  .strict();
export type WorkspaceOperationalState = z.infer<typeof workspaceOperationalStateSchema>;

export function createEmptyOperationalState(
  workspaceId: string,
  now: string
): WorkspaceOperationalState {
  return workspaceOperationalStateSchema.parse({
    schemaVersion: OPERATIONAL_SCHEMA_VERSION,
    workspaceId,
    policyId: "standard",
    runs: [],
    tasks: [],
    assignments: [],
    teamRuns: [],
    teamMembers: [],
    teamTasks: [],
    teamUserInputRequests: [],
    messages: [],
    activities: [],
    attention: [],
    events: [],
    recoveryActions: [],
    teamLayouts: [],
    notificationPreferences: defaultNotificationPreferences(),
    updatedAt: now
  });
}

const RUN_TRANSITIONS: Readonly<Record<OrchestrationRunStatus, readonly OrchestrationRunStatus[]>> =
  {
    created: ["planning", "cancelled"],
    planning: ["running", "needs-attention", "paused", "failed", "cancelled"],
    running: ["waiting", "needs-attention", "paused", "completed", "failed", "cancelled"],
    waiting: ["running", "needs-attention", "paused", "completed", "failed", "cancelled"],
    "needs-attention": ["running", "paused", "failed", "cancelled"],
    paused: ["running", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: []
  };

const TASK_TRANSITIONS: Readonly<
  Record<OrchestrationTaskStatus, readonly OrchestrationTaskStatus[]>
> = {
  queued: ["assigned", "cancelled"],
  assigned: ["running", "waiting-dependency", "cancelled"],
  running: ["waiting-input", "waiting-dependency", "completed", "failed", "cancelled"],
  "waiting-input": ["running", "failed", "cancelled"],
  "waiting-dependency": ["assigned", "running", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: []
};

export function transitionRun(
  run: OrchestrationRun,
  status: OrchestrationRunStatus,
  now: string,
  correlationId: string,
  failure?: StructuredFailure
): OrchestrationRun {
  if (!RUN_TRANSITIONS[run.status].includes(status)) {
    throw invalidTransition("execução", run.status, status, correlationId);
  }
  return orchestrationRunSchema.parse({
    ...run,
    status,
    updatedAt: now,
    ...(status === "completed" || status === "failed" || status === "cancelled"
      ? { completedAt: now }
      : {}),
    ...(failure === undefined ? {} : { failure })
  });
}

export function transitionTask(
  task: OrchestrationTask,
  status: OrchestrationTaskStatus,
  now: string,
  correlationId: string,
  failure?: StructuredFailure
): OrchestrationTask {
  if (!TASK_TRANSITIONS[task.status].includes(status)) {
    throw invalidTransition("tarefa", task.status, status, correlationId);
  }
  const startedAt = status === "running" && task.startedAt === undefined ? now : task.startedAt;
  return orchestrationTaskSchema.parse({
    ...task,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(status === "completed" || status === "failed" || status === "cancelled"
      ? { completedAt: now }
      : {}),
    ...(failure === undefined ? {} : { failure })
  });
}

export function sanitizeEventMetadata(
  metadata: Readonly<Record<string, unknown>>
): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/(token|secret|password|credential|prompt|stdout|content|path)/i.test(key)) continue;
    if (typeof value === "string") safe[key] = value.slice(0, 1_000);
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean" || value === null) safe[key] = value;
  }
  return safe;
}

export function retainOperationalHistory(
  state: WorkspaceOperationalState,
  limits: {
    readonly events?: number;
    readonly activities?: number;
    readonly messages?: number;
  } = {}
): WorkspaceOperationalState {
  const eventLimit = limits.events ?? 2_000;
  const activityLimit = limits.activities ?? 1_000;
  const messageLimit = limits.messages ?? 2_000;
  return workspaceOperationalStateSchema.parse({
    ...state,
    events: state.events.slice(-eventLimit),
    activities: state.activities.slice(-activityLimit),
    messages: state.messages.slice(-messageLimit)
  });
}

/** Migrates the compact operational document without modifying canvas persistence. */
export function migrateOperationalState(raw: unknown, now: string): WorkspaceOperationalState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Operational state must contain an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion === OPERATIONAL_SCHEMA_VERSION) {
    return workspaceOperationalStateSchema.parse(record);
  }
  if (
    record.schemaVersion === 1 ||
    record.schemaVersion === 2 ||
    record.schemaVersion === 3 ||
    record.schemaVersion === 4
  ) {
    const events = Array.isArray(record.events)
      ? record.events.map((event) => {
          if (typeof event !== "object" || event === null || Array.isArray(event)) return event;
          const entry = event as Record<string, unknown>;
          const renamed =
            typeof entry.type === "string" ? LEGACY_COORDINATOR_EVENT_TYPES[entry.type] : undefined;
          return {
            ...entry,
            ...(renamed === undefined ? {} : { type: renamed }),
            schemaVersion: OPERATIONAL_SCHEMA_VERSION
          };
        })
      : [];
    return workspaceOperationalStateSchema.parse({
      ...record,
      schemaVersion: OPERATIONAL_SCHEMA_VERSION,
      teamMembers: migrateTeamMembers(record.teamMembers, now),
      teamTasks: migrateTeamTasks(record.teamTasks, now),
      messages: migrateTeamMessages(record.messages, now),
      teamRuns: migrateTeamRuns(record.teamRuns, now),
      events,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now
    });
  }
  throw new Error(`Unsupported operational schema version: ${String(record.schemaVersion)}`);
}

function migrateTeamMembers(value: unknown, now: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((member) => {
    if (typeof member !== "object" || member === null || Array.isArray(member)) return member;
    const record = member as Record<string, unknown>;
    const base = withoutKeys(record, ["roleId", "recruitedBy"]);
    const legacyRoleId = typeof record.roleId === "string" ? record.roleId : undefined;
    return {
      ...base,
      agentType:
        record.agentType === "claude-code" ||
        record.agentType === "codex" ||
        record.agentType === "opencode"
          ? record.agentType
          : "codex",
      role:
        typeof record.role === "object" && record.role !== null
          ? record.role
          : {
              name: legacyRoleId ?? "Responsabilidade recrutada",
              responsibilities: ["Executar a tarefa atribuída e devolver um resultado estruturado."]
            },
      recruitedByTerminalId:
        typeof record.recruitedByTerminalId === "string"
          ? record.recruitedByTerminalId
          : record.recruitedBy,
      status: [
        "creating",
        "starting",
        "ready",
        "working",
        "waiting",
        "blocked",
        "completed",
        "failed",
        "dismissed"
      ].includes(String(record.status))
        ? record.status
        : "blocked",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
      ...(typeof record.dismissedAt === "string" ? { dismissedAt: record.dismissedAt } : {})
    };
  });
}

function migrateTeamTasks(value: unknown, now: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((task) => {
    if (typeof task !== "object" || task === null || Array.isArray(task)) return task;
    const record = task as Record<string, unknown>;
    const base = withoutKeys(record, [
      "runId",
      "priority",
      "createdBy",
      "assignedTo",
      "dependsOn",
      "resultRefs",
      "failure"
    ]);
    const assigned = Array.isArray(record.assignedTo) ? record.assignedTo[0] : undefined;
    const creator =
      typeof record.createdByTerminalId === "string"
        ? record.createdByTerminalId
        : record.createdBy;
    return {
      ...base,
      description:
        typeof record.description === "string" && record.description.trim() !== ""
          ? record.description
          : "Tarefa migrada.",
      ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
      status: [
        "queued",
        "blocked",
        "assigned",
        "running",
        "completed",
        "failed",
        "cancelled"
      ].includes(String(record.status))
        ? record.status
        : "queued",
      createdByTerminalId: creator,
      assignedToTerminalId:
        typeof record.assignedToTerminalId === "string" ? record.assignedToTerminalId : assigned,
      contextRefs: Array.isArray(record.contextRefs) ? record.contextRefs : [],
      dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn : [],
      blockedBy: Array.isArray(record.blockedBy) ? record.blockedBy : [],
      resultRefs: Array.isArray(record.resultRefs) ? record.resultRefs : [],
      attempt: typeof record.attempt === "number" ? record.attempt : 1,
      maxAttempts: typeof record.maxAttempts === "number" ? record.maxAttempts : 1,
      priority: ["low", "normal", "high"].includes(String(record.priority))
        ? record.priority
        : "normal",
      ...(typeof record.result === "object" && record.result !== null
        ? { result: record.result }
        : {}),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now
    };
  });
}

function migrateTeamMessages(value: unknown, now: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    const base = withoutKeys(record, ["connectionId", "attempt", "failure"]);
    const type = ["task", "progress", "result", "error", "system"].includes(String(record.type))
      ? record.type
      : "system";
    const status = [
      "queued",
      "delivering",
      "delivered",
      "acknowledged",
      "failed",
      "cancelled"
    ].includes(String(record.status))
      ? record.status
      : "failed";
    return {
      ...base,
      type,
      status,
      idempotencyKey:
        typeof record.idempotencyKey === "string"
          ? record.idempotencyKey
          : `migrated-${String(record.id ?? "message")}`,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now
    };
  });
}

function migrateTeamRuns(value: unknown, now: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((run) => {
    if (typeof run !== "object" || run === null || Array.isArray(run)) return run;
    const legacy = run as Record<string, unknown>;
    // v5 rename: the strict team-run schema rejects the legacy key, so drop it while carrying its value.
    const { [LEGACY_COORDINATOR_TERMINAL_ID]: legacyCompazioTerminalId, ...record } = legacy;
    return {
      ...record,
      compazioTerminalId: record.compazioTerminalId ?? legacyCompazioTerminalId,
      status: [
        "planning",
        "recruiting",
        "running",
        "blocked",
        "review",
        "completed",
        "failed",
        "cancelled"
      ].includes(String(record.status))
        ? record.status
        : "planning",
      memberIds: Array.isArray(record.memberIds) ? record.memberIds : [],
      taskIds: Array.isArray(record.taskIds) ? record.taskIds : [],
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now
    };
  });
}

function withoutKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function invalidTransition(
  entity: string,
  from: string,
  to: string,
  correlationId: string
): OperationalDomainError {
  return new OperationalDomainError({
    code: "ORCHESTRATION_INVALID_TRANSITION",
    message: `Não é possível mover esta ${entity} de ${from} para ${to}.`,
    technicalDetails: `${entity}:${from}->${to}`,
    suggestedAction: "Crie uma nova tentativa ou escolha uma ação compatível com o estado atual.",
    retryable: false,
    correlationId
  });
}
