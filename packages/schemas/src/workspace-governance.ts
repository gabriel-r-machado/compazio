import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedList = (maximumItems: number, maximumItemLength: number) =>
  z.array(boundedText(maximumItemLength)).max(maximumItems);

export const agentProfileSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    nodeId: z.string().min(1).max(160),
    version: z.number().int().positive(),
    identity: boundedText(160),
    adapterId: z.string().min(1).max(160),
    responsibilities: z.string().max(4_000),
    limits: z.string().max(2_000),
    capabilities: z.array(z.string().min(1).max(160)).max(32),
    expectedDeliverables: boundedList(16, 2_000),
    createdBy: z.literal("local-user"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const missionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    version: z.number().int().positive(),
    objective: boundedText(20_000),
    scope: boundedList(64, 2_000),
    decisions: boundedList(64, 2_000),
    constraints: boundedList(64, 2_000),
    progress: z.string().max(8_000),
    blockers: boundedList(64, 2_000),
    createdBy: z.literal("local-user"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const workspaceMemorySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    version: z.number().int().positive(),
    stack: boundedList(64, 500),
    architecture: z.string().max(12_000),
    patterns: boundedList(128, 2_000),
    commands: boundedList(64, 2_000),
    conventions: boundedList(128, 2_000),
    technicalDecisions: boundedList(128, 2_000),
    createdBy: z.literal("local-user"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const setMissionSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    objective: boundedText(20_000),
    scope: boundedList(64, 2_000).default([]),
    decisions: boundedList(64, 2_000).default([]),
    constraints: boundedList(64, 2_000).default([]),
    progress: z.string().max(8_000).default(""),
    blockers: boundedList(64, 2_000).default([])
  })
  .strict();

export const setWorkspaceMemorySchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    stack: boundedList(64, 500).default([]),
    architecture: z.string().max(12_000).default(""),
    patterns: boundedList(128, 2_000).default([]),
    commands: boundedList(64, 2_000).default([]),
    conventions: boundedList(128, 2_000).default([]),
    technicalDecisions: boundedList(128, 2_000).default([])
  })
  .strict();

export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type WorkspaceMemory = z.infer<typeof workspaceMemorySchema>;
export type SetMission = z.input<typeof setMissionSchema>;
export type SetWorkspaceMemory = z.input<typeof setWorkspaceMemorySchema>;
