import { z } from "zod";

import { canvasNodeSchema } from "./ipc/canvas";

export const WORKSPACE_ARTIFACT_EVENT_CHANNEL = "workspace-artifact:event" as const;

export const workspaceArtifactEventTypeSchema = z.enum(["artifact_published"]);
export const workspaceArtifactKindSchema = z.string().min(1).max(64);
export const workspaceArtifactSourcePathSchema = z.string().min(1).max(4_096);

export const publishWorkspaceArtifactSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    sourcePath: workspaceArtifactSourcePathSchema,
    kind: workspaceArtifactKindSchema,
    publishedByNodeId: z.string().min(1).max(160).nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

export const workspaceArtifactSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    projectId: z.string().uuid(),
    kind: workspaceArtifactKindSchema,
    sourceRelativePath: z.string().min(1).max(4_096),
    relativePath: z.string().min(1).max(4_096),
    filename: z.string().min(1).max(255),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024),
    mediaType: z.string().min(1).max(160),
    publishedByNodeId: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const workspaceArtifactCanvasEventSchema = z
  .object({
    id: z.string().uuid(),
    type: workspaceArtifactEventTypeSchema,
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    artifact: workspaceArtifactSchema,
    node: canvasNodeSchema,
    canvasRevision: z.number().int().positive()
  })
  .strict();

export function workspaceArtifactNodeId(artifactId: string): string {
  return `artifact-${artifactId}`;
}

export type WorkspaceArtifactEventType = z.infer<typeof workspaceArtifactEventTypeSchema>;
export type WorkspaceArtifactKind = z.infer<typeof workspaceArtifactKindSchema>;
export type PublishWorkspaceArtifact = z.infer<typeof publishWorkspaceArtifactSchema>;
export type WorkspaceArtifact = z.infer<typeof workspaceArtifactSchema>;
export type WorkspaceArtifactCanvasEvent = z.infer<typeof workspaceArtifactCanvasEventSchema>;
