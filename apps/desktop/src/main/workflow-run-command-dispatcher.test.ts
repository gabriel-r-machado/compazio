import { describe, expect, it, vi } from "vitest";

import type { WorkflowRunCommand } from "@forgedeck/local-db";
import type { WorkflowRunRuntime } from "./workflow-run-runtime";

import {
  WorkflowRunCommandDispatcher,
  type WorkflowRunExecutionContextFactory
} from "./workflow-run-command-dispatcher";

describe("WorkflowRunCommandDispatcher", () => {
  it("applies a typed start once and records the newly created run id", async () => {
    const command = workflowCommand({
      action: "start",
      workspaceId: "workspace-1",
      agentNodeId: "reviewer",
      task: "Verify the delivery report",
      templateId: "delivery-report",
      dryRun: false
    });
    const queue = queueWith(command);
    const startTemplate = vi
      .fn()
      .mockReturnValue({ runId: "run-new", completion: Promise.resolve({}) });
    const runtime = {
      startTemplate,
      requiresGitWorktree: vi.fn().mockReturnValue(false)
    } as unknown as WorkflowRunRuntime;
    const targets = targetResolver();
    const contexts = contextFactory();
    const dispatcher = new WorkflowRunCommandDispatcher(queue, runtime, targets, contexts);

    await dispatcher.drain();

    expect(startTemplate).toHaveBeenCalledWith(
      "delivery-report",
      false,
      expect.objectContaining({
        workspaceId: "workspace-1",
        projectId: "project-1",
        root: "C:\\approved-project",
        agentNodeId: "reviewer",
        executionContext: expect.objectContaining({
          context: expect.objectContaining({
            task: "Verify the delivery report",
            functionCheckpoint: expect.objectContaining({ checkpointId: "checkpoint-function" })
          })
        })
      })
    );
    expect(targets.bindRunTarget).toHaveBeenCalledWith({
      runId: "run-new",
      workspaceId: "workspace-1",
      projectId: "project-1",
      agentNodeId: "reviewer",
      worktreeId: null
    });
    expect(queue.markApplied).toHaveBeenCalledWith(command, "run-new");
    expect(queue.markFailed).not.toHaveBeenCalled();
  });

  it("does not leak runtime errors when an approval command cannot be applied", async () => {
    const command = workflowCommand({ action: "approve", runId: "run-1", nodeId: "review" });
    const queue = queueWith(command);
    const runtime = {
      resolveApproval: vi
        .fn()
        .mockRejectedValue(new Error("No approval is pending for node review"))
    } as unknown as WorkflowRunRuntime;
    const dispatcher = new WorkflowRunCommandDispatcher(
      queue,
      runtime,
      targetResolver(),
      contextFactory()
    );

    await dispatcher.drain();

    expect(queue.markFailed).toHaveBeenCalledWith(command, "approval_not_pending");
  });

  it("creates and persists a fresh managed worktree for isolated templates", async () => {
    const command = workflowCommand({
      action: "start",
      workspaceId: "workspace-1",
      agentNodeId: "reviewer",
      task: "Implement the reviewed change",
      templateId: "blueprint-to-pr",
      dryRun: false
    });
    const queue = queueWith(command);
    const startTemplate = vi
      .fn()
      .mockReturnValue({ runId: "run-isolated", completion: Promise.resolve({}) });
    const runtime = {
      startTemplate,
      requiresGitWorktree: vi.fn().mockReturnValue(true)
    } as unknown as WorkflowRunRuntime;
    const targets = targetResolver();
    const create = vi.fn().mockResolvedValue({
      id: "worktree-1",
      path: "C:\\managed-worktrees\\worktree-1"
    });
    const dispatcher = new WorkflowRunCommandDispatcher(queue, runtime, targets, contextFactory(), {
      create
    });

    await dispatcher.drain();

    expect(create).toHaveBeenCalledWith({
      projectId: "project-1",
      taskKey: "command-1",
      taskTitle: "Implement the reviewed change"
    });
    expect(startTemplate).toHaveBeenCalledWith(
      "blueprint-to-pr",
      false,
      expect.objectContaining({
        root: "C:\\managed-worktrees\\worktree-1",
        worktreeId: "worktree-1"
      })
    );
    expect(targets.bindRunTarget).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-isolated", worktreeId: "worktree-1" })
    );
  });

  it("creates a new managed worktree when selectively retrying an isolated run", async () => {
    const command = workflowCommand({
      action: "retry",
      runId: "run-old",
      nodeId: "quality",
      retryScope: "dependents"
    });
    const queue = queueWith(command);
    const retry = vi.fn().mockReturnValue({ runId: "run-retry", completion: Promise.resolve({}) });
    const runtime = {
      show: vi.fn().mockReturnValue({
        workflowId: "blueprint-to-pr",
        dryRun: false,
        executionContext: { task: "Implement the reviewed change", contractId: null }
      }),
      retry,
      requiresGitWorktree: vi.fn().mockReturnValue(true)
    } as unknown as WorkflowRunRuntime;
    const targets = {
      ...targetResolver(),
      getRunTarget: vi.fn().mockReturnValue({
        workspaceId: "workspace-1",
        projectId: "project-1",
        agentNodeId: "reviewer",
        worktreeId: "worktree-old"
      })
    };
    const create = vi.fn().mockResolvedValue({
      id: "worktree-retry",
      path: "C:\\managed-worktrees\\worktree-retry"
    });
    const dispatcher = new WorkflowRunCommandDispatcher(queue, runtime, targets, contextFactory(), {
      create
    });

    await dispatcher.drain();

    expect(create).toHaveBeenCalledWith({
      projectId: "project-1",
      taskKey: "command-1",
      taskTitle: "Implement the reviewed change"
    });
    expect(retry).toHaveBeenCalledWith(
      "run-old",
      expect.objectContaining({
        root: "C:\\managed-worktrees\\worktree-retry",
        worktreeId: "worktree-retry"
      }),
      { nodeId: "quality", scope: "dependents" }
    );
    expect(targets.bindRunTarget).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-retry", worktreeId: "worktree-retry" })
    );
  });
});

function queueWith(command: WorkflowRunCommand) {
  let next: WorkflowRunCommand | null = command;
  return {
    claimNext: vi.fn(() => {
      const claimed = next;
      next = null;
      return claimed;
    }),
    markApplied: vi.fn(),
    markFailed: vi.fn()
  };
}

function targetResolver() {
  return {
    resolveWorkspace: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      projectId: "project-1",
      root: "C:\\approved-project"
    }),
    getRunTarget: vi.fn().mockReturnValue(null),
    bindRunTarget: vi.fn()
  };
}

function workflowCommand(
  values: Pick<WorkflowRunCommand, "action"> & Partial<WorkflowRunCommand>
): WorkflowRunCommand {
  return {
    id: "command-1",
    action: values.action,
    status: "applying",
    runId: values.runId ?? null,
    workspaceId: values.workspaceId ?? null,
    agentNodeId: values.agentNodeId ?? null,
    task: values.task ?? null,
    contractId: values.contractId ?? null,
    nodeId: values.nodeId ?? null,
    retryScope: values.retryScope ?? "run",
    alternativeLabel: values.alternativeLabel ?? null,
    templateId: values.templateId ?? null,
    dryRun: values.dryRun ?? null,
    decisionNote: values.decisionNote ?? null,
    requestedBy: "compasso-cli",
    createdAt: "2026-07-20T12:00:00.000Z",
    appliedAt: null,
    resultRunId: null,
    errorCode: null
  };
}

function contextFactory(): WorkflowRunExecutionContextFactory {
  return {
    createFunctionContext: vi.fn((input) => ({
      ...input,
      profileVersion: 1,
      missionVersion: null,
      memoryVersion: null,
      contractVersion: null,
      functionCheckpoint: {
        checkpointId: "checkpoint-function",
        snapshotId: "snapshot-function",
        sha256: "a".repeat(64),
        createdAt: "2026-07-20T12:00:00.000Z"
      },
      deliveryCheckpoint: null
    })),
    createDeliveryCheckpoint: vi.fn(async () => ({
      checkpointId: "checkpoint-delivery",
      snapshotId: "snapshot-delivery",
      sha256: "b".repeat(64),
      createdAt: "2026-07-20T12:00:01.000Z"
    }))
  };
}
