import {
  WORKSPACE_SCHEMA_VERSION,
  canvasEdgeSchema,
  canvasGroupSchema,
  canvasNodeSchema,
  defaultTerminalLaunchConfig,
  defaultWorkspaceSettings,
  type CanvasEdge,
  type CanvasGroup,
  type CanvasNode,
  type EdgeCapability,
  type FilePreviewNode,
  type FileTreeNode,
  type PortalNode,
  type NoteNode,
  type Position,
  type Size,
  type TerminalLaunchConfig,
  type TerminalNode,
  type Workspace,
  type WorkspaceSettings,
  workspaceSchema
} from "./model";
import type { FilePreviewKind } from "./files";
import {
  defaultTerminalAgentConfig,
  defaultWorkspacePermissionPolicy,
  type RoleAssignment,
  type TerminalAgentConfig
} from "./agents";

export interface DomainDependencies {
  readonly createId: () => string;
  readonly now: () => string;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly workingDirectory: string;
  readonly settings?: WorkspaceSettings;
}

export interface CreateTerminalNodeInput {
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly position?: Position;
  readonly size?: Size;
  readonly launchConfig?: TerminalLaunchConfig;
  readonly agentConfig?: TerminalAgentConfig;
  readonly isCompazio?: boolean;
  readonly orchestrator?: boolean;
  readonly orchestratorOwnerNodeId?: string;
}

export interface CreateNoteNodeInput {
  readonly title?: string;
  readonly content?: string;
  readonly position?: Position;
  readonly size?: Size;
}

export interface CreateFileTreeNodeInput {
  readonly title?: string;
  readonly rootPath?: string;
  readonly currentPath?: string;
  readonly position?: Position;
  readonly size?: Size;
}

export interface CreateFilePreviewNodeInput {
  readonly title?: string;
  readonly filePath: string;
  readonly previewKind: FilePreviewKind;
  readonly fileRevision?: string;
  readonly missing?: boolean;
  readonly position?: Position;
  readonly size?: Size;
}

export interface CreatePortalNodeInput {
  readonly title?: string;
  readonly url?: string;
  readonly sessionMode?: PortalNode["sessionMode"];
  readonly sessionKey?: string;
  readonly position?: Position;
  readonly size?: Size;
}

export interface CreateCanvasGroupInput {
  readonly title?: string;
  readonly nodeIds: readonly string[];
  readonly position?: Position;
  readonly size?: Size;
  readonly color?: CanvasGroup["color"];
}

export class WorkspaceConsistencyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceConsistencyError";
  }
}

export function createWorkspace(
  input: CreateWorkspaceInput,
  dependencies: DomainDependencies
): Workspace {
  const now = dependencies.now();
  return assertWorkspace({
    id: dependencies.createId(),
    name: input.name,
    workingDirectory: input.workingDirectory,
    nodes: [],
    edges: [],
    groups: [],
    settings: input.settings ?? defaultWorkspaceSettings(),
    permissions: defaultWorkspacePermissionPolicy(),
    createdAt: now,
    updatedAt: now,
    schemaVersion: WORKSPACE_SCHEMA_VERSION
  });
}

export function renameWorkspace(
  workspace: Workspace,
  name: string,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  return assertWorkspace({ ...workspace, name, updatedAt: dependencies.now() });
}

export function updateWorkspaceSettings(
  workspace: Workspace,
  settings: WorkspaceSettings,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  return assertWorkspace({ ...workspace, settings, updatedAt: dependencies.now() });
}

export function updateWorkspacePermissions(
  workspace: Workspace,
  permissions: Workspace["permissions"],
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  return assertWorkspace({ ...workspace, permissions, updatedAt: dependencies.now() });
}

export function recordRoleAssignment(
  workspace: Workspace,
  assignment: RoleAssignment,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  if (
    !workspace.nodes.some(
      (node) => node.id === assignment.terminalNodeId && node.type === "terminal"
    )
  ) {
    throw new WorkspaceConsistencyError(
      "A responsibility can only be assigned to an existing terminal"
    );
  }
  const roleAssignments = workspace.roleAssignments.some(
    (current) => current.terminalNodeId === assignment.terminalNodeId
  )
    ? workspace.roleAssignments.map((current) =>
        current.terminalNodeId === assignment.terminalNodeId ? assignment : current
      )
    : [...workspace.roleAssignments, assignment];
  return assertWorkspace({ ...workspace, roleAssignments, updatedAt: dependencies.now() });
}

export function addTerminalNode(
  workspace: Workspace,
  input: CreateTerminalNodeInput,
  dependencies: DomainDependencies
): Workspace {
  const now = dependencies.now();
  const node: TerminalNode = {
    id: dependencies.createId(),
    workspaceId: workspace.id,
    type: "terminal",
    title: input.title ?? "Terminal",
    workingDirectory: input.workingDirectory ?? workspace.workingDirectory,
    launchConfig: input.launchConfig ?? defaultTerminalLaunchConfig(),
    agentConfig: input.agentConfig ?? defaultTerminalAgentConfig(),
    isCompazio: input.isCompazio ?? input.orchestrator ?? false,
    orchestrator: input.isCompazio ?? input.orchestrator ?? false,
    ...(input.orchestratorOwnerNodeId === undefined
      ? {}
      : { orchestratorOwnerNodeId: input.orchestratorOwnerNodeId }),
    position: input.position ?? { x: 80, y: 80 },
    size: input.size ?? { width: 640, height: 400 },
    createdAt: now,
    updatedAt: now
  };
  return addNode(workspace, node, dependencies);
}

export function addNoteNode(
  workspace: Workspace,
  input: CreateNoteNodeInput,
  dependencies: DomainDependencies
): Workspace {
  const now = dependencies.now();
  const node: NoteNode = {
    id: dependencies.createId(),
    workspaceId: workspace.id,
    type: "note",
    title: input.title ?? "Nota",
    content: input.content ?? "",
    position: input.position ?? { x: 120, y: 120 },
    size: input.size ?? { width: 320, height: 240 },
    createdAt: now,
    updatedAt: now
  };
  return addNode(workspace, node, dependencies);
}

export function addFileTreeNode(
  workspace: Workspace,
  input: CreateFileTreeNodeInput,
  dependencies: DomainDependencies
): Workspace {
  const now = dependencies.now();
  const currentPath = input.currentPath ?? input.rootPath ?? ".";
  const node: FileTreeNode = {
    id: dependencies.createId(),
    workspaceId: workspace.id,
    type: "file-tree",
    title: input.title ?? "Arquivos",
    rootPath: input.rootPath ?? ".",
    currentPath,
    history: [currentPath],
    historyIndex: 0,
    viewMode: "list",
    expandedPaths: [],
    editor: {},
    diff: { filter: "all" },
    position: input.position ?? { x: 160, y: 140 },
    size: input.size ?? { width: 420, height: 520 },
    createdAt: now,
    updatedAt: now
  };
  return addNode(workspace, node, dependencies);
}

export function addFilePreviewNode(
  workspace: Workspace,
  input: CreateFilePreviewNodeInput,
  dependencies: DomainDependencies
): Workspace {
  const now = dependencies.now();
  const node: FilePreviewNode = {
    id: dependencies.createId(),
    workspaceId: workspace.id,
    type: "file-preview",
    title: input.title ?? input.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Arquivo",
    filePath: input.filePath,
    previewKind: input.previewKind,
    ...(input.fileRevision === undefined ? {} : { fileRevision: input.fileRevision }),
    missing: input.missing ?? false,
    position: input.position ?? { x: 620, y: 180 },
    size: input.size ?? { width: 420, height: 360 },
    createdAt: now,
    updatedAt: now
  };
  return addNode(workspace, node, dependencies);
}

export function addPortalNode(
  workspace: Workspace,
  input: CreatePortalNodeInput,
  dependencies: DomainDependencies
): Workspace {
  const now = dependencies.now();
  const node: PortalNode = {
    id: dependencies.createId(),
    workspaceId: workspace.id,
    type: "portal",
    title: input.title ?? "Portal",
    url: input.url ?? "about:blank",
    sessionMode: input.sessionMode ?? "isolated",
    sessionKey: input.sessionKey ?? dependencies.createId(),
    zoomFactor: 1,
    lastKnownState: { canGoBack: false, canGoForward: false, crashed: false },
    position: input.position ?? { x: 200, y: 180 },
    size: input.size ?? { width: 720, height: 500 },
    createdAt: now,
    updatedAt: now
  };
  return addNode(workspace, node, dependencies);
}

export function addCanvasGroup(
  workspace: Workspace,
  input: CreateCanvasGroupInput,
  dependencies: DomainDependencies
): Workspace {
  const nodeIds = uniqueKnownNodeIds(workspace, input.nodeIds);
  const bounds = boundsForNodes(workspace, nodeIds);
  const now = dependencies.now();
  const group: CanvasGroup = {
    id: dependencies.createId(),
    workspaceId: workspace.id,
    title: input.title ?? "Grupo",
    nodeIds,
    position: input.position ?? { x: bounds.x - 24, y: bounds.y - 36 },
    size: input.size ?? { width: bounds.width + 48, height: bounds.height + 60 },
    collapsed: false,
    ...(input.color === undefined ? {} : { color: input.color }),
    createdAt: now,
    updatedAt: now
  };
  return assertWorkspace({
    ...workspace,
    groups: [...workspace.groups, canvasGroupSchema.parse(group)],
    updatedAt: now
  });
}

export function updateCanvasGroup(
  workspace: Workspace,
  groupId: string,
  patch: Partial<
    Pick<CanvasGroup, "title" | "nodeIds" | "position" | "size" | "collapsed" | "color">
  >,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  const current = workspace.groups.find((group) => group.id === groupId);
  if (current === undefined) throw new WorkspaceConsistencyError(`Unknown group: ${groupId}`);
  const nodeIds =
    patch.nodeIds === undefined
      ? current.nodeIds
      : uniqueKnownNodeIds(workspace, patch.nodeIds, current.id);
  const updated = canvasGroupSchema.parse({
    ...current,
    ...patch,
    nodeIds,
    updatedAt: dependencies.now()
  });
  return assertWorkspace({
    ...workspace,
    groups: workspace.groups.map((group) => (group.id === groupId ? updated : group)),
    updatedAt: updated.updatedAt
  });
}

export function removeCanvasGroup(
  workspace: Workspace,
  groupId: string,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  const groups = workspace.groups.filter((group) => group.id !== groupId);
  if (groups.length === workspace.groups.length) return workspace;
  return assertWorkspace({ ...workspace, groups, updatedAt: dependencies.now() });
}

/**
 * Clones only persisted canvas structure. Runtime terminal sessions are intentionally omitted and
 * edges are recreated only when both endpoints were selected.
 */
export function pasteCanvasSelection(
  source: Workspace,
  target: Workspace,
  nodeIds: readonly string[],
  position: Position,
  dependencies: DomainDependencies
): Workspace {
  const selected = uniqueKnownNodeIds(source, nodeIds, undefined, true);
  const sourceNodes = source.nodes.filter((node) => selected.includes(node.id));
  const sourceBounds = boundsForNodes(source, selected);
  const now = dependencies.now();
  const ids = new Map(sourceNodes.map((node) => [node.id, dependencies.createId()]));
  const offset = { x: position.x - sourceBounds.x, y: position.y - sourceBounds.y };
  const nodes = sourceNodes.map((node) => {
    const cloned = {
      ...node,
      id: ids.get(node.id) ?? dependencies.createId(),
      workspaceId: target.id,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      updatedAt: now,
      createdAt: now,
      ...(node.type === "terminal"
        ? { workingDirectory: target.workingDirectory, sessionId: undefined }
        : {})
    };
    return canvasNodeSchema.parse(cloned);
  });
  const edges = source.edges
    .filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId))
    .map((edge) =>
      canvasEdgeSchema.parse({
        ...edge,
        id: dependencies.createId(),
        workspaceId: target.id,
        sourceNodeId: ids.get(edge.sourceNodeId),
        targetNodeId: ids.get(edge.targetNodeId),
        createdAt: now
      })
    );
  const groups = source.groups
    .filter((group) => group.nodeIds.some((nodeId) => ids.has(nodeId)))
    .map((group) =>
      canvasGroupSchema.parse({
        ...group,
        id: dependencies.createId(),
        workspaceId: target.id,
        title: `Cópia de ${group.title}`,
        nodeIds: group.nodeIds.flatMap((nodeId) => {
          const next = ids.get(nodeId);
          return next === undefined ? [] : [next];
        }),
        position: { x: group.position.x + offset.x, y: group.position.y + offset.y },
        createdAt: now,
        updatedAt: now
      })
    );
  return assertWorkspace({
    ...target,
    nodes: [...target.nodes, ...nodes],
    edges: [...target.edges, ...edges],
    groups: [...target.groups, ...groups],
    updatedAt: now
  });
}

export function addNode(
  workspace: Workspace,
  node: CanvasNode,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  if (node.workspaceId !== workspace.id) {
    throw new WorkspaceConsistencyError("A node belongs to a different workspace");
  }
  if (workspace.nodes.some((current) => current.id === node.id)) {
    throw new WorkspaceConsistencyError(`A node with id ${node.id} already exists`);
  }
  return assertWorkspace({
    ...workspace,
    nodes: [...workspace.nodes, canvasNodeSchema.parse(node)],
    updatedAt: dependencies.now()
  });
}

export function moveNode(
  workspace: Workspace,
  nodeId: string,
  position: Position,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  return updateNode(workspace, nodeId, { position }, dependencies);
}

export function resizeNode(
  workspace: Workspace,
  nodeId: string,
  size: Size,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  return updateNode(workspace, nodeId, { size }, dependencies);
}

export function updateNode(
  workspace: Workspace,
  nodeId: string,
  patch: Partial<Omit<CanvasNode, "id" | "workspaceId" | "type" | "createdAt">>,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  const current = workspace.nodes.find((node) => node.id === nodeId);
  if (current === undefined) {
    throw new WorkspaceConsistencyError(`Unknown node: ${nodeId}`);
  }
  const updated = canvasNodeSchema.parse({ ...current, ...patch, updatedAt: dependencies.now() });
  return assertWorkspace({
    ...workspace,
    nodes: workspace.nodes.map((node) => (node.id === nodeId ? updated : node)),
    updatedAt: dependencies.now()
  });
}

/** Idempotently removes a node and every edge that would otherwise become orphaned. */
export function removeNode(
  workspace: Workspace,
  nodeId: string,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  const nodes = workspace.nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => {
      if (node.type !== "terminal" || node.orchestratorOwnerNodeId !== nodeId) return node;
      return canvasNodeSchema.parse(
        Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "orchestratorOwnerNodeId")
        )
      );
    });
  const roleAssignments = workspace.roleAssignments.filter(
    (assignment) => assignment.terminalNodeId !== nodeId
  );
  const edges = workspace.edges.filter(
    (edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId
  );
  if (nodes.length === workspace.nodes.length && edges.length === workspace.edges.length) {
    return workspace;
  }
  const groups = workspace.groups
    .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) }))
    .filter((group) => group.nodeIds.length > 0);
  return assertWorkspace({
    ...workspace,
    nodes,
    edges,
    groups,
    roleAssignments,
    updatedAt: dependencies.now()
  });
}

export function addVisualEdge(
  workspace: Workspace,
  sourceNodeId: string,
  targetNodeId: string,
  dependencies: DomainDependencies,
  capabilities: readonly EdgeCapability[] = []
): Workspace {
  if (sourceNodeId === targetNodeId) {
    throw new WorkspaceConsistencyError("A visual edge cannot reference the same node twice");
  }
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) {
    throw new WorkspaceConsistencyError("A visual edge must reference existing nodes");
  }
  if (
    workspace.edges.some(
      (edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId
    )
  ) {
    throw new WorkspaceConsistencyError("This visual edge already exists");
  }
  const edge: CanvasEdge = canvasEdgeSchema.parse({
    id: dependencies.createId(),
    workspaceId: workspace.id,
    sourceNodeId,
    targetNodeId,
    type: "visual",
    capabilities: [...new Set(capabilities)],
    createdAt: dependencies.now()
  });
  return assertWorkspace({
    ...workspace,
    edges: [...workspace.edges, edge],
    updatedAt: dependencies.now()
  });
}

export function removeEdge(
  workspace: Workspace,
  edgeId: string,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  const edges = workspace.edges.filter((edge) => edge.id !== edgeId);
  if (edges.length === workspace.edges.length) return workspace;
  return assertWorkspace({ ...workspace, edges, updatedAt: dependencies.now() });
}

export function removeOrphanEdges(
  workspace: Workspace,
  dependencies: Pick<DomainDependencies, "now">
): Workspace {
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  const edges = workspace.edges.filter(
    (edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)
  );
  if (edges.length === workspace.edges.length) return workspace;
  return assertWorkspace({ ...workspace, edges, updatedAt: dependencies.now() });
}

export function assertWorkspace(value: unknown): Workspace {
  const workspace = workspaceSchema.parse(value);
  const nodeIds = new Set<string>();
  for (const node of workspace.nodes) {
    if (node.workspaceId !== workspace.id) {
      throw new WorkspaceConsistencyError(`Node ${node.id} belongs to a different workspace`);
    }
    if (nodeIds.has(node.id)) {
      throw new WorkspaceConsistencyError(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of workspace.edges) {
    if (edge.workspaceId !== workspace.id) {
      throw new WorkspaceConsistencyError(`Edge ${edge.id} belongs to a different workspace`);
    }
    if (edgeIds.has(edge.id)) {
      throw new WorkspaceConsistencyError(`Duplicate edge id: ${edge.id}`);
    }
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new WorkspaceConsistencyError(`Edge ${edge.id} references an unknown node`);
    }
    edgeIds.add(edge.id);
  }
  const groupIds = new Set<string>();
  const groupedNodeIds = new Set<string>();
  for (const group of workspace.groups) {
    if (group.workspaceId !== workspace.id) {
      throw new WorkspaceConsistencyError(`Group ${group.id} belongs to a different workspace`);
    }
    if (groupIds.has(group.id))
      throw new WorkspaceConsistencyError(`Duplicate group id: ${group.id}`);
    for (const nodeId of group.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        throw new WorkspaceConsistencyError(`Group ${group.id} references an unknown node`);
      }
      if (groupedNodeIds.has(nodeId)) {
        throw new WorkspaceConsistencyError(`Node ${nodeId} belongs to more than one group`);
      }
      groupedNodeIds.add(nodeId);
    }
    groupIds.add(group.id);
  }
  return workspace;
}

/** Session identities are runtime-only and are never written to the V2 workspace files. */
export function toPersistentWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) =>
      node.type === "terminal" ? persistTerminalNode(node) : node
    )
  };
}

function persistTerminalNode(node: TerminalNode): Omit<TerminalNode, "sessionId"> {
  return {
    id: node.id,
    workspaceId: node.workspaceId,
    type: node.type,
    title: node.title,
    workingDirectory: node.workingDirectory,
    launchConfig: node.launchConfig,
    agentConfig: node.agentConfig,
    isCompazio: node.isCompazio,
    orchestrator: node.orchestrator,
    ...(node.orchestratorOwnerNodeId === undefined
      ? {}
      : { orchestratorOwnerNodeId: node.orchestratorOwnerNodeId }),
    position: node.position,
    size: node.size,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
}

export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify(assertWorkspace(toPersistentWorkspace(workspace)), null, 2);
}

function uniqueKnownNodeIds(
  workspace: Workspace,
  nodeIds: readonly string[],
  allowedGroupId?: string,
  allowExistingGroup = false
): string[] {
  const known = new Set(workspace.nodes.map((node) => node.id));
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) throw new WorkspaceConsistencyError("A group needs at least one node");
  if (unique.some((nodeId) => !known.has(nodeId))) {
    throw new WorkspaceConsistencyError("A group can only contain existing nodes");
  }
  const grouped = new Set(
    workspace.groups
      .filter((group) => group.id !== allowedGroupId)
      .flatMap((group) => group.nodeIds)
  );
  if (!allowExistingGroup && unique.some((nodeId) => grouped.has(nodeId))) {
    throw new WorkspaceConsistencyError("A node already belongs to a group");
  }
  return unique;
}

function boundsForNodes(workspace: Workspace, nodeIds: readonly string[]) {
  const nodes = workspace.nodes.filter((node) => nodeIds.includes(node.id));
  const x = Math.min(...nodes.map((node) => node.position.x));
  const y = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + node.size.width));
  const bottom = Math.max(...nodes.map((node) => node.position.y + node.size.height));
  return { x, y, width: right - x, height: bottom - y };
}
