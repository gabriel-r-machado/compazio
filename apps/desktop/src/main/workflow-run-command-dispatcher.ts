import type { WorkflowRunCommand } from "@forgedeck/local-db";
import type { ContextSelectionMode } from "@forgedeck/schemas";
import type {
  WorkflowExecutionCheckpointReference,
  WorkflowRunExecutionContext
} from "@forgedeck/orchestration";

import type { WorkflowRunRuntime } from "./workflow-run-runtime";

export interface WorkflowRunCommandQueue {
  claimNext(): WorkflowRunCommand | null;
  markApplied(command: WorkflowRunCommand, resultRunId: string | null): WorkflowRunCommand;
  markFailed(command: WorkflowRunCommand, errorCode: string): void;
}

export interface WorkflowRunExecutionTargetResolver {
  resolveWorkspace(workspaceId: string): Promise<{
    readonly workspaceId: string;
    readonly projectId: string;
    readonly root: string;
  } | null>;
  getRunTarget(runId: string): {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly agentNodeId: string | null;
    readonly worktreeId: string | null;
  } | null;
  bindRunTarget(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly agentNodeId: string | null;
    readonly worktreeId: string | null;
  }): void;
}

/** Creates a managed worktree from runtime-owned task metadata; it never accepts a filesystem path. */
export interface WorkflowRunWorktreeManager {
  create(input: {
    readonly projectId: string;
    readonly taskKey: string;
    readonly taskTitle: string;
  }): Promise<{ readonly id: string; readonly path: string }>;
}

/**
 * The dispatcher owns checkpoint timing: function context before execution and delivery context
 * before the scheduler writes its final report. It receives only safe identifiers and never a
 * renderer-provided context payload.
 */
export interface WorkflowRunExecutionContextFactory {
  createFunctionContext(input: {
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly task: string;
    readonly contractId: string | null;
    readonly contextMode: ContextSelectionMode;
  }): WorkflowRunExecutionContext;
  createDeliveryCheckpoint(input: {
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly task: string;
    readonly contractId: string | null;
  }): Promise<WorkflowExecutionCheckpointReference>;
}

/** Drains durable manual commands only while the desktop-owned runtime is active. */
export class WorkflowRunCommandDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  public constructor(
    private readonly queue: WorkflowRunCommandQueue,
    private readonly runtime: WorkflowRunRuntime,
    private readonly targets: WorkflowRunExecutionTargetResolver,
    private readonly contexts: WorkflowRunExecutionContextFactory,
    private readonly worktrees: WorkflowRunWorktreeManager | null = null
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.drain(), 250);
    this.timer.unref();
    void this.drain();
  }

  public stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  public async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const command = this.queue.claimNext();
        if (command === null) return;
        try {
          const resultRunId = await this.apply(command);
          this.queue.markApplied(command, resultRunId);
        } catch (error: unknown) {
          this.queue.markFailed(command, errorCode(error));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async apply(command: WorkflowRunCommand): Promise<string | null> {
    if (command.action === "start") {
      if (command.templateId === null || command.workspaceId === null || command.dryRun === null) {
        throw new Error("Invalid workflow start command");
      }
      if (command.agentNodeId === null || command.task === null) {
        throw new Error("Workflow execution requires an agent and task context");
      }
      const target = await this.requireWorkspace(command.workspaceId);
      const worktree = await this.createWorktreeIfRequired({
        templateId: command.templateId,
        dryRun: command.dryRun,
        projectId: target.projectId,
        taskKey: command.id,
        task: command.task
      });
      const executionContext = this.createExecutionContext({
        workspaceId: target.workspaceId,
        agentNodeId: command.agentNodeId,
        task: command.task,
        contractId: command.contractId,
        contextMode: command.contextMode ?? "full"
      });
      const handle = this.runtime.startTemplate(command.templateId, command.dryRun, {
        ...target,
        ...(worktree === null ? {} : { root: worktree.path, worktreeId: worktree.id }),
        agentNodeId: command.agentNodeId,
        executionContext
      });
      this.targets.bindRunTarget({
        runId: handle.runId,
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        agentNodeId: command.agentNodeId,
        worktreeId: worktree?.id ?? null
      });
      return handle.runId;
    }
    if (command.runId === null) throw new Error("Invalid workflow control command");
    if (command.action === "pause") {
      await this.runtime.pause(command.runId);
      return command.runId;
    }
    if (command.action === "resume") {
      await this.runtime.resume(command.runId);
      return command.runId;
    }
    if (command.action === "cancel") {
      await this.runtime.cancel(command.runId);
      return command.runId;
    }
    if (command.action === "retry" || command.action === "alternative") {
      const previous = this.targets.getRunTarget(command.runId);
      if (previous === null) throw new Error("Workflow target was not found");
      if (previous.agentNodeId === null) {
        throw new Error("Workflow execution context is unavailable for this historical run");
      }
      const run = this.runtime.show(command.runId);
      const previousContext = run.executionContext;
      if (previousContext === null || previousContext === undefined) {
        throw new Error("Workflow execution context is unavailable for this historical run");
      }
      const target = await this.requireWorkspace(previous.workspaceId);
      const worktree = await this.createWorktreeIfRequired({
        templateId: run.workflowId,
        dryRun: run.dryRun,
        projectId: target.projectId,
        taskKey: command.id,
        task: previousContext.task
      });
      const executionContext = this.createExecutionContext({
        workspaceId: target.workspaceId,
        agentNodeId: previous.agentNodeId,
        task: previousContext.task,
        contractId: previousContext.contractId,
        contextMode: previousContext.contextMode ?? "full"
      });
      const handle = this.runtime.retry(
        command.runId,
        {
          ...target,
          ...(worktree === null ? {} : { root: worktree.path, worktreeId: worktree.id }),
          agentNodeId: previous.agentNodeId,
          executionContext
        },
        command.action === "alternative"
          ? {
              nodeId: requireNodeId(command),
              scope: "dependents",
              alternativeLabel: command.alternativeLabel
            }
          : command.nodeId === null || command.retryScope === "run"
            ? undefined
            : { nodeId: command.nodeId, scope: command.retryScope }
      );
      this.targets.bindRunTarget({
        runId: handle.runId,
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        agentNodeId: previous.agentNodeId,
        worktreeId: worktree?.id ?? null
      });
      return handle.runId;
    }
    if (command.nodeId === null) throw new Error("Invalid workflow approval command");
    await this.runtime.resolveApproval(command.runId, command.nodeId, {
      approved: command.action === "approve",
      note: command.decisionNote ?? ""
    });
    return command.runId;
  }

  private createExecutionContext(input: {
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly task: string;
    readonly contractId: string | null;
    readonly contextMode: ContextSelectionMode;
  }) {
    return {
      context: this.contexts.createFunctionContext(input),
      createDeliveryCheckpoint: () => this.contexts.createDeliveryCheckpoint(input)
    };
  }

  private async createWorktreeIfRequired(input: {
    readonly templateId: string;
    readonly dryRun: boolean;
    readonly projectId: string;
    readonly taskKey: string;
    readonly task: string;
  }): Promise<{ readonly id: string; readonly path: string } | null> {
    if (!this.runtime.requiresGitWorktree(input.templateId) || input.dryRun) return null;
    if (this.worktrees === null) throw new Error("Managed Git worktree service is unavailable");
    return this.worktrees.create({
      projectId: input.projectId,
      taskKey: input.taskKey,
      taskTitle: input.task.slice(0, 160)
    });
  }

  private async requireWorkspace(workspaceId: string): Promise<{
    readonly workspaceId: string;
    readonly projectId: string;
    readonly root: string;
  }> {
    const target = await this.targets.resolveWorkspace(workspaceId);
    if (target === null) throw new Error("Workflow target was not found");
    return target;
  }
}

function requireNodeId(command: WorkflowRunCommand): string {
  if (command.nodeId === null) throw new Error("Workflow alternative node is unavailable");
  return command.nodeId;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("not found") || message.includes("unknown workflow")) return "run_not_found";
  if (message.includes("not available")) return "template_not_available";
  if (message.includes("cannot")) return "invalid_run_state";
  if (message.includes("approval")) return "approval_not_pending";
  if (message.includes("target")) return "target_not_available";
  if (message.includes("worktree")) return "target_not_available";
  if (message.includes("context") || message.includes("agent and task")) {
    return "execution_context_required";
  }
  return "workflow_control_failed";
}
