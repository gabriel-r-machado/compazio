import { z } from "zod";

import { canvasNodeSchema } from "./ipc/canvas";

export const WORKSPACE_NOTE_EVENT_CHANNEL = "workspace-note:event" as const;

export const workspaceNoteEventTypeSchema = z.enum([
  "note_created",
  "note_appended",
  "note_written"
]);
export const workspaceNoteContentSchema = z.string().max(100_000);
export const workspaceNoteAppendContentSchema = z.string().min(1).max(20_000);

export const createWorkspaceNoteSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    content: workspaceNoteContentSchema,
    createdByNodeId: z.string().min(1).max(160).nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

export const appendWorkspaceNoteSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    noteId: z.string().uuid(),
    content: workspaceNoteAppendContentSchema,
    appendedByNodeId: z.string().min(1).max(160).nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

/** Replaces a note's whole content — what an agent does when it rewrites a document. */
export const writeWorkspaceNoteSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    noteId: z.string().uuid(),
    content: workspaceNoteContentSchema,
    writtenByNodeId: z.string().min(1).max(160).nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

export const workspaceNoteSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    content: workspaceNoteContentSchema,
    revision: z.number().int().positive(),
    createdByNodeId: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const workspaceNoteCanvasEventSchema = z
  .object({
    id: z.string().uuid(),
    type: workspaceNoteEventTypeSchema,
    note: workspaceNoteSchema,
    node: canvasNodeSchema,
    canvasRevision: z.number().int().positive()
  })
  .strict();

export type WorkspaceNoteEventType = z.infer<typeof workspaceNoteEventTypeSchema>;
export type CreateWorkspaceNote = z.infer<typeof createWorkspaceNoteSchema>;
export type AppendWorkspaceNote = z.infer<typeof appendWorkspaceNoteSchema>;
export type WriteWorkspaceNote = z.infer<typeof writeWorkspaceNoteSchema>;
export type WorkspaceNote = z.infer<typeof workspaceNoteSchema>;
export type WorkspaceNoteCanvasEvent = z.infer<typeof workspaceNoteCanvasEventSchema>;
