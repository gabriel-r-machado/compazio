import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  automaticModeToExecutionProfile,
  automaticWorkflowRequestSchema
} from "./automatic-workflow";
import { orchestratorPlanSchema, orchestratorPlanToDraft } from "./orchestrator-plan";
import { remediationPlanSchema } from "./remediation";

describe("automaticWorkflowRequestSchema", () => {
  it("accepts a well-formed request", () => {
    const request = automaticWorkflowRequestSchema.parse({
      workspaceId: "ws-1",
      objective: "Add Supabase auth and make the build pass",
      mode: "standard",
      limits: AUTOMATIC_MODE_DEFAULT_LIMITS.standard
    });
    expect(request.mode).toBe("standard");
  });

  it("rejects an empty objective and an unknown mode", () => {
    expect(
      automaticWorkflowRequestSchema.safeParse({
        workspaceId: "ws-1",
        objective: "   ",
        mode: "standard",
        limits: AUTOMATIC_MODE_DEFAULT_LIMITS.standard
      }).success
    ).toBe(false);
    expect(
      automaticWorkflowRequestSchema.safeParse({
        workspaceId: "ws-1",
        objective: "do it",
        mode: "turbo",
        limits: AUTOMATIC_MODE_DEFAULT_LIMITS.standard
      }).success
    ).toBe(false);
  });

  it("maps each mode to a distinct execution profile", () => {
    expect(automaticModeToExecutionProfile("economic")).toBe("economy");
    expect(automaticModeToExecutionProfile("standard")).toBe("balanced");
    expect(automaticModeToExecutionProfile("high-performance")).toBe("maximum");
  });
});

const validPlan = {
  title: "Supabase auth",
  summary: "Implement auth, test it, fix until build passes.",
  nodes: [
    {
      id: "implement-auth",
      title: "Implement auth",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Implement Supabase email auth in the web app.",
      allowedAreas: ["apps/web/src/auth"],
      expectedArtifacts: ["auth module"],
      acceptanceCriteria: ["Login works", "Build passes"],
      verificationCommands: ["pnpm build"]
    },
    {
      id: "verify-auth",
      title: "Verify",
      role: "qa",
      adapter: "claude-code",
      prompt: "Run the tests and report failures.",
      dependsOn: ["implement-auth"],
      verificationCommands: ["pnpm test"]
    }
  ]
};

describe("orchestratorPlanSchema", () => {
  it("accepts a valid structured plan", () => {
    const plan = orchestratorPlanSchema.parse(validPlan);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[1]?.dependsOn).toEqual(["implement-auth"]);
  });

  it("rejects free text and structural errors (duplicate ids, missing/self deps)", () => {
    expect(orchestratorPlanSchema.safeParse("just do it").success).toBe(false);
    expect(
      orchestratorPlanSchema.safeParse({
        ...validPlan,
        nodes: [validPlan.nodes[0], validPlan.nodes[0]]
      }).success
    ).toBe(false);
    expect(
      orchestratorPlanSchema.safeParse({
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0], dependsOn: ["ghost"] }]
      }).success
    ).toBe(false);
  });
});

describe("orchestratorPlanToDraft", () => {
  it("produces a ready draft pinned to adapters with dependency edges (materialization covered in orchestration)", () => {
    const plan = orchestratorPlanSchema.parse(validPlan);
    const draft = orchestratorPlanToDraft(plan, {
      workspaceId: "ws-1",
      objective: "Add auth",
      executionProfile: "balanced",
      sourceTerminalId: "auto:ws-1",
      now: "2026-07-25T00:00:00.000Z",
      draftId: "11111111-1111-4111-8111-111111111111"
    });
    expect(draft.state).toBe("ready");
    expect(draft.creationMode).toBe("automatic");
    // Each node is pinned to its adapter, so materialization can bind it.
    expect(
      draft.nodes.every((node) => node.runtimeRequirement.resolvedRuntimeId === "claude-code")
    ).toBe(true);
    // The dependency became a dependency edge the materializer turns into depends_on.
    expect(draft.edges).toHaveLength(1);
    expect(draft.edges[0]).toMatchObject({
      sourceNodeId: "implement-auth",
      targetNodeId: "verify-auth",
      type: "dependency"
    });
  });

  it("creates an approval gate for a node that needs approval or is risky", () => {
    const plan = orchestratorPlanSchema.parse({
      ...validPlan,
      nodes: [{ ...validPlan.nodes[0], operationRisk: "destructive" }]
    });
    const draft = orchestratorPlanToDraft(plan, {
      workspaceId: "ws-1",
      objective: "Add auth",
      executionProfile: "balanced",
      sourceTerminalId: "auto:ws-1"
    });
    expect(draft.approvalGates).toHaveLength(1);
    expect(draft.approvalGates[0]?.nodeId).toBe("implement-auth");
  });
});

describe("remediationPlanSchema", () => {
  it("accepts a retry plan and rejects add_corrective_node without a node", () => {
    expect(
      remediationPlanSchema.safeParse({
        action: "retry_node",
        targetNodeId: "implement-auth",
        reason: "Build failed on a type error.",
        updatedPrompt: "Fix the type error in the auth module; do not undo working code."
      }).success
    ).toBe(true);
    expect(
      remediationPlanSchema.safeParse({
        action: "add_corrective_node",
        targetNodeId: "implement-auth",
        reason: "Needs a dedicated fix node.",
        updatedPrompt: "Add a migration."
      }).success
    ).toBe(false);
  });
});
