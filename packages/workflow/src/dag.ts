import type { PermissionMap, Workflow } from "./contracts";

export type WorkflowValidationIssueCode =
  | "duplicate_node_id"
  | "missing_dependency"
  | "self_dependency"
  | "cycle_detected"
  | "permission_escalation";

export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationIssueCode;
  readonly nodeId: string | null;
  readonly message: string;
}

export interface WorkflowValidationResult {
  readonly valid: boolean;
  readonly issues: readonly WorkflowValidationIssue[];
  readonly order: readonly string[];
  readonly waves: readonly (readonly string[])[];
}

export function validateWorkflowDag(
  workflow: Workflow,
  grantedPermissions: PermissionMap = workflow.permissions
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];
  const nodeById = new Map<string, Workflow["nodes"][number]>();

  for (const node of workflow.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        nodeId: node.id,
        message: `Duplicate workflow node id: ${node.id}`
      });
    } else {
      nodeById.set(node.id, node);
    }
    if (!permissionsAreSubset(node.permissions, grantedPermissions)) {
      issues.push({
        code: "permission_escalation",
        nodeId: node.id,
        message: `Node ${node.id} requests permissions not granted to the run`
      });
    }
  }

  for (const node of nodeById.values()) {
    for (const dependency of node.depends_on) {
      if (dependency === node.id) {
        issues.push({
          code: "self_dependency",
          nodeId: node.id,
          message: `Node ${node.id} cannot depend on itself`
        });
      } else if (!nodeById.has(dependency)) {
        issues.push({
          code: "missing_dependency",
          nodeId: node.id,
          message: `Node ${node.id} depends on missing node ${dependency}`
        });
      }
    }
  }

  const order = topologicalOrder(nodeById);
  if (order.length !== nodeById.size) {
    issues.push({
      code: "cycle_detected",
      nodeId: null,
      message: "Workflow contains a dependency cycle"
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    order,
    waves: issues.some((issue) => issue.code === "cycle_detected")
      ? []
      : buildWaves(nodeById, order)
  };
}

export function permissionsAreSubset(requested: PermissionMap, granted: PermissionMap): boolean {
  return Object.entries(requested).every(([permission, enabled]) =>
    enabled ? granted[permission as keyof PermissionMap] === true : true
  );
}

function topologicalOrder(
  nodes: ReadonlyMap<string, Workflow["nodes"][number]>
): readonly string[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes.values()) {
    const validDependencies = node.depends_on.filter((dependency) => nodes.has(dependency));
    inDegree.set(node.id, new Set(validDependencies).size);
    for (const dependency of validDependencies) {
      const entries = dependents.get(dependency) ?? [];
      entries.push(node.id);
      dependents.set(dependency, entries);
    }
  }

  const ready = [...nodes.keys()].filter((id) => inDegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    order.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return order;
}

function buildWaves(
  nodes: ReadonlyMap<string, Workflow["nodes"][number]>,
  order: readonly string[]
): readonly (readonly string[])[] {
  const depth = new Map<string, number>();
  for (const id of order) {
    const node = nodes.get(id);
    if (node === undefined) {
      continue;
    }
    const nodeDepth = node.depends_on.reduce(
      (maximum, dependency) => Math.max(maximum, (depth.get(dependency) ?? -1) + 1),
      0
    );
    depth.set(id, nodeDepth);
  }
  const waves: string[][] = [];
  for (const id of order) {
    const nodeDepth = depth.get(id) ?? 0;
    const wave = waves[nodeDepth] ?? [];
    wave.push(id);
    waves[nodeDepth] = wave;
  }
  return waves;
}
