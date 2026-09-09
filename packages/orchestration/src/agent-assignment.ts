import {
  AGENT_ASSIGNMENT_DEFAULT,
  AGENT_PRESET_PREFERENCE,
  toAgentAdapterId,
  workflowNodeAgentAssignmentSchema
} from "@forgedeck/schemas";
import type {
  AgentAdapterId,
  AgentAssignmentPreset,
  AgentCapability,
  AgentDescriptor,
  WorkflowNodeAgentAssignment,
  WorkflowNodeDraft
} from "@forgedeck/schemas";

/**
 * Deterministic agent selection for a workflow draft: how a legacy node's binding becomes an
 * assignment, how a preset suggests one, and what makes an assignment executable. Pure functions only
 * — nothing here detects an agent, starts a process, touches the store or creates a run.
 *
 * The rule that governs all of it: an agent is never inferred. Not from a node's title, role, prompt,
 * position or index, and not from a runtime id the product does not recognize. When the input does not
 * determine an agent, the answer is "no assignment", which the validator then reports as a node that
 * needs an explicit decision.
 */

/** What the validator needs to know about the agents present on this machine, right now. */
export interface AgentAssignmentCatalog {
  /** Descriptors of every known agent, including the ones that are not installed. */
  readonly descriptors: readonly AgentDescriptor[];
}

export type AgentAssignmentIssueCode =
  | "missing_agent_assignment"
  | "unknown_agent_adapter"
  | "agent_unavailable"
  | "agent_not_executable"
  | "agent_capabilities_unmet"
  | "invalid_fallback_adapter";

export interface AgentAssignmentIssue {
  readonly code: AgentAssignmentIssueCode;
  readonly nodeId: string;
  readonly message: string;
}

/**
 * The assignment that actually applies to a node, including drafts written before the neutral agent
 * model existed.
 *
 * The legacy migration is deliberately narrow: a node with no `agentAssignment` adopts its legacy
 * `resolvedRuntimeId` ONLY when that string is exactly a known adapter id. A runtime id the product
 * does not recognize yields no assignment at all, so an unknown value can never quietly become the
 * agent that runs the node — it surfaces as a node awaiting an explicit choice instead.
 */
export function resolveNodeAgentAssignment(
  node: Pick<WorkflowNodeDraft, "agentAssignment" | "runtimeRequirement">
): WorkflowNodeAgentAssignment {
  if (node.agentAssignment !== undefined) return node.agentAssignment;
  const legacy = toAgentAdapterId(node.runtimeRequirement.resolvedRuntimeId);
  if (legacy === null) return AGENT_ASSIGNMENT_DEFAULT;
  return workflowNodeAgentAssignmentSchema.parse({
    ...AGENT_ASSIGNMENT_DEFAULT,
    assignedAdapter: legacy,
    recommendationReason: "Migrated from the workflow's existing runtime binding."
  });
}

export interface AgentAssignmentSuggestion {
  readonly nodeId: string;
  readonly assignedAdapter: AgentAdapterId | null;
  readonly reason: string;
}

/**
 * Applies a preset to every node of a draft and returns the suggested assignments. Deterministic and
 * decided only from: the node's ordered recommendations, the preset's documented preference order,
 * declared capabilities and current availability.
 *
 * `manual` suggests nothing — every node stays undecided until the user chooses. No preset ever
 * selects an unavailable agent, and when no candidate qualifies the answer is `null` rather than a
 * quiet default, so a node is never silently handed to whichever agent happens to be installed.
 */
export function suggestAgentAssignments(input: {
  readonly nodes: readonly WorkflowNodeDraft[];
  readonly preset: AgentAssignmentPreset;
  readonly catalog: AgentAssignmentCatalog;
}): readonly AgentAssignmentSuggestion[] {
  return input.nodes.map((node) => {
    const assignment = resolveNodeAgentAssignment(node);
    if (input.preset === "manual") {
      return {
        nodeId: node.id,
        assignedAdapter: null,
        reason: "Manual selection: this node needs an explicit agent."
      };
    }
    const eligible = (candidate: AgentAdapterId): boolean =>
      isExecutable(candidate, assignment.requiredCapabilities, input.catalog);

    // A node already pinned by the user (including a configured canvas agent reconciled into an
    // automatic draft) is not a suggestion waiting to be overwritten. Presets fill undecided nodes;
    // they never replace a valid explicit choice.
    if (assignment.assignedAdapter !== null && eligible(assignment.assignedAdapter)) {
      return {
        nodeId: node.id,
        assignedAdapter: assignment.assignedAdapter,
        reason: "Kept the agent explicitly selected for this node."
      };
    }
    const recommended = assignment.recommendedAdapters.find(eligible);
    if (recommended !== undefined) {
      return {
        nodeId: node.id,
        assignedAdapter: recommended,
        reason: "Recommended for this node and available with the required capabilities."
      };
    }
    const preferred = AGENT_PRESET_PREFERENCE[input.preset].find(eligible);
    if (preferred !== undefined) {
      return {
        nodeId: node.id,
        assignedAdapter: preferred,
        reason:
          assignment.recommendedAdapters.length === 0
            ? `Chosen by the ${input.preset} preference order among the available agents.`
            : `No recommended agent is available; chosen by the ${input.preset} preference order.`
      };
    }
    return {
      nodeId: node.id,
      assignedAdapter: null,
      reason: "No available agent has the capabilities this node requires."
    };
  });
}

/**
 * Whether one node's assignment may execute, with the reason it may not. This is the single predicate
 * materialization uses, so the interface and the run gate can never disagree about what is runnable.
 */
export function validateNodeAgentAssignment(input: {
  readonly nodeId: string;
  readonly assignment: WorkflowNodeAgentAssignment;
  readonly catalog: AgentAssignmentCatalog;
}): readonly AgentAssignmentIssue[] {
  const issues: AgentAssignmentIssue[] = [];
  const { assignment, nodeId, catalog } = input;
  const assigned = assignment.assignedAdapter;

  if (assigned === null) {
    return [
      {
        code: "missing_agent_assignment",
        nodeId,
        message: `Node ${nodeId} has no agent selected. Choose one before starting the run.`
      }
    ];
  }

  const descriptor = findDescriptor(assigned, catalog);
  if (descriptor === null) {
    return [
      {
        code: "unknown_agent_adapter",
        nodeId,
        message: `Node ${nodeId} names an unknown agent: ${assigned}.`
      }
    ];
  }
  if (!descriptor.available) {
    issues.push({
      code: "agent_unavailable",
      nodeId,
      message: `Node ${nodeId} is assigned to ${descriptor.displayName}, which is not available: ${
        descriptor.unavailability?.message ?? "no reason was reported"
      }`
    });
  }
  if (!descriptor.hasImplementation || !descriptor.supportsExecution) {
    issues.push({
      code: "agent_not_executable",
      nodeId,
      message: `Node ${nodeId} is assigned to ${descriptor.displayName}, which cannot execute workflow nodes yet.`
    });
  }
  const missing = missingCapabilities(assignment.requiredCapabilities, descriptor);
  if (missing.length > 0) {
    issues.push({
      code: "agent_capabilities_unmet",
      nodeId,
      message: `Node ${nodeId} requires ${missing.join(", ")}, which ${descriptor.displayName} does not declare.`
    });
  }
  for (const fallback of assignment.fallbackAdapters) {
    if (findDescriptor(fallback, catalog) === null) {
      issues.push({
        code: "invalid_fallback_adapter",
        nodeId,
        message: `Node ${nodeId} lists an unknown fallback agent: ${fallback}.`
      });
    } else if (fallback === assigned) {
      issues.push({
        code: "invalid_fallback_adapter",
        nodeId,
        message: `Node ${nodeId} lists its own assigned agent as a fallback.`
      });
    }
  }
  return issues;
}

/** Available, executable, and declaring every capability the node requires. */
function isExecutable(
  id: AgentAdapterId,
  required: readonly AgentCapability[],
  catalog: AgentAssignmentCatalog
): boolean {
  const descriptor = findDescriptor(id, catalog);
  if (descriptor === null) return false;
  return (
    descriptor.available &&
    descriptor.hasImplementation &&
    descriptor.supportsExecution &&
    missingCapabilities(required, descriptor).length === 0
  );
}

function missingCapabilities(
  required: readonly AgentCapability[],
  descriptor: AgentDescriptor
): readonly AgentCapability[] {
  return required.filter((capability) => !descriptor.capabilities.includes(capability));
}

function findDescriptor(
  id: AgentAdapterId,
  catalog: AgentAssignmentCatalog
): AgentDescriptor | null {
  return catalog.descriptors.find((descriptor) => descriptor.id === id) ?? null;
}
