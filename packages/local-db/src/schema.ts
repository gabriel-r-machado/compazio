import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const localIdentities = sqliteTable(
  "local_identities",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    subjectId: text("subject_id").notNull(),
    label: text("label").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" })
  },
  (table) => [uniqueIndex("local_identities_kind_subject_idx").on(table.kind, table.subjectId)]
);

export const localAuthSessions = sqliteTable(
  "local_auth_sessions",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => localIdentities.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" })
  },
  (table) => [
    index("local_auth_sessions_identity_active_idx").on(table.identityId, table.revokedAt),
    index("local_auth_sessions_expiry_idx").on(table.expiresAt)
  ]
);

export const localIdentityEvents = sqliteTable(
  "local_identity_events",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").references(() => localIdentities.id, {
      onDelete: "set null"
    }),
    actorIdentityId: text("actor_identity_id").references(() => localIdentities.id, {
      onDelete: "set null"
    }),
    type: text("type").notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("local_identity_events_identity_created_idx").on(table.identityId, table.createdAt)
  ]
);

/** Immutable authorization decisions; no path, command, executable, or SQL is stored here. */
export const policyDecisions = sqliteTable(
  "policy_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    canvasId: text("canvas_id"),
    actorNodeId: text("actor_node_id"),
    permission: text("permission").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("policy_decisions_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("policy_decisions_actor_created_idx").on(table.actorNodeId, table.createdAt)
  ]
);

/**
 * Immutable audit of supervised-autonomy decisions (batch E4). Context holds only sanitized
 * quota/state numbers and booleans; no path, command, executable, prompt or SQL is stored here.
 */
export const autonomyDecisions = sqliteTable(
  "autonomy_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    proposalId: text("proposal_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    rule: text("rule").notNull(),
    contextJson: text("context_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("autonomy_decisions_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("autonomy_decisions_run_created_idx").on(table.runId, table.createdAt)
  ]
);

/** Durable per-workspace global interrupt for supervised autonomy. */
export const autonomyControls = sqliteTable("autonomy_controls", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  killSwitch: integer("kill_switch").notNull().default(0),
  engagedBy: text("engaged_by"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const cloudSyncOutbox = sqliteTable(
  "cloud_sync_outbox",
  {
    eventKey: text("event_key").primaryKey(),
    eventJson: text("event_json").notNull(),
    state: text("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" })
  },
  (table) => [index("cloud_sync_outbox_state_idx").on(table.state, table.createdAt)]
);

export const runtimeSessions = sqliteTable("runtime_sessions", {
  id: text("id").primaryKey(),
  adapterId: text("adapter_id").notNull(),
  state: text("state").notNull(),
  cwd: text("cwd").notNull(),
  processId: integer("process_id"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  exitCode: integer("exit_code"),
  exitSignal: integer("exit_signal"),
  interruptionReason: text("interruption_reason")
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    rootPath: text("root_path").notNull(),
    canonicalRootPath: text("canonical_root_path").notNull(),
    defaultBranch: text("default_branch").notNull(),
    headCommit: text("head_commit").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [uniqueIndex("projects_canonical_root_idx").on(table.canonicalRootPath)]
);

export const managedWorktrees = sqliteTable(
  "managed_worktrees",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    taskTitle: text("task_title").notNull(),
    branchName: text("branch_name").notNull(),
    path: text("path").notNull(),
    baseRef: text("base_ref").notNull(),
    baseCommit: text("base_commit").notNull(),
    state: text("state").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("managed_worktrees_project_branch_idx").on(table.projectId, table.branchName),
    uniqueIndex("managed_worktrees_path_idx").on(table.path),
    index("managed_worktrees_project_state_idx").on(table.projectId, table.state)
  ]
);

export const worktreeLeases = sqliteTable(
  "worktree_leases",
  {
    id: text("id").primaryKey(),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => managedWorktrees.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [uniqueIndex("worktree_leases_worktree_idx").on(table.worktreeId)]
);

export const projectLeases = sqliteTable(
  "project_leases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [uniqueIndex("project_leases_project_idx").on(table.projectId)]
);

/** A durable ownership lease for the single Compasso Runtime serving a local project. */
export const runtimeProjectLeases = sqliteTable(
  "runtime_project_leases",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [index("runtime_project_leases_owner_idx").on(table.ownerId)]
);

export const runtimeLifecycleState = sqliteTable("runtime_lifecycle_state", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const runtimeLifecycleCommands = sqliteTable(
  "runtime_lifecycle_commands",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    requestedBy: text("requested_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code")
  },
  (table) => [index("runtime_lifecycle_commands_pending_idx").on(table.status, table.createdAt)]
);

/** Redacted lifecycle audit log; it intentionally stores no process, path or command data. */
export const runtimeLifecycleEvents = sqliteTable(
  "runtime_lifecycle_events",
  {
    id: text("id").primaryKey(),
    commandId: text("command_id").references(() => runtimeLifecycleCommands.id, {
      onDelete: "set null"
    }),
    action: text("action").notNull(),
    state: text("state").notNull(),
    outcome: text("outcome").notNull(),
    actor: text("actor").notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [index("runtime_lifecycle_events_created_idx").on(table.createdAt)]
);

export const qualityGateRuns = sqliteTable(
  "quality_gate_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => managedWorktrees.id, { onDelete: "cascade" }),
    presetId: text("preset_id").notNull(),
    state: text("state").notNull(),
    executableName: text("executable_name").notNull(),
    argsJson: text("args_json").notNull(),
    headCommit: text("head_commit").notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    timedOut: integer("timed_out", { mode: "boolean" }).notNull(),
    outputSummary: text("output_summary").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" })
  },
  (table) => [
    index("quality_gate_runs_worktree_idx").on(table.worktreeId, table.startedAt),
    index("quality_gate_runs_state_idx").on(table.state)
  ]
);

export const qualityGateProcesses = sqliteTable("quality_gate_processes", {
  gateRunId: text("gate_run_id")
    .primaryKey()
    .references(() => qualityGateRuns.id, { onDelete: "cascade" }),
  worktreeId: text("worktree_id")
    .notNull()
    .references(() => managedWorktrees.id, { onDelete: "cascade" }),
  processId: integer("process_id").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull()
});

export const mergePlans = sqliteTable(
  "merge_plans",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => managedWorktrees.id, { onDelete: "cascade" }),
    sourceBranch: text("source_branch").notNull(),
    targetBranch: text("target_branch").notNull(),
    sourceHead: text("source_head").notNull(),
    targetHead: text("target_head").notNull(),
    confirmationTokenHash: text("confirmation_token_hash"),
    conflictedFilesJson: text("conflicted_files_json").notNull(),
    requiredGateRunIdsJson: text("required_gate_run_ids_json").notNull(),
    state: text("state").notNull(),
    eligible: integer("eligible", { mode: "boolean" }).notNull(),
    issuesJson: text("issues_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    mergeCommit: text("merge_commit"),
    error: text("error")
  },
  (table) => [index("merge_plans_project_state_idx").on(table.projectId, table.state)]
);

export const deliveryReports = sqliteTable(
  "delivery_reports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => managedWorktrees.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    markdown: text("markdown").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [index("delivery_reports_worktree_idx").on(table.worktreeId, table.createdAt)]
);

export const canvases = sqliteTable("canvases", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mission: text("mission").notNull().default(""),
  creationMode: text("creation_mode").notNull().default("manual"),
  executionProfile: text("execution_profile").notNull().default("balanced"),
  revision: integer("revision").notNull().default(0),
  viewportJson: text("viewport_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    isOpen: integer("is_open", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspaces_canvas_idx").on(table.canvasId),
    index("workspaces_project_idx").on(table.projectId),
    index("workspaces_open_position_idx").on(table.isOpen, table.position)
  ]
);

/** Append-only identity packs derived from the agent node's configured role and permissions. */
export const agentProfiles = sqliteTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    version: integer("version").notNull(),
    identity: text("identity").notNull(),
    adapterId: text("adapter_id").notNull(),
    responsibilities: text("responsibilities").notNull(),
    limits: text("limits").notNull(),
    capabilitiesJson: text("capabilities_json").notNull(),
    expectedDeliverablesJson: text("expected_deliverables_json").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("agent_profiles_workspace_node_version_idx").on(
      table.workspaceId,
      table.nodeId,
      table.version
    ),
    index("agent_profiles_workspace_node_created_idx").on(
      table.workspaceId,
      table.nodeId,
      table.createdAt
    )
  ]
);

/** Immutable mission versions; the current canvas mission remains the compatibility projection. */
export const missions = sqliteTable(
  "missions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    objective: text("objective").notNull(),
    scopeJson: text("scope_json").notNull(),
    decisionsJson: text("decisions_json").notNull(),
    constraintsJson: text("constraints_json").notNull(),
    progress: text("progress").notNull(),
    blockersJson: text("blockers_json").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("missions_workspace_version_idx").on(table.workspaceId, table.version),
    index("missions_workspace_created_idx").on(table.workspaceId, table.createdAt)
  ]
);

/** Append-only project conventions used to build reproducible local execution context. */
export const workspaceMemories = sqliteTable(
  "workspace_memories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    stackJson: text("stack_json").notNull(),
    architecture: text("architecture").notNull(),
    patternsJson: text("patterns_json").notNull(),
    commandsJson: text("commands_json").notNull(),
    conventionsJson: text("conventions_json").notNull(),
    technicalDecisionsJson: text("technical_decisions_json").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspace_memories_workspace_version_idx").on(table.workspaceId, table.version),
    index("workspace_memories_workspace_created_idx").on(table.workspaceId, table.createdAt)
  ]
);

/** Versioned delivery interfaces; verification adds a version rather than altering evidence in place. */
export const deliveryContracts = sqliteTable(
  "delivery_contracts",
  {
    id: text("id").primaryKey(),
    contractId: text("contract_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    version: integer("version").notNull(),
    inputsJson: text("inputs_json").notNull(),
    outputsJson: text("outputs_json").notNull(),
    completionCriteriaJson: text("completion_criteria_json").notNull(),
    declaredEvidenceJson: text("declared_evidence_json").notNull(),
    verifiedEvidenceJson: text("verified_evidence_json").notNull(),
    state: text("state").notNull(),
    limitsJson: text("limits_json").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("delivery_contracts_route_version_idx").on(
      table.workspaceId,
      table.sourceNodeId,
      table.targetNodeId,
      table.contractId,
      table.version
    ),
    uniqueIndex("delivery_contracts_contract_version_idx").on(table.contractId, table.version),
    index("delivery_contracts_workspace_created_idx").on(table.workspaceId, table.createdAt)
  ]
);

/** Immutable effective contexts and lifecycle checkpoints consumed by future execution services. */
export const executionContextSnapshots = sqliteTable(
  "execution_context_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentNodeId: text("agent_node_id").notNull(),
    task: text("task").notNull(),
    contractId: text("contract_id"),
    payloadJson: text("payload_json").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("execution_context_snapshots_workspace_agent_created_idx").on(
      table.workspaceId,
      table.agentNodeId,
      table.createdAt
    ),
    index("execution_context_snapshots_contract_idx").on(table.contractId, table.createdAt)
  ]
);

export const executionCheckpoints = sqliteTable(
  "execution_checkpoints",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentNodeId: text("agent_node_id").notNull(),
    type: text("type").notNull(),
    task: text("task").notNull(),
    contractId: text("contract_id"),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => executionContextSnapshots.id, { onDelete: "restrict" }),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("execution_checkpoints_workspace_agent_created_idx").on(
      table.workspaceId,
      table.agentNodeId,
      table.createdAt
    ),
    index("execution_checkpoints_snapshot_idx").on(table.snapshotId)
  ]
);

export const canvasNodes = sqliteTable(
  "canvas_nodes",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    type: text("type").notNull(),
    positionX: real("position_x").notNull(),
    positionY: real("position_y").notNull(),
    width: real("width"),
    height: real("height"),
    zIndex: integer("z_index"),
    dataJson: text("data_json").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.id] }),
    index("canvas_nodes_canvas_idx").on(table.canvasId)
  ]
);

export const canvasEdges = sqliteTable(
  "canvas_edges",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    contractJson: text("contract_json").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.id] }),
    index("canvas_edges_canvas_idx").on(table.canvasId),
    foreignKey({
      columns: [table.canvasId, table.sourceNodeId],
      foreignColumns: [canvasNodes.canvasId, canvasNodes.id]
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.canvasId, table.targetNodeId],
      foreignColumns: [canvasNodes.canvasId, canvasNodes.id]
    }).onDelete("cascade")
  ]
);

export const agentEndpoints = sqliteTable(
  "agent_endpoints",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => runtimeSessions.id, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    state: text("state").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.nodeId] }),
    uniqueIndex("agent_endpoints_session_idx").on(table.sessionId),
    index("agent_endpoints_state_idx").on(table.state, table.updatedAt),
    foreignKey({
      columns: [table.canvasId, table.nodeId],
      foreignColumns: [canvasNodes.canvasId, canvasNodes.id]
    }).onDelete("cascade")
  ]
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    recipientNodeId: text("recipient_node_id").notNull(),
    senderNodeId: text("sender_node_id"),
    content: text("content").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    attempt: integer("attempt").notNull().default(0),
    sessionId: text("session_id"),
    adapterId: text("adapter_id"),
    errorCode: text("error_code"),
    /**
     * Set when the sender is blocked on `ask --wait`. The answer then reaches it as that command's
     * output, so recording the response must not also enqueue a delivery into its terminal — the
     * waiting agent would read that second copy as a new instruction.
     */
    awaitedBySender: integer("awaited_by_sender").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" })
  },
  (table) => [
    uniqueIndex("agent_messages_workspace_idempotency_idx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index("agent_messages_delivery_idx").on(table.status, table.createdAt),
    index("agent_messages_recipient_idx").on(
      table.workspaceId,
      table.recipientNodeId,
      table.createdAt
    )
  ]
);

export const agentMessageResponses = sqliteTable(
  "agent_message_responses",
  {
    id: text("id").primaryKey(),
    requestMessageId: text("request_message_id")
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    responderNodeId: text("responder_node_id").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveryMessageId: text("delivery_message_id").references(() => agentMessages.id, {
      onDelete: "set null"
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("agent_message_responses_idempotency_idx").on(
      table.requestMessageId,
      table.idempotencyKey
    ),
    index("agent_message_responses_workspace_idx").on(table.workspaceId, table.createdAt),
    index("agent_message_responses_request_idx").on(table.requestMessageId, table.createdAt)
  ]
);

export const agentSpawns = sqliteTable(
  "agent_spawns",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    adapterId: text("adapter_id").notNull(),
    roleName: text("role_name").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    requestedByNodeId: text("requested_by_node_id"),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    attempt: integer("attempt").notNull().default(0),
    sessionId: text("session_id").references(() => runtimeSessions.id, {
      onDelete: "set null"
    }),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("agent_spawns_workspace_idempotency_idx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    uniqueIndex("agent_spawns_workspace_name_idx").on(table.workspaceId, table.normalizedName),
    uniqueIndex("agent_spawns_workspace_node_idx").on(table.workspaceId, table.nodeId),
    index("agent_spawns_status_idx").on(table.status, table.createdAt),
    index("agent_spawns_workspace_idx").on(table.workspaceId, table.createdAt)
  ]
);

export const agentSpawnEvents = sqliteTable(
  "agent_spawn_events",
  {
    id: text("id").primaryKey(),
    spawnId: text("spawn_id")
      .notNull()
      .references(() => agentSpawns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    detailJson: text("detail_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("agent_spawn_events_sequence_idx").on(table.spawnId, table.sequence),
    index("agent_spawn_events_spawn_idx").on(table.spawnId, table.createdAt)
  ]
);

export const workspaceNotes = sqliteTable(
  "workspace_notes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    revision: integer("revision").notNull(),
    createdByNodeId: text("created_by_node_id"),
    createIdempotencyKey: text("create_idempotency_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspace_notes_workspace_create_idempotency_idx").on(
      table.workspaceId,
      table.createIdempotencyKey
    ),
    uniqueIndex("workspace_notes_workspace_node_idx").on(table.workspaceId, table.nodeId),
    index("workspace_notes_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    index("workspace_notes_canvas_idx").on(table.canvasId, table.updatedAt)
  ]
);

export const workspaceNoteEvents = sqliteTable(
  "workspace_note_events",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => workspaceNotes.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    contentHash: text("content_hash").notNull(),
    projectionState: text("projection_state").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspace_note_events_sequence_idx").on(table.noteId, table.sequence),
    uniqueIndex("workspace_note_events_idempotency_idx").on(table.noteId, table.idempotencyKey),
    index("workspace_note_events_projection_idx").on(table.projectionState, table.createdAt)
  ]
);

export const workspaceConnectionEvents = sqliteTable(
  "workspace_connection_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    edgeId: text("edge_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    contractJson: text("contract_json").notNull(),
    eventType: text("event_type").notNull(),
    actorNodeId: text("actor_node_id"),
    canvasRevision: integer("canvas_revision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    projectionState: text("projection_state").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspace_connection_events_idempotency_idx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index("workspace_connection_events_edge_type_idx").on(
      table.canvasId,
      table.edgeId,
      table.eventType,
      table.createdAt
    ),
    index("workspace_connection_events_projection_idx").on(table.projectionState, table.createdAt),
    index("workspace_connection_events_canvas_idx").on(table.canvasId, table.createdAt)
  ]
);

export const workspaceArtifacts = sqliteTable(
  "workspace_artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sourceRelativePath: text("source_relative_path").notNull(),
    relativePath: text("relative_path").notNull(),
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    mediaType: text("media_type").notNull(),
    publishedByNodeId: text("published_by_node_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspace_artifacts_idempotency_idx").on(table.workspaceId, table.idempotencyKey),
    index("workspace_artifacts_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("workspace_artifacts_project_created_idx").on(table.projectId, table.createdAt)
  ]
);

/** Immutable metadata versions for a published artifact; bytes stay in the artifact registry. */
export const artifactMemories = sqliteTable(
  "artifact_memories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => workspaceArtifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    origin: text("origin").notNull(),
    sha256: text("sha256").notNull(),
    relationshipsJson: text("relationships_json").notNull(),
    relevance: text("relevance").notNull(),
    status: text("status").notNull(),
    restoredFromVersion: integer("restored_from_version"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("artifact_memories_workspace_artifact_version_idx").on(
      table.workspaceId,
      table.artifactId,
      table.version
    ),
    index("artifact_memories_workspace_artifact_created_idx").on(
      table.workspaceId,
      table.artifactId,
      table.createdAt
    )
  ]
);

/** Local review feedback bound to one immutable artifact-memory revision. */
export const artifactFeedback = sqliteTable(
  "artifact_feedback",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => workspaceArtifacts.id, { onDelete: "cascade" }),
    artifactVersion: integer("artifact_version").notNull(),
    content: text("content").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("artifact_feedback_workspace_artifact_version_created_idx").on(
      table.workspaceId,
      table.artifactId,
      table.artifactVersion,
      table.createdAt
    )
  ]
);

/**
 * Metadata-only index of direct canvas context. Source content remains in the authoritative canvas
 * or published-artifact store; this table keeps only hashes, bounded sizes and chunk boundaries.
 */
export const contextSourceIndexes = sqliteTable(
  "context_source_indexes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id").notNull(),
    type: text("type").notNull(),
    origin: text("origin").notNull(),
    version: integer("version").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    inclusion: text("inclusion").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("context_source_indexes_workspace_source_hash_idx").on(
      table.workspaceId,
      table.sourceNodeId,
      table.sourceSha256
    ),
    uniqueIndex("context_source_indexes_workspace_source_version_idx").on(
      table.workspaceId,
      table.sourceNodeId,
      table.version
    ),
    index("context_source_indexes_workspace_created_idx").on(table.workspaceId, table.createdAt)
  ]
);

export const contextIndexChunks = sqliteTable(
  "context_index_chunks",
  {
    id: text("id").primaryKey(),
    indexId: text("index_id")
      .notNull()
      .references(() => contextSourceIndexes.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    estimatedTokens: integer("estimated_tokens").notNull()
  },
  (table) => [
    uniqueIndex("context_index_chunks_index_ordinal_idx").on(table.indexId, table.ordinal),
    index("context_index_chunks_index_idx").on(table.indexId)
  ]
);

/** Deterministic selection cache. It contains no source bytes and is invalidated by index hash. */
export const contextSelectionCaches = sqliteTable(
  "context_selection_caches",
  {
    cacheKey: text("cache_key").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentNodeId: text("agent_node_id").notNull(),
    mode: text("mode").notNull(),
    sourceIndexSha256: text("source_index_sha256").notNull(),
    selectionJson: text("selection_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("context_selection_caches_workspace_agent_created_idx").on(
      table.workspaceId,
      table.agentNodeId,
      table.createdAt
    )
  ]
);

export const workspaceArtifactEvents = sqliteTable(
  "workspace_artifact_events",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => workspaceArtifacts.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    projectionState: text("projection_state").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workspace_artifact_events_sequence_idx").on(table.artifactId, table.sequence),
    index("workspace_artifact_events_artifact_idx").on(table.artifactId, table.createdAt),
    index("workspace_artifact_events_projection_idx").on(table.projectionState, table.createdAt)
  ]
);

export const agentMessageEvents = sqliteTable(
  "agent_message_events",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    detailJson: text("detail_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("agent_message_events_sequence_idx").on(table.messageId, table.sequence),
    index("agent_message_events_message_idx").on(table.messageId, table.createdAt)
  ]
);

export const canvasHandoffs = sqliteTable(
  "canvas_handoffs",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    revision: integer("revision").notNull().default(1),
    mission: text("mission").notNull(),
    sourceJson: text("source_json").notNull(),
    targetJson: text("target_json").notNull(),
    edgeJson: text("edge_json").notNull(),
    contentJson: text("content_json").notNull(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    readyAt: integer("ready_at", { mode: "timestamp_ms" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" })
  },
  (table) => [
    index("canvas_handoffs_canvas_updated_idx").on(table.canvasId, table.updatedAt),
    index("canvas_handoffs_status_idx").on(table.status)
  ]
);

export const canvasHandoffEvents = sqliteTable(
  "canvas_handoff_events",
  {
    id: text("id").primaryKey(),
    handoffId: text("handoff_id")
      .notNull()
      .references(() => canvasHandoffs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    error: text("error"),
    deliveryAttemptId: text("delivery_attempt_id"),
    responsible: text("responsible").notNull().default("system"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("canvas_handoff_events_sequence_idx").on(table.handoffId, table.sequence),
    index("canvas_handoff_events_handoff_idx").on(table.handoffId, table.createdAt)
  ]
);

export const canvasHandoffDeliveryAttempts = sqliteTable(
  "canvas_handoff_delivery_attempts",
  {
    id: text("id").primaryKey(),
    handoffId: text("handoff_id")
      .notNull()
      .references(() => canvasHandoffs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    targetSessionId: text("target_session_id"),
    adapterId: text("adapter_id"),
    status: text("status").notNull(),
    confirmation: text("confirmation"),
    error: text("error"),
    responsible: text("responsible").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("canvas_handoff_delivery_attempts_sequence_idx").on(
      table.handoffId,
      table.sequence
    ),
    index("canvas_handoff_delivery_attempts_handoff_idx").on(table.handoffId, table.createdAt)
  ]
);

export const workflowDefinitions = sqliteTable(
  "workflow_definitions",
  {
    id: text("id").notNull(),
    version: text("version").notNull(),
    name: text("name").notNull(),
    definitionJson: text("definition_json").notNull(),
    definitionHash: text("definition_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })]
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    workflowVersion: text("workflow_version").notNull(),
    workflowHash: text("workflow_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    workflowSnapshotJson: text("workflow_snapshot_json").notNull(),
    effectivePermissionsJson: text("effective_permissions_json").notNull(),
    state: text("state").notNull(),
    dryRun: integer("dry_run", { mode: "boolean" }).notNull(),
    concurrency: integer("concurrency").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    retryOfRunId: text("retry_of_run_id"),
    retryNodeId: text("retry_node_id"),
    retryScope: text("retry_scope"),
    alternativeGroupId: text("alternative_group_id"),
    alternativeLabel: text("alternative_label"),
    /** Immutable, redacted checkpoint references; full context is held separately. */
    executionContextJson: text("execution_context_json"),
    reportArtifactId: text("report_artifact_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("workflow_runs_state_idx").on(table.state),
    index("workflow_runs_workflow_idx").on(table.workflowId),
    index("workflow_runs_alternative_group_idx").on(table.alternativeGroupId, table.createdAt)
  ]
);

export const workflowNodeRuns = sqliteTable(
  "workflow_node_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text("node_id").notNull(),
    state: text("state").notNull(),
    attempt: integer("attempt").notNull(),
    inputHash: text("input_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    failureReason: text("failure_reason"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workflow_node_runs_run_node_idx").on(table.runId, table.nodeId),
    uniqueIndex("workflow_node_runs_idempotency_idx").on(table.idempotencyKey),
    index("workflow_node_runs_state_idx").on(table.runId, table.state)
  ]
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeRunId: text("node_run_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    schemaVersion: text("schema_version").notNull(),
    payloadJson: text("payload_json").notNull()
  },
  (table) => [
    uniqueIndex("run_events_run_sequence_idx").on(table.runId, table.sequence),
    index("run_events_node_idx").on(table.nodeRunId)
  ]
);

/** Typed, auditable manual controls consumed only by the desktop-owned scheduler. */
export const workflowRunCommands = sqliteTable(
  "workflow_run_commands",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    runId: text("run_id"),
    workspaceId: text("workspace_id"),
    agentNodeId: text("agent_node_id"),
    task: text("task"),
    contractId: text("contract_id"),
    nodeId: text("node_id"),
    retryScope: text("retry_scope"),
    alternativeLabel: text("alternative_label"),
    templateId: text("template_id"),
    contextMode: text("context_mode"),
    dryRun: integer("dry_run", { mode: "boolean" }),
    decisionNote: text("decision_note"),
    requestedBy: text("requested_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
    resultRunId: text("result_run_id"),
    errorCode: text("error_code")
  },
  (table) => [
    index("workflow_run_commands_status_created_idx").on(table.status, table.createdAt, table.id),
    index("workflow_run_commands_run_created_idx").on(table.runId, table.createdAt),
    index("workflow_run_commands_workspace_created_idx").on(table.workspaceId, table.createdAt)
  ]
);

export const workflowRunCommandEvents = sqliteTable(
  "workflow_run_command_events",
  {
    id: text("id").primaryKey(),
    commandId: text("command_id")
      .notNull()
      .references(() => workflowRunCommands.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    actor: text("actor").notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("workflow_run_command_events_command_created_idx").on(table.commandId, table.createdAt)
  ]
);

export const workflowRunTargets = sqliteTable(
  "workflow_run_targets",
  {
    runId: text("run_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    agentNodeId: text("agent_node_id"),
    /** Opaque managed worktree binding; the filesystem path remains runtime-private. */
    worktreeId: text("worktree_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("workflow_run_targets_project_created_idx").on(table.projectId, table.createdAt),
    index("workflow_run_targets_workspace_agent_idx").on(table.workspaceId, table.agentNodeId),
    index("workflow_run_targets_worktree_idx").on(table.worktreeId)
  ]
);

export const orchestrationProposals = sqliteTable(
  "orchestration_proposals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    autonomyLevel: text("autonomy_level").notNull(),
    proposalJson: text("proposal_json").notNull(),
    checksum: text("checksum").notNull(),
    revision: integer("revision").notNull(),
    createdBy: text("created_by").notNull(),
    reviewedBy: text("reviewed_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    rejectedAt: integer("rejected_at", { mode: "timestamp_ms" })
  },
  (table) => [
    index("orchestration_proposals_workspace_updated_idx").on(table.workspaceId, table.updatedAt)
  ]
);

export const orchestrationProposalEvents = sqliteTable(
  "orchestration_proposal_events",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => orchestrationProposals.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    detailsJson: text("details_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("orchestration_proposal_events_sequence_idx").on(table.proposalId, table.sequence),
    index("orchestration_proposal_events_proposal_created_idx").on(
      table.proposalId,
      table.createdAt
    )
  ]
);

export const workflowDrafts = sqliteTable(
  "workflow_drafts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    sourceTerminalId: text("source_terminal_id").notNull(),
    state: text("state").notNull(),
    creationMode: text("creation_mode").notNull(),
    executionProfile: text("execution_profile").notNull(),
    version: integer("version").notNull(),
    draftJson: text("draft_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("workflow_drafts_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    index("workflow_drafts_terminal_updated_idx").on(table.sourceTerminalId, table.updatedAt)
  ]
);

export const workflowDraftEvents = sqliteTable(
  "workflow_draft_events",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => workflowDrafts.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    summary: text("summary").notNull(),
    rejectionReason: text("rejection_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("workflow_draft_events_sequence_idx").on(table.draftId, table.sequence),
    index("workflow_draft_events_draft_created_idx").on(table.draftId, table.createdAt)
  ]
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeRunId: text("node_run_id"),
    type: text("type").notNull(),
    relativePath: text("relative_path").notNull(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [index("artifacts_run_idx").on(table.runId)]
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeRunId: text("node_run_id").notNull(),
    state: text("state").notNull(),
    decisionNote: text("decision_note"),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" })
  },
  (table) => [
    uniqueIndex("approvals_run_node_idx").on(table.runId, table.nodeRunId),
    index("approvals_state_idx").on(table.state)
  ]
);

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    fromNodeRunId: text("from_node_run_id").notNull(),
    toNodeRunId: text("to_node_run_id").notNull(),
    handoffJson: text("handoff_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [index("handoffs_run_idx").on(table.runId)]
);
