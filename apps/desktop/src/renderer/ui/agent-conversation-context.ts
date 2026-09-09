import { createContext, useContext } from "react";

import type { EdgeConversation } from "./agent-conversation-projection";

/**
 * Read-only projection of recorded agent-to-agent exchanges onto canvas edges, supplied by
 * `app.tsx` from the durable message store. It is a separate axis from the official run overlay: a
 * conversation happens on the free canvas between two terminals, while a run's edge state comes from
 * the scheduler's dependency graph. An edge can carry either, both, or neither.
 */
export const AgentConversationEdgeContext = createContext<ReadonlyMap<string, EdgeConversation>>(
  new Map()
);

export function useEdgeConversation(edgeId: string): EdgeConversation | undefined {
  return useContext(AgentConversationEdgeContext).get(edgeId);
}
