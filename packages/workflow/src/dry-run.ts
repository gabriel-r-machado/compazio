import type { PermissionMap, Workflow } from "./contracts";
import { validateWorkflowDag } from "./dag";

export interface DryRunPlan {
  readonly workflowId: string;
  readonly valid: boolean;
  readonly concurrency: number;
  readonly order: readonly string[];
  readonly waves: readonly (readonly string[])[];
  readonly requestedPermissions: readonly string[];
  readonly issues: readonly string[];
}

export function createDryRunPlan(
  workflow: Workflow,
  grantedPermissions: PermissionMap = workflow.permissions
): DryRunPlan {
  const validation = validateWorkflowDag(workflow, grantedPermissions);
  const requestedPermissions = new Set<string>();
  for (const node of workflow.nodes) {
    for (const [permission, enabled] of Object.entries(node.permissions)) {
      if (enabled) {
        requestedPermissions.add(permission);
      }
    }
  }
  return {
    workflowId: workflow.id,
    valid: validation.valid,
    concurrency: workflow.concurrency,
    order: validation.order,
    waves: validation.waves,
    requestedPermissions: [...requestedPermissions].sort(),
    issues: validation.issues.map((issue) => issue.message)
  };
}
