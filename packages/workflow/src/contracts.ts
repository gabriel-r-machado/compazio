import { z } from "zod";

export const workflowNodeTypeSchema = z.enum([
  "agent",
  "shell",
  "human_approval",
  "quality_gate",
  "artifact",
  "handoff",
  "transform",
  "parallel_group",
  "subworkflow"
]);

export const retryReasonSchema = z.enum([
  "process_exit_nonzero",
  "timeout",
  "adapter_unavailable",
  "transient_error"
]);

export const retryPolicySchema = z
  .object({
    max_attempts: z.number().int().min(1).max(10).default(1),
    backoff_ms: z.number().int().min(0).max(60_000).default(0),
    retry_on: z.array(retryReasonSchema).default([])
  })
  .strict();

export const permissionMapSchema = z
  .object({
    process: z.boolean().optional(),
    workspace_read: z.boolean().optional(),
    workspace_write: z.boolean().optional(),
    network: z.boolean().optional(),
    git_read: z.boolean().optional(),
    git_write: z.boolean().optional(),
    destructive: z.boolean().optional()
  })
  .strict()
  .default({});

export const commandSpecSchema = z
  .object({
    executable: z.string().min(1).max(1_024),
    args: z.array(z.string().max(8_192)).max(256).default([])
  })
  .strict();

export const resourceLockSchema = z
  .object({
    type: z.enum([
      "project",
      "branch",
      "worktree",
      "port",
      "file_glob",
      "environment",
      "adapter_session"
    ]),
    key: z.string().min(1).max(1_024)
  })
  .strict();

export const workflowNodeSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    type: workflowNodeTypeSchema,
    title: z.string().min(1).max(160).optional(),
    depends_on: z.array(z.string()).default([]),
    adapter: z.string().min(1).optional(),
    role: z.string().max(160).optional(),
    command: commandSpecSchema.optional(),
    timeout_ms: z.number().int().min(1).max(3_600_000).optional(),
    isolation: z.enum(["none", "git_worktree"]).default("none"),
    permissions: permissionMapSchema,
    resources: z.array(resourceLockSchema).max(64).default([]),
    retry: retryPolicySchema.default({ max_attempts: 1, backoff_ms: 0, retry_on: [] }),
    output: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const workflowSchema = z
  .object({
    schema_version: z.literal("1.0"),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(160),
    description: z.string().max(2_000).optional(),
    concurrency: z.number().int().min(1).max(32).default(1),
    permissions: permissionMapSchema,
    inputs: z.record(z.string(), z.unknown()).default({}),
    nodes: z.array(workflowNodeSchema).min(1).max(1_000)
  })
  .strict();

export const evidenceSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["exit_code", "artifact", "approval", "test", "output", "message"]),
    summary: z.string().min(1).max(2_000),
    artifact_id: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const artifactReferenceSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    relative_path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: z.string().min(1)
  })
  .strict();

export const decisionSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    rationale: z.string().max(4_000).optional()
  })
  .strict();

export const handoffSchema = z
  .object({
    id: z.string().min(1),
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    summary: z.string().min(1).max(4_000),
    decisions: z.array(decisionSchema).default([]),
    artifacts: z.array(artifactReferenceSchema).default([]),
    openQuestions: z.array(z.string().max(2_000)).default([]),
    acceptanceEvidence: z.array(evidenceSchema).min(1),
    schemaVersion: z.literal("1.0")
  })
  .strict();

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;
export type RetryReason = z.infer<typeof retryReasonSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type PermissionMap = z.infer<typeof permissionMapSchema>;
export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type ResourceLock = z.infer<typeof resourceLockSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type Handoff = z.infer<typeof handoffSchema>;
