import { z } from "zod";

import type { AgentLifecycleCanvasEvent } from "../agent-lifecycle";
import type { AgentSpawnCanvasEvent } from "../agent-spawns";
import type {
  AutomaticApprovalDecisionRequest,
  AutomaticCreateRequest,
  AutomaticEvent,
  AutomaticListRequest,
  AutomaticListResponse,
  AutomaticOrchestratorListResponse,
  AutomaticRunRef,
  AutomaticRunSnapshotDto
} from "./automatic";
import type { WorkspaceArtifactCanvasEvent } from "../workspace-artifacts";
import type { WorkspaceNoteCanvasEvent } from "../workspace-notes";
import type { WorkspaceConnectionCanvasEvent } from "../workspace-connections";
import type { WorkspaceActivityEvent } from "../workspace-activity";
import type { RuntimeAdapterStatus, RuntimeDiagnostics } from "./runtime";
import type {
  TerminalCreateRequest,
  TerminalEvent,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionRequest,
  TerminalWriteRequest
} from "./terminal";
import type {
  CanvasLoadRequest,
  CanvasLoadResponse,
  CanvasSaveRequest,
  CanvasSaveResponse
} from "./canvas";
import type {
  WorkflowDryRunRequest,
  WorkflowDryRunResponse,
  CompassoPackageRequest,
  WorkflowTemplateImportPreview,
  WorkflowTemplateImportRequest,
  WorkflowTemplateSummary,
  WorkflowRunApprovalRequest,
  WorkflowRunCommandResponse,
  WorkflowRunControlRequest,
  WorkflowRunEvent,
  WorkflowRunGraphDto,
  WorkflowRunListRequest,
  WorkflowRunSnapshotDto,
  WorkflowRunStartRequest
} from "./workflows";
import type {
  GitProjectDto,
  ManagedWorktreeDto,
  MergeConfirmRequest,
  MergeConfirmationResultDto,
  MergePlanDto,
  PrReadyReportDto,
  ProjectsCloneGitHubRequest,
  ProjectsChooseResponse,
  ProjectsInitializeGitRequest,
  ProjectBranchesResponse,
  ProjectSwitchBranchRequest,
  ProjectSwitchBranchResponse,
  QualityGateDefinitionDto,
  QualityGateRunDto,
  QualityGateRunRequest,
  WorktreeCleanupRequest,
  WorktreeCreateRequest,
  WorktreeDiffDto,
  WorktreeStatusDto
} from "./git";
import type {
  CloudSyncConfigureRequest,
  CloudSyncQueueRunSummaryRequest,
  CloudSyncStatus
} from "./cloud";
import type {
  WorkspaceCreateRequest,
  WorkspaceDto,
  WorkspaceReorderRequest,
  WorkspaceUpdateRequest
} from "./workspace";
import type { AppSettingsDto, AppSettingsUpdateRequest } from "./settings";
import type {
  WorkspaceIncidentListRequest,
  WorkspaceIncidentListResponse
} from "../workspace-incidents";
import type {
  CanvasHandoff,
  CanvasHandoffEvent,
  HandoffAwaitDestinationRequest,
  HandoffCancelDeliveryRequest,
  HandoffCreateDraftRequest,
  HandoffDeliverRequest,
  HandoffListEventsRequest,
  HandoffListRequest,
  HandoffMarkReadyRequest,
  HandoffMarkSentRequest,
  HandoffRetryRequest,
  HandoffUpdateDraftRequest
} from "./handoffs";
import type { AgentMessage } from "../agent-messages";
import type {
  AgentConversation,
  AgentConversationsRequest,
  AgentMessageControlRequest,
  AgentMessageInboxRequest
} from "./agent-messages";
import type {
  OrchestrationProposalCreateRequest,
  OrchestrationProposalExecuteRequest,
  OrchestrationProposalExecutionResponse,
  OrchestrationProposalListRequest,
  OrchestrationProposalPlanningOptionsRequest,
  OrchestrationProposalPlanningOptionsResponse,
  OrchestrationProposalReferenceRequest,
  OrchestrationProposalReviewRequest,
  OrchestrationProposalUpdateRequest
} from "./orchestration-proposals";
import type { OrchestrationProposal, OrchestrationProposalEvent } from "../orchestration-proposal";
import type { CompassoPackage, CompassoPackagePreview } from "../compasso-package";
import type {
  WorkflowAgentsListResponse,
  WorkflowDraftAssignAgentsRequest,
  WorkflowDraftAnswerQuestionRequest,
  WorkflowDraftApplyActionRequest,
  WorkflowDraftApproveRequest,
  WorkflowDraftCommandResult,
  WorkflowDraftLoadRequest,
  WorkflowDraftLoadResponse,
  WorkflowDraftLockFieldRequest,
  WorkflowDraftUpdateUserFieldRequest
} from "./workflow-draft";
import type { WorkflowDraft } from "../workflow-draft";
import type {
  OrchestratorSessionCancelRequest,
  OrchestratorSessionCancelResponse,
  OrchestratorSessionSendObjectiveRequest,
  OrchestratorSessionSendObjectiveResponse,
  OrchestratorSessionStartRequest,
  OrchestratorSessionStartResponse,
  WorkflowComposition
} from "./orchestrator-session";

export const SYSTEM_PING_CHANNEL = "system:ping" as const;

export const systemPingRequestSchema = z
  .object({
    requestId: z.string().uuid()
  })
  .strict();

export const systemPingResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    ok: z.literal(true),
    mainProcessTime: z.string().datetime({ offset: true })
  })
  .strict();

export type SystemPingRequest = z.infer<typeof systemPingRequestSchema>;
export type SystemPingResponse = z.infer<typeof systemPingResponseSchema>;

export interface ForgeDeckApi {
  readonly system: {
    ping(input: SystemPingRequest): Promise<SystemPingResponse>;
  };
  readonly runtime: {
    listAdapters(): Promise<RuntimeAdapterStatus[]>;
    diagnostics(): Promise<RuntimeDiagnostics>;
  };
  readonly terminals: {
    create(input: TerminalCreateRequest): Promise<TerminalSession>;
    list(): Promise<TerminalSession[]>;
    buffer(
      input: TerminalSessionRequest
    ): Promise<{ readonly data: string; readonly sequence: number }>;
    write(input: TerminalWriteRequest): Promise<void>;
    resize(input: TerminalResizeRequest): Promise<void>;
    clear(input: TerminalSessionRequest): Promise<void>;
    cancel(input: TerminalSessionRequest): Promise<TerminalSession>;
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  readonly canvases: {
    load(input: CanvasLoadRequest): Promise<CanvasLoadResponse>;
    save(input: CanvasSaveRequest): Promise<CanvasSaveResponse>;
  };
  readonly workflowDraft: {
    load(input: WorkflowDraftLoadRequest): Promise<WorkflowDraftLoadResponse>;
    applyAction(input: WorkflowDraftApplyActionRequest): Promise<WorkflowDraftCommandResult>;
    answerQuestion(input: WorkflowDraftAnswerQuestionRequest): Promise<WorkflowDraftCommandResult>;
    updateUserField(
      input: WorkflowDraftUpdateUserFieldRequest
    ): Promise<WorkflowDraftCommandResult>;
    lockField(input: WorkflowDraftLockFieldRequest): Promise<WorkflowDraftCommandResult>;
    approve(input: WorkflowDraftApproveRequest): Promise<WorkflowDraftCommandResult>;
    listAgents(): Promise<WorkflowAgentsListResponse>;
    assignAgents(input: WorkflowDraftAssignAgentsRequest): Promise<WorkflowDraftCommandResult>;
    /** Live push whenever a real orchestrator session mutates its draft (ghost nodes refresh). */
    onUpdated(listener: (draft: WorkflowDraft) => void): () => void;
  };
  /**
   * Automatic mode. The renderer sends an objective, a budget mode and decisions; it never receives a
   * store, a runtime, an adapter or a workflow definition, and never a generated prompt.
   */
  readonly automatic: {
    create(input: AutomaticCreateRequest): Promise<AutomaticRunSnapshotDto>;
    /** Availability of every agent that could write a plan. Listing never starts a planning turn. */
    orchestrators(): Promise<AutomaticOrchestratorListResponse>;
    start(input: AutomaticRunRef): Promise<AutomaticRunSnapshotDto>;
    show(input: AutomaticRunRef): Promise<AutomaticRunSnapshotDto>;
    list(input?: AutomaticListRequest): Promise<AutomaticListResponse>;
    pause(input: AutomaticRunRef): Promise<AutomaticRunSnapshotDto>;
    resume(input: AutomaticRunRef): Promise<AutomaticRunSnapshotDto>;
    cancel(input: AutomaticRunRef): Promise<AutomaticRunSnapshotDto>;
    approve(input: AutomaticApprovalDecisionRequest): Promise<AutomaticRunSnapshotDto>;
    reject(input: AutomaticApprovalDecisionRequest): Promise<AutomaticRunSnapshotDto>;
    /** Invalidation only: on any event the renderer re-reads the snapshot, which is the truth. */
    onEvent(listener: (event: AutomaticEvent) => void): () => void;
  };
  readonly orchestratorSession: {
    start(input: OrchestratorSessionStartRequest): Promise<OrchestratorSessionStartResponse>;
    sendObjective(
      input: OrchestratorSessionSendObjectiveRequest
    ): Promise<OrchestratorSessionSendObjectiveResponse>;
    cancel(input: OrchestratorSessionCancelRequest): Promise<OrchestratorSessionCancelResponse>;
    onCompositionUpdated(listener: (composition: WorkflowComposition) => void): () => void;
  };
  readonly agentMessages: {
    listInbox(input: AgentMessageInboxRequest): Promise<AgentMessage[]>;
    cancel(input: AgentMessageControlRequest): Promise<AgentMessage>;
    retry(input: AgentMessageControlRequest): Promise<AgentMessage>;
    listConversations(input: AgentConversationsRequest): Promise<AgentConversation[]>;
  };
  readonly agentSpawns: {
    onEvent(listener: (event: AgentSpawnCanvasEvent) => void): () => void;
  };
  readonly agentLifecycle: {
    onEvent(listener: (event: AgentLifecycleCanvasEvent) => void): () => void;
  };
  readonly artifacts: {
    onEvent(listener: (event: WorkspaceArtifactCanvasEvent) => void): () => void;
  };
  readonly notes: {
    onEvent(listener: (event: WorkspaceNoteCanvasEvent) => void): () => void;
  };
  readonly connections: {
    onEvent(listener: (event: WorkspaceConnectionCanvasEvent) => void): () => void;
  };
  readonly workspaceActivity: {
    onEvent(listener: (event: WorkspaceActivityEvent) => void): () => void;
  };
  readonly handoffs: {
    createDraft(input: HandoffCreateDraftRequest): Promise<CanvasHandoff>;
    updateDraft(input: HandoffUpdateDraftRequest): Promise<CanvasHandoff>;
    markReady(input: HandoffMarkReadyRequest): Promise<CanvasHandoff>;
    deliver(input: HandoffDeliverRequest): Promise<CanvasHandoff>;
    awaitDestination(input: HandoffAwaitDestinationRequest): Promise<CanvasHandoff>;
    retry(input: HandoffRetryRequest): Promise<CanvasHandoff>;
    markSent(input: HandoffMarkSentRequest): Promise<CanvasHandoff>;
    cancelDelivery(input: HandoffCancelDeliveryRequest): Promise<CanvasHandoff>;
    list(input: HandoffListRequest): Promise<CanvasHandoff[]>;
    listEvents(input: HandoffListEventsRequest): Promise<CanvasHandoffEvent[]>;
  };
  readonly orchestrationProposals: {
    create(input: OrchestrationProposalCreateRequest): Promise<OrchestrationProposal>;
    list(input: OrchestrationProposalListRequest): Promise<OrchestrationProposal[]>;
    show(input: OrchestrationProposalReferenceRequest): Promise<OrchestrationProposal>;
    events(input: OrchestrationProposalReferenceRequest): Promise<OrchestrationProposalEvent[]>;
    update(input: OrchestrationProposalUpdateRequest): Promise<OrchestrationProposal>;
    approve(input: OrchestrationProposalReviewRequest): Promise<OrchestrationProposal>;
    reject(input: OrchestrationProposalReviewRequest): Promise<OrchestrationProposal>;
    execute(
      input: OrchestrationProposalExecuteRequest
    ): Promise<OrchestrationProposalExecutionResponse>;
    planningOptions(
      input: OrchestrationProposalPlanningOptionsRequest
    ): Promise<OrchestrationProposalPlanningOptionsResponse>;
  };
  readonly workspaces: {
    list(): Promise<WorkspaceDto[]>;
    create(input: WorkspaceCreateRequest): Promise<WorkspaceDto>;
    update(input: WorkspaceUpdateRequest): Promise<WorkspaceDto>;
    reorder(input: WorkspaceReorderRequest): Promise<WorkspaceDto[]>;
  };
  readonly settings: {
    get(): Promise<AppSettingsDto>;
    update(input: AppSettingsUpdateRequest): Promise<AppSettingsDto>;
  };
  readonly incidents: {
    /** Durable failures for a workspace, newest first. Read on demand; never pushed. */
    list(input: WorkspaceIncidentListRequest): Promise<WorkspaceIncidentListResponse>;
  };
  readonly workflows: {
    listTemplates(): Promise<WorkflowTemplateSummary[]>;
    dryRun(input: WorkflowDryRunRequest): Promise<WorkflowDryRunResponse>;
    previewImport(input: WorkflowTemplateImportRequest): Promise<WorkflowTemplateImportPreview>;
    exportPackage(input: CompassoPackageRequest): Promise<CompassoPackage>;
    previewPackageImport(input: CompassoPackageRequest): Promise<CompassoPackagePreview>;
    list(input?: WorkflowRunListRequest): Promise<WorkflowRunSnapshotDto[]>;
    onEvent(listener: (event: WorkflowRunEvent) => void): () => void;
    show(input: WorkflowRunControlRequest): Promise<WorkflowRunSnapshotDto>;
    graph(input: WorkflowRunControlRequest): Promise<WorkflowRunGraphDto>;
    events(input: WorkflowRunControlRequest): Promise<WorkflowRunEvent[]>;
    start(input: WorkflowRunStartRequest): Promise<WorkflowRunCommandResponse>;
    pause(input: WorkflowRunControlRequest): Promise<WorkflowRunCommandResponse>;
    resume(input: WorkflowRunControlRequest): Promise<WorkflowRunCommandResponse>;
    cancel(input: WorkflowRunControlRequest): Promise<WorkflowRunCommandResponse>;
    retry(input: WorkflowRunControlRequest): Promise<WorkflowRunCommandResponse>;
    approve(input: WorkflowRunApprovalRequest): Promise<WorkflowRunCommandResponse>;
    reject(input: WorkflowRunApprovalRequest): Promise<WorkflowRunCommandResponse>;
  };
  readonly projects: {
    choose(): Promise<ProjectsChooseResponse>;
    initializeGit(input: ProjectsInitializeGitRequest): Promise<ProjectsChooseResponse>;
    cloneGitHub(input: ProjectsCloneGitHubRequest): Promise<ProjectsChooseResponse>;
    list(): Promise<GitProjectDto[]>;
    listBranches(input: { readonly projectId: string }): Promise<ProjectBranchesResponse>;
    switchBranch(input: ProjectSwitchBranchRequest): Promise<ProjectSwitchBranchResponse>;
  };
  readonly worktrees: {
    list(input: { readonly projectId: string }): Promise<ManagedWorktreeDto[]>;
    create(input: WorktreeCreateRequest): Promise<ManagedWorktreeDto>;
    status(input: { readonly worktreeId: string }): Promise<WorktreeStatusDto>;
    diff(input: { readonly worktreeId: string }): Promise<WorktreeDiffDto>;
    cleanup(input: WorktreeCleanupRequest): Promise<{ readonly removed: true }>;
  };
  readonly qualityGates: {
    discover(input: { readonly worktreeId: string }): Promise<QualityGateDefinitionDto[]>;
    listRuns(input: { readonly worktreeId: string }): Promise<QualityGateRunDto[]>;
    run(input: QualityGateRunRequest): Promise<QualityGateRunDto>;
  };
  readonly deliveryReports: {
    generate(input: { readonly worktreeId: string }): Promise<PrReadyReportDto>;
  };
  readonly merges: {
    prepare(input: { readonly worktreeId: string }): Promise<{
      readonly plan: MergePlanDto;
      readonly confirmationToken: string | null;
    }>;
    confirm(input: MergeConfirmRequest): Promise<MergeConfirmationResultDto>;
  };
  readonly cloudSync: {
    status(): Promise<CloudSyncStatus>;
    configure(input: CloudSyncConfigureRequest): Promise<CloudSyncStatus>;
    queueRunSummary(input: CloudSyncQueueRunSummaryRequest): Promise<{ readonly queued: boolean }>;
    syncNow(): Promise<CloudSyncStatus>;
    disconnect(): Promise<CloudSyncStatus>;
  };
}
