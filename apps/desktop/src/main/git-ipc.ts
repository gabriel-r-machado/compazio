import type { IpcMain } from "electron";

import type {
  ConfirmedMergeService,
  ManagedWorktree,
  MergePlanRecord,
  PrReadyReportService,
  ProjectRepositoryService,
  QualityGateService,
  WorktreeDiffService,
  WorktreeManager
} from "@forgedeck/git";
import { parseGitHubRepositoryUrl } from "@forgedeck/git";
import {
  DELIVERY_REPORT_GENERATE_CHANNEL,
  MERGE_CONFIRM_CHANNEL,
  MERGE_PREPARE_CHANNEL,
  PROJECTS_CLONE_GITHUB_CHANNEL,
  PROJECTS_CHOOSE_CHANNEL,
  PROJECTS_INITIALIZE_GIT_CHANNEL,
  PROJECTS_LIST_CHANNEL,
  PROJECTS_LIST_BRANCHES_CHANNEL,
  PROJECTS_SWITCH_BRANCH_CHANNEL,
  QUALITY_GATES_DISCOVER_CHANNEL,
  QUALITY_GATES_LIST_RUNS_CHANNEL,
  QUALITY_GATES_RUN_CHANNEL,
  WORKTREES_CLEANUP_CHANNEL,
  WORKTREES_CREATE_CHANNEL,
  WORKTREES_DIFF_CHANNEL,
  WORKTREES_LIST_CHANNEL,
  WORKTREES_STATUS_CHANNEL,
  gitProjectSchema,
  managedWorktreeSchema,
  mergeConfirmRequestSchema,
  mergeConfirmationResultSchema,
  mergePlanSchema,
  mergePrepareResponseSchema,
  prReadyReportSchema,
  projectIdRequestSchema,
  projectsChooseResponseSchema,
  projectsCloneGitHubRequestSchema,
  projectsInitializeGitRequestSchema,
  projectsListResponseSchema,
  projectBranchesResponseSchema,
  projectSwitchBranchRequestSchema,
  projectSwitchBranchResponseSchema,
  qualityGateDefinitionsResponseSchema,
  qualityGateRunRequestSchema,
  qualityGateRunSchema,
  qualityGateRunsResponseSchema,
  worktreeCleanupRequestSchema,
  worktreeCleanupResponseSchema,
  worktreeCreateRequestSchema,
  worktreeDiffSchema,
  worktreeIdRequestSchema,
  worktreeStatusSchema,
  worktreesListResponseSchema
} from "@forgedeck/schemas";

export interface GitIpcServices {
  readonly projects: ProjectRepositoryService;
  readonly worktrees: WorktreeManager;
  readonly diffs: WorktreeDiffService;
  readonly qualityGates: QualityGateService;
  readonly reports: PrReadyReportService;
  readonly merges: ConfirmedMergeService;
  readonly chooseDirectory: () => Promise<string | null>;
  readonly chooseCloneDestination: () => Promise<string | null>;
  readonly confirmGitHubClone: (repositoryUrl: string) => Promise<boolean>;
  readonly confirmBranchSwitch: (branchName: string) => Promise<boolean>;
  readonly confirmCleanup: (worktreeId: string) => Promise<boolean>;
  readonly confirmMerge: (planId: string) => Promise<boolean>;
  readonly registerProjectRuntime?: (projectRoot: string) => Promise<void>;
}

export function registerGitIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  services: GitIpcServices
): void {
  const initializationCandidates = new Set<string>();
  register(ipc, PROJECTS_CHOOSE_CHANNEL, async (payload) => {
    assertNoPayload(payload);
    const directory = await services.chooseDirectory();
    if (directory === null) {
      return projectsChooseResponseSchema.parse({ project: null, initializationDirectory: null });
    }
    try {
      return projectsChooseResponseSchema.parse({
        project: toProjectDto(await addProjectAndRegisterRuntime(services, directory)),
        initializationDirectory: null
      });
    } catch (error: unknown) {
      if (!canInitializeGit(error)) throw error;
      initializationCandidates.add(directory);
      return projectsChooseResponseSchema.parse({
        project: null,
        initializationDirectory: directory
      });
    }
  });
  register(ipc, PROJECTS_INITIALIZE_GIT_CHANNEL, async (payload) => {
    const request = projectsInitializeGitRequestSchema.parse(payload);
    if (!initializationCandidates.delete(request.directory)) {
      throw new Error("Choose the local folder in Compazio before initializing Git.");
    }
    return projectsChooseResponseSchema.parse({
      project: toProjectDto(await initializeProjectAndRegisterRuntime(services, request.directory)),
      initializationDirectory: null
    });
  });
  register(ipc, PROJECTS_CLONE_GITHUB_CHANNEL, async (payload) => {
    const request = projectsCloneGitHubRequestSchema.parse(payload);
    const repository = parseGitHubRepositoryUrl(request.repositoryUrl);
    if (!(await services.confirmGitHubClone(repository.cloneUrl))) {
      throw new Error("GitHub clone was canceled in the native confirmation dialog");
    }
    const destination = await services.chooseCloneDestination();
    return projectsChooseResponseSchema.parse({
      project:
        destination === null
          ? null
          : toProjectDto(
              await cloneProjectAndRegisterRuntime(services, repository.cloneUrl, destination)
            )
    });
  });
  register(ipc, PROJECTS_LIST_CHANNEL, async (payload) => {
    assertNoPayload(payload);
    return projectsListResponseSchema.parse((await services.projects.list()).map(toProjectDto));
  });
  register(ipc, PROJECTS_LIST_BRANCHES_CHANNEL, async (payload) => {
    const request = projectIdRequestSchema.parse(payload);
    return projectBranchesResponseSchema.parse(
      await services.projects.listBranches(request.projectId)
    );
  });
  register(ipc, PROJECTS_SWITCH_BRANCH_CHANNEL, async (payload) => {
    const request = projectSwitchBranchRequestSchema.parse(payload);
    const preflight = await services.projects.listBranches(request.projectId);
    if (preflight.dirty) {
      throw new Error("Commit or stash local changes before switching branches");
    }
    if (!(await services.confirmBranchSwitch(request.branchName))) {
      throw new Error("Git branch switch was canceled in the native confirmation dialog");
    }
    return projectSwitchBranchResponseSchema.parse(
      await services.projects.switchBranch(request.projectId, request.branchName)
    );
  });
  register(ipc, WORKTREES_LIST_CHANNEL, async (payload) => {
    const request = projectIdRequestSchema.parse(payload);
    return worktreesListResponseSchema.parse(
      (await services.worktrees.list(request.projectId)).map(toWorktreeDto)
    );
  });
  register(ipc, WORKTREES_CREATE_CHANNEL, async (payload) => {
    const request = worktreeCreateRequestSchema.parse(payload);
    return managedWorktreeSchema.parse(toWorktreeDto(await services.worktrees.create(request)));
  });
  register(ipc, WORKTREES_STATUS_CHANNEL, async (payload) => {
    const request = worktreeIdRequestSchema.parse(payload);
    return worktreeStatusSchema.parse(await services.worktrees.status(request.worktreeId));
  });
  register(ipc, WORKTREES_DIFF_CHANNEL, async (payload) => {
    const request = worktreeIdRequestSchema.parse(payload);
    return worktreeDiffSchema.parse(await services.diffs.getDiff(request.worktreeId));
  });
  register(ipc, WORKTREES_CLEANUP_CHANNEL, async (payload) => {
    const request = worktreeCleanupRequestSchema.parse(payload);
    if (!(await services.confirmCleanup(request.worktreeId))) {
      throw new Error("Cleanup was canceled in the native confirmation dialog");
    }
    await services.worktrees.cleanup(request.worktreeId);
    return worktreeCleanupResponseSchema.parse({ removed: true });
  });
  register(ipc, QUALITY_GATES_DISCOVER_CHANNEL, async (payload) => {
    const request = worktreeIdRequestSchema.parse(payload);
    return qualityGateDefinitionsResponseSchema.parse(
      await services.qualityGates.discover(request.worktreeId)
    );
  });
  register(ipc, QUALITY_GATES_LIST_RUNS_CHANNEL, async (payload) => {
    const request = worktreeIdRequestSchema.parse(payload);
    return qualityGateRunsResponseSchema.parse(
      await services.qualityGates.listRuns(request.worktreeId)
    );
  });
  register(ipc, QUALITY_GATES_RUN_CHANNEL, async (payload) => {
    const request = qualityGateRunRequestSchema.parse(payload);
    return qualityGateRunSchema.parse(
      await services.qualityGates.run(request.worktreeId, request.presetId)
    );
  });
  register(ipc, DELIVERY_REPORT_GENERATE_CHANNEL, async (payload) => {
    const request = worktreeIdRequestSchema.parse(payload);
    return prReadyReportSchema.parse(await services.reports.generate(request.worktreeId));
  });
  register(ipc, MERGE_PREPARE_CHANNEL, async (payload) => {
    const request = worktreeIdRequestSchema.parse(payload);
    const preview = await services.merges.prepare(request.worktreeId);
    return mergePrepareResponseSchema.parse({
      plan: toMergePlanDto(preview.plan),
      confirmationToken: preview.confirmationToken
    });
  });
  register(ipc, MERGE_CONFIRM_CHANNEL, async (payload) => {
    const request = mergeConfirmRequestSchema.parse(payload);
    if (!(await services.confirmMerge(request.planId))) {
      throw new Error("Merge was canceled in the native confirmation dialog");
    }
    return mergeConfirmationResultSchema.parse(await services.merges.confirm(request));
  });
}

function canInitializeGit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /not inside a Git repository|must contain at least one commit/i.test(message);
}

async function addProjectAndRegisterRuntime(
  services: GitIpcServices,
  directory: string
): Promise<Awaited<ReturnType<ProjectRepositoryService["addDirectory"]>>> {
  const project = await services.projects.addDirectory(directory);
  await services.registerProjectRuntime?.(project.canonicalRootPath);
  return project;
}

async function cloneProjectAndRegisterRuntime(
  services: GitIpcServices,
  repositoryUrl: string,
  destination: string
): Promise<Awaited<ReturnType<ProjectRepositoryService["cloneGitHub"]>>> {
  const project = await services.projects.cloneGitHub(repositoryUrl, destination);
  await services.registerProjectRuntime?.(project.canonicalRootPath);
  return project;
}

async function initializeProjectAndRegisterRuntime(
  services: GitIpcServices,
  directory: string
): Promise<Awaited<ReturnType<ProjectRepositoryService["initializeDirectory"]>>> {
  const project = await services.projects.initializeDirectory(directory);
  await services.registerProjectRuntime?.(project.canonicalRootPath);
  return project;
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => Promise<unknown>
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}

function assertNoPayload(payload: unknown): void {
  if (payload !== undefined) {
    throw new Error("This IPC channel does not accept a payload");
  }
}

function toProjectDto(project: Awaited<ReturnType<ProjectRepositoryService["addDirectory"]>>) {
  return gitProjectSchema.parse({
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    defaultBranch: project.defaultBranch,
    headCommit: project.headCommit,
    updatedAt: project.updatedAt
  });
}

function toWorktreeDto(worktree: ManagedWorktree) {
  return managedWorktreeSchema.parse({
    id: worktree.id,
    projectId: worktree.projectId,
    taskKey: worktree.taskKey,
    taskTitle: worktree.taskTitle,
    branchName: worktree.branchName,
    baseRef: worktree.baseRef,
    state: worktree.state,
    createdAt: worktree.createdAt,
    updatedAt: worktree.updatedAt
  });
}

function toMergePlanDto(plan: MergePlanRecord) {
  return mergePlanSchema.parse({
    id: plan.id,
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    sourceBranch: plan.sourceBranch,
    targetBranch: plan.targetBranch,
    sourceHead: plan.sourceHead,
    targetHead: plan.targetHead,
    conflictedFiles: plan.conflictedFiles,
    requiredGateRunIds: plan.requiredGateRunIds,
    state: plan.state,
    eligible: plan.eligible,
    issues: plan.issues,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    confirmedAt: plan.confirmedAt,
    mergeCommit: plan.mergeCommit,
    error: plan.error
  });
}
