import { z } from "zod";

import {
  agentPresetSchema,
  agentRoleSchema,
  terminalAgentConfigSchema,
  workspacePermissionPolicySchema
} from "./agents";
import {
  canvasNodeSchema,
  edgeCapabilitySchema,
  positionSchema,
  sizeSchema,
  workspaceSettingsSchema,
  terminalLaunchConfigSchema,
  v2TerminalEventSchema,
  v2TerminalSessionSchema,
  workspaceSchema,
  workspaceSummarySchema
} from "./model";
import {
  executionPolicyIdSchema,
  notificationPreferencesSchema,
  workspaceOperationalStateSchema
} from "./operations";
import {
  agentFileContextSchema,
  filePreviewKindSchema,
  fileReadResultSchema,
  fileSystemEventSchema,
  gitRepositorySnapshotSchema,
  workspaceRelativePathSchema
} from "./files";

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const V2_WORKSPACE_LIST_CHANNEL = "compazio-v2:workspace:list";
export const V2_WORKSPACE_CREATE_CHANNEL = "compazio-v2:workspace:create";
export const V2_WORKSPACE_OPEN_CHANNEL = "compazio-v2:workspace:open";
export const V2_WORKSPACE_CLOSE_CHANNEL = "compazio-v2:workspace:close";
export const V2_WORKSPACE_RENAME_CHANNEL = "compazio-v2:workspace:rename";
export const V2_WORKSPACE_DELETE_CHANNEL = "compazio-v2:workspace:delete";
export const V2_WORKSPACE_SELECT_DIRECTORY_CHANNEL = "compazio-v2:workspace:select-directory";
export const V2_WORKSPACE_UPDATE_SETTINGS_CHANNEL = "compazio-v2:workspace:update-settings";
export const V2_WORKSPACE_UNDO_CHANNEL = "compazio-v2:workspace:undo";
export const V2_WORKSPACE_REDO_CHANNEL = "compazio-v2:workspace:redo";
export const V2_LICENSE_STATUS_CHANNEL = "compazio-v2:license:status";
export const V2_LICENSE_ACTIVATE_CHANNEL = "compazio-v2:license:activate";
export const V2_LICENSE_DEACTIVATE_CHANNEL = "compazio-v2:license:deactivate";
export const V2_UPDATE_STATUS_CHANNEL = "compazio-v2:updates:get-status";
export const V2_UPDATE_CHECK_CHANNEL = "compazio-v2:updates:check";
export const V2_UPDATE_DOWNLOAD_CHANNEL = "compazio-v2:updates:download";
export const V2_UPDATE_INSTALL_CHANNEL = "compazio-v2:updates:install";
export const V2_UPDATE_AUTO_CHECK_CHANNEL = "compazio-v2:updates:set-auto-check";
export const V2_CLIPBOARD_READ_CHANNEL = "compazio-v2:clipboard:read-text";
export const V2_CLIPBOARD_WRITE_CHANNEL = "compazio-v2:clipboard:write-text";
export const V2_NODE_ADD_TERMINAL_CHANNEL = "compazio-v2:node:add-terminal";
export const V2_NODE_ADD_NOTE_CHANNEL = "compazio-v2:node:add-note";
export const V2_NODE_ADD_FILE_TREE_CHANNEL = "compazio-v2:node:add-file-tree";
export const V2_NODE_ADD_FILE_PREVIEW_CHANNEL = "compazio-v2:node:add-file-preview";
export const V2_NODE_ADD_PORTAL_CHANNEL = "compazio-v2:node:add-portal";
export const V2_NODE_UPDATE_FILE_TREE_CHANNEL = "compazio-v2:node:update-file-tree";
export const V2_NODE_UPDATE_FILE_PREVIEW_CHANNEL = "compazio-v2:node:update-file-preview";
export const V2_PORTAL_ENSURE_CHANNEL = "compazio-v2:portal:ensure";
export const V2_PORTAL_BOUNDS_CHANNEL = "compazio-v2:portal:bounds";
export const V2_PORTAL_NAVIGATE_CHANNEL = "compazio-v2:portal:navigate";
export const V2_PORTAL_COMMAND_CHANNEL = "compazio-v2:portal:command";
export const V2_PORTAL_SCREENSHOT_CHANNEL = "compazio-v2:portal:screenshot";
export const V2_PORTAL_AUTOMATION_CHANNEL = "compazio-v2:portal:automation";
export const V2_PORTAL_DESTROY_CHANNEL = "compazio-v2:portal:destroy";
export const V2_PORTAL_CONSOLE_CHANNEL = "compazio-v2:portal:console";
export const V2_PORTAL_CANCEL_CHANNEL = "compazio-v2:portal:cancel";
export const V2_PORTAL_RECOVER_CHANNEL = "compazio-v2:portal:recover";
export const V2_PORTAL_FOCUS_CHANNEL = "compazio-v2:portal:focus";
export const V2_PORTAL_RESET_FOCUS_CHANNEL = "compazio-v2:portal:reset-focus";
export const V2_PORTAL_STATE_CHANNEL = "compazio-v2:portal:state";
export const V2_PORTAL_DIAGNOSTICS_CHANNEL = "compazio-v2:portal:diagnostics";
export const V2_NATIVE_SURFACE_STATE_CHANNEL = "compazio-v2:native-surface:state";
export const V2_PORTAL_EVENT_CHANNEL = "compazio-v2:portal:event";
export const V2_PORTAL_DOWNLOAD_REQUEST_CHANNEL = "compazio-v2:portal:download-request";
export const V2_PORTAL_DOWNLOAD_DECISION_CHANNEL = "compazio-v2:portal:download-decision";
export const V2_NODE_MOVE_CHANNEL = "compazio-v2:node:move";
export const V2_NODE_MOVE_MANY_CHANNEL = "compazio-v2:node:move-many";
export const V2_NODE_RESIZE_CHANNEL = "compazio-v2:node:resize";
export const V2_NODE_UPDATE_CHANNEL = "compazio-v2:node:update";
export const V2_NODE_DELETE_CHANNEL = "compazio-v2:node:delete";
export const V2_NODE_DELETE_MANY_CHANNEL = "compazio-v2:node:delete-many";
export const V2_GROUP_CREATE_CHANNEL = "compazio-v2:group:create";
export const V2_GROUP_UPDATE_CHANNEL = "compazio-v2:group:update";
export const V2_GROUP_DELETE_CHANNEL = "compazio-v2:group:delete";
export const V2_CANVAS_PASTE_CHANNEL = "compazio-v2:canvas:paste";
export const V2_EDGE_ADD_CHANNEL = "compazio-v2:edge:add";
export const V2_EDGE_DELETE_CHANNEL = "compazio-v2:edge:delete";
export const V2_TERMINAL_START_CHANNEL = "compazio-v2:terminal:start";
export const V2_TERMINAL_WRITE_CHANNEL = "compazio-v2:terminal:write";
export const V2_TERMINAL_RESIZE_CHANNEL = "compazio-v2:terminal:resize";
export const V2_TERMINAL_STOP_CHANNEL = "compazio-v2:terminal:stop";
export const V2_TERMINAL_RESTART_CHANNEL = "compazio-v2:terminal:restart";
export const V2_TERMINAL_EVENT_CHANNEL = "compazio-v2:terminal:event";
export const V2_AGENT_LIST_DEFINITIONS_CHANNEL = "compazio-v2:agent:list-definitions";
export const V2_AGENT_DETECT_ALL_CHANNEL = "compazio-v2:agent:detect-all";
export const V2_AGENT_DETECT_ONE_CHANNEL = "compazio-v2:agent:detect-one";
export const V2_AGENT_SET_EXECUTABLE_CHANNEL = "compazio-v2:agent:set-executable";
export const V2_AGENT_CLEAR_EXECUTABLE_CHANNEL = "compazio-v2:agent:clear-executable";
export const V2_AGENT_LIST_PRESETS_CHANNEL = "compazio-v2:agent:list-presets";
export const V2_AGENT_CREATE_PRESET_CHANNEL = "compazio-v2:agent:create-preset";
export const V2_AGENT_DELETE_PRESET_CHANNEL = "compazio-v2:agent:delete-preset";
export const V2_ROLE_LIST_CHANNEL = "compazio-v2:role:list";
export const V2_ROLE_CREATE_CHANNEL = "compazio-v2:role:create";
export const V2_ROLE_UPDATE_CHANNEL = "compazio-v2:role:update";
export const V2_ROLE_DUPLICATE_CHANNEL = "compazio-v2:role:duplicate";
export const V2_ROLE_DELETE_CHANNEL = "compazio-v2:role:delete";
export const V2_ROLE_DISCOVER_CHANNEL = "compazio-v2:role:discover";
export const V2_ROLE_IMPORT_CHANNEL = "compazio-v2:role:import";
export const V2_ROLE_EXPORT_CHANNEL = "compazio-v2:role:export";
export const V2_PERMISSIONS_GET_CHANNEL = "compazio-v2:permissions:get";
export const V2_PERMISSIONS_UPDATE_CHANNEL = "compazio-v2:permissions:update";
export const V2_OPERATIONAL_GET_CHANNEL = "compazio-v2:operational:get";
export const V2_OPERATIONAL_EVENT_CHANNEL = "compazio-v2:operational:event";
export const V2_RUN_PAUSE_CHANNEL = "compazio-v2:orchestration:pause";
export const V2_RUN_RESUME_CHANNEL = "compazio-v2:orchestration:resume";
export const V2_RUN_CANCEL_CHANNEL = "compazio-v2:orchestration:cancel";
export const V2_RUN_RECOVER_CHANNEL = "compazio-v2:orchestration:recover";
export const V2_RUN_DELETE_TEAM_CHANNEL = "compazio-v2:orchestration:delete-team";
export const V2_TASK_RETRY_CHANNEL = "compazio-v2:task:retry";
export const V2_TASK_REASSIGN_CHANNEL = "compazio-v2:task:reassign";
export const V2_TASK_CANCEL_CHANNEL = "compazio-v2:task:cancel";
export const V2_ATTENTION_RESOLVE_CHANNEL = "compazio-v2:attention:resolve";
export const V2_ATTENTION_DISMISS_CHANNEL = "compazio-v2:attention:dismiss";
export const V2_TEAM_USER_INPUT_ANSWER_CHANNEL = "compazio-v2:team-user-input:answer";
export const V2_POLICY_UPDATE_CHANNEL = "compazio-v2:policy:update";
export const V2_NOTIFICATION_PREFERENCES_UPDATE_CHANNEL =
  "compazio-v2:notification-preferences:update";
export const V2_LAYOUT_ORGANIZE_TEAM_CHANNEL = "compazio-v2:layout:organize-team";
export const V2_LAYOUT_FIT_TEAM_CHANNEL = "compazio-v2:layout:fit-team";
export const V2_LAYOUT_RESTORE_TEAM_CHANNEL = "compazio-v2:layout:restore-team";
export const V2_DIAGNOSTICS_EXPORT_CHANNEL = "compazio-v2:diagnostics:export";
export const V2_OPERATIONAL_NAVIGATE_CHANNEL = "compazio-v2:operational:navigate";

export const v2AddPortalRequestSchema = z
  .object({
    workspaceId: idSchema,
    title: z.string().trim().min(1).max(240).optional(),
    url: z.string().trim().min(1).max(4_096).optional(),
    sessionMode: z.enum(["isolated", "workspace-shared"]).optional(),
    position: positionSchema.optional()
  })
  .strict();
export type V2AddPortalRequest = z.infer<typeof v2AddPortalRequestSchema>;
export const v2PortalReferenceSchema = z
  .object({ workspaceId: idSchema, portalId: idSchema })
  .strict();
export const v2PortalBoundsRequestSchema = v2PortalReferenceSchema
  .extend({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    visible: z.boolean(),
    // Escala do canvas. A superfície nativa não é afetada pelo transform do mundo, então ela
    // precisa receber o zoom para a página caber no nó em vez de vazar dele.
    canvasZoom: z.number().finite().min(0.1).max(4).optional()
  })
  .strict();
export const v2PortalNavigateRequestSchema = v2PortalReferenceSchema
  .extend({ url: z.string().trim().min(1).max(4_096) })
  .strict();
export const v2PortalCommandRequestSchema = v2PortalReferenceSchema
  .extend({
    action: z.enum(["back", "forward", "reload", "stop", "focus", "blur"]),
    timeoutMs: z.number().int().min(250).max(120_000).optional(),
    correlationId: z.string().trim().min(1).max(120).optional()
  })
  .strict();

/**
 * Automation is described, never scripted: the renderer and the CLI send a locator and an action,
 * so no caller can hand the page a snippet of code to execute.
 */
export const v2PortalLocatorSchema = z
  .object({
    role: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    label: z.string().trim().min(1).max(240).optional(),
    text: z.string().trim().min(1).max(240).optional(),
    selector: z.string().trim().min(1).max(240).optional(),
    coordinates: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
    exact: z.boolean().optional(),
    index: z.number().int().min(0).max(500).optional()
  })
  .strict();

export const v2PortalAutomationRequestSchema = v2PortalReferenceSchema
  .extend({
    action: z.enum([
      "click",
      "type",
      "press",
      "scroll",
      "dom",
      "accessibility",
      "get",
      "focus",
      "viewport"
    ]),
    locator: v2PortalLocatorSchema.optional(),
    text: z.string().max(4_096).optional(),
    clear: z.boolean().optional(),
    key: z.string().trim().min(1).max(32).optional(),
    modifiers: z
      .array(z.enum(["shift", "control", "alt", "meta"]))
      .max(4)
      .optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().int().min(1).max(20_000).optional(),
    query: z.string().trim().min(1).max(240).optional(),
    filter: z
      .object({
        role: z.string().trim().min(1).max(64).optional(),
        name: z.string().trim().min(1).max(240).optional()
      })
      .strict()
      .optional(),
    includeBounds: z.boolean().optional(),
    limits: z
      .object({
        maxNodes: z.number().int().min(1).max(1_500).optional(),
        maxDepth: z.number().int().min(1).max(24).optional(),
        maxChars: z.number().int().min(200).max(120_000).optional(),
        maxTextChars: z.number().int().min(20).max(2_000).optional(),
        maxClasses: z.number().int().min(1).max(16).optional(),
        maxChildren: z.number().int().min(1).max(200).optional()
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(250).max(120_000).optional(),
    correlationId: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export type V2PortalAutomationRequest = z.infer<typeof v2PortalAutomationRequestSchema>;

export const v2PortalConsoleRequestSchema = v2PortalReferenceSchema
  .extend({
    levels: z
      .array(z.enum(["debug", "log", "info", "warning", "error"]))
      .max(5)
      .optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
    since: z.number().int().min(0).optional(),
    sinceTimestamp: z.string().trim().min(1).max(64).optional(),
    contains: z.string().trim().min(1).max(240).optional()
  })
  .strict();

export const v2PortalScreenshotRequestSchema = v2PortalReferenceSchema
  .extend({
    timeoutMs: z.number().int().min(250).max(120_000).optional(),
    correlationId: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export const v2PortalCancelRequestSchema = z
  .object({ correlationId: z.string().trim().min(1).max(120) })
  .strict();

export const v2PortalRecoverRequestSchema = v2PortalReferenceSchema
  .extend({ mode: z.enum(["reload", "recreate"]) })
  .strict();

export const v2PortalFocusRequestSchema = z
  .object({ workspaceId: idSchema, portalId: idSchema.optional() })
  .strict();

export const v2NativeSurfaceStateSchema = z
  .object({
    workspaceId: idSchema.optional(),
    minimized: z.boolean().optional(),
    overlays: z
      .array(
        z.enum([
          "modal",
          "menu",
          "command-palette",
          "prompt-composer",
          "popover",
          "dialog",
          "settings",
          "destructive-confirmation",
          "inspector"
        ])
      )
      .max(9)
      .optional(),
    canvasViewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict();

export const v2PortalDownloadDecisionSchema = z
  .object({
    requestId: z.string().trim().min(1).max(120),
    accepted: z.boolean(),
    destination: z.string().trim().min(1).max(4_096).optional(),
    overwrite: z.boolean().optional()
  })
  .strict();
export const V2_FILE_LIST_CHANNEL = "compazio-v2:file:list";
export const V2_FILE_READ_CHANNEL = "compazio-v2:file:read";
export const V2_FILE_WRITE_CHANNEL = "compazio-v2:file:write";
export const V2_FILE_CREATE_CHANNEL = "compazio-v2:file:create";
export const V2_DIRECTORY_CREATE_CHANNEL = "compazio-v2:directory:create";
export const V2_FILE_RENAME_CHANNEL = "compazio-v2:file:rename";
export const V2_FILE_DELETE_CHANNEL = "compazio-v2:file:delete";
export const V2_FILE_SEARCH_CHANNEL = "compazio-v2:file:search";
export const V2_FILE_PREVIEW_CHANNEL = "compazio-v2:file:preview";
export const V2_FILE_WATCH_CHANNEL = "compazio-v2:file:watch";
export const V2_FILE_UNWATCH_CHANNEL = "compazio-v2:file:unwatch";
export const V2_FILE_IMPORT_CHANNEL = "compazio-v2:file:import";
export const V2_FILE_EVENT_CHANNEL = "compazio-v2:file:event";
export const V2_FILE_CONTEXT_SEND_CHANNEL = "compazio-v2:file-context:send";
export const V2_GIT_STATUS_CHANNEL = "compazio-v2:git:status";
export const V2_GIT_DIFF_CHANNEL = "compazio-v2:git:diff";
export const V2_GIT_STAGE_CHANNEL = "compazio-v2:git:stage";
export const V2_GIT_UNSTAGE_CHANNEL = "compazio-v2:git:unstage";
export const V2_GIT_COMMIT_CHANNEL = "compazio-v2:git:commit";
export const V2_GIT_OPERATION_CHANNEL = "compazio-v2:git:operation";

export const v2WorkspaceIdRequestSchema = z.object({ workspaceId: idSchema }).strict();
export const v2WorkspaceCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    workingDirectory: z.string().trim().min(1).max(4_096)
  })
  .strict();
export const v2WorkspaceRenameRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    name: z.string().trim().min(1).max(240)
  })
  .strict();
export const v2WorkspaceUpdateSettingsRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    settings: workspaceSettingsSchema
  })
  .strict();
export const v2NodeReferenceSchema = v2WorkspaceIdRequestSchema
  .extend({ nodeId: idSchema })
  .strict();
export const v2GroupReferenceSchema = v2WorkspaceIdRequestSchema
  .extend({ groupId: idSchema })
  .strict();
export const v2CreateGroupRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    nodeIds: z.array(idSchema).min(1).max(500),
    position: positionSchema.optional(),
    size: sizeSchema.optional(),
    color: z.enum(["slate", "blue", "purple", "green", "orange"]).optional()
  })
  .strict();
export const v2UpdateGroupRequestSchema = v2GroupReferenceSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    nodeIds: z.array(idSchema).min(1).max(500).optional(),
    position: positionSchema.optional(),
    size: sizeSchema.optional(),
    collapsed: z.boolean().optional(),
    color: z.enum(["slate", "blue", "purple", "green", "orange"]).optional()
  })
  .strict();
export const v2CanvasPasteRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    sourceWorkspaceId: idSchema,
    nodeIds: z.array(idSchema).min(1).max(500),
    position: positionSchema
  })
  .strict();
export const v2AddEdgeRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    sourceNodeId: idSchema,
    targetNodeId: idSchema,
    capabilities: z.array(edgeCapabilitySchema).max(5).optional()
  })
  .strict();
export const v2RemoveEdgeRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ edgeId: idSchema })
  .strict();
export const v2AddTerminalRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    position: positionSchema.optional(),
    size: sizeSchema.optional(),
    workingDirectory: z.string().trim().min(1).max(4_096).optional(),
    launchConfig: terminalLaunchConfigSchema.optional(),
    agentConfig: terminalAgentConfigSchema.optional(),
    isCompazio: z.boolean().optional(),
    orchestrator: z.boolean().optional()
  })
  .strict();
export const v2AddNoteRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    content: z.string().max(1_000_000).optional(),
    position: positionSchema.optional()
  })
  .strict();
export const v2AddFileTreeRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    rootPath: workspaceRelativePathSchema.optional(),
    currentPath: workspaceRelativePathSchema.optional(),
    position: positionSchema.optional()
  })
  .strict();
export const v2AddFilePreviewRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    filePath: workspaceRelativePathSchema,
    previewKind: filePreviewKindSchema,
    fileRevision: z.string().max(256).optional(),
    missing: z.boolean().optional(),
    position: positionSchema.optional()
  })
  .strict();
export const v2UpdateFileTreeRequestSchema = v2NodeReferenceSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    currentPath: workspaceRelativePathSchema.optional(),
    history: z.array(workspaceRelativePathSchema).max(100).optional(),
    historyIndex: z.number().int().min(-1).max(99).optional(),
    viewMode: z.enum(["list", "grid", "diff"]).optional(),
    expandedPaths: z.array(workspaceRelativePathSchema).max(1_000).optional(),
    selectedPath: workspaceRelativePathSchema.optional(),
    searchQuery: z.string().max(240).optional(),
    editor: z
      .object({
        openedPath: workspaceRelativePathSchema.optional(),
        cursorLine: z.number().int().positive().optional(),
        scrollTop: z.number().finite().min(0).optional()
      })
      .strict()
      .optional(),
    diff: z
      .object({
        selectedFile: workspaceRelativePathSchema.optional(),
        selectedHunkId: z.string().max(240).optional(),
        filter: z.enum(["all", "modified", "added", "deleted", "untracked"])
      })
      .strict()
      .optional()
  })
  .strict();
export const v2UpdateFilePreviewRequestSchema = v2NodeReferenceSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    fileRevision: z.string().max(256).optional(),
    missing: z.boolean().optional()
  })
  .strict();
export const v2MoveNodeRequestSchema = v2NodeReferenceSchema
  .extend({ position: positionSchema })
  .strict();
export const v2MoveManyNodesRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    positions: z.record(idSchema, positionSchema)
  })
  .strict();
export const v2DeleteManyNodesRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ nodeIds: z.array(idSchema).min(1).max(500) })
  .strict();
export const v2ResizeNodeRequestSchema = v2NodeReferenceSchema
  .extend({ size: sizeSchema })
  .strict();
export const v2UpdateNodeRequestSchema = v2NodeReferenceSchema
  .extend({
    title: z.string().trim().min(1).max(240).optional(),
    content: z.string().max(1_000_000).optional(),
    workingDirectory: z.string().trim().min(1).max(4_096).optional(),
    launchConfig: terminalLaunchConfigSchema.optional(),
    agentConfig: terminalAgentConfigSchema.optional(),
    isCompazio: z.boolean().optional(),
    orchestrator: z.boolean().optional()
  })
  .strict();
export const v2TerminalWriteRequestSchema = v2NodeReferenceSchema
  .extend({
    sessionId: idSchema,
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
    // A pasted block plus at most three redraw-separated confirmations fits the supervisor's
    // four-frame transaction. OpenCode can require all three to leave its multiline staging view.
    followingData: z.array(z.literal("\r")).min(1).max(3).optional()
  })
  .strict();
export const v2TerminalResizeRequestSchema = v2NodeReferenceSchema
  .extend({
    sessionId: idSchema,
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500)
  })
  .strict();
export const v2TerminalSessionRequestSchema = v2NodeReferenceSchema
  .extend({ sessionId: idSchema })
  .strict();
export const v2DirectorySelectionResponseSchema = z
  .object({ directory: z.string().min(1).nullable() })
  .strict();
export const v2AgentIdRequestSchema = z.object({ agentId: idSchema }).strict();
export const v2ClipboardWriteRequestSchema = z.object({ text: z.string().max(1_000_000) }).strict();
export const v2SetAgentExecutableRequestSchema = v2AgentIdRequestSchema
  .extend({ executablePath: z.string().trim().min(1).max(4_096) })
  .strict();
export const v2AgentPresetCreateRequestSchema = agentPresetSchema
  .omit({ id: true, isBuiltIn: true, createdAt: true, updatedAt: true })
  .strict();
export const v2RoleCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(1_000).optional(),
    instructions: z.string().trim().min(1).max(100_000),
    badge: agentRoleSchema.shape.badge.optional()
  })
  .strict();
export const v2RoleUpdateRequestSchema = agentRoleSchema.strict();
export const v2RoleIdRequestSchema = z.object({ roleId: idSchema }).strict();
export const v2RoleWorkspaceRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ roleIds: z.array(idSchema).min(1).max(100).optional() })
  .strict();
export const v2PermissionsRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ permissions: workspacePermissionPolicySchema })
  .strict();
export const v2RunReferenceSchema = v2WorkspaceIdRequestSchema.extend({ runId: idSchema }).strict();
export const v2TaskReferenceSchema = v2WorkspaceIdRequestSchema
  .extend({ taskId: idSchema })
  .strict();
export const v2RetryTaskRequestSchema = v2TaskReferenceSchema
  .extend({ idempotencyKey: z.string().trim().min(8).max(240) })
  .strict();
export const v2ReassignTaskRequestSchema = v2RetryTaskRequestSchema
  .extend({ terminalId: idSchema })
  .strict();
export const v2AttentionReferenceSchema = v2WorkspaceIdRequestSchema
  .extend({ attentionId: idSchema })
  .strict();
export const v2TeamUserInputAnswerRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    compazioTerminalId: idSchema,
    requestId: idSchema,
    answer: z.string().trim().min(1).max(16_000)
  })
  .strict();
export const v2PolicyUpdateRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ policyId: executionPolicyIdSchema })
  .strict();
export const v2NotificationPreferencesRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ preferences: notificationPreferencesSchema })
  .strict();
export const v2TeamLayoutRequestSchema = v2RunReferenceSchema
  .extend({ force: z.boolean().optional() })
  .strict();
export const v2RunRecoveryRequestSchema = v2RunReferenceSchema
  .extend({
    action: z.enum(["resume", "restart-agents", "end", "canvas-only"]),
    idempotencyKey: z.string().trim().min(8).max(240)
  })
  .strict();
export const v2TeamBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  })
  .strict();
export const v2DiagnosticsExportResponseSchema = z
  .object({ path: z.string().min(1).nullable(), cancelled: z.boolean() })
  .strict();
export const v2FilePathRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ path: workspaceRelativePathSchema })
  .strict();
export const v2FileListRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ path: workspaceRelativePathSchema.optional() })
  .strict();
export const v2FileWriteRequestSchema = v2FilePathRequestSchema
  .extend({
    content: z.string().max(1_048_576),
    expectedRevision: fileReadResultSchema.shape.revision.optional()
  })
  .strict();
export const v2FileCreateRequestSchema = v2FilePathRequestSchema
  .extend({ content: z.string().max(1_048_576).optional() })
  .strict();
export const v2FileRenameRequestSchema = v2FilePathRequestSchema
  .extend({ destinationPath: workspaceRelativePathSchema })
  .strict();
export const v2FileSearchRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    query: z.string().trim().min(1).max(240),
    path: workspaceRelativePathSchema.optional()
  })
  .strict();
/**
 * Trazer um arquivo do computador para o canvas. Sem `paths`, o processo principal abre o seletor
 * nativo — a escolha é sempre de uma pessoa, nunca de um agente. Arquivos de fora do workspace são
 * copiados para dentro dele, para que toda leitura posterior continue dentro do limite conhecido.
 */
export const v2FileImportRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ paths: z.array(z.string().trim().min(1).max(4_096)).max(50).optional() })
  .strict();
export const v2FileImportResponseSchema = z
  .object({
    files: z.array(
      z
        .object({
          path: workspaceRelativePathSchema,
          previewKind: filePreviewKindSchema,
          copied: z.boolean()
        })
        .strict()
    )
  })
  .strict();
export const v2FileWatchRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ treeNodeId: idSchema, path: workspaceRelativePathSchema.optional() })
  .strict();
export const v2FileContextSendRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ sourceNodeId: idSchema, targetTerminalId: idSchema, context: agentFileContextSchema })
  .strict();
export const v2GitDiffRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ path: workspaceRelativePathSchema.optional(), staged: z.boolean().optional() })
  .strict();
export const v2GitPathsRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ paths: z.array(workspaceRelativePathSchema).min(1).max(100) })
  .strict();
export const v2GitCommitRequestSchema = v2WorkspaceIdRequestSchema
  .extend({ message: z.string().trim().min(1).max(240) })
  .strict();
export const v2GitOperationRequestSchema = v2WorkspaceIdRequestSchema
  .extend({
    operation: z.enum([
      "fetch",
      "pull",
      "push",
      "checkout",
      "create-branch",
      "stash",
      "apply-stash",
      "list-stashes"
    ]),
    value: z.string().trim().min(1).max(240).optional()
  })
  .strict();
export const v2OperationalNavigationSchema = z
  .object({
    workspaceId: idSchema,
    runId: idSchema.optional(),
    terminalId: idSchema.optional(),
    openInspector: z.boolean()
  })
  .strict();
export const v2WorkspaceListResponseSchema = z
  .object({
    workspaces: z.array(workspaceSummarySchema),
    lastOpenedWorkspaceId: idSchema.nullable()
  })
  .strict();
export const v2LicenseActivateRequestSchema = z
  .object({ licenseCode: z.string().trim().min(1).max(128) })
  .strict();
export const v2LicenseStatusSchema = z
  .object({
    plan: z.enum(["free", "beta_unlimited"]),
    valid: z.boolean(),
    maxWorkspaces: z.number().int().positive().nullable(),
    installationId: idSchema,
    lastValidatedAt: z.string().datetime().nullable(),
    nextValidationAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    reason: z
      .enum(["none", "expired", "invalid-signature", "wrong-installation", "offline"])
      .optional()
  })
  .strict();
export const v2UpdateStatusSchema = z
  .object({
    state: z.enum([
      "idle",
      "checking",
      "available",
      "not-available",
      "downloading",
      "downloaded",
      "installing",
      "error"
    ]),
    version: z.string().nullable(),
    progress: z.number().min(0).max(100).nullable(),
    error: z.string().nullable(),
    autoCheck: z.boolean()
  })
  .strict();
export const v2UpdateAutoCheckSchema = z.object({ enabled: z.boolean() }).strict();

export type V2WorkspaceCreateRequest = z.infer<typeof v2WorkspaceCreateRequestSchema>;
export type V2WorkspaceIdRequest = z.infer<typeof v2WorkspaceIdRequestSchema>;
export type V2WorkspaceRenameRequest = z.infer<typeof v2WorkspaceRenameRequestSchema>;
export type V2WorkspaceUpdateSettingsRequest = z.infer<
  typeof v2WorkspaceUpdateSettingsRequestSchema
>;
export type V2LicenseActivateRequest = z.infer<typeof v2LicenseActivateRequestSchema>;
export type V2LicenseStatus = z.infer<typeof v2LicenseStatusSchema>;
export type V2UpdateStatus = z.infer<typeof v2UpdateStatusSchema>;
export type V2NodeReference = z.infer<typeof v2NodeReferenceSchema>;
export type V2GroupReference = z.infer<typeof v2GroupReferenceSchema>;
export type V2CreateGroupRequest = z.infer<typeof v2CreateGroupRequestSchema>;
export type V2UpdateGroupRequest = z.infer<typeof v2UpdateGroupRequestSchema>;
export type V2CanvasPasteRequest = z.infer<typeof v2CanvasPasteRequestSchema>;
export type V2AddEdgeRequest = z.infer<typeof v2AddEdgeRequestSchema>;
export type V2RemoveEdgeRequest = z.infer<typeof v2RemoveEdgeRequestSchema>;
export type V2AddTerminalRequest = z.infer<typeof v2AddTerminalRequestSchema>;
export type V2AddNoteRequest = z.infer<typeof v2AddNoteRequestSchema>;
export type V2AddFileTreeRequest = z.infer<typeof v2AddFileTreeRequestSchema>;
export type V2AddFilePreviewRequest = z.infer<typeof v2AddFilePreviewRequestSchema>;
export type V2UpdateFileTreeRequest = z.infer<typeof v2UpdateFileTreeRequestSchema>;
export type V2UpdateFilePreviewRequest = z.infer<typeof v2UpdateFilePreviewRequestSchema>;
export type V2MoveNodeRequest = z.infer<typeof v2MoveNodeRequestSchema>;
export type V2MoveManyNodesRequest = z.infer<typeof v2MoveManyNodesRequestSchema>;
export type V2DeleteManyNodesRequest = z.infer<typeof v2DeleteManyNodesRequestSchema>;
export type V2ResizeNodeRequest = z.infer<typeof v2ResizeNodeRequestSchema>;
export type V2UpdateNodeRequest = z.infer<typeof v2UpdateNodeRequestSchema>;
export type V2TerminalWriteRequest = z.infer<typeof v2TerminalWriteRequestSchema>;
export type V2TerminalResizeRequest = z.infer<typeof v2TerminalResizeRequestSchema>;
export type V2TerminalSessionRequest = z.infer<typeof v2TerminalSessionRequestSchema>;
export type V2AgentIdRequest = z.infer<typeof v2AgentIdRequestSchema>;
export type V2SetAgentExecutableRequest = z.infer<typeof v2SetAgentExecutableRequestSchema>;
export type V2AgentPresetCreateRequest = z.infer<typeof v2AgentPresetCreateRequestSchema>;
export type V2RoleCreateRequest = z.infer<typeof v2RoleCreateRequestSchema>;
export type V2RoleUpdateRequest = z.infer<typeof v2RoleUpdateRequestSchema>;
export type V2RoleIdRequest = z.infer<typeof v2RoleIdRequestSchema>;
export type V2RoleWorkspaceRequest = z.infer<typeof v2RoleWorkspaceRequestSchema>;
export type V2PermissionsRequest = z.infer<typeof v2PermissionsRequestSchema>;
export type V2RunReference = z.infer<typeof v2RunReferenceSchema>;
export type V2TaskReference = z.infer<typeof v2TaskReferenceSchema>;
export type V2RetryTaskRequest = z.infer<typeof v2RetryTaskRequestSchema>;
export type V2ReassignTaskRequest = z.infer<typeof v2ReassignTaskRequestSchema>;
export type V2AttentionReference = z.infer<typeof v2AttentionReferenceSchema>;
export type V2TeamUserInputAnswerRequest = z.infer<typeof v2TeamUserInputAnswerRequestSchema>;
export type V2PolicyUpdateRequest = z.infer<typeof v2PolicyUpdateRequestSchema>;
export type V2NotificationPreferencesRequest = z.infer<
  typeof v2NotificationPreferencesRequestSchema
>;
export type V2TeamLayoutRequest = z.infer<typeof v2TeamLayoutRequestSchema>;
export type V2RunRecoveryRequest = z.infer<typeof v2RunRecoveryRequestSchema>;
export type V2OperationalNavigation = z.infer<typeof v2OperationalNavigationSchema>;
export type V2FilePathRequest = z.infer<typeof v2FilePathRequestSchema>;
export type V2FileListRequest = z.infer<typeof v2FileListRequestSchema>;
export type V2FileWriteRequest = z.infer<typeof v2FileWriteRequestSchema>;
export type V2FileCreateRequest = z.infer<typeof v2FileCreateRequestSchema>;
export type V2FileRenameRequest = z.infer<typeof v2FileRenameRequestSchema>;
export type V2FileSearchRequest = z.infer<typeof v2FileSearchRequestSchema>;
export type V2FileWatchRequest = z.infer<typeof v2FileWatchRequestSchema>;
export type V2FileContextSendRequest = z.infer<typeof v2FileContextSendRequestSchema>;
export type V2GitDiffRequest = z.infer<typeof v2GitDiffRequestSchema>;
export type V2GitPathsRequest = z.infer<typeof v2GitPathsRequestSchema>;
export type V2GitCommitRequest = z.infer<typeof v2GitCommitRequestSchema>;
export type V2GitOperationRequest = z.infer<typeof v2GitOperationRequestSchema>;

export const v2IpcSchemas = {
  workspace: workspaceSchema,
  node: canvasNodeSchema,
  terminalSession: v2TerminalSessionSchema,
  terminalEvent: v2TerminalEventSchema,
  operationalState: workspaceOperationalStateSchema,
  fileEvent: fileSystemEventSchema,
  gitSnapshot: gitRepositorySnapshotSchema
} as const;

export type V2PortalConsoleRequest = z.infer<typeof v2PortalConsoleRequestSchema>;
export type V2NativeSurfaceState = z.infer<typeof v2NativeSurfaceStateSchema>;

/** Shapes the main process answers with. The renderer only reads them; validation stays in main. */
export interface PortalRuntimeSnapshot {
  readonly workspaceId: string;
  readonly portalId: string;
  readonly title: string;
  readonly url: string;
  readonly state:
    "creating" | "loading" | "ready" | "failed" | "crashed" | "destroying" | "destroyed";
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly focused: boolean;
  readonly sessionMode: "isolated" | "workspace-shared";
  readonly partition: string;
  readonly failure: {
    readonly reason: string;
    readonly hint: string;
    readonly lastUrl: string;
  } | null;
  readonly recovery: { readonly attempts: number; readonly exhausted: boolean };
  readonly visible: boolean;
  readonly surface: {
    readonly attached: boolean;
    readonly visible: boolean;
    readonly reason: string;
  };
}

export interface PortalConsoleEntry {
  readonly sequence: number;
  readonly level: "debug" | "log" | "info" | "warning" | "error";
  readonly message: string;
  readonly source: string;
  readonly line: number;
  readonly timestamp: string;
}

export interface PortalConsoleQueryResult {
  readonly entries: readonly PortalConsoleEntry[];
  readonly cursor: number;
  readonly capacity: number;
  readonly stored: number;
  readonly dropped: number;
}

export interface PortalDiagnostics {
  readonly views: number;
  readonly webContents: number;
  readonly listeners: number;
  readonly pendingOperations: number;
  readonly screenshots: number;
  readonly consoleEntries: number;
  readonly sessions: number;
  readonly attachedViews: number;
  readonly focusedPortals: number;
}

export interface PortalDownloadOffer {
  readonly id: string;
  readonly workspaceId: string;
  readonly portalId: string;
  readonly filename: string;
  readonly extension: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly origin: string;
  readonly url: string;
  readonly suggestedDestination: string;
  readonly destinationExists: boolean;
}

export interface PortalRuntimeEvent {
  readonly type: string;
  readonly workspaceId?: string;
  readonly portalId?: string;
  readonly reason?: string;
  readonly lastUrl?: string;
  readonly filename?: string;
}
