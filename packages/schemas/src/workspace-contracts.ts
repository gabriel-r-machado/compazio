import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedList = (maximumItems: number, maximumItemLength: number) =>
  z.array(boundedText(maximumItemLength)).max(maximumItems);

export const artifactMemoryRelationSchema = z
  .object({
    artifactId: z.string().uuid(),
    kind: z.enum(["derived_from", "supports", "supersedes"])
  })
  .strict();

export const artifactMemoryRelevanceSchema = z.enum(["required", "relevant", "optional"]);
export const artifactMemoryStatusSchema = z.enum(["active", "superseded", "archived"]);

export const artifactMemorySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    artifactId: z.string().uuid(),
    version: z.number().int().positive(),
    origin: boundedText(4_096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    relationships: z.array(artifactMemoryRelationSchema).max(64),
    relevance: artifactMemoryRelevanceSchema,
    status: artifactMemoryStatusSchema,
    restoredFromVersion: z.number().int().positive().nullable(),
    createdBy: z.string().min(1).max(160),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

/** Safe artifact-memory projection for CLI and IPC; it deliberately omits origin. */
export const artifactMemoryViewSchema = artifactMemorySchema.omit({ origin: true });

export const setArtifactMemorySchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    artifactId: z.string().uuid(),
    relationships: z.array(artifactMemoryRelationSchema).max(64),
    relevance: artifactMemoryRelevanceSchema,
    status: artifactMemoryStatusSchema
  })
  .strict();

/**
 * Safe, path-free artifact metadata intended for impact inspection outside the
 * local persistence boundary.
 */
export const artifactImpactNodeSchema = z
  .object({
    artifactId: z.string().uuid(),
    kind: boundedText(160),
    filename: boundedText(512),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    memoryVersion: z.number().int().positive(),
    relevance: artifactMemoryRelevanceSchema,
    status: artifactMemoryStatusSchema
  })
  .strict();

export const artifactImpactEdgeSchema = z
  .object({
    sourceArtifactId: z.string().uuid(),
    targetArtifactId: z.string().uuid(),
    kind: artifactMemoryRelationSchema.shape.kind
  })
  .strict();

/**
 * The connected, versioned artifact component around a root artifact.
 * `affectedArtifactIds` excludes the root and follows only `derived_from`
 * edges in the direction in which a source change can propagate.
 */
export const artifactImpactSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    rootArtifactId: z.string().uuid(),
    nodes: z.array(artifactImpactNodeSchema).min(1).max(1_000),
    edges: z.array(artifactImpactEdgeSchema).max(64_000),
    affectedArtifactIds: z.array(z.string().uuid()).max(999)
  })
  .strict();

const artifactMemoryChangeSchema = z
  .object({
    from: z.string().min(1).max(32),
    to: z.string().min(1).max(32)
  })
  .strict();

/** A path-free, metadata-only comparison between two immutable memory revisions. */
export const artifactMemoryComparisonSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    artifactId: z.string().uuid(),
    baseVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
    addedRelationships: z.array(artifactMemoryRelationSchema).max(64),
    removedRelationships: z.array(artifactMemoryRelationSchema).max(64),
    relevance: artifactMemoryChangeSchema.nullable(),
    status: artifactMemoryChangeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baseVersion === value.targetVersion) {
      context.addIssue({
        code: "custom",
        message: "Artifact memory comparison versions must differ"
      });
    }
  });

export const compareArtifactMemorySchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    artifactId: z.string().uuid(),
    baseVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baseVersion === value.targetVersion) {
      context.addIssue({
        code: "custom",
        message: "Artifact memory comparison versions must differ"
      });
    }
  });

export const restoreArtifactMemorySchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    artifactId: z.string().uuid(),
    sourceVersion: z.number().int().positive()
  })
  .strict();

export const artifactFeedbackSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    artifactId: z.string().uuid(),
    artifactVersion: z.number().int().positive(),
    content: boundedText(4_000),
    createdBy: z.literal("local-user"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const createArtifactFeedbackSchema = artifactFeedbackSchema
  .pick({ workspaceId: true, artifactId: true, artifactVersion: true, content: true })
  .strict();

export const deliveryEvidenceSchema = z
  .object({
    kind: z.enum(["artifact", "test", "approval", "exit_code", "output"]),
    reference: boundedText(2_000)
  })
  .strict();

export const deliveryContractStateSchema = z.enum(["draft", "ready", "verified", "rejected"]);

export const deliveryContractLimitsSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    maxContextBytes: z
      .number()
      .int()
      .min(4 * 1024)
      .max(2 * 1024 * 1024)
  })
  .strict();

export const deliveryContractSchema = z
  .object({
    id: z.string().uuid(),
    revisionId: z.string().uuid(),
    workspaceId: z.string().min(1).max(160),
    sourceNodeId: z.string().min(1).max(160),
    targetNodeId: z.string().min(1).max(160),
    version: z.number().int().positive(),
    inputs: boundedList(64, 2_000),
    outputs: boundedList(64, 2_000),
    completionCriteria: boundedList(64, 2_000),
    declaredEvidence: z.array(deliveryEvidenceSchema).max(64),
    verifiedEvidence: z.array(deliveryEvidenceSchema).max(64),
    state: deliveryContractStateSchema,
    limits: deliveryContractLimitsSchema,
    createdBy: z.literal("local-user"),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const createDeliveryContractSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    sourceNodeId: z.string().min(1).max(160),
    targetNodeId: z.string().min(1).max(160),
    inputs: boundedList(64, 2_000).default([]),
    outputs: boundedList(64, 2_000).default([]),
    completionCriteria: boundedList(64, 2_000).default([]),
    declaredEvidence: z.array(deliveryEvidenceSchema).max(64).default([]),
    limits: deliveryContractLimitsSchema.default({ maxAttempts: 1, maxContextBytes: 1024 * 1024 })
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceNodeId === value.targetNodeId) {
      context.addIssue({
        code: "custom",
        message: "Delivery contract source and target must differ"
      });
    }
  });

export const verifyDeliveryContractSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    contractId: z.string().uuid(),
    verifiedEvidence: z.array(deliveryEvidenceSchema).min(1).max(64)
  })
  .strict();

export type ArtifactMemory = z.infer<typeof artifactMemorySchema>;
export type ArtifactMemoryRelation = z.infer<typeof artifactMemoryRelationSchema>;
export type ArtifactMemoryRelevance = z.infer<typeof artifactMemoryRelevanceSchema>;
export type ArtifactMemoryStatus = z.infer<typeof artifactMemoryStatusSchema>;
export type SetArtifactMemory = z.input<typeof setArtifactMemorySchema>;
export type ArtifactImpact = z.infer<typeof artifactImpactSchema>;
export type ArtifactImpactEdge = z.infer<typeof artifactImpactEdgeSchema>;
export type ArtifactImpactNode = z.infer<typeof artifactImpactNodeSchema>;
export type ArtifactMemoryComparison = z.infer<typeof artifactMemoryComparisonSchema>;
export type ArtifactMemoryView = z.infer<typeof artifactMemoryViewSchema>;
export type CompareArtifactMemory = z.input<typeof compareArtifactMemorySchema>;
export type RestoreArtifactMemory = z.input<typeof restoreArtifactMemorySchema>;
export type ArtifactFeedback = z.infer<typeof artifactFeedbackSchema>;
export type CreateArtifactFeedback = z.input<typeof createArtifactFeedbackSchema>;
export type DeliveryEvidence = z.infer<typeof deliveryEvidenceSchema>;
export type DeliveryContract = z.infer<typeof deliveryContractSchema>;
export type DeliveryContractState = z.infer<typeof deliveryContractStateSchema>;
export type CreateDeliveryContract = z.input<typeof createDeliveryContractSchema>;
export type VerifyDeliveryContract = z.input<typeof verifyDeliveryContractSchema>;
