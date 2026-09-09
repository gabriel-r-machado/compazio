import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  addCanvasGroup,
  addFilePreviewNode,
  addFileTreeNode,
  addPortalNode,
  addNoteNode,
  addTerminalNode,
  addVisualEdge,
  createWorkspace,
  defaultTerminalLaunchConfig,
  moveNode,
  pasteCanvasSelection,
  recordRoleAssignment,
  removeEdge,
  removeCanvasGroup,
  removeNode,
  renameWorkspace,
  resizeNode,
  updateWorkspaceSettings,
  updateWorkspacePermissions,
  updateCanvasGroup,
  updateNode
} from "@forgedeck/compazio-v2-domain";
import type {
  CanvasNode,
  CanvasGroup,
  EdgeCapability,
  FilePreviewKind,
  FileTreeNode,
  PortalNode,
  Position,
  Size,
  TerminalLaunchConfig,
  TerminalAgentConfig,
  TerminalNode,
  TerminalSession,
  V2TerminalEvent,
  Workspace
} from "@forgedeck/compazio-v2-domain";
import type { LaunchSpec } from "@forgedeck/agent-sdk";
import {
  writeFileAtomically,
  type V2WorkspaceRepository
} from "@forgedeck/compazio-v2-persistence";
import type { V2ProcessSupervisor } from "@forgedeck/compazio-v2-runtime";
import type { AgentRuntime } from "@forgedeck/compazio-v2-runtime";
import type { EntitlementService } from "./entitlement-service";

export interface V2WorkspaceServiceOptions {
  readonly repository: V2WorkspaceRepository;
  readonly supervisor: V2ProcessSupervisor;
  readonly agents: AgentRuntime;
  readonly createId?: () => string;
  readonly now?: () => string;
  /**
   * The workspace creation gate. It is required so that no caller — UI, IPC, MCP, Compazio, an e2e
   * harness or a real agent — can reach {@link V2WorkspaceService.create} without passing it.
   * Isolated runs build one with {@link EntitlementService.forIsolatedTest}.
   */
  readonly entitlement: Pick<EntitlementService, "assertCanCreateWorkspace">;
  /** Production mirror for canvas notes; tests opt in with a temporary workspace directory. */
  readonly notesAsMarkdown?: boolean;
}

/** The private bridge creates ephemeral launch context and owns its cleanup by session. */
export interface V2OrchestratorBridge {
  prepare(input: {
    readonly workspace: Workspace;
    readonly terminal: TerminalNode;
    readonly sessionId: string;
  }): Promise<{
    readonly environment: Readonly<Record<string, string>>;
    readonly initialInput: string;
  }>;
  prepareAgentMcp?(input: {
    readonly workspace: Workspace;
    readonly terminal: TerminalNode;
    readonly sessionId: string;
    /** A task turn has its own hidden process; an interactive terminal remains person-owned. */
    readonly mode?: "interactive" | "task";
    readonly prompt?: string;
    readonly workspaceAccess?: "read" | "write";
  }): Promise<
    | {
        readonly environment: Readonly<Record<string, string>>;
        readonly args: readonly string[];
      }
    | undefined
  >;
  revoke(sessionId: string): Promise<void>;
  revokeMcpSessionsForTerminal?(terminalId: string): Promise<void>;
  revokeMcpSessionsForWorkspace?(workspaceId: string): Promise<void>;
}

export interface BackgroundAgentTask {
  /** @deprecated Hidden task sessions are disabled by the real-terminal core. */
  readonly session: TerminalSession;
  /** @deprecated Kept only so historical callers receive a typed, explicit runtime error. */
  readonly completion: Promise<{
    readonly session: TerminalSession;
    readonly output: string;
  }>;
}

export class V2WorkspaceService {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly eventListeners = new Set<(event: V2TerminalEvent) => void>();
  /** Keeps read-transform-save canvas mutations ordered for each workspace. */
  private readonly workspaceMutationTails = new Map<string, Promise<void>>();
  private readonly undoHistory = new Map<string, Workspace[]>();
  private readonly redoHistory = new Map<string, Workspace[]>();
  private readonly createId: () => string;
  private readonly now: () => string;
  private orchestratorBridge: V2OrchestratorBridge | null = null;

  public constructor(private readonly options: V2WorkspaceServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    options.supervisor.subscribe((event) => {
      if (
        event.type === "terminal.state" &&
        ["stopped", "completed", "failed"].includes(event.session.state)
      ) {
        void options.agents.cleanupRole(event.session.id).catch(() => undefined);
        void this.orchestratorBridge?.revoke(event.session.id).catch(() => undefined);
      }
      for (const listener of this.eventListeners) listener(event);
    });
  }

  public subscribe(listener: (event: V2TerminalEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public setOrchestratorBridge(bridge: V2OrchestratorBridge): void {
    this.orchestratorBridge = bridge;
  }

  public async list() {
    return this.options.repository.list();
  }

  public async workingDirectory(workspaceId: string): Promise<string> {
    return (await this.getRaw(workspaceId)).workingDirectory;
  }

  public async isRoleAssigned(roleId: string): Promise<boolean> {
    const listing = await this.options.repository.list();
    for (const summary of listing.workspaces) {
      const workspace =
        this.workspaces.get(summary.id) ?? (await this.options.repository.get(summary.id));
      if (
        workspace.nodes.some(
          (node) => node.type === "terminal" && node.agentConfig.roleId === roleId
        )
      ) {
        return true;
      }
    }
    return false;
  }

  public async create(input: {
    readonly name: string;
    readonly workingDirectory: string;
  }): Promise<Workspace> {
    const current = await this.options.repository.list();
    // The only persistent workspace creation in V2. Everything upstream funnels through here, so the
    // gate runs before the repository is ever touched.
    await this.options.entitlement.assertCanCreateWorkspace(current.workspaces.length);
    const workingDirectory = await canonicalDirectory(input.workingDirectory);
    const workspace = createWorkspace({ name: input.name, workingDirectory }, this.dependencies());
    await this.options.repository.create(workspace);
    this.workspaces.set(workspace.id, workspace);
    return this.decorate(workspace);
  }

  public async open(workspaceId: string): Promise<Workspace> {
    const workspace = await this.getRaw(workspaceId);
    await this.options.repository.setLastOpened(workspace.id);
    return this.decorate(workspace);
  }

  /** A read-only snapshot for trusted main-process collaborators such as the session bridge. */
  public async snapshot(workspaceId: string): Promise<Workspace> {
    return this.decorate(await this.getRaw(workspaceId));
  }

  public async close(workspaceId: string): Promise<void> {
    await this.mutateWorkspace(workspaceId, async () => {
      await this.options.supervisor.stopWorkspace(workspaceId);
      this.workspaces.delete(workspaceId);
      const index = await this.options.repository.list();
      if (index.lastOpenedWorkspaceId === workspaceId)
        await this.options.repository.setLastOpened(null);
    });
  }

  public async rename(workspaceId: string, name: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(renameWorkspace(await this.getRaw(workspaceId), name, this.dependencies()))
    );
  }

  public async updateSettings(
    workspaceId: string,
    settings: Workspace["settings"]
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(
        updateWorkspaceSettings(await this.getRaw(workspaceId), settings, this.dependencies()),
        false
      )
    );
  }

  public async undo(workspaceId: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const current = await this.getRaw(workspaceId);
      const history = this.undoHistory.get(workspaceId) ?? [];
      const previous = history.pop();
      if (previous === undefined) return this.decorate(current);
      this.undoHistory.set(workspaceId, history);
      this.redoHistory.set(
        workspaceId,
        [...(this.redoHistory.get(workspaceId) ?? []), current].slice(-100)
      );
      await this.options.repository.save(previous);
      this.workspaces.set(workspaceId, previous);
      return this.decorate(previous);
    });
  }

  public async redo(workspaceId: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const current = await this.getRaw(workspaceId);
      const future = this.redoHistory.get(workspaceId) ?? [];
      const next = future.pop();
      if (next === undefined) return this.decorate(current);
      this.redoHistory.set(workspaceId, future);
      this.undoHistory.set(
        workspaceId,
        [...(this.undoHistory.get(workspaceId) ?? []), current].slice(-100)
      );
      await this.options.repository.save(next);
      this.workspaces.set(workspaceId, next);
      return this.decorate(next);
    });
  }

  public async updatePermissions(
    workspaceId: string,
    permissions: Workspace["permissions"]
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(
        updateWorkspacePermissions(await this.getRaw(workspaceId), permissions, this.dependencies())
      )
    );
  }

  public async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      await this.options.supervisor.stopWorkspace(workspace.id);
      for (const node of workspace.nodes) {
        if (node.type === "terminal") {
          await this.options.supervisor.releaseNode(workspace.id, node.id);
          await this.orchestratorBridge?.revokeMcpSessionsForTerminal?.(node.id);
        }
      }
      await this.orchestratorBridge?.revokeMcpSessionsForWorkspace?.(workspace.id);
      await this.options.repository.delete(workspace.id);
      this.workspaces.delete(workspace.id);
    });
  }

  public async addTerminal(
    workspaceId: string,
    input: {
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
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const workingDirectory =
        input.workingDirectory === undefined
          ? workspace.workingDirectory
          : await ensureChildDirectory(workspace.workingDirectory, input.workingDirectory);
      return this.persist(
        addTerminalNode(
          workspace,
          {
            ...input,
            workingDirectory,
            launchConfig: input.launchConfig ?? defaultTerminalLaunchConfig()
          },
          this.dependencies()
        )
      );
    });
  }

  public async addNote(
    workspaceId: string,
    input: { readonly title?: string; readonly content?: string; readonly position?: Position }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(addNoteNode(await this.getRaw(workspaceId), input, this.dependencies()))
    );
  }

  public async addFileTree(
    workspaceId: string,
    input: {
      readonly title?: string;
      readonly rootPath?: string;
      readonly currentPath?: string;
      readonly position?: Position;
    }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(addFileTreeNode(await this.getRaw(workspaceId), input, this.dependencies()))
    );
  }

  public async addFilePreview(
    workspaceId: string,
    input: {
      readonly title?: string;
      readonly filePath: string;
      readonly previewKind: FilePreviewKind;
      readonly fileRevision?: string;
      readonly missing?: boolean;
      readonly position?: Position;
    }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(addFilePreviewNode(await this.getRaw(workspaceId), input, this.dependencies()))
    );
  }

  public async addPortal(
    workspaceId: string,
    input: {
      readonly title?: string;
      readonly url?: string;
      readonly sessionMode?: PortalNode["sessionMode"];
      readonly position?: Position;
    }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(addPortalNode(await this.getRaw(workspaceId), input, this.dependencies()))
    );
  }

  public async updatePortal(
    workspaceId: string,
    nodeId: string,
    patch: Partial<
      Pick<PortalNode, "title" | "url" | "zoomFactor" | "userAgentOverride" | "lastKnownState">
    >
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const node = requireNode(workspace, nodeId);
      if (node.type !== "portal") throw new Error("Only portals have browser state");
      return this.persist(updateNode(workspace, nodeId, patch, this.dependencies()));
    });
  }

  public async createGroup(
    workspaceId: string,
    input: {
      readonly title?: string;
      readonly nodeIds: readonly string[];
      readonly position?: Position;
      readonly size?: CanvasGroup["size"];
      readonly color?: CanvasGroup["color"];
    }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(addCanvasGroup(await this.getRaw(workspaceId), input, this.dependencies()))
    );
  }

  public async updateGroup(
    workspaceId: string,
    groupId: string,
    patch: Partial<
      Pick<CanvasGroup, "title" | "nodeIds" | "position" | "size" | "collapsed" | "color">
    >
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(
        updateCanvasGroup(await this.getRaw(workspaceId), groupId, patch, this.dependencies())
      )
    );
  }

  public async removeGroup(workspaceId: string, groupId: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(removeCanvasGroup(await this.getRaw(workspaceId), groupId, this.dependencies()))
    );
  }

  public async pasteCanvas(
    sourceWorkspaceId: string,
    workspaceId: string,
    nodeIds: readonly string[],
    position: Position
  ): Promise<Workspace> {
    const source = await this.getRaw(sourceWorkspaceId);
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(
        pasteCanvasSelection(
          source,
          await this.getRaw(workspaceId),
          nodeIds,
          position,
          this.dependencies()
        )
      )
    );
  }

  public async updateFileTree(
    workspaceId: string,
    nodeId: string,
    patch: Partial<
      Pick<
        FileTreeNode,
        | "title"
        | "currentPath"
        | "history"
        | "historyIndex"
        | "viewMode"
        | "expandedPaths"
        | "selectedPath"
        | "searchQuery"
        | "editor"
        | "diff"
      >
    >
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const node = requireNode(workspace, nodeId);
      if (node.type !== "file-tree") throw new Error("Only file trees have navigation state");
      return this.persist(updateNode(workspace, nodeId, patch, this.dependencies()));
    });
  }

  public async updateFilePreview(
    workspaceId: string,
    nodeId: string,
    patch: { readonly missing?: boolean; readonly fileRevision?: string; readonly title?: string }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const node = requireNode(workspace, nodeId);
      if (node.type !== "file-preview") throw new Error("Only previews have file state");
      return this.persist(updateNode(workspace, nodeId, patch, this.dependencies()));
    });
  }

  public async moveNode(
    workspaceId: string,
    nodeId: string,
    position: { readonly x: number; readonly y: number }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(moveNode(await this.getRaw(workspaceId), nodeId, position, this.dependencies()))
    );
  }

  /** Applies one deterministic layout with a single persistence write. */
  public async moveNodes(
    workspaceId: string,
    positions: Readonly<Record<string, Position>>
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      let workspace = await this.getRaw(workspaceId);
      const timestamp = this.now();
      const dependencies = { now: () => timestamp };
      for (const [nodeId, position] of Object.entries(positions)) {
        if (workspace.nodes.some((node) => node.id === nodeId)) {
          workspace = moveNode(workspace, nodeId, position, dependencies);
        }
      }
      return this.persist(workspace);
    });
  }

  public async resizeNode(
    workspaceId: string,
    nodeId: string,
    size: { readonly width: number; readonly height: number }
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      // ResizeObserver callbacks can already be in flight while a confirmed deletion is persisted.
      // Treat that stale visual update as a no-op instead of surfacing a false operational failure.
      if (!workspace.nodes.some((node) => node.id === nodeId)) return workspace;
      return this.persist(resizeNode(workspace, nodeId, size, this.dependencies()));
    });
  }

  public async updateNode(
    workspaceId: string,
    nodeId: string,
    patch: {
      readonly title?: string;
      readonly content?: string;
      readonly workingDirectory?: string;
      readonly launchConfig?: TerminalLaunchConfig;
      readonly agentConfig?: TerminalAgentConfig;
      readonly isCompazio?: boolean;
      readonly orchestrator?: boolean;
      readonly orchestratorOwnerNodeId?: string;
    }
  ): Promise<Workspace> {
    const current = await this.getRaw(workspaceId);
    const previous = current.nodes.find((node) => node.id === nodeId);
    const compazioChange =
      patch.isCompazio === undefined && patch.orchestrator === undefined
        ? undefined
        : (patch.isCompazio ?? patch.orchestrator ?? false);
    const updated = await this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const node = requireNode(workspace, nodeId);
      if (patch.content !== undefined && node.type !== "note") {
        throw new Error("Only notes have editable content");
      }
      if (
        (patch.workingDirectory !== undefined ||
          patch.launchConfig !== undefined ||
          patch.agentConfig !== undefined ||
          patch.isCompazio !== undefined ||
          patch.orchestrator !== undefined ||
          patch.orchestratorOwnerNodeId !== undefined) &&
        node.type !== "terminal"
      ) {
        throw new Error("Only terminals have launch configuration");
      }
      const workingDirectory =
        patch.workingDirectory === undefined
          ? undefined
          : await ensureChildDirectory(workspace.workingDirectory, patch.workingDirectory);
      return this.persist(
        updateNode(
          workspace,
          nodeId,
          {
            ...patch,
            ...(compazioChange === undefined
              ? {}
              : { isCompazio: compazioChange, orchestrator: compazioChange }),
            ...(workingDirectory === undefined ? {} : { workingDirectory })
          },
          this.dependencies()
        )
      );
    });
    if (
      previous?.type === "terminal" &&
      compazioChange !== undefined &&
      previous.isCompazio !== compazioChange
    ) {
      // MCP configuration is process-scoped. Revoking it before a controlled restart prevents a
      // terminal from retaining team capabilities after the persisted Compazio state changed.
      await this.orchestratorBridge?.revokeMcpSessionsForTerminal?.(nodeId);
      const active = this.sessionForNode(workspaceId, nodeId);
      if (active !== null && ["starting", "running", "waiting-input"].includes(active.state)) {
        await this.restartTerminal(workspaceId, nodeId, active.id);
      }
    }
    return updated;
  }

  /**
   * Appending agent output is serialized with every other workspace mutation.  Computing the
   * merged text inside the mutex prevents two connected agents from both writing a stale note.
   */
  public async appendToNote(
    workspaceId: string,
    nodeId: string,
    content: string
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const note = requireNode(workspace, nodeId);
      if (note.type !== "note") throw new Error("Only notes have editable content");
      const merged =
        note.content === "" || note.content.endsWith("\n")
          ? `${note.content}${content}`
          : `${note.content}\n${content}`;
      return this.persist(
        updateNode(
          workspace,
          nodeId,
          { content: merged } as Parameters<typeof updateNode>[2],
          this.dependencies()
        )
      );
    });
  }

  /** Checklist edits share the same serialized note path and never replace surrounding content. */
  public async setNoteChecklistItem(
    workspaceId: string,
    nodeId: string,
    line: number,
    checked: boolean
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const note = requireNode(workspace, nodeId);
      if (note.type !== "note") throw new Error("Only notes have editable content");
      const lines = note.content.split(/\r?\n/);
      const current = lines[line];
      if (current === undefined || !/^\s*- \[[ xX]\]/.test(current)) {
        throw new Error("The requested note line is not a checklist item");
      }
      lines[line] = current.replace(/^([\s]*- \[)[ xX](\])/, `$1${checked ? "x" : " "}$2`);
      return this.persist(
        updateNode(
          workspace,
          nodeId,
          { content: lines.join("\n") } as Parameters<typeof updateNode>[2],
          this.dependencies()
        )
      );
    });
  }

  public async deleteNode(workspaceId: string, nodeId: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
      if (node?.type === "terminal") {
        const session = this.options.supervisor
          .list()
          .find(
            (current) => current.workspaceId === workspaceId && current.terminalNodeId === node.id
          );
        if (session !== undefined) await this.options.agents.cleanupRole(session.id);
        await this.options.supervisor.releaseNode(workspaceId, node.id);
        await this.orchestratorBridge?.revokeMcpSessionsForTerminal?.(node.id);
      }
      const updated = removeNode(workspace, nodeId, this.dependencies());
      return this.persist(updated);
    });
  }

  public async deleteNodes(workspaceId: string, nodeIds: readonly string[]): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      let workspace = await this.getRaw(workspaceId);
      const selected = workspace.nodes.filter((node) => nodeIds.includes(node.id));
      for (const node of selected) {
        if (node.type === "terminal") {
          const session = this.options.supervisor
            .list()
            .find(
              (current) => current.workspaceId === workspaceId && current.terminalNodeId === node.id
            );
          if (session !== undefined) await this.options.agents.cleanupRole(session.id);
          await this.options.supervisor.releaseNode(workspaceId, node.id);
          await this.orchestratorBridge?.revokeMcpSessionsForTerminal?.(node.id);
        }
        workspace = removeNode(workspace, node.id, this.dependencies());
      }
      return this.persist(workspace);
    });
  }

  /**
   * Stops a recruited terminal without deleting its canvas node or operational history. Team
   * dismissal has a different retention contract from a user deleting a node.
   */
  public async dismissTeamTerminal(workspaceId: string, nodeId: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const terminal = requireTerminal(workspace, nodeId);
      const session = this.sessionForNode(workspaceId, terminal.id);
      if (session !== null)
        await this.options.agents.cleanupRole(session.id).catch(() => undefined);
      await this.options.supervisor.releaseNode(workspaceId, terminal.id);
      await this.orchestratorBridge?.revokeMcpSessionsForTerminal?.(terminal.id);
      let updated = workspace;
      for (const edge of workspace.edges.filter(
        (candidate) =>
          candidate.sourceNodeId === terminal.id || candidate.targetNodeId === terminal.id
      )) {
        updated = removeEdge(updated, edge.id, this.dependencies());
      }
      // Retaining the visual node must not retain worker authority: a later manual start cannot
      // recreate the bridge or an MCP session for an already dismissed member.
      updated = updateNode(
        updated,
        terminal.id,
        { orchestratorOwnerNodeId: undefined } as Partial<TerminalNode>,
        this.dependencies()
      );
      return this.persist(updated);
    });
  }

  public async addEdge(
    workspaceId: string,
    sourceNodeId: string,
    targetNodeId: string,
    capabilities: readonly EdgeCapability[] = []
  ): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () =>
      this.persist(
        addVisualEdge(
          await this.getRaw(workspaceId),
          sourceNodeId,
          targetNodeId,
          this.dependencies(),
          capabilities
        )
      )
    );
  }

  public async removeEdge(workspaceId: string, edgeId: string): Promise<Workspace> {
    return this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const edge = workspace.edges.find((candidate) => candidate.id === edgeId);
      const updated = await this.persist(removeEdge(workspace, edgeId, this.dependencies()));
      if (
        edge !== undefined &&
        edge.capabilities.some((capability) => capability.startsWith("portal-"))
      )
        await this.orchestratorBridge?.revokeMcpSessionsForTerminal?.(edge.sourceNodeId);
      return updated;
    });
  }

  public async startTerminal(workspaceId: string, nodeId: string): Promise<TerminalSession> {
    const workspace = await this.getRaw(workspaceId);
    const terminal = requireTerminal(workspace, nodeId);
    const active = this.options.supervisor
      .list()
      .find((session) => session.workspaceId === workspaceId && session.terminalNodeId === nodeId);
    if (
      active !== undefined &&
      ["starting", "running", "waiting-input", "stopping"].includes(active.state)
    )
      return active;
    if (active !== undefined) {
      await this.options.agents.cleanupRole(active.id).catch(() => undefined);
      await this.orchestratorBridge?.revoke(active.id).catch(() => undefined);
      this.options.supervisor.release(active.id);
    }
    const workingDirectory = await ensureChildDirectory(
      workspace.workingDirectory,
      terminal.workingDirectory
    );
    const sessionId = this.createId();
    try {
      const resolution = await this.options.agents.resolveLaunch(
        {
          workspaceId,
          terminalNodeId: nodeId,
          agentId: terminal.agentConfig.agentId,
          ...(terminal.agentConfig.presetId === undefined
            ? {}
            : { presetId: terminal.agentConfig.presetId }),
          ...(terminal.agentConfig.roleId === undefined
            ? {}
            : { roleId: terminal.agentConfig.roleId }),
          workingDirectory,
          ...(terminal.launchConfig.command === undefined
            ? {}
            : { executableOverride: terminal.launchConfig.command }),
          ...(terminal.launchConfig.args.length === 0
            ? {}
            : { argsOverride: terminal.launchConfig.args }),
          ...(Object.keys(terminal.launchConfig.env).length === 0
            ? {}
            : { envOverrides: terminal.launchConfig.env }),
          ...(terminal.launchConfig.processMode === "auto"
            ? {}
            : { processModeOverride: terminal.launchConfig.processMode })
        },
        workspace.permissions,
        sessionId
      );
      const receivesCompazioProtocol = ["claude-code", "codex", "opencode"].includes(
        terminal.agentConfig.agentId
      );
      const bridgeContext =
        receivesCompazioProtocol && this.orchestratorBridge !== null
          ? await this.orchestratorBridge.prepare({ workspace, terminal, sessionId })
          : undefined;
      // Provider bootstrap is part of the security boundary. In particular, Codex skill isolation
      // must fail closed instead of silently launching with unrelated host-global control planes.
      const mcpContext = await this.orchestratorBridge?.prepareAgentMcp?.({
        workspace,
        terminal,
        sessionId
      });
      const interactiveLaunch = withoutInteractiveInitialInput(
        withLaunchContext(resolution.launch, bridgeContext?.environment, mcpContext)
      );
      const session = await this.options.supervisor.start({
        sessionId,
        workspaceId,
        terminalNodeId: nodeId,
        launch: {
          ...interactiveLaunch,
          environment: {
            ...interactiveLaunch.environment,
            TERM: "xterm-256color",
            COLORTERM: "truecolor"
          }
        }
      });
      const rolePreparation = resolution.rolePreparation;
      if (rolePreparation !== undefined) {
        await this.mutateWorkspace(workspaceId, async () =>
          this.persist(
            recordRoleAssignment(
              await this.getRaw(workspaceId),
              {
                terminalNodeId: nodeId,
                roleId: rolePreparation.roleId,
                appliedRevision: rolePreparation.revision,
                appliedAt: this.now()
              },
              this.dependencies()
            )
          )
        );
      }
      return session;
    } catch (error) {
      await this.options.agents.cleanupRole(sessionId).catch(() => undefined);
      await this.orchestratorBridge?.revoke(sessionId).catch(() => undefined);
      throw error;
    }
  }

  /** @deprecated The active core executes agent work only through visible PTY terminals. */
  public async startBackgroundAgentTask(input: {
    readonly workspaceId: string;
    readonly terminalId: string;
    readonly prompt: string;
    readonly workspaceAccess?: "read" | "write";
  }): Promise<BackgroundAgentTask> {
    void input;
    throw new Error(
      "Workers ocultos estão desativados. Envie a solicitação ao terminal PTY visível conectado."
    );
  }

  public async writeTerminal(
    workspaceId: string,
    nodeId: string,
    sessionId: string,
    data: string
  ): Promise<void> {
    this.assertSessionOwnership(workspaceId, nodeId, sessionId);
    await this.options.supervisor.write(sessionId, data);
  }

  public async submitTerminalInput(
    workspaceId: string,
    nodeId: string,
    sessionId: string,
    data: string,
    followingData: readonly "\r"[]
  ): Promise<void> {
    this.assertSessionOwnership(workspaceId, nodeId, sessionId);
    await this.options.supervisor.writeSequenceWithOutputBarrier(sessionId, [
      data,
      ...followingData
    ]);
  }

  public resizeTerminal(
    workspaceId: string,
    nodeId: string,
    sessionId: string,
    cols: number,
    rows: number
  ): void {
    const active = this.sessionForNode(workspaceId, nodeId);
    // ResizeObserver can fire once after a process exits or after its node is deleted. It is a
    // stale renderer measurement, not an operational command, so it must not surface as noise.
    if (
      active?.id !== sessionId ||
      !["starting", "running", "waiting-input"].includes(active.state)
    )
      return;
    this.options.supervisor.resize(sessionId, cols, rows);
  }

  public async stopTerminal(
    workspaceId: string,
    nodeId: string,
    sessionId: string
  ): Promise<TerminalSession> {
    this.assertSessionOwnership(workspaceId, nodeId, sessionId);
    return this.options.supervisor.stop(sessionId);
  }

  public async restartTerminal(
    workspaceId: string,
    nodeId: string,
    sessionId: string
  ): Promise<TerminalSession> {
    this.assertSessionOwnership(workspaceId, nodeId, sessionId);
    await this.options.agents.cleanupRole(sessionId);
    await this.options.supervisor.releaseNode(workspaceId, nodeId);
    return this.startTerminal(workspaceId, nodeId);
  }

  public sessionForNode(workspaceId: string, nodeId: string): TerminalSession | null {
    return (
      this.options.supervisor
        .list()
        .find(
          (session) => session.workspaceId === workspaceId && session.terminalNodeId === nodeId
        ) ?? null
    );
  }

  /** Delivers a bounded, user-authorized file context only to a live terminal session. */
  public async sendContextToTerminal(
    workspaceId: string,
    nodeId: string,
    content: string
  ): Promise<void> {
    const terminal = requireTerminal(await this.getRaw(workspaceId), nodeId);
    const session = this.sessionForNode(workspaceId, terminal.id);
    if (session === null || !["running", "waiting-input"].includes(session.state)) {
      throw new Error("O terminal conectado não está pronto para receber contexto.");
    }
    await this.options.supervisor.write(session.id, `${content}\r`);
  }

  /** Trusted main-process delivery for an already-authorized visual connection. */
  public async deliverConnectionPrompt(
    workspaceId: string,
    nodeId: string,
    delivery: { readonly pasteFrame: string; readonly submit: "\r" }
  ): Promise<TerminalSession> {
    const terminal = requireTerminal(await this.getRaw(workspaceId), nodeId);
    if (terminal.agentConfig.agentId === "shell" || terminal.agentConfig.agentId === "custom") {
      throw new Error("Shell e terminais customizados não aceitam mensagens automáticas.");
    }
    const session = this.sessionForNode(workspaceId, terminal.id);
    if (session === null || !["running", "waiting-input"].includes(session.state)) {
      throw new Error("O terminal conectado não está pronto para receber mensagens.");
    }
    await this.options.supervisor.writeSequenceWithOutputBarrier(session.id, [
      delivery.pasteFrame,
      delivery.submit,
      ...(terminal.agentConfig.agentId === "opencode"
        ? [delivery.submit, delivery.submit]
        : terminal.agentConfig.agentId === "codex"
          ? [delivery.submit]
          : [])
    ]);
    return session;
  }

  public async assignTerminalRole(
    workspaceId: string,
    nodeId: string,
    roleId: string
  ): Promise<{ readonly workspace: Workspace; readonly session: TerminalSession | null }> {
    const updated = await this.mutateWorkspace(workspaceId, async () => {
      const workspace = await this.getRaw(workspaceId);
      const terminal = requireTerminal(workspace, nodeId);
      return this.persist(
        updateNode(
          workspace,
          nodeId,
          { agentConfig: { ...terminal.agentConfig, roleId } } as Partial<TerminalNode>,
          this.dependencies()
        )
      );
    });
    const active = this.sessionForNode(workspaceId, nodeId);
    if (active === null) return { workspace: updated, session: null };
    const session = await this.restartTerminal(workspaceId, nodeId, active.id);
    return { workspace: updated, session };
  }

  public async shutdown(): Promise<void> {
    shutdownTrace("workspace-shutdown-start");
    await this.options.supervisor.shutdown();
    this.workspaces.clear();
    this.workspaceMutationTails.clear();
    this.undoHistory.clear();
    this.redoHistory.clear();
    this.eventListeners.clear();
    shutdownTrace("workspace-shutdown-complete");
  }

  private async getRaw(workspaceId: string): Promise<Workspace> {
    const cached = this.workspaces.get(workspaceId);
    const workspace = cached ?? (await this.options.repository.get(workspaceId));
    const hydrated =
      this.options.notesAsMarkdown === true ? await hydrateNoteFiles(workspace) : workspace;
    if (hydrated !== workspace) await this.options.repository.save(hydrated);
    this.workspaces.set(workspaceId, hydrated);
    return hydrated;
  }

  private async persist(workspace: Workspace, recordHistory = true): Promise<Workspace> {
    const previous = this.workspaces.get(workspace.id);
    if (recordHistory && previous !== undefined && previous !== workspace) {
      this.undoHistory.set(
        workspace.id,
        [...(this.undoHistory.get(workspace.id) ?? []), previous].slice(-100)
      );
      this.redoHistory.delete(workspace.id);
    }
    if (this.options.notesAsMarkdown === true) await syncNoteFiles(workspace);
    await this.options.repository.save(workspace);
    this.workspaces.set(workspace.id, workspace);
    return this.decorate(workspace);
  }

  private async mutateWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceMutationTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.workspaceMutationTails.set(workspaceId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceMutationTails.get(workspaceId) === current) {
        this.workspaceMutationTails.delete(workspaceId);
      }
    }
  }

  private decorate(workspace: Workspace): Workspace {
    const sessionByNode = new Map(
      this.options.supervisor
        .list()
        .filter((session) => session.workspaceId === workspace.id)
        .map((session) => [session.terminalNodeId, session.id])
    );
    return {
      ...workspace,
      nodes: workspace.nodes.map((node) => {
        const sessionId = node.type === "terminal" ? sessionByNode.get(node.id) : undefined;
        return node.type === "terminal" && sessionId !== undefined ? { ...node, sessionId } : node;
      })
    };
  }

  private assertSessionOwnership(workspaceId: string, nodeId: string, sessionId: string): void {
    const session = this.options.supervisor.get(sessionId);
    if (session.workspaceId !== workspaceId || session.terminalNodeId !== nodeId) {
      throw new Error("Terminal session does not belong to this V2 node");
    }
  }

  private dependencies() {
    return { createId: this.createId, now: this.now };
  }
}

function withLaunchContext(
  launch: LaunchSpec,
  bridgeEnvironment: Readonly<Record<string, string>> | undefined,
  mcp:
    | {
        readonly environment: Readonly<Record<string, string>>;
        readonly args: readonly string[];
      }
    | undefined
): LaunchSpec {
  if (bridgeEnvironment === undefined && mcp === undefined) return launch;
  return {
    ...launch,
    // MCP options must precede the adapter's own arguments (for example Codex's startup `-c`).
    ...(mcp === undefined ? {} : { args: [...mcp.args, ...launch.args] }),
    environment: { ...launch.environment, ...bridgeEnvironment, ...mcp?.environment }
  };
}

/** Interactive terminal text is person-owned; a launch may not prefill or submit it. */
function withoutInteractiveInitialInput(launch: LaunchSpec): LaunchSpec {
  if (launch.initialInput === undefined) return launch;
  const { initialInput, ...interactiveLaunch } = launch;
  void initialInput;
  return interactiveLaunch;
}

async function hydrateNoteFiles(workspace: Workspace): Promise<Workspace> {
  let changed = false;
  const nodes: CanvasNode[] = [];
  for (const node of workspace.nodes) {
    if (node.type !== "note") {
      nodes.push(node);
      continue;
    }
    const path = await noteFilePath(workspace, node.id);
    const content = await readFile(path, "utf8").catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      await writeFileAtomically(path, node.content, {
        operation: "createWorkspaceNote",
        keepBackup: true
      });
      return node.content;
    });
    if (content === node.content) {
      nodes.push(node);
      continue;
    }
    changed = true;
    nodes.push({ ...node, content });
  }
  return changed ? { ...workspace, nodes } : workspace;
}

async function syncNoteFiles(workspace: Workspace): Promise<void> {
  await Promise.all(
    workspace.nodes
      .filter((node): node is Extract<CanvasNode, { type: "note" }> => node.type === "note")
      .map(async (note) => {
        const path = await noteFilePath(workspace, note.id);
        const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current === note.content) return;
        await writeFileAtomically(path, note.content, {
          operation: "saveWorkspaceNote",
          keepBackup: true
        });
      })
  );
}

async function noteFilePath(workspace: Workspace, noteId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(noteId)) throw new Error("Invalid note id");
  const root = await realpath(workspace.workingDirectory);
  const directory = join(root, ".compazio", "notes");
  await mkdir(directory, { recursive: true });
  const canonicalDirectory = await realpath(directory);
  const relativeDirectory = relative(root, canonicalDirectory);
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${String.fromCharCode(92)}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new Error("The Compazio note directory must stay inside the workspace");
  }
  return resolve(canonicalDirectory, `${noteId}.md`);
}

function requireNode(workspace: Workspace, nodeId: string): CanvasNode {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`Unknown node: ${nodeId}`);
  return node;
}

function requireTerminal(workspace: Workspace, nodeId: string): TerminalNode {
  const node = requireNode(workspace, nodeId);
  if (node.type !== "terminal") throw new Error(`Node ${nodeId} is not a terminal`);
  return node;
}

async function canonicalDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error("Working directory must be absolute");
  const canonical = await realpath(resolve(directory));
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Working directory must be a directory");
  return canonical;
}

async function ensureChildDirectory(
  workspaceDirectory: string,
  directory: string
): Promise<string> {
  const canonical = await canonicalDirectory(directory);
  const relativePath = relative(workspaceDirectory, canonical);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${String.fromCharCode(92)}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Terminal working directory must stay inside its workspace directory");
  }
  return canonical;
}

function shutdownTrace(stage: string, metadata: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.COMPAZIO_V2_SHUTDOWN_TRACE !== "1") return;
  console.info(
    `COMPAZIO_SHUTDOWN_TRACE ${JSON.stringify({ stage, at: new Date().toISOString(), ...metadata })}`
  );
}
