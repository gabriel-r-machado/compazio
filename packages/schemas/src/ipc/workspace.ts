import { z } from "zod";

export const WORKSPACES_LIST_CHANNEL = "workspaces:list" as const;
export const WORKSPACES_CREATE_CHANNEL = "workspaces:create" as const;
export const WORKSPACES_UPDATE_CHANNEL = "workspaces:update" as const;
export const WORKSPACES_REORDER_CHANNEL = "workspaces:reorder" as const;

const idSchema = z.string().uuid();

export const workspaceSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    canvasId: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    position: z.number().int().nonnegative(),
    isOpen: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const workspaceListResponseSchema = z.array(workspaceSchema).max(100);
export const workspaceCreateRequestSchema = z
  .object({
    projectId: idSchema,
    title: z.string().min(1).max(160).optional(),
    adoptLegacyCanvas: z.boolean().default(false)
  })
  .strict();
export const workspaceUpdateRequestSchema = z
  .object({
    workspaceId: idSchema,
    title: z.string().min(1).max(160).optional(),
    isOpen: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.title !== undefined || value.isOpen !== undefined, {
    message: "Workspace update must include a title or open state"
  });
export const workspaceReorderRequestSchema = z
  .object({ workspaceIds: z.array(idSchema).min(1).max(100) })
  .strict()
  .refine((value) => new Set(value.workspaceIds).size === value.workspaceIds.length, {
    message: "Workspace order cannot contain duplicate ids"
  });

export type WorkspaceDto = z.infer<typeof workspaceSchema>;
export type WorkspaceCreateRequest = z.infer<typeof workspaceCreateRequestSchema>;
export type WorkspaceUpdateRequest = z.infer<typeof workspaceUpdateRequestSchema>;
export type WorkspaceReorderRequest = z.infer<typeof workspaceReorderRequestSchema>;
