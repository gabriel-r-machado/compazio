import { describe, expect, it } from "vitest";

import { AGENT_ADAPTER_IDS } from "@forgedeck/schemas";

import { AgentDescriptorRegistry } from "./agent-descriptor-registry";
import type { AgentAdapterAvailability } from "./agent-adapter-registry";

/**
 * The descriptor registry is the catalog of agents Compazio knows about; the adapter registry is what
 * can actually launch one. These tests pin the separation: an agent with no implementation is a
 * first-class, honestly-described option that is never runnable, and probing one that is missing or
 * broken can never fail the application.
 */

function adapters(
  present: Record<string, () => Promise<AgentAdapterAvailability>>
): Pick<ConstructorParameters<typeof AgentDescriptorRegistry>[0], "has" | "detect"> {
  return {
    has: (id: string) => id in present,
    detect: async (id: string) => {
      const probe = present[id];
      if (probe === undefined) throw new Error(`Unknown agent adapter: ${id}`);
      return probe();
    }
  };
}

const claudeAvailable = async (): Promise<AgentAdapterAvailability> => ({
  id: "claude-code",
  available: true,
  version: "1.2.3",
  issue: null
});

describe("AgentDescriptorRegistry", () => {
  it("knows all three agents even when only one has an implementation", async () => {
    const registry = new AgentDescriptorRegistry(adapters({ "claude-code": claudeAvailable }));
    const descriptors = await registry.refresh();
    expect(descriptors.map((entry) => entry.id)).toEqual([...AGENT_ADAPTER_IDS]);
  });

  it("reports Codex and OpenCode as known but not available in this version", async () => {
    const registry = new AgentDescriptorRegistry(adapters({ "claude-code": claudeAvailable }));
    await registry.refresh();
    for (const id of ["codex", "opencode"] as const) {
      const descriptor = registry.get(id);
      expect(descriptor.displayName.length).toBeGreaterThan(0);
      expect(descriptor.available).toBe(false);
      expect(descriptor.hasImplementation).toBe(false);
      // It is described honestly, with a reason a person can act on.
      expect(descriptor.unavailability?.code).toBe("adapter_not_implemented");
      expect(descriptor.unavailability?.remediation.length).toBeGreaterThan(0);
    }
  });

  it("reports the detected version for an agent that is installed", async () => {
    const registry = new AgentDescriptorRegistry(adapters({ "claude-code": claudeAvailable }));
    await registry.refresh();
    const claude = registry.get("claude-code");
    expect(claude.available).toBe(true);
    expect(claude.hasImplementation).toBe(true);
    expect(claude.version).toBe("1.2.3");
  });

  it("reports an installed-but-unusable agent with its issue instead of hiding it", async () => {
    const registry = new AgentDescriptorRegistry(
      adapters({
        "claude-code": async () => ({
          id: "claude-code",
          available: false,
          version: null,
          issue: {
            code: "adapter_detection_failed",
            message: "Claude Code was found but could not report its version.",
            remediation: "Run `claude --version` in a trusted terminal."
          }
        })
      })
    );
    await registry.refresh();
    const claude = registry.get("claude-code");
    expect(claude.available).toBe(false);
    expect(claude.hasImplementation).toBe(true);
    expect(claude.unavailability?.code).toBe("adapter_detection_failed");
  });

  it("a probe that throws never breaks the catalog", async () => {
    // A missing or broken CLI must never fail application startup.
    const registry = new AgentDescriptorRegistry(
      adapters({
        "claude-code": async () => {
          throw new Error("spawn ENOENT");
        }
      })
    );
    const descriptors = await registry.refresh();
    expect(descriptors).toHaveLength(AGENT_ADAPTER_IDS.length);
    expect(registry.get("claude-code").available).toBe(false);
  });

  it("never persists or exposes credential material", async () => {
    const registry = new AgentDescriptorRegistry(adapters({ "claude-code": claudeAvailable }));
    await registry.refresh();
    // Authentication is only reported when a safe local check can determine it; none can today, so it
    // stays unknown rather than being guessed from availability.
    expect(registry.list().every((entry) => entry.authenticated === null)).toBe(true);
    const serialized = JSON.stringify(registry.list());
    expect(serialized).not.toMatch(/token|secret|cookie|password|api[_-]?key/i);
  });

  it("reports agents without probing anything before the first refresh", () => {
    let probes = 0;
    const registry = new AgentDescriptorRegistry(
      adapters({
        "claude-code": async () => {
          probes += 1;
          return claudeAvailable();
        }
      })
    );
    expect(registry.list()).toHaveLength(AGENT_ADAPTER_IDS.length);
    expect(probes).toBe(0);
  });
});
