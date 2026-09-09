import { contextBridge, ipcRenderer } from "electron";

import {
  AGENT_LIFECYCLE_EVENT_CHANNEL,
  AGENT_SPAWN_EVENT_CHANNEL,
  AGENT_MESSAGES_CANCEL_CHANNEL,
  AGENT_MESSAGES_LIST_CONVERSATIONS_CHANNEL,
  AGENT_MESSAGES_LIST_INBOX_CHANNEL,
  AGENT_MESSAGES_RETRY_CHANNEL,
  CANVAS_LOAD_CHANNEL,
  CANVAS_SAVE_CHANNEL,
  WORKFLOW_AGENTS_LIST_CHANNEL,
  WORKFLOW_DRAFT_ASSIGN_AGENTS_CHANNEL,
  workflowAgentsListResponseSchema,
  workflowDraftAssignAgentsRequestSchema,
  WORKFLOW_DRAFT_ANSWER_QUESTION_CHANNEL,
  WORKFLOW_DRAFT_APPLY_ACTION_CHANNEL,
  WORKFLOW_DRAFT_APPROVE_CHANNEL,
  WORKFLOW_DRAFT_LOAD_CHANNEL,
  WORKFLOW_DRAFT_LOCK_FIELD_CHANNEL,
  WORKFLOW_DRAFT_UPDATE_USER_FIELD_CHANNEL,
  WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL,
  ORCHESTRATOR_SESSION_START_CHANNEL,
  ORCHESTRATOR_SESSION_SEND_OBJECTIVE_CHANNEL,
  ORCHESTRATOR_SESSION_CANCEL_CHANNEL,
  ORCHESTRATOR_COMPOSITION_UPDATED_EVENT_CHANNEL,
  orchestratorSessionStartRequestSchema,
  orchestratorSessionStartResponseSchema,
  orchestratorSessionSendObjectiveRequestSchema,
  orchestratorSessionSendObjectiveResponseSchema,
  orchestratorSessionCancelRequestSchema,
  orchestratorSessionCancelResponseSchema,
  workflowCompositionSchema,
  workflowDraftSchema,
  CLOUD_SYNC_CONFIGURE_CHANNEL,
  CLOUD_SYNC_DISCONNECT_CHANNEL,
  CLOUD_SYNC_NOW_CHANNEL,
  CLOUD_SYNC_QUEUE_RUN_SUMMARY_CHANNEL,
  CLOUD_SYNC_STATUS_CHANNEL,
  DELIVERY_REPORT_GENERATE_CHANNEL,
  HANDOFF_CREATE_DRAFT_CHANNEL,
  HANDOFF_AWAIT_DESTINATION_CHANNEL,
  HANDOFF_CANCEL_DELIVERY_CHANNEL,
  HANDOFF_DELIVER_CHANNEL,
  HANDOFF_LIST_CHANNEL,
  HANDOFF_LIST_EVENTS_CHANNEL,
  WORKSPACE_INCIDENTS_LIST_CHANNEL,
  workspaceIncidentListRequestSchema,
  workspaceIncidentListResponseSchema,
  HANDOFF_MARK_READY_CHANNEL,
  HANDOFF_MARK_SENT_CHANNEL,
  HANDOFF_RETRY_CHANNEL,
  HANDOFF_UPDATE_DRAFT_CHANNEL,
  ORCHESTRATION_PROPOSAL_APPROVE_CHANNEL,
  ORCHESTRATION_PROPOSAL_CREATE_CHANNEL,
  ORCHESTRATION_PROPOSAL_EXECUTE_CHANNEL,
  ORCHESTRATION_PROPOSAL_EVENTS_CHANNEL,
  ORCHESTRATION_PROPOSAL_LIST_CHANNEL,
  ORCHESTRATION_PROPOSAL_PLANNING_OPTIONS_CHANNEL,
  ORCHESTRATION_PROPOSAL_REJECT_CHANNEL,
  ORCHESTRATION_PROPOSAL_SHOW_CHANNEL,
  ORCHESTRATION_PROPOSAL_UPDATE_CHANNEL,
  MERGE_CONFIRM_CHANNEL,
  MERGE_PREPARE_CHANNEL,
  PROJECTS_CLONE_GITHUB_CHANNEL,
  PROJECTS_CHOOSE_CHANNEL,
  PROJECTS_INITIALIZE_GIT_CHANNEL,
  PROJECTS_LIST_CHANNEL,
  PROJECTS_LIST_BRANCHES_CHANNEL,
  PROJECTS_SWITCH_BRANCH_CHANNEL,
  QUALITY_GATES_DISCOVER_CHANNEL,
  QUALITY_GATES_LIST_RUNS_CHANNEL,
  QUALITY_GATES_RUN_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  RUNTIME_LIST_ADAPTERS_CHANNEL,
  TERMINAL_BUFFER_CHANNEL,
  TERMINAL_CANCEL_CHANNEL,
  TERMINAL_CLEAR_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_LIST_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  SYSTEM_PING_CHANNEL,
  WORKSPACE_ACTIVITY_EVENT_CHANNEL,
  WORKSPACE_ARTIFACT_EVENT_CHANNEL,
  WORKSPACE_CONNECTION_EVENT_CHANNEL,
  WORKSPACE_NOTE_EVENT_CHANNEL,
  WORKTREES_CLEANUP_CHANNEL,
  WORKTREES_CREATE_CHANNEL,
  WORKTREES_DIFF_CHANNEL,
  WORKTREES_LIST_CHANNEL,
  WORKTREES_STATUS_CHANNEL,
  WORKFLOW_DRY_RUN_CHANNEL,
  WORKFLOW_TEMPLATE_PREVIEW_IMPORT_CHANNEL,
  WORKFLOW_PACKAGE_EXPORT_CHANNEL,
  WORKFLOW_PACKAGE_PREVIEW_IMPORT_CHANNEL,
  WORKFLOW_LIST_TEMPLATES_CHANNEL,
  WORKFLOW_RUN_LIST_CHANNEL,
  WORKFLOW_RUN_EVENT_CHANNEL,
  WORKFLOW_RUN_SHOW_CHANNEL,
  WORKFLOW_RUN_GRAPH_CHANNEL,
  WORKFLOW_RUN_EVENTS_CHANNEL,
  WORKFLOW_RUN_START_CHANNEL,
  WORKFLOW_RUN_PAUSE_CHANNEL,
  WORKFLOW_RUN_RESUME_CHANNEL,
  WORKFLOW_RUN_CANCEL_CHANNEL,
  WORKFLOW_RUN_RETRY_CHANNEL,
  WORKFLOW_RUN_APPROVE_CHANNEL,
  WORKFLOW_RUN_REJECT_CHANNEL,
  WORKSPACES_CREATE_CHANNEL,
  WORKSPACES_LIST_CHANNEL,
  WORKSPACES_REORDER_CHANNEL,
  WORKSPACES_UPDATE_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  canvasLoadRequestSchema,
  canvasLoadResponseSchema,
  canvasSaveRequestSchema,
  canvasSaveResponseSchema,
  workflowDraftAnswerQuestionRequestSchema,
  workflowDraftApplyActionRequestSchema,
  workflowDraftApproveRequestSchema,
  workflowDraftCommandResultSchema,
  workflowDraftLoadRequestSchema,
  workflowDraftLoadResponseSchema,
  workflowDraftLockFieldRequestSchema,
  workflowDraftUpdateUserFieldRequestSchema,
  canvasHandoffEventSchema,
  canvasHandoffSchema,
  cloudSyncConfigureRequestSchema,
  cloudSyncQueueRunSummaryRequestSchema,
  cloudSyncQueueRunSummaryResponseSchema,
  cloudSyncStatusSchema,
  handoffCreateDraftRequestSchema,
  handoffAwaitDestinationRequestSchema,
  handoffCancelDeliveryRequestSchema,
  handoffDeliverRequestSchema,
  handoffListEventsRequestSchema,
  handoffListRequestSchema,
  handoffMarkReadyRequestSchema,
  handoffMarkSentRequestSchema,
  handoffRetryRequestSchema,
  handoffUpdateDraftRequestSchema,
  orchestrationProposalCreateRequestSchema,
  orchestrationProposalExecuteRequestSchema,
  orchestrationProposalExecutionResponseSchema,
  orchestrationProposalEventListResponseSchema,
  orchestrationProposalListRequestSchema,
  orchestrationProposalListResponseSchema,
  orchestrationProposalPlanningOptionsRequestSchema,
  orchestrationProposalPlanningOptionsResponseSchema,
  orchestrationProposalReferenceRequestSchema,
  orchestrationProposalReviewRequestSchema,
  orchestrationProposalSchema,
  orchestrationProposalUpdateRequestSchema,
  managedWorktreeSchema,
  mergeConfirmRequestSchema,
  mergeConfirmationResultSchema,
  mergePrepareResponseSchema,
  prReadyReportSchema,
  projectIdRequestSchema,
  projectsChooseResponseSchema,
  projectsCloneGitHubRequestSchema,
  projectsInitializeGitRequestSchema,
  projectsListResponseSchema,
  projectBranchesResponseSchema,
  projectSwitchBranchRequestSchema,
  projectSwitchBranchResponseSchema,
  qualityGateDefinitionsResponseSchema,
  qualityGateRunRequestSchema,
  qualityGateRunSchema,
  qualityGateRunsResponseSchema,
  runtimeDiagnosticsSchema,
  runtimeListAdaptersResponseSchema,
  terminalBufferResponseSchema,
  terminalCreateRequestSchema,
  terminalEventSchema,
  terminalListResponseSchema,
  terminalResizeRequestSchema,
  terminalSessionRequestSchema,
  terminalSessionSchema,
  terminalWriteRequestSchema,
  workspaceCreateRequestSchema,
  workspaceListResponseSchema,
  workspaceReorderRequestSchema,
  workspaceSchema,
  workspaceUpdateRequestSchema,
  appSettingsSchema,
  appSettingsUpdateRequestSchema,
  agentLifecycleCanvasEventSchema,
  agentSpawnCanvasEventSchema,
  agentConversationsRequestSchema,
  agentConversationsResponseSchema,
  agentMessageControlRequestSchema,
  agentMessageInboxRequestSchema,
  agentMessageSchema,
  workspaceArtifactCanvasEventSchema,
  workspaceActivityEventSchema,
  workspaceConnectionCanvasEventSchema,
  workspaceNoteCanvasEventSchema,
  workflowDryRunRequestSchema,
  workflowDryRunResponseSchema,
  workflowTemplateImportRequestSchema,
  workflowTemplateImportPreviewSchema,
  compassoPackageRequestSchema,
  compassoPackagePreviewSchema,
  compassoPackageSchema,
  workflowTemplateSummarySchema,
  workflowRunApprovalRequestSchema,
  workflowRunControlRequestSchema,
  workflowRunCommandResponseSchema,
  workflowRunEventSchema,
  workflowRunGraphSchema,
  workflowRunListRequestSchema,
  workflowRunSnapshotSchema,
  workflowRunStartRequestSchema,
  worktreeCleanupRequestSchema,
  worktreeCleanupResponseSchema,
  worktreeCreateRequestSchema,
  worktreeDiffSchema,
  worktreeIdRequestSchema,
  worktreeStatusSchema,
  worktreesListResponseSchema,
  systemPingRequestSchema,
  systemPingResponseSchema
} from "@forgedeck/schemas";
import {
  AUTOMATIC_APPROVE_CHANNEL,
  AUTOMATIC_CANCEL_CHANNEL,
  AUTOMATIC_CREATE_CHANNEL,
  AUTOMATIC_EVENT_CHANNEL,
  AUTOMATIC_LIST_CHANNEL,
  AUTOMATIC_ORCHESTRATORS_CHANNEL,
  AUTOMATIC_PAUSE_CHANNEL,
  AUTOMATIC_REJECT_CHANNEL,
  AUTOMATIC_RESUME_CHANNEL,
  AUTOMATIC_SHOW_CHANNEL,
  AUTOMATIC_START_CHANNEL,
  automaticApprovalDecisionRequestSchema,
  automaticCreateRequestSchema,
  automaticEventSchema,
  automaticListRequestSchema,
  automaticListResponseSchema,
  automaticOrchestratorListResponseSchema,
  automaticRunRefSchema,
  automaticRunSnapshotSchema
} from "@forgedeck/schemas";
import type { ForgeDeckApi } from "@forgedeck/schemas";

const api = {
  system: {
    ping: async (input) => {
      const request = systemPingRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(SYSTEM_PING_CHANNEL, request);
      return systemPingResponseSchema.parse(response);
    }
  },
  runtime: {
    listAdapters: async () => {
      const response: unknown = await ipcRenderer.invoke(RUNTIME_LIST_ADAPTERS_CHANNEL);
      return runtimeListAdaptersResponseSchema.parse(response);
    },
    diagnostics: async () => {
      const response: unknown = await ipcRenderer.invoke(RUNTIME_DIAGNOSTICS_CHANNEL);
      return runtimeDiagnosticsSchema.parse(response);
    }
  },
  terminals: {
    create: async (input) => {
      const request = terminalCreateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, request);
      return terminalSessionSchema.parse(response);
    },
    list: async () => {
      const response: unknown = await ipcRenderer.invoke(TERMINAL_LIST_CHANNEL);
      return terminalListResponseSchema.parse(response);
    },
    buffer: async (input) => {
      const request = terminalSessionRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(TERMINAL_BUFFER_CHANNEL, request);
      return terminalBufferResponseSchema.parse(response);
    },
    write: async (input) => {
      const request = terminalWriteRequestSchema.parse(input);
      await ipcRenderer.invoke(TERMINAL_WRITE_CHANNEL, request);
    },
    resize: async (input) => {
      const request = terminalResizeRequestSchema.parse(input);
      await ipcRenderer.invoke(TERMINAL_RESIZE_CHANNEL, request);
    },
    clear: async (input) => {
      const request = terminalSessionRequestSchema.parse(input);
      await ipcRenderer.invoke(TERMINAL_CLEAR_CHANNEL, request);
    },
    cancel: async (input) => {
      const request = terminalSessionRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(TERMINAL_CANCEL_CHANNEL, request);
      return terminalSessionSchema.parse(response);
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(terminalEventSchema.parse(payload));
      };
      ipcRenderer.on(TERMINAL_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, handler);
    }
  },
  canvases: {
    load: async (input) => {
      const request = canvasLoadRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(CANVAS_LOAD_CHANNEL, request);
      return canvasLoadResponseSchema.parse(response);
    },
    save: async (input) => {
      const request = canvasSaveRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(CANVAS_SAVE_CHANNEL, request);
      return canvasSaveResponseSchema.parse(response);
    }
  },
  workflowDraft: {
    load: async (input) => {
      const request = workflowDraftLoadRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_DRAFT_LOAD_CHANNEL, request);
      return workflowDraftLoadResponseSchema.parse(response);
    },
    applyAction: async (input) => {
      const request = workflowDraftApplyActionRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_DRAFT_APPLY_ACTION_CHANNEL,
        request
      );
      return workflowDraftCommandResultSchema.parse(response);
    },
    answerQuestion: async (input) => {
      const request = workflowDraftAnswerQuestionRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_DRAFT_ANSWER_QUESTION_CHANNEL,
        request
      );
      return workflowDraftCommandResultSchema.parse(response);
    },
    updateUserField: async (input) => {
      const request = workflowDraftUpdateUserFieldRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_DRAFT_UPDATE_USER_FIELD_CHANNEL,
        request
      );
      return workflowDraftCommandResultSchema.parse(response);
    },
    lockField: async (input) => {
      const request = workflowDraftLockFieldRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_DRAFT_LOCK_FIELD_CHANNEL,
        request
      );
      return workflowDraftCommandResultSchema.parse(response);
    },
    approve: async (input) => {
      const request = workflowDraftApproveRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_DRAFT_APPROVE_CHANNEL, request);
      return workflowDraftCommandResultSchema.parse(response);
    },
    /** The agents known to this machine. Availability is observed now, never cached in a document. */
    listAgents: async () => {
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_AGENTS_LIST_CHANNEL);
      return workflowAgentsListResponseSchema.parse(response);
    },
    assignAgents: async (input) => {
      const request = workflowDraftAssignAgentsRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_DRAFT_ASSIGN_AGENTS_CHANNEL,
        request
      );
      return workflowDraftCommandResultSchema.parse(response);
    },
    onUpdated: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workflowDraftSchema.parse(payload));
      };
      ipcRenderer.on(WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL, handler);
    }
  },
  automatic: {
    // Every payload is validated on the way out and every response on the way in, so a malformed request
    // never reaches the main process and an over-sharing response never reaches the renderer.
    create: async (input) => {
      const request = automaticCreateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_CREATE_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    orchestrators: async () => {
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_ORCHESTRATORS_CHANNEL);
      return automaticOrchestratorListResponseSchema.parse(response);
    },
    start: async (input) => {
      const request = automaticRunRefSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_START_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    show: async (input) => {
      const request = automaticRunRefSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_SHOW_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    list: async (input) => {
      const request = automaticListRequestSchema.parse(input ?? {});
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_LIST_CHANNEL, request);
      return automaticListResponseSchema.parse(response);
    },
    pause: async (input) => {
      const request = automaticRunRefSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_PAUSE_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    resume: async (input) => {
      const request = automaticRunRefSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_RESUME_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    cancel: async (input) => {
      const request = automaticRunRefSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_CANCEL_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    approve: async (input) => {
      const request = automaticApprovalDecisionRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_APPROVE_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    reject: async (input) => {
      const request = automaticApprovalDecisionRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AUTOMATIC_REJECT_CHANNEL, request);
      return automaticRunSnapshotSchema.parse(response);
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(automaticEventSchema.parse(payload));
      };
      ipcRenderer.on(AUTOMATIC_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(AUTOMATIC_EVENT_CHANNEL, handler);
    }
  },
  orchestratorSession: {
    start: async (input) => {
      const request = orchestratorSessionStartRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATOR_SESSION_START_CHANNEL,
        request
      );
      return orchestratorSessionStartResponseSchema.parse(response);
    },
    sendObjective: async (input) => {
      const request = orchestratorSessionSendObjectiveRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATOR_SESSION_SEND_OBJECTIVE_CHANNEL,
        request
      );
      return orchestratorSessionSendObjectiveResponseSchema.parse(response);
    },
    cancel: async (input) => {
      const request = orchestratorSessionCancelRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATOR_SESSION_CANCEL_CHANNEL,
        request
      );
      return orchestratorSessionCancelResponseSchema.parse(response);
    },
    onCompositionUpdated: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workflowCompositionSchema.parse(payload));
      };
      ipcRenderer.on(ORCHESTRATOR_COMPOSITION_UPDATED_EVENT_CHANNEL, handler);
      return () =>
        ipcRenderer.removeListener(ORCHESTRATOR_COMPOSITION_UPDATED_EVENT_CHANNEL, handler);
    }
  },
  agentMessages: {
    listInbox: async (input) => {
      const request = agentMessageInboxRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        AGENT_MESSAGES_LIST_INBOX_CHANNEL,
        request
      );
      return agentMessageSchema.array().parse(response);
    },
    cancel: async (input) => {
      const request = agentMessageControlRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AGENT_MESSAGES_CANCEL_CHANNEL, request);
      return agentMessageSchema.parse(response);
    },
    retry: async (input) => {
      const request = agentMessageControlRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(AGENT_MESSAGES_RETRY_CHANNEL, request);
      return agentMessageSchema.parse(response);
    },
    listConversations: async (input) => {
      const request = agentConversationsRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        AGENT_MESSAGES_LIST_CONVERSATIONS_CHANNEL,
        request
      );
      return agentConversationsResponseSchema.parse(response);
    }
  },
  agentSpawns: {
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(agentSpawnCanvasEventSchema.parse(payload));
      };
      ipcRenderer.on(AGENT_SPAWN_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(AGENT_SPAWN_EVENT_CHANNEL, handler);
    }
  },
  agentLifecycle: {
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(agentLifecycleCanvasEventSchema.parse(payload));
      };
      ipcRenderer.on(AGENT_LIFECYCLE_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(AGENT_LIFECYCLE_EVENT_CHANNEL, handler);
    }
  },
  artifacts: {
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workspaceArtifactCanvasEventSchema.parse(payload));
      };
      ipcRenderer.on(WORKSPACE_ARTIFACT_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WORKSPACE_ARTIFACT_EVENT_CHANNEL, handler);
    }
  },
  notes: {
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workspaceNoteCanvasEventSchema.parse(payload));
      };
      ipcRenderer.on(WORKSPACE_NOTE_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WORKSPACE_NOTE_EVENT_CHANNEL, handler);
    }
  },
  connections: {
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workspaceConnectionCanvasEventSchema.parse(payload));
      };
      ipcRenderer.on(WORKSPACE_CONNECTION_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WORKSPACE_CONNECTION_EVENT_CHANNEL, handler);
    }
  },
  workspaceActivity: {
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workspaceActivityEventSchema.parse(payload));
      };
      ipcRenderer.on(WORKSPACE_ACTIVITY_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WORKSPACE_ACTIVITY_EVENT_CHANNEL, handler);
    }
  },
  handoffs: {
    createDraft: async (input) => {
      const request = handoffCreateDraftRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_CREATE_DRAFT_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    updateDraft: async (input) => {
      const request = handoffUpdateDraftRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_UPDATE_DRAFT_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    markReady: async (input) => {
      const request = handoffMarkReadyRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_MARK_READY_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    deliver: async (input) => {
      const request = handoffDeliverRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_DELIVER_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    awaitDestination: async (input) => {
      const request = handoffAwaitDestinationRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        HANDOFF_AWAIT_DESTINATION_CHANNEL,
        request
      );
      return canvasHandoffSchema.parse(response);
    },
    retry: async (input) => {
      const request = handoffRetryRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_RETRY_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    markSent: async (input) => {
      const request = handoffMarkSentRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_MARK_SENT_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    cancelDelivery: async (input) => {
      const request = handoffCancelDeliveryRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_CANCEL_DELIVERY_CHANNEL, request);
      return canvasHandoffSchema.parse(response);
    },
    list: async (input) => {
      const request = handoffListRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_LIST_CHANNEL, request);
      return canvasHandoffSchema.array().parse(response);
    },
    listEvents: async (input) => {
      const request = handoffListEventsRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(HANDOFF_LIST_EVENTS_CHANNEL, request);
      return canvasHandoffEventSchema.array().parse(response);
    }
  },
  orchestrationProposals: {
    create: async (input) => {
      const request = orchestrationProposalCreateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_CREATE_CHANNEL,
        request
      );
      return orchestrationProposalSchema.parse(response);
    },
    list: async (input) => {
      const request = orchestrationProposalListRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_LIST_CHANNEL,
        request
      );
      return orchestrationProposalListResponseSchema.parse(response);
    },
    show: async (input) => {
      const request = orchestrationProposalReferenceRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_SHOW_CHANNEL,
        request
      );
      return orchestrationProposalSchema.parse(response);
    },
    events: async (input) => {
      const request = orchestrationProposalReferenceRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_EVENTS_CHANNEL,
        request
      );
      return orchestrationProposalEventListResponseSchema.parse(response);
    },
    update: async (input) => {
      const request = orchestrationProposalUpdateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_UPDATE_CHANNEL,
        request
      );
      return orchestrationProposalSchema.parse(response);
    },
    approve: async (input) => {
      const request = orchestrationProposalReviewRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_APPROVE_CHANNEL,
        request
      );
      return orchestrationProposalSchema.parse(response);
    },
    reject: async (input) => {
      const request = orchestrationProposalReviewRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_REJECT_CHANNEL,
        request
      );
      return orchestrationProposalSchema.parse(response);
    },
    execute: async (input) => {
      const request = orchestrationProposalExecuteRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_EXECUTE_CHANNEL,
        request
      );
      return orchestrationProposalExecutionResponseSchema.parse(response);
    },
    planningOptions: async (input) => {
      const request = orchestrationProposalPlanningOptionsRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        ORCHESTRATION_PROPOSAL_PLANNING_OPTIONS_CHANNEL,
        request
      );
      return orchestrationProposalPlanningOptionsResponseSchema.parse(response);
    }
  },
  workspaces: {
    list: async () => {
      const response: unknown = await ipcRenderer.invoke(WORKSPACES_LIST_CHANNEL);
      return workspaceListResponseSchema.parse(response);
    },
    create: async (input) => {
      const request = workspaceCreateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKSPACES_CREATE_CHANNEL, request);
      return workspaceSchema.parse(response);
    },
    update: async (input) => {
      const request = workspaceUpdateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKSPACES_UPDATE_CHANNEL, request);
      return workspaceSchema.parse(response);
    },
    reorder: async (input) => {
      const request = workspaceReorderRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKSPACES_REORDER_CHANNEL, request);
      return workspaceListResponseSchema.parse(response);
    }
  },
  settings: {
    get: async () => {
      const response: unknown = await ipcRenderer.invoke(SETTINGS_GET_CHANNEL);
      return appSettingsSchema.parse(response);
    },
    update: async (input) => {
      const request = appSettingsUpdateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(SETTINGS_UPDATE_CHANNEL, request);
      return appSettingsSchema.parse(response);
    }
  },
  incidents: {
    list: async (input) => {
      const request = workspaceIncidentListRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKSPACE_INCIDENTS_LIST_CHANNEL, request);
      return workspaceIncidentListResponseSchema.parse(response);
    }
  },
  workflows: {
    listTemplates: async () => {
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_LIST_TEMPLATES_CHANNEL);
      return workflowTemplateSummarySchema.array().parse(response);
    },
    dryRun: async (input) => {
      const request = workflowDryRunRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_DRY_RUN_CHANNEL, request);
      return workflowDryRunResponseSchema.parse(response);
    },
    previewImport: async (input) => {
      const request = workflowTemplateImportRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_TEMPLATE_PREVIEW_IMPORT_CHANNEL,
        request
      );
      return workflowTemplateImportPreviewSchema.parse(response);
    },
    exportPackage: async (input) => {
      const request = compassoPackageRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_PACKAGE_EXPORT_CHANNEL, request);
      return compassoPackageSchema.parse(response);
    },
    previewPackageImport: async (input) => {
      const request = compassoPackageRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_PACKAGE_PREVIEW_IMPORT_CHANNEL,
        request
      );
      return compassoPackagePreviewSchema.parse(response);
    },
    list: async (input = {}) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_LIST_CHANNEL,
        workflowRunListRequestSchema.parse(input)
      );
      return workflowRunSnapshotSchema.array().parse(response);
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(workflowRunEventSchema.parse(payload));
      };
      ipcRenderer.on(WORKFLOW_RUN_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WORKFLOW_RUN_EVENT_CHANNEL, handler);
    },
    show: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_SHOW_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunSnapshotSchema.parse(response);
    },
    graph: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_GRAPH_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunGraphSchema.parse(response);
    },
    events: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_EVENTS_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunEventSchema.array().parse(response);
    },
    start: async (input) => {
      const request = workflowRunStartRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUN_START_CHANNEL, request);
      return workflowRunCommandResponseSchema.parse(response);
    },
    pause: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_PAUSE_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunCommandResponseSchema.parse(response);
    },
    resume: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_RESUME_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunCommandResponseSchema.parse(response);
    },
    cancel: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_CANCEL_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunCommandResponseSchema.parse(response);
    },
    retry: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_RETRY_CHANNEL,
        workflowRunControlRequestSchema.parse(input)
      );
      return workflowRunCommandResponseSchema.parse(response);
    },
    approve: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_APPROVE_CHANNEL,
        workflowRunApprovalRequestSchema.parse(input)
      );
      return workflowRunCommandResponseSchema.parse(response);
    },
    reject: async (input) => {
      const response: unknown = await ipcRenderer.invoke(
        WORKFLOW_RUN_REJECT_CHANNEL,
        workflowRunApprovalRequestSchema.parse(input)
      );
      return workflowRunCommandResponseSchema.parse(response);
    }
  },
  projects: {
    choose: async () => {
      const response: unknown = await ipcRenderer.invoke(PROJECTS_CHOOSE_CHANNEL);
      return projectsChooseResponseSchema.parse(response);
    },
    initializeGit: async (input) => {
      const request = projectsInitializeGitRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(PROJECTS_INITIALIZE_GIT_CHANNEL, request);
      return projectsChooseResponseSchema.parse(response);
    },
    cloneGitHub: async (input) => {
      const request = projectsCloneGitHubRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(PROJECTS_CLONE_GITHUB_CHANNEL, request);
      return projectsChooseResponseSchema.parse(response);
    },
    list: async () => {
      const response: unknown = await ipcRenderer.invoke(PROJECTS_LIST_CHANNEL);
      return projectsListResponseSchema.parse(response);
    },
    listBranches: async (input) => {
      const request = projectIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(PROJECTS_LIST_BRANCHES_CHANNEL, request);
      return projectBranchesResponseSchema.parse(response);
    },
    switchBranch: async (input) => {
      const request = projectSwitchBranchRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(PROJECTS_SWITCH_BRANCH_CHANNEL, request);
      return projectSwitchBranchResponseSchema.parse(response);
    }
  },
  worktrees: {
    list: async (input) => {
      const request = projectIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKTREES_LIST_CHANNEL, request);
      return worktreesListResponseSchema.parse(response);
    },
    create: async (input) => {
      const request = worktreeCreateRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKTREES_CREATE_CHANNEL, request);
      return managedWorktreeSchema.parse(response);
    },
    status: async (input) => {
      const request = worktreeIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKTREES_STATUS_CHANNEL, request);
      return worktreeStatusSchema.parse(response);
    },
    diff: async (input) => {
      const request = worktreeIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKTREES_DIFF_CHANNEL, request);
      return worktreeDiffSchema.parse(response);
    },
    cleanup: async (input) => {
      const request = worktreeCleanupRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(WORKTREES_CLEANUP_CHANNEL, request);
      return worktreeCleanupResponseSchema.parse(response);
    }
  },
  qualityGates: {
    discover: async (input) => {
      const request = worktreeIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(QUALITY_GATES_DISCOVER_CHANNEL, request);
      return qualityGateDefinitionsResponseSchema.parse(response);
    },
    listRuns: async (input) => {
      const request = worktreeIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(QUALITY_GATES_LIST_RUNS_CHANNEL, request);
      return qualityGateRunsResponseSchema.parse(response);
    },
    run: async (input) => {
      const request = qualityGateRunRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(QUALITY_GATES_RUN_CHANNEL, request);
      return qualityGateRunSchema.parse(response);
    }
  },
  deliveryReports: {
    generate: async (input) => {
      const request = worktreeIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(DELIVERY_REPORT_GENERATE_CHANNEL, request);
      return prReadyReportSchema.parse(response);
    }
  },
  merges: {
    prepare: async (input) => {
      const request = worktreeIdRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(MERGE_PREPARE_CHANNEL, request);
      return mergePrepareResponseSchema.parse(response);
    },
    confirm: async (input) => {
      const request = mergeConfirmRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(MERGE_CONFIRM_CHANNEL, request);
      return mergeConfirmationResultSchema.parse(response);
    }
  },
  cloudSync: {
    status: async () => {
      const response: unknown = await ipcRenderer.invoke(CLOUD_SYNC_STATUS_CHANNEL);
      return cloudSyncStatusSchema.parse(response);
    },
    configure: async (input) => {
      const request = cloudSyncConfigureRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(CLOUD_SYNC_CONFIGURE_CHANNEL, request);
      return cloudSyncStatusSchema.parse(response);
    },
    queueRunSummary: async (input) => {
      const request = cloudSyncQueueRunSummaryRequestSchema.parse(input);
      const response: unknown = await ipcRenderer.invoke(
        CLOUD_SYNC_QUEUE_RUN_SUMMARY_CHANNEL,
        request
      );
      return cloudSyncQueueRunSummaryResponseSchema.parse(response);
    },
    syncNow: async () => {
      const response: unknown = await ipcRenderer.invoke(CLOUD_SYNC_NOW_CHANNEL);
      return cloudSyncStatusSchema.parse(response);
    },
    disconnect: async () => {
      const response: unknown = await ipcRenderer.invoke(CLOUD_SYNC_DISCONNECT_CHANNEL);
      return cloudSyncStatusSchema.parse(response);
    }
  }
} satisfies ForgeDeckApi;

contextBridge.exposeInMainWorld("forgedeck", api);
