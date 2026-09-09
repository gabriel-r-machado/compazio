import { BrowserWindow, clipboard } from "electron";
import type { IpcMain } from "electron";

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
  V2_EDGE_ADD_CHANNEL,
  V2_EDGE_DELETE_CHANNEL,
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
  v2TerminalResizeRequestSchema,
  v2TerminalSessionRequestSchema,
  v2TerminalWriteRequestSchema,
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
  v2TerminalSessionSchema,
  v2AgentIdRequestSchema,
  v2ClipboardWriteRequestSchema,
  v2AgentPresetCreateRequestSchema,
  v2PermissionsRequestSchema,
  v2AttentionReferenceSchema,
  v2TeamUserInputAnswerRequestSchema,
  v2DiagnosticsExportResponseSchema,
  v2NotificationPreferencesRequestSchema,
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
  workspaceOperationalStateSchema,
  workspaceSchema
} from "@forgedeck/compazio-v2-domain";
import {
  V2_NATIVE_SURFACE_STATE_CHANNEL,
  V2_PORTAL_AUTOMATION_CHANNEL,
  V2_PORTAL_BOUNDS_CHANNEL,
  V2_PORTAL_CANCEL_CHANNEL,
  V2_PORTAL_COMMAND_CHANNEL,
  V2_PORTAL_CONSOLE_CHANNEL,
  V2_PORTAL_DESTROY_CHANNEL,
  V2_PORTAL_DIAGNOSTICS_CHANNEL,
  V2_PORTAL_DOWNLOAD_DECISION_CHANNEL,
  V2_PORTAL_ENSURE_CHANNEL,
  V2_PORTAL_FOCUS_CHANNEL,
  V2_PORTAL_NAVIGATE_CHANNEL,
  V2_PORTAL_RECOVER_CHANNEL,
  V2_PORTAL_RESET_FOCUS_CHANNEL,
  V2_PORTAL_SCREENSHOT_CHANNEL,
  V2_PORTAL_STATE_CHANNEL,
  v2NativeSurfaceStateSchema,
  v2PortalCancelRequestSchema,
  v2PortalConsoleRequestSchema,
  v2PortalDownloadDecisionSchema,
  v2PortalFocusRequestSchema,
  v2PortalRecoverRequestSchema,
  v2PortalScreenshotRequestSchema
} from "@forgedeck/compazio-v2-domain";
import type { V2PortalAutomationRequest } from "@forgedeck/compazio-v2-domain";
import {
  V2_DIRECTORY_CREATE_CHANNEL,
  V2_FILE_CONTEXT_SEND_CHANNEL,
  V2_FILE_CREATE_CHANNEL,
  V2_FILE_DELETE_CHANNEL,
  V2_FILE_LIST_CHANNEL,
  V2_FILE_PREVIEW_CHANNEL,
  V2_FILE_READ_CHANNEL,
  V2_FILE_RENAME_CHANNEL,
  V2_FILE_SEARCH_CHANNEL,
  V2_FILE_UNWATCH_CHANNEL,
  V2_FILE_IMPORT_CHANNEL,
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
  v2AddFilePreviewRequestSchema,
  v2AddFileTreeRequestSchema,
  v2FileContextSendRequestSchema,
  v2FileCreateRequestSchema,
  v2FileListRequestSchema,
  v2FilePathRequestSchema,
  v2FileRenameRequestSchema,
  v2FileSearchRequestSchema,
  v2FileImportRequestSchema,
  v2FileImportResponseSchema,
  v2FileWatchRequestSchema,
  v2FileWriteRequestSchema,
  v2GitCommitRequestSchema,
  v2GitDiffRequestSchema,
  v2GitOperationRequestSchema,
  v2GitPathsRequestSchema,
  v2UpdateFilePreviewRequestSchema,
  v2UpdateFileTreeRequestSchema,
  type AgentFileContext
} from "@forgedeck/compazio-v2-domain";
import {
  agentDefinitionSchema,
  agentInstallationSchema,
  agentPresetSchema,
  agentRoleSchema
} from "@forgedeck/compazio-v2-domain";
import type { AgentRuntime } from "@forgedeck/compazio-v2-runtime";

import type { V2WorkspaceService } from "./workspace-service";
import type { V2OperationalService } from "./operational-service";
import type { FileSystemService } from "./file-system-service";
import type { GitService } from "./git-service";
import type { PortalAutomationInput, PortalRuntimeManager } from "./portal-runtime-manager";
import type { EntitlementService } from "./entitlement-service";
import type { UpdateService } from "./update-service";
import type { V2OrchestratorBridge } from "./orchestrator-bridge";

export interface V2IpcServices {
  readonly workspaces: V2WorkspaceService;
  readonly agents: AgentRuntime;
  readonly operations: V2OperationalService;
  readonly files: FileSystemService;
  readonly git: GitService;
  readonly portals: PortalRuntimeManager;
  readonly entitlement: EntitlementService;
  readonly updates: UpdateService;
  readonly orchestrator?: V2OrchestratorBridge;
  readonly chooseDirectory: () => Promise<string | null>;
  /** Seletor nativo de arquivos, ancorado na pasta do workspace. Só uma pessoa o dispara. */
  readonly chooseFiles: (defaultPath: string) => Promise<readonly string[]>;
  readonly exportDiagnostics: (workspaceId: string) => Promise<string | null>;
}

export function registerV2Ipc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  services: V2IpcServices
): void {
  register(ipc, V2_LICENSE_STATUS_CHANNEL, async () =>
    v2LicenseStatusSchema.parse(await services.entitlement.status())
  );
  register(ipc, V2_LICENSE_ACTIVATE_CHANNEL, async (payload) => {
    const request = v2LicenseActivateRequestSchema.parse(payload);
    return v2LicenseStatusSchema.parse(await services.entitlement.activate(request.licenseCode));
  });
  register(ipc, V2_LICENSE_DEACTIVATE_CHANNEL, async () => {
    await services.entitlement.deactivate();
    return undefined;
  });
  register(ipc, V2_UPDATE_STATUS_CHANNEL, async () =>
    v2UpdateStatusSchema.parse(services.updates.status())
  );
  register(ipc, V2_UPDATE_CHECK_CHANNEL, async () =>
    v2UpdateStatusSchema.parse(await services.updates.check())
  );
  register(ipc, V2_UPDATE_DOWNLOAD_CHANNEL, async () =>
    v2UpdateStatusSchema.parse(await services.updates.download())
  );
  register(ipc, V2_UPDATE_INSTALL_CHANNEL, async () => {
    await services.updates.install();
    return undefined;
  });
  register(ipc, V2_UPDATE_AUTO_CHECK_CHANNEL, async (payload) => {
    const request = v2UpdateAutoCheckSchema.parse(payload);
    return v2UpdateStatusSchema.parse(services.updates.setAutoCheck(request.enabled));
  });
  register(ipc, V2_CLIPBOARD_READ_CHANNEL, async () => clipboard.readText());
  register(ipc, V2_CLIPBOARD_WRITE_CHANNEL, async (payload) => {
    clipboard.writeText(v2ClipboardWriteRequestSchema.parse(payload).text);
    return undefined;
  });
  register(ipc, V2_WORKSPACE_LIST_CHANNEL, async () =>
    v2WorkspaceListResponseSchema.parse(await services.workspaces.list())
  );
  register(ipc, V2_WORKSPACE_CREATE_CHANNEL, async (payload) => {
    const request = v2WorkspaceCreateRequestSchema.parse(payload);
    return workspaceSchema.parse(await services.workspaces.create(request));
  });
  register(ipc, V2_WORKSPACE_OPEN_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    return workspaceSchema.parse(await services.workspaces.open(request.workspaceId));
  });
  register(ipc, V2_WORKSPACE_CLOSE_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    await services.workspaces.close(request.workspaceId);
    await services.files.closeWorkspace(request.workspaceId);
    return undefined;
  });
  register(ipc, V2_WORKSPACE_RENAME_CHANNEL, async (payload) => {
    const request = v2WorkspaceRenameRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.rename(request.workspaceId, request.name)
    );
  });
  register(ipc, V2_WORKSPACE_UPDATE_SETTINGS_CHANNEL, async (payload) => {
    const request = v2WorkspaceUpdateSettingsRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.updateSettings(request.workspaceId, request.settings)
    );
  });
  register(ipc, V2_WORKSPACE_UNDO_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    return workspaceSchema.parse(await services.workspaces.undo(request.workspaceId));
  });
  register(ipc, V2_WORKSPACE_REDO_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    return workspaceSchema.parse(await services.workspaces.redo(request.workspaceId));
  });
  register(ipc, V2_WORKSPACE_DELETE_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    await services.workspaces.deleteWorkspace(request.workspaceId);
    await services.files.closeWorkspace(request.workspaceId);
    services.operations.clearWorkspace(request.workspaceId);
    return undefined;
  });
  register(ipc, V2_WORKSPACE_SELECT_DIRECTORY_CHANNEL, async () =>
    v2DirectorySelectionResponseSchema.parse({ directory: await services.chooseDirectory() })
  );
  register(ipc, V2_AGENT_LIST_DEFINITIONS_CHANNEL, async () =>
    (await services.agents.listDefinitions()).map((definition) =>
      agentDefinitionSchema.parse(definition)
    )
  );
  register(ipc, V2_AGENT_LIST_PRESETS_CHANNEL, async () =>
    (await services.agents.listPresets()).map((preset) => agentPresetSchema.parse(preset))
  );
  register(ipc, V2_AGENT_DETECT_ALL_CHANNEL, async () =>
    (await services.agents.detectAll()).map((installation) =>
      agentInstallationSchema.parse(installation)
    )
  );
  register(ipc, V2_AGENT_DETECT_ONE_CHANNEL, async (payload) => {
    const request = v2AgentIdRequestSchema.parse(payload);
    return agentInstallationSchema.parse(await services.agents.detectOne(request.agentId));
  });
  register(ipc, V2_AGENT_SET_EXECUTABLE_CHANNEL, async (payload) => {
    const request = v2SetAgentExecutableRequestSchema.parse(payload);
    return agentInstallationSchema.parse(
      await services.agents.setExecutablePath(request.agentId, request.executablePath)
    );
  });
  register(ipc, V2_AGENT_CLEAR_EXECUTABLE_CHANNEL, async (payload) => {
    const request = v2AgentIdRequestSchema.parse(payload);
    await services.agents.clearExecutablePath(request.agentId);
    return undefined;
  });
  register(ipc, V2_AGENT_CREATE_PRESET_CHANNEL, async (payload) =>
    agentPresetSchema.parse(
      await services.agents.createPreset(v2AgentPresetCreateRequestSchema.parse(payload))
    )
  );
  register(ipc, V2_AGENT_DELETE_PRESET_CHANNEL, async (payload) => {
    const request = v2AgentIdRequestSchema.parse(payload);
    await services.agents.deletePreset(request.agentId);
    return undefined;
  });
  register(ipc, V2_ROLE_LIST_CHANNEL, async () =>
    (await services.agents.listRoles()).map((role) => agentRoleSchema.parse(role))
  );
  register(ipc, V2_ROLE_CREATE_CHANNEL, async (payload) =>
    agentRoleSchema.parse(
      await services.agents.createRole(v2RoleCreateRequestSchema.parse(payload))
    )
  );
  register(ipc, V2_ROLE_UPDATE_CHANNEL, async (payload) =>
    agentRoleSchema.parse(await services.agents.saveRole(v2RoleUpdateRequestSchema.parse(payload)))
  );
  register(ipc, V2_ROLE_DUPLICATE_CHANNEL, async (payload) => {
    const request = v2RoleIdRequestSchema.parse(payload);
    return agentRoleSchema.parse(await services.agents.duplicateRole(request.roleId));
  });
  register(ipc, V2_ROLE_DELETE_CHANNEL, async (payload) => {
    const request = v2RoleIdRequestSchema.parse(payload);
    if (await services.workspaces.isRoleAssigned(request.roleId)) {
      throw new Error(
        "A responsabilidade está atribuída a um terminal. Remova ou troque a atribuição antes de excluí-la."
      );
    }
    await services.agents.deleteRole(request.roleId);
    return undefined;
  });
  register(ipc, V2_ROLE_DISCOVER_CHANNEL, async (payload) => {
    const request = v2RoleWorkspaceRequestSchema.parse(payload);
    return (
      await services.agents.discoverRepositoryRoles(
        await services.workspaces.workingDirectory(request.workspaceId)
      )
    ).map((role) => agentRoleSchema.parse(role));
  });
  register(ipc, V2_ROLE_IMPORT_CHANNEL, async (payload) => {
    const request = v2RoleWorkspaceRequestSchema.parse(payload);
    return (
      await services.agents.importRepositoryRoles(
        await services.workspaces.workingDirectory(request.workspaceId),
        request.roleIds
      )
    ).map((role) => agentRoleSchema.parse(role));
  });
  register(ipc, V2_ROLE_EXPORT_CHANNEL, async (payload) => {
    const request = v2RoleWorkspaceRequestSchema.parse(payload);
    const roleId = request.roleIds?.[0];
    if (roleId === undefined) throw new Error("A role id is required for export");
    await services.agents.exportRole(
      await services.workspaces.workingDirectory(request.workspaceId),
      roleId
    );
    return undefined;
  });
  register(ipc, V2_PERMISSIONS_GET_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    return (await services.workspaces.open(request.workspaceId)).permissions;
  });
  register(ipc, V2_PERMISSIONS_UPDATE_CHANNEL, async (payload) => {
    const request = v2PermissionsRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.updatePermissions(request.workspaceId, request.permissions)
    );
  });
  register(ipc, V2_NODE_ADD_TERMINAL_CHANNEL, async (payload) => {
    const request = v2AddTerminalRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.addTerminal(request.workspaceId, request)
    );
    const terminal = [...workspace.nodes].reverse().find((node) => node.type === "terminal");
    if (terminal?.type === "terminal" && terminal.isCompazio) {
      await services.operations.recordOperationalEvent({
        workspaceId: request.workspaceId,
        actor: "user",
        type: "compazio.enabled",
        target: terminal.id
      });
    }
    return workspace;
  });
  register(ipc, V2_NODE_ADD_NOTE_CHANNEL, async (payload) => {
    const request = v2AddNoteRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.addNote(request.workspaceId, request)
    );
    const note = [...workspace.nodes].reverse().find((node) => node.type === "note");
    if (note !== undefined) {
      await services.operations.recordNote({
        workspaceId: request.workspaceId,
        actorTerminalId: "user",
        noteId: note.id,
        action: "created"
      });
    }
    return workspace;
  });
  register(ipc, V2_NODE_ADD_PORTAL_CHANNEL, async (payload) => {
    const request = v2AddPortalRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.addPortal(request.workspaceId, request)
    );
    const portal = [...workspace.nodes].reverse().find((node) => node.type === "portal");
    if (portal !== undefined) await services.portals.ensure(request.workspaceId, portal);
    return workspace;
  });
  register(ipc, V2_PORTAL_ENSURE_CHANNEL, async (payload) => {
    const request = v2PortalReferenceSchema.parse(payload);
    const workspace = await services.workspaces.snapshot(request.workspaceId);
    const portal = workspace.nodes.find(
      (node): node is Extract<typeof node, { type: "portal" }> =>
        node.id === request.portalId && node.type === "portal"
    );
    if (portal === undefined) throw new Error("PORTAL_NOT_FOUND");
    return services.portals.ensure(request.workspaceId, portal);
  });
  register(ipc, V2_PORTAL_BOUNDS_CHANNEL, async (payload) => {
    const request = v2PortalBoundsRequestSchema.parse(payload);
    services.portals.setBounds(request.workspaceId, request.portalId, request);
  });
  register(ipc, V2_PORTAL_NAVIGATE_CHANNEL, async (payload) => {
    const request = v2PortalNavigateRequestSchema.parse(payload);
    return services.portals.navigate(request.workspaceId, request.portalId, request.url);
  });
  register(ipc, V2_PORTAL_COMMAND_CHANNEL, async (payload) => {
    const request = v2PortalCommandRequestSchema.parse(payload);
    return services.portals.command(request.workspaceId, request.portalId, request.action, {
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId })
    });
  });
  register(ipc, V2_PORTAL_SCREENSHOT_CHANNEL, async (payload) => {
    const request = v2PortalScreenshotRequestSchema.parse(payload);
    return services.portals.screenshot(request.workspaceId, request.portalId, {
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId })
    });
  });
  register(ipc, V2_PORTAL_AUTOMATION_CHANNEL, async (payload) => {
    const request = v2PortalAutomationRequestSchema.parse(payload);
    return services.portals.automation(
      request.workspaceId,
      request.portalId,
      request.action,
      portalAutomationInput(request),
      {
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId })
      }
    );
  });
  register(ipc, V2_PORTAL_CONSOLE_CHANNEL, async (payload) => {
    const request = v2PortalConsoleRequestSchema.parse(payload);
    return services.portals.consoleMessages(request.workspaceId, request.portalId, {
      ...(request.levels === undefined ? {} : { levels: request.levels }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(request.sinceTimestamp === undefined ? {} : { sinceTimestamp: request.sinceTimestamp }),
      ...(request.contains === undefined ? {} : { contains: request.contains })
    });
  });
  register(ipc, V2_PORTAL_CANCEL_CHANNEL, async (payload) => {
    const request = v2PortalCancelRequestSchema.parse(payload);
    return { cancelled: services.portals.cancel(request.correlationId) };
  });
  register(ipc, V2_PORTAL_RECOVER_CHANNEL, async (payload) => {
    const request = v2PortalRecoverRequestSchema.parse(payload);
    return services.portals.recover(request.workspaceId, request.portalId, request.mode);
  });
  register(ipc, V2_PORTAL_FOCUS_CHANNEL, async (payload) => {
    const request = v2PortalFocusRequestSchema.parse(payload);
    if (request.portalId === undefined)
      return { released: services.portals.resetFocus(request.workspaceId) };
    services.portals.focus(request.workspaceId, request.portalId);
    return { released: 0 };
  });
  register(ipc, V2_PORTAL_RESET_FOCUS_CHANNEL, async (payload) => {
    const request = v2PortalFocusRequestSchema.parse(payload ?? {});
    return { released: services.portals.resetFocus(request.workspaceId) };
  });
  register(ipc, V2_PORTAL_STATE_CHANNEL, async (payload) => {
    const request = v2PortalFocusRequestSchema.parse(payload);
    if (request.portalId === undefined) return services.portals.list(request.workspaceId);
    // A persisted Portal node outlives its native WebContents. During application recovery the
    // renderer can ask for its snapshot one frame before `ensure` recreates the runtime; that is an
    // ordinary empty state, not an IPC error visible in logs or to users.
    return services.portals
      .list(request.workspaceId)
      .filter((portal) => portal.portalId === request.portalId);
  });
  register(ipc, V2_PORTAL_DIAGNOSTICS_CHANNEL, async () => services.portals.diagnostics());
  register(ipc, V2_NATIVE_SURFACE_STATE_CHANNEL, async (payload) => {
    const request = v2NativeSurfaceStateSchema.parse(payload);
    services.portals.setWindowState({
      ...(request.workspaceId === undefined ? {} : { activeWorkspaceId: request.workspaceId }),
      ...(request.minimized === undefined ? {} : { minimized: request.minimized }),
      ...(request.overlays === undefined ? {} : { overlays: request.overlays }),
      ...(request.canvasViewport === undefined ? {} : { canvasViewport: request.canvasViewport })
    });
  });
  register(ipc, V2_PORTAL_DOWNLOAD_DECISION_CHANNEL, async (payload) => {
    const request = v2PortalDownloadDecisionSchema.parse(payload);
    return {
      settled: services.portals.settleDownload({
        requestId: request.requestId,
        accepted: request.accepted,
        ...(request.destination === undefined ? {} : { destination: request.destination }),
        ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite })
      })
    };
  });
  register(ipc, V2_PORTAL_DESTROY_CHANNEL, async (payload) => {
    const request = v2PortalReferenceSchema.parse(payload);
    await services.portals.destroy(request.workspaceId, request.portalId);
  });
  register(ipc, V2_NODE_ADD_FILE_TREE_CHANNEL, async (payload) => {
    const request = v2AddFileTreeRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.addFileTree(request.workspaceId, request)
    );
    const node = [...workspace.nodes].reverse().find((candidate) => candidate.type === "file-tree");
    if (node !== undefined) {
      await services.operations.recordOperationalEvent({
        workspaceId: request.workspaceId,
        type: "file-tree.created",
        target: node.id
      });
    }
    return workspace;
  });
  register(ipc, V2_NODE_ADD_FILE_PREVIEW_CHANNEL, async (payload) => {
    const request = v2AddFilePreviewRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.addFilePreview(request.workspaceId, request)
    );
    const node = [...workspace.nodes]
      .reverse()
      .find((candidate) => candidate.type === "file-preview");
    if (node !== undefined) {
      await services.operations.recordOperationalEvent({
        workspaceId: request.workspaceId,
        type: "file-preview.created",
        target: node.id,
        metadata: { file: request.filePath, kind: request.previewKind }
      });
    }
    return workspace;
  });
  register(ipc, V2_NODE_UPDATE_FILE_TREE_CHANNEL, async (payload) => {
    const request = v2UpdateFileTreeRequestSchema.parse(payload);
    const { workspaceId, nodeId, ...patch } = request;
    return workspaceSchema.parse(
      await services.workspaces.updateFileTree(workspaceId, nodeId, patch)
    );
  });
  register(ipc, V2_NODE_UPDATE_FILE_PREVIEW_CHANNEL, async (payload) => {
    const request = v2UpdateFilePreviewRequestSchema.parse(payload);
    const { workspaceId, nodeId, ...patch } = request;
    return workspaceSchema.parse(
      await services.workspaces.updateFilePreview(workspaceId, nodeId, patch)
    );
  });
  register(ipc, V2_NODE_MOVE_CHANNEL, async (payload) => {
    const request = v2MoveNodeRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.moveNode(request.workspaceId, request.nodeId, request.position)
    );
    await services.operations.markNodeManual(request.workspaceId, request.nodeId);
    return workspace;
  });
  register(ipc, V2_NODE_MOVE_MANY_CHANNEL, async (payload) => {
    const request = v2MoveManyNodesRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.moveNodes(request.workspaceId, request.positions)
    );
    for (const nodeId of Object.keys(request.positions))
      await services.operations.markNodeManual(request.workspaceId, nodeId);
    return workspace;
  });
  register(ipc, V2_NODE_RESIZE_CHANNEL, async (payload) => {
    const request = v2ResizeNodeRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.resizeNode(request.workspaceId, request.nodeId, request.size)
    );
  });
  register(ipc, V2_NODE_UPDATE_CHANNEL, async (payload) => {
    const request = v2UpdateNodeRequestSchema.parse(payload);
    const { workspaceId, nodeId, ...patch } = request;
    const before = await services.workspaces.snapshot(request.workspaceId);
    const previousTerminal = before.nodes.find(
      (node) => node.id === request.nodeId && node.type === "terminal"
    );
    const workspace = workspaceSchema.parse(
      await services.workspaces.updateNode(workspaceId, nodeId, patch)
    );
    const terminal = workspace.nodes.find(
      (node) => node.id === request.nodeId && node.type === "terminal"
    );
    if (
      terminal?.type === "terminal" &&
      previousTerminal?.type === "terminal" &&
      previousTerminal.isCompazio !== terminal.isCompazio
    ) {
      await services.operations.recordOperationalEvent({
        workspaceId: request.workspaceId,
        actor: "user",
        type: terminal.isCompazio ? "compazio.enabled" : "compazio.disabled",
        target: terminal.id
      });
    }
    if (
      workspace.nodes.some((node) => node.id === request.nodeId && node.type === "note") &&
      (request.content !== undefined || request.title !== undefined)
    ) {
      await services.operations.recordNote({
        workspaceId: request.workspaceId,
        actorTerminalId: "user",
        noteId: request.nodeId,
        action: "updated"
      });
    }
    return workspace;
  });
  register(ipc, V2_NODE_DELETE_CHANNEL, async (payload) => {
    const request = v2NodeReferenceSchema.parse(payload);
    const before = await services.workspaces.snapshot(request.workspaceId);
    const node = before.nodes.find((candidate) => candidate.id === request.nodeId);
    const workspace = workspaceSchema.parse(
      await services.workspaces.deleteNode(request.workspaceId, request.nodeId)
    );
    if (node?.type === "file-tree") await services.files.unwatchTree(node.id);
    if (node?.type === "portal") await services.portals.destroy(request.workspaceId, node.id);
    if (node?.type === "terminal")
      await services.operations.recordTerminalDeleted(request.workspaceId, request.nodeId);
    return workspace;
  });
  register(ipc, V2_NODE_DELETE_MANY_CHANNEL, async (payload) => {
    const request = v2DeleteManyNodesRequestSchema.parse(payload);
    const before = await services.workspaces.snapshot(request.workspaceId);
    const selected = before.nodes.filter((node) => request.nodeIds.includes(node.id));
    const workspace = workspaceSchema.parse(
      await services.workspaces.deleteNodes(request.workspaceId, request.nodeIds)
    );
    for (const node of selected) {
      if (node.type === "file-tree") await services.files.unwatchTree(node.id);
      if (node.type === "portal") await services.portals.destroy(request.workspaceId, node.id);
      if (node.type === "terminal")
        await services.operations.recordTerminalDeleted(request.workspaceId, node.id);
    }
    return workspace;
  });
  register(ipc, V2_GROUP_CREATE_CHANNEL, async (payload) => {
    const request = v2CreateGroupRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.createGroup(request.workspaceId, request)
    );
  });
  register(ipc, V2_GROUP_UPDATE_CHANNEL, async (payload) => {
    const request = v2UpdateGroupRequestSchema.parse(payload);
    const { workspaceId, groupId, ...patch } = request;
    return workspaceSchema.parse(
      await services.workspaces.updateGroup(workspaceId, groupId, patch)
    );
  });
  register(ipc, V2_GROUP_DELETE_CHANNEL, async (payload) => {
    const request = v2GroupReferenceSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.removeGroup(request.workspaceId, request.groupId)
    );
  });
  register(ipc, V2_CANVAS_PASTE_CHANNEL, async (payload) => {
    const request = v2CanvasPasteRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.pasteCanvas(
        request.sourceWorkspaceId,
        request.workspaceId,
        request.nodeIds,
        request.position
      )
    );
  });
  register(ipc, V2_EDGE_ADD_CHANNEL, async (payload) => {
    const request = v2AddEdgeRequestSchema.parse(payload);
    const workspace = workspaceSchema.parse(
      await services.workspaces.addEdge(
        request.workspaceId,
        request.sourceNodeId,
        request.targetNodeId,
        request.capabilities
      )
    );
    const edge = [...workspace.edges]
      .reverse()
      .find(
        (candidate) =>
          candidate.sourceNodeId === request.sourceNodeId &&
          candidate.targetNodeId === request.targetNodeId
      );
    if (edge !== undefined) {
      await services.operations.recordEdge({
        workspaceId: request.workspaceId,
        orchestratorTerminalId: "user",
        edgeId: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId
      });
    }
    return workspace;
  });
  register(ipc, V2_EDGE_DELETE_CHANNEL, async (payload) => {
    const request = v2RemoveEdgeRequestSchema.parse(payload);
    return workspaceSchema.parse(
      await services.workspaces.removeEdge(request.workspaceId, request.edgeId)
    );
  });
  register(ipc, V2_TERMINAL_START_CHANNEL, async (payload) => {
    const request = v2NodeReferenceSchema.parse(payload);
    return v2TerminalSessionSchema.parse(
      await services.workspaces.startTerminal(request.workspaceId, request.nodeId)
    );
  });
  register(ipc, V2_TERMINAL_WRITE_CHANNEL, async (payload) => {
    const request = v2TerminalWriteRequestSchema.parse(payload);
    if (request.followingData === undefined) {
      await services.workspaces.writeTerminal(
        request.workspaceId,
        request.nodeId,
        request.sessionId,
        request.data
      );
    } else {
      await services.workspaces.submitTerminalInput(
        request.workspaceId,
        request.nodeId,
        request.sessionId,
        request.data,
        request.followingData
      );
    }
    return undefined;
  });
  register(ipc, V2_TERMINAL_RESIZE_CHANNEL, async (payload) => {
    const request = v2TerminalResizeRequestSchema.parse(payload);
    services.workspaces.resizeTerminal(
      request.workspaceId,
      request.nodeId,
      request.sessionId,
      request.cols,
      request.rows
    );
    return undefined;
  });
  register(ipc, V2_TERMINAL_STOP_CHANNEL, async (payload) => {
    const request = v2TerminalSessionRequestSchema.parse(payload);
    return v2TerminalSessionSchema.parse(
      await services.workspaces.stopTerminal(request.workspaceId, request.nodeId, request.sessionId)
    );
  });
  register(ipc, V2_TERMINAL_RESTART_CHANNEL, async (payload) => {
    const request = v2TerminalSessionRequestSchema.parse(payload);
    return v2TerminalSessionSchema.parse(
      await services.workspaces.restartTerminal(
        request.workspaceId,
        request.nodeId,
        request.sessionId
      )
    );
  });
  register(ipc, V2_OPERATIONAL_GET_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_RUN_PAUSE_CHANNEL, async (payload) => {
    const request = v2RunReferenceSchema.parse(payload);
    await services.operations.pauseRun(request.workspaceId, request.runId);
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_RUN_RESUME_CHANNEL, async (payload) => {
    const request = v2RunReferenceSchema.parse(payload);
    await services.operations.resumeRun(request.workspaceId, request.runId);
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_RUN_CANCEL_CHANNEL, async (payload) => {
    const request = v2RunReferenceSchema.parse(payload);
    await services.operations.cancelRun(request.workspaceId, request.runId);
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_RUN_RECOVER_CHANNEL, async (payload) => {
    const request = v2RunRecoveryRequestSchema.parse(payload);
    await services.operations.recoverRun(
      request.workspaceId,
      request.runId,
      request.action,
      request.idempotencyKey
    );
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_RUN_DELETE_TEAM_CHANNEL, async (payload) => {
    const request = v2RunReferenceSchema.parse(payload);
    await services.operations.deleteTeam(request.workspaceId, request.runId);
    return workspaceSchema.parse(await services.workspaces.snapshot(request.workspaceId));
  });
  register(ipc, V2_TASK_RETRY_CHANNEL, async (payload) => {
    const request = v2RetryTaskRequestSchema.parse(payload);
    await services.operations.retryTask(
      request.workspaceId,
      request.taskId,
      request.idempotencyKey
    );
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_TASK_REASSIGN_CHANNEL, async (payload) => {
    const request = v2ReassignTaskRequestSchema.parse(payload);
    await services.operations.reassignTask(
      request.workspaceId,
      request.taskId,
      request.terminalId,
      request.idempotencyKey
    );
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_TASK_CANCEL_CHANNEL, async (payload) => {
    const request = v2TaskReferenceSchema.parse(payload);
    await services.operations.cancelTask(request.workspaceId, request.taskId);
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_ATTENTION_RESOLVE_CHANNEL, async (payload) => {
    const request = v2AttentionReferenceSchema.parse(payload);
    await services.operations.resolveAttention(
      request.workspaceId,
      request.attentionId,
      "resolved"
    );
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_ATTENTION_DISMISS_CHANNEL, async (payload) => {
    const request = v2AttentionReferenceSchema.parse(payload);
    await services.operations.resolveAttention(
      request.workspaceId,
      request.attentionId,
      "dismissed"
    );
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_TEAM_USER_INPUT_ANSWER_CHANNEL, async (payload) => {
    const request = v2TeamUserInputAnswerRequestSchema.parse(payload);
    if (services.orchestrator === undefined)
      throw new Error("A coordenação de equipe não está disponível.");
    await services.orchestrator.answerTeamUserInput(request);
    return workspaceOperationalStateSchema.parse(
      await services.operations.get(request.workspaceId)
    );
  });
  register(ipc, V2_POLICY_UPDATE_CHANNEL, async (payload) => {
    const request = v2PolicyUpdateRequestSchema.parse(payload);
    return workspaceOperationalStateSchema.parse(
      await services.operations.updatePolicy(request.workspaceId, request.policyId)
    );
  });
  register(ipc, V2_NOTIFICATION_PREFERENCES_UPDATE_CHANNEL, async (payload) => {
    const request = v2NotificationPreferencesRequestSchema.parse(payload);
    return workspaceOperationalStateSchema.parse(
      await services.operations.updateNotificationPreferences(
        request.workspaceId,
        request.preferences
      )
    );
  });
  register(ipc, V2_LAYOUT_ORGANIZE_TEAM_CHANNEL, async (payload) => {
    const request = v2TeamLayoutRequestSchema.parse(payload);
    await services.operations.organizeTeam(
      request.workspaceId,
      request.runId,
      request.force ?? false
    );
    return workspaceSchema.parse(await services.workspaces.snapshot(request.workspaceId));
  });
  register(ipc, V2_LAYOUT_RESTORE_TEAM_CHANNEL, async (payload) => {
    const request = v2RunReferenceSchema.parse(payload);
    await services.operations.organizeTeam(request.workspaceId, request.runId, true);
    return workspaceSchema.parse(await services.workspaces.snapshot(request.workspaceId));
  });
  register(ipc, V2_LAYOUT_FIT_TEAM_CHANNEL, async (payload) => {
    const request = v2RunReferenceSchema.parse(payload);
    return v2TeamBoundsSchema.parse(
      await services.operations.teamBounds(request.workspaceId, request.runId)
    );
  });
  register(ipc, V2_FILE_LIST_CHANNEL, async (payload) => {
    const request = v2FileListRequestSchema.parse(payload);
    return services.files.list(request.workspaceId, request.path);
  });
  register(ipc, V2_FILE_READ_CHANNEL, async (payload) => {
    const request = v2FilePathRequestSchema.parse(payload);
    const result = await services.files.read(request.workspaceId, request.path);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "file.opened",
      target: request.path,
      metadata: { file: request.path }
    });
    return result;
  });
  register(ipc, V2_FILE_WRITE_CHANNEL, async (payload) => {
    const request = v2FileWriteRequestSchema.parse(payload);
    const result = await services.files.write(
      request.workspaceId,
      request.path,
      request.content,
      request.expectedRevision
    );
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "file.saved",
      target: request.path,
      metadata: { file: request.path, bytes: request.content.length }
    });
    return result;
  });
  register(ipc, V2_FILE_CREATE_CHANNEL, async (payload) => {
    const request = v2FileCreateRequestSchema.parse(payload);
    const result = await services.files.createFile(
      request.workspaceId,
      request.path,
      request.content
    );
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "file.saved",
      target: request.path,
      metadata: { file: request.path, created: true }
    });
    return result;
  });
  register(ipc, V2_DIRECTORY_CREATE_CHANNEL, async (payload) => {
    const request = v2FilePathRequestSchema.parse(payload);
    await services.files.createDirectory(request.workspaceId, request.path);
    return undefined;
  });
  register(ipc, V2_FILE_RENAME_CHANNEL, async (payload) => {
    const request = v2FileRenameRequestSchema.parse(payload);
    await services.files.rename(request.workspaceId, request.path, request.destinationPath);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "file.renamed",
      target: request.path,
      metadata: { file: request.path, destination: request.destinationPath }
    });
    return undefined;
  });
  register(ipc, V2_FILE_DELETE_CHANNEL, async (payload) => {
    const request = v2FilePathRequestSchema.parse(payload);
    await services.files.remove(request.workspaceId, request.path);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "file.deleted",
      target: request.path,
      metadata: { file: request.path }
    });
    return undefined;
  });
  register(ipc, V2_FILE_SEARCH_CHANNEL, async (payload) => {
    const request = v2FileSearchRequestSchema.parse(payload);
    return services.files.search(request.workspaceId, request.query, request.path);
  });
  register(ipc, V2_FILE_PREVIEW_CHANNEL, async (payload) => {
    const request = v2FilePathRequestSchema.parse(payload);
    return services.files.preview(request.workspaceId, request.path);
  });
  register(ipc, V2_FILE_IMPORT_CHANNEL, async (payload) => {
    const request = v2FileImportRequestSchema.parse(payload);
    const workspace = await services.workspaces.open(request.workspaceId);
    const chosen = request.paths ?? (await services.chooseFiles(workspace.workingDirectory));
    if (chosen.length === 0) return v2FileImportResponseSchema.parse({ files: [] });
    return v2FileImportResponseSchema.parse({
      files: await services.files.importFiles(request.workspaceId, chosen)
    });
  });
  register(ipc, V2_FILE_WATCH_CHANNEL, async (payload) => {
    const request = v2FileWatchRequestSchema.parse(payload);
    await services.files.watchTree(request.workspaceId, request.treeNodeId, request.path);
    return undefined;
  });
  register(ipc, V2_FILE_UNWATCH_CHANNEL, async (payload) => {
    const request = v2FileWatchRequestSchema.parse(payload);
    await services.files.unwatchTree(request.treeNodeId);
    return undefined;
  });
  register(ipc, V2_FILE_CONTEXT_SEND_CHANNEL, async (payload) => {
    const request = v2FileContextSendRequestSchema.parse(payload);
    await sendFileContext(
      services,
      request.workspaceId,
      request.sourceNodeId,
      request.targetTerminalId,
      request.context
    );
    return undefined;
  });
  register(ipc, V2_GIT_STATUS_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    const result = await services.git.status(request.workspaceId);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "git.status.updated",
      target: "git"
    });
    return result;
  });
  register(ipc, V2_GIT_DIFF_CHANNEL, async (payload) => {
    const request = v2GitDiffRequestSchema.parse(payload);
    const result = await services.git.diff(request.workspaceId, request.path, request.staged);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "diff.opened",
      target: request.path ?? "git"
    });
    return { diff: result };
  });
  register(ipc, V2_GIT_STAGE_CHANNEL, async (payload) => {
    const request = v2GitPathsRequestSchema.parse(payload);
    const result = await services.git.stage(request.workspaceId, request.paths);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "git.stage",
      target: "git",
      metadata: { count: request.paths.length }
    });
    return result;
  });
  register(ipc, V2_GIT_UNSTAGE_CHANNEL, async (payload) => {
    const request = v2GitPathsRequestSchema.parse(payload);
    const result = await services.git.unstage(request.workspaceId, request.paths);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "git.unstage",
      target: "git",
      metadata: { count: request.paths.length }
    });
    return result;
  });
  register(ipc, V2_GIT_COMMIT_CHANNEL, async (payload) => {
    const request = v2GitCommitRequestSchema.parse(payload);
    const result = await services.git.commit(request.workspaceId, request.message);
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: "git.commit",
      target: "git"
    });
    return result;
  });
  register(ipc, V2_GIT_OPERATION_CHANNEL, async (payload) => {
    const request = v2GitOperationRequestSchema.parse(payload);
    const result = await runGitOperation(
      services.git,
      request.workspaceId,
      request.operation,
      request.value
    );
    const eventByOperation = {
      fetch: "git.fetch",
      pull: "git.pull",
      push: "git.push",
      checkout: "git.checkout",
      "create-branch": "git.branch.created",
      stash: "git.stash.created",
      "apply-stash": "git.stash.created",
      "list-stashes": "git.status.updated"
    } as const;
    await services.operations.recordOperationalEvent({
      workspaceId: request.workspaceId,
      type: eventByOperation[request.operation],
      target: "git"
    });
    return result;
  });
  register(ipc, V2_DIAGNOSTICS_EXPORT_CHANNEL, async (payload) => {
    const request = v2WorkspaceIdRequestSchema.parse(payload);
    const path = await services.exportDiagnostics(request.workspaceId);
    return v2DiagnosticsExportResponseSchema.parse({ path, cancelled: path === null });
  });
}

export function publishV2TerminalEvents(workspaces: V2WorkspaceService): () => void {
  return workspaces.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("compazio-v2:terminal:event", event);
  });
}

export function publishV2OperationalEvents(operations: V2OperationalService): () => void {
  return operations.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send(V2_OPERATIONAL_EVENT_CHANNEL, state);
  });
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => Promise<unknown>
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}

async function sendFileContext(
  services: V2IpcServices,
  workspaceId: string,
  sourceNodeId: string,
  targetTerminalId: string,
  context: AgentFileContext
): Promise<void> {
  const workspace = await services.workspaces.snapshot(workspaceId);
  const source = workspace.nodes.find((node) => node.id === sourceNodeId);
  const target = workspace.nodes.find((node) => node.id === targetTerminalId);
  if (source === undefined || !["file-tree", "file-preview"].includes(source.type)) {
    throw new Error("O contexto precisa partir de uma árvore ou preview de arquivo.");
  }
  if (target?.type !== "terminal")
    throw new Error("Escolha um terminal válido para receber o contexto.");
  const connected = workspace.edges.some(
    (edge) =>
      ((edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetTerminalId) ||
        (edge.targetNodeId === sourceNodeId && edge.sourceNodeId === targetTerminalId)) &&
      edge.capabilities.includes("share-context")
  );
  if (!connected)
    throw new Error("Conecte a árvore de arquivos ao terminal antes de compartilhar contexto.");
  const payload = formatAgentFileContext(context);
  await services.workspaces.sendContextToTerminal(workspaceId, targetTerminalId, payload);
  await services.operations.recordOperationalEvent({
    workspaceId,
    type: context.kind === "diff" ? "diff.sent-to-agent" : "file-context.sent",
    target: targetTerminalId,
    metadata: { kind: context.kind, file: context.relativePath }
  });
}

function formatAgentFileContext(context: AgentFileContext): string {
  const details = [
    "[Compazio: contexto de arquivo autorizado pelo usuário]",
    `tipo: ${context.kind}`,
    `arquivo: ${context.relativePath}`,
    ...(context.startLine === undefined
      ? []
      : [`linhas: ${context.startLine}-${context.endLine ?? context.startLine}`]),
    ...(context.revision === undefined ? [] : [`revisão: ${context.revision.hash.slice(0, 12)}`]),
    ...(context.contentPreview === undefined ? [] : ["conteúdo:", context.contentPreview]),
    ...(context.diff === undefined ? [] : ["diff:", context.diff])
  ];
  return details.join("\n").slice(0, 64 * 1_024);
}

async function runGitOperation(
  git: GitService,
  workspaceId: string,
  operation:
    | "fetch"
    | "pull"
    | "push"
    | "checkout"
    | "create-branch"
    | "stash"
    | "apply-stash"
    | "list-stashes",
  value: string | undefined
): Promise<unknown> {
  switch (operation) {
    case "fetch":
      return git.fetch(workspaceId);
    case "pull":
      return git.pull(workspaceId);
    case "push":
      return git.push(workspaceId);
    case "checkout":
      if (value === undefined) throw new Error("Informe a branch para checkout.");
      return git.checkout(workspaceId, value);
    case "create-branch":
      if (value === undefined) throw new Error("Informe o nome da nova branch.");
      return git.createBranch(workspaceId, value);
    case "stash":
      return git.stash(workspaceId, value);
    case "apply-stash":
      return git.applyStash(workspaceId, value);
    case "list-stashes":
      return git.listStashes(workspaceId);
  }
}

/** Maps the validated IPC payload to the runtime's locator-first automation input. */
function portalAutomationInput(request: V2PortalAutomationRequest): PortalAutomationInput {
  const locator = request.locator ?? {};
  return {
    ...(locator.role === undefined ? {} : { role: locator.role }),
    ...(locator.name === undefined ? {} : { name: locator.name }),
    ...(locator.label === undefined ? {} : { label: locator.label }),
    ...(locator.text === undefined ? {} : { text: locator.text }),
    ...(locator.selector === undefined ? {} : { selector: locator.selector }),
    ...(locator.coordinates === undefined ? {} : { coordinates: locator.coordinates }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.index === undefined ? {} : { index: locator.index }),
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.clear === undefined ? {} : { clear: request.clear }),
    ...(request.key === undefined ? {} : { key: request.key }),
    ...(request.modifiers === undefined ? {} : { modifiers: request.modifiers }),
    ...(request.direction === undefined ? {} : { direction: request.direction }),
    ...(request.amount === undefined ? {} : { amount: request.amount }),
    ...(request.query === undefined ? {} : { query: request.query }),
    ...(request.filter === undefined ? {} : { filter: definedOnly(request.filter) }),
    ...(request.includeBounds === undefined ? {} : { includeBounds: request.includeBounds }),
    ...(request.limits === undefined ? {} : { limits: definedOnly(request.limits) })
  };
}

/** Zod leaves optional keys present as `undefined`; the runtime contract wants them absent. */
function definedOnly<T extends Record<string, unknown>>(
  value: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
