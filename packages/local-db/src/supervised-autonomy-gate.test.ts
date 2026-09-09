import { describe, expect, it, vi } from "vitest";

import { defaultAutonomyConfig } from "@forgedeck/schemas";
import type { RecordedAutonomyDecision } from "@forgedeck/schemas";

import { SupervisedAutonomyGate } from "./supervised-autonomy-gate";

describe("SupervisedAutonomyGate", () => {
  it("binds the run to a fixed workspace and config and forwards only sanitized state", async () => {
    const record: RecordedAutonomyDecision = {
      id: "00000000-0000-4000-8000-000000000050",
      workspaceId: "workspace-1",
      runId: "run-1",
      proposalId: "00000000-0000-4000-8000-000000000051",
      actor: "runtime",
      action: "spawn_agent",
      outcome: "stop",
      rule: "spawn_limit",
      context: { config: defaultAutonomyConfig, state: {} },
      createdAt: "2026-07-21T12:00:00.000Z"
    };
    const assess = vi.fn().mockReturnValue(record);
    const gate = new SupervisedAutonomyGate(
      { assess },
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        config: defaultAutonomyConfig,
        proposalId: "00000000-0000-4000-8000-000000000051"
      }
    );

    const decision = await gate.assess({
      runId: "ignored-by-binding",
      nodeId: "build",
      action: "spawn_agent",
      state: { nodeAttempts: 1, concurrentAgents: 3, spawnedAgents: 6, elapsedMinutes: 5 }
    });

    expect(decision).toEqual({ outcome: "stop", rule: "spawn_limit" });
    expect(assess).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      proposalId: "00000000-0000-4000-8000-000000000051",
      actor: "runtime",
      action: "spawn_agent",
      config: defaultAutonomyConfig,
      state: { nodeAttempts: 1, concurrentAgents: 3, spawnedAgents: 6, elapsedMinutes: 5 }
    });
  });
});
