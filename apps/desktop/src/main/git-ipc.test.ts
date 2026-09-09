import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  MERGE_CONFIRM_CHANNEL,
  PROJECTS_CLONE_GITHUB_CHANNEL,
  PROJECTS_CHOOSE_CHANNEL,
  PROJECTS_INITIALIZE_GIT_CHANNEL,
  PROJECTS_SWITCH_BRANCH_CHANNEL,
  QUALITY_GATES_RUN_CHANNEL,
  WORKTREES_CLEANUP_CHANNEL,
  WORKTREES_CREATE_CHANNEL
} from "@forgedeck/schemas";

import { registerGitIpc } from "./git-ipc";
import type { GitIpcServices } from "./git-ipc";

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

function createHarness(services: GitIpcServices) {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    }
  } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
  registerGitIpc(ipc, services);
  return {
    invoke(channel: string, payload?: unknown) {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`Missing handler: ${channel}`);
      return handler({}, payload);
    }
  };
}

function createServices() {
  const project = {
    id: "project-1",
    name: "ForgeDeck",
    rootPath: "C:/chosen/by/main",
    canonicalRootPath: "C:/chosen/by/main",
    defaultBranch: "main",
    headCommit: "a".repeat(40),
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z"
  };
  const mocks = {
    addDirectory: vi.fn(async () => project),
    initializeDirectory: vi.fn(async () => project),
    cloneGitHub: vi.fn(async () => project),
    switchBranch: vi.fn(async () => ({ currentBranch: "feature/ui", headCommit: "b".repeat(40) })),
    create: vi.fn(),
    cleanup: vi.fn(),
    runGate: vi.fn(),
    confirmMerge: vi.fn(),
    confirmCleanupUi: vi.fn(async () => true),
    confirmMergeUi: vi.fn(async () => true),
    confirmGitHubCloneUi: vi.fn(async () => true),
    confirmBranchSwitchUi: vi.fn(async () => true)
  };
  const services = {
    projects: {
      addDirectory: mocks.addDirectory,
      initializeDirectory: mocks.initializeDirectory,
      cloneGitHub: mocks.cloneGitHub,
      list: vi.fn(async () => [project]),
      listBranches: vi.fn(async () => ({
        currentBranch: "main",
        dirty: false,
        branches: [{ name: "main", current: true }]
      })),
      switchBranch: mocks.switchBranch
    },
    worktrees: {
      list: vi.fn(async () => []),
      create: mocks.create,
      status: vi.fn(),
      cleanup: mocks.cleanup
    },
    diffs: { getDiff: vi.fn() },
    qualityGates: {
      discover: vi.fn(async () => []),
      listRuns: vi.fn(async () => []),
      run: mocks.runGate
    },
    reports: { generate: vi.fn() },
    merges: { prepare: vi.fn(), confirm: mocks.confirmMerge },
    chooseDirectory: vi.fn(async () => "C:/chosen/by/main"),
    chooseCloneDestination: vi.fn(async () => "C:/chosen/by/main"),
    confirmCleanup: mocks.confirmCleanupUi,
    confirmMerge: mocks.confirmMergeUi,
    confirmGitHubClone: mocks.confirmGitHubCloneUi,
    confirmBranchSwitch: mocks.confirmBranchSwitchUi
  } as unknown as GitIpcServices;
  return { services, mocks };
}

describe("Git IPC boundary", () => {
  it("gets repository paths only from the main-process chooser", async () => {
    const { services, mocks } = createServices();
    const ipc = createHarness(services);

    const response = await ipc.invoke(PROJECTS_CHOOSE_CHANNEL);

    expect(services.chooseDirectory).toHaveBeenCalledOnce();
    expect(mocks.addDirectory).toHaveBeenCalledWith("C:/chosen/by/main");
    expect(response).toMatchObject({ project: { id: "project-1", name: "ForgeDeck" } });
    await expect(ipc.invoke(PROJECTS_CHOOSE_CHANNEL, { path: "C:/renderer" })).rejects.toThrow();
  });

  it("offers Git initialization only for the directory just selected in the native picker", async () => {
    const { services, mocks } = createServices();
    mocks.addDirectory.mockRejectedValueOnce(
      new Error("Selected directory is not inside a Git repository")
    );
    const ipc = createHarness(services);

    await expect(ipc.invoke(PROJECTS_CHOOSE_CHANNEL)).resolves.toEqual({
      project: null,
      initializationDirectory: "C:/chosen/by/main"
    });
    await expect(
      ipc.invoke(PROJECTS_INITIALIZE_GIT_CHANNEL, { directory: "C:/other-folder" })
    ).rejects.toThrow("Choose the local folder");

    const initialized = await ipc.invoke(PROJECTS_INITIALIZE_GIT_CHANNEL, {
      directory: "C:/chosen/by/main"
    });
    expect(initialized).toMatchObject({ project: { id: "project-1" } });
    expect(mocks.initializeDirectory).toHaveBeenCalledWith("C:/chosen/by/main");
  });

  it("accepts only a validated GitHub repository URL and keeps its destination in the main process", async () => {
    const { services, mocks } = createServices();
    const ipc = createHarness(services);

    await ipc.invoke(PROJECTS_CLONE_GITHUB_CHANNEL, {
      repositoryUrl: "https://github.com/ForgeDeck/desktop.git"
    });

    expect(services.confirmGitHubClone).toHaveBeenCalledWith(
      "https://github.com/ForgeDeck/desktop.git"
    );
    expect(services.chooseCloneDestination).toHaveBeenCalledOnce();
    expect(mocks.cloneGitHub).toHaveBeenCalledWith(
      "https://github.com/ForgeDeck/desktop.git",
      "C:/chosen/by/main"
    );
    await expect(
      ipc.invoke(PROJECTS_CLONE_GITHUB_CHANNEL, {
        repositoryUrl: "https://example.com/not/allowed.git"
      })
    ).rejects.toThrow("GitHub HTTPS repository URL");
    expect(mocks.cloneGitHub).toHaveBeenCalledOnce();
  });

  it("requires native confirmation before switching a validated local branch", async () => {
    const { services, mocks } = createServices();
    const ipc = createHarness(services);

    await ipc.invoke(PROJECTS_SWITCH_BRANCH_CHANNEL, {
      projectId: "project-1",
      branchName: "feature/ui"
    });

    expect(mocks.confirmBranchSwitchUi).toHaveBeenCalledWith("feature/ui");
    expect(mocks.switchBranch).toHaveBeenCalledWith("project-1", "feature/ui");
  });

  it("does not open native confirmation when the project has local changes", async () => {
    const { services, mocks } = createServices();
    vi.mocked(services.projects.listBranches).mockResolvedValue({
      currentBranch: "main",
      dirty: true,
      branches: [{ name: "main", current: true }]
    });
    const ipc = createHarness(services);

    await expect(
      ipc.invoke(PROJECTS_SWITCH_BRANCH_CHANNEL, {
        projectId: "project-1",
        branchName: "feature/ui"
      })
    ).rejects.toThrow("Commit or stash local changes");

    expect(mocks.confirmBranchSwitchUi).not.toHaveBeenCalled();
    expect(mocks.switchBranch).not.toHaveBeenCalled();
  });

  it("requires native confirmation before cleanup", async () => {
    const { services, mocks } = createServices();
    mocks.confirmCleanupUi.mockResolvedValue(false);
    const ipc = createHarness(services);
    await expect(
      ipc.invoke(WORKTREES_CLEANUP_CHANNEL, { worktreeId: "worktree-1", confirmed: true })
    ).rejects.toThrow("native confirmation");
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("rejects renderer paths, refs, commands and missing confirmations", async () => {
    const { services, mocks } = createServices();
    const ipc = createHarness(services);

    await expect(
      ipc.invoke(WORKTREES_CREATE_CHANNEL, {
        projectId: "project-1",
        taskKey: "FD-4",
        taskTitle: "Git foundation",
        path: "C:/renderer"
      })
    ).rejects.toThrow();
    await expect(
      ipc.invoke(QUALITY_GATES_RUN_CHANNEL, {
        worktreeId: "worktree-1",
        presetId: "lint",
        command: "echo forged",
        confirmed: true
      })
    ).rejects.toThrow();
    await expect(
      ipc.invoke(WORKTREES_CLEANUP_CHANNEL, { worktreeId: "worktree-1", confirmed: false })
    ).rejects.toThrow();
    await expect(
      ipc.invoke(MERGE_CONFIRM_CHANNEL, {
        planId: "plan-1",
        confirmationToken: "b".repeat(64),
        targetRef: "unsafe",
        confirmed: true
      })
    ).rejects.toThrow();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.runGate).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.confirmMerge).not.toHaveBeenCalled();
  });
});
