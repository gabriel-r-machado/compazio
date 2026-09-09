import { z } from "zod";

import { canvasNodeSchema } from "./ipc/canvas";

export const AGENT_SPAWN_EVENT_CHANNEL = "agent-spawn:event" as const;

export const spawnAgentAdapterIdSchema = z.enum(["claude-code", "codex"]);
export const agentSpawnStatusSchema = z.enum([
  "queued",
  "spawning",
  "running",
  "failed",
  "interrupted"
]);
export const agentSpawnEventTypeSchema = z.enum([
  "spawn_queued",
  "spawn_started",
  "node_created",
  "agent_running",
  "spawn_failed",
  "spawn_interrupted",
  "spawn_retry_requested",
  "node_restarted"
]);

export const createAgentSpawnSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    adapterId: spawnAgentAdapterIdSchema,
    roleName: z.string().min(1).max(80),
    name: z.string().min(1).max(160),
    requestedByNodeId: z.string().min(1).max(160).nullable(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

export const agentSpawnSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    canvasId: z.string().min(1).max(160),
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(160),
    adapterId: spawnAgentAdapterIdSchema,
    roleName: z.string().min(1).max(80),
    name: z.string().min(1).max(160),
    requestedByNodeId: z.string().min(1).max(160).nullable(),
    status: agentSpawnStatusSchema,
    idempotencyKey: z.string().min(1).max(200),
    attempt: z.number().int().nonnegative(),
    sessionId: z.string().uuid().nullable(),
    errorCode: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const agentSpawnCanvasEventSchema = z
  .object({
    spawn: agentSpawnSchema,
    node: canvasNodeSchema,
    canvasRevision: z.number().int().positive()
  })
  .strict();

export type AgentSpawnAdapterId = z.infer<typeof spawnAgentAdapterIdSchema>;
export type AgentSpawnStatus = z.infer<typeof agentSpawnStatusSchema>;
export type AgentSpawnEventType = z.infer<typeof agentSpawnEventTypeSchema>;
export type CreateAgentSpawn = z.infer<typeof createAgentSpawnSchema>;
export type AgentSpawn = z.infer<typeof agentSpawnSchema>;
export type AgentSpawnCanvasEvent = z.infer<typeof agentSpawnCanvasEventSchema>;
