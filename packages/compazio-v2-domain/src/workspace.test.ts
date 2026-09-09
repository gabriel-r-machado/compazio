import { describe, expect, it } from "vitest";

import {
  addNoteNode,
  addFilePreviewNode,
  addFileTreeNode,
  addCanvasGroup,
  addTerminalNode,
  addVisualEdge,
  createWorkspace,
  LEGACY_COORDINATOR_FLAG,
  migrateWorkspace,
  moveNode,
  pasteCanvasSelection,
  removeNode,
  resizeNode,
  serializeWorkspace,
  type DomainDependencies
} from "./index";

function dependencies(): DomainDependencies {
  let next = 0;
  return {
    createId: () => `id_${++next}`,
    now: () => "2026-07-28T12:00:00.000Z"
  };
}

describe("Compazio V2 workspace domain", () => {
  it("creates, updates, serializes and keeps a workspace internally consistent", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addTerminalNode(workspace, { title: "Shell" }, domain);
    workspace = addNoteNode(workspace, { title: "Brief", content: "Construir algo" }, domain);
    const [terminal, note] = workspace.nodes;
    if (terminal === undefined || note === undefined) throw new Error("fixture failed");
    workspace = addVisualEdge(workspace, terminal.id, note.id, domain);
    workspace = moveNode(workspace, terminal.id, { x: 500, y: 320 }, domain);
    workspace = resizeNode(workspace, note.id, { width: 420, height: 280 }, domain);

    expect(workspace.nodes[0]?.position).toEqual({ x: 500, y: 320 });
    expect(workspace.nodes[1]?.size).toEqual({ width: 420, height: 280 });
    expect(JSON.parse(serializeWorkspace(workspace)).nodes[0].sessionId).toBeUndefined();
  });

  it("removes a node and associated edges idempotently", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addTerminalNode(workspace, {}, domain);
    workspace = addNoteNode(workspace, {}, domain);
    const [terminal, note] = workspace.nodes;
    if (terminal === undefined || note === undefined) throw new Error("fixture failed");
    workspace = addVisualEdge(workspace, terminal.id, note.id, domain);

    const deleted = removeNode(workspace, terminal.id, domain);
    expect(deleted.nodes).toHaveLength(1);
    expect(deleted.edges).toHaveLength(0);
    expect(removeNode(deleted, terminal.id, domain)).toEqual(deleted);
  });

  it("revokes a recruited worker's bridge ownership when its orchestrator is removed", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addTerminalNode(workspace, { orchestrator: true }, domain);
    const leader = workspace.nodes[0];
    if (leader?.type !== "terminal") throw new Error("leader fixture failed");
    workspace = addTerminalNode(workspace, { orchestratorOwnerNodeId: leader.id }, domain);
    const removed = removeNode(workspace, leader.id, domain);
    expect(removed.nodes[0]).toMatchObject({ type: "terminal" });
    expect(removed.nodes[0]).not.toHaveProperty("orchestratorOwnerNodeId");
  });

  it("rejects secret environment values before they can be persisted", () => {
    const domain = dependencies();
    const workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    expect(() =>
      addTerminalNode(
        workspace,
        { launchConfig: { args: [], env: { API_TOKEN: "x" }, processMode: "auto" } },
        domain
      )
    ).toThrow(/secrets/i);
  });

  it("migrates the narrow V0 shape and clears orphan connections on load", () => {
    const domain = dependencies();
    const workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    const migrated = migrateWorkspace({
      ...workspace,
      schemaVersion: 0,
      settings: undefined,
      edges: [
        {
          id: "edge_1",
          workspaceId: workspace.id,
          sourceNodeId: "missing_source",
          targetNodeId: "missing_target",
          type: "visual",
          createdAt: workspace.createdAt
        }
      ]
    });

    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.settings.viewport.zoom).toBe(1);
    expect(migrated.edges).toEqual([]);
  });

  it("migrates the v8 coordinator flag into isCompazio and drops the legacy key", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addTerminalNode(workspace, {}, domain);
    const migrated = migrateWorkspace({
      ...workspace,
      schemaVersion: 8,
      nodes: workspace.nodes.map((node) => {
        if (node.type !== "terminal") return node;
        const rest = Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "isCompazio")
        );
        return { ...rest, [LEGACY_COORDINATOR_FLAG]: true };
      })
    });

    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.nodes[0]).toMatchObject({
      type: "terminal",
      isCompazio: true,
      orchestrator: true
    });
    expect(migrated.nodes[0]).not.toHaveProperty(LEGACY_COORDINATOR_FLAG);
  });

  it("migrates Phase 2 terminals without silently granting orchestration capabilities", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addTerminalNode(workspace, {}, domain);
    workspace = addNoteNode(workspace, {}, domain);
    const [terminal, note] = workspace.nodes;
    if (terminal === undefined || note === undefined) throw new Error("fixture failed");
    workspace = addVisualEdge(workspace, terminal.id, note.id, domain);
    const phaseTwoEdge = Object.fromEntries(
      Object.entries(workspace.edges[0] ?? {}).filter(([key]) => key !== "capabilities")
    );
    const migrated = migrateWorkspace({
      ...workspace,
      schemaVersion: 2,
      nodes: workspace.nodes.map((node) => {
        if (node.type !== "terminal") return node;
        return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "orchestrator"));
      }),
      edges: [phaseTwoEdge]
    });

    expect(migrated.nodes[0]).toMatchObject({
      type: "terminal",
      isCompazio: false,
      orchestrator: false
    });
    expect(migrated.edges[0]?.capabilities).toEqual([]);
  });

  it("migrates the legacy orchestrator flag into the authoritative Compazio field", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addTerminalNode(workspace, { orchestrator: true }, domain);
    const migrated = migrateWorkspace({
      ...workspace,
      schemaVersion: 7,
      nodes: workspace.nodes.map((node) => {
        if (node.type !== "terminal") return node;
        return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "isCompazio"));
      })
    });

    expect(migrated.nodes[0]).toMatchObject({
      type: "terminal",
      isCompazio: true,
      orchestrator: true
    });
  });

  it("persists independent file trees and previews as first-class canvas nodes", () => {
    const domain = dependencies();
    let workspace = createWorkspace({ name: "Produto", workingDirectory: "C:\\produto" }, domain);
    workspace = addFileTreeNode(workspace, { title: "Projeto" }, domain);
    const tree = workspace.nodes[0];
    if (tree?.type !== "file-tree") throw new Error("tree fixture failed");
    workspace = addFilePreviewNode(
      workspace,
      { filePath: "assets/logo.png", previewKind: "image" },
      domain
    );
    expect(tree.currentPath).toBe(".");
    expect(tree.history).toEqual(["."]);
    expect(workspace.nodes[1]).toMatchObject({
      type: "file-preview",
      filePath: "assets/logo.png",
      missing: false
    });
    expect(JSON.parse(serializeWorkspace(workspace)).schemaVersion).toBe(10);
  });

  it("persists groups and copies only serializable canvas structure", () => {
    const domain = dependencies();
    let source = createWorkspace({ name: "Origem", workingDirectory: "C:\\origem" }, domain);
    source = addTerminalNode(source, { title: "Agente" }, domain);
    source = addNoteNode(source, { title: "Plano", content: "Seguro" }, domain);
    const [terminal, note] = source.nodes;
    if (terminal === undefined || note === undefined) throw new Error("fixture failed");
    source = addVisualEdge(source, terminal.id, note.id, domain);
    source = addCanvasGroup(source, { title: "Equipe", nodeIds: [terminal.id, note.id] }, domain);

    const target = createWorkspace({ name: "Destino", workingDirectory: "C:\\destino" }, domain);
    const pasted = pasteCanvasSelection(
      source,
      target,
      [terminal.id, note.id],
      { x: 800, y: 500 },
      domain
    );

    expect(pasted.nodes).toHaveLength(2);
    expect(pasted.edges).toHaveLength(1);
    expect(pasted.groups).toHaveLength(1);
    expect(pasted.nodes.find((node) => node.type === "terminal")).toMatchObject({
      workingDirectory: "C:\\destino"
    });
  });
});
