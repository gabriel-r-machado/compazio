import { z } from "zod";

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid stable id");
const timestampSchema = z.iso.datetime();
const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "A path cannot contain a null byte")
  .refine((value) => !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value), "A path must be relative")
  .refine(
    (value) => !value.split(/[\\/]+/).some((part) => part === ".."),
    "A path cannot escape the workspace"
  );

/** Paths persisted in canvas nodes are always workspace-relative ("." is the tree root). */
export const workspaceRelativePathSchema = z.union([z.literal("."), relativePathSchema]);
export type WorkspaceRelativePath = z.infer<typeof workspaceRelativePathSchema>;

export const fileTreeViewModeSchema = z.enum(["list", "grid", "diff"]);
export type FileTreeViewMode = z.infer<typeof fileTreeViewModeSchema>;

export const filePreviewKindSchema = z.enum(["image", "pdf", "video", "text", "unsupported"]);
export type FilePreviewKind = z.infer<typeof filePreviewKindSchema>;

export const fileKindSchema = z.enum(["file", "directory"]);
export type FileKind = z.infer<typeof fileKindSchema>;

export const fileEntrySchema = z
  .object({
    path: workspaceRelativePathSchema,
    name: z.string().min(1).max(255),
    kind: fileKindSchema,
    size: z.number().int().min(0),
    modifiedAt: timestampSchema,
    hidden: z.boolean(),
    previewKind: filePreviewKindSchema.optional()
  })
  .strict();
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileRevisionSchema = z
  .object({
    modifiedAt: timestampSchema,
    size: z.number().int().min(0),
    hash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type FileRevision = z.infer<typeof fileRevisionSchema>;

export const fileReadResultSchema = z
  .object({
    path: workspaceRelativePathSchema,
    content: z.string().max(1_048_576),
    revision: fileRevisionSchema,
    encoding: z.literal("utf8")
  })
  .strict();
export type FileReadResult = z.infer<typeof fileReadResultSchema>;

export const filePreviewSchema = z
  .object({
    path: workspaceRelativePathSchema,
    kind: filePreviewKindSchema,
    missing: z.boolean(),
    dataUrl: z.string().max(8_000_000).optional(),
    textPreview: z.string().max(32_000).optional()
  })
  .strict();
export type FilePreview = z.infer<typeof filePreviewSchema>;

export const gitFileStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "ignored",
  "conflicted"
]);
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;

export const gitChangedFileSchema = z
  .object({
    path: workspaceRelativePathSchema,
    status: gitFileStatusSchema,
    staged: z.boolean(),
    originalPath: workspaceRelativePathSchema.optional()
  })
  .strict();
export type GitChangedFile = z.infer<typeof gitChangedFileSchema>;

export const gitRepositorySnapshotSchema = z
  .object({
    repositoryRoot: workspaceRelativePathSchema,
    branch: z.string().min(1).max(256).optional(),
    detached: z.boolean(),
    ahead: z.number().int().min(0),
    behind: z.number().int().min(0),
    files: z.array(gitChangedFileSchema).max(10_000),
    updatedAt: timestampSchema
  })
  .strict();
export type GitRepositorySnapshot = z.infer<typeof gitRepositorySnapshotSchema>;

export const fileSelectionContextSchema = z
  .object({
    workspaceId: idSchema,
    fileTreeNodeId: idSchema,
    filePath: workspaceRelativePathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    selectedText: z.string().max(16_000).optional(),
    diffHunkId: z.string().max(240).optional(),
    diffText: z.string().max(64_000).optional(),
    revision: fileRevisionSchema.optional()
  })
  .strict();
export type FileSelectionContext = z.infer<typeof fileSelectionContextSchema>;

export const agentFileContextSchema = z
  .object({
    kind: z.enum(["file", "directory", "selection", "diff", "image", "pdf"]),
    workspaceId: idSchema,
    path: workspaceRelativePathSchema,
    relativePath: workspaceRelativePathSchema,
    revision: fileRevisionSchema.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    contentPreview: z.string().max(16_000).optional(),
    diff: z.string().max(64_000).optional(),
    metadata: z.record(z.string().max(100), z.string().max(1_000)).optional()
  })
  .strict();
export type AgentFileContext = z.infer<typeof agentFileContextSchema>;

export const fileSystemEventSchema = z
  .object({
    workspaceId: idSchema,
    treeNodeId: idSchema,
    type: z.enum(["changed", "renamed", "deleted", "error"]),
    path: workspaceRelativePathSchema.optional(),
    timestamp: timestampSchema
  })
  .strict();
export type FileSystemEvent = z.infer<typeof fileSystemEventSchema>;
