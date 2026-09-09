import { z } from "zod";

/** A redacted notification that lets the desktop refresh durable workspace views. */
export const WORKSPACE_ACTIVITY_EVENT_CHANNEL = "workspace-activity:event" as const;

export const workspaceActivitySubjectSchema = z.enum(["message", "handoff"]);

export const workspaceActivityEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    subject: workspaceActivitySubjectSchema,
    subjectId: z.string().min(1).max(160),
    agentNodeId: z.string().min(1).max(160).nullable(),
    eventType: z.string().min(1).max(80),
    occurredAt: z.string().datetime({ offset: true })
  })
  .strict();

export type WorkspaceActivitySubject = z.infer<typeof workspaceActivitySubjectSchema>;
export type WorkspaceActivityEvent = z.infer<typeof workspaceActivityEventSchema>;
