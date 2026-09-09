import { describe, expect, it } from "vitest";

import { organizeTeam, type LayoutNode } from "./index";

const orchestrator: LayoutNode = {
  id: "orchestrator",
  kind: "orchestrator",
  position: { x: 400, y: 100 },
  size: { width: 640, height: 400 },
  manual: true
};

function agent(id: string, manual = false): LayoutNode {
  return {
    id,
    kind: "agent",
    position: { x: 0, y: 0 },
    size: { width: 320, height: 220 },
    manual
  };
}

function overlaps(left: LayoutNode, right: LayoutNode): boolean {
  return !(
    left.position.x + left.size.width <= right.position.x ||
    right.position.x + right.size.width <= left.position.x ||
    left.position.y + left.size.height <= right.position.y ||
    right.position.y + right.size.height <= left.position.y
  );
}

describe("deterministic team layout", () => {
  it.each([1, 3, 7])("lays out %i agents without overlap", (count) => {
    const agents = Array.from({ length: count }, (_, index) => agent(`agent_${index}`));
    const nodes = [orchestrator, ...agents];
    const result = organizeTeam({
      orchestratorId: orchestrator.id,
      teamNodeIds: nodes.map((node) => node.id),
      nodes
    });
    const placed = nodes.map((node) => ({
      ...node,
      position: result.positions[node.id] ?? node.position
    }));
    for (let left = 0; left < placed.length; left += 1) {
      for (let right = left + 1; right < placed.length; right += 1) {
        expect(overlaps(requireValue(placed[left]), requireValue(placed[right]))).toBe(false);
      }
    }
  });

  it("routes around unrelated existing nodes", () => {
    const existing = {
      ...agent("existing", true),
      kind: "other" as const,
      position: { x: 560, y: 572 }
    };
    const recruited = agent("recruited");
    const result = organizeTeam({
      orchestratorId: orchestrator.id,
      teamNodeIds: [orchestrator.id, recruited.id],
      nodes: [orchestrator, existing, recruited]
    });
    const placed = { ...recruited, position: requireValue(result.positions[recruited.id]) };
    expect(overlaps(existing, placed)).toBe(false);
  });

  it("preserves manual positions unless organization is explicitly forced", () => {
    const manual = { ...agent("manual", true), position: { x: 1_500, y: 800 } };
    const normal = organizeTeam({
      orchestratorId: orchestrator.id,
      teamNodeIds: [orchestrator.id, manual.id],
      nodes: [orchestrator, manual]
    });
    expect(normal.positions[manual.id]).toEqual(manual.position);
    expect(normal.preservedNodeIds).toEqual([manual.id]);

    const forced = organizeTeam({
      orchestratorId: orchestrator.id,
      teamNodeIds: [orchestrator.id, manual.id],
      nodes: [orchestrator, manual],
      force: true
    });
    expect(forced.positions[manual.id]).not.toEqual(manual.position);
  });

  it("places shared notes after the agent rows", () => {
    const note: LayoutNode = {
      id: "specification",
      kind: "note",
      position: { x: 0, y: 0 },
      size: { width: 320, height: 240 },
      manual: false
    };
    const developer = agent("developer");
    const result = organizeTeam({
      orchestratorId: orchestrator.id,
      teamNodeIds: [orchestrator.id, developer.id, note.id],
      nodes: [orchestrator, developer, note]
    });
    expect(requireValue(result.positions[note.id]).x).toBeGreaterThan(
      requireValue(result.positions[developer.id]).x
    );
  });

  it("keeps representative daily-use layouts within a bounded computation budget", () => {
    const agents = Array.from({ length: 9 }, (_, index) => agent(`member_${index}`));
    const surroundingNotes: LayoutNode[] = Array.from({ length: 20 }, (_, index) => ({
      id: `existing_note_${index}`,
      kind: "other",
      position: { x: 3_000 + (index % 5) * 380, y: Math.floor(index / 5) * 300 },
      size: { width: 320, height: 240 },
      manual: true
    }));
    const nodes = [orchestrator, ...agents, ...surroundingNotes];
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 100; iteration += 1) {
      organizeTeam({
        orchestratorId: orchestrator.id,
        teamNodeIds: [orchestrator.id, ...agents.map((node) => node.id)],
        nodes
      });
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
  });
});

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("layout fixture is incomplete");
  return value;
}
