import { z } from "zod";

import { deliveryContractSchema } from "./workspace-contracts";
import { artifactMemorySchema } from "./workspace-contracts";
import { workspaceAgentContextSchema } from "./workspace-context";
import { agentProfileSchema, missionSchema, workspaceMemorySchema } from "./workspace-governance";
import { canvasHandoffSchema } from "./ipc/handoffs";
import { contextSelectionModeSchema, contextSelectionSnapshotSchema } from "./context-selection";

const boundedId = z.string().min(1).max(160);
const taskSchema = z.string().trim().min(1).max(20_000);

export const buildExecutionContextSchema = z
  .object({
    workspaceId: boundedId,
    agentNodeId: boundedId,
    task: taskSchema,
    contractId: z.string().uuid().nullable().default(null),
    contextMode: contextSelectionModeSchema.default("full")
  })
  .strict();

export const effectiveExecutionContextSchema = z
  .object({
    workspaceId: boundedId,
    agentNodeId: boundedId,
    task: taskSchema,
    profile: agentProfileSchema,
    mission: missionSchema.nullable(),
    memory: workspaceMemorySchema.nullable(),
    connectedContext: workspaceAgentContextSchema,
    artifactMemories: z.array(artifactMemorySchema).max(1_000),
    previousHandoff: canvasHandoffSchema.nullable(),
    deliveryContract: deliveryContractSchema.nullable(),
    /** Optional only so immutable checkpoints made before context selection remain readable. */
    contextSelection: contextSelectionSnapshotSchema.optional()
  })
  .strict();

export const executionContextSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    context: effectiveExecutionContextSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const executionCheckpointTypeSchema = z.enum(["function", "delivery"]);

export const createExecutionCheckpointSchema = buildExecutionContextSchema
  .extend({
    type: executionCheckpointTypeSchema
  })
  .strict();

export const executionCheckpointSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: boundedId,
    agentNodeId: boundedId,
    type: executionCheckpointTypeSchema,
    task: taskSchema,
    contractId: z.string().uuid().nullable(),
    snapshot: executionContextSnapshotSchema,
    createdBy: z.literal("local-user"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type BuildExecutionContext = z.input<typeof buildExecutionContextSchema>;
export type EffectiveExecutionContext = z.infer<typeof effectiveExecutionContextSchema>;
export type ExecutionContextSnapshot = z.infer<typeof executionContextSnapshotSchema>;
export type ExecutionCheckpointType = z.infer<typeof executionCheckpointTypeSchema>;
export type CreateExecutionCheckpoint = z.input<typeof createExecutionCheckpointSchema>;
export type ExecutionCheckpoint = z.infer<typeof executionCheckpointSchema>;
