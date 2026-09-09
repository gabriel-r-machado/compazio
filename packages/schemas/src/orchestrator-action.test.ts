import { describe, expect, it } from "vitest";

import { orchestratorActionSchema } from "./orchestrator-action";

describe("orchestratorActionSchema", () => {
  it("accepts a spawn_agent action with a role", () => {
    const result = orchestratorActionSchema.safeParse({
      type: "spawn_agent",
      ref: "ui-1",
      adapter: "codex",
      title: "UI Implementer",
      role: {
        name: "Implementer",
        responsibilities: "Build the landing page",
        constraints: "Do not touch billing",
        expectedDeliverable: "A working page",
        completionCriteria: "Tests pass"
      }
    });
    expect(result.success).toBe(true);
  });

  it("defaults the connection kind to handoff", () => {
    const result = orchestratorActionSchema.parse({ type: "connect", from: "a", to: "b" });
    expect(result).toMatchObject({ type: "connect", kind: "handoff" });
  });

  it("rejects an unknown action type", () => {
    expect(
      orchestratorActionSchema.safeParse({ type: "delete_everything", ref: "x" }).success
    ).toBe(false);
  });

  it("rejects a reference that is not a short slug", () => {
    expect(
      orchestratorActionSchema.safeParse({
        type: "close_agent",
        ref: "Not A Slug!"
      }).success
    ).toBe(false);
  });

  it("requires a reason to pause", () => {
    expect(orchestratorActionSchema.safeParse({ type: "pause" }).success).toBe(false);
    expect(
      orchestratorActionSchema.safeParse({ type: "pause", reason: "Need a Vercel token" }).success
    ).toBe(true);
  });
});
