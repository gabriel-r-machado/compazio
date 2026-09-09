import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow
} from "@xyflow/react";
import type { NodeChange } from "@xyflow/react";

import type {
  AgentConversation,
  AppLocale,
  AppTheme,
  CanvasAgentRole,
  CanvasHandoff,
  CanvasContextSourceKind,
  CanvasNodeType,
  EdgeContract,
  GitProjectDto,
  HandoffDraftContent,
  ProjectBranchDto,
  TerminalAdapterId,
  TerminalSession,
  AgentAdapterId,
  AgentAssignmentPreset,
  AgentDescriptor,
  WorkspaceDto,
  WorkflowDryRunResponse,
  WorkflowDraft,
  WorkflowDraftCommandResult,
  WorkflowRunEvent,
  WorkflowRunGraphDto,
  WorkflowRunSnapshotDto
} from "@forgedeck/schemas";
import { canvasContextSourceSchema, contextInclusionSchema } from "@forgedeck/schemas";
import { blueprintToPrTemplate, bugfixTemplate } from "@forgedeck/workflow";

import {
  adaptTemplateToAvailableAgents,
  createCanvasReplacement,
  createDefaultCanvas,
  toCanvasSnapshot,
  useCanvasStore
} from "./canvas-store";
import type { CanvasTemplateId, ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";
import { copyCanvasSelection, pasteCanvasSelection } from "./canvas-clipboard";
import type { CanvasClipboard } from "./canvas-clipboard";
import { contextMenuNodeId } from "./context-action-target";
import {
  AgentNode,
  ArtifactNode,
  CommentNode,
  ContextSourceNode,
  FrameNode,
  GateNode,
  NoteNode,
  ShapeNode,
  TaskNode,
  TerminalNode
} from "./canvas-nodes";
import { isEditableKeyboardTarget, nextKeyboardNodeId } from "./accessibility";
import {
  CanvasContextMenu,
  CanvasEdgeContractDialog,
  CanvasEditDialog,
  CanvasHandoffDialog,
  CanvasHandoffDestinationDialog,
  CanvasHandoffTargetDialog,
  CanvasRoleDialog
} from "./canvas-context-menu";
import type { CanvasMenuAction } from "./canvas-context-menu";
import { organizeCanvasNodes } from "./canvas-layout";
import { CommandPalette } from "./command-palette";
import { ContractEdge } from "./contract-edge";
import { I18nProvider, useI18n } from "./i18n";
import { CompazioLogo, Icon } from "./icons";
import type { IconName } from "./icons";
import { getAddNodePreset } from "./node-presets";
import type { AddNodeKind } from "./node-presets";
import { AttachmentTooLargeError, importContextFile } from "./context-file-import";
import { formatByteSize } from "./byte-size";
import { draftNodeIdsForDeletion } from "./draft-node-deletion";
import { createManualWorkflowPlan } from "./manual-workflow-plan";
import { projectWorkflowRunToCanvas } from "./workflow-run-projection";
import { buildCanvasEdgeRunOverlay, buildCanvasRunOverlay } from "./workflow-run-overlay";
import type { CanvasEdgeRunOverlay, CanvasRunOverlay } from "./workflow-run-overlay";
import { projectWorkspaceTerminalSessions } from "./workspace-terminal-sessions";
import { AgentConversationEdgeContext } from "./agent-conversation-context";
import { projectAgentConversations } from "./agent-conversation-projection";
import { WorkflowRunEdgeContext, WorkflowRunNodeContext } from "./workflow-run-node-context";
import { WorkflowNodeInspector } from "./workflow-node-inspector";
import { WorkflowApprovalPanel } from "./workflow-approval-panel";
import { buildNoteExecution } from "./note-execution";
import type { NoteExecutionDirection } from "./note-execution";
import { isTerminalBackedNode } from "./node-terminal";
import { nodeScreenPlacement } from "./node-placement";
import { LocalSettingsPanel, RunHistoryPanel } from "./runtime-panels";
import { ActivityPanel } from "./activity-panel";
import { HandoffHistoryPanel } from "./handoff-history";
import { AgentInboxPanel } from "./agent-inbox";
import { PromptComposer } from "./prompt-composer";
import { composerBlockedKey, composerMentionsFor } from "./prompt-composition";
import { TerminalNodeContext } from "./terminal-node-context";
import { ThemeProvider, useTheme } from "./theme";
import { terminalHandoffInput, terminalNeedsLogin } from "./terminal-handoff";
import {
  hasTerminalDraftIntent,
  terminalDraftRectangle,
  terminalGeometryFromDrag
} from "./terminal-draft";
import type { DraftPoint } from "./terminal-draft";
import { toUserFacingErrorMessage } from "./user-facing-error";
import {
  findWorkspaceForProject,
  replaceWorkspace,
  selectInitialWorkspace
} from "./workspace-state";

type PingState = "checking" | "ready" | "failed";
type WorkspaceSection = "canvas" | "runs" | "settings";
type WorkspaceSort = "manual" | "name" | "updated";

type CanvasContextTarget =
  | { readonly kind: "node"; readonly id: string; readonly x: number; readonly y: number }
  | { readonly kind: "edge"; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly kind: "selection";
      readonly ids: readonly string[];
      readonly x: number;
      readonly y: number;
    };
type CanvasEditTarget =
  | { readonly kind: "node"; readonly id: string; readonly value: string }
  | { readonly kind: "note-content"; readonly id: string; readonly value: string }
  | { readonly kind: "context-inclusion"; readonly id: string; readonly value: string }
  | { readonly kind: "progress"; readonly id: string; readonly value: string }
  | { readonly kind: "blocker"; readonly id: string; readonly value: string }
  | {
      readonly kind: "context-source";
      readonly id: string;
      readonly sourceKind: CanvasContextSourceKind;
      readonly value: string;
    }
  | { readonly kind: "mission"; readonly value: string };

function terminalOwnsKeyboard(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(
    element?.closest(".terminal-viewport, .xterm, .xterm-helper-textarea") ??
    document.activeElement?.closest(".terminal-viewport, .xterm, .xterm-helper-textarea")
  );
}

function isContextPolicyNode(type: CanvasNodeType): boolean {
  return [
    "note",
    "artifact",
    "text",
    "link",
    "file",
    "folder",
    "image",
    "drawing",
    "page"
  ].includes(type);
}

function selectedNodeIdsFromSurface(surface: HTMLElement): readonly string[] {
  return [...surface.querySelectorAll<HTMLElement>(".react-flow__node.selected")]
    .map((node) => node.dataset.id)
    .filter((id): id is string => id !== undefined);
}
interface TerminalDraftState {
  readonly startClient: DraftPoint;
  readonly currentClient: DraftPoint;
  readonly startLocal: DraftPoint;
  readonly currentLocal: DraftPoint;
}
interface HandoffReviewState {
  readonly record: CanvasHandoff;
  readonly rawOutput: string;
  readonly destinationOutput?: string;
  readonly busy: boolean;
  readonly error: string | null;
}
interface HandoffRoute {
  readonly edgeId: string;
  readonly targetNodeId: string;
  readonly targetTitle: string;
}
interface HandoffRouteChoiceState {
  readonly sourceNodeId: string;
  readonly routes: readonly HandoffRoute[];
}
interface HandoffDestinationChoiceState {
  readonly content: HandoffDraftContent;
}
interface WorkspaceContextTarget {
  readonly workspaceId: string | null;
  readonly x: number;
  readonly y: number;
}
interface AgentInboxTarget {
  readonly nodeId: string;
  readonly title: string;
}

const nodeTypes = {
  terminal: TerminalNode,
  agent: AgentNode,
  note: NoteNode,
  artifact: ArtifactNode,
  text: ContextSourceNode,
  link: ContextSourceNode,
  file: ContextSourceNode,
  folder: ContextSourceNode,
  image: ContextSourceNode,
  drawing: ContextSourceNode,
  page: ContextSourceNode,
  shape: ShapeNode,
  frame: FrameNode,
  comment: CommentNode,
  task: TaskNode,
  gate: GateNode
};

const edgeTypes = { contract: ContractEdge };

const sectionTranslationKeys = {
  canvas: "menu.canvas",
  runs: "menu.runs",
  settings: "menu.settings"
} as const;

const sectionIcons: Record<WorkspaceSection, IconName> = {
  canvas: "canvas",
  runs: "runs",
  settings: "settings"
};

const workspaceSections = ["canvas", "runs", "settings"] as const;
let canvasClipboard: CanvasClipboard | null = null;

export function App() {
  const [locale, setLocale] = useState<AppLocale>("pt-BR");
  const [theme, setTheme] = useState<AppTheme>("dark");
  useEffect(() => {
    let active = true;
    void window.forgedeck.settings
      .get()
      .then((settings) => {
        if (active) {
          setLocale(settings.locale);
          setTheme(settings.theme);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const updateLocale = useCallback(async (nextLocale: AppLocale) => {
    const settings = await window.forgedeck.settings.update({ locale: nextLocale });
    setLocale(settings.locale);
  }, []);
  const updateTheme = useCallback(async (nextTheme: AppTheme) => {
    const settings = await window.forgedeck.settings.update({ theme: nextTheme });
    setTheme(settings.theme);
  }, []);

  return (
    <I18nProvider locale={locale} onLocaleChange={updateLocale}>
      <ThemeProvider theme={theme} setTheme={updateTheme}>
        <ReactFlowProvider>
          <CanvasWorkspace />
        </ReactFlowProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

function CanvasWorkspace() {
  const { t } = useI18n();
  const { setTheme, theme } = useTheme();
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const viewport = useCanvasStore((state) => state.viewport);
  const mission = useCanvasStore((state) => state.mission);
  const executionProfile = useCanvasStore((state) => state.executionProfile);
  const setExecutionProfile = useCanvasStore((state) => state.setExecutionProfile);
  const loaded = useCanvasStore((state) => state.loaded);
  const dirty = useCanvasStore((state) => state.dirty);
  const saveError = useCanvasStore((state) => state.saveError);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const paletteOpen = useCanvasStore((state) => state.paletteOpen);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connect = useCanvasStore((state) => state.connect);
  const addNode = useCanvasStore((state) => state.addNode);
  const createFrame = useCanvasStore((state) => state.createFrame);
  const duplicateNode = useCanvasStore((state) => state.duplicateNode);
  const removeNode = useCanvasStore((state) => state.removeNode);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const disconnectNode = useCanvasStore((state) => state.disconnectNode);
  const disconnectNodes = useCanvasStore((state) => state.disconnectNodes);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const updateEdgeContract = useCanvasStore((state) => state.updateEdgeContract);
  const updateNode = useCanvasStore((state) => state.updateNode);
  const setMission = useCanvasStore((state) => state.setMission);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const setPaletteOpen = useCanvasStore((state) => state.setPaletteOpen);
  const insertGraph = useCanvasStore((state) => state.insertGraph);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const clearWorkflow = useCanvasStore((state) => state.clearWorkflow);
  const canUndo = useCanvasStore((state) => state.historyPast.length > 0);
  const canRedo = useCanvasStore((state) => state.historyFuture.length > 0);
  const load = useCanvasStore((state) => state.load);
  const mergeExternalNode = useCanvasStore((state) => state.mergeExternalNode);
  const removeExternalNode = useCanvasStore((state) => state.removeExternalNode);
  const mergeExternalEdge = useCanvasStore((state) => state.mergeExternalEdge);
  const removeExternalEdge = useCanvasStore((state) => state.removeExternalEdge);
  const [pingState, setPingState] = useState<PingState>("checking");
  const [dryRun, setDryRun] = useState<WorkflowDryRunResponse | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [canvasHint, setCanvasHint] = useState<string | null>(null);
  const [section, setSection] = useState<WorkspaceSection>("canvas");
  const [projects, setProjects] = useState<readonly GitProjectDto[]>([]);
  const [projectBranches, setProjectBranches] = useState<readonly ProjectBranchDto[]>([]);
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [branchDirty, setBranchDirty] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchMenuPosition, setBranchMenuPosition] = useState({ left: 8, top: 64 });
  const [branchBusy, setBranchBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceDto[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [projectPickerBusy, setProjectPickerBusy] = useState(false);
  const [gitInitializationDirectory, setGitInitializationDirectory] = useState<string | null>(null);
  const [gitInitializationBusy, setGitInitializationBusy] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(true);
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [workspaceSort, setWorkspaceSort] = useState<WorkspaceSort>("manual");
  const [workspaceContextTarget, setWorkspaceContextTarget] =
    useState<WorkspaceContextTarget | null>(null);
  const [contextTarget, setContextTarget] = useState<CanvasContextTarget | null>(null);
  const [editTarget, setEditTarget] = useState<CanvasEditTarget | null>(null);
  const [roleTarget, setRoleTarget] = useState<ForgeFlowNode | null>(null);
  const [edgeContractTarget, setEdgeContractTarget] = useState<ForgeFlowEdge | null>(null);
  const [handoffReview, setHandoffReview] = useState<HandoffReviewState | null>(null);
  const [handoffDestinationChoice, setHandoffDestinationChoice] =
    useState<HandoffDestinationChoiceState | null>(null);
  const [handoffRouteChoice, setHandoffRouteChoice] = useState<HandoffRouteChoiceState | null>(
    null
  );
  const [handoffHistory, setHandoffHistory] = useState<readonly CanvasHandoff[]>([]);
  const [agentConversations, setAgentConversations] = useState<readonly AgentConversation[]>([]);
  const [handoffHistoryOpen, setHandoffHistoryOpen] = useState(false);
  const [agentInboxTarget, setAgentInboxTarget] = useState<AgentInboxTarget | null>(null);
  const [composerNodeId, setComposerNodeId] = useState<string | null>(null);
  /**
   * One in-progress instruction per terminal, kept while the box is closed.
   *
   * A mission is written over several minutes, and the writing usually pauses to go read something
   * else on the canvas. Losing the paragraph to that detour is the reason people give up and type
   * into the PTY instead. Drafts live in memory only: an unsent instruction is not canvas state.
   */
  const [composerDrafts, setComposerDrafts] = useState<Readonly<Record<string, string>>>({});
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [pendingConnectionSourceId, setPendingConnectionSourceId] = useState<string | null>(null);
  const [edgeCutMode, setEdgeCutMode] = useState(false);
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null);
  /** Live agent catalog. Held in memory only — availability is never written into a document. */
  const [agentDescriptors, setAgentDescriptors] = useState<readonly AgentDescriptor[]>([]);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [canvasMoreOpen, setCanvasMoreOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [terminalClearEpochs, setTerminalClearEpochs] = useState<Readonly<Record<string, number>>>(
    {}
  );
  const [terminalDraft, setTerminalDraft] = useState<TerminalDraftState | null>(null);
  const [pendingNodePosition, setPendingNodePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<
    Readonly<Record<string, TerminalSession>>
  >({});
  const [nodeSessionIds, setNodeSessionIds] = useState<Readonly<Record<string, string>>>({});
  const [terminalErrors, setTerminalErrors] = useState<Readonly<Record<string, string>>>({});
  const [terminalStartingNodeIds, setTerminalStartingNodeIds] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [activeTerminalNodeIds, setActiveTerminalNodeIds] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [activeHandoffEdgeIds, setActiveHandoffEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const terminalNodesToStart = useRef(new Set<string>());
  const terminalActivityTimeouts = useRef(new Map<string, number>());
  const handoffActivityTimeouts = useRef(new Map<string, number>());
  const terminalDraftRef = useRef<TerminalDraftState | null>(null);
  const suppressPaneContextMenu = useRef(false);
  const selectedNodeIdsRef = useRef<readonly string[]>([]);
  const flowSurfaceRef = useRef<HTMLElement>(null);
  const nodePlacementOrdinal = useRef(0);
  // Bumped on every workspace switch/close so a stale async load/response can recognize it's no
  // longer current and skip applying its snapshot, even if it resolves after a newer switch.
  const workspaceGenerationRef = useRef(0);
  const reactFlow = useReactFlow<ForgeFlowNode, ForgeFlowEdge>();
  const visibleOperationError =
    operationError === null
      ? null
      : toUserFacingErrorMessage(operationError, t("composer.commandFailed"));

  useEffect(() => {
    let active = true;
    void (async () => {
      const [, defaultCanvas, projectResponse, workspaceResponse, settings] = await Promise.all([
        window.forgedeck.system.ping({ requestId: crypto.randomUUID() }),
        window.forgedeck.canvases.load({ canvasId: "default" }),
        window.forgedeck.projects.list(),
        window.forgedeck.workspaces.list(),
        window.forgedeck.settings.get()
      ]);
      let nextWorkspaces = workspaceResponse;
      if (nextWorkspaces.length === 0) {
        const legacyProjectId = readLegacyActiveProjectId(projectResponse);
        if (legacyProjectId !== null) {
          const recovered = await window.forgedeck.workspaces.create({
            projectId: legacyProjectId,
            adoptLegacyCanvas: defaultCanvas.snapshot !== null
          });
          nextWorkspaces = [recovered];
          window.localStorage.removeItem("forgedeck.active-project-id");
        }
      }
      const initialWorkspace = selectInitialWorkspace(nextWorkspaces, settings.activeWorkspaceId);
      const canvasResponse =
        initialWorkspace === null
          ? defaultCanvas
          : initialWorkspace.canvasId === "default"
            ? defaultCanvas
            : await window.forgedeck.canvases.load({ canvasId: initialWorkspace.canvasId });
      return { canvasResponse, initialWorkspace, nextWorkspaces, projectResponse };
    })()
      .then(({ canvasResponse, initialWorkspace, nextWorkspaces, projectResponse }) => {
        if (!active) {
          return;
        }
        document.documentElement.dataset.ipcStatus = "ok";
        setPingState("ready");
        const snapshot = canvasResponse.snapshot ?? createDefaultCanvas();
        load(snapshot, canvasResponse.snapshot === null);
        void reactFlow.setViewport(snapshot.viewport, { duration: 0 });
        setProjects(projectResponse);
        setWorkspaces(nextWorkspaces);
        setActiveWorkspaceId(initialWorkspace?.id ?? null);
        if (initialWorkspace !== null) {
          void window.forgedeck.settings
            .update({ activeWorkspaceId: initialWorkspace.id })
            .catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          document.documentElement.dataset.ipcStatus = "failed";
          setPingState("failed");
          setOperationError(error instanceof Error ? error.message : t("startup.handshakeError"));
        }
      });
    return () => {
      active = false;
    };
  }, [bootAttempt, load, reactFlow, t]);

  const flushCanvas = useCanvasAutosave(loaded);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces]
  );
  const activeProjectId = activeWorkspace?.projectId ?? null;
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects]
  );
  const availableExecutionAgentIds = useMemo(
    () =>
      agentDescriptors
        .filter(
          (agent) =>
            agent.available &&
            agent.authenticated !== false &&
            agent.hasImplementation &&
            agent.supportsExecution
        )
        .map((agent) => agent.id),
    [agentDescriptors]
  );
  useEffect(() => {
    const workspaceId = activeWorkspace?.id;
    setTerminalSessions({});
    setNodeSessionIds({});
    setTerminalErrors({});
    setTerminalStartingNodeIds(new Set());
    setActiveTerminalNodeIds(new Set());
    if (workspaceId === undefined) return;
    let active = true;
    void window.forgedeck.terminals
      .list()
      .then((sessions) => {
        if (!active) return;
        const nodeIds = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
        const projection = projectWorkspaceTerminalSessions(sessions, workspaceId, nodeIds);
        setTerminalSessions(projection.sessions);
        setNodeSessionIds(projection.nodeSessionIds);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [activeWorkspace?.id]);
  const loadHandoffHistory = useCallback(async () => {
    if (activeWorkspace === null) {
      setHandoffHistory([]);
      return;
    }
    try {
      setHandoffHistory(
        await window.forgedeck.handoffs.list({ canvasId: activeWorkspace.canvasId, limit: 100 })
      );
    } catch (error: unknown) {
      setOperationError(toUserFacingErrorMessage(error, t("handoff.historyFailed")));
    }
  }, [activeWorkspace, t]);
  useEffect(() => {
    void loadHandoffHistory();
  }, [loadHandoffHistory]);
  useEffect(() => {
    setHandoffReview(null);
    setHandoffRouteChoice(null);
    setHandoffHistoryOpen(false);
    setAgentInboxTarget(null);
  }, [activeWorkspaceId]);
  useEffect(() => {
    // Defensive, centralized guarantee: no matter which code path clears activeWorkspaceId, the
    // canvas and its ephemeral workflow state must be empty whenever there is no active workspace —
    // not just in the one call site that happens to remember to reset them.
    if (activeWorkspaceId !== null) return;
    load(createDefaultCanvas(), false);
    selectNode(null);
    setEditTarget(null);
    setWorkflowDraft(null);
  }, [activeWorkspaceId, load, selectNode]);
  useEffect(() => {
    if (activeProject === null) {
      return;
    }
    let active = true;
    void window.forgedeck.projects
      .listBranches({ projectId: activeProject.id })
      .then((response) => {
        if (!active) return;
        setProjectBranches(response.branches);
        setActiveBranch(response.currentBranch);
        setBranchDirty(response.dirty);
      })
      .catch((error: unknown) => {
        if (active) {
          setOperationError(error instanceof Error ? error.message : t("branch.loadFailed"));
        }
      });
    return () => {
      active = false;
    };
  }, [activeProject, t]);
  const openWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.isOpen),
    [workspaces]
  );
  const filteredOpenWorkspaces = useMemo(() => {
    const query = workspaceFilter.trim().toLocaleLowerCase();
    const filtered =
      query.length === 0
        ? [...openWorkspaces]
        : openWorkspaces.filter((workspace) => {
            const project = projects.find((entry) => entry.id === workspace.projectId);
            return `${workspace.title} ${project?.name ?? ""} ${project?.defaultBranch ?? ""}`
              .toLocaleLowerCase()
              .includes(query);
          });
    if (workspaceSort === "name") {
      return filtered.sort((left, right) => {
        const leftName = projects.find((entry) => entry.id === left.projectId)?.name ?? left.title;
        const rightName =
          projects.find((entry) => entry.id === right.projectId)?.name ?? right.title;
        return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
      });
    }
    if (workspaceSort === "updated") {
      return filtered.sort((left, right) => {
        const leftUpdated =
          projects.find((entry) => entry.id === left.projectId)?.updatedAt ?? left.updatedAt;
        const rightUpdated =
          projects.find((entry) => entry.id === right.projectId)?.updatedAt ?? right.updatedAt;
        return rightUpdated.localeCompare(leftUpdated);
      });
    }
    return filtered;
  }, [openWorkspaces, projects, workspaceFilter, workspaceSort]);
  const terminalSessionsByNode = useMemo(() => {
    const result: Record<string, TerminalSession> = {};
    for (const [nodeId, sessionId] of Object.entries(nodeSessionIds)) {
      const session = terminalSessions[sessionId];
      if (session !== undefined) {
        result[nodeId] = session;
      }
    }
    return result;
  }, [nodeSessionIds, terminalSessions]);
  const renderedEdges = useMemo(
    () =>
      edges.map((edge) =>
        activeHandoffEdgeIds.has(edge.id)
          ? { ...edge, className: `${edge.className ?? ""} is-handoff-active`.trim() }
          : edge
      ),
    [activeHandoffEdgeIds, edges]
  );
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );
  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const resolveSelectedNodeIds = useCallback(() => {
    const liveIds = new Set(nodes.map((node) => node.id));
    const flowSelection = selectedNodeIdsRef.current.filter((id) => liveIds.has(id));
    return flowSelection.length > 0 ? flowSelection : selectedNodes.map((node) => node.id);
  }, [nodes, selectedNodes]);
  const terminalDraftPreview = useMemo(
    () =>
      terminalDraft === null
        ? null
        : terminalDraftRectangle(terminalDraft.startLocal, terminalDraft.currentLocal),
    [terminalDraft]
  );

  useEffect(() => {
    if (!loaded || operationError === null) return;
    const timeout = window.setTimeout(() => setOperationError(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [loaded, operationError]);

  useEffect(() => {
    if (canvasHint === null) return;
    const timeout = window.setTimeout(() => setCanvasHint(null), 3_500);
    return () => window.clearTimeout(timeout);
  }, [canvasHint]);

  useEffect(() => {
    return window.forgedeck.terminals.onEvent((event) => {
      if (event.type === "session.state") {
        if (
          event.session.workspaceId !== undefined &&
          event.session.workspaceId !== activeWorkspace?.id
        ) {
          return;
        }
        setTerminalSessions((current) => ({ ...current, [event.session.id]: event.session }));
        const directCanvasNodeId = event.session.canvasNodeId;
        if (directCanvasNodeId !== undefined) {
          setNodeSessionIds((current) => ({
            ...current,
            [directCanvasNodeId]: event.session.id
          }));
        } else if (event.session.workflowNodeId !== undefined) {
          const workflowNodeId = event.session.workflowNodeId;
          const canvasNodeId =
            useCanvasStore
              .getState()
              .nodes.find((node) => node.data.workflowNodeId === workflowNodeId)?.id ??
            workflowNodeId;
          setNodeSessionIds((current) => ({
            ...current,
            [canvasNodeId]: event.session.id
          }));
        }
        return;
      }
      if (event.type !== "session.output") return;
      const nodeId = Object.entries(nodeSessionIds).find(
        ([, sessionId]) => sessionId === event.sessionId
      )?.[0];
      if (nodeId === undefined) return;
      const previousTimeout = terminalActivityTimeouts.current.get(nodeId);
      if (previousTimeout !== undefined) window.clearTimeout(previousTimeout);
      setActiveTerminalNodeIds((current) => new Set([...current, nodeId]));
      const timeout = window.setTimeout(() => {
        terminalActivityTimeouts.current.delete(nodeId);
        setActiveTerminalNodeIds(
          (current) => new Set([...current].filter((entry) => entry !== nodeId))
        );
      }, 900);
      terminalActivityTimeouts.current.set(nodeId, timeout);
    });
  }, [activeWorkspace?.id, nodeSessionIds]);

  // An agent dismissed or reassigned by another agent. The runtime already applied it durably; the
  // canvas reflects it without waiting for a reload.
  useEffect(() => {
    return window.forgedeck.agentLifecycle.onEvent((event) => {
      if (useCanvasStore.getState().canvasId !== event.command.canvasId) return;
      if (event.removedNodeId !== null) {
        const removedNodeId = event.removedNodeId;
        removeExternalNode(removedNodeId, event.canvasRevision);
        setNodeSessionIds((current) =>
          Object.fromEntries(Object.entries(current).filter(([nodeId]) => nodeId !== removedNodeId))
        );
        return;
      }
      if (event.node !== null) {
        mergeExternalNode(event.node, event.canvasRevision);
      }
    });
  }, [mergeExternalNode, removeExternalNode]);

  useEffect(() => {
    return window.forgedeck.agentSpawns.onEvent((event) => {
      if (useCanvasStore.getState().canvasId !== event.spawn.canvasId) return;
      mergeExternalNode(event.node, event.canvasRevision);
      if (event.spawn.sessionId !== null) {
        void window.forgedeck.terminals.list().then((sessions) => {
          const session = sessions.find((entry) => entry.id === event.spawn.sessionId);
          if (session === undefined) return;
          setTerminalSessions((current) => ({ ...current, [session.id]: session }));
          setNodeSessionIds((current) => ({ ...current, [event.spawn.nodeId]: session.id }));
        });
      }
      if (event.spawn.status === "failed") {
        setTerminalErrors((current) => ({
          ...current,
          [event.spawn.nodeId]: t("canvas.terminalConnectFailed")
        }));
      }
    });
  }, [mergeExternalNode, t]);

  useEffect(() => {
    return window.forgedeck.artifacts.onEvent((event) => {
      if (useCanvasStore.getState().canvasId !== event.canvasId) return;
      mergeExternalNode(event.node, event.canvasRevision);
    });
  }, [mergeExternalNode]);

  useEffect(() => {
    return window.forgedeck.notes.onEvent((event) => {
      if (useCanvasStore.getState().canvasId !== event.note.canvasId) return;
      mergeExternalNode(event.node, event.canvasRevision);
    });
  }, [mergeExternalNode]);

  useEffect(() => {
    return window.forgedeck.connections.onEvent((event) => {
      if (useCanvasStore.getState().canvasId !== event.canvasId) return;
      if (event.type === "connection_created") {
        mergeExternalEdge(event.edge, event.canvasRevision);
      } else {
        removeExternalEdge(event.connection.connectionId, event.canvasRevision);
      }
    });
  }, [mergeExternalEdge, removeExternalEdge]);

  useEffect(() => {
    return window.forgedeck.workspaceActivity.onEvent((event) => {
      if (event.workspaceId !== activeWorkspace?.id || event.subject !== "handoff") return;
      void loadHandoffHistory();
    });
  }, [activeWorkspace?.id, loadHandoffHistory]);

  // Agent-to-agent exchanges the canvas draws on the edge that connects the two terminals. Refreshed
  // from the durable store on the same redacted activity signal the rest of the canvas uses — never
  // guessed from terminal output, and never held as optimistic UI state.
  const loadAgentConversations = useCallback(async () => {
    const workspaceId = activeWorkspace?.id;
    if (workspaceId === undefined) {
      setAgentConversations([]);
      return;
    }
    try {
      setAgentConversations(
        await window.forgedeck.agentMessages.listConversations({ workspaceId })
      );
    } catch {
      // A conversation overlay is decoration over durable records; failing to read it must never
      // take the canvas down. The next activity event retries.
    }
  }, [activeWorkspace?.id]);

  useEffect(() => {
    void loadAgentConversations();
  }, [loadAgentConversations]);

  useEffect(() => {
    return window.forgedeck.workspaceActivity.onEvent((event) => {
      if (event.workspaceId !== activeWorkspace?.id || event.subject !== "message") return;
      void loadAgentConversations();
    });
  }, [activeWorkspace?.id, loadAgentConversations]);

  useEffect(
    () => () => {
      for (const timeout of terminalActivityTimeouts.current.values()) {
        window.clearTimeout(timeout);
      }
      for (const timeout of handoffActivityTimeouts.current.values()) {
        window.clearTimeout(timeout);
      }
    },
    []
  );

  useEffect(() => {
    const exitTransientCanvasModes = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        terminalOwnsKeyboard(event.target) ||
        isEditableKeyboardTarget(event.target as HTMLElement | null)
      ) {
        return;
      }
      setFocusedNodeId(null);
      setPendingConnectionSourceId(null);
      setEdgeCutMode(false);
      setCanvasHint(null);
      setContextTarget(null);
      setBranchMenuOpen(false);
      setTemplateMenuOpen(false);
    };
    window.addEventListener("keydown", exitTransientCanvasModes);
    return () => window.removeEventListener("keydown", exitTransientCanvasModes);
  }, []);

  const fitView = useCallback(() => {
    void reactFlow.fitView({ padding: 0.2, duration: 220 });
    setPaletteOpen(false);
  }, [reactFlow, setPaletteOpen]);

  const executeDryRun = useCallback(
    (templateId: "blueprint-to-pr" | "bugfix") => {
      const workflow = templateId === "blueprint-to-pr" ? blueprintToPrTemplate : bugfixTemplate;
      setPaletteOpen(false);
      setOperationError(null);
      void window.forgedeck.workflows
        .dryRun({ workflow, grantedPermissions: workflow.permissions })
        .then(setDryRun)
        .catch((error: unknown) =>
          setOperationError(error instanceof Error ? error.message : t("canvas.invalid"))
        );
    },
    [setPaletteOpen, t]
  );

  const openAddMenu = useCallback(
    (position?: { x: number; y: number }) => {
      if (activeProject === null) {
        setOperationError(t("canvas.openProjectFirst"));
        return;
      }
      setPendingNodePosition(position ?? null);
      setPaletteOpen(true);
    },
    [activeProject, setPaletteOpen, t]
  );

  const closeAddMenu = useCallback(() => {
    setPendingNodePosition(null);
    setPaletteOpen(false);
  }, [setPaletteOpen]);

  const applyCanvasTemplate = useCallback(
    async (templateId: CanvasTemplateId) => {
      if (activeWorkspace === null || activeProject === null) {
        setOperationError(t("canvas.openProjectFirst"));
        return;
      }
      if (
        nodes.length > 0 &&
        !window.confirm(
          "Aplicar este modelo substitui o canvas atual. Terminais ativos serão interrompidos. Continuar?"
        )
      ) {
        return;
      }
      const sessionIds = Object.values(nodeSessionIds);
      const replacement = {
        ...adaptTemplateToAvailableAgents(
          createCanvasReplacement(templateId, useCanvasStore.getState().revision),
          availableExecutionAgentIds
        ),
        id: activeWorkspace.canvasId
      };
      load(replacement, true);
      setNodeSessionIds({});
      setTerminalSessions({});
      setTerminalErrors({});
      setTerminalStartingNodeIds(new Set());
      setTemplateMenuOpen(false);
      setOperationError(null);
      setCanvasHint(
        templateId === "empty"
          ? "Canvas vazio aplicado."
          : `Modelo ${replacement.title} aplicado. Revise os agentes e inicie o fluxo.`
      );
      try {
        // Persist the visual replacement before waiting for process shutdown. Switching workspaces
        // while a terminal was stopping used to reload the old canvas and resurrect removed nodes.
        await flushCanvas();
        await Promise.allSettled(
          sessionIds.map((sessionId) => window.forgedeck.terminals.cancel({ sessionId }))
        );
        await reactFlow.setViewport(replacement.viewport, { duration: 0 });
      } catch (error: unknown) {
        setOperationError(
          toUserFacingErrorMessage(error, "Não foi possível aplicar o modelo no canvas.")
        );
      }
    },
    [
      activeProject,
      activeWorkspace,
      availableExecutionAgentIds,
      flushCanvas,
      load,
      nodeSessionIds,
      nodes.length,
      reactFlow,
      t
    ]
  );

  const nextVisibleNodePosition = useCallback(() => {
    const screenPosition = nodeScreenPlacement(
      window.innerWidth,
      window.innerHeight,
      nodePlacementOrdinal.current
    );
    nodePlacementOrdinal.current += 1;
    return reactFlow.screenToFlowPosition(screenPosition);
  }, [reactFlow]);

  const addNodeFromMenu = useCallback(
    (kind: AddNodeKind) => {
      const nodeId = addNode(kind, pendingNodePosition ?? nextVisibleNodePosition());
      queueTerminalStart(kind, nodeId, terminalNodesToStart.current);
      setPendingNodePosition(null);
    },
    [addNode, nextVisibleNodePosition, pendingNodePosition]
  );

  const dropFilesOnCanvas = useCallback(
    (files: readonly File[], client: { x: number; y: number }) => {
      if (activeProject === null) {
        setOperationError(t("canvas.openProjectFirst"));
        return;
      }
      const position = reactFlow.screenToFlowPosition(client);
      files.forEach((file, index) => {
        const kind: AddNodeKind = file.type.startsWith("image/") ? "image" : "file";
        const offset = index * 28;
        const nodeId = addNode(kind, { x: position.x + offset, y: position.y + offset });
        void importContextFile(file)
          .then((imported) =>
            updateNode(nodeId, {
              title: imported.title,
              contextSource: {
                kind,
                filename: imported.source.filename,
                mediaType: imported.source.mediaType,
                byteSize: imported.source.byteSize,
                sha256: imported.source.sha256,
                ...(kind === "image" && imported.source.previewDataUri !== undefined
                  ? { previewDataUri: imported.source.previewDataUri }
                  : {})
              },
              state: "idle"
            })
          )
          .catch((error: unknown) => {
            removeNode(nodeId);
            setOperationError(
              error instanceof AttachmentTooLargeError
                ? t("canvas.fileTooLarge", { max: formatByteSize(error.maxBytes) })
                : t("canvas.importFailed")
            );
          });
      });
    },
    [activeProject, addNode, reactFlow, removeNode, t, updateNode]
  );

  const addWorkspaceNode = useCallback(
    (kind: AddNodeKind) => {
      if (activeProject === null) {
        setOperationError(t("canvas.openProjectFirst"));
        return;
      }
      setSection("canvas");
      setOperationError(null);
      const nodeId = addNode(kind, nextVisibleNodePosition());
      queueTerminalStart(kind, nodeId, terminalNodesToStart.current);
    },
    [activeProject, addNode, nextVisibleNodePosition, t]
  );

  const beginTerminalDraft = useCallback((client: DraftPoint, local: DraftPoint) => {
    const draft = {
      startClient: client,
      currentClient: client,
      startLocal: local,
      currentLocal: local
    } satisfies TerminalDraftState;
    terminalDraftRef.current = draft;
    setTerminalDraft(draft);
  }, []);

  const updateTerminalDraft = useCallback((client: DraftPoint, local: DraftPoint) => {
    const current = terminalDraftRef.current;
    if (current === null) return;
    const draft = { ...current, currentClient: client, currentLocal: local };
    terminalDraftRef.current = draft;
    setTerminalDraft(draft);
  }, []);

  const finishTerminalDraft = useCallback(
    (client: DraftPoint) => {
      const draft = terminalDraftRef.current;
      terminalDraftRef.current = null;
      setTerminalDraft(null);
      if (draft === null) return;

      suppressPaneContextMenu.current = true;
      window.setTimeout(() => {
        suppressPaneContextMenu.current = false;
      }, 250);
      if (!hasTerminalDraftIntent(draft.startClient, client)) {
        openAddMenu(reactFlow.screenToFlowPosition(client));
        return;
      }
      if (activeProject === null) {
        setOperationError(t("canvas.openProjectFirst"));
        return;
      }
      const geometry = terminalGeometryFromDrag(
        reactFlow.screenToFlowPosition(draft.startClient),
        reactFlow.screenToFlowPosition(client)
      );
      const nodeId = addNode("terminal", geometry.position, {
        width: geometry.width,
        height: geometry.height
      });
      terminalNodesToStart.current.add(nodeId);
      setOperationError(null);
      setCanvasHint(null);
    },
    [activeProject, addNode, openAddMenu, reactFlow, t]
  );

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (terminalDraftRef.current === null || (event.buttons & 2) === 0) return;
      const bounds = flowSurfaceRef.current?.getBoundingClientRect();
      if (bounds === undefined) return;
      updateTerminalDraft(
        { x: event.clientX, y: event.clientY },
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
      );
    };
    const finish = (event: MouseEvent) => {
      if (event.button === 2) finishTerminalDraft({ x: event.clientX, y: event.clientY });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
    };
  }, [finishTerminalDraft, updateTerminalDraft]);

  const activateWorkspace = useCallback(
    async (workspace: WorkspaceDto) => {
      if (workspace.id === activeWorkspaceId) {
        setSection("canvas");
        return;
      }
      const generation = ++workspaceGenerationRef.current;
      await flushCanvas();
      const response = await window.forgedeck.canvases.load({ canvasId: workspace.canvasId });
      // A newer activateWorkspace/closeWorkspaceTab ran while this one was awaiting the load —
      // that call already applied its own (more recent) snapshot, so this stale response must not
      // overwrite it.
      if (workspaceGenerationRef.current !== generation) return;
      const snapshot = response.snapshot ?? createWorkspaceCanvas(workspace);
      load(snapshot, response.snapshot === null);
      await reactFlow.setViewport(snapshot.viewport, { duration: 0 });
      if (workspaceGenerationRef.current !== generation) return;
      setActiveBranch(null);
      setBranchDirty(false);
      setProjectBranches([]);
      setBranchMenuOpen(false);
      await window.forgedeck.settings.update({ activeWorkspaceId: workspace.id });
      if (workspaceGenerationRef.current !== generation) return;
      setActiveWorkspaceId(workspace.id);
      setOperationError(null);
      setSection("canvas");
    },
    [activeWorkspaceId, flushCanvas, load, reactFlow]
  );

  const openWorkspaceForProject = useCallback(
    async (projectId: string) => {
      let workspace = findWorkspaceForProject(workspaces, projectId);
      if (workspace === null) {
        workspace = await window.forgedeck.workspaces.create({
          projectId,
          adoptLegacyCanvas: false
        });
      } else if (!workspace.isOpen) {
        workspace = await window.forgedeck.workspaces.update({
          workspaceId: workspace.id,
          isOpen: true
        });
      }
      setWorkspaces((current) => replaceWorkspace(current, workspace));
      await activateWorkspace(workspace);
    },
    [activateWorkspace, workspaces]
  );

  const openProjectPicker = useCallback(() => {
    setProjectPickerBusy(true);
    setOperationError(null);
    setGitInitializationDirectory(null);
    void window.forgedeck.projects
      .choose()
      .then(async ({ project, initializationDirectory }) => {
        if (project === null) {
          if (initializationDirectory !== null) {
            setGitInitializationDirectory(initializationDirectory);
            setOperationError(t("canvas.projectRequiresGit"));
          }
          return;
        }
        setProjects((current) => [project, ...current.filter((entry) => entry.id !== project.id)]);
        await openWorkspaceForProject(project.id);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t("canvas.projectOpenFailed");
        setOperationError(
          /not inside a git repository/i.test(message) ? t("canvas.projectRequiresGit") : message
        );
      })
      .finally(() => setProjectPickerBusy(false));
  }, [openWorkspaceForProject, t]);
  const initializeLocalProject = useCallback(() => {
    if (gitInitializationDirectory === null) return;
    setGitInitializationBusy(true);
    setOperationError(null);
    void window.forgedeck.projects
      .initializeGit({ directory: gitInitializationDirectory })
      .then(async ({ project }) => {
        if (project === null) throw new Error(t("canvas.projectOpenFailed"));
        setProjects((current) => [project, ...current.filter((entry) => entry.id !== project.id)]);
        setGitInitializationDirectory(null);
        await openWorkspaceForProject(project.id);
        setCanvasHint(t("canvas.projectGitInitialized"));
      })
      .catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : t("canvas.projectOpenFailed"))
      )
      .finally(() => setGitInitializationBusy(false));
  }, [gitInitializationDirectory, openWorkspaceForProject, t]);

  const switchProjectBranch = useCallback(
    (branchName: string) => {
      if (activeProject === null || branchName === activeBranch) {
        setBranchMenuOpen(false);
        return;
      }
      if (branchDirty) {
        setBranchMenuOpen(false);
        setOperationError(t("branch.dirtyWorktree"));
        return;
      }
      setBranchBusy(true);
      setOperationError(null);
      void window.forgedeck.projects
        .switchBranch({ projectId: activeProject.id, branchName })
        .then((response) => {
          setActiveBranch(response.currentBranch);
          setBranchDirty(false);
          setProjectBranches((current) =>
            current.map((branch) => ({
              ...branch,
              current: branch.name === response.currentBranch
            }))
          );
          setProjects((current) =>
            current.map((project) =>
              project.id === activeProject.id
                ? {
                    ...project,
                    headCommit: response.headCommit,
                    updatedAt: new Date().toISOString()
                  }
                : project
            )
          );
          setBranchMenuOpen(false);
          setCanvasHint(t("branch.switched", { branch: response.currentBranch }));
        })
        .catch((error: unknown) => {
          const message = toUserFacingErrorMessage(error, t("branch.switchFailed"));
          setOperationError(
            message.includes("Commit or stash local changes") ? t("branch.dirtyWorktree") : message
          );
        })
        .finally(() => setBranchBusy(false));
    },
    [activeBranch, activeProject, branchDirty, t]
  );

  const closeWorkspaceTab = useCallback(
    (workspace: WorkspaceDto) => {
      void (async () => {
        const generation = ++workspaceGenerationRef.current;
        await flushCanvas();
        const closed = await window.forgedeck.workspaces.update({
          workspaceId: workspace.id,
          isOpen: false
        });
        const nextWorkspaces = replaceWorkspace(workspaces, closed);
        setWorkspaces(nextWorkspaces);
        if (workspace.id !== activeWorkspaceId) {
          return;
        }
        // A newer switch/close already ran while this awaited IPC calls above; that call's
        // outcome is the one that should stick, not this stale close.
        if (workspaceGenerationRef.current !== generation) return;
        const next = nextWorkspaces.find((entry) => entry.isOpen) ?? null;
        if (next === null) {
          load(createDefaultCanvas(), false);
          setActiveWorkspaceId(null);
          await window.forgedeck.settings.update({ activeWorkspaceId: null });
          return;
        }
        await activateWorkspace(next);
      })().catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : t("workspace.switchFailed"))
      );
    },
    [activateWorkspace, activeWorkspaceId, flushCanvas, load, t, workspaces]
  );

  const toggleWorkspaceSidebar = useCallback(() => {
    setWorkspaceSidebarOpen((open) => !open);
  }, []);

  const contextWorkspace = useMemo(() => {
    if (workspaceContextTarget === null) return null;
    if (workspaceContextTarget.workspaceId === null) return activeWorkspace;
    return (
      workspaces.find((workspace) => workspace.id === workspaceContextTarget.workspaceId) ?? null
    );
  }, [activeWorkspace, workspaceContextTarget, workspaces]);
  const workspaceContextActions = useMemo<readonly CanvasMenuAction[]>(
    () => [
      {
        id: "add-project",
        label: t("workspace.addProject"),
        disabled: projectPickerBusy
      },
      { id: "sort-name", label: t("workspace.sortName"), disabled: workspaceSort === "name" },
      {
        id: "sort-updated",
        label: t("workspace.sortUpdated"),
        disabled: workspaceSort === "updated"
      },
      ...(contextWorkspace === null
        ? []
        : [{ id: "remove-project", label: t("workspace.removeProject"), danger: true }])
    ],
    [contextWorkspace, projectPickerBusy, t, workspaceSort]
  );
  const handleWorkspaceContextAction = useCallback(
    (actionId: string) => {
      setWorkspaceContextTarget(null);
      if (actionId === "add-project") {
        openProjectPicker();
      } else if (actionId === "sort-name") {
        setWorkspaceSort("name");
      } else if (actionId === "sort-updated") {
        setWorkspaceSort("updated");
      } else if (
        actionId === "remove-project" &&
        contextWorkspace !== null &&
        window.confirm(t("workspace.removeConfirm", { title: contextWorkspace.title }))
      ) {
        closeWorkspaceTab(contextWorkspace);
      }
    },
    [closeWorkspaceTab, contextWorkspace, openProjectPicker, t]
  );

  const reportTerminalError = useCallback((nodeId: string, message: string) => {
    setTerminalErrors((current) => ({ ...current, [nodeId]: message }));
  }, []);

  const createTerminalForNode = useCallback(
    async (nodeId: string, adapterId: string | undefined): Promise<TerminalSession | null> => {
      if (activeProject === null || activeWorkspace === null) {
        setOperationError(t("canvas.openProjectFirst"));
        return null;
      }
      setTerminalStartingNodeIds((current) => new Set([...current, nodeId]));
      setTerminalErrors((current) => withoutRecordKey(current, nodeId));
      try {
        // A terminal endpoint is bound to a persisted canvas agent.  New nodes are queued for
        // launch immediately after they are added, so persist the canvas first instead of racing
        // the endpoint lookup in the main process.
        await flushCanvas();
        const session = await window.forgedeck.terminals.create({
          projectId: activeProject.id,
          adapterId: terminalAdapterId(adapterId),
          endpoint: { workspaceId: activeWorkspace.id, nodeId },
          cols: 120,
          rows: 30
        });
        setTerminalSessions((current) => ({ ...current, [session.id]: session }));
        setNodeSessionIds((current) => ({ ...current, [nodeId]: session.id }));
        return session;
      } catch (error) {
        reportTerminalError(
          nodeId,
          toUserFacingErrorMessage(error, t("canvas.terminalConnectFailed"))
        );
        return null;
      } finally {
        setTerminalStartingNodeIds(
          (current) => new Set([...current].filter((entry) => entry !== nodeId))
        );
      }
    },
    [activeProject, activeWorkspace, flushCanvas, reportTerminalError, t]
  );

  const connectTerminalNode = useCallback(
    (nodeId: string, adapterId: string | undefined) => {
      void createTerminalForNode(nodeId, adapterId);
    },
    [createTerminalForNode]
  );

  const pulseHandoffEdge = useCallback((edgeId: string) => {
    const previousTimeout = handoffActivityTimeouts.current.get(edgeId);
    if (previousTimeout !== undefined) window.clearTimeout(previousTimeout);
    setActiveHandoffEdgeIds((current) => new Set([...current, edgeId]));
    const timeout = window.setTimeout(() => {
      handoffActivityTimeouts.current.delete(edgeId);
      setActiveHandoffEdgeIds(
        (current) => new Set([...current].filter((entry) => entry !== edgeId))
      );
    }, 1_600);
    handoffActivityTimeouts.current.set(edgeId, timeout);
  }, []);

  const createHandoffDraft = useCallback(
    async (sourceNode: ForgeFlowNode, route: HandoffRoute) => {
      const sourceSessionId = nodeSessionIds[sourceNode.id];
      if (sourceSessionId === undefined) {
        reportTerminalError(sourceNode.id, t("context.handoffSourceUnavailable"));
        return;
      }
      setOperationError(null);
      try {
        await flushCanvas();
        const [rawOutput, record] = await Promise.all([
          window.forgedeck.terminals.buffer({ sessionId: sourceSessionId }),
          window.forgedeck.handoffs.createDraft({
            canvasId: useCanvasStore.getState().canvasId,
            sourceNodeId: sourceNode.id,
            targetNodeId: route.targetNodeId,
            edgeId: route.edgeId
          })
        ]);
        setHandoffRouteChoice(null);
        setHandoffReview({ record, rawOutput: rawOutput.data, busy: false, error: null });
        await loadHandoffHistory();
      } catch (error: unknown) {
        reportTerminalError(
          sourceNode.id,
          toUserFacingErrorMessage(error, t("context.handoffFailed"))
        );
      }
    },
    [flushCanvas, loadHandoffHistory, nodeSessionIds, reportTerminalError, t]
  );

  const prepareTerminalHandoff = useCallback(
    async (sourceNode: ForgeFlowNode, requestedTargetIds?: readonly string[]) => {
      if (mission.trim().length === 0) {
        setEditTarget({ kind: "mission", value: "" });
        setOperationError(t("mission.required"));
        return;
      }
      if (sourceNode.data.role === undefined) {
        setRoleTarget(sourceNode);
        setOperationError(t("handoff.rolesRequired"));
        return;
      }
      const routes = edges
        .filter(
          (edge) =>
            edge.source === sourceNode.id &&
            (requestedTargetIds === undefined || requestedTargetIds.includes(edge.target))
        )
        .map((edge) => {
          const target = nodes.find((node) => node.id === edge.target);
          return { edge, target };
        })
        .filter(
          (route): route is { edge: ForgeFlowEdge; target: ForgeFlowNode } =>
            route.target !== undefined &&
            isTerminalBackedNode(route.target.type ?? "task", route.target.data.adapterId) &&
            terminalAdapterId(route.target.data.adapterId) !== "shell"
        )
        .map(({ edge, target }) => ({
          edgeId: edge.id,
          targetNodeId: target.id,
          targetTitle: target.data.role?.name ?? target.data.title
        }));
      if (routes.length === 0) {
        reportTerminalError(sourceNode.id, t("context.handoffTargetUnavailable"));
        return;
      }
      const missingRole = routes.find(
        (route) => nodes.find((node) => node.id === route.targetNodeId)?.data.role === undefined
      );
      if (missingRole !== undefined) {
        const target = nodes.find((node) => node.id === missingRole.targetNodeId);
        if (target !== undefined) setRoleTarget(target);
        setOperationError(t("handoff.rolesRequired"));
        return;
      }
      if (routes.length > 1) {
        setHandoffRouteChoice({ sourceNodeId: sourceNode.id, routes });
        return;
      }
      const route = routes[0];
      if (route !== undefined) await createHandoffDraft(sourceNode, route);
    },
    [createHandoffDraft, edges, mission, nodes, reportTerminalError, t]
  );

  const startFlow = useCallback(async () => {
    if (mission.trim().length === 0) {
      setEditTarget({ kind: "mission", value: "" });
      setOperationError(t("mission.required"));
      return;
    }
    if (activeWorkspace === null) {
      setOperationError(t("canvas.openProjectFirst"));
      return;
    }
    const plan = createManualWorkflowPlan({ mission: mission.trim(), nodes, edges });
    if (plan.nodes.length === 0) {
      setOperationError(t("mission.noInitialAgent"));
      return;
    }

    setOperationError(null);
    try {
      await flushCanvas();
      const sourceTerminalId = `manual-${crypto.randomUUID()}`;
      const applyAction = async (
        action: Parameters<typeof window.forgedeck.workflowDraft.applyAction>[0]["action"],
        draftId?: string
      ): Promise<WorkflowDraftCommandResult> => {
        const result = await window.forgedeck.workflowDraft.applyAction({
          workspaceId: activeWorkspace.id,
          sourceTerminalId,
          creationMode: "manual",
          executionProfile,
          ...(draftId === undefined ? {} : { draftId }),
          action
        });
        if (result.status !== "applied" || result.draft === null) {
          throw new Error(result.message || t("mission.startFailed"));
        }
        return result;
      };
      let result = await applyAction({
        type: "start_workflow_draft",
        title: activeWorkspace.title,
        objective: mission.trim()
      });
      let draftId = result.draft?.id;
      if (draftId === undefined) throw new Error(t("mission.startFailed"));
      for (const node of plan.nodes) {
        result = await applyAction(node.action, draftId);
        draftId = result.draft?.id ?? draftId;
      }
      for (const edge of plan.edges) {
        result = await applyAction(edge.action, draftId);
        draftId = result.draft?.id ?? draftId;
      }
      result = await applyAction({ type: "finalize_workflow_draft" }, draftId);
      const assigned = await window.forgedeck.workflowDraft.assignAgents({
        draftId,
        preset: "manual",
        assignments: plan.nodes.map((node) => ({
          nodeId: node.ref,
          assignedAdapter: node.adapterId
        }))
      });
      if (assigned.status !== "applied" || assigned.draft === null) {
        throw new Error(assigned.message || t("mission.startFailed"));
      }
      const approved = await window.forgedeck.workflowDraft.approve({ draftId });
      if (approved.draft !== null) setWorkflowDraft(approved.draft);
      if (
        approved.status !== "applied" ||
        approved.activation?.status !== "started" ||
        approved.activation.runId === null
      ) {
        throw new Error(
          approved.activation?.issues[0]?.message ?? approved.message ?? t("mission.startFailed")
        );
      }
      setCanvasHint(
        plan.ignoredShellRoles.length === 0
          ? t("mission.started", { count: plan.nodes.length })
          : `Fluxo iniciado com ${plan.nodes.length} agentes. Terminal shell “${plan.ignoredShellRoles.join(
              ", "
            )}” não é um agente de IA e não foi executado.`
      );
    } catch (error: unknown) {
      setOperationError(toUserFacingErrorMessage(error, t("mission.startFailed")));
    }
  }, [
    activeWorkspace,
    edges,
    executionProfile,
    flushCanvas,
    mission,
    nodes,
    setCanvasHint,
    setEditTarget,
    setOperationError,
    t
  ]);

  const executeNoteNode = useCallback(
    async (note: ForgeFlowNode, direction: NoteExecutionDirection) => {
      if (note.type !== "note") return;
      const candidates = edges
        .filter((edge) =>
          direction === "forward" ? edge.source === note.id : edge.target === note.id
        )
        .map((edge) => ({
          edge,
          node: nodes.find((node) =>
            direction === "forward" ? node.id === edge.target : node.id === edge.source
          )
        }))
        .filter(
          (target): target is { edge: ForgeFlowEdge; node: ForgeFlowNode } =>
            target.node !== undefined &&
            isTerminalBackedNode(target.node.type ?? "task", target.node.data.adapterId) &&
            terminalAdapterId(target.node.data.adapterId) !== "shell"
        );
      if (candidates.length === 0) {
        setOperationError(
          t(direction === "forward" ? "note.noForwardAgent" : "note.noFeedbackAgent")
        );
        return;
      }

      updateNode(note.id, { state: "running" });
      setOperationError(null);
      try {
        const message = buildNoteExecution(
          note.data.title,
          note.data.content ?? note.data.summary,
          direction,
          mission
        );
        let delivered = 0;
        for (const { edge, node: target } of candidates) {
          const existingSessionId = nodeSessionIds[target.id];
          const sessionId =
            existingSessionId ??
            (await createTerminalForNode(target.id, target.data.adapterId))?.id ??
            null;
          if (sessionId === null) continue;
          const targetOutput = await waitForTerminalOutput(sessionId);
          if (terminalNeedsLogin(targetOutput)) {
            reportTerminalError(target.id, t("context.handoffLoginRequired"));
            continue;
          }
          await window.forgedeck.terminals.write({
            sessionId,
            data: terminalHandoffInput(message)
          });
          pulseHandoffEdge(edge.id);
          delivered += 1;
        }
        if (delivered === 0) {
          updateNode(note.id, { state: "failed" });
          setOperationError(t("note.deliveryFailed"));
          return;
        }
        updateNode(note.id, { state: "succeeded" });
        setCanvasHint(
          t(direction === "forward" ? "note.forwardDelivered" : "note.feedbackDelivered", {
            count: delivered
          })
        );
      } catch (error) {
        updateNode(note.id, { state: "failed" });
        setOperationError(toUserFacingErrorMessage(error, t("note.deliveryFailed")));
      }
    },
    [
      createTerminalForNode,
      edges,
      mission,
      nodeSessionIds,
      nodes,
      pulseHandoffEdge,
      reportTerminalError,
      t,
      updateNode
    ]
  );

  const composerNode = useMemo(
    () =>
      composerNodeId === null ? null : (nodes.find((node) => node.id === composerNodeId) ?? null),
    [composerNodeId, nodes]
  );

  const composerMentions = useMemo(
    () => (composerNode === null ? [] : composerMentionsFor(composerNode.id, nodes, edges)),
    [composerNode, edges, nodes]
  );

  const composerDisabledReason = useMemo(() => {
    if (composerNode === null) return null;
    const key = composerBlockedKey(
      terminalAdapterId(composerNode.data.adapterId),
      nodeSessionIds[composerNode.id] !== undefined
    );
    return key === null ? null : t(key);
  }, [composerNode, nodeSessionIds, t]);

  /**
   * Forgets a draft once its node is gone.
   *
   * One effect instead of a line in each delete path: nodes also disappear on a workspace switch and
   * on an external canvas merge, and a draft left behind would eventually be offered to whichever
   * node inherits that id.
   */
  useEffect(() => {
    const liveIds = new Set(nodes.map((node) => node.id));
    setComposerDrafts((current) => {
      const kept = Object.entries(current).filter(([nodeId]) => liveIds.has(nodeId));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
    setComposerNodeId((current) => (current !== null && !liveIds.has(current) ? null : current));
  }, [nodes]);

  /**
   * Hands a written instruction to a running agent terminal as one paste.
   *
   * Bracketed paste is what keeps a multi-line mission intact: the TUI receives it as pasted text
   * instead of interpreting each newline as a separate submission, which is exactly the failure that
   * makes people write one-line prompts.
   */
  const sendComposedPrompt = useCallback(
    (nodeId: string, content: string) => {
      const sessionId = nodeSessionIds[nodeId];
      if (sessionId === undefined) {
        reportTerminalError(nodeId, t("composer.inactiveBlocked"));
        return;
      }
      const draft = composerDrafts[nodeId] ?? "";
      // Closed and cleared before the write resolves, so a second Enter cannot send the same
      // paragraph twice while the first one is still in flight.
      setComposerDrafts((current) => withoutRecordKey(current, nodeId));
      setComposerNodeId(null);
      void window.forgedeck.terminals
        .write({ sessionId, data: terminalHandoffInput(content) })
        .then(() => setCanvasHint(t("composer.sent")))
        .catch((error: unknown) => {
          // The draft comes back: a write that failed left nothing in the terminal, so discarding
          // what the person wrote would destroy the only copy of it. Text typed for this node in the
          // meantime wins, though — restoring over it would be the same destruction, reversed.
          setComposerDrafts((current) =>
            (current[nodeId] ?? "").length > 0 ? current : { ...current, [nodeId]: draft }
          );
          reportTerminalError(nodeId, toUserFacingErrorMessage(error, t("composer.sendFailed")));
        });
    },
    [composerDrafts, nodeSessionIds, reportTerminalError, t]
  );

  useEffect(() => {
    for (const node of nodes) {
      if (!terminalNodesToStart.current.has(node.id)) {
        continue;
      }
      terminalNodesToStart.current.delete(node.id);
      connectTerminalNode(node.id, node.data.adapterId);
    }
  }, [connectTerminalNode, nodes]);

  const interruptTerminalSession = useCallback(
    (nodeId: string, sessionId: string) => {
      void window.forgedeck.terminals
        .cancel({ sessionId })
        .then((session) =>
          setTerminalSessions((current) => ({ ...current, [session.id]: session }))
        )
        .catch((error: unknown) =>
          reportTerminalError(
            nodeId,
            error instanceof Error ? error.message : t("canvas.terminalStopFailed")
          )
        );
    },
    [reportTerminalError, t]
  );

  const clearTerminalNode = useCallback(
    (nodeId: string) => {
      const sessionId = nodeSessionIds[nodeId];
      if (sessionId === undefined) return;
      void window.forgedeck.terminals
        .clear({ sessionId })
        .then(() =>
          setTerminalClearEpochs((current) => ({
            ...current,
            [nodeId]: (current[nodeId] ?? 0) + 1
          }))
        )
        .catch((error: unknown) =>
          reportTerminalError(
            nodeId,
            error instanceof Error ? error.message : t("context.clearFailed")
          )
        );
    },
    [nodeSessionIds, reportTerminalError, t]
  );

  const restartTerminalNode = useCallback(
    (node: ForgeFlowNode) => {
      const sessionId = nodeSessionIds[node.id];
      void (async () => {
        if (sessionId !== undefined) {
          await window.forgedeck.terminals.cancel({ sessionId });
          setNodeSessionIds((current) => withoutRecordKey(current, node.id));
        }
        connectTerminalNode(node.id, node.data.adapterId);
      })().catch((error: unknown) =>
        reportTerminalError(
          node.id,
          error instanceof Error ? error.message : t("context.restartFailed")
        )
      );
    },
    [connectTerminalNode, nodeSessionIds, reportTerminalError, t]
  );

  /**
   * Takes deleted tasks out of the generated plan.
   *
   * Without this a plan node only disappears until the plan is loaded again, because the canvas is
   * redrawn from the plan — the person deletes, switches project, comes back, and everything is
   * there again. Deleting has to reach the plan for the two to tell the same story.
   */
  const removeDeletedDraftNodes = useCallback(
    async (deletedNodeIds: readonly string[]): Promise<void> => {
      const workspaceId = activeWorkspace?.id;
      const draft = workflowDraft;
      if (workspaceId === undefined || draft === null) return;
      const taskIds = draftNodeIdsForDeletion(deletedNodeIds, draft);
      if (taskIds.length === 0) return;
      let latest: WorkflowDraft | null = null;
      for (const taskId of taskIds) {
        const result = await window.forgedeck.workflowDraft.applyAction({
          workspaceId,
          sourceTerminalId: `manual-${crypto.randomUUID()}`,
          creationMode: "manual",
          executionProfile,
          draftId: draft.id,
          action: { type: "remove_draft_node", ref: taskId }
        });
        if (result.draft !== null) latest = result.draft;
      }
      if (latest !== null) setWorkflowDraft(latest);
    },
    [activeWorkspace?.id, executionProfile, workflowDraft]
  );

  const deleteCanvasNode = useCallback(
    (node: ForgeFlowNode) => {
      const planTaskIds = draftNodeIdsForDeletion([node.id], workflowDraft);
      const confirmMessage =
        planTaskIds.length > 0
          ? t("context.deletePlanNodeConfirm", { title: node.data.title })
          : t("context.deleteNodeConfirm", { title: node.data.title });
      if (!window.confirm(confirmMessage)) return;
      const sessionId = nodeSessionIds[node.id];
      const removed = removeNode(node.id);
      if (!removed) return;
      terminalNodesToStart.current.delete(node.id);
      setNodeSessionIds((current) => withoutRecordKey(current, node.id));
      setTerminalErrors((current) => withoutRecordKey(current, node.id));
      setTerminalClearEpochs((current) => withoutNumericRecordKey(current, node.id));
      setFocusedNodeId((current) => (current === node.id ? null : current));
      void (async () => {
        // Make the visual deletion durable before waiting for a CLI to stop. This keeps a rapid
        // workspace switch from loading the node that the user just removed.
        await flushCanvas();
        await removeDeletedDraftNodes([node.id]);
        if (sessionId !== undefined) {
          await window.forgedeck.terminals.cancel({ sessionId });
        }
      })().catch((error: unknown) =>
        reportTerminalError(
          node.id,
          error instanceof Error ? error.message : t("context.deleteFailed")
        )
      );
    },
    [
      flushCanvas,
      nodeSessionIds,
      removeDeletedDraftNodes,
      removeNode,
      reportTerminalError,
      t,
      workflowDraft
    ]
  );

  const duplicateCanvasNode = useCallback(
    (node: ForgeFlowNode) => {
      const duplicateId = duplicateNode(
        node.id,
        t("context.copyTitle", { title: node.data.title })
      );
      if (duplicateId !== null && isTerminalBackedNode(node.type ?? "task", node.data.adapterId)) {
        terminalNodesToStart.current.add(duplicateId);
      }
    },
    [duplicateNode, t]
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<ForgeFlowNode>[]) => {
      onNodesChange(changes);
      const sessionIds = changes
        .filter((change) => change.type === "remove")
        .map((change) => nodeSessionIds[change.id])
        .filter((sessionId): sessionId is string => sessionId !== undefined);
      if (sessionIds.length === 0) {
        return;
      }
      setNodeSessionIds((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, sessionId]) => !sessionIds.includes(sessionId))
        )
      );
      void Promise.all(
        sessionIds.map((sessionId) => window.forgedeck.terminals.cancel({ sessionId }))
      ).catch((error: unknown) =>
        setOperationError(
          error instanceof Error ? error.message : "A removed terminal could not be stopped"
        )
      );
    },
    [nodeSessionIds, onNodesChange]
  );

  const centerNode = useCallback(
    (nodeId: string) => {
      const node = reactFlow.getNode(nodeId);
      if (node === undefined) return;
      const width = node.measured?.width ?? node.width ?? 280;
      const height = node.measured?.height ?? node.height ?? 180;
      void reactFlow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: Math.min(1.15, Math.max(0.8, reactFlow.getZoom())),
        duration: 220
      });
    },
    [reactFlow]
  );

  const organizeCanvas = useCallback(() => {
    const organized = organizeCanvasNodes(nodes, edges);
    handleNodesChange(
      organized.map((node) => ({ id: node.id, type: "position", position: node.position }))
    );
    window.requestAnimationFrame(() => {
      void reactFlow.fitView({ padding: 0.16, duration: 260 });
    });
  }, [edges, handleNodesChange, nodes, reactFlow]);

  const terminalContext = useMemo(
    () => ({
      sessionsByNode: terminalSessionsByNode,
      errorsByNode: terminalErrors,
      startingNodeIds: terminalStartingNodeIds,
      activeNodeIds: activeTerminalNodeIds,
      clearEpochsByNode: terminalClearEpochs,
      connectNode: connectTerminalNode,
      interruptSession: interruptTerminalSession,
      reportNodeError: reportTerminalError
    }),
    [
      connectTerminalNode,
      interruptTerminalSession,
      reportTerminalError,
      terminalClearEpochs,
      terminalErrors,
      terminalStartingNodeIds,
      activeTerminalNodeIds,
      terminalSessionsByNode
    ]
  );

  // --- Official workflow run projected onto the free canvas. The deterministic runtime's snapshot,
  // dependency graph and structured events are the ONLY source of truth; the overlay is a pure
  // derivation matched to real nodes by workflowNodeId, never inferred from terminal text, timers or
  // optimistic UI (spec §13.2). Approving a draft materialises the run elsewhere; here we only project.
  const [officialRun, setOfficialRun] = useState<{
    readonly snapshot: WorkflowRunSnapshotDto;
    readonly graph: WorkflowRunGraphDto | null;
    readonly events: readonly WorkflowRunEvent[];
  } | null>(null);
  const [runReloadNonce, setRunReloadNonce] = useState(0);
  // A structured run event means the official state changed; re-read the snapshot (debounced to
  // coalesce bursts). Raw terminal output travels on a different channel and never drives run state.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const release = window.forgedeck.workflows.onEvent(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setRunReloadNonce((value) => value + 1);
      }, 150);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      release();
    };
  }, []);
  // Resolve the latest official run bound to the active workspace and load its graph and events.
  useEffect(() => {
    const workspaceId = activeWorkspace?.id;
    if (workspaceId === undefined) {
      setOfficialRun(null);
      return;
    }
    let active = true;
    void window.forgedeck.workflows
      .list({})
      .then(async (runs) => {
        const match = runs.find((run) => run.executionContext?.workspaceId === workspaceId) ?? null;
        if (match === null) {
          if (active) setOfficialRun(null);
          return;
        }
        const [graph, events] = await Promise.all([
          window.forgedeck.workflows.graph({ runId: match.id }).catch(() => null),
          window.forgedeck.workflows
            .events({ runId: match.id })
            .catch(() => [] as WorkflowRunEvent[])
        ]);
        if (active) setOfficialRun({ snapshot: match, graph, events });
      })
      .catch(() => {
        if (active) setOfficialRun(null);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspace?.id, runReloadNonce]);
  // Project once, then derive the node and edge overlays. Both are pure views matched to real nodes
  // and edges by workflowNodeId; nothing here mutates the canvas store or persists a runtime state.
  const runProjection = useMemo(
    () =>
      officialRun === null
        ? null
        : projectWorkflowRunToCanvas(officialRun.snapshot, officialRun.graph, officialRun.events),
    [officialRun]
  );
  const runOverlay = useMemo<CanvasRunOverlay>(
    () => (runProjection === null ? new Map() : buildCanvasRunOverlay(runProjection, nodes)),
    [runProjection, nodes]
  );
  const edgeRunOverlay = useMemo<CanvasEdgeRunOverlay>(
    () =>
      runProjection === null ? new Map() : buildCanvasEdgeRunOverlay(runProjection, nodes, edges),
    [runProjection, nodes, edges]
  );
  const edgeConversationOverlay = useMemo(
    () => projectAgentConversations(edges, agentConversations),
    [edges, agentConversations]
  );
  // The official projected node for the current selection, resolved by its workflowNodeId. Feeds the
  // existing WorkflowNodeInspector so retries, attempts, artifacts, hashes, errors and blocks always
  // belong to the correct node. Null when nothing is selected or the node is not bound to a run.
  const selectedRunNode = useMemo(
    () => (selectedNode === null ? null : (runOverlay.get(selectedNode.id) ?? null)),
    [runOverlay, selectedNode]
  );

  const handleConnect = useCallback(
    (connection: Parameters<typeof connect>[0]) => {
      const result = connect(connection);
      if (result.accepted) {
        setOperationError(null);
        setCanvasHint(null);
        return;
      }
      const messages = {
        self_connection: t("canvas.connectionSelf"),
        missing_node: t("canvas.connectionMissing"),
        duplicate_connection: t("canvas.connectionDuplicate"),
        cycle: t("canvas.connectionCycle")
      } as const;
      setOperationError(messages[result.reason]);
    },
    [connect, t]
  );

  // --- Automatic mode: Compazio composes a workflow draft deterministically from the objective
  // and the real runtimes. No agent, no terminal, no LLM parsing — the draft is always born correctly
  // on the canvas as ghost nodes, then the user edits/locks/approves it. Nothing runs until approval.
  const handleDraftResult = useCallback(
    (result: WorkflowDraftCommandResult) => {
      if (result.draft !== null) {
        setWorkflowDraft(result.draft);
      }
      if (result.status === "rejected") {
        setOperationError(t("composer.rejected", { reason: result.message }));
      } else if (result.status === "needs_input") {
        setCanvasHint(t("composer.needsInput"));
      }
    },
    [t]
  );
  // The canvas draws only nodes that actually exist. It used to be redrawn from the persisted plan,
  // which meant a terminal the person deleted came back the next time the plan loaded — the drawing
  // was gone, the plan was not. A plan now produces real terminals or nothing at all.
  // The live agent catalog. Availability is observed here and never written into the draft; it is
  // refreshed whenever a draft appears so a CLI installed meanwhile is picked up without a restart.
  // Keyed by draft identity on purpose: the catalog is refreshed when a draft appears or changes,
  // not on every edit to its contents.
  const activeDraftId = workflowDraft?.id ?? null;
  const activePreset = workflowDraft?.agentAssignmentPreset ?? "manual";
  useEffect(() => {
    if (activeWorkspace?.id === undefined) {
      setAgentDescriptors([]);
      return;
    }
    let cancelled = false;
    void window.forgedeck.workflowDraft
      .listAgents()
      .then((response) => {
        if (!cancelled) setAgentDescriptors(response.agents);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeDraftId, activeWorkspace?.id]);
  const assignDraftAgent = useCallback(
    async (nodeId: string, adapter: AgentAdapterId | null) => {
      if (activeDraftId === null) return;
      handleDraftResult(
        await window.forgedeck.workflowDraft.assignAgents({
          draftId: activeDraftId,
          preset: activePreset,
          assignments: [{ nodeId, assignedAdapter: adapter }]
        })
      );
    },
    [activeDraftId, activePreset, handleDraftResult]
  );
  const applyAgentPreset = useCallback(
    async (preset: AgentAssignmentPreset) => {
      if (activeDraftId === null) return;
      handleDraftResult(
        await window.forgedeck.workflowDraft.assignAgents({
          draftId: activeDraftId,
          preset,
          assignments: []
        })
      );
    },
    [activeDraftId, handleDraftResult]
  );
  // Restore the saved plan for this workspace so it survives a reload. The plan is the record of
  // which tasks belong to which materialized terminal; it never redraws the canvas by itself.
  useEffect(() => {
    const workspaceId = activeWorkspace?.id;
    if (workspaceId === undefined) {
      setWorkflowDraft(null);
      return;
    }
    void window.forgedeck.workflowDraft
      .load({ workspaceId })
      .then((response) => setWorkflowDraft(response.draft))
      .catch(() => setWorkflowDraft(null));
  }, [activeWorkspace?.id]);
  useEffect(() => {
    return window.forgedeck.workflowDraft.onUpdated((draft) => {
      setWorkflowDraft(draft);
    });
  }, []);
  const discardDraft = useCallback(() => {
    setWorkflowDraft(null);
    setCanvasHint(t("composer.discarded"));
  }, [t]);
  const answerDraftQuestion = useCallback(
    (questionId: string, answer: string) => {
      if (workflowDraft === null) return;
      void window.forgedeck.workflowDraft
        .answerQuestion({ draftId: workflowDraft.id, questionId, answer })
        .then(handleDraftResult)
        .catch((error: unknown) =>
          setOperationError(error instanceof Error ? error.message : t("composer.commandFailed"))
        );
    },
    [handleDraftResult, t, workflowDraft]
  );
  const approveDraft = useCallback(() => {
    if (workflowDraft === null) return;
    void window.forgedeck.workflowDraft
      .approve({ draftId: workflowDraft.id })
      .then((result) => {
        handleDraftResult(result);
        if (result.status !== "applied") return;
        // Increment A: approval materialized one official run. The run overlay resolves the run by
        // workspace, so we only nudge it to re-read; the projection itself is never duplicated here.
        const activation = result.activation;
        if (activation !== null && activation.status === "started" && activation.runId !== null) {
          setRunReloadNonce((value) => value + 1);
          setCanvasHint(t("composer.approved"));
        } else if (activation !== null && activation.status !== "started") {
          setOperationError(
            t("composer.activationFailed", {
              reason: activation.issues[0]?.message ?? activation.status
            })
          );
        } else {
          setCanvasHint(t("composer.approved"));
        }
      })
      .catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : t("composer.commandFailed"))
      );
  }, [handleDraftResult, t, workflowDraft]);

  const contextNode = useMemo(
    () =>
      contextTarget?.kind === "node"
        ? (nodes.find((node) => node.id === contextTarget.id) ?? null)
        : null,
    [contextTarget, nodes]
  );
  const contextEdge = useMemo(
    () =>
      contextTarget?.kind === "edge"
        ? (edges.find((edge) => edge.id === contextTarget.id) ?? null)
        : null,
    [contextTarget, edges]
  );
  const contextSelection = useMemo(() => {
    if (contextTarget?.kind !== "selection") return [];
    const ids = new Set(contextTarget.ids);
    return nodes.filter((node) => ids.has(node.id));
  }, [contextTarget, nodes]);
  const contextActions = useMemo<readonly CanvasMenuAction[]>(() => {
    if (contextSelection.length > 0) {
      const ids = new Set(contextSelection.map((node) => node.id));
      const connected = edges.some((edge) => ids.has(edge.source) || ids.has(edge.target));
      return [
        { id: "center-selection", label: t("context.centerSelection") },
        { id: "copy-selection", label: t("context.copySelection") },
        {
          id: "group-selection",
          label: t("context.groupSelection"),
          disabled: contextSelection.filter((node) => node.type !== "frame").length < 2
        },
        {
          id: "disconnect-selection",
          label: t("context.disconnectSelection"),
          disabled: !connected
        },
        { id: "delete-selection", label: t("context.deleteSelection"), danger: true }
      ];
    }
    if (contextEdge !== null) {
      const source = nodes.find((node) => node.id === contextEdge.source);
      const target = nodes.find((node) => node.id === contextEdge.target);
      return [
        {
          id: "handoff-edge",
          label: t("context.handoffNow"),
          disabled:
            source === undefined ||
            target === undefined ||
            nodeSessionIds[source.id] === undefined ||
            terminalAdapterId(target.data.adapterId) === "shell"
        },
        { id: "edit-rule", label: t("edge.editContract") },
        { id: "delete-edge", label: t("context.deleteConnection"), danger: true }
      ];
    }
    if (contextNode === null) return [];
    const terminalBacked = isTerminalBackedNode(
      contextNode.type ?? "task",
      contextNode.data.adapterId
    );
    const connected = edges.some(
      (edge) => edge.source === contextNode.id || edge.target === contextNode.id
    );
    const hasHandoffTarget = edges.some((edge) => {
      if (edge.source !== contextNode.id) return false;
      const target = nodes.find((node) => node.id === edge.target);
      return target !== undefined && terminalAdapterId(target.data.adapterId) !== "shell";
    });
    const hasNoteForwardTarget =
      contextNode.type === "note" &&
      edges.some((edge) => {
        const target = nodes.find((node) => node.id === edge.target);
        return (
          edge.source === contextNode.id &&
          target !== undefined &&
          isTerminalBackedNode(target.type ?? "task", target.data.adapterId) &&
          terminalAdapterId(target.data.adapterId) !== "shell"
        );
      });
    const hasNoteFeedbackTarget =
      contextNode.type === "note" &&
      edges.some((edge) => {
        const source = nodes.find((node) => node.id === edge.source);
        return (
          edge.target === contextNode.id &&
          source !== undefined &&
          isTerminalBackedNode(source.type ?? "task", source.data.adapterId) &&
          terminalAdapterId(source.data.adapterId) !== "shell"
        );
      });
    const isVisualOnly =
      contextNode.type === "shape" ||
      contextNode.type === "frame" ||
      contextNode.type === "comment";
    const common: CanvasMenuAction[] = [
      { id: "focus", label: t("context.focus") },
      {
        id: "rename",
        label: t(contextNode.type === "note" ? "context.editTitle" : "context.rename")
      },
      { id: "duplicate", label: t("context.duplicate") },
      ...(isVisualOnly
        ? []
        : [
            { id: "connect", label: t("context.connect") },
            ...(contextNode.type === "note"
              ? [
                  {
                    id: "execute-note-forward",
                    label: t("note.executeForward"),
                    disabled: !hasNoteForwardTarget
                  },
                  {
                    id: "execute-note-feedback",
                    label: t("note.executeFeedback"),
                    disabled: !hasNoteFeedbackTarget
                  }
                ]
              : [
                  {
                    id: "handoff",
                    label: t("context.handoffNext"),
                    disabled: nodeSessionIds[contextNode.id] === undefined || !hasHandoffTarget
                  }
                ]),
            { id: "disconnect", label: t("context.disconnect"), disabled: !connected }
          ])
    ];
    if (terminalBacked) {
      common.splice(2, 0, { id: "configure-role", label: t("role.configure") });
    }
    if (contextNode.type === "note") {
      common.splice(2, 0, { id: "edit-note", label: t("note.editContent") });
    }
    if (contextNode.type === "comment") {
      common.splice(2, 0, { id: "edit-comment", label: t("comment.editContent") });
    }
    if (contextNode.data.contextSource !== undefined) {
      common.splice(2, 0, { id: "edit-context-source", label: t("source.editContent") });
    }
    if (isContextPolicyNode(contextNode.type)) {
      common.splice(2, 0, { id: "edit-context-inclusion", label: t("source.editPolicy") });
    }
    if (!isVisualOnly) {
      common.splice(2, 0, { id: "edit-progress", label: t("context.updateProgress") });
      common.splice(3, 0, { id: "edit-blocker", label: t("context.setBlocker") });
    }
    if (terminalBacked && terminalAdapterId(contextNode.data.adapterId) !== "shell") {
      // Enabled even without a session, like the button on the node: the box saying "start the
      // terminal first" teaches more than an item greyed out for a reason it cannot state.
      common.splice(2, 0, { id: "open-composer", label: t("composer.open") });
    }
    if (terminalBacked) {
      common.push(
        {
          id: "clear",
          label: t("context.clearTerminal"),
          disabled: nodeSessionIds[contextNode.id] === undefined
        },
        { id: "restart", label: t("context.restartSession") }
      );
    }
    common.push({ id: "delete-node", label: t("context.deleteNode"), danger: true });
    return common;
  }, [contextEdge, contextNode, contextSelection, edges, nodeSessionIds, nodes, t]);

  const handleContextAction = useCallback(
    (actionId: string) => {
      const actionNodeId = contextMenuNodeId(contextTarget);
      const actionNode =
        actionNodeId === null ? null : (nodes.find((node) => node.id === actionNodeId) ?? null);
      setContextTarget(null);
      if (contextTarget?.kind === "selection" && contextSelection.length > 0) {
        const ids = contextSelection.map((node) => node.id);
        const idSet = new Set(ids);
        if (actionId === "center-selection") {
          void reactFlow.fitView({ nodes: contextSelection, padding: 0.28, duration: 220 });
        } else if (actionId === "copy-selection") {
          const copied = copyCanvasSelection(
            nodes.map((node) => ({ ...node, selected: idSet.has(node.id) })),
            edges
          );
          if (copied !== null) {
            canvasClipboard = copied;
            setCanvasHint(t("canvas.copied", { count: copied.nodes.length }));
          }
        } else if (actionId === "group-selection") {
          const frameId = createFrame(ids);
          if (frameId !== null) {
            setCanvasHint(t("context.groupCreated", { count: ids.length }));
            selectNode(frameId);
          }
        } else if (
          actionId === "disconnect-selection" &&
          window.confirm(t("context.disconnectSelectionConfirm", { count: ids.length }))
        ) {
          disconnectNodes(ids);
        } else if (
          actionId === "delete-selection" &&
          window.confirm(
            draftNodeIdsForDeletion(ids, workflowDraft).length > 0
              ? t("context.deletePlanTasksConfirm", {
                  count: ids.length,
                  tasks: draftNodeIdsForDeletion(ids, workflowDraft).length
                })
              : t("context.deleteSelectionConfirm", { count: ids.length })
          )
        ) {
          const sessionIds = ids
            .map((id) => nodeSessionIds[id])
            .filter((sessionId): sessionId is string => sessionId !== undefined);
          removeNodes(ids);
          for (const id of ids) terminalNodesToStart.current.delete(id);
          setNodeSessionIds((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => !idSet.has(id)))
          );
          setTerminalErrors((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => !idSet.has(id)))
          );
          setTerminalClearEpochs((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => !idSet.has(id)))
          );
          setTerminalStartingNodeIds(
            (current) => new Set([...current].filter((id) => !idSet.has(id)))
          );
          setFocusedNodeId((current) => (current !== null && idSet.has(current) ? null : current));
          void flushCanvas()
            // The plan is updated before the terminals are stopped: a task the person deleted must
            // not survive in the plan just because a CLI was slow to exit.
            .then(() => removeDeletedDraftNodes(ids))
            .then(() =>
              Promise.allSettled(
                sessionIds.map((sessionId) => window.forgedeck.terminals.cancel({ sessionId }))
              )
            )
            .catch((error: unknown) =>
              setOperationError(
                error instanceof Error ? error.message : t("context.deleteSelectionFailed")
              )
            );
        }
        return;
      }
      if (contextEdge !== null) {
        if (actionId === "handoff-edge") {
          const source = nodes.find((node) => node.id === contextEdge.source);
          if (source !== undefined) void prepareTerminalHandoff(source, [contextEdge.target]);
        } else if (actionId === "edit-rule") {
          setEdgeContractTarget(contextEdge);
        } else if (actionId === "delete-edge") {
          removeEdge(contextEdge.id);
        }
        return;
      }
      if (actionNode === null) return;
      if (actionId === "focus") {
        selectNode(actionNode.id);
        setFocusedNodeId(actionNode.id);
        centerNode(actionNode.id);
      } else if (actionId === "open-composer") {
        setComposerNodeId(actionNode.id);
      } else if (actionId === "rename") {
        setEditTarget({ kind: "node", id: actionNode.id, value: actionNode.data.title });
      } else if (actionId === "configure-role") {
        setRoleTarget(actionNode);
      } else if (actionId === "edit-note") {
        setEditTarget({
          kind: "note-content",
          id: actionNode.id,
          value: actionNode.data.content ?? actionNode.data.summary
        });
      } else if (actionId === "edit-comment") {
        setEditTarget({
          kind: "note-content",
          id: actionNode.id,
          value: actionNode.data.content ?? actionNode.data.summary
        });
      } else if (actionId === "edit-progress") {
        setEditTarget({
          kind: "progress",
          id: actionNode.id,
          value: String(actionNode.data.progressPercent ?? 0)
        });
      } else if (actionId === "edit-blocker") {
        setEditTarget({
          kind: "blocker",
          id: actionNode.id,
          value: actionNode.data.blocker ?? ""
        });
      } else if (actionId === "edit-context-inclusion") {
        setEditTarget({
          kind: "context-inclusion",
          id: actionNode.id,
          value: actionNode.data.contextInclusion ?? "relevant"
        });
      } else if (
        actionId === "edit-context-source" &&
        actionNode.data.contextSource !== undefined
      ) {
        const source = actionNode.data.contextSource;
        setEditTarget({
          kind: "context-source",
          id: actionNode.id,
          sourceKind: source.kind,
          value: source.kind === "link" ? (source.url ?? "") : (source.content ?? "")
        });
      } else if (actionId === "duplicate") {
        duplicateCanvasNode(actionNode);
      } else if (actionId === "connect") {
        setPendingConnectionSourceId(actionNode.id);
        setCanvasHint(t("context.chooseTarget"));
      } else if (actionId === "handoff") {
        void prepareTerminalHandoff(actionNode);
      } else if (actionId === "execute-note-forward") {
        void executeNoteNode(actionNode, "forward");
      } else if (actionId === "execute-note-feedback") {
        void executeNoteNode(actionNode, "feedback");
      } else if (
        actionId === "disconnect" &&
        window.confirm(t("context.disconnectConfirm", { title: actionNode.data.title }))
      ) {
        disconnectNode(actionNode.id);
      } else if (actionId === "clear") {
        clearTerminalNode(actionNode.id);
      } else if (actionId === "restart") {
        restartTerminalNode(actionNode);
      } else if (actionId === "delete-node") {
        deleteCanvasNode(actionNode);
      }
    },
    [
      clearTerminalNode,
      centerNode,
      contextEdge,
      contextTarget,
      contextSelection,
      createFrame,
      deleteCanvasNode,
      disconnectNode,
      disconnectNodes,
      duplicateCanvasNode,
      edges,
      executeNoteNode,
      flushCanvas,
      nodeSessionIds,
      nodes,
      prepareTerminalHandoff,
      reactFlow,
      removeDeletedDraftNodes,
      removeEdge,
      removeNodes,
      restartTerminalNode,
      selectNode,
      t,
      workflowDraft
    ]
  );

  const saveEditTarget = useCallback(
    (value: string) => {
      if (editTarget?.kind === "node") {
        updateNode(editTarget.id, { title: value });
      } else if (editTarget?.kind === "note-content") {
        updateNode(editTarget.id, { content: value, state: "idle" });
      } else if (editTarget?.kind === "progress") {
        const progressPercent = Number(value);
        if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) {
          setOperationError(t("context.invalidProgress"));
          return;
        }
        updateNode(editTarget.id, { progressPercent });
      } else if (editTarget?.kind === "blocker") {
        const blocker = value.trim();
        const node = nodes.find((candidate) => candidate.id === editTarget.id);
        updateNode(editTarget.id, {
          blocker: blocker === "" ? undefined : blocker,
          ...(blocker === "" && node?.data.state === "blocked" ? { state: "idle" } : {}),
          ...(blocker === "" ? {} : { state: "blocked" })
        });
      } else if (editTarget?.kind === "context-inclusion") {
        try {
          updateNode(editTarget.id, {
            contextInclusion: contextInclusionSchema.parse(value.trim())
          });
        } catch {
          setOperationError(t("source.invalidPolicy"));
          return;
        }
      } else if (editTarget?.kind === "context-source") {
        const node = nodes.find((candidate) => candidate.id === editTarget.id);
        const source = node?.data.contextSource;
        if (source === undefined || source.kind !== editTarget.sourceKind) {
          setOperationError(t("source.editFailed"));
          return;
        }
        try {
          const nextSource = canvasContextSourceSchema.parse({
            ...source,
            ...(source.kind === "link" ? { url: value } : { content: value })
          });
          updateNode(editTarget.id, { contextSource: nextSource, state: "idle" });
        } catch {
          setOperationError(t("source.invalidLink"));
          return;
        }
      } else if (editTarget?.kind === "mission") {
        setMission(value);
      }
      setEditTarget(null);
    },
    [editTarget, nodes, setMission, t, updateNode]
  );

  const saveRole = useCallback(
    (role: CanvasAgentRole, permissions: readonly string[]) => {
      // Permissions ride along with the role because both are answers to "what is this terminal
      // here to do". The Policy Engine reads exactly this list, so writing it here is what actually
      // grants the powers — nothing else in the product hands them out.
      if (roleTarget !== null) updateNode(roleTarget.id, { role, permissions: [...permissions] });
      setRoleTarget(null);
    },
    [roleTarget, updateNode]
  );

  const saveEdgeContract = useCallback(
    (contract: EdgeContract) => {
      if (edgeContractTarget !== null) updateEdgeContract(edgeContractTarget.id, contract);
      setEdgeContractTarget(null);
    },
    [edgeContractTarget, updateEdgeContract]
  );

  const copySelection = useCallback(() => {
    const selectedNodes = nodes.some((node) => node.selected)
      ? nodes
      : nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId }));
    const copied = copyCanvasSelection(selectedNodes, edges);
    if (copied === null) return;
    canvasClipboard = copied;
    setCanvasHint(t("canvas.copied", { count: copied.nodes.length }));
  }, [edges, nodes, selectedNodeId, t]);

  const pasteSelection = useCallback(() => {
    if (canvasClipboard === null || activeProject === null) return;
    const bounds = flowSurfaceRef.current?.getBoundingClientRect();
    const point =
      bounds === undefined
        ? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
        : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const graph = pasteCanvasSelection(canvasClipboard, reactFlow.screenToFlowPosition(point));
    insertGraph(graph.nodes, graph.edges);
    setCanvasHint(t("canvas.pasted", { count: graph.nodes.length }));
  }, [activeProject, insertGraph, reactFlow, t]);

  const reconcileTerminalSessionsAfterHistory = useCallback(
    (previousNodeIds: ReadonlySet<string>) => {
      const currentNodeIds = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
      const removedNodeIds = [...previousNodeIds].filter((id) => !currentNodeIds.has(id));
      const sessions = removedNodeIds
        .map((id) => nodeSessionIds[id])
        .filter((sessionId): sessionId is string => sessionId !== undefined);
      if (removedNodeIds.length > 0) {
        setNodeSessionIds((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !removedNodeIds.includes(id)))
        );
      }
      void Promise.all(
        sessions.map((sessionId) => window.forgedeck.terminals.cancel({ sessionId }))
      ).catch(() => undefined);
    },
    [nodeSessionIds]
  );

  const undoCanvas = useCallback(() => {
    const previousNodeIds = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
    if (undo()) reconcileTerminalSessionsAfterHistory(previousNodeIds);
  }, [reconcileTerminalSessionsAfterHistory, undo]);

  const redoCanvas = useCallback(() => {
    const previousNodeIds = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
    if (redo()) reconcileTerminalSessionsAfterHistory(previousNodeIds);
  }, [reconcileTerminalSessionsAfterHistory, redo]);

  const clearWorkspaceWorkflow = useCallback(() => {
    if (activeWorkspace === null) return;
    clearWorkflow();
    selectNode(null);
    setEditTarget(null);
    setWorkflowDraft(null);
    setCanvasHint(t("workflow.cleared"));
  }, [activeWorkspace, clearWorkflow, selectNode, t]);

  const savePreparedHandoff = useCallback(
    async (content: HandoffDraftContent) => {
      if (handoffReview === null || handoffReview.record.status !== "draft") return;
      setHandoffReview((current) =>
        current === null ? null : { ...current, busy: true, error: null }
      );
      try {
        const record = await window.forgedeck.handoffs.updateDraft({
          handoffId: handoffReview.record.id,
          revision: handoffReview.record.revision,
          content
        });
        setHandoffReview((current) =>
          current === null ? null : { ...current, record, busy: false, error: null }
        );
        await loadHandoffHistory();
        setCanvasHint(t("handoff.draftSaved"));
      } catch (error: unknown) {
        setHandoffReview((current) =>
          current === null
            ? null
            : {
                ...current,
                busy: false,
                error: toUserFacingErrorMessage(error, t("handoff.saveFailed"))
              }
        );
      }
    },
    [handoffReview, loadHandoffHistory, t]
  );

  const submitPreparedHandoff = useCallback(
    async (
      content: HandoffDraftContent,
      options: { readonly targetSessionId?: string; readonly startDestination?: boolean } = {}
    ) => {
      if (handoffReview === null) return;
      const initial = handoffReview.record;
      const source = nodes.find((node) => node.id === initial.source.nodeId);
      const target = nodes.find((node) => node.id === initial.target.nodeId);
      if (source === undefined || target === undefined) {
        setHandoffReview((current) =>
          current === null ? null : { ...current, error: t("handoff.routeMissing") }
        );
        return;
      }
      setHandoffReview((current) =>
        current === null ? null : { ...current, busy: true, error: null }
      );
      try {
        let record = initial;
        if (record.status === "draft") {
          record = await window.forgedeck.handoffs.markReady({
            handoffId: record.id,
            revision: record.revision,
            content
          });
        }
        const currentSessionId = options.targetSessionId ?? nodeSessionIds[target.id];
        const currentSession =
          currentSessionId === undefined ? undefined : terminalSessions[currentSessionId];
        let sessionId =
          currentSessionId !== undefined &&
          currentSession !== undefined &&
          !isTerminalSessionFinished(currentSession.state)
            ? currentSessionId
            : null;
        if (sessionId === null && options.startDestination === true) {
          sessionId = (await createTerminalForNode(target.id, target.data.adapterId))?.id ?? null;
        }
        if (sessionId === null) {
          if (record.status === "ready") {
            record = await window.forgedeck.handoffs.awaitDestination({
              handoffId: record.id,
              revision: record.revision
            });
          }
          setHandoffReview((current) =>
            current === null ? null : { ...current, record, busy: false, error: null }
          );
          await loadHandoffHistory();
          return;
        }
        const targetOutput = await waitForTerminalOutput(sessionId);
        if (terminalNeedsLogin(targetOutput)) {
          throw new Error(t("context.handoffLoginRequired"));
        }

        if (record.status === "ready") {
          record = await window.forgedeck.handoffs.deliver({
            handoffId: record.id,
            targetSessionId: sessionId
          });
        } else if (
          record.status === "failed" ||
          record.status === "delivery_unknown" ||
          record.status === "awaiting_destination" ||
          record.status === "cancelled"
        ) {
          record = await window.forgedeck.handoffs.retry({
            handoffId: record.id,
            revision: record.revision,
            targetSessionId: sessionId
          });
        }
        if (record.status !== "delivered") {
          throw new Error(t("handoff.deliveryIncomplete"));
        }
        updateNode(source.id, { state: "succeeded" });
        updateNode(target.id, { state: "running" });
        pulseHandoffEdge(record.edge.edgeId);
        setHandoffReview(null);
        setCanvasHint(t("handoff.delivered"));
        await loadHandoffHistory();
      } catch (error: unknown) {
        await loadHandoffHistory();
        const refreshed = activeWorkspace
          ? await window.forgedeck.handoffs
              .list({ canvasId: activeWorkspace.canvasId, limit: 100 })
              .then((records) => records.find((record) => record.id === initial.id))
              .catch(() => undefined)
          : undefined;
        setHandoffReview((current) =>
          current === null
            ? null
            : {
                ...current,
                ...(refreshed === undefined ? {} : { record: refreshed }),
                busy: false,
                error: toUserFacingErrorMessage(error, t("context.handoffFailed"))
              }
        );
      }
    },
    [
      activeWorkspace,
      createTerminalForNode,
      handoffReview,
      loadHandoffHistory,
      nodeSessionIds,
      nodes,
      pulseHandoffEdge,
      t,
      terminalSessions,
      updateNode
    ]
  );

  const inspectHandoffDestination = useCallback(async () => {
    if (handoffReview === null) return;
    const latestAttempt = handoffReview.record.deliveryAttempts.at(-1);
    const sessionId =
      latestAttempt?.targetSessionId ?? nodeSessionIds[handoffReview.record.target.nodeId];
    if (sessionId === undefined || sessionId === null) {
      setHandoffReview((current) =>
        current === null ? null : { ...current, error: t("handoff.noActiveDestination") }
      );
      return;
    }
    setHandoffReview((current) =>
      current === null ? null : { ...current, busy: true, error: null }
    );
    try {
      const snapshot = await window.forgedeck.terminals.buffer({ sessionId });
      selectNode(handoffReview.record.target.nodeId);
      setHandoffReview((current) =>
        current === null
          ? null
          : { ...current, busy: false, destinationOutput: snapshot.data, error: null }
      );
    } catch (error: unknown) {
      setHandoffReview((current) =>
        current === null
          ? null
          : {
              ...current,
              busy: false,
              error: toUserFacingErrorMessage(error, t("handoff.noActiveDestination"))
            }
      );
    }
  }, [handoffReview, nodeSessionIds, selectNode, t]);

  const markHandoffSent = useCallback(async () => {
    if (handoffReview === null) return;
    const attempt = handoffReview.record.deliveryAttempts.at(-1);
    if (attempt === undefined) {
      setHandoffReview((current) =>
        current === null ? null : { ...current, error: t("handoff.deliveryIncomplete") }
      );
      return;
    }
    setHandoffReview((current) =>
      current === null ? null : { ...current, busy: true, error: null }
    );
    try {
      const record = await window.forgedeck.handoffs.markSent({
        handoffId: handoffReview.record.id,
        revision: handoffReview.record.revision,
        deliveryAttemptId: attempt.id
      });
      setHandoffReview((current) =>
        current === null ? null : { ...current, record, busy: false }
      );
      await loadHandoffHistory();
    } catch (error: unknown) {
      setHandoffReview((current) =>
        current === null
          ? null
          : {
              ...current,
              busy: false,
              error: toUserFacingErrorMessage(error, t("context.handoffFailed"))
            }
      );
    }
  }, [handoffReview, loadHandoffHistory, t]);

  const cancelHandoffDelivery = useCallback(async () => {
    if (handoffReview === null) return;
    setHandoffReview((current) =>
      current === null ? null : { ...current, busy: true, error: null }
    );
    try {
      const record = await window.forgedeck.handoffs.cancelDelivery({
        handoffId: handoffReview.record.id,
        revision: handoffReview.record.revision
      });
      setHandoffReview((current) =>
        current === null ? null : { ...current, record, busy: false }
      );
      await loadHandoffHistory();
    } catch (error: unknown) {
      setHandoffReview((current) =>
        current === null
          ? null
          : {
              ...current,
              busy: false,
              error: toUserFacingErrorMessage(error, t("context.handoffFailed"))
            }
      );
    }
  }, [handoffReview, loadHandoffHistory, t]);

  useKeyboardNavigation({
    nodes,
    selectedNodeId,
    onSelect: (id) => {
      selectNode(id);
      handleNodesChange(
        nodes.map((node): NodeChange<ForgeFlowNode> => ({
          id: node.id,
          type: "select",
          selected: node.id === id
        }))
      );
    },
    onPalette: () => openAddMenu(),
    onClosePalette: closeAddMenu,
    onFitView: fitView,
    onDryRun: () => executeDryRun("bugfix"),
    onCopy: copySelection,
    onPaste: pasteSelection,
    onUndo: undoCanvas,
    onRedo: redoCanvas
  });

  if (!loaded) {
    if (pingState === "failed") {
      return (
        <main className="startup-state" role="main">
          <section aria-labelledby="startup-error-title" className="startup-card" role="alert">
            <p className="fd-eyebrow">{t("startup.errorEyebrow")}</p>
            <h1 id="startup-error-title">{t("startup.errorTitle")}</h1>
            <p>{operationError ?? t("startup.handshakeError")}</p>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setOperationError(null);
                setPingState("checking");
                setBootAttempt((attempt) => attempt + 1);
              }}
            >
              {t("startup.retry")}
            </button>
          </section>
        </main>
      );
    }
    return (
      <main aria-busy="true" className="loading-screen" role="main">
        <section className="startup-card">
          <p className="fd-eyebrow">{t("startup.loadingEyebrow")}</p>
          <h1>{t("startup.loadingTitle")}</h1>
          <p>{t("startup.loadingBody")}</p>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell${focusedNodeId === null ? "" : " is-node-focused"}`}>
      <section className="workspace">
        <header className="workspace-bar">
          <button className="workspace-brand" type="button" onClick={() => setSection("canvas")}>
            <CompazioLogo />
          </button>
          <div className="workspace-current-wrap">
            <button
              aria-expanded={branchMenuOpen}
              aria-haspopup="menu"
              className="workspace-current"
              disabled={activeProject === null || branchBusy}
              title={activeProject === null ? undefined : t("branch.change")}
              type="button"
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setBranchMenuPosition({
                  left: Math.max(8, bounds.left + bounds.width / 2 - 120),
                  top: bounds.bottom + 8
                });
                setBranchMenuOpen((open) => !open);
              }}
            >
              <strong>{activeWorkspace?.title ?? t("workspace.noWorkspace")}</strong>
              <small>
                <Icon name="branch" />
                {activeProject === null
                  ? t("workspace.localOnly")
                  : (activeBranch ?? activeProject.defaultBranch)}
                {activeProject === null ? null : <Icon name="chevronDown" />}
              </small>
            </button>
            {!branchMenuOpen || activeProject === null
              ? null
              : createPortal(
                  <div
                    className="branch-menu"
                    role="menu"
                    aria-label={t("branch.menu")}
                    style={branchMenuPosition}
                  >
                    <p>{t("branch.localBranches")}</p>
                    {projectBranches.map((branch) => (
                      <button
                        aria-checked={branch.current}
                        className={branch.current ? "is-current" : undefined}
                        key={branch.name}
                        role="menuitemradio"
                        type="button"
                        onClick={() => switchProjectBranch(branch.name)}
                      >
                        <span>{branch.name}</span>
                        {branch.current ? <span aria-hidden="true">✓</span> : null}
                      </button>
                    ))}
                  </div>,
                  document.body
                )}
          </div>
          <div className="workspace-utilities">
            <output
              className={`save-indicator status-${pingState}`}
              aria-label={t("save.label")}
              aria-live="polite"
              title={
                saveError !== null ? t("save.failed") : dirty ? t("save.saving") : t("save.saved")
              }
            >
              <span aria-hidden="true" />
            </output>
          </div>
        </header>
        <div
          className={`canvas-layout${workspaceSidebarOpen ? " is-sidebar-open" : ""}${
            pendingConnectionSourceId === null ? "" : " is-connecting"
          }${edgeCutMode ? " is-cutting" : ""}`}
        >
          {workspaceSidebarOpen ? (
            <aside
              className="workspace-sidebar"
              aria-label={t("workspace.sidebar")}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextTarget(null);
                const item =
                  event.target instanceof Element
                    ? event.target.closest<HTMLElement>("[data-workspace-id]")
                    : null;
                setWorkspaceContextTarget({
                  workspaceId: item?.dataset.workspaceId ?? null,
                  x: event.clientX,
                  y: event.clientY
                });
              }}
            >
              <div className="workspace-sidebar-header">
                <button
                  aria-expanded="true"
                  aria-label={t("workspace.toggleSidebar")}
                  className="workspace-sidebar-toggle"
                  title={t("workspace.toggleSidebar")}
                  type="button"
                  onClick={toggleWorkspaceSidebar}
                >
                  <Icon name="chevronLeft" />
                </button>
                <strong>{t("workspace.myProjects")}</strong>
                <button
                  aria-label={t("workspace.new")}
                  disabled={projectPickerBusy}
                  title={t("workspace.new")}
                  type="button"
                  onClick={openProjectPicker}
                >
                  <Icon name="plus" />
                </button>
              </div>
              <label className="workspace-filter">
                <Icon name="search" />
                <span className="sr-only">{t("workspace.filter")}</span>
                <input
                  placeholder={t("workspace.filter")}
                  type="search"
                  value={workspaceFilter}
                  onChange={(event) => setWorkspaceFilter(event.target.value)}
                />
              </label>
              <div className="workspace-sidebar-section">
                <div
                  className="workspace-sidebar-list"
                  role="tablist"
                  aria-label={t("workspace.tabs")}
                >
                  {filteredOpenWorkspaces.map((workspace) => {
                    const project = projects.find((entry) => entry.id === workspace.projectId);
                    const active = workspace.id === activeWorkspaceId;
                    return (
                      <div
                        className={`workspace-sidebar-item${active ? " is-active" : ""}`}
                        data-workspace-id={workspace.id}
                        key={workspace.id}
                      >
                        <button
                          aria-selected={active}
                          role="tab"
                          title={project?.name ?? workspace.title}
                          type="button"
                          onClick={() =>
                            void activateWorkspace(workspace).catch((error: unknown) =>
                              setOperationError(
                                error instanceof Error ? error.message : t("workspace.switchFailed")
                              )
                            )
                          }
                        >
                          <span className="workspace-project-icon" aria-hidden="true">
                            <Icon name="folder" />
                          </span>
                          <span>
                            <strong>{project?.name ?? workspace.title}</strong>
                            <small>{project?.defaultBranch ?? t("workspace.localOnly")}</small>
                          </span>
                          <output aria-label={t("workspace.itemCount")}>
                            {active ? nodes.length : "·"}
                          </output>
                        </button>
                        <button
                          aria-label={t("workspace.close", { title: workspace.title })}
                          className="workspace-sidebar-close"
                          title={t("workspace.close", { title: workspace.title })}
                          type="button"
                          onClick={() => closeWorkspaceTab(workspace)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  {filteredOpenWorkspaces.length === 0 ? (
                    <p className="workspace-sidebar-empty">{t("workspace.noResults")}</p>
                  ) : null}
                </div>
              </div>
              <div className="workspace-sidebar-footer">
                <nav aria-label={t("workspace.navigation")}>
                  {workspaceSections.map((item) => (
                    <button
                      aria-current={section === item ? "page" : undefined}
                      className={section === item ? "is-active" : undefined}
                      key={item}
                      title={t(sectionTranslationKeys[item])}
                      type="button"
                      onClick={() => setSection(item)}
                    >
                      <Icon name={sectionIcons[item]} />
                      {t(sectionTranslationKeys[item])}
                    </button>
                  ))}
                </nav>
                <div>
                  <span aria-hidden="true" />
                  {t("workspace.localOnly")}
                </div>
              </div>
            </aside>
          ) : null}
          {!workspaceSidebarOpen ? (
            <button
              aria-expanded="false"
              aria-label={t("workspace.toggleSidebar")}
              className="workspace-sidebar-reopen"
              title={t("workspace.toggleSidebar")}
              type="button"
              onClick={toggleWorkspaceSidebar}
            >
              <Icon name="chevronRight" />
            </button>
          ) : null}
          {section === "runs" ? (
            <RunHistoryPanel workspaceId={activeWorkspace?.id ?? null} />
          ) : section === "settings" ? (
            <LocalSettingsPanel theme={theme} onThemeChange={setTheme} />
          ) : (
            <>
              <section
                className="flow-surface"
                aria-label={t("canvas.aria")}
                data-testid="canvas-surface"
                ref={flowSurfaceRef}
                onContextMenuCapture={(event) => {
                  const surfaceSelection = selectedNodeIdsFromSurface(event.currentTarget);
                  const selectionIds =
                    surfaceSelection.length > 1 ? surfaceSelection : resolveSelectedNodeIds();
                  if (selectionIds.length <= 1) return;
                  if (
                    event.target instanceof Element &&
                    event.target.closest(
                      ".react-flow__controls, .react-flow__minimap, .selection-toolbar, button, input, textarea, select, [role='menu']"
                    ) !== null
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  setContextTarget({
                    kind: "selection",
                    ids: selectionIds,
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
                onMouseDownCapture={(event) => {
                  const surfaceSelection = selectedNodeIdsFromSurface(event.currentTarget);
                  if (
                    event.button !== 2 ||
                    surfaceSelection.length > 1 ||
                    resolveSelectedNodeIds().length > 1 ||
                    !(event.target instanceof Element) ||
                    event.target.closest(".react-flow__pane") === null ||
                    event.target.closest(".react-flow__node") !== null ||
                    event.target.closest(".react-flow__edge") !== null
                  ) {
                    return;
                  }
                  const bounds = event.currentTarget.getBoundingClientRect();
                  event.preventDefault();
                  beginTerminalDraft(
                    { x: event.clientX, y: event.clientY },
                    { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
                  );
                }}
                onKeyDown={(event) => {
                  if (
                    selectedNode === null ||
                    (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const bounds = (event.target as HTMLElement).getBoundingClientRect();
                  setContextTarget({
                    kind: "node",
                    id: selectedNode.id,
                    x: bounds.left + Math.min(bounds.width, 220),
                    y: bounds.top + 32
                  });
                }}
                onDoubleClick={(event) => {
                  // Only the empty canvas background opens the add menu. Double-clicks on nodes,
                  // the zoom controls, minimap or any toolbar button must not trigger it.
                  if (
                    event.target instanceof Element &&
                    event.target.closest(".react-flow__pane") !== null
                  ) {
                    openAddMenu(
                      reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
                    );
                  }
                }}
                onDragOver={(event) => {
                  if (![...event.dataTransfer.types].includes("Files")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  const files = [...event.dataTransfer.files];
                  if (files.length === 0) return;
                  event.preventDefault();
                  dropFilesOnCanvas(files, { x: event.clientX, y: event.clientY });
                }}
              >
                {activeWorkspace !== null && (
                  <>
                    <TerminalNodeContext.Provider value={terminalContext}>
                      <WorkflowRunNodeContext.Provider value={runOverlay}>
                        <WorkflowRunEdgeContext.Provider value={edgeRunOverlay}>
                          <AgentConversationEdgeContext.Provider value={edgeConversationOverlay}>
                            <ReactFlow<ForgeFlowNode, ForgeFlowEdge>
                              key={activeWorkspaceId ?? "none"}
                              nodes={nodes}
                              edges={renderedEdges}
                              nodeTypes={nodeTypes}
                              edgeTypes={edgeTypes}
                              defaultViewport={viewport}
                              onNodesChange={handleNodesChange}
                              onEdgesChange={onEdgesChange}
                              onConnect={handleConnect}
                              onMoveEnd={(_event, nextViewport) => setViewport(nextViewport)}
                              onSelectionChange={({ nodes: flowSelection }) => {
                                selectedNodeIdsRef.current = flowSelection.map((node) => node.id);
                              }}
                              onNodeClick={(_event, node) => {
                                selectNode(node.id);
                                if (
                                  pendingConnectionSourceId !== null &&
                                  pendingConnectionSourceId !== node.id
                                ) {
                                  handleConnect({
                                    source: pendingConnectionSourceId,
                                    target: node.id,
                                    sourceHandle: null,
                                    targetHandle: null
                                  });
                                  setPendingConnectionSourceId(null);
                                }
                              }}
                              onNodeContextMenu={(event, node) => {
                                event.preventDefault();
                                const selectionIds = resolveSelectedNodeIds();
                                if (selectionIds.length > 1 && selectionIds.includes(node.id)) {
                                  setContextTarget({
                                    kind: "selection",
                                    ids: selectionIds,
                                    x: event.clientX,
                                    y: event.clientY
                                  });
                                  return;
                                }
                                selectNode(node.id);
                                setContextTarget({
                                  kind: "node",
                                  id: node.id,
                                  x: event.clientX,
                                  y: event.clientY
                                });
                              }}
                              onEdgeContextMenu={(event, edge) => {
                                event.preventDefault();
                                setContextTarget({
                                  kind: "edge",
                                  id: edge.id,
                                  x: event.clientX,
                                  y: event.clientY
                                });
                              }}
                              onEdgeClick={(_event, edge) => {
                                if (!edgeCutMode) return;
                                removeEdge(edge.id);
                                setCanvasHint(t("canvas.connectionCut"));
                              }}
                              onPaneClick={() => {
                                selectNode(null);
                                setFocusedNodeId(null);
                                setPendingConnectionSourceId(null);
                                setCanvasHint(null);
                                setContextTarget(null);
                                setBranchMenuOpen(false);
                              }}
                              onPaneContextMenu={(event) => {
                                event.preventDefault();
                                if (
                                  terminalDraftRef.current !== null ||
                                  suppressPaneContextMenu.current
                                ) {
                                  return;
                                }
                                if (resolveSelectedNodeIds().length > 1) {
                                  setContextTarget({
                                    kind: "selection",
                                    ids: resolveSelectedNodeIds(),
                                    x: event.clientX,
                                    y: event.clientY
                                  });
                                  return;
                                }
                                openAddMenu(
                                  reactFlow.screenToFlowPosition({
                                    x: event.clientX,
                                    y: event.clientY
                                  })
                                );
                              }}
                              minZoom={0.1}
                              maxZoom={2.5}
                              connectionRadius={64}
                              nodesDraggable
                              nodesConnectable
                              elementsSelectable
                              panOnDrag={[0, 1]}
                              panActivationKeyCode="Space"
                              deleteKeyCode={null}
                              selectionOnDrag={false}
                              selectionKeyCode={["Control", "Meta"]}
                              multiSelectionKeyCode={["Control", "Meta"]}
                              proOptions={{ hideAttribution: true }}
                            >
                              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                              {nodes.length > 0 ? (
                                <MiniMap
                                  className="canvas-minimap"
                                  pannable
                                  zoomable
                                  ariaLabel={t("canvas.minimap")}
                                  nodeColor={(node) =>
                                    nodeColor(node.type as CanvasNodeType | undefined)
                                  }
                                />
                              ) : null}
                              <Controls showInteractive={false} />
                              {selectedNode === null ||
                              selectedNodes.length > 1 ||
                              contextTarget !== null ? null : (
                                <NodeToolbar
                                  className="selection-toolbar nodrag nopan"
                                  isVisible
                                  nodeId={selectedNode.id}
                                  offset={8}
                                  position={Position.Bottom}
                                >
                                  <button
                                    aria-label={t("canvas.center")}
                                    title={t("canvas.center")}
                                    type="button"
                                    onClick={() => centerNode(selectedNode.id)}
                                  >
                                    <Icon name="center" />
                                  </button>
                                  <button
                                    aria-label={t("context.rename")}
                                    title={t("context.rename")}
                                    type="button"
                                    onClick={() =>
                                      setEditTarget({
                                        kind: "node",
                                        id: selectedNode.id,
                                        value: selectedNode.data.title
                                      })
                                    }
                                  >
                                    <Icon name="edit" />
                                  </button>
                                  <button
                                    aria-label={t("context.duplicate")}
                                    title={t("context.duplicate")}
                                    type="button"
                                    onClick={() => duplicateCanvasNode(selectedNode)}
                                  >
                                    <Icon name="copy" />
                                  </button>
                                  <button
                                    aria-label={t("context.connect")}
                                    title={t("context.connect")}
                                    type="button"
                                    onClick={() => {
                                      setPendingConnectionSourceId(selectedNode.id);
                                      setCanvasHint(t("context.chooseTarget"));
                                    }}
                                  >
                                    <Icon name="branch" />
                                  </button>
                                  <button
                                    aria-label={t(
                                      selectedNode.type === "note"
                                        ? "note.executeForward"
                                        : "context.handoffNext"
                                    )}
                                    disabled={
                                      selectedNode.type === "note"
                                        ? !edges.some((edge) => {
                                            if (edge.source !== selectedNode.id) return false;
                                            const target = nodes.find(
                                              (node) => node.id === edge.target
                                            );
                                            return (
                                              target !== undefined &&
                                              isTerminalBackedNode(
                                                target.type ?? "task",
                                                target.data.adapterId
                                              ) &&
                                              terminalAdapterId(target.data.adapterId) !== "shell"
                                            );
                                          })
                                        : nodeSessionIds[selectedNode.id] === undefined ||
                                          !edges.some((edge) => {
                                            if (edge.source !== selectedNode.id) return false;
                                            const target = nodes.find(
                                              (node) => node.id === edge.target
                                            );
                                            return (
                                              target !== undefined &&
                                              terminalAdapterId(target.data.adapterId) !== "shell"
                                            );
                                          })
                                    }
                                    title={t(
                                      selectedNode.type === "note"
                                        ? "note.executeForward"
                                        : "context.handoffNext"
                                    )}
                                    type="button"
                                    onClick={() =>
                                      void (selectedNode.type === "note"
                                        ? executeNoteNode(selectedNode, "forward")
                                        : prepareTerminalHandoff(selectedNode))
                                    }
                                  >
                                    <Icon name="handoff" />
                                  </button>
                                  {isTerminalBackedNode(
                                    selectedNode.type ?? "task",
                                    selectedNode.data.adapterId
                                  ) &&
                                  terminalAdapterId(selectedNode.data.adapterId) !== "shell" ? (
                                    <>
                                      <button
                                        aria-label={t("composer.open")}
                                        title={t("composer.open")}
                                        type="button"
                                        onClick={() => setComposerNodeId(selectedNode.id)}
                                      >
                                        <Icon name="compose" />
                                      </button>
                                      <button
                                        aria-label={t("messages.openInbox")}
                                        title={t("messages.openInbox")}
                                        type="button"
                                        onClick={() =>
                                          setAgentInboxTarget({
                                            nodeId: selectedNode.id,
                                            title: selectedNode.data.title
                                          })
                                        }
                                      >
                                        <Icon name="runs" />
                                      </button>
                                    </>
                                  ) : null}
                                  <button
                                    aria-label={t("context.deleteNode")}
                                    className="is-danger"
                                    title={t("context.deleteNode")}
                                    type="button"
                                    onClick={() => deleteCanvasNode(selectedNode)}
                                  >
                                    <Icon name="trash" />
                                  </button>
                                </NodeToolbar>
                              )}
                              {selectedNode === null ||
                              selectedNodes.length > 1 ||
                              contextTarget !== null ||
                              selectedRunNode === null ? null : (
                                <NodeToolbar
                                  className="run-inspector-toolbar nodrag nopan"
                                  isVisible
                                  nodeId={selectedNode.id}
                                  offset={8}
                                  position={Position.Top}
                                >
                                  <WorkflowNodeInspector node={selectedRunNode} />
                                </NodeToolbar>
                              )}
                            </ReactFlow>
                          </AgentConversationEdgeContext.Provider>
                        </WorkflowRunEdgeContext.Provider>
                      </WorkflowRunNodeContext.Provider>
                    </TerminalNodeContext.Provider>
                    {workflowDraft !== null &&
                    (workflowDraft.state === "ready" || workflowDraft.state === "needs_input") ? (
                      <WorkflowApprovalPanel
                        draft={workflowDraft}
                        onApprove={approveDraft}
                        onCancel={discardDraft}
                        onAnswerQuestion={answerDraftQuestion}
                        agents={agentDescriptors}
                        onAssignAgent={(nodeId, adapter) => void assignDraftAgent(nodeId, adapter)}
                        onApplyPreset={(preset) => void applyAgentPreset(preset)}
                      />
                    ) : null}
                    {/*
                      One bar, eight controls. Undo/redo and the three things you create belong in
                      reach; everything else is either rare (templates, clearing the canvas) or set
                      once (the execution profile), so it lives behind the overflow instead of
                      competing for attention with the work.
                    */}
                    <div
                      className="canvas-tools"
                      aria-label={t("canvas.tools")}
                      data-testid="canvas-toolbar"
                      role="toolbar"
                      tabIndex={0}
                    >
                      <button
                        aria-label={t("canvas.undo")}
                        disabled={!canUndo}
                        title={t("canvas.undo") + " (Ctrl+Z)"}
                        type="button"
                        onClick={undoCanvas}
                      >
                        <Icon name="undo" />
                      </button>
                      <button
                        aria-label={t("canvas.redo")}
                        disabled={!canRedo}
                        title={t("canvas.redo") + " (Ctrl+Shift+Z)"}
                        type="button"
                        onClick={redoCanvas}
                      >
                        <Icon name="redo" />
                      </button>
                      <span className="canvas-tool-divider" aria-hidden="true" />
                      <button
                        aria-label={t("topbar.addTerminal")}
                        data-testid="canvas-add-terminal"
                        disabled={activeProject === null}
                        title={t("topbar.addTerminal")}
                        type="button"
                        onClick={() => addWorkspaceNode("terminal")}
                      >
                        <Icon name="terminal" />
                        {t("topbar.addTerminal").replace("+ ", "")}
                      </button>
                      <button
                        aria-label={t("topbar.addAgent")}
                        data-testid="canvas-add-node"
                        disabled={activeProject === null}
                        title={t("topbar.addAgent")}
                        type="button"
                        onClick={() => openAddMenu()}
                      >
                        <Icon name="agent" />
                        {t("topbar.addAgent").replace("+ ", "")}
                      </button>
                      <button
                        aria-label={t("topbar.addNote")}
                        disabled={activeProject === null}
                        title={t("topbar.addNote")}
                        type="button"
                        onClick={() => addWorkspaceNode("note")}
                      >
                        <Icon name="note" />
                        {t("palette.note")}
                      </button>
                      <span className="canvas-tool-divider" aria-hidden="true" />
                      <button
                        aria-label={t("canvas.fit")}
                        title={t("canvas.fit") + " (F)"}
                        type="button"
                        onClick={fitView}
                      >
                        <Icon name="fit" />
                      </button>
                      <button
                        aria-label={t("mission.start")}
                        className="canvas-tool-primary"
                        disabled={activeProject === null}
                        type="button"
                        title={t("mission.start")}
                        onClick={() => void startFlow()}
                      >
                        <Icon name="runs" />
                        {t("mission.start")}
                      </button>
                      <details
                        className="canvas-tool-more"
                        open={canvasMoreOpen}
                        onToggle={(event) => setCanvasMoreOpen(event.currentTarget.open)}
                      >
                        <summary aria-label={t("canvas.more")} title={t("canvas.more")}>
                          <Icon name="more" />
                        </summary>
                        <div role="menu" aria-label={t("canvas.moreMenu")}>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              setEditTarget({ kind: "mission", value: mission });
                            }}
                          >
                            {mission.length === 0 ? t("mission.add") : t("mission.edit")}
                          </button>
                          <button
                            disabled={activeWorkspace === null}
                            data-testid="open-activity"
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              setActivityOpen(true);
                            }}
                          >
                            {t("activity.title")}
                          </button>
                          <button
                            disabled={activeWorkspace === null}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              setHandoffHistoryOpen(true);
                            }}
                          >
                            {t("handoff.history")}
                          </button>
                          <button
                            disabled={nodes.length < 2}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              organizeCanvas();
                            }}
                          >
                            {t("canvas.organize")}
                          </button>
                          <button
                            aria-label={t("canvas.cutConnections")}
                            aria-pressed={edgeCutMode}
                            className={edgeCutMode ? "is-active" : undefined}
                            disabled={edges.length === 0 && !edgeCutMode}
                            role="menuitem"
                            title={t("canvas.cutConnectionsHint")}
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              setEdgeCutMode((active) => !active);
                              setPendingConnectionSourceId(null);
                            }}
                          >
                            {t("canvas.cutConnections")}
                          </button>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              setTemplateMenuOpen((open) => !open);
                            }}
                          >
                            {t("canvas.templates")}
                          </button>
                          <span className="canvas-more-divider" aria-hidden="true" />
                          <div
                            className="canvas-more-profile"
                            role="group"
                            aria-label={t("execution.label")}
                          >
                            <span className="control-label">{t("execution.label")}</span>
                            <div>
                              {(["economy", "balanced", "maximum"] as const).map((profile) => (
                                <button
                                  key={profile}
                                  type="button"
                                  className={executionProfile === profile ? "is-active" : ""}
                                  aria-pressed={executionProfile === profile}
                                  onClick={() => setExecutionProfile(profile)}
                                >
                                  {t(`execution.${profile}`)}
                                </button>
                              ))}
                            </div>
                          </div>
                          <span className="canvas-more-divider" aria-hidden="true" />
                          <button
                            className="is-danger"
                            data-testid="clear-workflow"
                            disabled={nodes.length === 0 && edges.length === 0}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setCanvasMoreOpen(false);
                              clearWorkspaceWorkflow();
                            }}
                          >
                            {t("workflow.clear")}
                          </button>
                        </div>
                      </details>
                    </div>
                    {templateMenuOpen ? (
                      <section className="canvas-template-menu" aria-label="Modelos de canvas">
                        <header>
                          <div>
                            <strong>Modelos prontos</strong>
                            <p>
                              Estruturas iniciais para o canvas. Não fazem parte do Histórico local.
                            </p>
                          </div>
                          <button
                            aria-label="Fechar modelos"
                            type="button"
                            onClick={() => setTemplateMenuOpen(false)}
                          >
                            Fechar
                          </button>
                        </header>
                        <div>
                          <button
                            disabled={activeProject === null}
                            type="button"
                            onClick={() => void applyCanvasTemplate("empty")}
                          >
                            <strong>Canvas vazio</strong>
                            <span>Comece sem nós e monte o fluxo manualmente.</span>
                          </button>
                          <button
                            disabled={activeProject === null}
                            type="button"
                            onClick={() => void applyCanvasTemplate("blueprint-to-pr")}
                          >
                            <strong>Blueprint para PR</strong>
                            <span>Explorar, implementar, testar e revisar antes da entrega.</span>
                          </button>
                          <button
                            disabled={activeProject === null}
                            type="button"
                            onClick={() => void applyCanvasTemplate("bugfix")}
                          >
                            <strong>Correção de bug</strong>
                            <span>Investigar, corrigir, testar e registrar evidências.</span>
                          </button>
                          <button
                            disabled={activeProject === null}
                            type="button"
                            onClick={() => void applyCanvasTemplate("landing-page")}
                          >
                            <strong>Landing Page Premium</strong>
                            <span>
                              Estratégia, copy, visual, duas frentes de implementação e revisão.
                            </span>
                          </button>
                          <button
                            disabled={activeProject === null}
                            type="button"
                            onClick={() => void applyCanvasTemplate("saas")}
                          >
                            <strong>SaaS completo</strong>
                            <span>
                              Produto, UX, back-end, front-end e QA sobre o mesmo briefing.
                            </span>
                          </button>
                          <button
                            disabled={activeProject === null}
                            type="button"
                            onClick={() => void applyCanvasTemplate("system")}
                          >
                            <strong>Sistema completo</strong>
                            <span>Arquitetura, domínio, dados, interface e integração final.</span>
                          </button>
                        </div>
                        {activeProject === null ? (
                          <small>Abra ou crie um projeto para aplicar um modelo.</small>
                        ) : null}
                      </section>
                    ) : null}
                    {terminalDraftPreview === null ? null : (
                      <div
                        className="terminal-draft-preview"
                        style={{
                          left: terminalDraftPreview.left,
                          top: terminalDraftPreview.top,
                          width: terminalDraftPreview.width,
                          height: terminalDraftPreview.height
                        }}
                      >
                        <span>{t("canvas.releaseTerminal")}</span>
                        <output>
                          {Math.round(terminalDraftPreview.width)} ×{" "}
                          {Math.round(terminalDraftPreview.height)}
                        </output>
                      </div>
                    )}
                    {activeProject !== null && nodes.length === 0 ? (
                      <section
                        className="canvas-empty-state is-project-open"
                        aria-label={t("canvas.emptyAria")}
                      >
                        <p className="fd-eyebrow">{activeProject.name}</p>
                        <h1>{t("canvas.readyTitle")}</h1>
                        <p>{t("canvas.readyBody")}</p>
                        <ol className="canvas-onboarding-steps">
                          <li>
                            <span>1</span>
                            <div>
                              <strong>{t("canvas.onboardingTerminal")}</strong>
                              <small>{t("canvas.onboardingTerminalBody")}</small>
                            </div>
                          </li>
                          <li>
                            <span>2</span>
                            <div>
                              <strong>{t("canvas.onboardingConnect")}</strong>
                              <small>{t("canvas.onboardingConnectBody")}</small>
                            </div>
                          </li>
                          <li>
                            <span>3</span>
                            <div>
                              <strong>{t("canvas.onboardingDiscover")}</strong>
                              <small>{t("canvas.onboardingDiscoverBody")}</small>
                            </div>
                          </li>
                        </ol>
                        <div className="empty-state-actions">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => addWorkspaceNode("terminal")}
                          >
                            {t("topbar.addTerminal")}
                          </button>
                          <button type="button" onClick={() => openAddMenu()}>
                            {t("topbar.addAgent")}
                          </button>
                          <button type="button" onClick={() => addWorkspaceNode("note")}>
                            {t("topbar.addNote")}
                          </button>
                        </div>
                      </section>
                    ) : null}
                  </>
                )}
                {activeWorkspace === null && (
                  <section className="canvas-empty-state" aria-labelledby="open-project-title">
                    <p className="fd-eyebrow">{t("canvas.localEyebrow")}</p>
                    <h1 id="open-project-title">{t("canvas.openTitle")}</h1>
                    <p>{t("canvas.openBody")}</p>
                    <button
                      className="primary-button"
                      data-testid="project-open"
                      disabled={projectPickerBusy}
                      type="button"
                      onClick={openProjectPicker}
                    >
                      {projectPickerBusy ? t("common.opening") : t("canvas.openProject")}
                    </button>
                  </section>
                )}
              </section>
              {activeWorkspace !== null && (
                <div className="canvas-count" aria-label={t("canvas.count")}>
                  {nodes.length} {t(nodes.length === 1 ? "common.item" : "common.items")} ·{" "}
                  {edges.length}{" "}
                  {t(edges.length === 1 ? "common.connection" : "common.connections")}
                </div>
              )}
              {operationError === null && saveError === null ? null : (
                <div className="canvas-notice is-error" role="alert">
                  <span>{visibleOperationError ?? saveError}</span>
                  {gitInitializationDirectory === null ? null : (
                    <button
                      type="button"
                      disabled={gitInitializationBusy}
                      onClick={initializeLocalProject}
                    >
                      {gitInitializationBusy
                        ? t("canvas.initializingGit")
                        : t("canvas.initializeGit")}
                    </button>
                  )}
                  {operationError === null ? null : (
                    <button
                      aria-label={t("common.close")}
                      className="canvas-notice-close"
                      title={t("common.close")}
                      type="button"
                      onClick={() => setOperationError(null)}
                    >
                      ×
                    </button>
                  )}
                </div>
              )}
              {canvasHint === null ? null : (
                <div className="canvas-notice is-hint" role="status">
                  {canvasHint}
                </div>
              )}
              {dryRun === null || operationError !== null || saveError !== null ? null : (
                <div className="canvas-notice" role="status">
                  {t("canvas.dryRun", {
                    workflow: dryRun.workflowId,
                    status: t(dryRun.valid ? "canvas.valid" : "canvas.invalid"),
                    nodes: dryRun.order.length,
                    concurrency: dryRun.concurrency
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </section>
      <CommandPalette open={paletteOpen} onClose={closeAddMenu} onAddNode={addNodeFromMenu} />
      {contextTarget === null || contextActions.length === 0 ? null : (
        <CanvasContextMenu
          actions={contextActions}
          label={t(
            contextTarget.kind === "node"
              ? "context.nodeMenu"
              : contextTarget.kind === "selection"
                ? "context.selectionMenu"
                : "context.edgeMenu",
            contextTarget.kind === "selection" ? { count: contextTarget.ids.length } : undefined
          )}
          x={contextTarget.x}
          y={contextTarget.y}
          onAction={handleContextAction}
          onClose={() => setContextTarget(null)}
        />
      )}
      {workspaceContextTarget === null ? null : (
        <CanvasContextMenu
          actions={workspaceContextActions}
          label={t("workspace.contextMenu")}
          x={workspaceContextTarget.x}
          y={workspaceContextTarget.y}
          onAction={handleWorkspaceContextAction}
          onClose={() => setWorkspaceContextTarget(null)}
        />
      )}
      {editTarget === null ? null : (
        <CanvasEditDialog
          cancelLabel={t("common.cancel")}
          initialValue={editTarget.value}
          label={t(
            editTarget.kind === "node"
              ? "context.titleLabel"
              : editTarget.kind === "note-content"
                ? "note.contentLabel"
                : editTarget.kind === "progress"
                  ? "context.progressLabel"
                  : editTarget.kind === "blocker"
                    ? "context.blockerLabel"
                    : editTarget.kind === "context-inclusion"
                      ? "source.policyLabel"
                      : editTarget.kind === "context-source"
                        ? editTarget.sourceKind === "link"
                          ? "source.linkLabel"
                          : "source.contentLabel"
                        : "mission.label"
          )}
          maxLength={
            editTarget.kind === "note-content" ||
            editTarget.kind === "blocker" ||
            editTarget.kind === "context-source"
              ? 100_000
              : editTarget.kind === "mission"
                ? 20_000
                : 160
          }
          multiline={
            (editTarget.kind === "context-source" && editTarget.sourceKind !== "link") ||
            editTarget.kind === "note-content" ||
            editTarget.kind === "blocker" ||
            editTarget.kind === "mission"
          }
          saveLabel={t("context.save")}
          title={t(
            editTarget.kind === "node"
              ? "context.renameTitle"
              : editTarget.kind === "note-content"
                ? "note.editContent"
                : editTarget.kind === "progress"
                  ? "context.updateProgress"
                  : editTarget.kind === "blocker"
                    ? "context.setBlocker"
                    : editTarget.kind === "context-inclusion"
                      ? "source.editPolicy"
                      : editTarget.kind === "context-source"
                        ? "source.editContent"
                        : "mission.dialogTitle"
          )}
          onClose={() => setEditTarget(null)}
          onSave={saveEditTarget}
        />
      )}
      {roleTarget === null ? null : (
        <CanvasRoleDialog
          initialPermissions={roleTarget.data.permissions}
          initialRole={roleTarget.data.role}
          nodeTitle={roleTarget.data.title}
          onClose={() => setRoleTarget(null)}
          onSave={saveRole}
        />
      )}
      {edgeContractTarget === null ? null : (
        <CanvasEdgeContractDialog
          initialContract={
            edgeContractTarget.data ?? {
              schemaVersion: "1.0",
              kind: "dependency",
              label: "",
              requiredEvidenceTypes: []
            }
          }
          onClose={() => setEdgeContractTarget(null)}
          onSave={saveEdgeContract}
        />
      )}
      {handoffRouteChoice === null ? null : (
        <CanvasHandoffTargetDialog
          routes={handoffRouteChoice.routes}
          onClose={() => setHandoffRouteChoice(null)}
          onSelect={(route) => {
            const source = nodes.find((node) => node.id === handoffRouteChoice.sourceNodeId);
            if (source !== undefined) void createHandoffDraft(source, route);
          }}
        />
      )}
      {handoffReview === null ? null : (
        <CanvasHandoffDialog
          busy={handoffReview.busy}
          error={handoffReview.error}
          handoff={handoffReview.record}
          rawOutput={handoffReview.rawOutput}
          {...(handoffReview.destinationOutput === undefined
            ? {}
            : { destinationOutput: handoffReview.destinationOutput })}
          onClose={() => setHandoffReview(null)}
          onSave={savePreparedHandoff}
          onSend={submitPreparedHandoff}
          onChooseDestination={(content) => {
            if (handoffReview !== null) {
              setHandoffDestinationChoice({ content });
            }
          }}
          onStartDestination={(content) =>
            void submitPreparedHandoff(content, { startDestination: true })
          }
          onInspectDestination={() => void inspectHandoffDestination()}
          onMarkSent={() => void markHandoffSent()}
          onCancelDelivery={() => void cancelHandoffDelivery()}
        />
      )}
      {handoffDestinationChoice === null ? null : (
        <CanvasHandoffDestinationDialog
          destinations={nodes.flatMap((node) => {
            if (!isTerminalBackedNode(node.type ?? "task", node.data.adapterId)) return [];
            const sessionId = nodeSessionIds[node.id];
            const session = sessionId === undefined ? undefined : terminalSessions[sessionId];
            if (
              sessionId === undefined ||
              session === undefined ||
              isTerminalSessionFinished(session.state)
            ) {
              return [];
            }
            return [{ sessionId, title: node.data.title }];
          })}
          onClose={() => setHandoffDestinationChoice(null)}
          onSelect={(sessionId) => {
            const choice = handoffDestinationChoice;
            setHandoffDestinationChoice(null);
            void submitPreparedHandoff(choice.content, { targetSessionId: sessionId });
          }}
        />
      )}
      <ActivityPanel
        open={activityOpen}
        workspaceId={activeWorkspace?.id ?? null}
        onClose={() => setActivityOpen(false)}
        onSelectNode={(nodeId) => {
          setActivityOpen(false);
          selectNode(nodeId);
          reactFlow.fitView({ nodes: [{ id: nodeId }], duration: 220, maxZoom: 1.2 });
        }}
      />
      <HandoffHistoryPanel
        handoffs={handoffHistory}
        open={handoffHistoryOpen}
        onClose={() => setHandoffHistoryOpen(false)}
        onRefresh={() => void loadHandoffHistory()}
        onReview={(record) => {
          setHandoffHistoryOpen(false);
          setHandoffReview({ record, rawOutput: "", busy: false, error: null });
        }}
      />
      <AgentInboxPanel
        workspaceId={activeWorkspace?.id ?? null}
        agentNodeId={agentInboxTarget?.nodeId ?? null}
        agentTitle={agentInboxTarget?.title ?? null}
        open={agentInboxTarget !== null}
        onClose={() => setAgentInboxTarget(null)}
      />
      {composerNode === null ? null : (
        <PromptComposer
          disabledReason={composerDisabledReason}
          draft={composerDrafts[composerNode.id] ?? ""}
          key={composerNode.id}
          mentions={composerMentions}
          nodeTitle={composerNode.data.title}
          onClose={() => setComposerNodeId(null)}
          onDraftChange={(draft) =>
            setComposerDrafts((current) => ({ ...current, [composerNode.id]: draft }))
          }
          onSend={(content) => sendComposedPrompt(composerNode.id, content)}
        />
      )}
    </main>
  );
}

function readLegacyActiveProjectId(projects: readonly GitProjectDto[]): string | null {
  try {
    const projectId = window.localStorage.getItem("forgedeck.active-project-id");
    return projects.some((project) => project.id === projectId) ? projectId : null;
  } catch {
    return null;
  }
}

function createWorkspaceCanvas(workspace: WorkspaceDto) {
  return { ...createDefaultCanvas(), id: workspace.canvasId, title: workspace.title };
}

function terminalAdapterId(adapterId: string | undefined): TerminalAdapterId {
  if (
    adapterId === "shell" ||
    adapterId === "claude-code" ||
    adapterId === "codex" ||
    adapterId === "opencode"
  ) {
    return adapterId;
  }
  return "shell";
}

function queueTerminalStart(kind: AddNodeKind, nodeId: string, queue: Set<string>): void {
  const preset = getAddNodePreset(kind);
  if (isTerminalBackedNode(preset.nodeType, preset.data.adapterId)) {
    queue.add(nodeId);
  }
}

function withoutRecordKey<T extends Record<string, string>>(record: T, key: string): T {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key)) as T;
}

function withoutNumericRecordKey(
  record: Readonly<Record<string, number>>,
  key: string
): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function useCanvasAutosave(loaded: boolean): () => Promise<void> {
  const { t } = useI18n();
  const dirty = useCanvasStore((state) => state.dirty);
  const changeVersion = useCanvasStore((state) => state.changeVersion);
  const markSaved = useCanvasStore((state) => state.markSaved);
  const setSaveError = useCanvasStore((state) => state.setSaveError);
  const savePromise = useRef<Promise<void> | null>(null);

  const persist = useCallback((): Promise<void> => {
    if (savePromise.current !== null) {
      return savePromise.current;
    }
    const run = async () => {
      try {
        while (true) {
          const state = useCanvasStore.getState();
          if (!state.dirty) {
            break;
          }
          const version = state.changeVersion;
          const result = await window.forgedeck.canvases.save({
            snapshot: toCanvasSnapshot(state)
          });
          markSaved(version, result.revision);
        }
      } catch (error: unknown) {
        setSaveError(error instanceof Error ? error.message : t("canvas.autosaveFailed"));
        throw error;
      }
    };
    const pending = run().finally(() => {
      savePromise.current = null;
    });
    savePromise.current = pending;
    return pending;
  }, [markSaved, setSaveError, t]);

  useEffect(() => {
    if (!loaded || !dirty) {
      return;
    }
    const timer = window.setTimeout(() => void persist().catch(() => undefined), 500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [changeVersion, dirty, loaded, persist]);
  return persist;
}

function useKeyboardNavigation(input: {
  readonly nodes: readonly ForgeFlowNode[];
  readonly selectedNodeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onPalette: () => void;
  readonly onClosePalette: () => void;
  readonly onFitView: () => void;
  readonly onDryRun: () => void;
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (terminalOwnsKeyboard(event.target) || isEditableKeyboardTarget(target)) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.onPalette();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        input.onCopy();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        input.onPaste();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) input.onRedo();
        else input.onUndo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        input.onRedo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        input.onDryRun();
        return;
      }
      if (event.key === "Escape") {
        input.onClosePalette();
        return;
      }
      if (event.key.toLowerCase() === "f") {
        input.onFitView();
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = nextKeyboardNodeId(input.nodes, input.selectedNodeId, direction);
        if (next !== null) {
          event.preventDefault();
          input.onSelect(next);
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [input]);
}

function nodeColor(type: CanvasNodeType | undefined): string {
  switch (type) {
    case "terminal":
      return "#f5f5f5";
    case "agent":
      return "#d4d4d4";
    case "note":
      return "#a3a3a3";
    case "artifact":
      return "#d7b86f";
    case "text":
    case "page":
      return "#91b7df";
    case "link":
      return "#77d2d0";
    case "file":
    case "folder":
      return "#b5a2df";
    case "image":
    case "drawing":
      return "#d694bf";
    case "shape":
      return "#90a7c9";
    case "frame":
      return "#718096";
    case "comment":
      return "#d7b86f";
    case "gate":
      return "#737373";
    default:
      return "#525252";
  }
}

async function waitForTerminalOutput(sessionId: string): Promise<string> {
  let output = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    output = (await window.forgedeck.terminals.buffer({ sessionId })).data;
    if (output.length > 0) return output;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
  }
  return output;
}

function isTerminalSessionFinished(state: TerminalSession["state"]): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
}
