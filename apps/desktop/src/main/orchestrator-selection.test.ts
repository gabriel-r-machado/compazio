import { describe, expect, it } from "vitest";
import type {
  OrchestratorAvailability,
  OrchestratorPlanResult,
  OrchestratorPlanningPort,
  OrchestratorPort
} from "@forgedeck/orchestration";
import type { AgentAdapterId, OrchestratorPlan } from "@forgedeck/schemas";

import type { OrchestratorSelection } from "./automatic-mode-service";
import { createOrchestratorSelection } from "./orchestrator-selection";
import { RemediationUnsupportedError } from "./planning-port-bridge";

/**
 * Choosing WHO PLANS is a different question from choosing WHO EXECUTES each node. These tests hold
 * that line: the planner list carries no executor decision, the executors handed to a planner are the
 * same whoever plans, and a planner that cannot remediate says so instead of borrowing another agent.
 */

const PLAN: OrchestratorPlan = {
  title: "Deliver the slice",
  summary: "Design, build, verify.",
  nodes: [
    {
      id: "architecture",
      title: "Design",
      role: "designer",
      adapter: "claude-code",
      prompt: "Design it.",
      dependsOn: [],
      allowedAreas: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      verificationCommands: [],
      operationRisk: "safe",
      requiresHumanApproval: false
    },
    {
      id: "implementation",
      title: "Build",
      role: "implementer",
      adapter: "opencode",
      prompt: "Build it.",
      dependsOn: ["architecture"],
      allowedAreas: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      verificationCommands: [],
      operationRisk: "safe",
      requiresHumanApproval: false
    }
  ],
  assumptions: [],
  needsHumanApproval: false
};

class StubPlanner implements OrchestratorPlanningPort {
  public requests: { readonly snapshotPath: string; readonly agents: readonly string[] }[] = [];

  public constructor(
    public readonly id: AgentAdapterId,
    private readonly availability: Partial<OrchestratorAvailability> = {}
  ) {}

  public async detect(): Promise<OrchestratorAvailability> {
    return {
      id: this.id,
      hasImplementation: true,
      available: true,
      version: `${this.id} 1.0.0`,
      issue: null,
      ...this.availability
    };
  }

  public async createPlan(request: {
    readonly planningSnapshotPath: string;
    readonly availableAgents: readonly { readonly id: string }[];
  }): Promise<OrchestratorPlanResult> {
    this.requests.push({
      snapshotPath: request.planningSnapshotPath,
      agents: request.availableAgents.map((agent) => agent.id)
    });
    return { plan: PLAN, adapterId: this.id, diagnostics: [] };
  }
}

/**
 * A Claude stand-in that declares both capabilities, exactly as the real port does: it speaks the
 * neutral planning contract AND the coordinator's own analyze/remediate seam.
 */
function claudeStub(): OrchestratorPlanningPort & OrchestratorPort {
  const planner = new StubPlanner("claude-code");
  return {
    id: "claude-code",
    detect: () => planner.detect(),
    createPlan: (request) => planner.createPlan(request),
    analyze: async () => PLAN,
    remediate: async () => ({ action: "retry_node" })
  };
}

function selection(options: { readonly codexAvailable?: boolean } = {}): {
  readonly selection: OrchestratorSelection;
  readonly disposals: number[];
  readonly agentsSeen: string[][];
} {
  const disposals: number[] = [];
  const agentsSeen: string[][] = [];
  const codex = new StubPlanner(
    "codex",
    options.codexAvailable === false
      ? {
          available: false,
          version: null,
          issue: {
            code: "planner_unavailable",
            path: null,
            message: "Codex is not installed.",
            structuralShape: null
          }
        }
      : {}
  );
  return {
    disposals,
    agentsSeen,
    selection: createOrchestratorSelection({
      // Both planners are registered exactly the same way, in one registry. What differs is only what
      // each one declares it can do.
      ports: [claudeStub(), codex, new StubPlanner("opencode")],
      isolation: {
        create: async () => ({
          path: "/snapshot",
          files: [],
          dispose: async () => {
            disposals.push(1);
          }
        })
      },
      workspaceRoot: () => "/real/workspace",
      projectMetadata: () => ({ summary: "A workspace." }),
      availableAgents: async () => {
        const agents = [
          {
            id: "claude-code",
            displayName: "Claude Code",
            capabilities: ["planning"],
            available: true
          },
          { id: "opencode", displayName: "OpenCode", capabilities: ["backend"], available: true },
          { id: "codex", displayName: "Codex", capabilities: ["testing"], available: true }
        ];
        agentsSeen.push(agents.map((agent) => agent.id));
        return agents;
      }
    })
  };
}

describe("orchestrator selection", () => {
  it("1/2. lists all three agents as planners, each declaring what it can do", async () => {
    const options = await selection().selection.list();
    expect(options.map((entry) => entry.id)).toEqual(["claude-code", "codex", "opencode"]);
    // Claude plans and remediates; Codex and OpenCode plan only. None of this is hard-coded per id:
    // each value is read from the registered port itself.
    expect(options[0]).toMatchObject({
      available: true,
      supportsPlanning: true,
      supportsRemediation: true
    });
    expect(options[1]).toMatchObject({
      available: true,
      supportsPlanning: true,
      supportsRemediation: false
    });
    expect(options[2]).toMatchObject({
      available: true,
      supportsPlanning: true,
      supportsRemediation: false
    });
  });

  it("resolves all three planners through the one registry", () => {
    const harness = selection();
    for (const id of ["claude-code", "codex", "opencode"] as const) {
      expect(harness.selection.resolve(id)).not.toBeNull();
    }
    // OpenCode declares no remediation, so a session it plans stops rather than borrowing another.
    expect(harness.selection.resolve("opencode")?.supportsRemediation).toBe(false);
  });

  it("reports an unavailable planner with its reason instead of substituting another", async () => {
    const options = await selection({ codexAvailable: false }).selection.list();
    expect(options[1]).toMatchObject({ id: "codex", available: false });
    expect(options[1]?.unavailableReason).toBe("Codex is not installed.");
    // Claude stays available; nothing was swapped or hidden.
    expect(options[0]?.available).toBe(true);
  });

  it("3/23. a bridged planner sees the executor list, and choosing it moves no executor", async () => {
    const harness = selection();
    const codex = harness.selection.resolve("codex");
    const claude = harness.selection.resolve("claude-code");
    expect(codex).not.toBeNull();
    expect(claude).not.toBeNull();

    const request = {
      workspaceId: "ws-1",
      objective: "Deliver",
      mode: "standard" as const,
      limits: {
        maxWorkflowNodes: 8,
        maxRemediationCycles: 2,
        maxAttemptsPerNode: 2,
        timeoutMs: 2_700_000
      }
    };
    const byCodex = (await codex?.port.analyze(request)) as OrchestratorPlan;
    const byClaude = (await claude?.port.analyze(request)) as OrchestratorPlan;

    // The new planner is handed the executors as they are — the same list the canvas offers.
    expect(harness.agentsSeen).toEqual([["claude-code", "opencode", "codex"]]);
    // A plan written by Codex still assigns OTHER agents to the nodes: planner and executor are
    // different choices, and neither one moves the other.
    expect(byCodex.nodes.map((node) => node.adapter)).toEqual(["claude-code", "opencode"]);
    expect(byClaude.nodes.map((node) => node.adapter)).toEqual(["claude-code", "opencode"]);
    // The disposable snapshot was created and disposed around the bridged turn; Claude keeps owning
    // its own approved isolation, which is why only one snapshot was taken here.
    expect(harness.disposals).toHaveLength(1);
  });

  it("stops instead of borrowing another agent when the planner cannot remediate", async () => {
    const harness = selection();
    const codex = harness.selection.resolve("codex");
    expect(codex?.supportsRemediation).toBe(false);
    await expect(
      codex?.port.remediate({
        objective: "Deliver",
        targetNodeId: "implementation",
        failedCriteria: [],
        sanitizedError: "",
        allowedAreas: [],
        priorAttempts: 1
      })
    ).rejects.toBeInstanceOf(RemediationUnsupportedError);

    // Claude, which can remediate, still does.
    const claude = harness.selection.resolve("claude-code");
    expect(claude?.supportsRemediation).toBe(true);
  });

  it("refuses to resolve a planner this build does not register", () => {
    // A build that ships no port for an id resolves nothing for it — the id is known, not implemented.
    const withoutOpenCode = createOrchestratorSelection({
      ports: [claudeStub()],
      isolation: {
        create: async () => ({ path: "/snapshot", files: [], dispose: async () => undefined })
      },
      workspaceRoot: () => "/real/workspace",
      projectMetadata: () => ({}),
      availableAgents: async () => []
    });
    expect(withoutOpenCode.resolve("opencode")).toBeNull();
  });

  it("records a plan hash per planner, so a session can prove which plan it approved", async () => {
    const harness = selection();
    const codex = harness.selection.resolve("codex");
    expect(codex?.planHash()).toBeNull();
    await codex?.port.analyze({
      workspaceId: "ws-1",
      objective: "Deliver",
      mode: "standard",
      limits: {
        maxWorkflowNodes: 8,
        maxRemediationCycles: 2,
        maxAttemptsPerNode: 2,
        timeoutMs: 2_700_000
      }
    });
    expect(codex?.planHash()).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("orchestrator resolution is uniform", () => {
  it("4. dispatches by declared capability, never by the planner's id", async () => {
    // A planner registered under the ESTABLISHED id that does NOT speak the analysis seam is bridged
    // like any other newcomer. If resolution had an id-based special case, this would take Claude's
    // path and never touch createPlan.
    const neutralOnly = new StubPlanner("claude-code");
    const resolvedPlanner = createOrchestratorSelection({
      ports: [neutralOnly],
      isolation: {
        create: async () => ({ path: "/snapshot", files: [], dispose: async () => undefined })
      },
      workspaceRoot: () => "/real/workspace",
      projectMetadata: () => ({}),
      availableAgents: async () => []
    }).resolve("claude-code");

    await resolvedPlanner?.port.analyze({
      workspaceId: "ws-1",
      objective: "Deliver",
      mode: "standard",
      limits: {
        maxWorkflowNodes: 8,
        maxRemediationCycles: 2,
        maxAttemptsPerNode: 2,
        timeoutMs: 2_700_000
      }
    });
    expect(neutralOnly.requests).toHaveLength(1);
    expect(neutralOnly.requests[0]?.snapshotPath).toBe("/snapshot");
    // It declares no remediation, so it stops rather than borrowing one.
    expect(resolvedPlanner?.supportsRemediation).toBe(false);
  });

  it("5/6. a planner that owns its analysis keeps it; a neutral one goes through the bridge", async () => {
    const harness = selection();
    const request = {
      workspaceId: "ws-1",
      objective: "Deliver",
      mode: "standard" as const,
      limits: {
        maxWorkflowNodes: 8,
        maxRemediationCycles: 2,
        maxAttemptsPerNode: 2,
        timeoutMs: 2_700_000
      }
    };
    await harness.selection.resolve("claude-code")?.port.analyze(request);
    // Claude's own analysis ran: no snapshot was taken for it, and its neutral entry point was not used.
    expect(harness.disposals).toHaveLength(0);
    expect(harness.agentsSeen).toHaveLength(0);

    await harness.selection.resolve("codex")?.port.analyze(request);
    // The neutral planner went through the bridge: one snapshot, created and disposed.
    expect(harness.disposals).toHaveLength(1);
    expect(harness.agentsSeen).toHaveLength(1);
  });

  it("7. detect never starts a planning turn", async () => {
    const harness = selection();
    await harness.selection.list();
    await harness.selection.list();
    expect(harness.disposals).toHaveLength(0);
    expect(harness.agentsSeen).toHaveLength(0);
  });
});
