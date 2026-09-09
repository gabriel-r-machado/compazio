import { z } from "zod";

import { canvasEdgeSchema } from "./ipc/canvas";

export const WORKSPACE_CONNECTION_EVENT_CHANNEL = "workspace-connection:event" as const;

export const workspaceConnectionTypeSchema = z.enum([
  "context",
  "handoff",
  "dependency",
  "artifact",
  "approval"
]);
export const workspaceConnectionCreatableTypeSchema = z.enum(["context", "handoff", "dependency"]);
export const workspaceConnectionPermissionSchema = z.literal("connect_context");
export const workspaceConnectionEventTypeSchema = z.enum([
  "connection_created",
  "connection_removed"
]);

export const workspaceCanvasConnectionSchema = z
  .object({
    connectionId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    sourceNodeId: z.string().min(1).max(160),
    targetNodeId: z.string().min(1).max(160),
    type: workspaceConnectionTypeSchema,
    permission: workspaceConnectionPermissionSchema,
    label: z.string().min(1).max(160).nullable(),
    createdBy: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    revision: z.number().int().nonnegative()
  })
  .strict();

export const canvasConnectionNodeSchema = z
  .object({
    nodeId: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    type: z.string().min(1).max(64)
  })
  .strict();

export const workspaceConnectionCanvasEventSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: workspaceConnectionEventTypeSchema,
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    connection: workspaceCanvasConnectionSchema,
    edge: canvasEdgeSchema,
    actorNodeId: z.string().min(1).max(160).nullable(),
    canvasRevision: z.number().int().positive()
  })
  .strict();

export type WorkspaceConnectionEventType = z.infer<typeof workspaceConnectionEventTypeSchema>;
export type WorkspaceConnectionType = z.infer<typeof workspaceConnectionTypeSchema>;
export type WorkspaceConnectionCreatableType = z.infer<
  typeof workspaceConnectionCreatableTypeSchema
>;
export type WorkspaceConnectionPermission = z.infer<typeof workspaceConnectionPermissionSchema>;
export type WorkspaceCanvasConnection = z.infer<typeof workspaceCanvasConnectionSchema>;
export type CanvasConnectionNode = z.infer<typeof canvasConnectionNodeSchema>;
export type WorkspaceConnectionCanvasEvent = z.infer<typeof workspaceConnectionCanvasEventSchema>;
