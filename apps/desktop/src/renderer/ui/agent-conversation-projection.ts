import type { AgentConversation, AgentConversationState } from "@forgedeck/schemas";

/**
 * Maps recorded agent conversations onto the canvas edges that connect the same two nodes, so a
 * cable between two agents shows whether work was asked for and whether it came back.
 *
 * This is a pure structural match, on purpose and for the same reason the official run overlay is:
 * an edge's state comes from durable records keyed by node id, never from terminal output, a timer
 * or optimistic UI. An edge with no recorded exchange stays unstyled rather than showing "idle",
 * because "nothing was ever asked here" and "the answer is pending" must not look alike.
 */

export interface ProjectableEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface EdgeConversation {
  readonly state: AgentConversationState;
  readonly attempt: number;
}

export function projectAgentConversations(
  edges: readonly ProjectableEdge[],
  conversations: readonly AgentConversation[]
): ReadonlyMap<string, EdgeConversation> {
  const byPair = new Map<string, AgentConversation>();
  for (const conversation of conversations) {
    const key = pairKey(conversation.senderNodeId, conversation.recipientNodeId);
    const existing = byPair.get(key);
    // The store already returns one row per pair; keeping the newest here means a caller that
    // merges several sources cannot make an edge flicker between two states.
    if (existing === undefined || existing.updatedAt < conversation.updatedAt) {
      byPair.set(key, conversation);
    }
  }

  const projected = new Map<string, EdgeConversation>();
  for (const edge of edges) {
    // An edge is drawn in one direction, but a conversation can run either way along it. The edge
    // reflects whichever direction actually has an exchange; a request answered by the other side
    // is still this edge's story.
    const forward = byPair.get(pairKey(edge.source, edge.target));
    const backward = byPair.get(pairKey(edge.target, edge.source));
    const conversation = mostRecent(forward, backward);
    if (conversation !== undefined) {
      projected.set(edge.id, { state: conversation.state, attempt: conversation.attempt });
    }
  }
  return projected;
}

function mostRecent(
  first: AgentConversation | undefined,
  second: AgentConversation | undefined
): AgentConversation | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first.updatedAt >= second.updatedAt ? first : second;
}

function pairKey(senderNodeId: string, recipientNodeId: string): string {
  // Node ids are opaque and may contain any character, so the separator is length-prefixed rather
  // than a delimiter two different pairs could collide on.
  return `${String(senderNodeId.length)}:${senderNodeId}>${recipientNodeId}`;
}
