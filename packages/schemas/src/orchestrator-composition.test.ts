import { describe, expect, it } from "vitest";

import { orchestratorCompositionActionSchema } from "./orchestrator-composition";

describe("orchestratorCompositionActionSchema", () => {
  it("accepts a start_workflow_draft action", () => {
    const result = orchestratorCompositionActionSchema.safeParse({
      type: "start_workflow_draft",
      objective: "Build a tested landing page"
    });
    expect(result.success).toBe(true);
  });

  it("accepts an add_draft_node with an abstract role", () => {
    const result = orchestratorCompositionActionSchema.safeParse({
      type: "add_draft_node",
      ref: "impl",
      title: "Implementer",
      role: "implementer",
      objective: "Build the page",
      acceptanceCriteria: ["Tests pass"]
    });
    expect(result.success).toBe(true);
  });

  it("defaults connect edgeType to handoff", () => {
    const parsed = orchestratorCompositionActionSchema.parse({
      type: "connect_draft_nodes",
      from: "a",
      to: "b"
    });
    expect(parsed).toMatchObject({ type: "connect_draft_nodes", edgeType: "handoff" });
  });

  it("defaults request_user_input responseKind to free_text", () => {
    const parsed = orchestratorCompositionActionSchema.parse({
      type: "request_user_input",
      prompt: "Who is the audience?"
    });
    expect(parsed).toMatchObject({ responseKind: "free_text" });
  });

  it("rejects a spawn or file action — composition cannot start processes", () => {
    expect(
      orchestratorCompositionActionSchema.safeParse({
        type: "spawn_agent",
        ref: "x",
        adapter: "codex",
        title: "X"
      }).success
    ).toBe(false);
  });

  it("rejects a node reference that is not a short slug", () => {
    expect(
      orchestratorCompositionActionSchema.safeParse({
        type: "remove_draft_node",
        ref: "Not A Slug!"
      }).success
    ).toBe(false);
  });
});
