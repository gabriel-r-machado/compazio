import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Connection, Edge, EdgeChange, Node, NodeChange, Viewport } from "@xyflow/react";
import { create } from "zustand";

import type {
  AgentAdapterId,
  CanvasNodeData,
  CanvasNodeType,
  CanvasSnapshot,
  CreationMode,
  EdgeContract,
  ExecutionProfile
} from "@forgedeck/schemas";
import { DEFAULT_CREATION_MODE, DEFAULT_EXECUTION_PROFILE } from "@forgedeck/schemas";

import { getAddNodePreset } from "./node-presets";
import type { AddNodeKind } from "./node-presets";

export type ForgeFlowNode = Node<CanvasNodeData, CanvasNodeType>;
export type ForgeFlowEdge = Edge<EdgeContract, "contract">;
export type CanvasTemplateId =
  "empty" | "blueprint-to-pr" | "bugfix" | "landing-page" | "saas" | "system";
export type CanvasConnectionResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "self_connection" | "missing_node" | "duplicate_connection" | "cycle";
    };

interface CanvasState {
  canvasId: string;
  title: string;
  mission: string;
  creationMode: CreationMode;
  executionProfile: ExecutionProfile;
  revision: number;
  viewport: Viewport;
  nodes: ForgeFlowNode[];
  edges: ForgeFlowEdge[];
  selectedNodeId: string | null;
  loaded: boolean;
  dirty: boolean;
  changeVersion: number;
  saveError: string | null;
  paletteOpen: boolean;
  historyPast: CanvasHistoryFrame[];
  historyFuture: CanvasHistoryFrame[];
  historyGroup: "node-drag" | "node-resize" | null;
  load(snapshot: CanvasSnapshot, dirty?: boolean): void;
  /** Empties the current canvas (same canvasId/title) — nodes, edges, mission, selection and
   * undo/redo history — and marks it dirty so the existing autosave persists the empty state. */
  clearWorkflow(): void;
  mergeExternalNode(node: CanvasSnapshot["nodes"][number], canvasRevision: number): void;
  mergeExternalEdge(edge: CanvasSnapshot["edges"][number], canvasRevision: number): void;
  removeExternalEdge(edgeId: string, canvasRevision: number): void;
  /** Drops a node the runtime removed, together with every edge that touched it. */
  removeExternalNode(nodeId: string, canvasRevision: number): void;
  onNodesChange(changes: NodeChange<ForgeFlowNode>[]): void;
  onEdgesChange(changes: EdgeChange<ForgeFlowEdge>[]): void;
  connect(connection: Connection): CanvasConnectionResult;
  addNode(
    kind: AddNodeKind,
    position?: { x: number; y: number },
    size?: { width: number; height: number }
  ): string;
  createFrame(memberNodeIds: readonly string[]): string | null;
  duplicateNode(id: string, title: string): string | null;
  removeNode(id: string): boolean;
  removeNodes(ids: readonly string[]): number;
  disconnectNode(id: string): number;
  disconnectNodes(ids: readonly string[]): number;
  removeEdge(id: string): boolean;
  updateEdgeContract(id: string, patch: Partial<EdgeContract>): void;
  updateNode(id: string, patch: Partial<CanvasNodeData>): void;
  setMission(mission: string): void;
  setCreationMode(mode: CreationMode): void;
  setExecutionProfile(profile: ExecutionProfile): void;
  /** Replaces the projected draft ghost nodes/edges with a fresh projection; never marks dirty. */
  insertGraph(nodes: ForgeFlowNode[], edges: ForgeFlowEdge[]): void;
  undo(): boolean;
  redo(): boolean;
  selectNode(id: string | null): void;
  setViewport(viewport: Viewport): void;
  setPaletteOpen(open: boolean): void;
  markSaved(changeVersion: number, revision: number): void;
  setSaveError(message: string | null): void;
}

interface CanvasHistoryFrame {
  readonly mission: string;
  readonly nodes: ForgeFlowNode[];
  readonly edges: ForgeFlowEdge[];
}

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1 };
const terminalNodeSize = { width: 560, height: 380 } as const;
const noteNodeSize = { width: 320, height: 220 } as const;
const contextNodeSize = { width: 340, height: 240 } as const;
const historyLimit = 60;

export const useCanvasStore = create<CanvasState>((set, get) => ({
  canvasId: "default",
  title: "Local workflow",
  mission: "",
  creationMode: DEFAULT_CREATION_MODE,
  executionProfile: DEFAULT_EXECUTION_PROFILE,
  revision: 0,
  viewport: defaultViewport,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  loaded: false,
  dirty: false,
  changeVersion: 0,
  saveError: null,
  paletteOpen: false,
  historyPast: [],
  historyFuture: [],
  historyGroup: null,

  load: (snapshot, dirty = false) =>
    set({
      canvasId: snapshot.id,
      title: snapshot.title,
      mission: snapshot.mission ?? "",
      creationMode: snapshot.creationMode,
      executionProfile: snapshot.executionProfile,
      revision: snapshot.revision,
      viewport: snapshot.viewport,
      nodes: snapshot.nodes.map((node) => {
        const defaultSize = defaultCanvasNodeSize(node.type, node.data.adapterId);
        return {
          id: node.id,
          type: node.type,
          position: node.position,
          ...(node.width === undefined
            ? defaultSize === undefined
              ? {}
              : { width: defaultSize.width }
            : { width: node.width }),
          ...(node.height === undefined
            ? defaultSize === undefined
              ? {}
              : { height: defaultSize.height }
            : { height: node.height }),
          ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
          data: node.data
        };
      }),
      edges: snapshot.edges.map((edge) => ({
        id: edge.id,
        type: "contract",
        source: edge.source,
        target: edge.target,
        data: edge.contract
      })),
      loaded: true,
      dirty,
      changeVersion: dirty ? 1 : 0,
      saveError: null,
      historyPast: [],
      historyFuture: [],
      historyGroup: null
    }),

  clearWorkflow: () =>
    set((state) => ({
      nodes: [],
      edges: [],
      mission: "",
      selectedNodeId: null,
      dirty: true,
      changeVersion: state.changeVersion + 1,
      historyPast: [],
      historyFuture: [],
      historyGroup: null,
      saveError: null
    })),

  mergeExternalNode: (node, canvasRevision) =>
    set((state) => {
      const defaultSize = defaultCanvasNodeSize(node.type, node.data.adapterId);
      const flowNode: ForgeFlowNode = {
        id: node.id,
        type: node.type,
        position: node.position,
        ...(node.width === undefined
          ? defaultSize === undefined
            ? {}
            : { width: defaultSize.width }
          : { width: node.width }),
        ...(node.height === undefined
          ? defaultSize === undefined
            ? {}
            : { height: defaultSize.height }
          : { height: node.height }),
        ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
        data: node.data
      };
      const existing = state.nodes.some((entry) => entry.id === node.id);
      return {
        nodes: existing
          ? state.nodes.map((entry) => (entry.id === node.id ? flowNode : entry))
          : [...state.nodes, flowNode],
        revision: Math.max(state.revision, canvasRevision),
        changeVersion: state.dirty ? state.changeVersion + 1 : state.changeVersion,
        saveError: null
      };
    }),

  mergeExternalEdge: (edge, canvasRevision) =>
    set((state) => {
      const flowEdge: ForgeFlowEdge = {
        id: edge.id,
        type: "contract",
        source: edge.source,
        target: edge.target,
        data: edge.contract
      };
      const existing = state.edges.some((entry) => entry.id === edge.id);
      return {
        edges: existing
          ? state.edges.map((entry) => (entry.id === edge.id ? flowEdge : entry))
          : [...state.edges, flowEdge],
        revision: Math.max(state.revision, canvasRevision),
        changeVersion: state.dirty ? state.changeVersion + 1 : state.changeVersion,
        saveError: null
      };
    }),

  removeExternalEdge: (edgeId, canvasRevision) =>
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      revision: Math.max(state.revision, canvasRevision),
      changeVersion: state.dirty ? state.changeVersion + 1 : state.changeVersion,
      saveError: null
    })),

  removeExternalNode: (nodeId, canvasRevision) =>
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      // The store already deleted these; dropping them here too keeps the canvas from rendering a
      // cable to a node that is gone until the next reload.
      edges: state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      revision: Math.max(state.revision, canvasRevision),
      changeVersion: state.dirty ? state.changeVersion + 1 : state.changeVersion,
      saveError: null
    })),

  onNodesChange: (changes) => {
    const persistentChange = changes.some((change) => change.type !== "select");
    set((state) => {
      const group = nodeChangeHistoryGroup(changes);
      const continuingGroup =
        (group !== null && state.historyGroup === group) ||
        finishesNodeHistoryGroup(changes, state.historyGroup);
      return {
        nodes: applyPersistentNodeChanges(changes, state.nodes),
        ...(persistentChange
          ? {
              ...recordHistory(state, !continuingGroup),
              dirty: true,
              changeVersion: state.changeVersion + 1,
              historyGroup: group
            }
          : {})
      };
    });
  },

  onEdgesChange: (changes) => {
    const persistentChange = changes.some((change) => change.type !== "select");
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      ...(persistentChange
        ? {
            ...recordHistory(state),
            dirty: true,
            changeVersion: state.changeVersion + 1,
            historyGroup: null
          }
        : {})
    }));
  },

  connect: (connection) => {
    if (
      connection.source === null ||
      connection.target === null ||
      connection.source === connection.target
    ) {
      return { accepted: false, reason: "self_connection" };
    }
    const state = get();
    if (
      !state.nodes.some((node) => node.id === connection.source) ||
      !state.nodes.some((node) => node.id === connection.target)
    ) {
      return { accepted: false, reason: "missing_node" };
    }
    if (
      state.edges.some(
        (edge) => edge.source === connection.source && edge.target === connection.target
      )
    ) {
      return { accepted: false, reason: "duplicate_connection" };
    }
    if (wouldCreateCycle(state.edges, connection.source, connection.target)) {
      return { accepted: false, reason: "cycle" };
    }
    const sourceType = state.nodes.find((node) => node.id === connection.source)?.type;
    const targetNode = state.nodes.find((node) => node.id === connection.target);
    // A note/artifact/context-source feeding a terminal is context by default — the process
    // reading it needs the material, not just an ordering hint. Anything else (e.g. terminal ->
    // terminal) keeps today's plain sequencing default.
    const isMaterialSource =
      sourceType !== undefined &&
      (sourceType === "note" || sourceType === "artifact" || isContextSourceType(sourceType));
    const isTerminalTarget =
      targetNode?.type !== undefined &&
      isTerminalCanvasNode(targetNode.type, targetNode.data.adapterId);
    const contract: EdgeContract =
      isMaterialSource && isTerminalTarget
        ? { schemaVersion: "1.0", kind: "context", label: "context", requiredEvidenceTypes: [] }
        : {
            schemaVersion: "1.0",
            kind: "dependency",
            label: "depends on",
            requiredEvidenceTypes: []
          };
    set({
      ...recordHistory(state),
      edges: addEdge(
        {
          ...connection,
          id: `edge-${crypto.randomUUID()}`,
          type: "contract",
          data: contract
        },
        state.edges
      ),
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return { accepted: true };
  },

  addNode: (kind, position, size) => {
    const state = get();
    const preset = getAddNodePreset(kind);
    const id = `${preset.nodeType}-${crypto.randomUUID()}`;
    const offset = state.nodes.length * 32;
    const node: ForgeFlowNode = {
      id,
      type: preset.nodeType,
      position: position ?? { x: 160 + (offset % 480), y: 140 + (offset % 320) },
      ...(size ?? defaultCanvasNodeSize(preset.nodeType, preset.data.adapterId)),
      ...(preset.nodeType === "frame" ? { zIndex: -1 } : {}),
      data: preset.data
    };
    set({
      ...recordHistory(state),
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      dirty: true,
      changeVersion: state.changeVersion + 1,
      paletteOpen: false
    });
    return id;
  },

  createFrame: (memberNodeIds) => {
    const state = get();
    const memberIds = [...new Set(memberNodeIds)].filter((id) => {
      const node = state.nodes.find((candidate) => candidate.id === id);
      return node !== undefined && node.type !== "frame";
    });
    if (memberIds.length < 2) return null;
    const members = state.nodes.filter((node) => memberIds.includes(node.id));
    const bounds = nodesBounds(members);
    const id = `frame-${crypto.randomUUID()}`;
    const node: ForgeFlowNode = {
      id,
      type: "frame",
      position: { x: bounds.x - 28, y: bounds.y - 44 },
      width: Math.max(280, bounds.width + 56),
      height: Math.max(180, bounds.height + 72),
      zIndex: -1,
      data: {
        title: "Group",
        state: "idle",
        summary: `${memberIds.length} grouped items`,
        frame: { memberNodeIds: memberIds },
        retryMaxAttempts: 1,
        permissions: []
      }
    };
    set({
      ...recordHistory(state),
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return id;
  },

  duplicateNode: (id, title) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === id);
    if (source === undefined) {
      return null;
    }
    const duplicateId = `${source.type ?? "task"}-${crypto.randomUUID()}`;
    const duplicate: ForgeFlowNode = {
      ...source,
      id: duplicateId,
      position: { x: source.position.x + 48, y: source.position.y + 48 },
      selected: true,
      data: { ...source.data, title }
    };
    set({
      ...recordHistory(state),
      nodes: [
        ...state.nodes.map((node) => (node.id === id ? { ...node, selected: false } : node)),
        duplicate
      ],
      selectedNodeId: duplicateId,
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return duplicateId;
  },

  removeNode: (id) => {
    const state = get();
    if (!state.nodes.some((node) => node.id === id)) {
      return false;
    }
    set({
      ...recordHistory(state),
      nodes: removeFrameMembers(state.nodes, new Set([id])),
      edges: state.edges.filter((edge) => edge.source !== id && edge.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return true;
  },

  removeNodes: (ids) => {
    const state = get();
    const targets = new Set(ids);
    const removed = state.nodes.filter((node) => targets.has(node.id)).length;
    if (removed === 0) return 0;
    set({
      ...recordHistory(state),
      nodes: removeFrameMembers(state.nodes, targets),
      edges: state.edges.filter((edge) => !targets.has(edge.source) && !targets.has(edge.target)),
      selectedNodeId:
        state.selectedNodeId !== null && targets.has(state.selectedNodeId)
          ? null
          : state.selectedNodeId,
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return removed;
  },

  disconnectNode: (id) => {
    const state = get();
    const edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id);
    const removed = state.edges.length - edges.length;
    if (removed > 0) {
      set({
        ...recordHistory(state),
        edges,
        dirty: true,
        changeVersion: state.changeVersion + 1
      });
    }
    return removed;
  },

  disconnectNodes: (ids) => {
    const state = get();
    const targets = new Set(ids);
    const edges = state.edges.filter(
      (edge) => !targets.has(edge.source) && !targets.has(edge.target)
    );
    const removed = state.edges.length - edges.length;
    if (removed > 0) {
      set({
        ...recordHistory(state),
        edges,
        dirty: true,
        changeVersion: state.changeVersion + 1
      });
    }
    return removed;
  },

  removeEdge: (id) => {
    const state = get();
    if (!state.edges.some((edge) => edge.id === id)) {
      return false;
    }
    set({
      ...recordHistory(state),
      edges: state.edges.filter((edge) => edge.id !== id),
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return true;
  },

  updateEdgeContract: (id, patch) =>
    set((state) => ({
      ...recordHistory(state),
      edges: state.edges.map((edge) =>
        edge.id === id
          ? {
              ...edge,
              data: {
                schemaVersion: "1.0",
                kind: edge.data?.kind ?? "dependency",
                label: edge.data?.label ?? "",
                requiredEvidenceTypes: edge.data?.requiredEvidenceTypes ?? [],
                ...patch
              }
            }
          : edge
      ),
      dirty: true,
      changeVersion: state.changeVersion + 1
    })),

  updateNode: (id, patch) =>
    set((state) => ({
      ...recordHistory(state),
      nodes: state.nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
      ),
      dirty: true,
      changeVersion: state.changeVersion + 1
    })),

  setMission: (mission) =>
    set((state) => ({
      ...recordHistory(state),
      mission,
      dirty: true,
      changeVersion: state.changeVersion + 1
    })),

  // The two header controls persist with the canvas. They are orthogonal to the graph, so they do
  // not enter the undo history; changing them only marks the canvas dirty so it is saved.
  setCreationMode: (creationMode) =>
    set((state) =>
      state.creationMode === creationMode
        ? {}
        : { creationMode, dirty: true, changeVersion: state.changeVersion + 1 }
    ),

  setExecutionProfile: (executionProfile) =>
    set((state) =>
      state.executionProfile === executionProfile
        ? {}
        : { executionProfile, dirty: true, changeVersion: state.changeVersion + 1 }
    ),

  // Projected draft nodes are a read-only view of the persisted WorkflowDraft, so this replaces the
  // ghost layer wholesale without touching history, dirty state or the change version. Real canvas
  // nodes and edges are preserved untouched.
  insertGraph: (nodes, edges) =>
    set((state) => ({
      ...recordHistory(state),
      nodes: [
        ...state.nodes.map((node) => ({ ...node, selected: false })),
        ...nodes.map((node) => ({ ...node, selected: true }))
      ],
      edges: [...state.edges, ...edges],
      selectedNodeId: nodes.at(-1)?.id ?? state.selectedNodeId,
      dirty: true,
      changeVersion: state.changeVersion + 1,
      paletteOpen: false
    })),

  undo: () => {
    const state = get();
    const frame = state.historyPast.at(-1);
    if (frame === undefined) return false;
    set({
      mission: frame.mission,
      nodes: cloneNodes(frame.nodes),
      edges: cloneEdges(frame.edges),
      selectedNodeId: null,
      historyPast: state.historyPast.slice(0, -1),
      historyFuture: [createHistoryFrame(state), ...state.historyFuture].slice(0, historyLimit),
      historyGroup: null,
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return true;
  },

  redo: () => {
    const state = get();
    const frame = state.historyFuture[0];
    if (frame === undefined) return false;
    set({
      mission: frame.mission,
      nodes: cloneNodes(frame.nodes),
      edges: cloneEdges(frame.edges),
      selectedNodeId: null,
      historyPast: [...state.historyPast, createHistoryFrame(state)].slice(-historyLimit),
      historyFuture: state.historyFuture.slice(1),
      historyGroup: null,
      dirty: true,
      changeVersion: state.changeVersion + 1
    });
    return true;
  },

  selectNode: (id) => set({ selectedNodeId: id }),

  setViewport: (viewport) =>
    set((state) => ({
      viewport,
      dirty: true,
      changeVersion: state.changeVersion + 1
    })),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  markSaved: (changeVersion, revision) =>
    set((state) => ({
      revision,
      dirty: state.changeVersion !== changeVersion,
      saveError: null
    })),

  setSaveError: (message) => set({ saveError: message })
}));

function recordHistory(
  state: Pick<CanvasState, "mission" | "nodes" | "edges" | "historyPast" | "historyFuture">,
  record = true
): Pick<CanvasState, "historyPast" | "historyFuture"> {
  if (!record) {
    return { historyPast: state.historyPast, historyFuture: state.historyFuture };
  }
  return {
    historyPast: [...state.historyPast, createHistoryFrame(state)].slice(-historyLimit),
    historyFuture: []
  };
}

function createHistoryFrame(
  state: Pick<CanvasState, "mission" | "nodes" | "edges">
): CanvasHistoryFrame {
  return { mission: state.mission, nodes: cloneNodes(state.nodes), edges: cloneEdges(state.edges) };
}

function cloneNodes(nodes: readonly ForgeFlowNode[]): ForgeFlowNode[] {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: structuredClone(node.data)
  }));
}

function cloneEdges(edges: readonly ForgeFlowEdge[]): ForgeFlowEdge[] {
  return edges.map((edge) => ({
    ...edge,
    ...(edge.data === undefined ? {} : { data: structuredClone(edge.data) })
  }));
}

function nodeChangeHistoryGroup(
  changes: readonly NodeChange<ForgeFlowNode>[]
): CanvasState["historyGroup"] {
  if (changes.some((change) => change.type === "position" && change.dragging === true)) {
    return "node-drag";
  }
  if (changes.some((change) => change.type === "dimensions" && change.resizing === true)) {
    return "node-resize";
  }
  return null;
}

function finishesNodeHistoryGroup(
  changes: readonly NodeChange<ForgeFlowNode>[],
  group: CanvasState["historyGroup"]
): boolean {
  if (group === "node-drag") {
    return changes.some((change) => change.type === "position" && change.dragging === false);
  }
  if (group === "node-resize") {
    return changes.some((change) => change.type === "dimensions" && change.resizing === false);
  }
  return false;
}

function applyPersistentNodeChanges(
  changes: NodeChange<ForgeFlowNode>[],
  nodes: ForgeFlowNode[]
): ForgeFlowNode[] {
  const dimensions = new Map<string, { readonly width: number; readonly height: number }>();
  for (const change of changes) {
    if (change.type === "dimensions" && change.dimensions !== undefined) {
      dimensions.set(change.id, change.dimensions);
    }
  }
  return applyNodeChanges(changes, nodes).map((node) => {
    const size = dimensions.get(node.id);
    return size === undefined ? node : { ...node, width: size.width, height: size.height };
  });
}

export function toCanvasSnapshot(state: CanvasState): CanvasSnapshot {
  // Every node on the canvas is real and is saved. This used to skip nodes whose `lifecycle` said
  // "draft"/"configured", which meant a node could be visible and never persisted — the same trap
  // that made deleted terminals reappear. A label is not what decides whether something exists.
  const persistentNodes = state.nodes;
  const persistentNodeIds = new Set(persistentNodes.map((node) => node.id));
  return {
    id: state.canvasId,
    title: state.title,
    ...(state.mission.length === 0 ? {} : { mission: state.mission }),
    creationMode: state.creationMode,
    executionProfile: state.executionProfile,
    revision: state.revision,
    viewport: state.viewport,
    nodes: persistentNodes.map((node) => ({
      id: node.id,
      type: node.type ?? "task",
      position: node.position,
      ...(node.width === undefined ? {} : { width: node.width }),
      ...(node.height === undefined ? {} : { height: node.height }),
      ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
      data: node.data
    })),
    edges: state.edges
      .filter((edge) => persistentNodeIds.has(edge.source) && persistentNodeIds.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        contract:
          edge.data ??
          ({
            schemaVersion: "1.0",
            kind: "dependency",
            label: "",
            requiredEvidenceTypes: []
          } satisfies EdgeContract)
      }))
  };
}

export function createDefaultCanvas(): CanvasSnapshot {
  return createCanvasTemplate("empty");
}

export function createCanvasReplacement(
  templateId: CanvasTemplateId,
  revision: number
): CanvasSnapshot {
  return { ...createCanvasTemplate(templateId), revision };
}

/** Keeps a template runnable on machines where only part of the suggested mixed team is available. */
export function adaptTemplateToAvailableAgents(
  snapshot: CanvasSnapshot,
  availableAdapters: readonly AgentAdapterId[]
): CanvasSnapshot {
  if (availableAdapters.length === 0) return snapshot;
  let replacementOrdinal = 0;
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      if (node.type !== "agent") return node;
      const current = node.data.adapterId as AgentAdapterId | undefined;
      if (current !== undefined && availableAdapters.includes(current)) return node;
      const adapterId = availableAdapters[replacementOrdinal % availableAdapters.length];
      replacementOrdinal += 1;
      return adapterId === undefined ? node : { ...node, data: { ...node.data, adapterId } };
    })
  };
}

export function createCanvasTemplate(templateId: CanvasTemplateId): CanvasSnapshot {
  if (templateId === "empty") {
    return {
      id: "default",
      title: "Untitled workspace",
      creationMode: DEFAULT_CREATION_MODE,
      executionProfile: DEFAULT_EXECUTION_PROFILE,
      revision: 0,
      viewport: defaultViewport,
      nodes: [],
      edges: []
    };
  }

  if (templateId === "landing-page" || templateId === "saas" || templateId === "system") {
    return createProductTemplate(templateId);
  }

  const isBlueprint = templateId === "blueprint-to-pr";
  const nodes: CanvasSnapshot["nodes"] = [
    {
      id: "terminal-start",
      type: "terminal" as const,
      position: { x: 100, y: 180 },
      data: {
        ...defaultNodeData("terminal"),
        title: isBlueprint ? "Explore the project" : "Investigate the issue",
        summary: "Connect a local terminal to begin."
      }
    },
    {
      id: "agent-work",
      type: "agent" as const,
      position: { x: 420, y: 180 },
      data: {
        ...defaultNodeData("agent"),
        title: isBlueprint ? "Claude Code" : "Codex",
        summary: "Ready to connect to this workspace.",
        adapterId: isBlueprint ? "claude-code" : "codex"
      }
    },
    {
      id: "tests-evidence",
      type: "task" as const,
      position: { x: 740, y: 180 },
      data: {
        ...defaultNodeData("task"),
        title: "Tests",
        summary: "Capture test evidence before completion."
      }
    },
    {
      id: "human-approval",
      type: "gate" as const,
      position: { x: 1060, y: 180 },
      data: {
        ...defaultNodeData("gate"),
        title: "Approval",
        summary: "A person approves the next step.",
        state: "blocked"
      }
    }
  ];

  return {
    id: "default",
    title: isBlueprint ? "Blueprint to PR" : "Bugfix",
    creationMode: DEFAULT_CREATION_MODE,
    executionProfile: DEFAULT_EXECUTION_PROFILE,
    revision: 0,
    viewport: defaultViewport,
    nodes,
    edges: [
      {
        id: "agent-tests",
        source: "agent-work",
        target: "tests-evidence",
        contract: {
          schemaVersion: "1.0",
          kind: "dependency",
          label: "run tests",
          requiredEvidenceTypes: ["test"]
        }
      },
      {
        id: "tests-approval",
        source: "tests-evidence",
        target: "human-approval",
        contract: {
          schemaVersion: "1.0",
          kind: "approval",
          label: "review evidence",
          requiredEvidenceTypes: ["test", "approval"]
        }
      }
    ]
  };
}

type ProductTemplateId = Extract<CanvasTemplateId, "landing-page" | "saas" | "system">;

interface ProductTemplateAgent {
  readonly id: string;
  readonly title: string;
  readonly adapterId: "claude-code" | "codex" | "opencode";
  readonly position: { readonly x: number; readonly y: number };
  readonly role: {
    readonly name: string;
    readonly responsibilities: string;
    readonly constraints: string;
    readonly expectedDeliverable: string;
    readonly completionCriteria: string;
  };
}

function createProductTemplate(templateId: ProductTemplateId): CanvasSnapshot {
  const definitions = productTemplateDefinition(templateId);
  const briefingId = `${templateId}-briefing`;
  const nodes: CanvasSnapshot["nodes"] = [
    {
      id: briefingId,
      type: "note",
      position: { x: 80, y: 230 },
      width: 300,
      height: 300,
      data: {
        ...defaultNodeData("note"),
        title: definitions.briefingTitle,
        summary: "Preencha este briefing uma vez; os agentes conectados recebem o mesmo contexto.",
        content: definitions.briefing
      }
    },
    ...definitions.agents.map((agent): CanvasSnapshot["nodes"][number] => ({
      id: agent.id,
      type: "agent",
      position: agent.position,
      width: 280,
      height: 240,
      data: {
        ...defaultNodeData("agent"),
        title: agent.title,
        summary: agent.role.expectedDeliverable,
        adapterId: agent.adapterId,
        role: agent.role
      }
    }))
  ];
  const edges: CanvasSnapshot["edges"] = [
    ...definitions.contextTargets.map((target) =>
      templateEdge(
        `${briefingId}-${target}`,
        briefingId,
        target,
        "context",
        "usar briefing compartilhado"
      )
    ),
    ...definitions.handoffs.map(([source, target, label]) =>
      templateEdge(`${source}-${target}`, source, target, "handoff", label)
    )
  ];
  return {
    id: "default",
    title: definitions.title,
    mission: definitions.mission,
    creationMode: "manual",
    executionProfile: DEFAULT_EXECUTION_PROFILE,
    revision: 0,
    viewport: { x: 30, y: 80, zoom: 0.72 },
    nodes,
    edges
  };
}

function productTemplateDefinition(templateId: ProductTemplateId): {
  readonly title: string;
  readonly mission: string;
  readonly briefingTitle: string;
  readonly briefing: string;
  readonly agents: readonly ProductTemplateAgent[];
  readonly contextTargets: readonly string[];
  readonly handoffs: readonly (readonly [string, string, string])[];
} {
  if (templateId === "landing-page") {
    return {
      title: "Landing Page Premium",
      mission:
        "Criar uma landing page premium, original, responsiva e orientada à conversão usando o briefing conectado.",
      briefingTitle: "Briefing da landing page",
      briefing:
        "# Preencha antes de iniciar\n\nProduto/serviço:\nPúblico:\nOferta principal:\nProvas disponíveis:\nCTA:\nReferências visuais:\nRestrições:\n",
      agents: [
        templateAgent(
          "lp-strategy",
          "Estratégia e oferta",
          "claude-code",
          430,
          80,
          "Estrategista",
          "Definir proposta, jornada, hierarquia e mensagem central.",
          "Não implementar componentes.",
          "Mapa de conversão e arquitetura da página.",
          "Cada seção tem objetivo e CTA definidos."
        ),
        templateAgent(
          "lp-copy",
          "Copy e prova",
          "codex",
          750,
          80,
          "Copywriter",
          "Escrever headline, benefícios, objeções, provas e CTAs com base no briefing.",
          "Não inventar números, depoimentos ou credenciais.",
          "Copy final organizada por seção.",
          "Texto específico, verificável e sem placeholders genéricos."
        ),
        templateAgent(
          "lp-art",
          "Direção visual",
          "opencode",
          430,
          390,
          "Diretor visual",
          "Definir linguagem visual, composição, tipografia, cores e comportamento responsivo.",
          "Preservar acessibilidade e a stack existente.",
          "Sistema visual aplicável pelos implementadores.",
          "Decisões visuais claras para desktop e mobile."
        ),
        templateAgent(
          "lp-hero",
          "Hero e primeira dobra",
          "claude-code",
          780,
          350,
          "Front-end da abertura",
          "Implementar hero, navegação, CTA principal e primeira dobra.",
          "Editar somente as seções sob sua responsabilidade.",
          "Abertura premium responsiva integrada ao projeto.",
          "Sem overflow, CTA funcional e leitura forte em mobile."
        ),
        templateAgent(
          "lp-sections",
          "Seções, prova e fechamento",
          "opencode",
          1110,
          350,
          "Front-end das seções",
          "Implementar benefícios, prova, FAQ, CTA final e footer.",
          "Não alterar o hero sem registrar necessidade no handoff.",
          "Corpo e fechamento completos e responsivos.",
          "Seções coerentes entre si e integradas à direção visual."
        ),
        templateAgent(
          "lp-review",
          "Integração e revisão final",
          "codex",
          1430,
          215,
          "Revisor e QA",
          "Integrar as seções, revisar conversão, acessibilidade, responsividade e acabamento.",
          "Não aceitar entrega apenas por aparência; validar o projeto executável.",
          "Landing page integrada com evidências de validação.",
          "Build e verificações disponíveis passam sem regressões."
        )
      ],
      contextTargets: ["lp-strategy", "lp-copy", "lp-art"],
      handoffs: [
        ["lp-strategy", "lp-copy", "estratégia aprovada"],
        ["lp-strategy", "lp-art", "hierarquia e jornada"],
        ["lp-copy", "lp-hero", "copy da abertura"],
        ["lp-art", "lp-hero", "sistema visual"],
        ["lp-copy", "lp-sections", "copy das seções"],
        ["lp-art", "lp-sections", "sistema visual"],
        ["lp-hero", "lp-review", "abertura implementada"],
        ["lp-sections", "lp-review", "seções implementadas"]
      ]
    };
  }
  if (templateId === "saas") {
    return {
      title: "SaaS completo",
      mission:
        "Construir um SaaS sólido a partir do briefing, dividindo produto, experiência, front-end, back-end e qualidade.",
      briefingTitle: "Briefing do SaaS",
      briefing:
        "# Preencha antes de iniciar\n\nProblema:\nUsuários:\nFluxo principal:\nRegras de negócio:\nDados e integrações:\nModelo de acesso/cobrança:\nReferências:\nRestrições:\n",
      agents: [
        templateAgent(
          "saas-product",
          "Produto e arquitetura",
          "claude-code",
          430,
          80,
          "Líder de produto",
          "Transformar o briefing em escopo, arquitetura, jornadas e contratos entre áreas.",
          "Evitar escopo não solicitado.",
          "Plano funcional e técnico com prioridades.",
          "Fluxos, estados e critérios de aceite estão explícitos."
        ),
        templateAgent(
          "saas-ux",
          "UX e design do produto",
          "opencode",
          750,
          80,
          "Designer de produto",
          "Definir navegação, estados vazios, feedback, acessibilidade e sistema visual.",
          "Não implementar regras de servidor.",
          "Especificação de experiência aplicável no front-end.",
          "Fluxo principal é simples em desktop e mobile."
        ),
        templateAgent(
          "saas-backend",
          "Back-end e dados",
          "codex",
          750,
          390,
          "Engenheiro back-end",
          "Implementar domínio, persistência, autenticação e integrações necessárias.",
          "Não expor segredos nem enfraquecer autorização.",
          "Serviços e dados testáveis com contratos claros.",
          "Regras críticas possuem validação e tratamento de falhas."
        ),
        templateAgent(
          "saas-frontend",
          "Front-end e estados",
          "claude-code",
          1080,
          220,
          "Engenheiro front-end",
          "Implementar os fluxos e componentes consumindo os contratos aprovados.",
          "Não duplicar regra de negócio crítica no cliente.",
          "Interface completa, responsiva e integrada.",
          "Estados de carga, erro, vazio e sucesso estão cobertos."
        ),
        templateAgent(
          "saas-qa",
          "QA e segurança",
          "opencode",
          1400,
          220,
          "QA e segurança",
          "Validar fluxos, permissões, regressões, acessibilidade e cenários de falha.",
          "Não declarar sucesso sem evidência executável.",
          "Relatório de validação e correções necessárias.",
          "Critérios críticos passam com evidências."
        )
      ],
      contextTargets: ["saas-product", "saas-ux"],
      handoffs: [
        ["saas-product", "saas-ux", "jornadas e escopo"],
        ["saas-product", "saas-backend", "arquitetura e regras"],
        ["saas-ux", "saas-frontend", "experiência especificada"],
        ["saas-backend", "saas-frontend", "contratos disponíveis"],
        ["saas-frontend", "saas-qa", "produto integrado"],
        ["saas-backend", "saas-qa", "serviços integrados"]
      ]
    };
  }
  return {
    title: "Sistema completo",
    mission:
      "Construir um sistema completo e sustentável, com arquitetura, módulos especializados, integração e validação final.",
    briefingTitle: "Requisitos do sistema",
    briefing:
      "# Preencha antes de iniciar\n\nObjetivo:\nPerfis de usuário:\nMódulos:\nFluxos críticos:\nDados:\nIntegrações:\nRequisitos não funcionais:\nRestrições:\n",
    agents: [
      templateAgent(
        "system-architecture",
        "Arquitetura e contratos",
        "claude-code",
        430,
        80,
        "Arquiteto",
        "Mapear módulos, dependências, contratos, riscos e sequência de entrega.",
        "Respeitar a arquitetura e bibliotecas existentes.",
        "Plano técnico modular com contratos claros.",
        "Cada módulo tem fronteiras e critérios de aceite."
      ),
      templateAgent(
        "system-core",
        "Domínio e serviços",
        "codex",
        750,
        80,
        "Engenheiro de domínio",
        "Implementar regras centrais e serviços conforme os contratos.",
        "Manter domínio independente da interface.",
        "Núcleo funcional testável.",
        "Regras de negócio críticas possuem cobertura."
      ),
      templateAgent(
        "system-data",
        "Dados e segurança",
        "opencode",
        750,
        390,
        "Engenheiro de dados e segurança",
        "Projetar persistência, migrações, autorização, auditoria e integridade.",
        "Negar acesso por padrão e evitar mudanças destrutivas.",
        "Camada de dados segura e migrável.",
        "Integridade e permissões são verificáveis."
      ),
      templateAgent(
        "system-interface",
        "Interface e fluxos",
        "claude-code",
        1080,
        220,
        "Engenheiro de interface",
        "Implementar jornadas, componentes e estados integrados aos serviços.",
        "Não esconder falhas nem inventar dados em produção.",
        "Interface completa e acessível.",
        "Fluxos críticos funcionam de ponta a ponta."
      ),
      templateAgent(
        "system-integration",
        "Integração e validação",
        "codex",
        1400,
        220,
        "Integrador e QA",
        "Integrar módulos, executar verificações e corrigir regressões de contrato.",
        "Não aceitar módulos isolados como sistema concluído.",
        "Sistema integrado com relatório de evidências.",
        "Build, testes e fluxos críticos passam."
      )
    ],
    contextTargets: ["system-architecture"],
    handoffs: [
      ["system-architecture", "system-core", "contratos de domínio"],
      ["system-architecture", "system-data", "modelo e riscos"],
      ["system-core", "system-interface", "serviços disponíveis"],
      ["system-data", "system-interface", "dados e autorização"],
      ["system-interface", "system-integration", "interface integrada"],
      ["system-core", "system-integration", "núcleo integrado"],
      ["system-data", "system-integration", "dados integrados"]
    ]
  };
}

function templateAgent(
  id: string,
  title: string,
  adapterId: ProductTemplateAgent["adapterId"],
  x: number,
  y: number,
  name: string,
  responsibilities: string,
  constraints: string,
  expectedDeliverable: string,
  completionCriteria: string
): ProductTemplateAgent {
  return {
    id,
    title,
    adapterId,
    position: { x, y },
    role: { name, responsibilities, constraints, expectedDeliverable, completionCriteria }
  };
}

function templateEdge(
  id: string,
  source: string,
  target: string,
  kind: EdgeContract["kind"],
  label: string
): CanvasSnapshot["edges"][number] {
  return {
    id,
    source,
    target,
    contract: {
      schemaVersion: "1.0",
      kind,
      label,
      requiredEvidenceTypes: kind === "context" ? [] : ["artifact"],
      ...(kind === "handoff"
        ? {
            handoffMode: "after-success" as const,
            targetInstruction: `Continue a partir da entrega: ${label}.`
          }
        : {})
    }
  };
}

function defaultNodeData(type: CanvasNodeType): CanvasNodeData {
  const titles: Record<CanvasNodeType, string> = {
    terminal: "Local terminal",
    agent: "Implementation agent",
    note: "Engineering note",
    artifact: "Published artifact",
    text: "Text source",
    link: "Link source",
    file: "File source",
    folder: "Folder source",
    image: "Image source",
    drawing: "Drawing source",
    page: "Page source",
    shape: "Rectangle",
    frame: "Frame",
    comment: "Comment",
    task: "Typed task",
    gate: "Quality gate"
  };
  return {
    title: titles[type],
    state: type === "gate" ? "blocked" : "idle",
    summary:
      type === "terminal"
        ? "$ pnpm test\nwaiting for approved project"
        : type === "note"
          ? "Canvas layout is a projection of local state."
          : "Ready for configuration",
    ...(type === "note" ? { content: "Keep decisions and evidence close to the workflow." } : {}),
    ...(isContextSourceType(type)
      ? {
          contextSource: {
            kind: type,
            ...(type === "link" ? { url: "https://example.invalid/context" } : {}),
            ...(["text", "drawing", "page"].includes(type)
              ? { content: "Add reviewed local context." }
              : {})
          }
        }
      : {}),
    ...(type === "shape" ? { shape: { kind: "rectangle" as const } } : {}),
    ...(type === "frame" ? { frame: { memberNodeIds: [] } } : {}),
    retryMaxAttempts: 1,
    permissions: []
  };
}

function isContextSourceType(
  type: CanvasNodeType
): type is Extract<
  CanvasNodeType,
  "text" | "link" | "file" | "folder" | "image" | "drawing" | "page"
> {
  return ["text", "link", "file", "folder", "image", "drawing", "page"].includes(type);
}

function defaultCanvasNodeSize(
  type: CanvasNodeType,
  adapterId: string | undefined
): { readonly width: number; readonly height: number } | undefined {
  if (isTerminalCanvasNode(type, adapterId)) return terminalNodeSize;
  if (type === "note") return noteNodeSize;
  if (isContextSourceType(type)) return contextNodeSize;
  if (type === "frame") return { width: 420, height: 280 };
  if (type === "shape") return { width: 240, height: 160 };
  if (type === "comment") return { width: 280, height: 180 };
  return undefined;
}

function nodesBounds(nodes: readonly ForgeFlowNode[]): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + (node.width ?? 220)));
  const maxY = Math.max(...nodes.map((node) => node.position.y + (node.height ?? 140)));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function removeFrameMembers(
  nodes: readonly ForgeFlowNode[],
  removedIds: ReadonlySet<string>
): ForgeFlowNode[] {
  return nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) =>
      node.data.frame === undefined
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              frame: {
                memberNodeIds: node.data.frame.memberNodeIds.filter(
                  (memberNodeId) => !removedIds.has(memberNodeId)
                )
              }
            }
          }
    );
}

function wouldCreateCycle(
  edges: readonly ForgeFlowEdge[],
  source: string,
  target: string
): boolean {
  const visited = new Set<string>();
  const pending = [target];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || visited.has(nodeId)) {
      continue;
    }
    if (nodeId === source) {
      return true;
    }
    visited.add(nodeId);
    for (const edge of edges) {
      if (edge.source === nodeId && !visited.has(edge.target)) {
        pending.push(edge.target);
      }
    }
  }
  return false;
}

function isTerminalCanvasNode(type: CanvasNodeType, adapterId: string | undefined): boolean {
  return type === "terminal" || (type === "agent" && adapterId !== undefined);
}
