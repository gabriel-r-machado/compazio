import { describe, expect, it } from "vitest";

import { contextMenuNodeId } from "./context-action-target";

describe("contextMenuNodeId", () => {
  it("keeps the node id from the contextmenu event when that node is already selected", () => {
    const selectedNodeIds = ["terminal-1"];
    const target = { kind: "node" as const, id: "terminal-1" };

    expect(selectedNodeIds).toContain(target.id);
    expect(contextMenuNodeId(target)).toBe("terminal-1");
  });

  it("does not route edge or multi-selection actions to a node", () => {
    expect(contextMenuNodeId({ kind: "edge", id: "edge-1" })).toBeNull();
    expect(contextMenuNodeId({ kind: "selection" })).toBeNull();
  });
});
