import type {
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowNodeExecutor
} from "@forgedeck/orchestration";
import type { WorkflowNode } from "@forgedeck/workflow";

import type { AgentAdapterRegistry } from "./agent-adapter-registry";

/**
 * Routes an `agent` node to the right executor strictly by `node.adapter`:
 *
 * - a known process adapter (e.g. `claude-code`) runs through the shared ProcessAgentNodeExecutor;
 * - a declared but unknown adapter id fails here, before any process is started;
 * - an adapter-less agent node keeps the existing message-based delivery path.
 *
 * It introduces no runtime, scheduler, queue or persistence — it only picks an already-constructed
 * executor. The node title, prompt text or visual name never influence the choice.
 */
export class AgentNodeExecutorRouter implements WorkflowNodeExecutor {
  public constructor(
    private readonly registry: AgentAdapterRegistry,
    private readonly processExecutor: WorkflowNodeExecutor,
    private readonly fallback: WorkflowNodeExecutor | null
  ) {}

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (node.type !== "agent") return this.delegateFallback(node, context);

    const adapterId = node.adapter;
    if (adapterId === undefined) return this.delegateFallback(node, context);

    if (this.registry.has(adapterId)) {
      return this.processExecutor.execute(node, context);
    }
    return {
      success: false,
      reason: "adapter_unavailable",
      message: `No agent adapter is registered for "${adapterId}".`,
      evidence: []
    };
  }

  private async delegateFallback(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (this.fallback === null) {
      return {
        success: false,
        reason: "adapter_unavailable",
        message: "This workflow node requires an executor that is not enabled.",
        evidence: []
      };
    }
    return this.fallback.execute(node, context);
  }
}
