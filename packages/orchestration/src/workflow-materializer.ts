import type { WorkflowDraft } from "@forgedeck/schemas";
import { validateWorkflowDag, workflowSchema } from "@forgedeck/workflow";
import type { Workflow } from "@forgedeck/workflow";

import {
  resolveNodeAgentAssignment,
  validateNodeAgentAssignment,
  type AgentAssignmentCatalog,
  type AgentAssignmentIssueCode
} from "./agent-assignment";

/**
 * Turns an approved {@link WorkflowDraft} into an official {@link Workflow} definition that the
 * WorkflowRunRuntime can execute. This is a pure, deterministic transform with no side effects: it
 * never starts a process, touches the store, or invents runtime availability.
 *
 * Identity is preserved structurally — each official `nodeId` is exactly the draft node id already
 * bound to the canvas as `workflowNodeId` — so the increment-B projection lights up the real cards and
 * edges without any renderer change. Title, position, array index and ephemeral ReactFlow ids are
 * never used as executable identity. A node without a resolved runtime binding, a duplicate id, a
 * dependency to a missing node, a cycle, or an empty team blocks materialization; the caller must not
 * create a run or an attempt when issues are present.
 */

const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Draft edge types that express an executable ordering dependency in the official workflow. */
const DEPENDENCY_EDGE_TYPES: ReadonlySet<WorkflowDraft["edges"][number]["type"]> = new Set([
  "dependency",
  "handoff"
]);

export type WorkflowMaterializationIssueCode =
  | "empty_workflow"
  | "invalid_node_id"
  | "missing_binding"
  | "duplicate_node_id"
  | "missing_dependency"
  | "self_dependency"
  | "cycle_detected"
  | "invalid_definition"
  | AgentAssignmentIssueCode;

export interface WorkflowMaterializationOptions {
  /**
   * The agents present on this machine right now. When supplied, every node's agent assignment is
   * validated against it and `assignedAdapter` becomes the definition's executable `adapter`.
   *
   * When absent, materialization keeps checking only the legacy runtime binding. That is what lets an
   * already-materialized historical workflow be re-read without being re-judged against a machine that
   * may no longer have the same agents installed.
   */
  readonly agents?: AgentAssignmentCatalog;
}

export interface WorkflowMaterializationIssue {
  readonly code: WorkflowMaterializationIssueCode;
  readonly nodeId: string | null;
  readonly message: string;
}

export interface WorkflowMaterializationResult {
  /** The official definition, or null when any issue is present. */
  readonly workflow: Workflow | null;
  /** Stable workflowNodeIds of the agent nodes, in draft order; the first is the run's agent target. */
  readonly agentNodeIds: readonly string[];
  readonly issues: readonly WorkflowMaterializationIssue[];
}

/** A stable, schema-valid workflow id derived only from the draft id (never from the title). */
export function materializedWorkflowId(draft: Pick<WorkflowDraft, "id">): string {
  return `draft-${draft.id}`;
}

export function materializeWorkflowDraft(
  draft: WorkflowDraft,
  options: WorkflowMaterializationOptions = {}
): WorkflowMaterializationResult {
  const issues: WorkflowMaterializationIssue[] = [];
  const nodeIds = draft.nodes.map((node) => node.id);
  const agentNodeIds: string[] = [];
  const catalog = options.agents;
  // The executable agent per node, decided once here. After materialization the definition's
  // `adapter` is the authority for the run; the draft is never consulted again and a later canvas
  // edit therefore cannot change what an existing run executes.
  const adapterByNode = new Map<string, string>();

  if (draft.nodes.length === 0) {
    issues.push({
      code: "empty_workflow",
      nodeId: null,
      message: "The workflow has no executable nodes to materialize."
    });
  }

  const seen = new Set<string>();
  for (const node of draft.nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) {
      issues.push({
        code: "invalid_node_id",
        nodeId: node.id,
        message: `Node id ${node.id} is not a valid executable identifier.`
      });
    }
    if (seen.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        nodeId: node.id,
        message: `Duplicate node id: ${node.id}.`
      });
    }
    seen.add(node.id);
    if (catalog === undefined) {
      if (
        node.runtimeRequirement.resolvedRuntimeId === null ||
        node.runtimeRequirement.resolvedRuntimeId.length === 0
      ) {
        issues.push({
          code: "missing_binding",
          nodeId: node.id,
          message: `Node ${node.id} has no resolved runtime binding.`
        });
      } else {
        adapterByNode.set(node.id, node.runtimeRequirement.resolvedRuntimeId);
        agentNodeIds.push(node.id);
      }
      continue;
    }
    // A node's agent must be an explicit, known, available, executable and capable choice. A legacy
    // node contributes its binding only when that binding is exactly a known adapter id.
    const assignment = resolveNodeAgentAssignment(node);
    const assignmentIssues = validateNodeAgentAssignment({
      nodeId: node.id,
      assignment,
      catalog
    });
    if (assignmentIssues.length > 0) {
      issues.push(...assignmentIssues);
      continue;
    }
    // Guaranteed non-null: an absent assignment is reported above and never reaches here.
    adapterByNode.set(node.id, assignment.assignedAdapter as string);
    agentNodeIds.push(node.id);
  }

  const nodeIdSet = new Set(nodeIds);
  const dependenciesByNode = collectDependencies(draft);
  for (const [nodeId, dependencies] of dependenciesByNode) {
    for (const dependency of dependencies) {
      if (dependency === nodeId) {
        issues.push({
          code: "self_dependency",
          nodeId,
          message: `Node ${nodeId} cannot depend on itself.`
        });
      } else if (!nodeIdSet.has(dependency)) {
        issues.push({
          code: "missing_dependency",
          nodeId,
          message: `Node ${nodeId} depends on missing node ${dependency}.`
        });
      }
    }
  }

  if (issues.length > 0) {
    return { workflow: null, agentNodeIds, issues };
  }

  let workflow: Workflow;
  try {
    workflow = workflowSchema.parse({
      schema_version: "1.0",
      id: materializedWorkflowId(draft),
      name: draft.title.length > 0 ? draft.title : "Canvas workflow",
      description: draft.objective.length > 0 ? draft.objective.slice(0, 2_000) : undefined,
      concurrency: 1,
      permissions: {},
      nodes: draft.nodes.map((node) => ({
        id: node.id,
        type: "agent" as const,
        title: node.title,
        role: node.role,
        // The chosen agent becomes the definition's executable adapter. The resolver picks the
        // executor from it; no command, executable or path is ever synthesized here.
        adapter: adapterByNode.get(node.id),
        depends_on: [...(dependenciesByNode.get(node.id) ?? [])],
        permissions: {}
      }))
    });
  } catch (error) {
    return {
      workflow: null,
      agentNodeIds,
      issues: [
        {
          code: "invalid_definition",
          nodeId: null,
          message:
            error instanceof Error ? error.message : "The materialized definition is invalid."
        }
      ]
    };
  }

  const dag = validateWorkflowDag(workflow);
  if (!dag.valid) {
    return {
      workflow: null,
      agentNodeIds,
      issues: dag.issues.map((issue) => ({
        code: mapDagIssueCode(issue.code),
        nodeId: issue.nodeId,
        message: issue.message
      }))
    };
  }

  return { workflow, agentNodeIds, issues: [] };
}

/** Deduplicated executable dependencies (dependency/handoff edges), keyed by target node id. */
function collectDependencies(draft: WorkflowDraft): Map<string, readonly string[]> {
  const byTarget = new Map<string, Set<string>>();
  for (const node of draft.nodes) {
    byTarget.set(node.id, new Set());
  }
  for (const edge of draft.edges) {
    if (!DEPENDENCY_EDGE_TYPES.has(edge.type)) continue;
    const set = byTarget.get(edge.targetNodeId);
    if (set === undefined) continue;
    set.add(edge.sourceNodeId);
  }
  return new Map([...byTarget].map(([nodeId, set]) => [nodeId, [...set].sort()]));
}

function mapDagIssueCode(
  code: ReturnType<typeof validateWorkflowDag>["issues"][number]["code"]
): WorkflowMaterializationIssueCode {
  switch (code) {
    case "duplicate_node_id":
      return "duplicate_node_id";
    case "missing_dependency":
      return "missing_dependency";
    case "self_dependency":
      return "self_dependency";
    case "cycle_detected":
      return "cycle_detected";
    default:
      return "invalid_definition";
  }
}
