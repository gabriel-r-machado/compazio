import { describe, expect, it } from "vitest";

import {
  autonomyConfigSchema,
  defaultAutonomyConfig,
  describeSupervisedAutonomyPlan,
  evaluateAutonomyDecision,
  shouldTerminateIdleAgent,
  type AutonomyConfig,
  type AutonomyRuntimeState
} from "./supervised-autonomy";

const state = (overrides: Partial<AutonomyRuntimeState> = {}): AutonomyRuntimeState => ({
  ...overrides
});

const config = (overrides: Partial<AutonomyConfig> = {}): AutonomyConfig =>
  autonomyConfigSchema.parse({ ...overrides });

describe("autonomyConfigSchema", () => {
  it("defaults to conservative, network-denying limits", () => {
    expect(defaultAutonomyConfig).toEqual({
      maxConcurrentAgents: 3,
      maxSpawnedAgents: 6,
      maxRetriesPerNode: 2,
      maxRuntimeMinutes: 120,
      maxIdleMinutes: 10,
      allowNetwork: false,
      allowDependencyInstall: false,
      allowExternalPaths: false,
      allowGitPush: false,
      allowMerge: false,
      allowDeploy: false
    });
  });

  it("rejects out-of-range and unknown fields", () => {
    expect(() => autonomyConfigSchema.parse({ maxConcurrentAgents: 0 })).toThrow();
    expect(() => autonomyConfigSchema.parse({ maxRuntimeMinutes: 10_000 })).toThrow();
    expect(() => autonomyConfigSchema.parse({ unexpected: true })).toThrow();
  });
});

describe("evaluateAutonomyDecision precedence", () => {
  it("stops on the kill switch before any allow flag can apply", () => {
    const decision = evaluateAutonomyDecision(
      config({ allowNetwork: true }),
      state({ killSwitchEngaged: true }),
      "network_access"
    );
    expect(decision).toEqual({ outcome: "stop", rule: "kill_switch", reason: "kill_switch" });
  });

  it.each([
    ["ambiguity", { ambiguity: true }],
    ["conflicting_instructions", { conflictingInstructions: true }],
    ["missing_required_material", { missingRequiredMaterial: true }],
    ["data_loss_risk", { dataLossRisk: true }],
    ["credential_required", { credentialRequired: true }],
    ["repeated_failure", { repeatedFailure: true }]
  ])("stops on the mandatory condition %s", (rule, flag) => {
    const decision = evaluateAutonomyDecision(
      config(),
      state(flag as Partial<AutonomyRuntimeState>),
      "continue_approved_step"
    );
    expect(decision.outcome).toBe("stop");
    expect(decision.rule).toBe(rule);
  });
});

describe("human-only actions", () => {
  it.each([
    "git_merge",
    "deploy",
    "publish_release",
    "approve_final_delivery",
    "change_objective_or_scope",
    "destructive_command",
    "delete_files_or_project",
    "use_new_credential",
    "increase_quota",
    "bypass_gate"
  ] as const)("requires approval for %s even with every flag enabled", (action) => {
    const permissive = config({
      allowNetwork: true,
      allowDependencyInstall: true,
      allowExternalPaths: true,
      allowGitPush: true,
      allowMerge: true,
      allowDeploy: true
    });
    const decision = evaluateAutonomyDecision(permissive, state(), action);
    expect(decision).toEqual({
      outcome: "require_approval",
      rule: "human_approval_required",
      reason: "human_approval_required"
    });
  });
});

describe("flag-gated actions", () => {
  it.each([
    ["network_access", "allowNetwork"],
    ["install_dependency", "allowDependencyInstall"],
    ["access_external_path", "allowExternalPaths"],
    ["git_push", "allowGitPush"]
  ] as const)("requires approval for %s when the flag is off", (action, flag) => {
    const decision = evaluateAutonomyDecision(config({ [flag]: false }), state(), action);
    expect(decision).toEqual({
      outcome: "require_approval",
      rule: "not_preauthorized",
      reason: "not_preauthorized"
    });
  });

  it.each([
    ["network_access", "allowNetwork"],
    ["install_dependency", "allowDependencyInstall"],
    ["access_external_path", "allowExternalPaths"],
    ["git_push", "allowGitPush"]
  ] as const)("allows %s once the reviewed workflow pre-authorizes it", (action, flag) => {
    const decision = evaluateAutonomyDecision(config({ [flag]: true }), state(), action);
    expect(decision).toEqual({
      outcome: "allow",
      rule: "preauthorized_in_workflow",
      reason: "preauthorized_in_workflow"
    });
  });
});

describe("quotas and runtime limits", () => {
  it("stops a forward action once the runtime budget is spent", () => {
    const decision = evaluateAutonomyDecision(
      config({ maxRuntimeMinutes: 120 }),
      state({ elapsedMinutes: 120 }),
      "continue_approved_step"
    );
    expect(decision.rule).toBe("runtime_limit");
    expect(decision.outcome).toBe("stop");
  });

  it("stops spawning at the concurrency ceiling and at the total spawn ceiling", () => {
    expect(
      evaluateAutonomyDecision(
        config({ maxConcurrentAgents: 3 }),
        state({ concurrentAgents: 3, spawnedAgents: 1 }),
        "spawn_agent"
      ).rule
    ).toBe("concurrency_limit");
    expect(
      evaluateAutonomyDecision(
        config({ maxConcurrentAgents: 3, maxSpawnedAgents: 6 }),
        state({ concurrentAgents: 1, spawnedAgents: 6 }),
        "spawn_agent"
      ).rule
    ).toBe("spawn_limit");
  });

  it("allows spawning inside both ceilings", () => {
    const decision = evaluateAutonomyDecision(
      config(),
      state({ concurrentAgents: 1, spawnedAgents: 2 }),
      "spawn_agent"
    );
    expect(decision.outcome).toBe("allow");
    expect(decision.rule).toBe("within_supervised_scope");
  });

  it("stops retrying a node past its retry ceiling", () => {
    expect(
      evaluateAutonomyDecision(
        config({ maxRetriesPerNode: 2 }),
        state({ nodeAttempts: 2 }),
        "retry_node"
      ).rule
    ).toBe("retry_limit");
    expect(
      evaluateAutonomyDecision(
        config({ maxRetriesPerNode: 2 }),
        state({ nodeAttempts: 1 }),
        "retry_node"
      ).outcome
    ).toBe("allow");
  });
});

describe("advance_on_criteria", () => {
  it("advances only when the acceptance criteria are objective, satisfied and validatable", () => {
    const decision = evaluateAutonomyDecision(
      config(),
      state({
        criteriaObjective: true,
        criteriaSatisfied: true,
        resultObjectivelyValidatable: true
      }),
      "advance_on_criteria"
    );
    expect(decision.outcome).toBe("allow");
  });

  it.each([
    { criteriaObjective: false, criteriaSatisfied: true, resultObjectivelyValidatable: true },
    { criteriaObjective: true, criteriaSatisfied: false, resultObjectivelyValidatable: true },
    { criteriaObjective: true, criteriaSatisfied: true, resultObjectivelyValidatable: false }
  ])("requires approval when a criterion is missing (%o)", (partial) => {
    const decision = evaluateAutonomyDecision(config(), state(partial), "advance_on_criteria");
    expect(decision).toEqual({
      outcome: "require_approval",
      rule: "criteria_not_objective",
      reason: "criteria_not_objective"
    });
  });
});

describe("scoped and cleanup actions", () => {
  it.each([
    "continue_approved_step",
    "delegate_planned_task",
    "select_authorized_context",
    "run_local_validation",
    "propose_correction"
  ] as const)("allows the in-scope action %s", (action) => {
    expect(evaluateAutonomyDecision(config(), state(), action).outcome).toBe("allow");
  });

  it("always allows safe cleanup, even while a runtime limit would block forward progress", () => {
    const spent = state({ elapsedMinutes: 1_000 });
    expect(evaluateAutonomyDecision(config(), spent, "terminate_idle_agent").rule).toBe(
      "idle_termination"
    );
    expect(evaluateAutonomyDecision(config(), spent, "release_lease").outcome).toBe("allow");
  });

  it("still stops cleanup when the kill switch is engaged", () => {
    expect(
      evaluateAutonomyDecision(config(), state({ killSwitchEngaged: true }), "release_lease")
        .outcome
    ).toBe("stop");
  });
});

describe("shouldTerminateIdleAgent", () => {
  it("only terminates once the idle budget is exceeded", () => {
    expect(shouldTerminateIdleAgent(config({ maxIdleMinutes: 10 }), 9)).toBe(false);
    expect(shouldTerminateIdleAgent(config({ maxIdleMinutes: 10 }), 10)).toBe(true);
  });
});

describe("describeSupervisedAutonomyPlan", () => {
  it("summarizes allowed, pre-authorized, approval-gated actions and quotas", () => {
    const plan = describeSupervisedAutonomyPlan(config({ allowGitPush: true }));
    expect(plan.preauthorizedActions).toContain("git_push");
    expect(plan.approvalActions).toContain("git_merge");
    expect(plan.approvalActions).toContain("network_access");
    expect(plan.approvalActions).not.toContain("git_push");
    expect(plan.allowedActions).toContain("spawn_agent");
    expect(plan.quotas.maxConcurrentAgents).toBe(3);
    expect(plan.mandatoryStops).toContain("runtime_limit");
  });
});
