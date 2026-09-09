import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import {
  V2_NODE_ADD_NOTE_CHANNEL,
  V2_NODE_ADD_PORTAL_CHANNEL,
  V2_NODE_ADD_TERMINAL_CHANNEL,
  V2_NODE_DELETE_CHANNEL,
  V2_NODE_DELETE_MANY_CHANNEL,
  V2_GROUP_CREATE_CHANNEL,
  V2_GROUP_UPDATE_CHANNEL,
  V2_GROUP_DELETE_CHANNEL,
  V2_CANVAS_PASTE_CHANNEL,
  V2_NODE_MOVE_CHANNEL,
  V2_NODE_MOVE_MANY_CHANNEL,
  V2_NODE_RESIZE_CHANNEL,
  V2_NODE_UPDATE_CHANNEL,
  V2_NATIVE_SURFACE_STATE_CHANNEL,
  V2_PORTAL_CANCEL_CHANNEL,
  V2_PORTAL_CONSOLE_CHANNEL,
  V2_PORTAL_DIAGNOSTICS_CHANNEL,
  V2_PORTAL_DOWNLOAD_DECISION_CHANNEL,
  V2_PORTAL_DOWNLOAD_REQUEST_CHANNEL,
  V2_PORTAL_EVENT_CHANNEL,
  V2_PORTAL_FOCUS_CHANNEL,
  V2_PORTAL_RECOVER_CHANNEL,
  V2_PORTAL_RESET_FOCUS_CHANNEL,
  V2_PORTAL_STATE_CHANNEL,
  V2_PORTAL_ENSURE_CHANNEL,
  V2_PORTAL_BOUNDS_CHANNEL,
  V2_PORTAL_NAVIGATE_CHANNEL,
  V2_PORTAL_COMMAND_CHANNEL,
  V2_PORTAL_SCREENSHOT_CHANNEL,
  V2_PORTAL_AUTOMATION_CHANNEL,
  V2_PORTAL_DESTROY_CHANNEL,
  V2_EDGE_ADD_CHANNEL,
  V2_EDGE_DELETE_CHANNEL,
  V2_TERMINAL_EVENT_CHANNEL,
  V2_TERMINAL_RESTART_CHANNEL,
  V2_TERMINAL_RESIZE_CHANNEL,
  V2_TERMINAL_START_CHANNEL,
  V2_TERMINAL_STOP_CHANNEL,
  V2_TERMINAL_WRITE_CHANNEL,
  V2_AGENT_CLEAR_EXECUTABLE_CHANNEL,
  V2_AGENT_CREATE_PRESET_CHANNEL,
  V2_AGENT_DELETE_PRESET_CHANNEL,
  V2_AGENT_DETECT_ALL_CHANNEL,
  V2_AGENT_DETECT_ONE_CHANNEL,
  V2_AGENT_LIST_DEFINITIONS_CHANNEL,
  V2_AGENT_LIST_PRESETS_CHANNEL,
  V2_AGENT_SET_EXECUTABLE_CHANNEL,
  V2_PERMISSIONS_GET_CHANNEL,
  V2_PERMISSIONS_UPDATE_CHANNEL,
  V2_ATTENTION_DISMISS_CHANNEL,
  V2_TEAM_USER_INPUT_ANSWER_CHANNEL,
  V2_ATTENTION_RESOLVE_CHANNEL,
  V2_DIAGNOSTICS_EXPORT_CHANNEL,
  V2_LAYOUT_FIT_TEAM_CHANNEL,
  V2_LAYOUT_ORGANIZE_TEAM_CHANNEL,
  V2_LAYOUT_RESTORE_TEAM_CHANNEL,
  V2_NOTIFICATION_PREFERENCES_UPDATE_CHANNEL,
  V2_OPERATIONAL_EVENT_CHANNEL,
  V2_OPERATIONAL_GET_CHANNEL,
  V2_OPERATIONAL_NAVIGATE_CHANNEL,
  V2_POLICY_UPDATE_CHANNEL,
  V2_RUN_CANCEL_CHANNEL,
  V2_RUN_DELETE_TEAM_CHANNEL,
  V2_RUN_PAUSE_CHANNEL,
  V2_RUN_RECOVER_CHANNEL,
  V2_RUN_RESUME_CHANNEL,
  V2_TASK_CANCEL_CHANNEL,
  V2_TASK_REASSIGN_CHANNEL,
  V2_TASK_RETRY_CHANNEL,
  V2_ROLE_CREATE_CHANNEL,
  V2_ROLE_UPDATE_CHANNEL,
  V2_ROLE_DELETE_CHANNEL,
  V2_ROLE_DISCOVER_CHANNEL,
  V2_ROLE_DUPLICATE_CHANNEL,
  V2_ROLE_EXPORT_CHANNEL,
  V2_ROLE_IMPORT_CHANNEL,
  V2_ROLE_LIST_CHANNEL,
  V2_WORKSPACE_CLOSE_CHANNEL,
  V2_WORKSPACE_CREATE_CHANNEL,
  V2_WORKSPACE_DELETE_CHANNEL,
  V2_WORKSPACE_LIST_CHANNEL,
  V2_WORKSPACE_OPEN_CHANNEL,
  V2_WORKSPACE_RENAME_CHANNEL,
  V2_WORKSPACE_SELECT_DIRECTORY_CHANNEL,
  V2_WORKSPACE_UPDATE_SETTINGS_CHANNEL,
  V2_WORKSPACE_UNDO_CHANNEL,
  V2_WORKSPACE_REDO_CHANNEL,
  V2_LICENSE_STATUS_CHANNEL,
  V2_LICENSE_ACTIVATE_CHANNEL,
  V2_LICENSE_DEACTIVATE_CHANNEL,
  V2_UPDATE_STATUS_CHANNEL,
  V2_UPDATE_CHECK_CHANNEL,
  V2_UPDATE_DOWNLOAD_CHANNEL,
  V2_UPDATE_INSTALL_CHANNEL,
  V2_UPDATE_AUTO_CHECK_CHANNEL,
  V2_CLIPBOARD_READ_CHANNEL,
  V2_CLIPBOARD_WRITE_CHANNEL,
  v2AddNoteRequestSchema,
  v2AddPortalRequestSchema,
  v2PortalReferenceSchema,
  v2PortalBoundsRequestSchema,
  v2PortalNavigateRequestSchema,
  v2PortalCommandRequestSchema,
  v2PortalAutomationRequestSchema,
  v2PortalConsoleRequestSchema,
  v2PortalCancelRequestSchema,
  v2PortalRecoverRequestSchema,
  v2PortalFocusRequestSchema,
  v2PortalDownloadDecisionSchema,
  v2NativeSurfaceStateSchema,
  type PortalConsoleQueryResult,
  type PortalDiagnostics,
  type PortalDownloadOffer,
  type PortalRuntimeEvent,
  type PortalRuntimeSnapshot,
  type V2NativeSurfaceState,
  type V2PortalAutomationRequest,
  type V2PortalConsoleRequest,
  v2AddEdgeRequestSchema,
  v2AddTerminalRequestSchema,
  v2DirectorySelectionResponseSchema,
  v2MoveNodeRequestSchema,
  v2MoveManyNodesRequestSchema,
  v2DeleteManyNodesRequestSchema,
  v2NodeReferenceSchema,
  v2GroupReferenceSchema,
  v2CreateGroupRequestSchema,
  v2UpdateGroupRequestSchema,
  v2CanvasPasteRequestSchema,
  v2ResizeNodeRequestSchema,
  v2RemoveEdgeRequestSchema,
  v2TerminalEventSchema,
  v2TerminalResizeRequestSchema,
  v2TerminalSessionRequestSchema,
  v2TerminalSessionSchema,
  v2TerminalWriteRequestSchema,
  v2AgentIdRequestSchema,
  v2AgentPresetCreateRequestSchema,
  v2PermissionsRequestSchema,
  v2AttentionReferenceSchema,
  v2TeamUserInputAnswerRequestSchema,
  v2DiagnosticsExportResponseSchema,
  v2NotificationPreferencesRequestSchema,
  v2OperationalNavigationSchema,
  v2PolicyUpdateRequestSchema,
  v2ReassignTaskRequestSchema,
  v2RetryTaskRequestSchema,
  v2RunRecoveryRequestSchema,
  v2RunReferenceSchema,
  v2TaskReferenceSchema,
  v2TeamBoundsSchema,
  v2TeamLayoutRequestSchema,
  v2RoleCreateRequestSchema,
  v2RoleUpdateRequestSchema,
  v2RoleIdRequestSchema,
  v2RoleWorkspaceRequestSchema,
  v2SetAgentExecutableRequestSchema,
  v2ClipboardWriteRequestSchema,
  v2UpdateNodeRequestSchema,
  v2WorkspaceCreateRequestSchema,
  v2WorkspaceIdRequestSchema,
  v2WorkspaceListResponseSchema,
  v2WorkspaceRenameRequestSchema,
  v2WorkspaceUpdateSettingsRequestSchema,
  v2LicenseActivateRequestSchema,
  v2LicenseStatusSchema,
  v2UpdateStatusSchema,
  v2UpdateAutoCheckSchema,
  agentDefinitionSchema,
  agentInstallationSchema,
  agentPresetSchema,
  agentRoleSchema,
  workspacePermissionPolicySchema,
  workspaceOperationalStateSchema,
  workspaceSchema,
  type V2AddNoteRequest,
  type V2AddEdgeRequest,
  type V2AddTerminalRequest,
  type V2MoveNodeRequest,
  type V2MoveManyNodesRequest,
  type V2DeleteManyNodesRequest,
  type V2NodeReference,
  type V2GroupReference,
  type V2CreateGroupRequest,
  type V2UpdateGroupRequest,
  type V2CanvasPasteRequest,
  type V2ResizeNodeRequest,
  type V2RemoveEdgeRequest,
  type V2TerminalEvent,
  type V2TerminalResizeRequest,
  type V2TerminalSessionRequest,
  type V2TerminalWriteRequest,
  type V2UpdateNodeRequest,
  type V2WorkspaceCreateRequest,
  type V2WorkspaceIdRequest,
  type V2WorkspaceRenameRequest,
  type V2WorkspaceUpdateSettingsRequest,
  type V2LicenseActivateRequest,
  type V2LicenseStatus,
  type V2UpdateStatus,
  type TerminalSession,
  type Workspace,
  type WorkspaceSummary,
  type AgentDefinition,
  type AgentInstallation,
  type AgentPreset,
  type AgentRole,
  type V2AgentIdRequest,
  type V2AgentPresetCreateRequest,
  type V2PermissionsRequest,
  type V2AttentionReference,
  type V2TeamUserInputAnswerRequest,
  type V2NotificationPreferencesRequest,
  type V2OperationalNavigation,
  type V2PolicyUpdateRequest,
  type V2ReassignTaskRequest,
  type V2RetryTaskRequest,
  type V2RunRecoveryRequest,
  type V2RunReference,
  type V2TaskReference,
  type V2TeamLayoutRequest,
  type WorkspaceOperationalState,
  type V2RoleCreateRequest,
  type V2RoleUpdateRequest,
  type V2RoleIdRequest,
  type V2RoleWorkspaceRequest,
  type V2SetAgentExecutableRequest
} from "@forgedeck/compazio-v2-domain";
import {
  V2_DIRECTORY_CREATE_CHANNEL,
  V2_FILE_CONTEXT_SEND_CHANNEL,
  V2_FILE_CREATE_CHANNEL,
  V2_FILE_DELETE_CHANNEL,
  V2_FILE_EVENT_CHANNEL,
  V2_FILE_LIST_CHANNEL,
  V2_FILE_PREVIEW_CHANNEL,
  V2_FILE_READ_CHANNEL,
  V2_FILE_RENAME_CHANNEL,
  V2_FILE_SEARCH_CHANNEL,
  V2_FILE_IMPORT_CHANNEL,
  V2_FILE_UNWATCH_CHANNEL,
  V2_FILE_WATCH_CHANNEL,
  V2_FILE_WRITE_CHANNEL,
  V2_GIT_COMMIT_CHANNEL,
  V2_GIT_DIFF_CHANNEL,
  V2_GIT_OPERATION_CHANNEL,
  V2_GIT_STAGE_CHANNEL,
  V2_GIT_STATUS_CHANNEL,
  V2_GIT_UNSTAGE_CHANNEL,
  V2_NODE_ADD_FILE_PREVIEW_CHANNEL,
  V2_NODE_ADD_FILE_TREE_CHANNEL,
  V2_NODE_UPDATE_FILE_PREVIEW_CHANNEL,
  V2_NODE_UPDATE_FILE_TREE_CHANNEL,
  agentFileContextSchema,
  fileEntrySchema,
  filePreviewSchema,
  fileReadResultSchema,
  fileSystemEventSchema,
  gitRepositorySnapshotSchema,
  v2AddFilePreviewRequestSchema,
  v2AddFileTreeRequestSchema,
  v2FileImportRequestSchema,
  v2FileImportResponseSchema,
  v2FileContextSendRequestSchema,
  v2FileCreateRequestSchema,
  v2FileListRequestSchema,
  v2FilePathRequestSchema,
  v2FileRenameRequestSchema,
  v2FileSearchRequestSchema,
  v2FileWatchRequestSchema,
  v2FileWriteRequestSchema,
  v2GitCommitRequestSchema,
  v2GitDiffRequestSchema,
  v2GitOperationRequestSchema,
  v2GitPathsRequestSchema,
  v2UpdateFilePreviewRequestSchema,
  v2UpdateFileTreeRequestSchema,
  type FileEntry,
  type FilePreview,
  type FilePreviewKind,
  type FileReadResult,
  type FileSystemEvent,
  type GitRepositorySnapshot,
  type V2AddFilePreviewRequest,
  type V2AddFileTreeRequest,
  type V2FileContextSendRequest,
  type V2FileCreateRequest,
  type V2FileListRequest,
  type V2FilePathRequest,
  type V2FileRenameRequest,
  type V2FileSearchRequest,
  type V2FileWatchRequest,
  type V2FileWriteRequest,
  type V2GitCommitRequest,
  type V2GitDiffRequest,
  type V2GitOperationRequest,
  type V2GitPathsRequest,
  type V2UpdateFilePreviewRequest,
  type V2UpdateFileTreeRequest,
  type V2AddPortalRequest
} from "@forgedeck/compazio-v2-domain";

export interface CompazioV2Api {
  /** Narrow IPC bridge; renderer code never receives Node/Electron globals. */
  readonly clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
  readonly license: {
    status(): Promise<V2LicenseStatus>;
    activate(input: V2LicenseActivateRequest): Promise<V2LicenseStatus>;
    deactivate(): Promise<void>;
  };
  readonly updates: {
    status(): Promise<V2UpdateStatus>;
    check(): Promise<V2UpdateStatus>;
    download(): Promise<V2UpdateStatus>;
    install(): Promise<void>;
    setAutoCheck(input: { enabled: boolean }): Promise<V2UpdateStatus>;
  };
  readonly workspace: {
    list(): Promise<{
      readonly workspaces: readonly WorkspaceSummary[];
      readonly lastOpenedWorkspaceId: string | null;
    }>;
    create(input: V2WorkspaceCreateRequest): Promise<Workspace>;
    open(input: V2WorkspaceIdRequest): Promise<Workspace>;
    close(input: V2WorkspaceIdRequest): Promise<void>;
    rename(input: V2WorkspaceRenameRequest): Promise<Workspace>;
    updateSettings(input: V2WorkspaceUpdateSettingsRequest): Promise<Workspace>;
    undo(input: V2WorkspaceIdRequest): Promise<Workspace>;
    redo(input: V2WorkspaceIdRequest): Promise<Workspace>;
    delete(input: V2WorkspaceIdRequest): Promise<void>;
    selectDirectory(): Promise<string | null>;
  };
  readonly nodes: {
    addTerminal(input: V2AddTerminalRequest): Promise<Workspace>;
    addNote(input: V2AddNoteRequest): Promise<Workspace>;
    addFileTree(input: V2AddFileTreeRequest): Promise<Workspace>;
    addFilePreview(input: V2AddFilePreviewRequest): Promise<Workspace>;
    addPortal(input: V2AddPortalRequest): Promise<Workspace>;
    updateFileTree(input: V2UpdateFileTreeRequest): Promise<Workspace>;
    updateFilePreview(input: V2UpdateFilePreviewRequest): Promise<Workspace>;
    move(input: V2MoveNodeRequest): Promise<Workspace>;
    moveMany(input: V2MoveManyNodesRequest): Promise<Workspace>;
    resize(input: V2ResizeNodeRequest): Promise<Workspace>;
    update(input: V2UpdateNodeRequest): Promise<Workspace>;
    delete(input: V2NodeReference): Promise<Workspace>;
    deleteMany(input: V2DeleteManyNodesRequest): Promise<Workspace>;
  };
  readonly portals: {
    ensure(input: { workspaceId: string; portalId: string }): Promise<void>;
    setBounds(input: {
      workspaceId: string;
      portalId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      visible: boolean;
      canvasZoom?: number;
    }): Promise<void>;
    navigate(input: { workspaceId: string; portalId: string; url: string }): Promise<void>;
    command(input: {
      workspaceId: string;
      portalId: string;
      action: "back" | "forward" | "reload" | "stop" | "focus";
    }): Promise<void>;
    screenshot(input: { workspaceId: string; portalId: string }): Promise<{ path: string }>;
    automation(input: V2PortalAutomationRequest): Promise<unknown>;
    console(input: V2PortalConsoleRequest): Promise<PortalConsoleQueryResult>;
    cancel(input: { correlationId: string }): Promise<{ cancelled: boolean }>;
    recover(input: {
      workspaceId: string;
      portalId: string;
      mode: "reload" | "recreate";
    }): Promise<PortalRuntimeSnapshot>;
    focus(input: { workspaceId: string; portalId?: string }): Promise<{ released: number }>;
    resetFocus(input: { workspaceId?: string }): Promise<{ released: number }>;
    state(input: {
      workspaceId: string;
      portalId?: string;
    }): Promise<readonly PortalRuntimeSnapshot[]>;
    diagnostics(): Promise<PortalDiagnostics>;
    surface(input: V2NativeSurfaceState): Promise<void>;
    decideDownload(input: {
      requestId: string;
      accepted: boolean;
      destination?: string;
      overwrite?: boolean;
    }): Promise<{ settled: boolean }>;
    onDownloadRequest(listener: (offer: PortalDownloadOffer) => void): () => void;
    onEvent(listener: (event: PortalRuntimeEvent) => void): () => void;
    destroy(input: { workspaceId: string; portalId: string }): Promise<void>;
  };
  readonly edges: {
    add(input: V2AddEdgeRequest): Promise<Workspace>;
    delete(input: V2RemoveEdgeRequest): Promise<Workspace>;
  };
  readonly groups: {
    create(input: V2CreateGroupRequest): Promise<Workspace>;
    update(input: V2UpdateGroupRequest): Promise<Workspace>;
    delete(input: V2GroupReference): Promise<Workspace>;
  };
  readonly canvas: {
    paste(input: V2CanvasPasteRequest): Promise<Workspace>;
  };
  readonly terminal: {
    start(input: V2NodeReference): Promise<TerminalSession>;
    write(input: V2TerminalWriteRequest): Promise<void>;
    resize(input: V2TerminalResizeRequest): Promise<void>;
    stop(input: V2TerminalSessionRequest): Promise<TerminalSession>;
    restart(input: V2TerminalSessionRequest): Promise<TerminalSession>;
    onEvent(listener: (event: V2TerminalEvent) => void): () => void;
  };
  readonly agents: {
    listDefinitions(): Promise<readonly AgentDefinition[]>;
    listPresets(): Promise<readonly AgentPreset[]>;
    detectAll(): Promise<readonly AgentInstallation[]>;
    detectOne(input: V2AgentIdRequest): Promise<AgentInstallation>;
    setExecutablePath(input: V2SetAgentExecutableRequest): Promise<AgentInstallation>;
    clearExecutablePath(input: V2AgentIdRequest): Promise<void>;
    createPreset(input: V2AgentPresetCreateRequest): Promise<AgentPreset>;
    deletePreset(input: V2AgentIdRequest): Promise<void>;
  };
  readonly roles: {
    list(): Promise<readonly AgentRole[]>;
    create(input: V2RoleCreateRequest): Promise<AgentRole>;
    update(input: V2RoleUpdateRequest): Promise<AgentRole>;
    duplicate(input: V2RoleIdRequest): Promise<AgentRole>;
    delete(input: V2RoleIdRequest): Promise<void>;
    discover(input: V2RoleWorkspaceRequest): Promise<readonly AgentRole[]>;
    import(input: V2RoleWorkspaceRequest): Promise<readonly AgentRole[]>;
    export(input: V2RoleWorkspaceRequest): Promise<void>;
  };
  readonly permissions: {
    get(input: V2WorkspaceIdRequest): Promise<Workspace["permissions"]>;
    update(input: V2PermissionsRequest): Promise<Workspace>;
  };
  readonly operations: {
    get(input: V2WorkspaceIdRequest): Promise<WorkspaceOperationalState>;
    onEvent(listener: (state: WorkspaceOperationalState) => void): () => void;
    onNavigate(listener: (target: V2OperationalNavigation) => void): () => void;
  };
  readonly runs: {
    pause(input: V2RunReference): Promise<WorkspaceOperationalState>;
    resume(input: V2RunReference): Promise<WorkspaceOperationalState>;
    cancel(input: V2RunReference): Promise<WorkspaceOperationalState>;
    recover(input: V2RunRecoveryRequest): Promise<WorkspaceOperationalState>;
    deleteTeam(input: V2RunReference): Promise<Workspace>;
  };
  readonly tasks: {
    retry(input: V2RetryTaskRequest): Promise<WorkspaceOperationalState>;
    reassign(input: V2ReassignTaskRequest): Promise<WorkspaceOperationalState>;
    cancel(input: V2TaskReference): Promise<WorkspaceOperationalState>;
  };
  readonly attention: {
    resolve(input: V2AttentionReference): Promise<WorkspaceOperationalState>;
    dismiss(input: V2AttentionReference): Promise<WorkspaceOperationalState>;
  };
  readonly teamUserInput: {
    answer(input: V2TeamUserInputAnswerRequest): Promise<WorkspaceOperationalState>;
  };
  readonly policy: {
    update(input: V2PolicyUpdateRequest): Promise<WorkspaceOperationalState>;
  };
  readonly notifications: {
    update(input: V2NotificationPreferencesRequest): Promise<WorkspaceOperationalState>;
  };
  readonly layout: {
    organizeTeam(input: V2TeamLayoutRequest): Promise<Workspace>;
    restoreTeam(input: V2RunReference): Promise<Workspace>;
    fitTeam(input: V2RunReference): Promise<{
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }>;
  };
  readonly diagnostics: {
    export(input: V2WorkspaceIdRequest): Promise<{
      readonly path: string | null;
      readonly cancelled: boolean;
    }>;
  };
  readonly files: {
    list(input: V2FileListRequest): Promise<readonly FileEntry[]>;
    read(input: V2FilePathRequest): Promise<FileReadResult>;
    write(input: V2FileWriteRequest): Promise<FileReadResult>;
    create(input: V2FileCreateRequest): Promise<FileReadResult>;
    createDirectory(input: V2FilePathRequest): Promise<void>;
    rename(input: V2FileRenameRequest): Promise<void>;
    delete(input: V2FilePathRequest): Promise<void>;
    search(input: V2FileSearchRequest): Promise<readonly FileEntry[]>;
    preview(input: V2FilePathRequest): Promise<FilePreview>;
    /**
     * Traz arquivos do computador para o workspace. Sem `paths`, abre o seletor nativo; com
     * `paths`, aceita o que foi arrastado do explorador. Retorna caminhos relativos ao workspace.
     */
    import(input: {
      workspaceId: string;
      paths?: readonly string[];
    }): Promise<readonly { path: string; previewKind: FilePreviewKind; copied: boolean }[]>;
    /** Caminhos reais dos arquivos de um drop do sistema operacional. */
    pathsFromDrop(files: readonly File[]): readonly string[];
    watch(input: V2FileWatchRequest): Promise<void>;
    unwatch(input: V2FileWatchRequest): Promise<void>;
    sendContext(input: V2FileContextSendRequest): Promise<void>;
    onEvent(listener: (event: FileSystemEvent) => void): () => void;
  };
  readonly git: {
    status(input: V2WorkspaceIdRequest): Promise<GitRepositorySnapshot>;
    diff(input: V2GitDiffRequest): Promise<{ readonly diff: string }>;
    stage(input: V2GitPathsRequest): Promise<GitRepositorySnapshot>;
    unstage(input: V2GitPathsRequest): Promise<GitRepositorySnapshot>;
    commit(input: V2GitCommitRequest): Promise<GitRepositorySnapshot>;
    operation(input: V2GitOperationRequest): Promise<unknown>;
  };
}

const api: CompazioV2Api = {
  clipboard: {
    readText: async () => (await ipcRenderer.invoke(V2_CLIPBOARD_READ_CHANNEL)) as string,
    writeText: async (text) => {
      await ipcRenderer.invoke(
        V2_CLIPBOARD_WRITE_CHANNEL,
        v2ClipboardWriteRequestSchema.parse({ text })
      );
    }
  },
  license: {
    status: async () =>
      v2LicenseStatusSchema.parse(await ipcRenderer.invoke(V2_LICENSE_STATUS_CHANNEL)),
    activate: async (input) =>
      v2LicenseStatusSchema.parse(
        await ipcRenderer.invoke(
          V2_LICENSE_ACTIVATE_CHANNEL,
          v2LicenseActivateRequestSchema.parse(input)
        )
      ),
    deactivate: async () => {
      await ipcRenderer.invoke(V2_LICENSE_DEACTIVATE_CHANNEL);
    }
  },
  updates: {
    status: async () =>
      v2UpdateStatusSchema.parse(await ipcRenderer.invoke(V2_UPDATE_STATUS_CHANNEL)),
    check: async () =>
      v2UpdateStatusSchema.parse(await ipcRenderer.invoke(V2_UPDATE_CHECK_CHANNEL)),
    download: async () =>
      v2UpdateStatusSchema.parse(await ipcRenderer.invoke(V2_UPDATE_DOWNLOAD_CHANNEL)),
    install: async () => {
      await ipcRenderer.invoke(V2_UPDATE_INSTALL_CHANNEL);
    },
    setAutoCheck: async (input) =>
      v2UpdateStatusSchema.parse(
        await ipcRenderer.invoke(V2_UPDATE_AUTO_CHECK_CHANNEL, v2UpdateAutoCheckSchema.parse(input))
      )
  },
  workspace: {
    list: async () =>
      v2WorkspaceListResponseSchema.parse(await ipcRenderer.invoke(V2_WORKSPACE_LIST_CHANNEL)),
    create: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_WORKSPACE_CREATE_CHANNEL,
          v2WorkspaceCreateRequestSchema.parse(input)
        )
      ),
    open: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_WORKSPACE_OPEN_CHANNEL, v2WorkspaceIdRequestSchema.parse(input))
      ),
    close: async (input) => {
      await ipcRenderer.invoke(V2_WORKSPACE_CLOSE_CHANNEL, v2WorkspaceIdRequestSchema.parse(input));
    },
    rename: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_WORKSPACE_RENAME_CHANNEL,
          v2WorkspaceRenameRequestSchema.parse(input)
        )
      ),
    updateSettings: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_WORKSPACE_UPDATE_SETTINGS_CHANNEL,
          v2WorkspaceUpdateSettingsRequestSchema.parse(input)
        )
      ),
    undo: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_WORKSPACE_UNDO_CHANNEL, v2WorkspaceIdRequestSchema.parse(input))
      ),
    redo: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_WORKSPACE_REDO_CHANNEL, v2WorkspaceIdRequestSchema.parse(input))
      ),
    delete: async (input) => {
      await ipcRenderer.invoke(
        V2_WORKSPACE_DELETE_CHANNEL,
        v2WorkspaceIdRequestSchema.parse(input)
      );
    },
    selectDirectory: async () =>
      v2DirectorySelectionResponseSchema.parse(
        await ipcRenderer.invoke(V2_WORKSPACE_SELECT_DIRECTORY_CHANNEL)
      ).directory
  },
  nodes: {
    addTerminal: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_ADD_TERMINAL_CHANNEL,
          v2AddTerminalRequestSchema.parse(input)
        )
      ),
    addNote: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_NODE_ADD_NOTE_CHANNEL, v2AddNoteRequestSchema.parse(input))
      ),
    addPortal: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_NODE_ADD_PORTAL_CHANNEL, v2AddPortalRequestSchema.parse(input))
      ),
    addFileTree: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_ADD_FILE_TREE_CHANNEL,
          v2AddFileTreeRequestSchema.parse(input)
        )
      ),
    addFilePreview: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_ADD_FILE_PREVIEW_CHANNEL,
          v2AddFilePreviewRequestSchema.parse(input)
        )
      ),
    updateFileTree: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_UPDATE_FILE_TREE_CHANNEL,
          v2UpdateFileTreeRequestSchema.parse(input)
        )
      ),
    updateFilePreview: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_UPDATE_FILE_PREVIEW_CHANNEL,
          v2UpdateFilePreviewRequestSchema.parse(input)
        )
      ),
    move: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_NODE_MOVE_CHANNEL, v2MoveNodeRequestSchema.parse(input))
      ),
    moveMany: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_MOVE_MANY_CHANNEL,
          v2MoveManyNodesRequestSchema.parse(input)
        )
      ),
    resize: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_NODE_RESIZE_CHANNEL, v2ResizeNodeRequestSchema.parse(input))
      ),
    update: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_NODE_UPDATE_CHANNEL, v2UpdateNodeRequestSchema.parse(input))
      ),
    delete: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_NODE_DELETE_CHANNEL, v2NodeReferenceSchema.parse(input))
      ),
    deleteMany: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_NODE_DELETE_MANY_CHANNEL,
          v2DeleteManyNodesRequestSchema.parse(input)
        )
      )
  },
  portals: {
    ensure: async (input) => {
      await ipcRenderer.invoke(V2_PORTAL_ENSURE_CHANNEL, v2PortalReferenceSchema.parse(input));
    },
    setBounds: async (input) => {
      await ipcRenderer.invoke(V2_PORTAL_BOUNDS_CHANNEL, v2PortalBoundsRequestSchema.parse(input));
    },
    navigate: async (input) => {
      await ipcRenderer.invoke(
        V2_PORTAL_NAVIGATE_CHANNEL,
        v2PortalNavigateRequestSchema.parse(input)
      );
    },
    command: async (input) => {
      await ipcRenderer.invoke(
        V2_PORTAL_COMMAND_CHANNEL,
        v2PortalCommandRequestSchema.parse(input)
      );
    },
    screenshot: async (input) =>
      ipcRenderer.invoke(V2_PORTAL_SCREENSHOT_CHANNEL, v2PortalReferenceSchema.parse(input)),
    automation: async (input) =>
      ipcRenderer.invoke(
        V2_PORTAL_AUTOMATION_CHANNEL,
        v2PortalAutomationRequestSchema.parse(input)
      ),
    console: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_CONSOLE_CHANNEL,
        v2PortalConsoleRequestSchema.parse(input)
      )) as PortalConsoleQueryResult,
    cancel: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_CANCEL_CHANNEL,
        v2PortalCancelRequestSchema.parse(input)
      )) as { cancelled: boolean },
    recover: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_RECOVER_CHANNEL,
        v2PortalRecoverRequestSchema.parse(input)
      )) as PortalRuntimeSnapshot,
    focus: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_FOCUS_CHANNEL,
        v2PortalFocusRequestSchema.parse(input)
      )) as { released: number },
    resetFocus: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_RESET_FOCUS_CHANNEL,
        v2PortalFocusRequestSchema.parse(input)
      )) as { released: number },
    state: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_STATE_CHANNEL,
        v2PortalFocusRequestSchema.parse(input)
      )) as readonly PortalRuntimeSnapshot[],
    diagnostics: async () =>
      (await ipcRenderer.invoke(V2_PORTAL_DIAGNOSTICS_CHANNEL)) as PortalDiagnostics,
    surface: async (input) => {
      await ipcRenderer.invoke(
        V2_NATIVE_SURFACE_STATE_CHANNEL,
        v2NativeSurfaceStateSchema.parse(input)
      );
    },
    decideDownload: async (input) =>
      (await ipcRenderer.invoke(
        V2_PORTAL_DOWNLOAD_DECISION_CHANNEL,
        v2PortalDownloadDecisionSchema.parse(input)
      )) as { settled: boolean },
    onDownloadRequest: (listener) => {
      const handler = (_event: IpcRendererEvent, offer: unknown): void =>
        listener(offer as PortalDownloadOffer);
      ipcRenderer.on(V2_PORTAL_DOWNLOAD_REQUEST_CHANNEL, handler);
      return () => ipcRenderer.removeListener(V2_PORTAL_DOWNLOAD_REQUEST_CHANNEL, handler);
    },
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void =>
        listener(payload as PortalRuntimeEvent);
      ipcRenderer.on(V2_PORTAL_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(V2_PORTAL_EVENT_CHANNEL, handler);
    },
    destroy: async (input) => {
      await ipcRenderer.invoke(V2_PORTAL_DESTROY_CHANNEL, v2PortalReferenceSchema.parse(input));
    }
  },
  edges: {
    add: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_EDGE_ADD_CHANNEL, v2AddEdgeRequestSchema.parse(input))
      ),
    delete: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_EDGE_DELETE_CHANNEL, v2RemoveEdgeRequestSchema.parse(input))
      )
  },
  groups: {
    create: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_GROUP_CREATE_CHANNEL, v2CreateGroupRequestSchema.parse(input))
      ),
    update: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_GROUP_UPDATE_CHANNEL, v2UpdateGroupRequestSchema.parse(input))
      ),
    delete: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_GROUP_DELETE_CHANNEL, v2GroupReferenceSchema.parse(input))
      )
  },
  canvas: {
    paste: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_CANVAS_PASTE_CHANNEL, v2CanvasPasteRequestSchema.parse(input))
      )
  },
  terminal: {
    start: async (input) =>
      v2TerminalSessionSchema.parse(
        await ipcRenderer.invoke(V2_TERMINAL_START_CHANNEL, v2NodeReferenceSchema.parse(input))
      ),
    write: async (input) => {
      await ipcRenderer.invoke(
        V2_TERMINAL_WRITE_CHANNEL,
        v2TerminalWriteRequestSchema.parse(input)
      );
    },
    resize: async (input) => {
      await ipcRenderer.invoke(
        V2_TERMINAL_RESIZE_CHANNEL,
        v2TerminalResizeRequestSchema.parse(input)
      );
    },
    stop: async (input) =>
      v2TerminalSessionSchema.parse(
        await ipcRenderer.invoke(
          V2_TERMINAL_STOP_CHANNEL,
          v2TerminalSessionRequestSchema.parse(input)
        )
      ),
    restart: async (input) =>
      v2TerminalSessionSchema.parse(
        await ipcRenderer.invoke(
          V2_TERMINAL_RESTART_CHANNEL,
          v2TerminalSessionRequestSchema.parse(input)
        )
      ),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) =>
        listener(v2TerminalEventSchema.parse(payload));
      ipcRenderer.on(V2_TERMINAL_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(V2_TERMINAL_EVENT_CHANNEL, handler);
    }
  },
  agents: {
    listDefinitions: async () =>
      (await ipcRenderer.invoke(V2_AGENT_LIST_DEFINITIONS_CHANNEL)).map((value: unknown) =>
        agentDefinitionSchema.parse(value)
      ),
    listPresets: async () =>
      (await ipcRenderer.invoke(V2_AGENT_LIST_PRESETS_CHANNEL)).map((value: unknown) =>
        agentPresetSchema.parse(value)
      ),
    detectAll: async () =>
      (await ipcRenderer.invoke(V2_AGENT_DETECT_ALL_CHANNEL)).map((value: unknown) =>
        agentInstallationSchema.parse(value)
      ),
    detectOne: async (input) =>
      agentInstallationSchema.parse(
        await ipcRenderer.invoke(V2_AGENT_DETECT_ONE_CHANNEL, v2AgentIdRequestSchema.parse(input))
      ),
    setExecutablePath: async (input) =>
      agentInstallationSchema.parse(
        await ipcRenderer.invoke(
          V2_AGENT_SET_EXECUTABLE_CHANNEL,
          v2SetAgentExecutableRequestSchema.parse(input)
        )
      ),
    clearExecutablePath: async (input) => {
      await ipcRenderer.invoke(
        V2_AGENT_CLEAR_EXECUTABLE_CHANNEL,
        v2AgentIdRequestSchema.parse(input)
      );
    },
    createPreset: async (input) =>
      agentPresetSchema.parse(
        await ipcRenderer.invoke(
          V2_AGENT_CREATE_PRESET_CHANNEL,
          v2AgentPresetCreateRequestSchema.parse(input)
        )
      ),
    deletePreset: async (input) => {
      await ipcRenderer.invoke(V2_AGENT_DELETE_PRESET_CHANNEL, v2AgentIdRequestSchema.parse(input));
    }
  },
  roles: {
    list: async () =>
      (await ipcRenderer.invoke(V2_ROLE_LIST_CHANNEL)).map((value: unknown) =>
        agentRoleSchema.parse(value)
      ),
    create: async (input) =>
      agentRoleSchema.parse(
        await ipcRenderer.invoke(V2_ROLE_CREATE_CHANNEL, v2RoleCreateRequestSchema.parse(input))
      ),
    update: async (input) =>
      agentRoleSchema.parse(
        await ipcRenderer.invoke(V2_ROLE_UPDATE_CHANNEL, v2RoleUpdateRequestSchema.parse(input))
      ),
    duplicate: async (input) =>
      agentRoleSchema.parse(
        await ipcRenderer.invoke(V2_ROLE_DUPLICATE_CHANNEL, v2RoleIdRequestSchema.parse(input))
      ),
    delete: async (input) => {
      await ipcRenderer.invoke(V2_ROLE_DELETE_CHANNEL, v2RoleIdRequestSchema.parse(input));
    },
    discover: async (input) =>
      (
        await ipcRenderer.invoke(
          V2_ROLE_DISCOVER_CHANNEL,
          v2RoleWorkspaceRequestSchema.parse(input)
        )
      ).map((value: unknown) => agentRoleSchema.parse(value)),
    import: async (input) =>
      (
        await ipcRenderer.invoke(V2_ROLE_IMPORT_CHANNEL, v2RoleWorkspaceRequestSchema.parse(input))
      ).map((value: unknown) => agentRoleSchema.parse(value)),
    export: async (input) => {
      await ipcRenderer.invoke(V2_ROLE_EXPORT_CHANNEL, v2RoleWorkspaceRequestSchema.parse(input));
    }
  },
  permissions: {
    get: async (input) =>
      workspacePermissionPolicySchema.parse(
        await ipcRenderer.invoke(
          V2_PERMISSIONS_GET_CHANNEL,
          v2WorkspaceIdRequestSchema.parse(input)
        )
      ),
    update: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_PERMISSIONS_UPDATE_CHANNEL,
          v2PermissionsRequestSchema.parse(input)
        )
      )
  },
  operations: {
    get: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(
          V2_OPERATIONAL_GET_CHANNEL,
          v2WorkspaceIdRequestSchema.parse(input)
        )
      ),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) =>
        listener(workspaceOperationalStateSchema.parse(payload));
      ipcRenderer.on(V2_OPERATIONAL_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(V2_OPERATIONAL_EVENT_CHANNEL, handler);
    },
    onNavigate: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) =>
        listener(v2OperationalNavigationSchema.parse(payload));
      ipcRenderer.on(V2_OPERATIONAL_NAVIGATE_CHANNEL, handler);
      return () => ipcRenderer.removeListener(V2_OPERATIONAL_NAVIGATE_CHANNEL, handler);
    }
  },
  runs: {
    pause: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_RUN_PAUSE_CHANNEL, v2RunReferenceSchema.parse(input))
      ),
    resume: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_RUN_RESUME_CHANNEL, v2RunReferenceSchema.parse(input))
      ),
    cancel: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_RUN_CANCEL_CHANNEL, v2RunReferenceSchema.parse(input))
      ),
    recover: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_RUN_RECOVER_CHANNEL, v2RunRecoveryRequestSchema.parse(input))
      ),
    deleteTeam: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_RUN_DELETE_TEAM_CHANNEL, v2RunReferenceSchema.parse(input))
      )
  },
  tasks: {
    retry: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_TASK_RETRY_CHANNEL, v2RetryTaskRequestSchema.parse(input))
      ),
    reassign: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_TASK_REASSIGN_CHANNEL, v2ReassignTaskRequestSchema.parse(input))
      ),
    cancel: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_TASK_CANCEL_CHANNEL, v2TaskReferenceSchema.parse(input))
      )
  },
  attention: {
    resolve: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(
          V2_ATTENTION_RESOLVE_CHANNEL,
          v2AttentionReferenceSchema.parse(input)
        )
      ),
    dismiss: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(
          V2_ATTENTION_DISMISS_CHANNEL,
          v2AttentionReferenceSchema.parse(input)
        )
      )
  },
  teamUserInput: {
    answer: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(
          V2_TEAM_USER_INPUT_ANSWER_CHANNEL,
          v2TeamUserInputAnswerRequestSchema.parse(input)
        )
      )
  },
  policy: {
    update: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(V2_POLICY_UPDATE_CHANNEL, v2PolicyUpdateRequestSchema.parse(input))
      )
  },
  notifications: {
    update: async (input) =>
      workspaceOperationalStateSchema.parse(
        await ipcRenderer.invoke(
          V2_NOTIFICATION_PREFERENCES_UPDATE_CHANNEL,
          v2NotificationPreferencesRequestSchema.parse(input)
        )
      )
  },
  layout: {
    organizeTeam: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(
          V2_LAYOUT_ORGANIZE_TEAM_CHANNEL,
          v2TeamLayoutRequestSchema.parse(input)
        )
      ),
    restoreTeam: async (input) =>
      workspaceSchema.parse(
        await ipcRenderer.invoke(V2_LAYOUT_RESTORE_TEAM_CHANNEL, v2RunReferenceSchema.parse(input))
      ),
    fitTeam: async (input) =>
      v2TeamBoundsSchema.parse(
        await ipcRenderer.invoke(V2_LAYOUT_FIT_TEAM_CHANNEL, v2RunReferenceSchema.parse(input))
      )
  },
  files: {
    list: async (input) =>
      (await ipcRenderer.invoke(V2_FILE_LIST_CHANNEL, v2FileListRequestSchema.parse(input))).map(
        (value: unknown) => fileEntrySchema.parse(value)
      ),
    read: async (input) =>
      fileReadResultSchema.parse(
        await ipcRenderer.invoke(V2_FILE_READ_CHANNEL, v2FilePathRequestSchema.parse(input))
      ),
    write: async (input) =>
      fileReadResultSchema.parse(
        await ipcRenderer.invoke(V2_FILE_WRITE_CHANNEL, v2FileWriteRequestSchema.parse(input))
      ),
    create: async (input) =>
      fileReadResultSchema.parse(
        await ipcRenderer.invoke(V2_FILE_CREATE_CHANNEL, v2FileCreateRequestSchema.parse(input))
      ),
    createDirectory: async (input) => {
      await ipcRenderer.invoke(V2_DIRECTORY_CREATE_CHANNEL, v2FilePathRequestSchema.parse(input));
    },
    rename: async (input) => {
      await ipcRenderer.invoke(V2_FILE_RENAME_CHANNEL, v2FileRenameRequestSchema.parse(input));
    },
    delete: async (input) => {
      await ipcRenderer.invoke(V2_FILE_DELETE_CHANNEL, v2FilePathRequestSchema.parse(input));
    },
    search: async (input) =>
      (
        await ipcRenderer.invoke(V2_FILE_SEARCH_CHANNEL, v2FileSearchRequestSchema.parse(input))
      ).map((value: unknown) => fileEntrySchema.parse(value)),
    preview: async (input) =>
      filePreviewSchema.parse(
        await ipcRenderer.invoke(V2_FILE_PREVIEW_CHANNEL, v2FilePathRequestSchema.parse(input))
      ),
    import: async (input) =>
      v2FileImportResponseSchema.parse(
        await ipcRenderer.invoke(
          V2_FILE_IMPORT_CHANNEL,
          v2FileImportRequestSchema.parse({
            workspaceId: input.workspaceId,
            ...(input.paths === undefined ? {} : { paths: [...input.paths] })
          })
        )
      ).files,
    pathsFromDrop: (files) =>
      files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== ""),
    watch: async (input) => {
      await ipcRenderer.invoke(V2_FILE_WATCH_CHANNEL, v2FileWatchRequestSchema.parse(input));
    },
    unwatch: async (input) => {
      await ipcRenderer.invoke(V2_FILE_UNWATCH_CHANNEL, v2FileWatchRequestSchema.parse(input));
    },
    sendContext: async (input) => {
      await ipcRenderer.invoke(
        V2_FILE_CONTEXT_SEND_CHANNEL,
        v2FileContextSendRequestSchema.parse({
          ...input,
          context: agentFileContextSchema.parse(input.context)
        })
      );
    },
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) =>
        listener(fileSystemEventSchema.parse(payload));
      ipcRenderer.on(V2_FILE_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(V2_FILE_EVENT_CHANNEL, handler);
    }
  },
  git: {
    status: async (input) =>
      gitRepositorySnapshotSchema.parse(
        await ipcRenderer.invoke(V2_GIT_STATUS_CHANNEL, v2WorkspaceIdRequestSchema.parse(input))
      ),
    diff: async (input) => {
      const value = await ipcRenderer.invoke(
        V2_GIT_DIFF_CHANNEL,
        v2GitDiffRequestSchema.parse(input)
      );
      if (
        typeof value !== "object" ||
        value === null ||
        !("diff" in value) ||
        typeof value.diff !== "string"
      ) {
        throw new Error("Resposta de diff inválida.");
      }
      return { diff: value.diff };
    },
    stage: async (input) =>
      gitRepositorySnapshotSchema.parse(
        await ipcRenderer.invoke(V2_GIT_STAGE_CHANNEL, v2GitPathsRequestSchema.parse(input))
      ),
    unstage: async (input) =>
      gitRepositorySnapshotSchema.parse(
        await ipcRenderer.invoke(V2_GIT_UNSTAGE_CHANNEL, v2GitPathsRequestSchema.parse(input))
      ),
    commit: async (input) =>
      gitRepositorySnapshotSchema.parse(
        await ipcRenderer.invoke(V2_GIT_COMMIT_CHANNEL, v2GitCommitRequestSchema.parse(input))
      ),
    operation: async (input) =>
      ipcRenderer.invoke(V2_GIT_OPERATION_CHANNEL, v2GitOperationRequestSchema.parse(input))
  },
  diagnostics: {
    export: async (input) =>
      v2DiagnosticsExportResponseSchema.parse(
        await ipcRenderer.invoke(
          V2_DIAGNOSTICS_EXPORT_CHANNEL,
          v2WorkspaceIdRequestSchema.parse(input)
        )
      )
  }
};

contextBridge.exposeInMainWorld("compazioV2", api);
