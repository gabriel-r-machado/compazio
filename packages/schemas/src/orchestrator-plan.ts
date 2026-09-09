import { z } from "zod";

import { workflowDraftSchema, workflowRoleSchema, type WorkflowDraft } from "./workflow-draft";
import type { ExecutionProfile } from "./workflow-mode";

/**
 * The structured, schema-validated output of the read-only analysis/planning task. The orchestrator
 * (a single-shot Claude Code task) analyzes the project and returns THIS — never free text. It is then
 * converted deterministically into the existing {@link WorkflowDraft}, so materialization, the runtime
 * and the canvas projection are all reused unchanged.
 */

const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** How destructive the node's intended operation is; anything above `safe` gates on human approval. */
export const operationRiskSchema = z.enum(["safe", "caution", "destructive"]);
export type OperationRisk = z.infer<typeof operationRiskSchema>;

export const orchestratorPlanNodeSchema = z
  .object({
    /** Stable executable id, decided before materialization; reused verbatim as the workflow node id. */
    id: z.string().min(1).max(160).regex(NODE_ID_PATTERN),
    title: z.string().trim().min(1).max(160),
    role: workflowRoleSchema,
    /** The adapter that runs this node (e.g. `claude-code`). No command/executable is ever synthesized. */
    adapter: z.string().trim().min(1).max(160),
    /** The complete prompt the node's agent receives. */
    prompt: z.string().trim().min(1).max(20_000),
    dependsOn: z.array(z.string().min(1).max(160)).max(64).default([]),
    /** Files or areas the node is allowed to touch. */
    allowedAreas: z.array(z.string().trim().min(1).max(400)).max(64).default([]),
    expectedArtifacts: z.array(z.string().trim().min(1).max(400)).max(32).default([]),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(32).default([]),
    /** Allowlisted verification commands (e.g. `pnpm test`), evaluated by exit code, never by text. */
    verificationCommands: z.array(z.string().trim().min(1).max(400)).max(16).default([]),
    operationRisk: operationRiskSchema.default("safe"),
    requiresHumanApproval: z.boolean().default(false)
  })
  .strict();
export type OrchestratorPlanNode = z.infer<typeof orchestratorPlanNodeSchema>;

export const orchestratorPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(4_000),
    nodes: z.array(orchestratorPlanNodeSchema).min(1).max(50),
    assumptions: z.array(z.string().trim().min(1).max(2_000)).max(64).default([]),
    /** The plan itself asks for human approval before execution (risk, ambiguity, cost). */
    needsHumanApproval: z.boolean().default(false)
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const node of plan.nodes) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate plan node id: ${node.id}`,
          path: ["nodes"]
        });
      }
      ids.add(node.id);
    }
    for (const node of plan.nodes) {
      for (const dependency of node.dependsOn) {
        if (dependency === node.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Plan node ${node.id} cannot depend on itself`,
            path: ["nodes"]
          });
        } else if (!ids.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Plan node ${node.id} depends on missing node ${dependency}`,
            path: ["nodes"]
          });
        }
      }
    }
  });
export type OrchestratorPlan = z.infer<typeof orchestratorPlanSchema>;

/**
 * The response contract, DERIVED FROM THE SCHEMA rather than restated by hand. Anything that describes the
 * expected answer to a model must be built from these, so a schema change can never leave a prompt telling
 * an agent something the validator will then reject.
 */

/** Every role the schema accepts, in schema order. */
export const ORCHESTRATOR_PLAN_ROLES: readonly string[] = workflowRoleSchema.options;

/** Every key a plan node may carry. */
export const ORCHESTRATOR_PLAN_NODE_FIELDS: readonly string[] = Object.keys(
  orchestratorPlanNodeSchema.shape
).sort();

/**
 * Keys a caller must supply. Computed by asking the schema what it refuses when given nothing, so a field
 * that later gains or loses a default is reflected here automatically.
 */
export const ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS: readonly string[] = deriveRequiredFields(
  orchestratorPlanNodeSchema
);

export const ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS: readonly string[] =
  deriveRequiredFields(orchestratorPlanSchema);

function deriveRequiredFields(schema: {
  safeParse: (value: unknown) => unknown;
}): readonly string[] {
  const result = schema.safeParse({}) as
    | { readonly success: true }
    | { readonly success: false; readonly error: { readonly issues: readonly z.core.$ZodIssue[] } };
  if (result.success) return [];
  return [
    ...new Set(
      result.error.issues
        .filter((issue) => issue.path.length === 1)
        .map((issue) => String(issue.path[0]))
    )
  ].sort();
}

/**
 * One minimal plan that genuinely satisfies the schema, parsed at load time so it can never drift. It is
 * the example shown to a planning agent: a real, complete answer rather than a sketch, including the
 * fields that carry defaults, so nothing has to be inferred.
 */
export const ORCHESTRATOR_PLAN_EXAMPLE: OrchestratorPlan = orchestratorPlanSchema.parse({
  title: "Add a health endpoint",
  summary: "Implement the endpoint, then verify it with the existing test script.",
  nodes: [
    {
      id: "implement-health-endpoint",
      title: "Implement the health endpoint",
      role: "implementer",
      adapter: "claude-code",
      prompt:
        'Add a GET /health endpoint that responds with status 200 and the JSON body {"status":"ok"}. Touch only the server module.',
      dependsOn: [],
      allowedAreas: ["src/server"],
      expectedArtifacts: ["the updated server module"],
      acceptanceCriteria: ["GET /health responds 200", "The existing tests still pass"],
      verificationCommands: ["pnpm test"],
      operationRisk: "safe",
      requiresHumanApproval: false
    },
    {
      id: "verify-health-endpoint",
      title: "Verify the health endpoint",
      role: "qa",
      adapter: "claude-code",
      prompt:
        "Run the test suite and report whether GET /health responds 200 with the expected body. Do not change source files.",
      dependsOn: ["implement-health-endpoint"],
      allowedAreas: ["src/server"],
      expectedArtifacts: ["the test report"],
      acceptanceCriteria: ["The test suite passes"],
      verificationCommands: ["pnpm test"],
      operationRisk: "safe",
      requiresHumanApproval: false
    }
  ],
  assumptions: ["The project already has a test script"],
  needsHumanApproval: false
});

export interface OrchestratorPlanToDraftContext {
  readonly workspaceId: string;
  readonly objective: string;
  readonly executionProfile: ExecutionProfile;
  readonly sourceTerminalId: string;
  /** ISO timestamp; defaults to now. Injectable for deterministic tests. */
  readonly now?: string;
  /** Draft uuid; defaults to a random uuid. Injectable for deterministic tests. */
  readonly draftId?: string;
}

/**
 * Deterministically converts a validated {@link OrchestratorPlan} into a ready {@link WorkflowDraft}.
 * Every node's stable id becomes the executable workflow node id, its adapter is pinned as the
 * resolved runtime (so materialization binds it), `dependsOn` becomes dependency edges, and any node
 * that needs approval produces an approval gate. It invents no runtime availability and starts nothing.
 */
export function orchestratorPlanToDraft(
  plan: OrchestratorPlan,
  context: OrchestratorPlanToDraftContext
): WorkflowDraft {
  const now = context.now ?? new Date().toISOString();
  const draftId = context.draftId ?? crypto.randomUUID();

  const nodes = plan.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    role: node.role,
    objective: node.prompt.slice(0, 8_000),
    constraints: node.allowedAreas
      .slice(0, 32)
      .map((area) => `Restrito a: ${area}`.slice(0, 2_000)),
    acceptanceCriteria: node.acceptanceCriteria,
    expectedOutputs: node.expectedArtifacts.map((artifact) => ({
      label: artifact.slice(0, 160),
      description: ""
    })),
    runtimeRequirement: {
      strategy: "fixed" as const,
      fixedRuntimeId: node.adapter,
      resolvedRuntimeId: node.adapter,
      resolutionReason: "Bound by the automatic-mode orchestrator plan."
    },
    execution: {
      canRunInParallel: false,
      estimatedComplexity: "medium" as const,
      requiresHumanApproval: node.requiresHumanApproval
    },
    lifecycle: "configured" as const,
    generatedByOrchestrator: true
  }));

  const edges = plan.nodes.flatMap((node) =>
    node.dependsOn.map((dependency) => ({
      id: `edge-${dependency}-${node.id}`.slice(0, 160),
      sourceNodeId: dependency,
      targetNodeId: node.id,
      type: "dependency" as const
    }))
  );

  const approvalGates = plan.nodes
    .filter((node) => node.requiresHumanApproval || node.operationRisk !== "safe")
    .map((node) => ({
      id: `gate-${node.id}`.slice(0, 160),
      nodeId: node.id,
      description:
        node.operationRisk === "safe"
          ? "Requer aprovação humana antes de executar."
          : `Operação de risco (${node.operationRisk}); requer aprovação humana.`
    }));

  return workflowDraftSchema.parse({
    id: draftId,
    version: 0,
    workspaceId: context.workspaceId,
    sourceTerminalId: context.sourceTerminalId,
    creationMode: "automatic",
    executionProfile: context.executionProfile,
    title: plan.title,
    objective: context.objective.slice(0, 8_000),
    assumptions: plan.assumptions.slice(0, 64).map((statement, index) => ({
      id: `assumption-${index}`,
      statement,
      createdBy: "orchestrator" as const
    })),
    nodes,
    edges,
    approvalGates,
    state: "ready" as const,
    createdAt: now,
    updatedAt: now
  });
}
