import { createWorkspace, createEmptyOperationalState } from "@forgedeck/compazio-v2-domain";
import type { AgentRuntime, V2ProcessSupervisor } from "@forgedeck/compazio-v2-runtime";
import { describe, expect, it } from "vitest";

import { createSafeV2Diagnostics } from "./diagnostics";
import type { V2OperationalService } from "./operational-service";
import type { V2OrchestratorBridge } from "./orchestrator-bridge";
import type { V2WorkspaceService } from "./workspace-service";

const timestamp = "2026-07-28T12:00:00.000Z";

describe("safe V2 diagnostics", () => {
  it("omits workspace identifiers, personal paths, executable paths and sensitive metadata", async () => {
    const personalPath = "C:\\Users\\Private Person\\secret-project";
    const workspace = createWorkspace(
      { name: "Private", workingDirectory: personalPath },
      { createId: () => "workspace_private_123", now: () => timestamp }
    );
    const state = {
      ...createEmptyOperationalState(workspace.id, timestamp),
      events: [
        {
          id: "event_1",
          type: "policy.changed" as const,
          workspaceId: workspace.id,
          actor: "user",
          target: workspace.id,
          timestamp,
          correlationId: "correlation_1",
          metadata: {
            token: "top-secret-token",
            prompt: "private prompt",
            path: personalPath,
            policyId: "standard"
          },
          schemaVersion: 1 as const
        }
      ]
    };
    const report = await createSafeV2Diagnostics(workspace.id, {
      version: "0.1.0-test",
      now: () => timestamp,
      workspaces: {
        snapshot: async () => workspace
      } as unknown as V2WorkspaceService,
      operations: {
        get: async () => state
      } as unknown as V2OperationalService,
      agents: {
        detectAll: async () => [
          {
            agentId: "codex",
            status: "installed",
            executablePath: `${personalPath}\\codex.exe`,
            version: "1.0.0",
            detectedAt: timestamp
          }
        ]
      } as unknown as AgentRuntime,
      supervisor: {
        list: () => [],
        diagnostics: () => ({
          sessionCount: 0,
          activeSessionCount: 0,
          listenerCount: 0
        })
      } as unknown as V2ProcessSupervisor,
      bridge: {
        diagnostics: () => ({ listening: true, sessionCount: 0, taskCount: 0 })
      } as unknown as V2OrchestratorBridge
    });

    expect(report).not.toContain(workspace.id);
    expect(report).not.toContain(personalPath);
    expect(report).not.toContain("top-secret-token");
    expect(report).not.toContain("private prompt");
    expect(report).not.toContain("codex.exe");
    expect(report).toContain('"policyId": "standard"');
    expect(report).toContain('"anonymousId"');
    expect(report).toContain('"node"');
    expect(report).toContain('"architecture"');
  });
});
