import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import { PipeProcessFactory } from "@forgedeck/terminal";
import { afterEach, describe, expect, it } from "vitest";

import { V2OrchestratorBridge } from "./orchestrator-bridge";
import { isolatedTestEntitlement } from "./testing/isolated-entitlement";
import { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Compazio optional MCP lifecycle", () => {
  it("does not start the legacy team gateway when no connected Portal needs MCP", async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.bridge.diagnostics()).toMatchObject({ listening: true, taskCount: 0 });
      expect(() =>
        fixture.bridge.createAgentMcpSession({
          workspaceId: "workspace",
          terminalId: "terminal",
          capabilities: ["team-recruit"]
        })
      ).toThrow(/MCP não está disponível/i);
    } finally {
      await fixture.shutdown();
    }
  });

  it("rejects hidden provider turns even when historical callers still compile", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.workspaces.startBackgroundAgentTask({
          workspaceId: "historical-workspace",
          terminalId: "historical-terminal",
          prompt: "execute invisibly"
        })
      ).rejects.toThrow(/Workers ocultos estão desativados/i);
    } finally {
      await fixture.shutdown();
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "compazio-mcp-release-gate-"));
  roots.push(root);
  const repository = new V2WorkspaceRepository({ rootDirectory: join(root, "state") });
  const supervisor = new V2ProcessSupervisor(new PipeProcessFactory(), {
    treeKiller: { kill: async () => undefined }
  });
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "roles"))
  });
  const workspaces = new V2WorkspaceService({
    repository,
    supervisor,
    agents,
    entitlement: isolatedTestEntitlement(root)
  });
  const bridge = new V2OrchestratorBridge({
    workspaces,
    agents,
    storageDirectory: join(root, "bridge"),
    nodeExecutable: process.execPath
  });
  await bridge.start();
  workspaces.setOrchestratorBridge(bridge);
  return {
    workspaces,
    bridge,
    async shutdown(): Promise<void> {
      await workspaces.shutdown();
      await bridge.shutdown();
    }
  };
}
