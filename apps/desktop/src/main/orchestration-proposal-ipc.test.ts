import { describe, expect, it, vi } from "vitest";

import { defaultAutonomyConfig } from "@forgedeck/schemas";

import { registerOrchestrationProposalIpc } from "./orchestration-proposal-ipc";

describe("orchestration proposal IPC", () => {
  it("uses the local proposal store and rejects renderer-controlled execution fields", () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => unknown>();
    const store = storeDouble();
    registerOrchestrationProposalIpc(
      {
        removeHandler: (channel) => handlers.delete(channel),
        handle: (channel, handler) => handlers.set(channel, handler as never)
      },
      store,
      { request: vi.fn().mockReturnValue(command()) },
      {
        listAgents: vi
          .fn()
          .mockReturnValue([{ nodeId: "reviewer", name: "Reviewer", roleName: null, online: true }])
      }
    );

    expect(() =>
      handlers.get("orchestration-proposals:create")?.({}, { ...draft(), cwd: "C:/private" })
    ).toThrow();
    expect(store.create).not.toHaveBeenCalled();

    expect(
      handlers.get("orchestration-proposals:list")?.({}, { workspaceId: "workspace-1" })
    ).toEqual([proposal()]);
    expect(handlers.get("orchestration-proposals:approve")?.({}, review())).toMatchObject({
      status: "approved",
      revision: 2
    });
    expect(store.approve).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      proposalId: proposal().id,
      expectedRevision: 1
    });
    expect(
      handlers.get("orchestration-proposals:execute")?.(
        {},
        {
          workspaceId: "workspace-1",
          proposalId: proposal().id
        }
      )
    ).toMatchObject({ commandId: command().id, status: "queued" });
    expect(
      handlers.get("orchestration-proposals:planning-options")?.({}, { workspaceId: "workspace-1" })
    ).toMatchObject({ agents: [{ nodeId: "reviewer" }] });
  });
});

function storeDouble() {
  return {
    create: vi.fn().mockReturnValue(proposal()),
    get: vi.fn().mockReturnValue(proposal()),
    list: vi.fn().mockReturnValue([proposal()]),
    listEvents: vi.fn().mockReturnValue([]),
    updateDraft: vi.fn().mockReturnValue(proposal()),
    approve: vi.fn().mockReturnValue({
      ...proposal(),
      status: "approved",
      revision: 2,
      reviewedBy: "local-user",
      approvedAt: "2026-07-21T12:00:00.000Z"
    }),
    reject: vi.fn().mockReturnValue({ ...proposal(), status: "rejected", revision: 2 })
  };
}

function command() {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    action: "start" as const,
    status: "queued" as const,
    runId: null,
    workspaceId: "workspace-1",
    agentNodeId: "reviewer",
    task: "Review a local delivery",
    contractId: null,
    nodeId: null,
    templateId: "bugfix",
    dryRun: false,
    decisionNote: null,
    requestedBy: "desktop-proposal-review",
    createdAt: "2026-07-21T12:00:00.000Z",
    appliedAt: null,
    resultRunId: null,
    errorCode: null
  };
}

function review() {
  return {
    workspaceId: "workspace-1",
    proposalId: proposal().id,
    revision: 1
  };
}

function draft() {
  return {
    workspaceId: "workspace-1",
    objective: "Review a local delivery",
    understanding: "A human must review this proposal.",
    questions: [],
    requiredMaterials: [],
    suggestedTeam: [],
    workflowTemplateId: null,
    executionAgentNodeId: null,
    dependencies: [],
    requestedPermissions: [],
    gates: ["human_approval"],
    risks: [],
    estimatedCost: null,
    estimatedDuration: null,
    autonomyLevel: "assisted" as const,
    autonomy: defaultAutonomyConfig
  };
}

function proposal() {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    ...draft(),
    status: "draft" as const,
    checksum: "a".repeat(64),
    revision: 1,
    createdBy: "local-user" as const,
    reviewedBy: null,
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
    approvedAt: null,
    rejectedAt: null
  };
}
