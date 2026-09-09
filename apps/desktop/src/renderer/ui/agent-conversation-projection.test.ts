import { describe, expect, it } from "vitest";

import type { AgentConversation } from "@forgedeck/schemas";

import { projectAgentConversations } from "./agent-conversation-projection";

function conversation(
  senderNodeId: string,
  recipientNodeId: string,
  state: AgentConversation["state"],
  updatedAt = "2026-07-27T12:00:00.000Z",
  attempt = 1
): AgentConversation {
  return { senderNodeId, recipientNodeId, state, attempt, updatedAt };
}

describe("projectAgentConversations", () => {
  it("marks the edge that connects the two agents actually exchanging work", () => {
    const projected = projectAgentConversations(
      [
        { id: "edge-review", source: "planner", target: "reviewer" },
        { id: "edge-unrelated", source: "planner", target: "tester" }
      ],
      [conversation("planner", "reviewer", "awaiting-response")]
    );

    expect(projected.get("edge-review")).toEqual({ state: "awaiting-response", attempt: 1 });
    // No exchange recorded here: unstyled, because "never asked" must not look like "waiting".
    expect(projected.has("edge-unrelated")).toBe(false);
  });

  it("reflects an exchange running against the direction the edge was drawn", () => {
    const projected = projectAgentConversations(
      [{ id: "edge-1", source: "planner", target: "reviewer" }],
      [conversation("reviewer", "planner", "responded")]
    );

    expect(projected.get("edge-1")?.state).toBe("responded");
  });

  it("shows the newest exchange when both directions have one", () => {
    const projected = projectAgentConversations(
      [{ id: "edge-1", source: "planner", target: "reviewer" }],
      [
        conversation("planner", "reviewer", "responded", "2026-07-27T12:00:00.000Z"),
        conversation("reviewer", "planner", "awaiting-response", "2026-07-27T12:05:00.000Z")
      ]
    );

    // The reply turned into a new question: the edge is waiting again, not still answered.
    expect(projected.get("edge-1")?.state).toBe("awaiting-response");
  });

  it("carries a failed delivery and its attempt count", () => {
    const projected = projectAgentConversations(
      [{ id: "edge-1", source: "planner", target: "reviewer" }],
      [conversation("planner", "reviewer", "failed", "2026-07-27T12:00:00.000Z", 3)]
    );

    expect(projected.get("edge-1")).toEqual({ state: "failed", attempt: 3 });
  });

  it("does not confuse two pairs whose ids could collide on a naive separator", () => {
    const projected = projectAgentConversations(
      [
        { id: "edge-a", source: "a>b", target: "c" },
        { id: "edge-b", source: "a", target: "b>c" }
      ],
      [conversation("a", "b>c", "responded")]
    );

    expect(projected.has("edge-a")).toBe(false);
    expect(projected.get("edge-b")?.state).toBe("responded");
  });

  it("projects nothing when no conversation has been recorded", () => {
    expect(
      projectAgentConversations([{ id: "edge-1", source: "planner", target: "reviewer" }], []).size
    ).toBe(0);
  });
});
