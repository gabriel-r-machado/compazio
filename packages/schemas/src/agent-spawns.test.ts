import { describe, expect, it } from "vitest";

import { createAgentSpawnSchema, spawnAgentAdapterIdSchema } from "./agent-spawns";

describe("agent spawn schemas", () => {
  it("accepts a bounded local agent spawn request", () => {
    expect(
      createAgentSpawnSchema.parse({
        workspaceId: "workspace-1",
        adapterId: "codex",
        roleName: "tester",
        name: "qa-auth",
        requestedByNodeId: null,
        idempotencyKey: "spawn-1"
      })
    ).toMatchObject({ adapterId: "codex", name: "qa-auth" });
  });

  it("does not allow a plain shell or the unavailable OpenCode adapter", () => {
    expect(spawnAgentAdapterIdSchema.safeParse("shell").success).toBe(false);
    expect(spawnAgentAdapterIdSchema.safeParse("opencode").success).toBe(false);
  });
});
