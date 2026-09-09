import { z } from "zod";

const boundedId = z.string().min(1).max(160);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Source policy is evaluated after the explicit canvas context edge has granted access. */
export const contextInclusionSchema = z.enum(["required", "relevant", "optional", "never"]);
export const contextSelectionModeSchema = z.enum(["full", "intelligent", "economical"]);
export const contextSourceIndexTypeSchema = z.enum([
  "note",
  "artifact",
  "text",
  "link",
  "file",
  "folder",
  "image",
  "drawing",
  "page"
]);

/** Metadata-only chunks; context bytes are never copied into the local index. */
export const contextIndexChunkSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    sha256: sha256Schema,
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024),
    estimatedTokens: z.number().int().nonnegative().max(10_000_000)
  })
  .strict();

export const contextSourceIndexSchema = z
  .object({
    workspaceId: boundedId,
    sourceNodeId: boundedId,
    type: contextSourceIndexTypeSchema,
    /** Deliberately structural, never a filesystem path or remote URL. */
    origin: z.enum(["canvas_context", "published_artifact"]),
    version: z.number().int().positive(),
    sourceSha256: sha256Schema,
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024),
    inclusion: contextInclusionSchema,
    chunks: z.array(contextIndexChunkSchema).max(10_000)
  })
  .strict();

export const contextSelectionReasonSchema = z.enum([
  "required_by_source_policy",
  "relevant_by_source_policy",
  "optional_in_full_mode",
  "optional_within_intelligent_budget",
  "excluded_by_never_policy",
  "excluded_by_economical_mode",
  "excluded_by_intelligent_budget",
  "excluded_by_economical_budget"
]);

export const contextSelectionEntrySchema = z
  .object({
    sourceNodeId: boundedId,
    sourceSha256: sha256Schema,
    inclusion: contextInclusionSchema,
    included: z.boolean(),
    reason: contextSelectionReasonSchema,
    estimatedTokens: z.number().int().nonnegative().max(10_000_000),
    /** Null unless a provider reports a measured value. */
    actualTokens: z.number().int().nonnegative().max(10_000_000).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.inclusion === "never" && value.included) {
      context.addIssue({ code: "custom", message: "Never-permitted context cannot be selected" });
    }
  });

export const contextUsageMetricsSchema = z
  .object({
    estimatedTokens: z.number().int().nonnegative().max(10_000_000),
    /** No adapter currently reports provider token usage, so new selections leave this null. */
    actualTokens: z.number().int().nonnegative().max(10_000_000).nullable(),
    costStatus: z.enum(["estimated", "reported"]),
    estimatedCostMicros: z.number().int().nonnegative().nullable(),
    actualCostMicros: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.costStatus === "reported" && value.actualCostMicros === null) {
      context.addIssue({ code: "custom", message: "Reported cost requires a provider value" });
    }
    if (value.actualTokens === null && value.actualCostMicros !== null) {
      context.addIssue({ code: "custom", message: "Actual cost requires reported token usage" });
    }
  });

/** Reproducible, metadata-only evidence of why every connected source was included or excluded. */
export const contextSelectionSnapshotSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    workspaceId: boundedId,
    agentNodeId: boundedId,
    mode: contextSelectionModeSchema,
    sourceIndexSha256: sha256Schema,
    selectionSha256: sha256Schema,
    entries: z.array(contextSelectionEntrySchema).max(1_000),
    metrics: contextUsageMetricsSchema,
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type ContextInclusion = z.infer<typeof contextInclusionSchema>;
export type ContextSelectionMode = z.infer<typeof contextSelectionModeSchema>;
export type ContextSourceIndex = z.infer<typeof contextSourceIndexSchema>;
export type ContextIndexChunk = z.infer<typeof contextIndexChunkSchema>;
export type ContextSelectionReason = z.infer<typeof contextSelectionReasonSchema>;
export type ContextSelectionEntry = z.infer<typeof contextSelectionEntrySchema>;
export type ContextUsageMetrics = z.infer<typeof contextUsageMetricsSchema>;
export type ContextSelectionSnapshot = z.infer<typeof contextSelectionSnapshotSchema>;
