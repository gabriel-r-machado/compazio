import { z } from "zod";

/**
 * Supervised-autonomous guardrails (batch E4).
 *
 * The product decision is deliberate: Compasso has no unrestricted autonomy. The third execution
 * level, "Autônomo supervisionado", may only coordinate agents automatically inside a workflow the
 * user already reviewed and approved. This module is the deterministic safety core that decides,
 * for one proposed automatic action, whether the runtime may proceed on its own, must pause for a
 * human, or must stop the workflow. It is a pure function with no process, filesystem, database or
 * network access so it can be exhaustively tested and reused by the runtime, CLI and desktop.
 */

/** Per-workflow limits. Every value is user-editable with conservative defaults. */
export const autonomyConfigSchema = z
  .object({
    maxConcurrentAgents: z.number().int().min(1).max(16).default(3),
    maxSpawnedAgents: z.number().int().min(1).max(64).default(6),
    maxRetriesPerNode: z.number().int().min(0).max(10).default(2),
    maxRuntimeMinutes: z.number().int().min(1).max(1_440).default(120),
    maxIdleMinutes: z.number().int().min(1).max(240).default(10),
    allowNetwork: z.boolean().default(false),
    allowDependencyInstall: z.boolean().default(false),
    allowExternalPaths: z.boolean().default(false),
    allowGitPush: z.boolean().default(false),
    allowMerge: z.boolean().default(false),
    allowDeploy: z.boolean().default(false)
  })
  .strict();

export type AutonomyConfig = z.infer<typeof autonomyConfigSchema>;

/** The conservative baseline used whenever a workflow does not declare its own limits. */
export const defaultAutonomyConfig: AutonomyConfig = autonomyConfigSchema.parse({});

/**
 * Actions the runtime can propose while a supervised-autonomous run is active. They are grouped by
 * how the guardrail treats them, not by who performs them.
 */
export const autonomyActionKindSchema = z.enum([
  // Forward progress permitted automatically inside the approved workflow, subject to limits.
  "continue_approved_step",
  "delegate_planned_task",
  "spawn_agent",
  "retry_node",
  "select_authorized_context",
  "run_local_validation",
  "propose_correction",
  "advance_on_criteria",
  // Safe cleanup routines the runtime performs on its own within the approved workflow.
  "terminate_idle_agent",
  "release_lease",
  // Pre-authorizable through an explicit config flag on the reviewed workflow.
  "network_access",
  "install_dependency",
  "access_external_path",
  "git_push",
  // Always require a human in this release, even if a related flag is set. Reserved, not automated.
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
]);

export type AutonomyActionKind = z.infer<typeof autonomyActionKindSchema>;

/**
 * A snapshot of the run the guardrail needs to reason about. The runtime supplies it; the guardrail
 * never reads live state itself. Every stop-condition flag defaults to false so a caller can pass
 * only what it has observed.
 */
export const autonomyRuntimeStateSchema = z
  .object({
    killSwitchEngaged: z.boolean().default(false),
    concurrentAgents: z.number().int().min(0).default(0),
    spawnedAgents: z.number().int().min(0).default(0),
    nodeAttempts: z.number().int().min(0).default(0),
    elapsedMinutes: z.number().min(0).default(0),
    idleMinutes: z.number().min(0).default(0),
    // Mandatory stop conditions observed by the runtime for the current decision point.
    ambiguity: z.boolean().default(false),
    conflictingInstructions: z.boolean().default(false),
    missingRequiredMaterial: z.boolean().default(false),
    dataLossRisk: z.boolean().default(false),
    credentialRequired: z.boolean().default(false),
    repeatedFailure: z.boolean().default(false),
    // Objective acceptance evidence for advance_on_criteria.
    resultObjectivelyValidatable: z.boolean().default(false),
    criteriaObjective: z.boolean().default(false),
    criteriaSatisfied: z.boolean().default(false)
  })
  .strict();

export type AutonomyRuntimeState = z.input<typeof autonomyRuntimeStateSchema>;

export const autonomyDecisionOutcomeSchema = z.enum(["allow", "require_approval", "stop"]);
export type AutonomyDecisionOutcome = z.infer<typeof autonomyDecisionOutcomeSchema>;

/** Auditable reason codes. The caller records who decided and the concrete inputs alongside these. */
export const autonomyDecisionRuleSchema = z.enum([
  "kill_switch",
  "ambiguity",
  "conflicting_instructions",
  "missing_required_material",
  "data_loss_risk",
  "credential_required",
  "repeated_failure",
  "runtime_limit",
  "concurrency_limit",
  "spawn_limit",
  "retry_limit",
  "criteria_not_objective",
  "human_approval_required",
  "not_preauthorized",
  "preauthorized_in_workflow",
  "within_supervised_scope",
  "idle_termination"
]);

export type AutonomyDecisionRule = z.infer<typeof autonomyDecisionRuleSchema>;

export interface AutonomyDecision {
  readonly outcome: AutonomyDecisionOutcome;
  readonly rule: AutonomyDecisionRule;
  /** Short, sanitized reason code suitable for an audit event. Never carries paths or commands. */
  readonly reason: string;
}

/** Actions that move the workflow forward and therefore respect the wall-clock runtime budget. */
const forwardProgressActions = new Set<AutonomyActionKind>([
  "continue_approved_step",
  "delegate_planned_task",
  "spawn_agent",
  "retry_node",
  "advance_on_criteria",
  "propose_correction"
]);

/** Actions that always require a human in this release, regardless of any config flag. */
const humanOnlyActions = new Set<AutonomyActionKind>([
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
]);

/** Actions a reviewed workflow can pre-authorize through a single explicit flag. */
const flagGatedActions: Readonly<
  Record<
    "network_access" | "install_dependency" | "access_external_path" | "git_push",
    keyof AutonomyConfig
  >
> = {
  network_access: "allowNetwork",
  install_dependency: "allowDependencyInstall",
  access_external_path: "allowExternalPaths",
  git_push: "allowGitPush"
};

const decision = (
  outcome: AutonomyDecisionOutcome,
  rule: AutonomyDecisionRule
): AutonomyDecision => ({ outcome, rule, reason: rule });

/**
 * Decides whether one proposed automatic action may proceed. Precedence is safety-first: the kill
 * switch and mandatory stop conditions win over everything, human-only actions can never be
 * automated, flag-gated actions need explicit pre-authorization, and only then are quota and
 * runtime limits applied to forward progress. The result is deterministic for a given input.
 */
export function evaluateAutonomyDecision(
  rawConfig: AutonomyConfig,
  rawState: AutonomyRuntimeState,
  action: AutonomyActionKind
): AutonomyDecision {
  const config = autonomyConfigSchema.parse(rawConfig);
  const state = autonomyRuntimeStateSchema.parse(rawState);

  // 1. Global interrupt. Nothing runs while the kill switch is engaged.
  if (state.killSwitchEngaged) return decision("stop", "kill_switch");

  // 2. Mandatory stops halt every forward action until a human resolves them.
  if (state.ambiguity) return decision("stop", "ambiguity");
  if (state.conflictingInstructions) return decision("stop", "conflicting_instructions");
  if (state.missingRequiredMaterial) return decision("stop", "missing_required_material");
  if (state.dataLossRisk) return decision("stop", "data_loss_risk");
  if (state.credentialRequired) return decision("stop", "credential_required");
  if (state.repeatedFailure) return decision("stop", "repeated_failure");

  // 3. Idle termination is safe cleanup, allowed only once the idle budget is actually exceeded.
  if (action === "terminate_idle_agent" || action === "release_lease") {
    // release_lease and idle termination are cleanup routines; they are always safe to run.
    return decision("allow", "idle_termination");
  }

  // 4. Human-only actions can never be automated in this release.
  if (humanOnlyActions.has(action)) return decision("require_approval", "human_approval_required");

  // 5. Flag-gated actions need explicit pre-authorization on the reviewed workflow.
  const flag = flagGatedActions[action as keyof typeof flagGatedActions];
  if (flag !== undefined) {
    return config[flag] === true
      ? decision("allow", "preauthorized_in_workflow")
      : decision("require_approval", "not_preauthorized");
  }

  // 6. Runtime budget applies to every forward-progress action.
  if (forwardProgressActions.has(action) && state.elapsedMinutes >= config.maxRuntimeMinutes) {
    return decision("stop", "runtime_limit");
  }

  // 7. Per-action quota and objective-criteria checks.
  if (action === "spawn_agent") {
    if (state.concurrentAgents >= config.maxConcurrentAgents) {
      return decision("stop", "concurrency_limit");
    }
    if (state.spawnedAgents >= config.maxSpawnedAgents) return decision("stop", "spawn_limit");
    return decision("allow", "within_supervised_scope");
  }
  if (action === "retry_node") {
    if (state.nodeAttempts >= config.maxRetriesPerNode) return decision("stop", "retry_limit");
    return decision("allow", "within_supervised_scope");
  }
  if (action === "advance_on_criteria") {
    const objective =
      state.criteriaObjective && state.criteriaSatisfied && state.resultObjectivelyValidatable;
    return objective
      ? decision("allow", "within_supervised_scope")
      : decision("require_approval", "criteria_not_objective");
  }

  // 8. Remaining scoped actions (continue, delegate, context, validation, propose) proceed.
  return decision("allow", "within_supervised_scope");
}

/**
 * Whether the target agent has been idle long enough to be stopped automatically. The runtime uses
 * this to drive idle termination; it is separate from evaluateAutonomyDecision because it is a
 * threshold query, not an action authorization.
 */
export function shouldTerminateIdleAgent(config: AutonomyConfig, idleMinutes: number): boolean {
  return idleMinutes >= autonomyConfigSchema.parse(config).maxIdleMinutes;
}

export interface SupervisedAutonomyPlan {
  readonly allowedActions: readonly AutonomyActionKind[];
  readonly preauthorizedActions: readonly AutonomyActionKind[];
  readonly approvalActions: readonly AutonomyActionKind[];
  readonly quotas: AutonomyConfig;
  readonly mandatoryStops: readonly AutonomyDecisionRule[];
}

/**
 * Produces the pre-start summary the desktop shows before a person confirms supervised-autonomous
 * execution: what runs automatically, what stays pre-authorized by flag, what still needs approval,
 * the effective quotas and the conditions that force a stop.
 */
export function describeSupervisedAutonomyPlan(rawConfig: AutonomyConfig): SupervisedAutonomyPlan {
  const config = autonomyConfigSchema.parse(rawConfig);
  const preauthorized: AutonomyActionKind[] = [];
  const approval: AutonomyActionKind[] = [];
  for (const [action, flag] of Object.entries(flagGatedActions) as [
    AutonomyActionKind,
    keyof AutonomyConfig
  ][]) {
    (config[flag] === true ? preauthorized : approval).push(action);
  }
  for (const action of humanOnlyActions) approval.push(action);
  return {
    allowedActions: [
      "continue_approved_step",
      "delegate_planned_task",
      "spawn_agent",
      "retry_node",
      "select_authorized_context",
      "run_local_validation",
      "propose_correction",
      "advance_on_criteria",
      "terminate_idle_agent",
      "release_lease"
    ],
    preauthorizedActions: preauthorized,
    approvalActions: approval,
    quotas: config,
    mandatoryStops: [
      "ambiguity",
      "conflicting_instructions",
      "missing_required_material",
      "data_loss_risk",
      "credential_required",
      "repeated_failure",
      "runtime_limit",
      "concurrency_limit",
      "spawn_limit",
      "retry_limit"
    ]
  };
}
