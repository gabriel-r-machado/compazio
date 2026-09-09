import type { WorkflowNode } from "@forgedeck/workflow";
import type {
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowNodeExecutor
} from "@forgedeck/orchestration";

interface WorkflowHandoffTargetStore {
  get(runId: string): { readonly workspaceId: string; readonly agentNodeId: string | null } | null;
}

interface WorkflowHandoffDraftStore {
  createWorkflowDraft(input: {
    readonly workspaceId: string;
    readonly sourceNodeId: string;
    readonly summary: string;
  }): { readonly id: string; readonly status: string };
}

/**
 * Creates a durable, reviewable draft along one visual handoff route. It never opens a terminal,
 * sends content to an agent, or advances the handoff beyond `draft`.
 */
export class WorkflowHandoffNodeExecutor implements WorkflowNodeExecutor {
  public constructor(
    private readonly targets: WorkflowHandoffTargetStore,
    private readonly handoffs: WorkflowHandoffDraftStore
  ) {}

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (node.type !== "handoff") return unavailable();
    const target = this.targets.get(context.runId);
    if (target === null || target.agentNodeId === null) return unavailable();
    try {
      const handoff = this.handoffs.createWorkflowDraft({
        workspaceId: target.workspaceId,
        sourceNodeId: target.agentNodeId,
        summary: `Workflow ${context.runId} prepared a handoff for human review.`
      });
      return {
        success: true,
        evidence: [
          {
            id: `workflow-handoff-${handoff.id}`,
            type: "artifact",
            summary: "A workflow handoff draft was created; manual approval is still required.",
            metadata: { handoffId: handoff.id, status: handoff.status }
          }
        ],
        output: { handoffId: handoff.id, status: handoff.status }
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      return {
        success: false,
        reason: message.includes("permission") ? "permission_denied" : "schema_invalid",
        message: "The workflow handoff draft could not be prepared from the approved canvas route.",
        evidence: []
      };
    }
  }
}

function unavailable(): Extract<NodeExecutionResult, { success: false }> {
  return {
    success: false,
    reason: "adapter_unavailable",
    message: "The selected workflow handoff target is not available.",
    evidence: []
  };
}
