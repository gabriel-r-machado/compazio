import { describe, expect, it, vi } from "vitest";

import { workflowSchema } from "@forgedeck/workflow";

import { WorkflowHandoffNodeExecutor } from "./workflow-handoff-node-executor";

describe("WorkflowHandoffNodeExecutor", () => {
  it("creates a reviewable draft from the persisted source target without delivering it", async () => {
    const createWorkflowDraft = vi.fn().mockReturnValue({ id: "handoff-1", status: "draft" });
    const executor = new WorkflowHandoffNodeExecutor(
      { get: () => ({ workspaceId: "workspace-1", agentNodeId: "author" }) },
      { createWorkflowDraft }
    );

    const result = await executor.execute(node(), context());

    expect(result).toMatchObject({ success: true, output: { handoffId: "handoff-1" } });
    expect(createWorkflowDraft).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceNodeId: "author",
      summary: "Workflow run-1 prepared a handoff for human review."
    });
    expect(JSON.stringify(result)).not.toContain("delivered");
  });

  it("fails closed when the source agent lacks the handoff permission", async () => {
    const executor = new WorkflowHandoffNodeExecutor(
      { get: () => ({ workspaceId: "workspace-1", agentNodeId: "author" }) },
      {
        createWorkflowDraft: () => {
          throw new Error("create_handoffs permission denied");
        }
      }
    );

    await expect(executor.execute(node(), context())).resolves.toMatchObject({
      success: false,
      reason: "permission_denied"
    });
  });
});

function node() {
  const value = workflowSchema.parse({
    schema_version: "1.0",
    id: "handoff-check",
    name: "Handoff check",
    concurrency: 1,
    permissions: {},
    nodes: [{ id: "prepare", type: "handoff", permissions: {} }]
  }).nodes[0];
  if (value === undefined) throw new Error("Expected handoff node");
  return value;
}

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
