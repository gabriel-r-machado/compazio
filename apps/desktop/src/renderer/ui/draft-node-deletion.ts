import type { WorkflowDraft } from "@forgedeck/schemas";

/**
 * Which plan tasks a canvas deletion is really about.
 *
 * A materialized plan puts real terminals on the canvas carrying the task ids they came from.
 * Deleting one has to reach the task too, or the plan would still list work whose terminal the
 * person removed — and the next thing built from that plan would bring it back. Anything else the
 * person deleted is an ordinary canvas node and no plan's business.
 */
export function draftNodeIdsForDeletion(
  deletedNodeIds: readonly string[],
  draft: WorkflowDraft | null
): readonly string[] {
  if (draft === null) return [];
  const taskIds = new Set(draft.nodes.map((node) => node.id));
  const matched = new Set<string>();
  for (const nodeId of deletedNodeIds) {
    if (taskIds.has(nodeId)) matched.add(nodeId);
  }
  return [...matched];
}

/** Whether the plan would lose every task it has, so the person can be told before confirming. */
export function removesWholeDraft(
  draftNodeIds: readonly string[],
  draft: WorkflowDraft | null
): boolean {
  if (draft === null || draft.nodes.length === 0) return false;
  return draftNodeIds.length >= draft.nodes.length;
}
