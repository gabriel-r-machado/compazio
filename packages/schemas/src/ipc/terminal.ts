import { z } from "zod";

export const TERMINAL_CREATE_CHANNEL = "terminal:create" as const;
export const TERMINAL_LIST_CHANNEL = "terminal:list" as const;
export const TERMINAL_BUFFER_CHANNEL = "terminal:buffer" as const;
export const TERMINAL_WRITE_CHANNEL = "terminal:write" as const;
export const TERMINAL_RESIZE_CHANNEL = "terminal:resize" as const;
export const TERMINAL_CANCEL_CHANNEL = "terminal:cancel" as const;
export const TERMINAL_CLEAR_CHANNEL = "terminal:clear" as const;
export const TERMINAL_EVENT_CHANNEL = "terminal:event" as const;

// Interactive sessions use UUIDs. Official workflow workers use a deterministic local id so the
// renderer can reconnect their audited output to the exact run/node after the process starts.
const idSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9:_-]+$/);
export const terminalAdapterIdSchema = z.enum(["shell", "claude-code", "codex", "opencode"]);
export const terminalSessionStateSchema = z.enum([
  "starting",
  "running",
  "waiting",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted"
]);

export const terminalSessionSchema = z
  .object({
    id: idSchema,
    adapterId: terminalAdapterIdSchema,
    state: terminalSessionStateSchema,
    startedAt: z.string().datetime({ offset: true }).nullable(),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    exitCode: z.number().int().nullable(),
    exitSignal: z.number().int().nullable(),
    workspaceId: z.string().min(1).max(160).optional(),
    canvasNodeId: z.string().min(1).max(160).optional(),
    workflowRunId: z.string().min(1).max(200).optional(),
    workflowNodeId: z.string().min(1).max(160).optional(),
    workflowAttempt: z.number().int().min(1).max(100).optional(),
    readOnly: z.boolean().default(false)
  })
  .strict();

export const terminalCreateRequestSchema = z
  .object({
    projectId: idSchema,
    adapterId: terminalAdapterIdSchema,
    endpoint: z
      .object({
        workspaceId: z.string().min(1).max(160),
        nodeId: z.string().min(1).max(160)
      })
      .strict()
      .optional(),
    cols: z.number().int().min(1).max(500).default(120),
    rows: z.number().int().min(1).max(500).default(30)
  })
  .strict();
export const terminalListResponseSchema = z.array(terminalSessionSchema).max(1_000);
export const terminalSessionRequestSchema = z.object({ sessionId: idSchema }).strict();
export const terminalBufferResponseSchema = z
  .object({
    data: z.string().max(2 * 1024 * 1024),
    sequence: z.number().int().nonnegative()
  })
  .strict();
export const terminalWriteRequestSchema = z
  .object({
    sessionId: idSchema,
    data: z
      .string()
      .min(1)
      .max(64 * 1024)
  })
  .strict();
export const terminalResizeRequestSchema = z
  .object({
    sessionId: idSchema,
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500)
  })
  .strict();

export const terminalEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session.state"),
      session: terminalSessionSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("session.output"),
      sessionId: idSchema,
      sequence: z.number().int().nonnegative(),
      data: z.string().max(64 * 1024),
      timestamp: z.string().datetime({ offset: true })
    })
    .strict(),
  z
    .object({
      type: z.literal("session.error"),
      sessionId: idSchema,
      code: z.string().min(1).max(160),
      message: z.string().min(1).max(2_000)
    })
    .strict()
]);

export type TerminalAdapterId = z.infer<typeof terminalAdapterIdSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type TerminalCreateRequest = z.infer<typeof terminalCreateRequestSchema>;
export type TerminalSessionRequest = z.infer<typeof terminalSessionRequestSchema>;
export type TerminalWriteRequest = z.infer<typeof terminalWriteRequestSchema>;
export type TerminalResizeRequest = z.infer<typeof terminalResizeRequestSchema>;
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
