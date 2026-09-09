import { describe, expect, it } from "vitest";
import { resolveAutomaticModeStrategy, validateOrchestratorPlan } from "@forgedeck/orchestration";
import type {
  AgentPlanningDescriptor,
  OrchestratorPlanRequest,
  StructuredDiagnostic
} from "@forgedeck/orchestration";
import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  ORCHESTRATOR_PLAN_ROLES,
  orchestratorPlanSchema
} from "@forgedeck/schemas";

import { ClaudeOrchestratorPort } from "./claude-orchestrator-port";
import { planContractSection } from "./orchestrator-plan-contract";

/**
 * One contract, two planners. These tests exist to make "Codex produces the same plan schema as Claude"
 * a checked fact rather than a claim: the same validator, the same schema-derived instructions and the
 * same diagnostic vocabulary, with no per-provider parser, converter or relaxation anywhere.
 */

const AGENTS: readonly AgentPlanningDescriptor[] = [
  { id: "claude-code", displayName: "Claude Code", capabilities: ["planning"], available: true },
  { id: "opencode", displayName: "OpenCode", capabilities: ["backend"], available: true },
  { id: "codex", displayName: "Codex", capabilities: ["testing"], available: true }
];

interface RawNode {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly adapter: string;
  readonly prompt: string;
  readonly dependsOn?: readonly string[];
}
interface RawPlan {
  readonly title: string;
  readonly summary: string;
  readonly nodes: readonly RawNode[];
}

function validPlan(): RawPlan {
  return {
    title: "Deliver the slice",
    summary: "Design it, build it, verify it.",
    nodes: [
      {
        id: "architecture",
        title: "Design",
        role: "designer",
        adapter: "claude-code",
        prompt: "Design it."
      },
      {
        id: "implementation",
        title: "Build",
        role: "implementer",
        adapter: "opencode",
        prompt: "Build it.",
        dependsOn: ["architecture"]
      },
      {
        id: "tests",
        title: "Verify",
        role: "qa",
        adapter: "codex",
        prompt: "Verify it.",
        dependsOn: ["implementation"]
      }
    ]
  };
}

const validateOptions = {
  allowedAdapters: ["claude-code", "opencode", "codex"],
  maxNodes: 8,
  workspaceId: "planning",
  objective: "Deliver the slice",
  executionProfile: "balanced" as const,
  sourceTerminalId: "orchestrator:test"
};

function claudePort(answer: string): ClaudeOrchestratorPort {
  return new ClaudeOrchestratorPort({
    runner: { run: async () => ({ stdout: answer, exitCode: 0 }) },
    // A stable fingerprint: this port's own mutation guard is exercised elsewhere.
    fingerprinter: { fingerprint: async () => "stable" },
    cwd: "/real/workspace",
    isolation: {
      create: async () => ({ path: "/snapshot", files: [], dispose: async () => undefined })
    },
    context: async () => ({
      summary: "",
      availableScripts: [],
      gitStatus: "",
      documentation: [],
      acceptanceCriteria: []
    }),
    availability: async () => ({ available: true, version: "claude 2.1.220" })
  });
}

function request(overrides: Partial<OrchestratorPlanRequest> = {}): OrchestratorPlanRequest {
  return {
    objective: "Deliver the slice",
    planningSnapshotPath: "/snapshot",
    projectMetadata: { summary: "A test workspace." },
    limits: AUTOMATIC_MODE_DEFAULT_LIMITS.standard,
    availableAgents: AGENTS,
    strategy: resolveAutomaticModeStrategy("standard", AUTOMATIC_MODE_DEFAULT_LIMITS.standard),
    ...overrides
  };
}

function codes(diagnostics: readonly StructuredDiagnostic[]): readonly string[] {
  return diagnostics.map((entry) => entry.code);
}

/** Returns the valid plan with one field of its first node replaced — no indexed mutation needed. */
function patchFirstNode(patch: Partial<RawNode>): RawPlan {
  const plan = validPlan();
  return {
    ...plan,
    nodes: plan.nodes.map((node, index) => (index === 0 ? { ...node, ...patch } : node))
  };
}

describe("the neutral orchestrator contract", () => {
  it("5. is derived from the official schema, never restated by hand", () => {
    const contract = planContractSection(["claude-code", "codex"]).join("\n");
    for (const role of ORCHESTRATOR_PLAN_ROLES) {
      expect(contract).toContain(role);
    }
    // The example handed to every planner is itself schema-valid, so the instructions cannot describe
    // something the validator would reject.
    const example =
      /### A complete, valid example \(copy this structure exactly\)\n([\s\S]*?)\n\n/u.exec(
        `${contract}\n\n`
      )?.[1];
    expect(example).toBeDefined();
    expect(orchestratorPlanSchema.safeParse(JSON.parse(example ?? "{}")).success).toBe(true);
    // Both planners are told the same allowed adapters, in the same words.
    expect(contract).toContain("- adapter MUST be exactly one of: claude-code | codex");
    expect(contract).toContain("No markdown fence, no ``` of any kind.");
  });

  it("4. accepts one plan shape and rejects everything else the same way, whoever wrote it", () => {
    expect(validateOrchestratorPlan(validPlan(), validateOptions).ok).toBe(true);

    const cycled = validateOrchestratorPlan(
      patchFirstNode({ dependsOn: ["tests"] }),
      validateOptions
    );
    expect(cycled.ok).toBe(false);
    if (!cycled.ok) expect(codes(cycled.diagnostics)).toContain("dependency_cycle");

    const rejected = validateOrchestratorPlan(
      patchFirstNode({ adapter: "ghost-agent" }),
      validateOptions
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(codes(rejected.diagnostics)).toEqual(["invalid_adapter"]);

    const overBudget = validateOrchestratorPlan(validPlan(), { ...validateOptions, maxNodes: 2 });
    expect(overBudget.ok).toBe(false);
    if (!overBudget.ok) expect(codes(overBudget.diagnostics)).toEqual(["limit_exceeded"]);
  });

  it("reports a bad answer from Claude with the same vocabulary Codex uses", async () => {
    const fenced = await claudePort("```json\n{}\n```").createPlan(request());
    expect(fenced.plan).toBeNull();
    expect(codes(fenced.diagnostics)).toEqual(["result_wrapped_in_markdown"]);

    const prose = await claudePort("Sure! Here is the plan.").createPlan(request());
    expect(prose.plan).toBeNull();
    expect(codes(prose.diagnostics)).toEqual(["result_not_json"]);

    const empty = await claudePort("   ").createPlan(request());
    expect(codes(empty.diagnostics)).toEqual(["result_empty"]);

    const rejected = await claudePort(
      JSON.stringify(patchFirstNode({ role: "wizard" }))
    ).createPlan(request());
    expect(rejected.plan).toBeNull();
    expect(codes(rejected.diagnostics)).toContain("invalid_role");
  });

  it("Claude returns a plan through the neutral entry point, identified and complete", async () => {
    const result = await claudePort(JSON.stringify(validPlan())).createPlan(request());
    expect(result.adapterId).toBe("claude-code");
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.nodes.map((node) => node.adapter)).toEqual([
      "claude-code",
      "opencode",
      "codex"
    ]);
  });

  it("refuses to plan without a snapshot, and reports availability without planning", async () => {
    const port = claudePort(JSON.stringify(validPlan()));
    const withoutSnapshot = await port.createPlan(request({ planningSnapshotPath: "" }));
    expect(withoutSnapshot.plan).toBeNull();
    expect(codes(withoutSnapshot.diagnostics)).toEqual(["snapshot_unavailable"]);

    const availability = await port.detect();
    expect(availability.id).toBe("claude-code");
    expect(availability.available).toBe(true);
    expect(availability.version).toBe("claude 2.1.220");
    expect(availability.hasImplementation).toBe(true);
  });

  it("24. a planner never gains an execution surface by implementing the contract", () => {
    const port = claudePort("{}");
    expect(typeof port.createPlan).toBe("function");
    expect("execute" in port).toBe(false);
    expect("materializeAndStart" in port).toBe(false);
    expect("start" in port).toBe(false);
  });
});
