import { z } from "zod";

export const PROJECTS_CHOOSE_CHANNEL = "projects:choose" as const;
export const PROJECTS_INITIALIZE_GIT_CHANNEL = "projects:initialize-git" as const;
export const PROJECTS_CLONE_GITHUB_CHANNEL = "projects:clone-github" as const;
export const PROJECTS_LIST_CHANNEL = "projects:list" as const;
export const PROJECTS_LIST_BRANCHES_CHANNEL = "projects:list-branches" as const;
export const PROJECTS_SWITCH_BRANCH_CHANNEL = "projects:switch-branch" as const;
export const WORKTREES_LIST_CHANNEL = "worktrees:list" as const;
export const WORKTREES_CREATE_CHANNEL = "worktrees:create" as const;
export const WORKTREES_STATUS_CHANNEL = "worktrees:status" as const;
export const WORKTREES_DIFF_CHANNEL = "worktrees:diff" as const;
export const WORKTREES_CLEANUP_CHANNEL = "worktrees:cleanup" as const;
export const QUALITY_GATES_DISCOVER_CHANNEL = "quality-gates:discover" as const;
export const QUALITY_GATES_LIST_RUNS_CHANNEL = "quality-gates:list-runs" as const;
export const QUALITY_GATES_RUN_CHANNEL = "quality-gates:run" as const;
export const DELIVERY_REPORT_GENERATE_CHANNEL = "delivery-report:generate" as const;
export const MERGE_PREPARE_CHANNEL = "merge:prepare" as const;
export const MERGE_CONFIRM_CHANNEL = "merge:confirm" as const;

const idSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });

export const gitProjectSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(255),
    rootPath: z.string().min(1).max(32_768),
    defaultBranch: z.string().min(1).max(256),
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    updatedAt: timestampSchema
  })
  .strict();

export const managedWorktreeSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    taskKey: z.string().min(1).max(80),
    taskTitle: z.string().min(1).max(200),
    branchName: z.string().min(1).max(96),
    baseRef: z.string().min(1).max(256),
    state: z.enum(["active", "removed"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export const worktreeFileStatusSchema = z
  .object({
    path: z.string().min(1).max(32_768),
    index: z.string().max(4),
    workingTree: z.string().max(4)
  })
  .strict();

export const worktreeStatusSchema = z
  .object({
    worktreeId: idSchema,
    branchName: z.string().min(1).max(96),
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    dirty: z.boolean(),
    gitLocked: z.boolean(),
    leased: z.boolean(),
    leaseOwnerId: z.string().max(200).nullable(),
    files: z.array(worktreeFileStatusSchema).max(5_000),
    ignoredFiles: z.array(z.string().min(1).max(32_768)).max(5_000)
  })
  .strict();

export const diffFileSchema = z
  .object({
    path: z.string().min(1).max(32_768),
    status: z.string().min(1).max(16),
    oldPath: z.string().max(32_768).nullable()
  })
  .strict();

export const worktreeDiffSchema = z
  .object({
    worktreeId: idSchema,
    baseRef: z.string().min(1).max(256),
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    dirty: z.boolean(),
    files: z.array(diffFileSchema).max(5_000),
    untrackedFiles: z.array(z.string().min(1).max(32_768)).max(5_000),
    patch: z.string().max(2 * 1024 * 1024 + 1_024),
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative()
  })
  .strict();

export const qualityGatePresetSchema = z.enum(["lint", "typecheck", "test", "build", "playwright"]);

export const qualityGateDefinitionSchema = z
  .object({
    id: qualityGatePresetSchema,
    label: z.string().min(1).max(80),
    script: z.string().min(1).max(160),
    timeoutMs: z.number().int().min(1).max(3_600_000),
    optional: z.boolean()
  })
  .strict();

export const qualityGateRunSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    worktreeId: idSchema,
    presetId: qualityGatePresetSchema,
    state: z.enum(["running", "passed", "failed", "interrupted"]),
    executableName: z.string().min(1).max(255),
    args: z.array(z.string().max(8_192)).max(32),
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    timedOut: z.boolean(),
    outputSummary: z.string().max(64 * 1024 + 1_024),
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable()
  })
  .strict();

export const mergePlanSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    worktreeId: idSchema,
    sourceBranch: z.string().min(1).max(96),
    targetBranch: z.string().min(1).max(256),
    sourceHead: z.string().regex(/^[a-f0-9]{40,64}$/),
    targetHead: z.string().regex(/^[a-f0-9]{40,64}$/),
    conflictedFiles: z.array(z.string().min(1).max(32_768)).max(5_000),
    requiredGateRunIds: z.array(idSchema).max(32),
    state: z.enum(["pending", "confirmed", "invalid", "failed"]),
    eligible: z.boolean(),
    issues: z.array(z.string().max(2_000)).max(64),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    confirmedAt: timestampSchema.nullable(),
    mergeCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    error: z.string().max(2_000).nullable()
  })
  .strict();

export const prReadyReportSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    worktreeId: idSchema,
    title: z.string().min(1).max(280),
    markdown: z.string().max(500_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestampSchema
  })
  .strict();

export const projectsChooseResponseSchema = z
  .object({
    project: gitProjectSchema.nullable(),
    /** Only a directory returned by the native picker can be initialized in the follow-up action. */
    initializationDirectory: z.string().min(1).max(32_768).nullable().default(null)
  })
  .strict();
export const projectsInitializeGitRequestSchema = z
  .object({ directory: z.string().min(1).max(32_768) })
  .strict();
export const projectsCloneGitHubRequestSchema = z
  .object({
    repositoryUrl: z.string().url().max(2_048)
  })
  .strict();
export const projectsListResponseSchema = z.array(gitProjectSchema).max(1_000);
export const projectBranchSchema = z
  .object({ name: z.string().min(1).max(256), current: z.boolean() })
  .strict();
export const projectBranchesResponseSchema = z
  .object({
    branches: z.array(projectBranchSchema).max(10_000),
    currentBranch: z.string().min(1).max(256),
    dirty: z.boolean()
  })
  .strict();
export const projectSwitchBranchRequestSchema = z
  .object({ projectId: idSchema, branchName: z.string().min(1).max(256) })
  .strict();
export const projectSwitchBranchResponseSchema = z
  .object({
    currentBranch: z.string().min(1).max(256),
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/)
  })
  .strict();
export const projectIdRequestSchema = z.object({ projectId: idSchema }).strict();
export const worktreeIdRequestSchema = z.object({ worktreeId: idSchema }).strict();
export const worktreesListResponseSchema = z.array(managedWorktreeSchema).max(10_000);
export const worktreeCreateRequestSchema = z
  .object({
    projectId: idSchema,
    taskKey: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    taskTitle: z.string().min(1).max(200)
  })
  .strict();
export const worktreeCleanupRequestSchema = z
  .object({ worktreeId: idSchema, confirmed: z.literal(true) })
  .strict();
export const worktreeCleanupResponseSchema = z.object({ removed: z.literal(true) }).strict();
export const qualityGateDefinitionsResponseSchema = z.array(qualityGateDefinitionSchema).max(5);
export const qualityGateRunsResponseSchema = z.array(qualityGateRunSchema).max(10_000);
export const qualityGateRunRequestSchema = z
  .object({
    worktreeId: idSchema,
    presetId: qualityGatePresetSchema,
    confirmed: z.literal(true)
  })
  .strict();
export const mergePrepareResponseSchema = z
  .object({
    plan: mergePlanSchema,
    confirmationToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
  })
  .strict();
export const mergeConfirmRequestSchema = z
  .object({
    planId: idSchema,
    confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true)
  })
  .strict();
export const mergeConfirmationResultSchema = z
  .object({
    planId: idSchema,
    state: z.enum(["confirmed", "failed"]),
    mergeCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    rollbackCommand: z.string().max(512).nullable(),
    error: z.string().max(2_000).nullable()
  })
  .strict();

export type GitProjectDto = z.infer<typeof gitProjectSchema>;
export type ProjectsChooseResponse = z.infer<typeof projectsChooseResponseSchema>;
export type ProjectBranchDto = z.infer<typeof projectBranchSchema>;
export type ProjectBranchesResponse = z.infer<typeof projectBranchesResponseSchema>;
export type ProjectSwitchBranchRequest = z.infer<typeof projectSwitchBranchRequestSchema>;
export type ProjectSwitchBranchResponse = z.infer<typeof projectSwitchBranchResponseSchema>;
export type ManagedWorktreeDto = z.infer<typeof managedWorktreeSchema>;
export type WorktreeStatusDto = z.infer<typeof worktreeStatusSchema>;
export type WorktreeDiffDto = z.infer<typeof worktreeDiffSchema>;
export type QualityGatePresetDto = z.infer<typeof qualityGatePresetSchema>;
export type QualityGateDefinitionDto = z.infer<typeof qualityGateDefinitionSchema>;
export type QualityGateRunDto = z.infer<typeof qualityGateRunSchema>;
export type MergePlanDto = z.infer<typeof mergePlanSchema>;
export type PrReadyReportDto = z.infer<typeof prReadyReportSchema>;
export type WorktreeCreateRequest = z.infer<typeof worktreeCreateRequestSchema>;
export type ProjectsCloneGitHubRequest = z.infer<typeof projectsCloneGitHubRequestSchema>;
export type ProjectsInitializeGitRequest = z.infer<typeof projectsInitializeGitRequestSchema>;
export type WorktreeCleanupRequest = z.infer<typeof worktreeCleanupRequestSchema>;
export type QualityGateRunRequest = z.infer<typeof qualityGateRunRequestSchema>;
export type MergeConfirmRequest = z.infer<typeof mergeConfirmRequestSchema>;
export type MergeConfirmationResultDto = z.infer<typeof mergeConfirmationResultSchema>;
