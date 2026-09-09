import type { WorkflowDraft } from "@forgedeck/schemas";

/**
 * Turns an approved {@link WorkflowDraft} into the next batch of nodes to dispatch. Pure and
 * deterministic: given which nodes are already completed or running, it returns the nodes whose
 * dependencies are all satisfied, capped by the profile's concurrency limit. A node with no resolved
 * runtime is never dispatched (approval already blocks those). This is the scheduler's decision core;
 * actually spawning workers is a separate, side-effecting step.
 */

export interface ActivationPlanInput {
  readonly draft: WorkflowDraft;
  readonly maxConcurrentAgents: number;
  readonly completedNodeIds?: readonly string[];
  readonly runningNodeIds?: readonly string[];
}

export interface ActivationPlan {
  /** Node ids to dispatch now (bounded by the free concurrency slots). */
  readonly ready: readonly string[];
  /** Node ids still waiting on an unmet dependency. */
  readonly blocked: readonly string[];
  /** True when every node is completed. */
  readonly done: boolean;
}

export function planActivation(input: ActivationPlanInput): ActivationPlan {
  const completed = new Set(input.completedNodeIds ?? []);
  const running = new Set(input.runningNodeIds ?? []);
  // Every edge is a prerequisite: the target waits until the source completes (handoff/dependency chain).
  const predecessors = new Map<string, string[]>();
  for (const node of input.draft.nodes) {
    predecessors.set(node.id, []);
  }
  for (const edge of input.draft.edges) {
    predecessors.get(edge.targetNodeId)?.push(edge.sourceNodeId);
  }

  const ready: string[] = [];
  const blocked: string[] = [];
  const freeSlots = Math.max(0, input.maxConcurrentAgents - running.size);

  for (const node of input.draft.nodes) {
    if (completed.has(node.id) || running.has(node.id)) {
      continue;
    }
    const deps = predecessors.get(node.id) ?? [];
    const depsMet = deps.every((dep) => completed.has(dep));
    const runnable = node.runtimeRequirement.resolvedRuntimeId !== null;
    if (depsMet && runnable) {
      ready.push(node.id);
    } else {
      blocked.push(node.id);
    }
  }

  return {
    ready: ready.slice(0, freeSlots),
    blocked,
    done: input.draft.nodes.length > 0 && input.draft.nodes.every((node) => completed.has(node.id))
  };
}
