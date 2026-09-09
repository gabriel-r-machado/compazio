import type { CommandSpec, Evidence, WorkflowNode } from "@forgedeck/workflow";

import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from "./contracts";

export interface ShellExecutionRequest {
  readonly command: CommandSpec;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly timeoutMs: number | undefined;
  readonly abortSignal: AbortSignal;
}

export interface ShellExecutionOutcome {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Platform adapters execute an already-approved command. They never receive a path, shell script,
 * environment, cwd or executable from CLI/IPC; those are resolved by the desktop runtime.
 */
export interface ShellExecutionAdapter {
  execute(input: ShellExecutionRequest): Promise<ShellExecutionOutcome>;
}

/** Stable failure categories exposed by an internal shell adapter. */
export class ShellExecutionAdapterError extends Error {
  public constructor(public readonly code: "adapter_unavailable" | "target_unavailable") {
    super(
      code === "adapter_unavailable"
        ? "Workflow shell adapter is unavailable"
        : "Workflow target is unavailable"
    );
    this.name = "ShellExecutionAdapterError";
  }
}

/** Executes trusted shell and quality-gate nodes with no client-defined command surface. */
export class ShellWorkflowNodeExecutor implements WorkflowNodeExecutor {
  public constructor(private readonly shell: ShellExecutionAdapter) {}

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (node.type !== "shell" && node.type !== "quality_gate") {
      return unavailable("Node is not an executable workflow step");
    }
    if (context.grantedPermissions.process !== true || node.permissions.process !== true) {
      return {
        success: false,
        reason: "permission_denied",
        message: "The workflow shell step is not permitted to start a process.",
        evidence: []
      };
    }
    if (node.command === undefined) {
      return {
        success: false,
        reason: "schema_invalid",
        message: "The trusted workflow shell step has no approved command.",
        evidence: []
      };
    }
    let outcome: ShellExecutionOutcome;
    try {
      outcome = await this.shell.execute({
        command: node.command,
        runId: context.runId,
        nodeRunId: context.nodeRunId,
        nodeId: node.id,
        attempt: context.attempt,
        timeoutMs: node.timeout_ms,
        abortSignal: context.abortSignal
      });
    } catch (error: unknown) {
      if (error instanceof ShellExecutionAdapterError) {
        return unavailable("The approved workflow shell adapter is unavailable.");
      }
      throw error;
    }
    if (outcome.timedOut) {
      return {
        success: false,
        reason: "timeout",
        message: "The approved workflow shell step reached its timeout.",
        evidence: []
      };
    }
    if (outcome.exitCode !== 0) {
      return {
        success: false,
        reason: "process_exit_nonzero",
        message: "The approved workflow shell step exited unsuccessfully.",
        evidence: []
      };
    }
    return {
      success: true,
      evidence: [successEvidence(node, outcome)],
      output: { exitCode: 0, durationMs: outcome.durationMs }
    };
  }
}

/**
 * Deterministic fake adapter used before any real process adapter. It makes shell behavior
 * testable without spawning a process, inspecting PATH, or accepting an arbitrary command.
 */
export class FakeShellExecutionAdapter implements ShellExecutionAdapter {
  public readonly requests: ShellExecutionRequest[] = [];

  public constructor(
    private readonly outcomes: Readonly<Record<string, ShellExecutionOutcome>> = {}
  ) {}

  public async execute(input: ShellExecutionRequest): Promise<ShellExecutionOutcome> {
    this.requests.push(input);
    if (input.abortSignal.aborted) return { exitCode: null, durationMs: 0, timedOut: false };
    return (
      this.outcomes[input.command.executable] ?? {
        exitCode: 0,
        durationMs: 1,
        timedOut: false
      }
    );
  }
}

function successEvidence(node: WorkflowNode, outcome: ShellExecutionOutcome): Evidence {
  return {
    id: `shell-exit-${node.id}`,
    type: node.type === "quality_gate" ? "test" : "exit_code",
    summary:
      node.type === "quality_gate"
        ? `Approved quality gate ${node.id} passed with exit code 0 in ${outcome.durationMs}ms.`
        : `Approved shell step ${node.id} completed with exit code 0 in ${outcome.durationMs}ms.`,
    metadata: { exitCode: 0, durationMs: outcome.durationMs }
  };
}

function unavailable(message: string): NodeExecutionResult {
  return {
    success: false,
    reason: "adapter_unavailable",
    message,
    evidence: []
  };
}
