import { describe, expect, it } from "vitest";

import { ORCHESTRATOR_TEAM_PERMISSIONS, grantsTeamOrchestration } from "@forgedeck/schemas";
import type { CanvasSnapshot } from "@forgedeck/schemas";

import {
  adaptTemplateToAvailableAgents,
  createCanvasReplacement,
  createCanvasTemplate,
  toCanvasSnapshot,
  useCanvasStore
} from "./canvas-store";
import { getAddNodePreset } from "./node-presets";

describe("canvas projection store", () => {
  it("starts a new workspace empty and offers local workflow templates", () => {
    expect(createCanvasTemplate("empty").nodes).toHaveLength(0);
    expect(createCanvasTemplate("blueprint-to-pr").nodes).toHaveLength(4);
    expect(createCanvasTemplate("bugfix").edges).toHaveLength(2);
    expect(createCanvasTemplate("landing-page")).toMatchObject({
      title: "Landing Page Premium",
      creationMode: "manual",
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "landing-page-briefing", type: "note" }),
        expect.objectContaining({
          id: "lp-hero",
          type: "agent",
          data: expect.objectContaining({
            adapterId: "claude-code",
            role: expect.objectContaining({ name: "Front-end da abertura" })
          })
        }),
        expect.objectContaining({
          id: "lp-sections",
          data: expect.objectContaining({
            role: expect.objectContaining({ name: "Front-end das seções" })
          })
        })
      ])
    });
    expect(createCanvasTemplate("saas").nodes).toHaveLength(6);
    expect(createCanvasTemplate("system").edges.length).toBeGreaterThan(5);
    expect(
      adaptTemplateToAvailableAgents(createCanvasTemplate("landing-page"), ["codex"])
        .nodes.filter((node) => node.type === "agent")
        .every((node) => node.data.adapterId === "codex")
    ).toBe(true);
    expect(getAddNodePreset("git-review").data.title).toBe("Git review");
  });

  it("returns the created node id so the UI can start only its registered adapter", () => {
    useCanvasStore.getState().load(createCanvasTemplate("empty"));
    const nodeId = useCanvasStore.getState().addNode("terminal", { x: 320, y: 180 });

    expect(nodeId).toMatch(/^terminal-/);
    expect(useCanvasStore.getState().nodes).toContainEqual(
      expect.objectContaining({
        id: nodeId,
        type: "terminal",
        position: { x: 320, y: 180 },
        width: 560,
        height: 380,
        data: expect.objectContaining({ adapterId: "shell" })
      })
    );
  });

  it("gives notes a durable box that can be resized with their content", () => {
    useCanvasStore.getState().load(createCanvasTemplate("empty"));
    const nodeId = useCanvasStore.getState().addNode("note", { x: 320, y: 180 });

    expect(useCanvasStore.getState().nodes.find((node) => node.id === nodeId)).toMatchObject({
      position: { x: 320, y: 180 },
      width: 320,
      height: 220
    });

    useCanvasStore.getState().load({
      ...createCanvasTemplate("empty"),
      nodes: [
        {
          id: "legacy-note",
          type: "note",
          position: { x: 20, y: 40 },
          data: {
            title: "Legacy note",
            state: "idle",
            summary: "Persisted before dimensions were introduced",
            content: "Resize me",
            retryMaxAttempts: 1,
            permissions: []
          }
        }
      ]
    });

    expect(useCanvasStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: "legacy-note", width: 320, height: 220 })
    );
  });

  it("merges an externally spawned agent without making a clean canvas dirty", () => {
    useCanvasStore.getState().load({ ...createCanvasTemplate("empty"), revision: 4 });
    useCanvasStore.getState().mergeExternalNode(
      {
        id: "agent-spawned",
        type: "agent",
        position: { x: 160, y: 140 },
        width: 560,
        height: 380,
        data: {
          title: "qa-auth",
          state: "running",
          summary: "Spawned",
          adapterId: "codex",
          retryMaxAttempts: 1,
          permissions: []
        }
      },
      5
    );

    expect(useCanvasStore.getState()).toMatchObject({ revision: 5, dirty: false });
    expect(useCanvasStore.getState().nodes).toContainEqual(
      expect.objectContaining({
        id: "agent-spawned",
        data: expect.objectContaining({ state: "running" })
      })
    );
  });

  it("projects external connection creation and removal without making a clean canvas dirty", () => {
    useCanvasStore.getState().load({
      ...createCanvasTemplate("empty"),
      revision: 4,
      nodes: ["note-requirements", "reviewer"].map((id) => ({
        id,
        type: id === "note-requirements" ? ("note" as const) : ("agent" as const),
        position: { x: 0, y: 0 },
        data: {
          title: id,
          state: "idle" as const,
          summary: "",
          ...(id === "note-requirements" ? { content: "Requirements" } : { adapterId: "codex" }),
          retryMaxAttempts: 1,
          permissions: []
        }
      }))
    });

    useCanvasStore.getState().mergeExternalEdge(
      {
        id: "edge-context",
        source: "note-requirements",
        target: "reviewer",
        contract: {
          schemaVersion: "1.0",
          kind: "context",
          label: "Context",
          requiredEvidenceTypes: []
        }
      },
      5
    );

    expect(useCanvasStore.getState()).toMatchObject({ revision: 5, dirty: false });
    expect(useCanvasStore.getState().edges).toContainEqual(
      expect.objectContaining({
        id: "edge-context",
        source: "note-requirements",
        target: "reviewer"
      })
    );
    useCanvasStore.getState().removeExternalEdge("edge-context", 6);
    expect(useCanvasStore.getState()).toMatchObject({ revision: 6, dirty: false });
    expect(useCanvasStore.getState().edges).not.toContainEqual(
      expect.objectContaining({ id: "edge-context" })
    );
  });

  it("preserves a terminal size drafted directly on the canvas", () => {
    useCanvasStore.getState().load(createCanvasTemplate("empty"));
    const nodeId = useCanvasStore
      .getState()
      .addNode("terminal", { x: 180, y: 120 }, { width: 720, height: 440 });

    expect(useCanvasStore.getState().nodes.find((node) => node.id === nodeId)).toMatchObject({
      position: { x: 180, y: 120 },
      width: 720,
      height: 440
    });
  });

  it("persists a resized note independently from terminal sizing", () => {
    useCanvasStore.getState().load(createCanvasTemplate("empty"));
    const nodeId = useCanvasStore.getState().addNode("note", { x: 220, y: 160 });

    useCanvasStore.getState().onNodesChange([
      {
        id: nodeId,
        type: "dimensions",
        dimensions: { width: 760, height: 520 },
        resizing: false
      }
    ]);

    expect(toCanvasSnapshot(useCanvasStore.getState()).nodes[0]).toMatchObject({
      id: nodeId,
      type: "note",
      width: 760,
      height: 520
    });
  });

  it("creates a persistent visual frame around a selection and cleans removed members", () => {
    useCanvasStore.getState().load(createCanvasTemplate("empty"));
    const standaloneFrameId = useCanvasStore.getState().addNode("frame", { x: 20, y: 20 });
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === standaloneFrameId)
    ).toMatchObject({
      type: "frame",
      zIndex: -1
    });
    const firstId = useCanvasStore.getState().addNode("comment", { x: 160, y: 180 });
    const secondId = useCanvasStore.getState().addNode("diamond", { x: 520, y: 260 });

    const frameId = useCanvasStore.getState().createFrame([firstId, secondId]);
    expect(frameId).toMatch(/^frame-/);
    const frame = useCanvasStore.getState().nodes.find((node) => node.id === frameId);
    expect(frame).toMatchObject({
      type: "frame",
      zIndex: -1,
      data: { frame: { memberNodeIds: [firstId, secondId] } }
    });

    useCanvasStore.getState().removeNode(firstId);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === frameId)?.data.frame).toEqual(
      {
        memberNodeIds: [secondId]
      }
    );
    expect(
      toCanvasSnapshot(useCanvasStore.getState()).nodes.find((node) => node.id === frameId)
    ).toMatchObject({ zIndex: -1 });
  });

  it("preserves the persisted revision when replacing an existing canvas", () => {
    expect(createCanvasReplacement("empty", 12)).toMatchObject({
      id: "default",
      revision: 12,
      nodes: []
    });
  });

  it("persists and restores the mission, roles and manual delivery contract", () => {
    useCanvasStore.getState().load(createCanvasTemplate("blueprint-to-pr"));
    useCanvasStore.getState().setMission("Ship the requested feature with evidence");
    useCanvasStore.getState().updateNode("agent-work", {
      role: {
        name: "Implementer",
        responsibilities: "Implement the approved scope",
        constraints: "Keep IPC typed",
        expectedDeliverable: "Working code and tests",
        completionCriteria: "Relevant checks pass"
      }
    });
    useCanvasStore.getState().updateEdgeContract("agent-tests", {
      handoffMode: "manual",
      sourceDeliverable: "Changed files and test evidence",
      targetInstruction: "Review the evidence and run tests"
    });

    const snapshot = toCanvasSnapshot(useCanvasStore.getState());
    expect(snapshot.mission).toBe("Ship the requested feature with evidence");
    expect(snapshot.nodes.find((node) => node.id === "agent-work")?.data.role).toMatchObject({
      name: "Implementer",
      expectedDeliverable: "Working code and tests"
    });
    expect(snapshot.edges.find((edge) => edge.id === "agent-tests")?.contract).toMatchObject({
      handoffMode: "manual",
      sourceDeliverable: "Changed files and test evidence",
      targetInstruction: "Review the evidence and run tests"
    });
    useCanvasStore.getState().load(snapshot);
    expect(useCanvasStore.getState().mission).toBe("Ship the requested feature with evidence");
  });

  it("applies and serializes interactions for 40 simple nodes within the interaction budget", () => {
    const snapshot: CanvasSnapshot = {
      id: "performance",
      title: "Forty nodes",
      creationMode: "manual",
      executionProfile: "balanced",
      revision: 0,
      viewport: { x: 12, y: 24, zoom: 0.8 },
      nodes: Array.from({ length: 40 }, (_, index) => ({
        id: `node-${index}`,
        type: "task" as const,
        position: { x: (index % 8) * 240, y: Math.floor(index / 8) * 160 },
        data: {
          title: `Task ${index}`,
          state: "idle" as const,
          summary: "Simple task",
          retryMaxAttempts: 1,
          permissions: []
        }
      })),
      edges: []
    };
    const startedAt = performance.now();
    useCanvasStore.getState().load(snapshot);
    useCanvasStore.getState().onNodesChange(
      snapshot.nodes.map((node) => ({
        id: node.id,
        type: "position" as const,
        position: { x: node.position.x + 10, y: node.position.y + 10 }
      }))
    );
    const projected = toCanvasSnapshot(useCanvasStore.getState());
    const durationMs = performance.now() - startedAt;

    expect(projected.nodes).toHaveLength(40);
    expect(projected.nodes[39]?.position).toEqual({ x: 1690, y: 650 });
    expect(durationMs).toBeLessThan(250);
  });

  it("rejects duplicate and cyclic connections while preserving a valid DAG", () => {
    useCanvasStore.getState().load({
      id: "dag",
      title: "DAG",
      creationMode: "manual",
      executionProfile: "balanced",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: ["plan", "implement", "review"].map((id) => ({
        id,
        type: "task" as const,
        position: { x: 0, y: 0 },
        data: {
          title: id,
          state: "idle" as const,
          summary: "Task",
          retryMaxAttempts: 1,
          permissions: []
        }
      })),
      edges: []
    });

    const connection = (source: string, target: string) => ({
      source,
      target,
      sourceHandle: null,
      targetHandle: null
    });

    expect(useCanvasStore.getState().connect(connection("plan", "implement"))).toEqual({
      accepted: true
    });
    expect(useCanvasStore.getState().connect(connection("implement", "review"))).toEqual({
      accepted: true
    });
    expect(useCanvasStore.getState().connect(connection("review", "plan"))).toEqual({
      accepted: false,
      reason: "cycle"
    });
    expect(useCanvasStore.getState().connect(connection("plan", "implement"))).toEqual({
      accepted: false,
      reason: "duplicate_connection"
    });
    expect(useCanvasStore.getState().edges).toHaveLength(2);
  });

  it("defaults a note/attachment -> terminal connection to context, keeping dependency elsewhere", () => {
    useCanvasStore.getState().load({
      id: "context-defaults",
      title: "Context defaults",
      creationMode: "manual",
      executionProfile: "balanced",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "note-1",
          type: "note" as const,
          position: { x: 0, y: 0 },
          data: {
            title: "Nota",
            state: "idle" as const,
            summary: "",
            content: "Briefing",
            retryMaxAttempts: 1,
            permissions: []
          }
        },
        {
          id: "image-1",
          type: "image" as const,
          position: { x: 0, y: 0 },
          data: {
            title: "Foto",
            state: "idle" as const,
            summary: "",
            contextSource: { kind: "image" as const },
            retryMaxAttempts: 1,
            permissions: []
          }
        },
        {
          id: "terminal-1",
          type: "terminal" as const,
          position: { x: 0, y: 0 },
          data: {
            title: "Claude",
            state: "idle" as const,
            summary: "",
            adapterId: "claude-code",
            retryMaxAttempts: 1,
            permissions: []
          }
        },
        {
          id: "terminal-2",
          type: "terminal" as const,
          position: { x: 0, y: 0 },
          data: {
            title: "Codex",
            state: "idle" as const,
            summary: "",
            adapterId: "codex",
            retryMaxAttempts: 1,
            permissions: []
          }
        }
      ],
      edges: []
    });

    const connection = (source: string, target: string) => ({
      source,
      target,
      sourceHandle: null,
      targetHandle: null
    });

    useCanvasStore.getState().connect(connection("note-1", "terminal-1"));
    useCanvasStore.getState().connect(connection("image-1", "terminal-1"));
    useCanvasStore.getState().connect(connection("terminal-1", "terminal-2"));

    const edges = useCanvasStore.getState().edges;
    expect(edges.find((edge) => edge.source === "note-1")?.data?.kind).toBe("context");
    expect(edges.find((edge) => edge.source === "image-1")?.data?.kind).toBe("context");
    expect(edges.find((edge) => edge.source === "terminal-1")?.data?.kind).toBe("dependency");
  });

  it("duplicates and removes nodes without leaving orphan connections", () => {
    useCanvasStore.getState().load(createCanvasTemplate("blueprint-to-pr"));

    const duplicateId = useCanvasStore.getState().duplicateNode("agent-work", "Claude Code copy");

    expect(duplicateId).toMatch(/^agent-/);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === duplicateId)).toMatchObject({
      data: { title: "Claude Code copy" },
      position: { x: 468, y: 228 }
    });

    expect(useCanvasStore.getState().removeNode("agent-work")).toBe(true);
    expect(useCanvasStore.getState().edges.some((edge) => edge.source === "agent-work")).toBe(
      false
    );
    expect(useCanvasStore.getState().removeNode("missing")).toBe(false);
  });

  it("undoes and redoes canvas mutations as recoverable history", () => {
    useCanvasStore.getState().load(createCanvasTemplate("empty"));
    const nodeId = useCanvasStore.getState().addNode("terminal", { x: 120, y: 80 });
    useCanvasStore.getState().updateNode(nodeId, { title: "Configured terminal" });

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0]?.data.title).not.toBe("Configured terminal");
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it("clearWorkflow empties nodes, edges, mission and selection while keeping the same canvas", () => {
    useCanvasStore.getState().load({ ...createCanvasTemplate("bugfix"), id: "canvas-42" });
    const someNodeId = useCanvasStore.getState().nodes[0]?.id;
    expect(someNodeId).toBeDefined();
    if (someNodeId === undefined) throw new Error("unreachable");
    useCanvasStore.getState().selectNode(someNodeId);
    useCanvasStore.getState().setMission("Ship the fix");
    expect(useCanvasStore.getState().nodes.length).toBeGreaterThan(0);
    expect(useCanvasStore.getState().edges.length).toBeGreaterThan(0);

    useCanvasStore.getState().clearWorkflow();

    const state = useCanvasStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.mission).toBe("");
    expect(state.selectedNodeId).toBeNull();
    expect(state.canvasId).toBe("canvas-42");
    expect(state.dirty).toBe(true);
  });

  it("clearWorkflow empties undo/redo history so a clean graph can never be resurrected", () => {
    useCanvasStore.getState().load(createCanvasTemplate("bugfix"));
    useCanvasStore.getState().clearWorkflow();

    expect(useCanvasStore.getState().undo()).toBe(false);
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("accepts a fresh load() right after clearWorkflow with no residual state", () => {
    useCanvasStore.getState().load(createCanvasTemplate("bugfix"));
    useCanvasStore.getState().clearWorkflow();

    useCanvasStore.getState().load(createCanvasTemplate("blueprint-to-pr"));

    const state = useCanvasStore.getState();
    expect(state.nodes).toHaveLength(4);
    expect(state.dirty).toBe(false);
    expect(state.undo()).toBe(false);
  });

  it("disconnects nodes and updates or removes edge contracts explicitly", () => {
    useCanvasStore.getState().load(createCanvasTemplate("bugfix"));

    useCanvasStore.getState().updateEdgeContract("agent-tests", {
      kind: "handoff",
      label: "passar evidência"
    });
    expect(useCanvasStore.getState().edges[0]?.data).toMatchObject({
      kind: "handoff",
      label: "passar evidência"
    });
    expect(useCanvasStore.getState().disconnectNode("tests-evidence")).toBe(2);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(useCanvasStore.getState().removeEdge("missing")).toBe(false);
  });

  it("disconnects and removes a multi-selection as one recoverable action", () => {
    useCanvasStore.getState().load(createCanvasTemplate("bugfix"));

    expect(useCanvasStore.getState().disconnectNodes(["agent-work", "tests-evidence"])).toBe(2);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toHaveLength(2);

    expect(useCanvasStore.getState().removeNodes(["agent-work", "tests-evidence"])).toBe(2);
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).not.toContain("agent-work");
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it("carries granted permissions into the saved snapshot", () => {
    // The Policy Engine authorizes an agent against the permissions stored on its canvas node. If
    // this patch were dropped on the way to the snapshot, marking a terminal as the orchestrator
    // would look like it worked and every command it ran would still be denied.
    useCanvasStore.getState().load(createCanvasTemplate("bugfix"));
    useCanvasStore.getState().updateNode("agent-work", {
      permissions: [...ORCHESTRATOR_TEAM_PERMISSIONS]
    });

    const saved = toCanvasSnapshot(useCanvasStore.getState()).nodes.find(
      (node) => node.id === "agent-work"
    );
    expect(saved?.data.permissions).toEqual([...ORCHESTRATOR_TEAM_PERMISSIONS]);
    expect(grantsTeamOrchestration(saved?.data.permissions ?? [])).toBe(true);

    // Unchecking has to actually revoke, not merely stop advertising.
    useCanvasStore.getState().updateNode("agent-work", { permissions: [] });
    const revoked = toCanvasSnapshot(useCanvasStore.getState()).nodes.find(
      (node) => node.id === "agent-work"
    );
    expect(grantsTeamOrchestration(revoked?.data.permissions ?? [])).toBe(false);
  });
});
