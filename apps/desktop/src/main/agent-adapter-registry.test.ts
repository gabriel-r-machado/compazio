import { describe, expect, it } from "vitest";
import { workflowNodeSchema } from "@forgedeck/workflow";

import {
  AgentAdapterRegistry,
  AgentAdapterUnavailableError,
  type AgentNodeAdapter
} from "./agent-adapter-registry";
import type { AgentNodeLaunchInput, AgentNodeLaunchPlan } from "./process-agent-node-executor";

function stubAdapter(id: string, overrides: Partial<AgentNodeAdapter> = {}): AgentNodeAdapter {
  return {
    id,
    planLaunch: async () => basePlan(),
    detect: async () => ({ id, available: true, version: "1.0.0", issue: null }),
    ...overrides
  };
}

function basePlan(): AgentNodeLaunchPlan {
  return {
    executable: { path: "/usr/bin/claude", kind: "native" },
    args: ["--print"],
    producesArtifact: true,
    artifactType: "claude-code-result",
    artifactFilename: "result.json",
    mediaType: "application/json"
  };
}

function launchInput(adapter: string | undefined): AgentNodeLaunchInput {
  const node = workflowNodeSchema.parse({
    id: "planner",
    type: "agent",
    role: "planner",
    ...(adapter === undefined ? {} : { adapter }),
    permissions: {}
  });
  return {
    node,
    role: "planner",
    task: "do the thing",
    cwd: "/workspace",
    runId: "run-1",
    attempt: 1,
    statePath: "/workspace/.forgedeck/planner.state",
    outputPath: "/workspace/.forgedeck/planner.out",
    inputs: []
  };
}

describe("AgentAdapterRegistry", () => {
  it("resolves the adapter strictly by node.adapter", async () => {
    const registry = new AgentAdapterRegistry([stubAdapter("claude-code")]);
    const plan = await registry.resolve(launchInput("claude-code"));
    expect(plan).not.toBeNull();
    expect(registry.has("claude-code")).toBe(true);
    expect(registry.list().map((adapter) => adapter.id)).toEqual(["claude-code"]);
  });

  it("returns null for an unknown adapter id so the node fails before a process starts", async () => {
    const registry = new AgentAdapterRegistry([stubAdapter("claude-code")]);
    expect(await registry.resolve(launchInput("does-not-exist"))).toBeNull();
    expect(registry.has("does-not-exist")).toBe(false);
  });

  it("returns null when a node declares no adapter", async () => {
    const registry = new AgentAdapterRegistry([stubAdapter("claude-code")]);
    expect(await registry.resolve(launchInput(undefined))).toBeNull();
  });

  it("treats an adapter's unavailability as a safe null plan, never a throw", async () => {
    const registry = new AgentAdapterRegistry([
      stubAdapter("claude-code", {
        planLaunch: async () => {
          throw new AgentAdapterUnavailableError("missing binary", "claude-code");
        }
      })
    ]);
    expect(await registry.resolve(launchInput("claude-code"))).toBeNull();
  });

  it("propagates unexpected adapter errors instead of masking them as unavailable", async () => {
    const registry = new AgentAdapterRegistry([
      stubAdapter("claude-code", {
        planLaunch: async () => {
          throw new Error("unexpected");
        }
      })
    ]);
    await expect(registry.resolve(launchInput("claude-code"))).rejects.toThrow("unexpected");
  });

  it("detects availability per adapter id and for all adapters", async () => {
    const registry = new AgentAdapterRegistry([stubAdapter("claude-code")]);
    expect((await registry.detect("claude-code")).available).toBe(true);
    expect((await registry.detectAll()).map((entry) => entry.id)).toEqual(["claude-code"]);
    expect(() => registry.get("nope")).toThrow(AgentAdapterUnavailableError);
  });
});
