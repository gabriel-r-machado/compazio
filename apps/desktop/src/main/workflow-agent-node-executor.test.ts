import { describe, expect, it, vi } from "vitest";

import { workflowSchema } from "@forgedeck/workflow";

import { WorkflowAgentNodeExecutor } from "./workflow-agent-node-executor";

describe("WorkflowAgentNodeExecutor", () => {
  it("queues an audited request for the explicitly persisted agent target", async () => {
    const enqueue = vi.fn().mockReturnValue({ id: "message-1" });
    const executor = new WorkflowAgentNodeExecutor(
      { get: () => ({ workspaceId: "workspace-1", agentNodeId: "reviewer" }) },
      {
        listAgents: () => [{ nodeId: "reviewer", adapterId: "codex" }],
        enqueue
      }
    );
    const node = requireNode(
      workflowSchema.parse({
        schema_version: "1.0",
        id: "agent-check",
        name: "Agent check",
        concurrency: 1,
        permissions: {},
        nodes: [{ id: "deliver", type: "agent", role: "review", permissions: {} }]
      }).nodes[0]
    );

    const result = await executor.execute(node, context());

    expect(result).toMatchObject({ success: true });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        type: "message",
        metadata: expect.objectContaining({ agentNodeId: "reviewer" })
      })
    ]);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        recipientNodeId: "reviewer",
        senderNodeId: null,
        idempotencyKey: "workflow-agent:run-1:deliver:1"
      })
    );
    expect(enqueue.mock.calls[0]?.[0].content).not.toContain("C:\\");
  });

  it("does not choose an agent when the persisted target is missing", async () => {
    const enqueue = vi.fn();
    const executor = new WorkflowAgentNodeExecutor(
      { get: () => ({ workspaceId: "workspace-1", agentNodeId: null }) },
      { listAgents: () => [{ nodeId: "reviewer", adapterId: "codex" }], enqueue }
    );
    const node = requireNode(
      workflowSchema.parse({
        schema_version: "1.0",
        id: "agent-check",
        name: "Agent check",
        concurrency: 1,
        permissions: {},
        nodes: [{ id: "deliver", type: "agent", permissions: {} }]
      }).nodes[0]
    );

    await expect(executor.execute(node, context())).resolves.toMatchObject({
      success: false,
      reason: "adapter_unavailable"
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

function context() {
  return {
    runId: "run-1",
    nodeRunId: "node-run-1",
    attempt: 1,
    workflowVersion: "1.0",
    grantedPermissions: {},
    abortSignal: new AbortController().signal
  };
}

function requireNode<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected workflow node");
  return value;
}
