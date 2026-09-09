import { describe, expect, it } from "vitest";

import {
  agentDescriptorSchema,
  toAgentAdapterId,
  workflowNodeDraftSchema
} from "@forgedeck/schemas";
import type {
  AgentAdapterId,
  AgentCapability,
  AgentDescriptor,
  WorkflowNodeDraft
} from "@forgedeck/schemas";

import {
  resolveNodeAgentAssignment,
  suggestAgentAssignments,
  validateNodeAgentAssignment,
  type AgentAssignmentCatalog
} from "./agent-assignment";

/** A descriptor with everything a runnable agent needs, so each test varies only what it is about. */
function descriptor(id: AgentAdapterId, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing", "review"],
    available: true,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: true,
    ...overrides
  });
}

/** Today's real shape: Claude runnable, Codex and OpenCode known but with no implementation. */
function catalog(overrides: Partial<Record<AgentAdapterId, AgentDescriptor>> = {}) {
  const unavailable = (id: AgentAdapterId): AgentDescriptor =>
    descriptor(id, {
      available: false,
      hasImplementation: false,
      unavailability: {
        code: "adapter_not_implemented",
        message: `${id} is not available`,
        remediation: ""
      }
    });
  return {
    descriptors: [
      overrides["claude-code"] ?? descriptor("claude-code"),
      overrides.codex ?? unavailable("codex"),
      overrides.opencode ?? unavailable("opencode")
    ]
  } satisfies AgentAssignmentCatalog;
}

function node(overrides: Record<string, unknown> = {}): WorkflowNodeDraft {
  return workflowNodeDraftSchema.parse({
    id: "backend",
    title: "Backend",
    role: "implementer",
    ...overrides
  });
}

describe("legacy migration", () => {
  it("adopts a legacy runtime binding only when it is exactly a known adapter id", () => {
    const legacy = node({
      runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "claude-code" }
    });
    expect(resolveNodeAgentAssignment(legacy).assignedAdapter).toBe("claude-code");
  });

  it("never infers an adapter from an unknown runtime id", () => {
    // The decisive guarantee: a runtime id the product does not recognize must not quietly become the
    // agent that runs the node. It stays undecided and is reported as needing an explicit choice.
    for (const unknown of ["fake-agent", "claude", "Claude-Code", "gpt-4", "codex-cli"]) {
      const legacy = node({
        runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: unknown }
      });
      expect(resolveNodeAgentAssignment(legacy).assignedAdapter).toBeNull();
    }
    // Nothing but an exact known id ever produces an adapter, not even an empty or blank string.
    expect(toAgentAdapterId("")).toBeNull();
    expect(toAgentAdapterId(null)).toBeNull();
    expect(toAgentAdapterId(undefined)).toBeNull();
  });

  it("leaves a node with no runtime binding undecided", () => {
    expect(resolveNodeAgentAssignment(node()).assignedAdapter).toBeNull();
  });

  it("never infers an adapter from the title, role, prompt or position", () => {
    const suggestive = node({
      id: "codex",
      title: "Run Codex on the backend",
      role: "implementer",
      objective: "Use OpenCode to implement this"
    });
    expect(resolveNodeAgentAssignment(suggestive).assignedAdapter).toBeNull();
  });

  it("an explicit assignment always wins over the legacy binding", () => {
    const both = node({
      runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "claude-code" },
      agentAssignment: { assignedAdapter: "codex" }
    });
    expect(resolveNodeAgentAssignment(both).assignedAdapter).toBe("codex");
  });
});

describe("assignment presets", () => {
  it("manual assigns nothing and demands an explicit choice for every node", () => {
    const suggestions = suggestAgentAssignments({
      nodes: [node({ id: "a" }), node({ id: "b" })],
      preset: "manual",
      catalog: catalog()
    });
    expect(suggestions.map((entry) => entry.assignedAdapter)).toEqual([null, null]);
  });

  it("never selects an agent that is unavailable, whatever the preset prefers", () => {
    // `economic` and `speed` prefer OpenCode/Codex first; neither is available today, so the only
    // acceptable outcomes are the available agent or nothing — never an unavailable one.
    for (const preset of ["automatic", "quality", "economic", "speed"] as const) {
      const [suggestion] = suggestAgentAssignments({
        nodes: [node()],
        preset,
        catalog: catalog()
      });
      expect(suggestion?.assignedAdapter).toBe("claude-code");
    }
  });

  it("never selects an unavailable agent even when the node recommends it first", () => {
    const [suggestion] = suggestAgentAssignments({
      nodes: [node({ agentAssignment: { recommendedAdapters: ["codex", "opencode"] } })],
      preset: "automatic",
      catalog: catalog()
    });
    expect(suggestion?.assignedAdapter).toBe("claude-code");
    expect(suggestion?.reason).toContain("No recommended agent is available");
  });

  it("honours the node's recommendation order when the recommended agent is available", () => {
    const [suggestion] = suggestAgentAssignments({
      nodes: [node({ agentAssignment: { recommendedAdapters: ["codex", "claude-code"] } })],
      preset: "automatic",
      catalog: catalog({ codex: descriptor("codex") })
    });
    expect(suggestion?.assignedAdapter).toBe("codex");
  });

  it("preserves an available agent explicitly assigned on the canvas", () => {
    const [suggestion] = suggestAgentAssignments({
      nodes: [node({ agentAssignment: { assignedAdapter: "codex" } })],
      preset: "automatic",
      catalog: catalog({ codex: descriptor("codex") })
    });
    expect(suggestion).toMatchObject({
      assignedAdapter: "codex",
      reason: expect.stringContaining("explicitly selected")
    });
  });

  it("follows each preset's documented preference order among available agents", () => {
    const all = catalog({ codex: descriptor("codex"), opencode: descriptor("opencode") });
    const pick = (preset: "automatic" | "quality" | "economic" | "speed") =>
      suggestAgentAssignments({ nodes: [node()], preset, catalog: all })[0]?.assignedAdapter;
    expect(pick("automatic")).toBe("claude-code");
    expect(pick("quality")).toBe("claude-code");
    expect(pick("economic")).toBe("opencode");
    expect(pick("speed")).toBe("codex");
  });

  it("assigns nothing when no available agent has the required capabilities", () => {
    const [suggestion] = suggestAgentAssignments({
      nodes: [node({ agentAssignment: { requiredCapabilities: ["ui-ux"] } })],
      preset: "automatic",
      catalog: catalog()
    });
    // No hidden fallback to whichever agent happens to be installed.
    expect(suggestion?.assignedAdapter).toBeNull();
    expect(suggestion?.reason).toContain("capabilities");
  });

  it("is deterministic: the same input always yields the same assignment", () => {
    const input = {
      nodes: [node({ id: "a" }), node({ id: "b" })],
      preset: "automatic" as const,
      catalog: catalog()
    };
    expect(suggestAgentAssignments(input)).toEqual(suggestAgentAssignments(input));
  });
});

describe("assignment validation", () => {
  const validate = (assignment: Record<string, unknown>, agents = catalog()) =>
    validateNodeAgentAssignment({
      nodeId: "backend",
      assignment: resolveNodeAgentAssignment(node({ agentAssignment: assignment })),
      catalog: agents
    });

  it("blocks a node with no agent selected", () => {
    expect(validate({}).map((issue) => issue.code)).toEqual(["missing_agent_assignment"]);
  });

  it("blocks an agent that is not available", () => {
    expect(validate({ assignedAdapter: "codex" }).map((issue) => issue.code)).toContain(
      "agent_unavailable"
    );
  });

  it("blocks an agent that has no executable implementation", () => {
    expect(validate({ assignedAdapter: "opencode" }).map((issue) => issue.code)).toContain(
      "agent_not_executable"
    );
  });

  it("blocks a node whose required capabilities the chosen agent does not declare", () => {
    const narrow = catalog({
      "claude-code": descriptor("claude-code", { capabilities: ["planning"] })
    });
    const issues = validate(
      { assignedAdapter: "claude-code", requiredCapabilities: ["backend", "testing"] },
      narrow
    );
    expect(issues.map((issue) => issue.code)).toEqual(["agent_capabilities_unmet"]);
    expect(issues[0]?.message).toContain("backend");
  });

  it("accepts required capabilities that are a subset of the declared ones", () => {
    expect(validate({ assignedAdapter: "claude-code", requiredCapabilities: ["backend"] })).toEqual(
      []
    );
  });

  it("blocks an unknown fallback and a fallback that repeats the assigned agent", () => {
    const issues = validate({
      assignedAdapter: "claude-code",
      fallbackAdapters: ["claude-code"]
    });
    expect(issues.map((issue) => issue.code)).toEqual(["invalid_fallback_adapter"]);
  });

  it("accepts an unavailable agent as a declared fallback", () => {
    // A fallback is a future candidate, not an authorization to execute, so listing an agent that is
    // not installed is legitimate — unlike assigning one.
    expect(validate({ assignedAdapter: "claude-code", fallbackAdapters: ["codex"] })).toEqual([]);
  });

  it("recommending an unavailable agent never blocks and never authorizes execution", () => {
    const assignment = {
      assignedAdapter: "claude-code",
      recommendedAdapters: ["codex", "opencode"] as AgentAdapterId[]
    };
    expect(validate(assignment)).toEqual([]);
  });
});

describe("capability vocabulary", () => {
  it("declares every capability a node can require for the executable agent", () => {
    // Claude must not be blocked by an incomplete declaration, or workflows that run today would stop.
    const claude = catalog().descriptors.find((entry) => entry.id === "claude-code");
    const required: readonly AgentCapability[] = ["planning", "backend", "testing", "review"];
    expect(required.every((capability) => claude?.capabilities.includes(capability))).toBe(true);
  });
});
