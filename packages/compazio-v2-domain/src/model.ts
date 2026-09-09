import { z } from "zod";

import {
  defaultTerminalAgentConfig,
  defaultWorkspacePermissionPolicy,
  roleAssignmentSchema,
  terminalAgentConfigSchema,
  workspacePermissionPolicySchema
} from "./agents";
import {
  filePreviewKindSchema,
  fileTreeViewModeSchema,
  workspaceRelativePathSchema
} from "./files";

export const WORKSPACE_SCHEMA_VERSION = 10;

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid stable id");
const timestampSchema = z.iso.datetime();
const nonEmptyTextSchema = z.string().trim().min(1).max(240);
const environmentKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const processStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting-input",
  "stopping",
  "stopped",
  "completed",
  "failed",
  "disconnected"
]);

export type ProcessState = z.infer<typeof processStateSchema>;

export const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export type Position = z.infer<typeof positionSchema>;

export const sizeSchema = z
  .object({
    width: z.number().finite().min(180).max(4_000),
    height: z.number().finite().min(120).max(3_000)
  })
  .strict();
export type Size = z.infer<typeof sizeSchema>;

export const terminalLaunchConfigSchema = z
  .object({
    shell: z.string().trim().min(1).max(1_024).optional(),
    // This is an executable path, not a shell command line: spaces are legitimate on Windows paths
    // and args stay in their own array. Newlines are rejected to avoid accidental command parsing.
    command: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !/[\r\n]/.test(value), "Command must be an executable")
      .optional(),
    args: z.array(z.string().max(8_192)).max(128),
    env: z.record(environmentKeySchema, z.string().max(8_192)),
    processMode: z.enum(["auto", "pty", "pipe"])
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of Object.keys(value.env)) {
      if (/(token|secret|password|api[_-]?key|credential)/i.test(key)) {
        context.addIssue({
          code: "custom",
          path: ["env", key],
          message: "Terminal launch configuration cannot persist secrets"
        });
      }
    }
  });

export type TerminalLaunchConfig = z.infer<typeof terminalLaunchConfigSchema>;

const baseCanvasNodeSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    position: positionSchema,
    size: sizeSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export const terminalNodeSchema = baseCanvasNodeSchema
  .extend({
    type: z.literal("terminal"),
    title: nonEmptyTextSchema,
    workingDirectory: z.string().trim().min(1).max(4_096),
    launchConfig: terminalLaunchConfigSchema,
    agentConfig: terminalAgentConfigSchema.default(defaultTerminalAgentConfig()),
    /**
     * Enables the narrow, session-scoped Compazio MCP surface for this terminal only.
     * This is the authoritative persisted flag for team coordination.
     */
    isCompazio: z.boolean().default(false),
    /**
     * Legacy Phase 4/5 alias. It is kept until existing workspaces and legacy bridge consumers
     * have been migrated; all new callers must use isCompazio.
     */
    orchestrator: z.boolean().default(false),
    /** A worker recruited by an orchestrator may read only notes its directed edges permit. */
    orchestratorOwnerNodeId: idSchema.optional(),
    /** Runtime-only association. Persistence deliberately strips it before writing. */
    sessionId: idSchema.optional()
  })
  .strict();

export type TerminalNode = z.infer<typeof terminalNodeSchema>;

export const noteNodeSchema = baseCanvasNodeSchema
  .extend({
    type: z.literal("note"),
    title: nonEmptyTextSchema,
    content: z.string().max(1_000_000)
  })
  .strict();

export type NoteNode = z.infer<typeof noteNodeSchema>;

export const fileTreeNodeSchema = baseCanvasNodeSchema
  .extend({
    type: z.literal("file-tree"),
    title: nonEmptyTextSchema,
    /** Root stays relative so the workspace can move between machines. */
    rootPath: workspaceRelativePathSchema.default("."),
    currentPath: workspaceRelativePathSchema.default("."),
    history: z.array(workspaceRelativePathSchema).max(100).default([]),
    historyIndex: z.number().int().min(-1).max(99).default(-1),
    viewMode: fileTreeViewModeSchema.default("list"),
    expandedPaths: z.array(workspaceRelativePathSchema).max(1_000).default([]),
    selectedPath: workspaceRelativePathSchema.optional(),
    searchQuery: z.string().max(240).optional(),
    editor: z
      .object({
        openedPath: workspaceRelativePathSchema.optional(),
        cursorLine: z.number().int().positive().optional(),
        scrollTop: z.number().finite().min(0).optional()
      })
      .strict()
      .default({}),
    diff: z
      .object({
        selectedFile: workspaceRelativePathSchema.optional(),
        selectedHunkId: z.string().max(240).optional(),
        filter: z.enum(["all", "modified", "added", "deleted", "untracked"]).default("all")
      })
      .strict()
      .default({ filter: "all" })
  })
  .strict();

export type FileTreeNode = z.infer<typeof fileTreeNodeSchema>;

export const filePreviewNodeSchema = baseCanvasNodeSchema
  .extend({
    type: z.literal("file-preview"),
    title: nonEmptyTextSchema,
    filePath: workspaceRelativePathSchema,
    previewKind: filePreviewKindSchema,
    fileRevision: z.string().max(256).optional(),
    missing: z.boolean().default(false)
  })
  .strict();

export type FilePreviewNode = z.infer<typeof filePreviewNodeSchema>;

/** Persistent description only. Native views, sessions, cookies and listeners live in main. */
export const portalPersistedStateSchema = z
  .object({
    lastUrl: z.string().max(4_096).optional(),
    lastTitle: z.string().max(512).optional(),
    canGoBack: z.boolean().default(false),
    canGoForward: z.boolean().default(false),
    crashed: z.boolean().default(false)
  })
  .strict();
export type PortalPersistedState = z.infer<typeof portalPersistedStateSchema>;

export const portalNodeSchema = baseCanvasNodeSchema
  .extend({
    type: z.literal("portal"),
    title: nonEmptyTextSchema,
    url: z.string().trim().min(1).max(4_096),
    sessionMode: z.enum(["isolated", "workspace-shared"]),
    // A generated key, never a renderer-provided Electron partition name.
    sessionKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    zoomFactor: z.number().finite().min(0.25).max(5).default(1),
    userAgentOverride: z.string().trim().min(1).max(2_048).optional(),
    lastKnownState: portalPersistedStateSchema.default({
      canGoBack: false,
      canGoForward: false,
      crashed: false
    })
  })
  .strict();
export type PortalNode = z.infer<typeof portalNodeSchema>;

/**
 * A group is persisted separately from canvas nodes: it is a spatial organizer and never owns
 * runtime state. Keeping it serializable lets grouped layouts survive restarts and cross-workspace
 * pastes without carrying terminal sessions, tokens, watchers, or processes with them.
 */
export const canvasGroupSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    title: nonEmptyTextSchema,
    nodeIds: z.array(idSchema).min(1).max(500),
    position: positionSchema,
    size: sizeSchema,
    collapsed: z.boolean().default(false),
    color: z.enum(["slate", "blue", "purple", "green", "orange"]).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export type CanvasGroup = z.infer<typeof canvasGroupSchema>;

export const canvasNodeSchema = z.discriminatedUnion("type", [
  terminalNodeSchema,
  noteNodeSchema,
  fileTreeNodeSchema,
  filePreviewNodeSchema,
  portalNodeSchema
]);
export type CanvasNode = z.infer<typeof canvasNodeSchema>;

/**
 * A canvas edge is an explicit consent boundary. Visual links created before Phase 3 are migrated
 * with no capabilities so they do not silently become a channel for an agent.
 */
export const edgeCapabilitySchema = z.enum([
  "send-message",
  "read-note",
  "write-note",
  "share-context",
  "task-delegate",
  "result-return",
  "review-request",
  "portal-read",
  "portal-control",
  "portal-screenshot",
  "portal-close"
]);
export type EdgeCapability = z.infer<typeof edgeCapabilitySchema>;

export const defaultOrchestrationEdgeCapabilities = (): readonly EdgeCapability[] => [
  "send-message",
  "read-note",
  "write-note",
  "share-context"
];

export const canvasEdgeSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    sourceNodeId: idSchema,
    targetNodeId: idSchema,
    type: z.literal("visual"),
    capabilities: z.array(edgeCapabilitySchema).max(8).default([]),
    createdAt: timestampSchema
  })
  .strict();

export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;

export const workspaceSettingsSchema = z
  .object({
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().finite().min(0.1).max(4)
      })
      .strict()
  })
  .strict();

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const workspaceSchema = z
  .object({
    id: idSchema,
    name: nonEmptyTextSchema,
    workingDirectory: z.string().trim().min(1).max(4_096),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
    groups: z.array(canvasGroupSchema).default([]),
    settings: workspaceSettingsSchema,
    permissions: workspacePermissionPolicySchema.default(defaultWorkspacePermissionPolicy()),
    roleAssignments: z.array(roleAssignmentSchema).default([]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION)
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceSummarySchema = z
  .object({
    id: idSchema,
    name: nonEmptyTextSchema,
    workingDirectory: z.string().trim().min(1).max(4_096),
    updatedAt: timestampSchema
  })
  .strict();

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceIndexSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    workspaceIds: z.array(idSchema),
    lastOpenedWorkspaceId: idSchema.nullable(),
    updatedAt: timestampSchema
  })
  .strict();

export type WorkspaceIndex = z.infer<typeof workspaceIndexSchema>;

export const v2TerminalSessionSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    terminalNodeId: idSchema,
    state: processStateSchema,
    startedAt: timestampSchema.nullable(),
    lastActivityAt: timestampSchema,
    exitCode: z.number().int().nullable(),
    exitSignal: z.number().int().nullable()
  })
  .strict();

export type TerminalSession = z.infer<typeof v2TerminalSessionSchema>;

export const v2TerminalEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal.state"), session: v2TerminalSessionSchema }).strict(),
  z
    .object({
      type: z.literal("terminal.output"),
      sessionId: idSchema,
      terminalNodeId: idSchema,
      data: z.string(),
      timestamp: timestampSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.error"),
      sessionId: idSchema,
      terminalNodeId: idSchema,
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(2_000)
    })
    .strict()
]);

export type V2TerminalEvent = z.infer<typeof v2TerminalEventSchema>;

export const defaultWorkspaceSettings = (): WorkspaceSettings => ({
  viewport: { x: 0, y: 0, zoom: 1 }
});

export const defaultTerminalLaunchConfig = (): TerminalLaunchConfig => ({
  args: [],
  env: {},
  processMode: "auto"
});
