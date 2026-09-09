import { describe, expect, it, vi } from "vitest";

import type { OrchestrationProposal } from "@forgedeck/schemas";

import { OrchestrationProposalExecutionService } from "./orchestration-proposal-execution-service";

describe("OrchestrationProposalExecutionService", () => {
  it("materializes one approved proposal through the existing command store", () => {
    const command = queuedCommand();
    const commands = {
      getForProposal: vi.fn().mockReturnValue(null),
      requestStart: vi.fn().mockReturnValue(command)
    };
    const policy = { assertAllowed: vi.fn() };
    const service = new OrchestrationProposalExecutionService(
      { get: vi.fn().mockReturnValue(approvedProposal()) },
      commands,
      { listAgents: vi.fn().mockReturnValue([{ nodeId: "reviewer" }]) },
      policy
    );

    expect(service.request({ workspaceId: "workspace-1", proposalId: approvedProposal().id })).toBe(
      command
    );
    expect(commands.requestStart).toHaveBeenCalledWith({
      templateId: "bugfix",
      workspaceId: "workspace-1",
      agentNodeId: "reviewer",
      task: "Fix the reviewed local defect",
      dryRun: false,
      requestedBy: "desktop-proposal-review",
      proposalId: approvedProposal().id
    });
    expect(policy.assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ actorNodeId: "reviewer", permission: "execute_tasks" })
    );
    expect(policy.assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ actorNodeId: "reviewer", permission: "manage_worktrees" })
    );
  });

  it("returns an existing materialization without reauthorizing or duplicating it", () => {
    const commands = {
      getForProposal: vi.fn().mockReturnValue(queuedCommand()),
      requestStart: vi.fn()
    };
    const policy = { assertAllowed: vi.fn() };
    const service = new OrchestrationProposalExecutionService(
      { get: vi.fn() },
      commands,
      { listAgents: vi.fn() },
      policy
    );

    expect(
      service.request({ workspaceId: "workspace-1", proposalId: approvedProposal().id })
    ).toEqual(queuedCommand());
    expect(commands.requestStart).not.toHaveBeenCalled();
    expect(policy.assertAllowed).not.toHaveBeenCalled();
  });

  it.each([
    ["draft", "Only approved proposals"],
    ["approved", "Approved proposal requires a trusted workflow template"]
  ] as const)("rejects %s proposal state that cannot become a command", (status, message) => {
    const proposal = {
      ...approvedProposal(),
      status,
      workflowTemplateId: status === "approved" ? null : "bugfix"
    } as OrchestrationProposal;
    const commands = { getForProposal: vi.fn().mockReturnValue(null), requestStart: vi.fn() };
    const service = new OrchestrationProposalExecutionService(
      { get: vi.fn().mockReturnValue(proposal) },
      commands,
      { listAgents: vi.fn() },
      { assertAllowed: vi.fn() }
    );

    expect(() => service.request({ workspaceId: "workspace-1", proposalId: proposal.id })).toThrow(
      message
    );
    expect(commands.requestStart).not.toHaveBeenCalled();
  });

  it("does not use a proposal to request automatic merge permissions", () => {
    const commands = { getForProposal: vi.fn().mockReturnValue(null), requestStart: vi.fn() };
    const service = new OrchestrationProposalExecutionService(
      {
        get: vi.fn().mockReturnValue({
          ...approvedProposal(),
          requestedPermissions: ["merge_changes"]
        })
      },
      commands,
      { listAgents: vi.fn() },
      { assertAllowed: vi.fn() }
    );

    expect(() =>
      service.request({ workspaceId: "workspace-1", proposalId: approvedProposal().id })
    ).toThrow("cannot request merge permissions");
  });
});

function approvedProposal(): OrchestrationProposal {
  return {
    id: "00000000-0000-4000-8000-000000000013",
    workspaceId: "workspace-1",
    objective: "Fix the reviewed local defect",
    understanding: "A reviewer selected the trusted bugfix workflow.",
    questions: [],
    requiredMaterials: ["Current workspace context"],
    suggestedTeam: [{ nodeId: "reviewer", role: "Implementation" }],
    workflowTemplateId: "bugfix",
    executionAgentNodeId: "reviewer",
    dependencies: [],
    requestedPermissions: ["execute_tasks"],
    gates: ["human_approval"],
    risks: ["The human approval must remain recorded."],
    estimatedCost: null,
    estimatedDuration: null,
    autonomyLevel: "supervised",
    status: "approved",
    checksum: "a".repeat(64),
    revision: 2,
    createdBy: "local-user",
    reviewedBy: "local-user",
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:01:00.000Z",
    approvedAt: "2026-07-21T12:01:00.000Z",
    rejectedAt: null
  };
}

function queuedCommand() {
  return {
    id: "00000000-0000-4000-8000-000000000014",
    action: "start" as const,
    status: "queued" as const,
    runId: null,
    workspaceId: "workspace-1",
    agentNodeId: "reviewer",
    task: "Fix the reviewed local defect",
    contractId: null,
    nodeId: null,
    templateId: "bugfix",
    dryRun: false,
    decisionNote: null,
    requestedBy: "desktop-proposal-review",
    createdAt: "2026-07-21T12:01:00.000Z",
    appliedAt: null,
    resultRunId: null,
    errorCode: null
  };
}
