import { describe, expect, it } from "vitest";

import type { WorkflowDraft } from "@forgedeck/schemas";

import { draftNodeIdsForDeletion, removesWholeDraft } from "./draft-node-deletion";

function draft(nodeIds: readonly string[]): WorkflowDraft {
  return {
    nodes: nodeIds.map((id) => ({ id })),
    edges: []
  } as unknown as WorkflowDraft;
}

describe("draftNodeIdsForDeletion", () => {
  it("maps a real terminal back to the task it was materialized from", () => {
    expect(draftNodeIdsForDeletion(["review"], draft(["implement", "review"]))).toEqual(["review"]);
  });

  it("leaves ordinary canvas nodes alone", () => {
    // A terminal the person drew themselves is no plan's business.
    expect(draftNodeIdsForDeletion(["agent-abc", "note-1"], draft(["implement"]))).toEqual([]);
  });

  it("does nothing when there is no plan", () => {
    expect(draftNodeIdsForDeletion(["implement"], null)).toEqual([]);
  });
});

describe("removesWholeDraft", () => {
  it("is true when the plan would be left with no task at all", () => {
    expect(removesWholeDraft(["a", "b"], draft(["a", "b"]))).toBe(true);
  });

  it("is false when the plan keeps a task", () => {
    expect(removesWholeDraft(["a"], draft(["a", "b"]))).toBe(false);
  });

  it("is false when nothing plan-related is being deleted", () => {
    expect(removesWholeDraft([], draft(["a"]))).toBe(false);
    expect(removesWholeDraft([], null)).toBe(false);
  });
});
