import { z } from "zod";

import { orchestratorPlanNodeSchema } from "./orchestrator-plan";

/**
 * The structured, schema-validated output the orchestrator returns when a verification fails. It is
 * never free text: the AutomaticWorkflowCoordinator validates it and turns it into either an official
 * retry of the failed node (with a corrected prompt) or an official corrective node. It can never
 * silently rewrite the whole workflow or undo already-valid work.
 */

export const remediationActionSchema = z.enum(["retry_node", "add_corrective_node"]);
export type RemediationAction = z.infer<typeof remediationActionSchema>;

export const remediationPlanSchema = z
  .object({
    action: remediationActionSchema,
    /** The failed node the remediation is aimed at. */
    targetNodeId: z.string().min(1).max(160),
    /** A concise, sanitized explanation of what failed and how the fix addresses it. */
    reason: z.string().trim().min(1).max(2_000),
    /** The corrected prompt for the retry (for `retry_node`), or the corrective node's prompt seed. */
    updatedPrompt: z.string().trim().min(1).max(20_000),
    /**
     * A brand-new corrective node to insert (only for `add_corrective_node`). Its `dependsOn` should
     * include the target node so it runs after it, and it must not redo valid upstream work.
     */
    correctiveNode: orchestratorPlanNodeSchema.optional()
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.action === "add_corrective_node" && plan.correctiveNode === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add_corrective_node requires a correctiveNode",
        path: ["correctiveNode"]
      });
    }
  });
export type RemediationPlan = z.infer<typeof remediationPlanSchema>;
