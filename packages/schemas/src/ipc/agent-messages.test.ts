import { describe, expect, it } from "vitest";

import { agentMessageControlRequestSchema, agentMessageInboxRequestSchema } from "./agent-messages";

describe("agent message IPC schemas", () => {
  it("accepts a bounded inbox request", () => {
    expect(
      agentMessageInboxRequestSchema.parse({
        workspaceId: "workspace-1",
        agentNodeId: "reviewer",
        limit: 50
      })
    ).toMatchObject({ agentNodeId: "reviewer", limit: 50 });
  });

  it("rejects process, path and arbitrary action fields", () => {
    expect(
      agentMessageControlRequestSchema.safeParse({
        workspaceId: "workspace-1",
        messageId: "00000000-0000-4000-8000-000000000001",
        executable: "cmd.exe",
        cwd: "C:/private"
      }).success
    ).toBe(false);
  });
});
