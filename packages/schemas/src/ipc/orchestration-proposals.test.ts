import { describe, expect, it } from "vitest";

import {
  orchestrationProposalCreateRequestSchema,
  orchestrationProposalExecuteRequestSchema,
  orchestrationProposalReviewRequestSchema,
  orchestrationProposalUpdateRequestSchema
} from "./orchestration-proposals";

describe("orchestration proposal IPC schemas", () => {
  it("accepts a bounded local draft but rejects execution fields", () => {
    expect(orchestrationProposalCreateRequestSchema.safeParse(draft()).success).toBe(true);
    expect(
      orchestrationProposalCreateRequestSchema.safeParse({
        ...draft(),
        executable: "cmd.exe",
        cwd: "C:/private",
        command: "pnpm test"
      }).success
    ).toBe(false);
  });

  it("requires an optimistic revision for edits and decisions", () => {
    expect(
      orchestrationProposalUpdateRequestSchema.safeParse({
        workspaceId: "workspace-1",
        proposalId: "00000000-0000-4000-8000-000000000010",
        revision: 1,
        draft: draft()
      }).success
    ).toBe(true);
    expect(
      orchestrationProposalReviewRequestSchema.safeParse({
        workspaceId: "workspace-1",
        proposalId: "00000000-0000-4000-8000-000000000010"
      }).success
    ).toBe(false);
  });

  it("accepts only identifiers for materialization and rejects dependency cycles", () => {
    expect(
      orchestrationProposalExecuteRequestSchema.safeParse({
        workspaceId: "workspace-1",
        proposalId: "00000000-0000-4000-8000-000000000010"
      }).success
    ).toBe(true);
    expect(
      orchestrationProposalExecuteRequestSchema.safeParse({
        workspaceId: "workspace-1",
        proposalId: "00000000-0000-4000-8000-000000000010",
        command: "pnpm test"
      }).success
    ).toBe(false);
    expect(
      orchestrationProposalCreateRequestSchema.safeParse({
        ...draft(),
        dependencies: [
          ["implement", "verify"],
          ["verify", "implement"]
        ]
      }).success
    ).toBe(false);
  });
});

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
    autonomyLevel: "assisted"
  };
}
