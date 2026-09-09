import { describe, expect, it } from "vitest";
import type {
  OrchestratorAvailability,
  OrchestratorPlanResult,
  OrchestratorPlanningPort
} from "@forgedeck/orchestration";

import { OrchestratorRegistry, UnknownOrchestratorError } from "./orchestrator-registry";

/**
 * The planner registry is separate from the execution registries on purpose: an installed executor must
 * never become a planner by accident, and choosing a planner must never move a node's executor.
 */

class StubPlanner implements OrchestratorPlanningPort {
  public detectCalls = 0;
  public planCalls = 0;

  public constructor(
    public readonly id: OrchestratorPlanningPort["id"],
    private readonly available = true,
    private readonly version: string | null = "1.0.0"
  ) {}

  public async detect(): Promise<OrchestratorAvailability> {
    this.detectCalls += 1;
    return {
      id: this.id,
      hasImplementation: true,
      available: this.available,
      version: this.available ? this.version : null,
      issue: null
    };
  }

  public async createPlan(): Promise<OrchestratorPlanResult> {
    this.planCalls += 1;
    return { plan: null, adapterId: this.id, diagnostics: [] };
  }
}

describe("OrchestratorRegistry", () => {
  it("1. resolves Claude and Codex strictly by their orchestrator id", () => {
    const claude = new StubPlanner("claude-code");
    const codex = new StubPlanner("codex");
    const registry = new OrchestratorRegistry([claude, codex]);
    expect(registry.has("claude-code")).toBe(true);
    expect(registry.has("codex")).toBe(true);
    expect(registry.get("claude-code")).toBe(claude);
    expect(registry.get("codex")).toBe(codex);
  });

  it("2. reports OpenCode as a known agent whose planning is not implemented", async () => {
    const registry = new OrchestratorRegistry([new StubPlanner("claude-code")]);
    expect(registry.knownIds()).toEqual(["claude-code", "codex", "opencode"]);
    expect(registry.has("opencode")).toBe(false);
    const availability = await registry.detect("opencode");
    expect(availability.hasImplementation).toBe(false);
    expect(availability.available).toBe(false);
    expect(availability.issue?.code).toBe("planner_not_implemented");
    // A known-but-unimplemented planner is never silently substituted by an implemented one.
    expect(availability.id).toBe("opencode");
  });

  it("refuses an unknown id instead of guessing a planner", () => {
    const registry = new OrchestratorRegistry([new StubPlanner("claude-code")]);
    expect(() => registry.get("gpt-nine")).toThrow(UnknownOrchestratorError);
    expect(registry.has("gpt-nine")).toBe(false);
  });

  it("refuses two ports claiming the same id", () => {
    expect(
      () => new OrchestratorRegistry([new StubPlanner("codex"), new StubPlanner("codex")])
    ).toThrow(/Duplicate orchestrator registration/u);
  });

  it("detects without ever starting a planning turn", async () => {
    const claude = new StubPlanner("claude-code");
    const codex = new StubPlanner("codex", false, null);
    const registry = new OrchestratorRegistry([claude, codex]);
    const all = await registry.detectAll();
    expect(all.map((entry) => entry.id)).toEqual(["claude-code", "codex", "opencode"]);
    expect(all[0]?.available).toBe(true);
    expect(all[1]?.available).toBe(false);
    expect(all[2]?.hasImplementation).toBe(false);
    expect(claude.planCalls + codex.planCalls).toBe(0);
    expect(claude.detectCalls).toBe(1);
  });

  it("3. carries no execution concern: it holds planners only, keyed by planner id", () => {
    const registry = new OrchestratorRegistry([new StubPlanner("codex")]);
    // Choosing Codex as the planner says nothing about which agents execute the nodes: the registry
    // exposes no node, adapter assignment or executor surface at all.
    expect(Object.keys(registry)).not.toContain("adapters");
    expect("resolve" in registry).toBe(false);
    expect("execute" in registry).toBe(false);
  });
});
