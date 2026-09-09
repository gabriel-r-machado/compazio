import { describe, expect, it } from "vitest";

import { createCanvasTemplate } from "./canvas-store";
import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";
import { organizeCanvasNodes } from "./canvas-layout";

describe("canvas visual organization", () => {
  it("places dependencies from left to right without changing node data", () => {
    const snapshot = createCanvasTemplate("bugfix");
    const nodes: ForgeFlowNode[] = snapshot.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data
    }));
    const edges: ForgeFlowEdge[] = snapshot.edges.map((edge) => ({
      id: edge.id,
      type: "contract",
      source: edge.source,
      target: edge.target,
      data: edge.contract
    }));

    const organized = organizeCanvasNodes(nodes, edges);

    expect(organized.find((node) => node.id === "agent-work")?.position.x).toBeLessThan(
      organized.find((node) => node.id === "tests-evidence")?.position.x ?? 0
    );
    expect(organized.find((node) => node.id === "tests-evidence")?.position.x).toBeLessThan(
      organized.find((node) => node.id === "human-approval")?.position.x ?? 0
    );
    expect(organized.map((node) => node.data)).toEqual(nodes.map((node) => node.data));
  });

  it("lays out disconnected nodes deterministically", () => {
    const snapshot = createCanvasTemplate("blueprint-to-pr");
    const nodes = snapshot.nodes.map((node): ForgeFlowNode => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data
    }));
    expect(organizeCanvasNodes(nodes, [])).toEqual(organizeCanvasNodes(nodes, []));
  });

  it("keeps large terminals from overlapping in the same workflow column", () => {
    const nodes: ForgeFlowNode[] = [
      terminalNode("source-a"),
      terminalNode("source-b"),
      terminalNode("target")
    ];
    const edges: ForgeFlowEdge[] = [
      edge("a-target", "source-a", "target"),
      edge("b-target", "source-b", "target")
    ];

    const organized = organizeCanvasNodes(nodes, edges);
    const sourceA = requireNode(organized, "source-a");
    const sourceB = requireNode(organized, "source-b");
    const target = requireNode(organized, "target");

    expect(sourceB.position.y).toBeGreaterThanOrEqual(sourceA.position.y + 380 + 100);
    expect(target.position.x).toBeGreaterThanOrEqual(sourceA.position.x + 560 + 100);
  });

  it("places disconnected work in a separate lane below the connected flow", () => {
    const nodes: ForgeFlowNode[] = [
      terminalNode("source"),
      terminalNode("target"),
      noteNode("note")
    ];
    const organized = organizeCanvasNodes(nodes, [edge("flow", "source", "target")]);
    const note = requireNode(organized, "note");
    const source = requireNode(organized, "source");

    expect(note.position.y).toBeGreaterThan(source.position.y + 380);
  });
});

function terminalNode(id: string): ForgeFlowNode {
  return {
    id,
    type: "terminal",
    width: 560,
    height: 380,
    position: { x: 0, y: 0 },
    data: {
      title: id,
      state: "idle",
      summary: "Terminal",
      adapterId: "shell",
      retryMaxAttempts: 1,
      permissions: []
    }
  };
}

function noteNode(id: string): ForgeFlowNode {
  return {
    id,
    type: "note",
    position: { x: 0, y: 0 },
    data: {
      title: id,
      state: "idle",
      summary: "Note",
      retryMaxAttempts: 1,
      permissions: []
    }
  };
}

function edge(id: string, source: string, target: string): ForgeFlowEdge {
  return {
    id,
    type: "contract",
    source,
    target,
    data: {
      schemaVersion: "1.0",
      kind: "dependency",
      label: "depends on",
      requiredEvidenceTypes: []
    }
  };
}

function requireNode(nodes: readonly ForgeFlowNode[], id: string): ForgeFlowNode {
  const node = nodes.find((entry) => entry.id === id);
  if (node === undefined) throw new Error(`Expected organized node ${id}`);
  return node;
}
