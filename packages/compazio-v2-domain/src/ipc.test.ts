import { describe, expect, it } from "vitest";

import { v2TerminalWriteRequestSchema } from "./ipc";

describe("V2 terminal write IPC", () => {
  const request = {
    workspaceId: "workspace-1",
    nodeId: "terminal-1",
    sessionId: "session-1",
    data: "\u001b[200~multiline prompt\u001b[201~"
  };

  it("accepts the bounded three-confirmation OpenCode submission", () => {
    expect(
      v2TerminalWriteRequestSchema.parse({ ...request, followingData: ["\r", "\r", "\r"] })
        .followingData
    ).toEqual(["\r", "\r", "\r"]);
  });

  it("rejects input sequences beyond the four-frame supervisor limit", () => {
    expect(() =>
      v2TerminalWriteRequestSchema.parse({
        ...request,
        followingData: ["\r", "\r", "\r", "\r"]
      })
    ).toThrow();
  });
});
