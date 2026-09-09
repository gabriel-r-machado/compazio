import { describe, expect, it } from "vitest";

import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";
import { copyCanvasSelection, pasteCanvasSelection } from "./canvas-clipboard";

const node = (id: string, x: number, selected: boolean): ForgeFlowNode => ({
  id,
  type: "terminal",
  position: { x, y: 40 },
  selected,
  data: { title: id, state: "idle", summary: "", retryMaxAttempts: 1, permissions: [] }
});

describe("canvas clipboard", () => {
  it("copies selected nodes, their configuration and internal connections", () => {
    const nodes = [node("a", 10, true), node("b", 110, true), node("c", 240, false)];
    const edges: ForgeFlowEdge[] = [
      { id: "ab", type: "contract", source: "a", target: "b" },
      { id: "bc", type: "contract", source: "b", target: "c" }
    ];
    const clipboard = copyCanvasSelection(nodes, edges);
    expect(clipboard?.nodes).toHaveLength(2);
    expect(clipboard?.edges).toHaveLength(1);
    if (clipboard === null) throw new Error("Expected a clipboard selection");

    let ordinal = 0;
    const pasted = pasteCanvasSelection(clipboard, { x: 500, y: 300 }, () => `${++ordinal}`);
    expect(pasted.nodes.map((entry) => entry.position)).toEqual([
      { x: 500, y: 300 },
      { x: 600, y: 300 }
    ]);
    expect(pasted.nodes.map((entry) => entry.data.title)).toEqual(["a", "b"]);
    expect(pasted.edges[0]).toMatchObject({
      source: pasted.nodes[0]?.id,
      target: pasted.nodes[1]?.id
    });
  });

  it("returns null when there is no node selection", () => {
    expect(copyCanvasSelection([node("a", 0, false)], [])).toBeNull();
  });

  it("remaps copied frame membership without preserving references to unselected nodes", () => {
    const nodes: ForgeFlowNode[] = [
      {
        id: "frame",
        type: "frame",
        position: { x: 0, y: 0 },
        selected: true,
        data: {
          title: "Frame",
          state: "idle",
          summary: "",
          frame: { memberNodeIds: ["a", "outside"] },
          retryMaxAttempts: 1,
          permissions: []
        }
      },
      node("a", 40, true),
      node("outside", 240, false)
    ];
    const clipboard = copyCanvasSelection(nodes, []);
    if (clipboard === null) throw new Error("Expected a clipboard selection");

    const pasted = pasteCanvasSelection(clipboard, { x: 400, y: 200 }, () => "new");
    const pastedFrame = pasted.nodes.find((entry) => entry.type === "frame");
    const pastedMember = pasted.nodes.find((entry) => entry.type === "terminal");
    expect(pastedFrame?.data.frame?.memberNodeIds).toEqual([pastedMember?.id]);
  });
});
