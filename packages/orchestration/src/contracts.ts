import type {
  ArtifactReference,
  Evidence,
  PermissionMap,
  RetryReason,
  Workflow,
  WorkflowNode
} from "@forgedeck/workflow";

export type RunState =
  | "created"
  | "running"
  | "paused"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type NodeRunState =
  | "pending"
  | "ready"
  | "starting"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped";

export type NonRetryableFailureReason =
  | "approval_denied"
  | "permission_denied"
  | "schema_invalid"
  | "destructive_action_denied"
  | "missing_evidence"
  | "unknown_error";

export type NodeFailureReason = RetryReason | NonRetryableFailureReason;

export interface NodeExecutionContext {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attempt: number;
  readonly workflowVersion: string;
  readonly grantedPermissions: PermissionMap;
  /** Aborts only the current run; executors must stop their own process cooperatively. */
  readonly abortSignal: AbortSignal;
}

export type NodeExecutionResult =
  | {
      readonly success: true;
      readonly evidence: readonly Evidence[];
      readonly output: Readonly<Record<string, unknown>>;
    }
  | {
      readonly success: false;
      readonly reason: NodeFailureReason;
      readonly message: string;
      readonly evidence: readonly Evidence[];
    };

export interface WorkflowNodeExecutor {
  execute(node: WorkflowNode, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export interface ResourceLockManager {
  acquire(resources: readonly string[], ownerId: string): Promise<() => void>;
}

export interface RunEvent {
  readonly id: string;
  readonly runId: string;
  readonly nodeRunId: string | null;
  readonly type: RunEventType;
  readonly timestamp: string;
  readonly schemaVersion: "1.0";
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.cancelled"
  | "run.completed"
  | "run.failed"
  | "run.interrupted"
  | "node.ready"
  | "node.started"
  | "node.waiting"
  | "node.blocked"
  | "node.succeeded"
  | "node.failed"
  | "node.cancelled"
  | "node.retry_scheduled"
  | "approval.requested"
  | "approval.resolved"
  | "artifact.created"
  | "handoff.created"
  | "report.created";

export interface NodeRunSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly state: NodeRunState;
  readonly attempt: number;
  readonly inputHash: string;
  readonly idempotencyKey: string;
  readonly evidence: readonly Evidence[];
  readonly failureReason: NodeFailureReason | null;
}

export interface WorkflowRunSnapshot {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowHash: string;
  readonly inputHash: string;
  readonly effectivePermissions: PermissionMap;
  readonly state: RunState;
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Immutable lineage for a manual retry or alternative branch. */
  readonly lineage?: WorkflowRunLineage | null;
  /**
   * Immutable, redacted references to the context packs used for this execution. The full packs
   * remain in the local context store; workflow consumers receive identifiers, versions and hashes
   * only.
   */
  readonly executionContext?: WorkflowRunExecutionContext | null;
  readonly nodeRuns: readonly NodeRunSnapshot[];
  readonly reportArtifact: ArtifactReference | null;
}

export interface WorkflowRunLineage {
  readonly sourceRunId: string;
  readonly nodeId: string | null;
  readonly scope: "run" | "node" | "dependents";
  readonly alternativeGroupId: string | null;
  readonly alternativeLabel: string | null;
}

export interface WorkflowExecutionCheckpointReference {
  readonly checkpointId: string;
  readonly snapshotId: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface WorkflowRunExecutionContext {
  readonly workspaceId: string;
  readonly agentNodeId: string;
  readonly task: string;
  readonly contractId: string | null;
  readonly profileVersion: number;
  readonly missionVersion: number | null;
  readonly memoryVersion: number | null;
  readonly contractVersion: number | null;
  /** The deterministic context-selection mode used by the immutable function checkpoint. */
  readonly contextMode?: "full" | "intelligent" | "economical" | undefined;
  readonly contextSelectionSha256?: string | undefined;
  readonly estimatedContextTokens?: number | undefined;
  /** Null until an adapter/provider reports measured usage. */
  readonly actualContextTokens?: number | null | undefined;
  readonly contextCostStatus?: "estimated" | "reported" | undefined;
  readonly functionCheckpoint: WorkflowExecutionCheckpointReference;
  readonly deliveryCheckpoint: WorkflowExecutionCheckpointReference | null;
}

/** Runtime-only lifecycle hook. It is intentionally never persisted or exposed to IPC. */
export interface WorkflowRunExecutionContextLifecycle {
  readonly context: WorkflowRunExecutionContext;
  readonly createDeliveryCheckpoint: () => Promise<WorkflowExecutionCheckpointReference>;
}

export interface RunStore {
  createRun(snapshot: WorkflowRunSnapshot, workflow: Workflow, event: RunEvent): Promise<void>;
  saveRun(snapshot: WorkflowRunSnapshot): Promise<void>;
  saveRunWithEvent(snapshot: WorkflowRunSnapshot, event: RunEvent): Promise<void>;
  saveNodeRun(snapshot: NodeRunSnapshot): Promise<void>;
  saveNodeRunWithEvent(snapshot: NodeRunSnapshot, event: RunEvent): Promise<void>;
  appendEvent(event: RunEvent): Promise<void>;
}

export interface FinalReportInput {
  readonly run: WorkflowRunSnapshot;
  readonly workflow: Workflow;
  readonly events: readonly RunEvent[];
}

export interface ArtifactRegistry {
  createFinalReport(input: FinalReportInput): Promise<ArtifactReference>;
}

/** Automatic scheduler actions that must be assessed by the supervised-autonomy guardrail. */
export type AutonomyGateAction = "continue_approved_step" | "spawn_agent" | "retry_node";
export type AutonomyGateOutcome = "allow" | "require_approval" | "stop";

/** Sanitized run state the guardrail needs; no path, command, prompt or permission is included. */
export interface AutonomyGateState {
  readonly nodeAttempts: number;
  readonly concurrentAgents: number;
  readonly spawnedAgents: number;
  readonly elapsedMinutes: number;
}

export interface AutonomyGateRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly action: AutonomyGateAction;
  readonly state: AutonomyGateState;
}

export interface AutonomyGateDecision {
  readonly outcome: AutonomyGateOutcome;
  readonly rule: string;
}

/**
 * Guardrail consulted by the scheduler before automatic actions in supervised and autonomous runs.
 * The implementation evaluates the deterministic guardrail, merges the durable kill switch and
 * records an immutable audit decision before returning. The scheduler cannot widen limits: it only
 * reports state and obeys the decision.
 */
export interface AutonomyGate {
  assess(request: AutonomyGateRequest): Promise<AutonomyGateDecision>;
}

export interface SchedulerRunAutonomy {
  /** Only supervised and autonomous runs consult the gate; assisted never makes automatic decisions. */
  readonly mode: "supervised" | "autonomous";
  readonly gate: AutonomyGate;
}

export interface SchedulerStartInput {
  /** Runtime-generated opaque ID; callers cannot choose it through CLI or IPC. */
  readonly runId?: string;
  readonly workflow: Workflow;
  readonly grantedPermissions: PermissionMap;
  readonly dryRun?: boolean;
  readonly availableCapabilities?: Readonly<{
    gitWorktree?: boolean;
  }>;
  /** Runtime-owned retry provenance, never accepted from CLI or IPC. */
  readonly lineage?: WorkflowRunLineage;
  /** Optional for compatibility with historical runs; new desktop-managed runs always provide it. */
  readonly executionContext?: WorkflowRunExecutionContextLifecycle;
  /** Present only for supervised/autonomous runs; absent for manual and assisted execution. */
  readonly autonomy?: SchedulerRunAutonomy;
  /**
   * Runtime-only preparation after the run row exists and before it enters running state. Used for
   * durable per-run inputs that must exist before the first node can launch.
   */
  readonly prepareRun?: (runId: string) => Promise<void> | void;
}

export interface WorkflowRunHandle {
  readonly runId: string;
  readonly completion: Promise<WorkflowRunSnapshot>;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly note: string;
}

export type QualityGatePresetId = "lint" | "typecheck" | "test" | "build" | "playwright";
export type QualityGateRunState = "running" | "passed" | "failed" | "interrupted";

export interface QualityGateDefinition {
  readonly id: QualityGatePresetId;
  readonly label: string;
  readonly script: string;
  readonly timeoutMs: number;
  readonly optional: boolean;
}

export interface QualityGateRunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly presetId: QualityGatePresetId;
  readonly state: QualityGateRunState;
  readonly executableName: string;
  readonly args: readonly string[];
  readonly headCommit: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly timedOut: boolean;
  readonly outputSummary: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface QualityGateStore {
  saveGateRun(record: QualityGateRunRecord): Promise<void>;
  getGateRun(id: string): Promise<QualityGateRunRecord | null>;
  listGateRuns(worktreeId: string): Promise<readonly QualityGateRunRecord[]>;
  recoverGateRuns(at: string): Promise<number>;
}

export interface GateCommandRunnerInput {
  readonly sessionId: string;
  readonly executable: {
    readonly path: string;
    readonly kind: "native" | "command-shim";
  };
  readonly args: readonly string[];
  readonly cwd: string;
  readonly allowedCwdRoot: string;
  readonly timeoutMs: number;
  readonly onSpawn?: (pid: number) => Promise<void>;
}

export interface GateCommandResult {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputSummary: string;
  readonly timedOut: boolean;
}

export interface GateCommandRunner {
  run(input: GateCommandRunnerInput): Promise<GateCommandResult>;
}
