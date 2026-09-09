import type { WorkflowNode } from "@forgedeck/workflow";
import type {
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowNodeExecutor
} from "@forgedeck/orchestration";
import type { AgentMessage } from "@forgedeck/schemas";

interface AgentTarget {
  readonly workspaceId: string;
  readonly agentNodeId: string | null;
}

interface WorkflowAgentTargetStore {
  get(runId: string): AgentTarget | null;
}

interface WorkflowAgentDirectory {
  listAgents(workspaceId: string): readonly {
    readonly nodeId: string;
    readonly adapterId: string;
  }[];
  enqueue(input: {
    readonly workspaceId: string;
    readonly recipientNodeId: string;
    readonly senderNodeId: null;
    readonly content: string;
    readonly idempotencyKey: string;
    /** A workflow node never blocks on the reply; the scheduler owns when the task completes. */
    readonly awaitedBySender: false;
  }): AgentMessage;
}

/**
 * Uses the existing durable Agent Bridge message queue. It never starts an agent, opens a
 * terminal, or receives raw terminal output: a human selects an already-declared canvas agent
 * when starting the trusted workflow template.
 */
export class WorkflowAgentNodeExecutor implements WorkflowNodeExecutor {
  public constructor(
    private readonly targets: WorkflowAgentTargetStore,
    private readonly agents: WorkflowAgentDirectory
  ) {}

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (node.type !== "agent") return unavailable();
    const target = this.targets.get(context.runId);
    if (target?.agentNodeId === null || target === null) return unavailable();
    const agent = this.agents
      .listAgents(target.workspaceId)
      .find((candidate) => candidate.nodeId === target.agentNodeId);
    if (agent === undefined || agent.adapterId === "shell") return unavailable();
    try {
      const message = this.agents.enqueue({
        workspaceId: target.workspaceId,
        recipientNodeId: agent.nodeId,
        senderNodeId: null,
        content: formatTrustedRequest(node, context),
        idempotencyKey: `workflow-agent:${context.runId}:${node.id}:${context.attempt}`,
        awaitedBySender: false
      });
      return {
        success: true,
        evidence: [
          {
            id: `workflow-message-${message.id}`,
            type: "message",
            summary: "Approved workflow request queued for the selected local agent.",
            metadata: { messageId: message.id, agentNodeId: agent.nodeId }
          }
        ],
        output: { queued: true }
      };
    } catch {
      return {
        success: false,
        reason: "permission_denied",
        message: "The local policy did not allow this workflow delivery.",
        evidence: []
      };
    }
  }
}

function unavailable(): Extract<NodeExecutionResult, { success: false }> {
  return {
    success: false,
    reason: "adapter_unavailable",
    message: "The selected local agent is not available for this workflow.",
    evidence: []
  };
}

function formatTrustedRequest(node: WorkflowNode, context: NodeExecutionContext): string {
  return [
    "Approved local workflow request.",
    `workflow_run: ${context.runId}`,
    `workflow_node: ${node.id}`,
    `role: ${node.role ?? "delivery"}`,
    "Acknowledge or respond through the Compazio message lifecycle."
  ].join("\n");
}
