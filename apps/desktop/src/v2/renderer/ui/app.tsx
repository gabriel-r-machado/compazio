import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type DragEvent,
  type MouseEvent,
  type PointerEvent
} from "react";

import type {
  CanvasNode,
  CanvasGroup,
  AgentDefinition,
  AgentInstallation,
  AgentRole,
  ProcessState,
  TerminalNode,
  PortalNode,
  PortalDownloadOffer,
  PortalRuntimeSnapshot,
  TerminalSession,
  Position,
  Workspace,
  WorkspaceSummary,
  WorkspaceOperationalState
} from "@forgedeck/compazio-v2-domain";

import {
  ContextMenu,
  OperationalInspector,
  PolicySelector,
  RecoveryNotice,
  TeamSummary,
  Timeline
} from "./operational-ui";
import { terminalOutputBus } from "./terminal-output-bus";
import { terminalInputBus } from "./terminal-input-bus";
import { forcedAgentPasteFrame } from "./terminal-paste";
import { createTerminalResizeCoordinator } from "./terminal-resize-coordinator";
import { terminalTuiWheelPlan } from "./terminal-tui-wheel";
import { FilePreviewCard, FileTreeCard } from "./file-ui";
import { PromptComposer } from "./prompt-composer";
import { MarkdownPreview } from "./markdown";
import { CompazioMark, ToolIcon } from "./brand";
import { isFreeWorkspaceLimitError, userFacingIpcError } from "./ipc-errors";
import { connectionFor } from "./connection-capabilities";
import {
  ZOOM_STEP,
  boundsOf,
  cablePath,
  centerOn,
  connectionGeometry,
  consumesWheelScroll,
  detailLevel,
  fitViewport,
  minimapProjection,
  nodesInRect,
  normalizeRect,
  panBy,
  snapToGrid,
  toCanvasPoint,
  unionRect,
  visibleRect,
  viewportInsertionPoint,
  zoomAtCenter,
  zoomAtPoint,
  type Rect,
  type Size,
  type Viewport
} from "./canvas-viewport";

/** Um nó menor do que isto deixa de ser utilizável; vale para as duas alças de redimensionamento. */
const MIN_NODE_WIDTH = 200;
const MIN_NODE_HEIGHT = 120;
/** Historical TeamRun panels stay out of the public real-terminal product. */
const LEGACY_TEAM_RUNTIME_UI_ENABLED = false;

type Sessions = Readonly<Record<string, TerminalSession>>;
type InstallationByAgent = Readonly<Record<string, AgentInstallation>>;
type TerminalDialogState =
  | { readonly mode: "create"; readonly position?: Position; readonly size?: Size }
  | { readonly mode: "edit"; readonly terminal: TerminalNode };

interface DragInteraction {
  readonly type: "node";
  readonly nodeIds: readonly string[];
  readonly startPointer: { readonly x: number; readonly y: number };
  readonly startPositions: Readonly<Record<string, Position>>;
}

interface PanInteraction {
  readonly type: "pan";
  readonly startPointer: { readonly x: number; readonly y: number };
  readonly startViewport: Viewport;
}

interface MarqueeInteraction {
  readonly type: "marquee";
  readonly origin: Position;
}

interface DrawTerminalInteraction {
  readonly type: "draw-terminal";
  readonly origin: Position;
}

type Interaction = DragInteraction | PanInteraction | MarqueeInteraction | DrawTerminalInteraction;

interface PointerCaptureState {
  readonly element: Element;
  readonly pointerId: number;
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly canvasPosition?: Position;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly selection?: true;
}

interface PendingNodeDeletion {
  readonly nodeIds: readonly string[];
  readonly label: string;
}

interface ConfirmationRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly resolve: (confirmed: boolean) => void;
}

type ConfirmationOptions = Omit<ConfirmationRequest, "resolve">;

const terminalStateLabel: Record<ProcessState, string> = {
  idle: "Pronto",
  starting: "Iniciando",
  running: "Executando",
  "waiting-input": "Aguardando entrada",
  stopping: "Encerrando",
  stopped: "Encerrado",
  completed: "Encerrado",
  failed: "Falhou",
  disconnected: "Indisponível"
};

function isTerminalElement(value: EventTarget | null): value is Element {
  return (
    value instanceof Element &&
    value.closest(".v2-terminal-body, .xterm, .xterm-helper-textarea") !== null
  );
}

function terminalOwnsKeyboard(event: KeyboardEvent): boolean {
  const focusedTerminal = document.querySelector<HTMLElement>(
    ".v2-terminal-body[data-terminal-focused='true']"
  );
  if (focusedTerminal?.contains(document.activeElement)) return true;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return [...path, event.target, document.activeElement].some(isTerminalElement);
}

function isTextEditingElement(value: EventTarget | null): boolean {
  return (
    value instanceof Element && value.matches("input, textarea, select, [contenteditable='true']")
  );
}

export function V2App() {
  const [workspaceList, setWorkspaceList] = useState<readonly WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [initializingWorkspace, setInitializingWorkspace] = useState(true);
  const [operations, setOperations] = useState<WorkspaceOperationalState | null>(null);
  const [sessions, setSessions] = useState<Sessions>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<readonly string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  /** Scissors mode: while it is on, clicking a connection cuts it instead of selecting it. */
  const [cutMode, setCutMode] = useState(false);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<Awaited<
    ReturnType<typeof window.compazioV2.license.status>
  > | null>(null);
  const [licenseDialogOpen, setLicenseDialogOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<Awaited<
    ReturnType<typeof window.compazioV2.updates.status>
  > | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [agentDefinitions, setAgentDefinitions] = useState<readonly AgentDefinition[]>([]);
  const [roles, setRoles] = useState<readonly AgentRole[]>([]);
  const [installations, setInstallations] = useState<InstallationByAgent>({});
  const [terminalDialog, setTerminalDialog] = useState<TerminalDialogState | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [roleLibraryOpen, setRoleLibraryOpen] = useState(false);
  const [teamSummaryOpen, setTeamSummaryOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Selection is lightweight; the inspector is explicitly opened by the user.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pendingNodeDeletion, setPendingNodeDeletion] = useState<PendingNodeDeletion | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composerTerminalId, setComposerTerminalId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [canvasBox, setCanvasBox] = useState<Size>({ width: 1200, height: 800 });
  const [marquee, setMarquee] = useState<{
    readonly origin: Position;
    readonly current: Position;
  } | null>(null);
  const [creationTool, setCreationTool] = useState<"terminal" | null>(null);
  const [terminalDraft, setTerminalDraft] = useState<{
    readonly origin: Position;
    readonly current: Position;
  } | null>(null);
  const [linking, setLinking] = useState<{
    readonly sourceId: string;
    readonly from: Position;
    readonly to: Position;
  } | null>(null);
  const clipboard = useRef<{
    readonly sourceWorkspaceId: string;
    readonly nodeIds: readonly string[];
  } | null>(null);
  const interaction = useRef<Interaction | null>(null);
  const viewportTimer = useRef<number | null>(null);
  const operationalRefreshTimer = useRef<number | null>(null);
  const workspaceIdRef = useRef<string | null>(null);
  const canvasElement = useRef<HTMLDivElement | null>(null);
  const pointerCapture = useRef<PointerCaptureState | null>(null);

  const releasePointerCapture = useCallback((pointerId?: number): void => {
    const captured = pointerCapture.current;
    if (captured === null || (pointerId !== undefined && captured.pointerId !== pointerId)) return;
    try {
      if (captured.element.hasPointerCapture(captured.pointerId))
        captured.element.releasePointerCapture(captured.pointerId);
    } catch {
      // The node may have been removed while a pointer gesture was in flight.
    }
    pointerCapture.current = null;
  }, []);

  const capturePointer = useCallback(
    (element: Element, pointerId: number): void => {
      releasePointerCapture();
      try {
        element.setPointerCapture(pointerId);
        pointerCapture.current = { element, pointerId };
      } catch {
        // Pointer capture is an optimization. The pointer event still remains usable without it.
      }
    },
    [releasePointerCapture]
  );

  useEffect(() => {
    const onLostPointerCapture = (event: Event): void => {
      const captured = pointerCapture.current;
      const pointerEvent = event as globalThis.PointerEvent;
      if (
        captured === null ||
        event.target !== captured.element ||
        pointerEvent.pointerId !== captured.pointerId
      )
        return;
      pointerCapture.current = null;
      interaction.current = null;
      setPanning(false);
      setMarquee(null);
      setTerminalDraft(null);
      setLinking(null);
    };
    window.addEventListener("lostpointercapture", onLostPointerCapture);
    return () => window.removeEventListener("lostpointercapture", onLostPointerCapture);
  }, []);

  useEffect(() => {
    workspaceIdRef.current = workspace?.id ?? null;
  }, [workspace?.id]);

  const refreshList = useCallback(async (): Promise<{
    readonly workspaces: readonly WorkspaceSummary[];
    readonly lastOpenedWorkspaceId: string | null;
  }> => {
    const listing = await window.compazioV2.workspace.list();
    setWorkspaceList(listing.workspaces);
    return listing;
  }, []);

  const run = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
      setMessage(null);
    } catch (error: unknown) {
      if (isFreeWorkspaceLimitError(error)) {
        setLicenseDialogOpen(true);
        return;
      }
      setMessage(userFacingIpcError(error, "A operação não pôde ser concluída."));
    }
  }, []);

  // Transient feedback must never sit over the canvas forever after a recoverable action.
  useEffect(() => {
    if (message === null) return;
    const timeout = window.setTimeout(() => {
      setMessage((current) => (current === message ? null : current));
    }, 7_000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const refreshAgentData = useCallback(async (): Promise<void> => {
    const [definitions, nextRoles, detected] = await Promise.all([
      window.compazioV2.agents.listDefinitions(),
      window.compazioV2.roles.list(),
      window.compazioV2.agents.detectAll()
    ]);
    setAgentDefinitions(definitions);
    setRoles(nextRoles);
    setInstallations(
      Object.fromEntries(detected.map((installation) => [installation.agentId, installation]))
    );
  }, []);

  const openWorkspace = useCallback(async (workspaceId: string): Promise<Workspace> => {
    const [nextWorkspace, nextOperations] = await Promise.all([
      window.compazioV2.workspace.open({ workspaceId }),
      window.compazioV2.operations.get({ workspaceId })
    ]);
    setWorkspace(nextWorkspace);
    setOperations(nextOperations);
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setCreationTool(null);
    setTerminalDraft(null);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    return nextWorkspace;
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      void (async () => {
        try {
          const listing = await window.compazioV2.workspace.list();
          if (!active) return;
          setWorkspaceList(listing.workspaces);
          const workspaceId = listing.lastOpenedWorkspaceId ?? listing.workspaces[0]?.id;
          if (workspaceId !== undefined) await openWorkspace(workspaceId);
        } catch (error: unknown) {
          if (active) setMessage(userFacingIpcError(error, "O workspace não pôde ser restaurado."));
        } finally {
          if (active) setInitializingWorkspace(false);
        }
      })();
      void refreshAgentData().catch(toMessage(setMessage));
      void window.compazioV2.license
        .status()
        .then(setLicenseStatus)
        .catch(() => undefined);
      void window.compazioV2.updates
        .status()
        .then(setUpdateStatus)
        .catch(() => undefined);
    });
    const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
      if (event.type === "terminal.state") {
        setSessions((current) => ({ ...current, [event.session.terminalNodeId]: event.session }));
      } else if (event.type === "terminal.output") {
        terminalOutputBus.publish(event.sessionId, event.data);
      } else {
        setMessage(event.message);
      }
    });
    const unsubscribeOperations = window.compazioV2.operations.onEvent((state) => {
      if (workspaceIdRef.current !== state.workspaceId) return;
      setOperations(state);
      if (operationalRefreshTimer.current !== null)
        window.clearTimeout(operationalRefreshTimer.current);
      operationalRefreshTimer.current = window.setTimeout(() => {
        void window.compazioV2.workspace
          .open({ workspaceId: state.workspaceId })
          .then(setWorkspace)
          .catch(toMessage(setMessage));
      }, 80);
    });
    const unsubscribeNavigation = window.compazioV2.operations.onNavigate((target) => {
      void openWorkspace(target.workspaceId)
        .then(() => {
          setSelectedNodeId(target.terminalId ?? null);
          setSelectedEdgeId(null);
          setTeamSummaryOpen(target.runId !== undefined);
        })
        .catch(toMessage(setMessage));
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeOperations();
      unsubscribeNavigation();
      if (operationalRefreshTimer.current !== null)
        window.clearTimeout(operationalRefreshTimer.current);
    };
  }, [openWorkspace, refreshAgentData]);

  const adoptWorkspace = useCallback(
    async (next: Workspace): Promise<void> => {
      setWorkspace(next);
      await refreshList();
    },
    [refreshList]
  );

  const startTerminalSession = useCallback(
    async (workspaceId: string, nodeId: string): Promise<void> => {
      const session = await window.compazioV2.terminal.start({ workspaceId, nodeId });
      setSessions((current) => ({ ...current, [nodeId]: session }));
    },
    []
  );

  const scheduleViewportSave = useCallback(
    (next: Workspace): void => {
      if (viewportTimer.current !== null) window.clearTimeout(viewportTimer.current);
      viewportTimer.current = window.setTimeout(() => {
        void window.compazioV2.workspace
          .updateSettings({ workspaceId: next.id, settings: next.settings })
          .then(adoptWorkspace)
          .catch(toMessage(setMessage));
      }, 300);
    },
    [adoptWorkspace]
  );

  useEffect(
    () => () => {
      if (viewportTimer.current !== null) window.clearTimeout(viewportTimer.current);
    },
    []
  );

  const createWorkspace = (): void => setWorkspaceDialogOpen(true);

  const requestConfirmation = useCallback(
    (options: ConfirmationOptions): Promise<boolean> =>
      new Promise((resolve) => setConfirmation({ ...options, resolve })),
    []
  );

  const respondToConfirmation = useCallback(
    (confirmed: boolean): void => {
      if (confirmation === null) return;
      setConfirmation(null);
      confirmation.resolve(confirmed);
    },
    [confirmation]
  );

  const createWorkspaceFromDialog = (input: {
    readonly name: string;
    readonly directory: string;
  }): void => {
    void run(async () => {
      const created = await window.compazioV2.workspace.create({
        name: input.name,
        workingDirectory: input.directory
      });
      await adoptWorkspace(created);
      setWorkspaceDialogOpen(false);
    });
  };

  const deleteWorkspace = (): void => {
    if (workspace === null) return;
    const target = workspace;
    void requestConfirmation({
      title: "Excluir workspace",
      message: `Excluir o workspace “${target.name}”? O diretório de código não será apagado.`,
      confirmLabel: "Excluir",
      danger: true
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(async () => {
        await window.compazioV2.workspace.delete({ workspaceId: target.id });
        setWorkspace(null);
        setOperations(null);
        setSessions({});
        terminalOutputBus.clear();
        await refreshList();
      });
    });
  };

  /** Size of the canvas box; every viewport calculation is anchored to what the person can see. */
  const canvasSize = useCallback(
    (): Size => ({
      width: canvasElement.current?.clientWidth ?? canvasBox.width,
      height: canvasElement.current?.clientHeight ?? canvasBox.height
    }),
    [canvasBox]
  );

  // O minimapa e o enquadramento leem o tamanho durante o render, então ele vira estado observado.
  useEffect(() => {
    const element = canvasElement.current;
    if (element === null) return;
    const measure = (): void =>
      setCanvasBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspace?.id]);

  const canvasPointerPosition = useCallback((clientX: number, clientY: number): Position => {
    const rect = canvasElement.current?.getBoundingClientRect();
    if (rect === undefined) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const current = interaction.current;
    if (current === null || workspace === null) return;
    if (current.type === "pan") {
      const viewport = {
        ...current.startViewport,
        x: current.startViewport.x + event.clientX - current.startPointer.x,
        y: current.startViewport.y + event.clientY - current.startPointer.y
      };
      setWorkspace({ ...workspace, settings: { ...workspace.settings, viewport } });
      return;
    }
    if (current.type === "marquee") {
      setMarquee({
        origin: current.origin,
        current: toCanvasPoint(
          workspace.settings.viewport,
          canvasPointerPosition(event.clientX, event.clientY)
        )
      });
      return;
    }
    if (current.type === "draw-terminal") {
      setTerminalDraft({
        origin: current.origin,
        current: toCanvasPoint(
          workspace.settings.viewport,
          canvasPointerPosition(event.clientX, event.clientY)
        )
      });
      return;
    }
    const zoom = workspace.settings.viewport.zoom;
    const offset = {
      x: (event.clientX - current.startPointer.x) / zoom,
      y: (event.clientY - current.startPointer.y) / zoom
    };
    setWorkspace({
      ...workspace,
      nodes: workspace.nodes.map((candidate) =>
        current.startPositions[candidate.id] === undefined
          ? candidate
          : {
              ...candidate,
              position: {
                x: current.startPositions[candidate.id].x + offset.x,
                y: current.startPositions[candidate.id].y + offset.y
              }
            }
      )
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    releasePointerCapture(event.pointerId);
    const current = interaction.current;
    interaction.current = null;
    setPanning(false);
    if (workspace === null) return;
    if (current?.type === "pan") {
      scheduleViewportSave(workspace);
      return;
    }
    if (current?.type === "marquee") {
      const selection =
        marquee === null
          ? []
          : nodesInRect(workspace.nodes, normalizeRect(marquee.origin, marquee.current));
      setMarquee(null);
      setSelectedNodeIds(selection);
      setSelectedNodeId(selection.at(-1) ?? null);
      return;
    }
    if (current?.type === "draw-terminal") {
      const rect =
        terminalDraft === null
          ? { x: current.origin.x, y: current.origin.y, width: 0, height: 0 }
          : normalizeRect(terminalDraft.origin, terminalDraft.current);
      setTerminalDraft(null);
      setCreationTool(null);
      setTerminalDialog({
        mode: "create",
        position: snapToGrid({ x: rect.x, y: rect.y }),
        ...(rect.width < 40 || rect.height < 40
          ? {}
          : {
              size: {
                width: Math.min(4_000, Math.max(MIN_NODE_WIDTH, rect.width)),
                height: Math.min(3_000, Math.max(MIN_NODE_HEIGHT, rect.height))
              }
            })
      });
      return;
    }
    if (current?.type !== "node") return;
    void run(async () =>
      adoptWorkspace(
        await window.compazioV2.nodes.moveMany({
          workspaceId: workspace.id,
          positions: Object.fromEntries(
            workspace.nodes
              .filter((node) => current.nodeIds.includes(node.id))
              .map((node) => [node.id, node.position])
          )
        })
      )
    );
  };

  const startDrag = (event: PointerEvent<HTMLElement>, node: CanvasNode): void => {
    if (workspace === null) return;
    // Espaço pressionado ou botão do meio significam "andar pelo canvas": o nó devolve o evento
    // para a superfície em vez de sequestrar o arrasto.
    if (spaceHeld || event.button === 1) return;
    event.stopPropagation();
    if (connectionSourceId !== null) {
      if (connectionSourceId === node.id) {
        setMessage("Escolha outro nó para completar a conexão.");
        return;
      }
      void run(async () => {
        const target = workspace.nodes.find((candidate) => candidate.id === node.id);
        const source = workspace.nodes.find((candidate) => candidate.id === connectionSourceId);
        if (source === undefined || target === undefined) return;
        const connection = connectionFor(source, target);
        await adoptWorkspace(
          await window.compazioV2.edges.add({
            workspaceId: workspace.id,
            ...connection
          })
        );
        setConnectionSourceId(null);
      });
      return;
    }
    const toggle = event.ctrlKey || event.metaKey || event.shiftKey;
    if (toggle) {
      // Ctrl/Cmd/Shift + click is selection only. It must never arm a drag, otherwise the tiny
      // pointer movement that naturally happens during a click moves cards onto one another.
      const nextSelection = selectedNodeIds.includes(node.id)
        ? selectedNodeIds.filter((id) => id !== node.id)
        : [...selectedNodeIds, node.id];
      setSelectedNodeIds(nextSelection);
      setSelectedNodeId(nextSelection.at(-1) ?? null);
      setSelectedEdgeId(null);
      setContextMenu(null);
      return;
    }
    const nextSelection = selectedNodeIds.includes(node.id) ? selectedNodeIds : [node.id];
    const draggedNodes = workspace.nodes.filter((candidate) =>
      nextSelection.includes(candidate.id)
    );
    capturePointer(event.currentTarget, event.pointerId);
    interaction.current = {
      type: "node",
      nodeIds: draggedNodes.map((candidate) => candidate.id),
      startPointer: { x: event.clientX, y: event.clientY },
      startPositions: Object.fromEntries(
        draggedNodes.map((candidate) => [candidate.id, candidate.position])
      )
    };
    setSelectedNodeIds(nextSelection);
    setSelectedNodeId(nextSelection.at(-1) ?? null);
    setSelectedEdgeId(null);
    setContextMenu(null);
  };

  const canvasPoint = useCallback(
    (clientX: number, clientY: number): Position => {
      const rect = canvasElement.current?.getBoundingClientRect();
      if (rect === undefined || workspace === null) return { x: 80, y: 80 };
      const { viewport } = workspace.settings;
      return snapToGrid(toCanvasPoint(viewport, { x: clientX - rect.left, y: clientY - rect.top }));
    },
    [workspace]
  );

  const createGroup = useCallback((): void => {
    if (workspace === null || selectedNodeIds.length === 0) return;
    void run(async () => {
      await adoptWorkspace(
        await window.compazioV2.groups.create({
          workspaceId: workspace.id,
          title: "Grupo",
          nodeIds: selectedNodeIds
        })
      );
    });
  }, [adoptWorkspace, run, selectedNodeIds, workspace]);

  const organizeSelected = useCallback((): void => {
    if (workspace === null || selectedNodeIds.length < 2) return;
    const nodes = workspace.nodes.filter((node) => selectedNodeIds.includes(node.id));
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const columns = Math.ceil(Math.sqrt(nodes.length));
    const cellWidth = Math.max(...nodes.map((node) => node.size.width)) + 48;
    const cellHeight = Math.max(...nodes.map((node) => node.size.height)) + 48;
    void run(async () => {
      await adoptWorkspace(
        await window.compazioV2.nodes.moveMany({
          workspaceId: workspace.id,
          positions: Object.fromEntries(
            nodes.map((node, index) => [
              node.id,
              {
                x: left + (index % columns) * cellWidth,
                y: top + Math.floor(index / columns) * cellHeight
              }
            ])
          )
        })
      );
    });
  }, [adoptWorkspace, run, selectedNodeIds, workspace]);

  const copySelection = useCallback((): void => {
    if (workspace === null || selectedNodeIds.length === 0) return;
    clipboard.current = { sourceWorkspaceId: workspace.id, nodeIds: selectedNodeIds };
    setMessage(`${selectedNodeIds.length} nó(s) copiado(s).`);
  }, [selectedNodeIds, workspace]);

  const pasteSelection = useCallback((): void => {
    if (workspace === null || clipboard.current === null) return;
    const source = clipboard.current;
    const position = canvasPoint(
      canvasElement.current?.getBoundingClientRect().left ?? 160,
      canvasElement.current?.getBoundingClientRect().top ?? 160
    );
    void run(async () =>
      adoptWorkspace(
        await window.compazioV2.canvas.paste({
          workspaceId: workspace.id,
          sourceWorkspaceId: source.sourceWorkspaceId,
          nodeIds: source.nodeIds,
          position: { x: position.x + 48, y: position.y + 48 }
        })
      )
    );
  }, [adoptWorkspace, canvasPoint, run, workspace]);

  const undoWorkspace = useCallback((): void => {
    if (workspace === null) return;
    void run(async () => {
      await adoptWorkspace(await window.compazioV2.workspace.undo({ workspaceId: workspace.id }));
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
    });
  }, [adoptWorkspace, run, workspace]);

  const redoWorkspace = useCallback((): void => {
    if (workspace === null) return;
    void run(async () => {
      await adoptWorkspace(await window.compazioV2.workspace.redo({ workspaceId: workspace.id }));
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
    });
  }, [adoptWorkspace, run, workspace]);

  // Every React surface that must cover a Portal reports itself here. The main process owns the
  // decision; the canvas only says what is open, so no modal has to remember the rule on its own.
  useEffect(() => {
    const overlays: ("command-palette" | "menu" | "inspector" | "modal")[] = [];
    if (paletteOpen) overlays.push("command-palette");
    if (contextMenu !== null || moreMenuOpen) overlays.push("menu");
    if (timelineOpen || inspectorOpen) overlays.push("inspector");
    if (
      terminalDialog !== null ||
      workspaceDialogOpen ||
      roleLibraryOpen ||
      licenseDialogOpen ||
      updateDialogOpen ||
      shortcutsOpen ||
      pendingNodeDeletion !== null ||
      confirmation !== null ||
      composerTerminalId !== null
    )
      overlays.push("modal");
    void window.compazioV2.portals
      .surface({
        overlays,
        ...(workspace === null ? {} : { workspaceId: workspace.id })
      })
      .catch(() => undefined);
  }, [
    composerTerminalId,
    confirmation,
    contextMenu,
    licenseDialogOpen,
    moreMenuOpen,
    inspectorOpen,
    pendingNodeDeletion,
    paletteOpen,
    roleLibraryOpen,
    terminalDialog,
    timelineOpen,
    updateDialogOpen,
    shortcutsOpen,
    workspace,
    workspaceDialogOpen
  ]);

  useEffect(() => {
    // Only the viewport is the renderer's to report: whether the window is minimized is a fact of
    // the window itself, and asking the document would call an occluded window minimized.
    const report = (): void => {
      void window.compazioV2.portals
        .surface({
          canvasViewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
        })
        .catch(() => undefined);
    };
    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, []);

  const resetFocus = useCallback((): void => {
    releasePointerCapture();
    interaction.current = null;
    setConnectionSourceId(null);
    setContextMenu(null);
    setSelectedEdgeId(null);
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    canvasElement.current?.focus();
    // A Portal holds the keyboard in its own process: releasing focus has to reach the main side.
    void window.compazioV2.portals.resetFocus({}).catch(() => undefined);
  }, [releasePointerCapture]);

  /**
   * Um único gesto de fundo: arrastar anda pelo canvas, Shift desenha a seleção e o botão do meio
   * ou a barra de espaço andam mesmo sobre um nó. Sem isso o canvas parece travado.
   */
  const startCanvasGesture = (event: PointerEvent<HTMLElement>): void => {
    if (workspace === null) return;
    if (isTerminalElement(event.target)) return;
    const target = event.target as HTMLElement;
    const onSurface = event.target === event.currentTarget || target.classList.contains("v2-world");
    const forcePan = event.button === 1 || spaceHeld;
    if (!onSurface && !forcePan) return;
    if (creationTool === "terminal" && onSurface && event.button === 0 && !forcePan) {
      const origin = toCanvasPoint(
        workspace.settings.viewport,
        canvasPointerPosition(event.clientX, event.clientY)
      );
      capturePointer(event.currentTarget, event.pointerId);
      interaction.current = { type: "draw-terminal", origin };
      setTerminalDraft({ origin, current: origin });
      setContextMenu(null);
      event.preventDefault();
      return;
    }
    // A right-click on the empty canvas is an action on the current selection, not a new canvas
    // gesture. Keeping the selection intact lets its context menu open wherever the user clicked.
    if (onSurface && event.button === 2) {
      setContextMenu(null);
      setMoreMenuOpen(false);
      return;
    }
    capturePointer(event.currentTarget, event.pointerId);
    setContextMenu(null);
    setMoreMenuOpen(false);
    if (
      onSurface &&
      (event.shiftKey || event.ctrlKey || event.metaKey) &&
      event.button === 0 &&
      !forcePan
    ) {
      const origin = toCanvasPoint(
        workspace.settings.viewport,
        canvasPointerPosition(event.clientX, event.clientY)
      );
      interaction.current = { type: "marquee", origin };
      setMarquee({ origin, current: origin });
      return;
    }
    interaction.current = {
      type: "pan",
      startPointer: { x: event.clientX, y: event.clientY },
      startViewport: workspace.settings.viewport
    };
    setPanning(true);
    if (!onSurface) return;
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
  };

  /**
   * Ligação por arrasto: sai de uma borda do nó e termina onde o ponteiro soltar. O gesto vive na
   * janela porque ele atravessa nós, alças e o fundo do canvas — nenhum elemento sozinho o vê
   * inteiro.
   */
  const startLink = useCallback(
    (
      node: CanvasNode,
      side: "left" | "right" | "top" | "bottom",
      event: PointerEvent<HTMLElement>
    ): void => {
      if (workspace === null) return;
      capturePointer(event.currentTarget, event.pointerId);
      const anchor = handleAnchor(node, side);
      setLinking({
        sourceId: node.id,
        from: anchor,
        to: toCanvasPoint(
          workspace.settings.viewport,
          canvasPointerPosition(event.clientX, event.clientY)
        )
      });
    },
    [canvasPointerPosition, capturePointer, workspace]
  );

  useEffect(() => {
    if (linking === null || workspace === null) return;
    const viewport = workspace.settings.viewport;
    const onMove = (event: globalThis.PointerEvent): void => {
      const to = toCanvasPoint(viewport, canvasPointerPosition(event.clientX, event.clientY));
      setLinking((current) => (current === null ? null : { ...current, to }));
    };
    const onUp = (event: globalThis.PointerEvent): void => {
      const targetId = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      const source = linking.sourceId;
      releasePointerCapture(event.pointerId);
      setLinking(null);
      if (targetId === undefined || targetId === source) return;
      if (
        workspace.edges.some(
          (edge) => edge.sourceNodeId === source && edge.targetNodeId === targetId
        )
      ) {
        setMessage("Esses nós já estão conectados.");
        return;
      }
      void run(async () => {
        const sourceNode = workspace.nodes.find((node) => node.id === source);
        const targetNode = workspace.nodes.find((node) => node.id === targetId);
        if (sourceNode === undefined || targetNode === undefined) return;
        await adoptWorkspace(
          await window.compazioV2.edges.add({
            workspaceId: workspace.id,
            ...connectionFor(sourceNode, targetNode)
          })
        );
      });
    };
    const onCancel = (): void => {
      releasePointerCapture();
      setLinking(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [adoptWorkspace, canvasPointerPosition, linking, releasePointerCapture, run, workspace]);

  const applyViewport = useCallback(
    (viewport: Viewport): void => {
      if (workspace === null) return;
      const next = { ...workspace, settings: { ...workspace.settings, viewport } };
      setWorkspace(next);
      scheduleViewportSave(next);
    },
    [scheduleViewportSave, workspace]
  );

  const zoomBy = useCallback(
    (factor: number): void => {
      if (workspace === null) return;
      applyViewport(zoomAtCenter(workspace.settings.viewport, factor, canvasSize()));
    },
    [applyViewport, canvasSize, workspace]
  );

  /** Toolbar and shortcut actions always create in the viewport currently being worked on. */
  const insertionPointInCurrentView = useCallback((): Position => {
    if (workspace === null) return { x: 80, y: 80 };
    return viewportInsertionPoint(workspace.settings.viewport, canvasSize(), workspace.nodes);
  }, [canvasSize, workspace]);

  const addTerminal = useCallback(
    (position?: Position): void => {
      if (workspace === null) return;
      setTerminalDialog({ mode: "create", position: position ?? insertionPointInCurrentView() });
    },
    [insertionPointInCurrentView, workspace]
  );

  const configureTerminal = (terminal: TerminalNode): void =>
    setTerminalDialog({ mode: "edit", terminal });

  const addNote = useCallback(
    (position?: Position): void => {
      if (workspace === null) return;
      const insertionPoint = position ?? insertionPointInCurrentView();
      void run(async () =>
        adoptWorkspace(
          await window.compazioV2.nodes.addNote({
            workspaceId: workspace.id,
            position: insertionPoint
          })
        )
      );
    },
    [adoptWorkspace, insertionPointInCurrentView, run, workspace]
  );

  /**
   * Trazer arquivos é uma escolha da pessoa no explorador do sistema: markdown, imagem, PDF ou
   * mídia. Cada arquivo vira um card no canvas, lado a lado a partir de onde foi pedido.
   */
  const importFiles = useCallback(
    (position?: Position, paths?: readonly string[]): void => {
      if (workspace === null) return;
      void run(async () => {
        const imported = await window.compazioV2.files.import({
          workspaceId: workspace.id,
          ...(paths === undefined ? {} : { paths })
        });
        if (imported.length === 0) return;
        const origin = position ?? insertionPointInCurrentView();
        let next = workspace;
        for (const [index, file] of imported.entries()) {
          next = await window.compazioV2.nodes.addFilePreview({
            workspaceId: workspace.id,
            filePath: file.path,
            previewKind: file.previewKind,
            position: { x: origin.x + index * 48, y: origin.y + index * 36 }
          });
        }
        await adoptWorkspace(next);
        const copied = imported.filter((file) => file.copied).length;
        setMessage(
          copied === 0
            ? null
            : `${copied} arquivo(s) de fora do workspace foram copiados para .compazio/anexos.`
        );
      });
    },
    [adoptWorkspace, insertionPointInCurrentView, run, workspace]
  );

  const addFileTree = useCallback(
    (position?: Position): void => {
      if (workspace === null) return;
      const insertionPoint = position ?? insertionPointInCurrentView();
      void run(async () =>
        adoptWorkspace(
          await window.compazioV2.nodes.addFileTree({
            workspaceId: workspace.id,
            position: insertionPoint
          })
        )
      );
    },
    [adoptWorkspace, insertionPointInCurrentView, run, workspace]
  );

  const addPortal = useCallback(
    (position?: Position): void => {
      if (workspace === null) return;
      const insertionPoint = position ?? insertionPointInCurrentView();
      void run(async () =>
        adoptWorkspace(
          await window.compazioV2.nodes.addPortal({
            workspaceId: workspace.id,
            url: "about:blank",
            position: insertionPoint
          })
        )
      );
    },
    [adoptWorkspace, insertionPointInCurrentView, run, workspace]
  );

  const dropFileReference = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (workspace === null) return;
      event.preventDefault();
      // Arrastar do explorador do sistema: os arquivos entram pelo mesmo caminho autorizado do
      // seletor nativo, e caem onde foram soltos.
      const dropped = [...event.dataTransfer.files];
      if (dropped.length > 0) {
        const paths = window.compazioV2.files.pathsFromDrop(dropped);
        if (paths.length === 0) {
          setMessage("Não foi possível ler o caminho dos arquivos arrastados.");
          return;
        }
        importFiles(canvasPoint(event.clientX, event.clientY), paths);
        return;
      }
      const raw = event.dataTransfer.getData("application/x-compazio-file");
      if (raw === "") return;
      let payload: { sourceNodeId?: unknown; path?: unknown; kind?: unknown };
      try {
        payload = JSON.parse(raw) as { sourceNodeId?: unknown; path?: unknown; kind?: unknown };
      } catch {
        setMessage("O arquivo arrastado não possui uma referência válida do Compazio.");
        return;
      }
      if (
        typeof payload.sourceNodeId !== "string" ||
        typeof payload.path !== "string" ||
        !["image", "pdf", "video", "text", "unsupported"].includes(String(payload.kind))
      ) {
        setMessage("O arquivo arrastado foi bloqueado por validação de segurança.");
        return;
      }
      const targetId = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]")?.dataset
        .nodeId;
      const target = workspace.nodes.find((node) => node.id === targetId);
      if (target?.type === "terminal") {
        void window.compazioV2.files
          .sendContext({
            workspaceId: workspace.id,
            sourceNodeId: payload.sourceNodeId,
            targetTerminalId: target.id,
            context: {
              kind: "file",
              workspaceId: workspace.id,
              path: payload.path,
              relativePath: payload.path
            }
          })
          .then(() => setMessage("Contexto de arquivo enviado ao terminal conectado."))
          .catch(toMessage(setMessage));
        return;
      }
      void window.compazioV2.nodes
        .addFilePreview({
          workspaceId: workspace.id,
          filePath: payload.path,
          previewKind: payload.kind as "image" | "pdf" | "video" | "text" | "unsupported",
          position: canvasPoint(event.clientX, event.clientY)
        })
        .then(adoptWorkspace)
        .catch(toMessage(setMessage));
    },
    [adoptWorkspace, canvasPoint, importFiles, workspace]
  );

  const activeRun =
    operations === null
      ? undefined
      : [...operations.runs]
          .reverse()
          .find(
            (candidate) =>
              candidate.id === operations.lastSelectedRunId ||
              !["completed", "failed", "cancelled"].includes(candidate.status)
          );
  const openAttentionCount = operations
    ? operations.attention.filter((request) => request.status === "open").length
    : 0;
  const selectedNode =
    workspace?.nodes.find((candidate) => candidate.id === selectedNodeId) ?? undefined;
  const selectedEdge =
    workspace?.edges.find((candidate) => candidate.id === selectedEdgeId) ?? undefined;
  const composerTarget = workspace?.nodes.find(
    (node): node is TerminalNode => node.id === composerTerminalId && node.type === "terminal"
  );

  const fitBounds = useCallback(
    (bounds: Rect): void => {
      if (workspace === null) return;
      applyViewport(fitViewport(bounds, canvasSize()));
    },
    [applyViewport, canvasSize, workspace]
  );

  const fitAll = useCallback((): void => {
    if (workspace === null) return;
    const bounds = boundsOf(workspace.nodes);
    if (bounds === null) {
      applyViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    fitBounds(bounds);
  }, [applyViewport, fitBounds, workspace]);

  const fitTeam = useCallback(
    (runId: string): void => {
      if (workspace === null) return;
      void run(async () =>
        fitBounds(await window.compazioV2.layout.fitTeam({ workspaceId: workspace.id, runId }))
      );
    },
    [fitBounds, run, workspace]
  );

  const fitSelection = useCallback((): void => {
    if (selectedNode !== undefined) {
      fitBounds({
        x: selectedNode.position.x,
        y: selectedNode.position.y,
        width: selectedNode.size.width,
        height: selectedNode.size.height
      });
      return;
    }
    if (activeRun !== undefined) fitTeam(activeRun.id);
  }, [activeRun, fitBounds, fitTeam, selectedNode]);

  const requestNodeDeletion = useCallback((node: CanvasNode): void => {
    setPendingNodeDeletion({
      nodeIds: [node.id],
      label: `“${node.title}” e suas conexões`
    });
  }, []);

  const deleteSelection = useCallback((): void => {
    if (workspace === null) return;
    const selectedNodes = workspace.nodes.filter((node) => selectedNodeIds.includes(node.id));
    if (selectedNodes.length > 0) {
      const label =
        selectedNodes.length === 1
          ? `“${selectedNodes[0]?.title ?? "Canvas"}” e suas conexões`
          : `${selectedNodes.length} canvases e suas conexões`;
      // Electron does not provide browser dialogs consistently. Keep confirmation in the app so
      // Delete, the context menu and multi-selection behave identically on every platform.
      setPendingNodeDeletion({ nodeIds: selectedNodes.map((node) => node.id), label });
    } else if (selectedEdge !== undefined) {
      void run(async () => {
        await adoptWorkspace(
          await window.compazioV2.edges.delete({
            workspaceId: workspace.id,
            edgeId: selectedEdge.id
          })
        );
        setSelectedEdgeId(null);
      });
    }
  }, [adoptWorkspace, run, selectedEdge, selectedNodeIds, workspace]);

  const confirmNodeDeletion = useCallback((): void => {
    if (workspace === null || pendingNodeDeletion === null) return;
    const nodeIds = pendingNodeDeletion.nodeIds.filter((nodeId) =>
      workspace.nodes.some((node) => node.id === nodeId)
    );
    setPendingNodeDeletion(null);
    if (nodeIds.length === 0) return;
    void run(async () => {
      await adoptWorkspace(
        await window.compazioV2.nodes.deleteMany({ workspaceId: workspace.id, nodeIds })
      );
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
    });
  }, [adoptWorkspace, pendingNodeDeletion, run, workspace]);

  /** Cuts one connection. The nodes and everything they hold stay exactly where they are. */
  const cutEdge = useCallback(
    (edgeId: string): void => {
      if (workspace === null) return;
      void run(async () => {
        adoptWorkspace(await window.compazioV2.edges.delete({ workspaceId: workspace.id, edgeId }));
        setSelectedEdgeId((current) => (current === edgeId ? null : current));
      });
    },
    [adoptWorkspace, run, workspace]
  );

  const disconnectSelection = useCallback((): void => {
    if (workspace === null || selectedNodeIds.length === 0) return;
    const selected = new Set(selectedNodeIds);
    const attached = workspace.edges.filter(
      (edge) => selected.has(edge.sourceNodeId) || selected.has(edge.targetNodeId)
    );
    if (attached.length === 0) {
      setMessage("Os canvases selecionados não possuem conexões para desconectar.");
      return;
    }
    void run(async () => {
      let latest = workspace;
      for (const edge of attached) {
        latest = await window.compazioV2.edges.delete({
          workspaceId: workspace.id,
          edgeId: edge.id
        });
      }
      await adoptWorkspace(latest);
      setSelectedEdgeId(null);
    });
  }, [adoptWorkspace, run, selectedNodeIds, workspace]);

  const nudgeSelection = useCallback(
    (deltaX: number, deltaY: number): void => {
      if (workspace === null || selectedNodeIds.length === 0) return;
      const moved = workspace.nodes.filter((node) => selectedNodeIds.includes(node.id));
      setWorkspace({
        ...workspace,
        nodes: workspace.nodes.map((node) =>
          selectedNodeIds.includes(node.id)
            ? { ...node, position: { x: node.position.x + deltaX, y: node.position.y + deltaY } }
            : node
        )
      });
      void run(async () => {
        for (const node of moved) {
          await window.compazioV2.nodes.move({
            workspaceId: workspace.id,
            nodeId: node.id,
            position: { x: node.position.x + deltaX, y: node.position.y + deltaY }
          });
        }
        await adoptWorkspace(await window.compazioV2.workspace.open({ workspaceId: workspace.id }));
      });
    },
    [adoptWorkspace, run, selectedNodeIds, workspace]
  );

  // A barra de espaço vira o modo "mão" enquanto está pressionada, como em qualquer canvas.
  useEffect(() => {
    const isEditing = (target: EventTarget | null): boolean =>
      isTerminalElement(target) ||
      isTextEditingElement(target) ||
      isTerminalElement(document.activeElement);
    const onDown = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || event.repeat || isEditing(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const onUp = (event: KeyboardEvent): void => {
      if (event.code !== "Space") return;
      setSpaceHeld(false);
    };
    const onBlur = (): void => setSpaceHeld(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const editing = terminalOwnsKeyboard(event) || isTextEditingElement(event.target);
      if (editing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoWorkspace();
        else undoWorkspace();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const ids = workspace?.nodes.map((node) => node.id) ?? [];
        setSelectedNodeIds(ids);
        setSelectedNodeId(ids.at(-1) ?? null);
        setSelectedEdgeId(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoWorkspace();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        nudgeSelection(0, (event.key === "ArrowUp" ? -1 : 1) * (event.shiftKey ? 24 : 8));
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        nudgeSelection((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 24 : 8), 0);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault();
        applyViewport({ x: 0, y: 0, zoom: 1 });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "1") {
        event.preventDefault();
        fitAll();
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        addTerminal();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        addNote();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        addFileTree();
      } else if (event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (activeRun !== undefined) fitTeam(activeRun.id);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitSelection();
      } else if (event.key === "Delete") {
        event.preventDefault();
        deleteSelection();
      } else if (event.key === "Escape") {
        resetFocus();
        setTimelineOpen(false);
      } else if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
      } else if (event.ctrlKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteSelection();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        createGroup();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        if (selectedNode?.type === "terminal") setComposerTerminalId(selectedNode.id);
        else setMessage("Selecione um terminal para preparar um prompt.");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeRun,
    addFileTree,
    addNote,
    addTerminal,
    applyViewport,
    copySelection,
    createGroup,
    deleteSelection,
    fitAll,
    fitSelection,
    fitTeam,
    nudgeSelection,
    pasteSelection,
    resetFocus,
    redoWorkspace,
    selectedNode,
    undoWorkspace,
    workspace,
    zoomBy
  ]);

  const runAction = (action: "pause" | "resume" | "cancel" | "fit"): void => {
    if (workspace === null || activeRun === undefined) return;
    if (action === "fit") {
      fitTeam(activeRun.id);
      return;
    }
    const applyAction = (): void =>
      void run(async () => {
        const input = { workspaceId: workspace.id, runId: activeRun.id };
        setOperations(
          action === "pause"
            ? await window.compazioV2.runs.pause(input)
            : action === "resume"
              ? await window.compazioV2.runs.resume(input)
              : await window.compazioV2.runs.cancel(input)
        );
      });
    if (action !== "cancel") {
      applyAction();
      return;
    }
    void requestConfirmation({
      title: "Cancelar execução",
      message: "Arquivos, notas e terminais serão preservados para sua decisão.",
      confirmLabel: "Cancelar execução",
      danger: true
    }).then((confirmed) => {
      if (confirmed) applyAction();
    });
  };

  const recoverRun = (
    runId: string,
    action: "resume" | "restart-agents" | "end" | "canvas-only"
  ): void => {
    if (workspace === null) return;
    void run(async () =>
      setOperations(
        await window.compazioV2.runs.recover({
          workspaceId: workspace.id,
          runId,
          action,
          idempotencyKey: `recover-${runId}-${action}`
        })
      )
    );
  };

  const paletteItems: readonly PaletteItem[] =
    workspace === null
      ? []
      : [
          {
            id: "action:new-terminal",
            title: "Novo Terminal",
            detail: "Ação",
            action: () => addTerminal()
          },
          {
            id: "action:new-note",
            title: "Nova Nota",
            detail: "Ação",
            action: () => addNote()
          },
          {
            id: "action:new-tree",
            title: "Nova Árvore de Arquivos",
            detail: "Ação",
            action: () => addFileTree()
          },
          {
            id: "action:reset-focus",
            title: "Resetar Foco",
            detail: "Visualizar",
            action: resetFocus
          },
          ...workspaceList.map((item) => ({
            id: `workspace:${item.id}`,
            title: item.name,
            detail: "Workspace",
            keywords: item.workingDirectory,
            action: () => void openWorkspace(item.id).catch(toMessage(setMessage))
          })),
          ...workspace.nodes.map((node) => ({
            id: `node:${node.id}`,
            title: node.title,
            detail:
              node.type === "terminal"
                ? "Terminal"
                : node.type === "note"
                  ? "Nota"
                  : node.type === "file-tree"
                    ? "Árvore de arquivos"
                    : "Preview de arquivo",
            keywords: node.type === "note" ? node.content.slice(0, 20_000) : "",
            action: () => {
              setSelectedNodeId(node.id);
              setSelectedNodeIds([node.id]);
              setSelectedEdgeId(null);
              fitBounds({
                x: node.position.x,
                y: node.position.y,
                width: node.size.width,
                height: node.size.height
              });
            }
          })),
          ...workspace.groups.map((group) => ({
            id: `group:${group.id}`,
            title: group.title,
            detail: "Grupo",
            action: () =>
              fitBounds({
                x: group.position.x,
                y: group.position.y,
                width: group.size.width,
                height: group.size.height
              })
          }))
        ];

  if (initializingWorkspace) {
    return (
      <main className="v2-boot" role="status" aria-label="Abrindo o workspace">
        <CompazioMark size={42} />
        <span>Abrindo seu workspace…</span>
      </main>
    );
  }

  return (
    <main className="v2-app" data-sidebar={sidebarOpen ? "expanded" : "collapsed"}>
      <aside className="v2-sidebar" aria-label="Workspaces" aria-hidden={!sidebarOpen}>
        <div className="v2-brand">
          <CompazioMark size={26} />
          <span>Compazio</span>
          <small>Orquestração visual de agentes</small>
        </div>
        <button className="v2-primary" data-testid="v2-create-workspace" onClick={createWorkspace}>
          Novo workspace
        </button>
        <div className="v2-sidebar-label">
          <p className="v2-eyebrow">Workspaces</p>
          <span className="v2-muted">{workspaceList.length}</span>
        </div>
        <nav>
          {workspaceList.length === 0 ? (
            <p className="v2-muted">Nenhum workspace criado.</p>
          ) : (
            workspaceList.map((item) => (
              <div
                key={item.id}
                className={
                  workspace?.id === item.id ? "v2-workspace-row active" : "v2-workspace-row"
                }
              >
                <button
                  className="v2-workspace"
                  onClick={() =>
                    void run(async () => {
                      await openWorkspace(item.id);
                    })
                  }
                >
                  <strong>{item.name}</strong>
                  <small>{item.workingDirectory}</small>
                </button>
                {workspace?.id === item.id && (
                  <button
                    className="v2-workspace-delete"
                    aria-label={`Excluir workspace ${item.name}`}
                    title="Excluir workspace"
                    onClick={deleteWorkspace}
                  >
                    <ToolIcon name="trash" />
                  </button>
                )}
              </div>
            ))
          )}
        </nav>
        <div className="v2-sidebar-footer">
          <button className="v2-quiet" onClick={() => setLicenseDialogOpen(true)}>
            Licença
          </button>
          <button className="v2-quiet" onClick={() => setShortcutsOpen(true)}>
            Atalhos
          </button>
          <button
            className="v2-quiet"
            onClick={() => {
              setUpdateDialogOpen(true);
              void window.compazioV2.updates
                .status()
                .then(setUpdateStatus)
                .catch(() => undefined);
            }}
          >
            Updates
          </button>
          {workspace !== null && (
            <button className="v2-quiet v2-danger subtle" onClick={deleteWorkspace}>
              Excluir workspace
            </button>
          )}
        </div>
      </aside>
      <section className="v2-main">
        {workspace === null ? (
          <EmptyState
            onCreate={createWorkspace}
            definitions={agentDefinitions}
            installations={installations}
          />
        ) : (
          <>
            <header className="v2-toolbar">
              <div className="v2-toolbar-title">
                <button
                  className="v2-sidebar-toggle"
                  aria-label={sidebarOpen ? "Ocultar workspaces" : "Mostrar workspaces"}
                  aria-pressed={sidebarOpen}
                  title="Mostrar ou ocultar a lista de workspaces"
                  onClick={() => setSidebarOpen((current) => !current)}
                >
                  <ToolIcon name="sidebar" />
                </button>
                <h1>{workspace.name}</h1>
                <span title={workspace.workingDirectory}>{workspace.workingDirectory}</span>
              </div>
              <div className="v2-actions" aria-label="Ações do workspace">
                {LEGACY_TEAM_RUNTIME_UI_ENABLED && operations !== null && (
                  <PolicySelector
                    state={operations}
                    disabled={false}
                    onChange={(policyId) =>
                      void run(async () =>
                        setOperations(
                          await window.compazioV2.policy.update({
                            workspaceId: workspace.id,
                            policyId
                          })
                        )
                      )
                    }
                  />
                )}
                <span className="v2-divider" aria-hidden="true" />
                <button
                  className="v2-icon-button"
                  aria-label="Buscar"
                  title="Buscar — Ctrl+K"
                  onClick={() => setPaletteOpen(true)}
                >
                  <ToolIcon name="search" />
                </button>
                <button
                  className="v2-icon-button v2-danger subtle"
                  data-testid="v2-delete-workspace"
                  aria-label="Excluir workspace"
                  title="Excluir workspace — o diretório de código não é apagado"
                  onClick={deleteWorkspace}
                >
                  <ToolIcon name="trash" />
                </button>
                {LEGACY_TEAM_RUNTIME_UI_ENABLED && (
                  <button
                    className={
                      openAttentionCount > 0
                        ? "v2-icon-button v2-attention-button has-open"
                        : "v2-icon-button v2-attention-button"
                    }
                    aria-label={`Itens que precisam de atenção: ${openAttentionCount}`}
                    title="Itens que precisam de atenção"
                    onClick={() => {
                      setSelectedNodeId(null);
                      setSelectedNodeIds([]);
                      setSelectedEdgeId(null);
                      setTimelineOpen(false);
                      setTeamSummaryOpen(false);
                      setInspectorOpen(true);
                    }}
                  >
                    <ToolIcon name="alert" />
                    {openAttentionCount > 0 && <span>{openAttentionCount}</span>}
                  </button>
                )}
                {LEGACY_TEAM_RUNTIME_UI_ENABLED && (
                  <>
                    <button
                      disabled={activeRun === undefined}
                      onClick={() => {
                        setTimelineOpen(false);
                        setSelectedNodeId(null);
                        setSelectedNodeIds([]);
                        setSelectedEdgeId(null);
                        setTeamSummaryOpen(true);
                      }}
                    >
                      Equipe
                    </button>
                    <button
                      disabled={operations === null}
                      onClick={() => {
                        setTeamSummaryOpen(false);
                        setTimelineOpen(true);
                      }}
                    >
                      Histórico
                    </button>
                  </>
                )}
                <button
                  className={inspectorOpen ? "v2-icon-button active" : "v2-icon-button"}
                  aria-label={inspectorOpen ? "Ocultar inspector" : "Mostrar inspector"}
                  aria-pressed={inspectorOpen}
                  title="Mostrar ou ocultar inspector"
                  onClick={() => setInspectorOpen((current) => !current)}
                >
                  <ToolIcon name="settings" />
                </button>
                <div className="v2-menu-anchor">
                  <button
                    className="v2-icon-button"
                    aria-label="Mais ações do workspace"
                    aria-haspopup="menu"
                    aria-expanded={moreMenuOpen}
                    title="Mais ações"
                    onClick={() => setMoreMenuOpen((current) => !current)}
                  >
                    <ToolIcon name="more" />
                  </button>
                  {moreMenuOpen && (
                    <div
                      className="v2-menu"
                      role="menu"
                      data-testid="v2-more-menu"
                      onMouseLeave={() => setMoreMenuOpen(false)}
                    >
                      <p className="v2-menu-label">Workspace</p>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuOpen(false);
                          void run(refreshAgentData);
                        }}
                      >
                        Verificar agentes
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuOpen(false);
                          setRoleLibraryOpen(true);
                        }}
                      >
                        Responsabilidades
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuOpen(false);
                          void run(async () => {
                            const fileAccess = chooseFileAccess(
                              "Acesso a arquivos: ask, workspace-read ou workspace-read-write",
                              workspace.permissions.fileAccess
                            );
                            if (fileAccess === null) return;
                            if (
                              !["ask", "workspace-read", "workspace-read-write"].includes(
                                fileAccess
                              )
                            ) {
                              throw new Error("Política de arquivos inválida.");
                            }
                            await adoptWorkspace(
                              await window.compazioV2.permissions.update({
                                workspaceId: workspace.id,
                                permissions: {
                                  ...workspace.permissions,
                                  fileAccess: fileAccess as Workspace["permissions"]["fileAccess"]
                                }
                              })
                            );
                          });
                        }}
                      >
                        Permissões
                      </button>
                      <p className="v2-menu-label">Canvas</p>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuOpen(false);
                          resetFocus();
                        }}
                      >
                        Resetar foco
                      </button>
                      <button
                        role="menuitem"
                        disabled={workspace.edges.length === 0}
                        onClick={() => {
                          setMoreMenuOpen(false);
                          void run(async () => {
                            for (const edge of workspace.edges)
                              await window.compazioV2.edges.delete({
                                workspaceId: workspace.id,
                                edgeId: edge.id
                              });
                            await adoptWorkspace(
                              await window.compazioV2.workspace.open({ workspaceId: workspace.id })
                            );
                          });
                        }}
                      >
                        Remover conexões
                      </button>
                      {LEGACY_TEAM_RUNTIME_UI_ENABLED && (
                        <button
                          role="menuitem"
                          disabled={activeRun === undefined}
                          onClick={() => {
                            setMoreMenuOpen(false);
                            if (activeRun === undefined) return;
                            void run(async () =>
                              adoptWorkspace(
                                await window.compazioV2.layout.organizeTeam({
                                  workspaceId: workspace.id,
                                  runId: activeRun.id
                                })
                              )
                            );
                          }}
                        >
                          Organizar equipe
                        </button>
                      )}
                      <p className="v2-menu-label">Suporte</p>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuOpen(false);
                          void run(async () => {
                            const result = await window.compazioV2.diagnostics.export({
                              workspaceId: workspace.id
                            });
                            if (!result.cancelled)
                              setMessage("Diagnóstico exportado com segurança.");
                          });
                        }}
                      >
                        Diagnóstico
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </header>
            {LEGACY_TEAM_RUNTIME_UI_ENABLED && operations !== null && (
              <RecoveryNotice state={operations} onRecover={recoverRun} />
            )}
            <div
              ref={canvasElement}
              className="v2-canvas"
              data-testid="v2-canvas"
              data-panning={panning}
              data-space={spaceHeld}
              data-linking={linking !== null}
              data-creation-tool={creationTool ?? "none"}
              tabIndex={0}
              aria-label="Canvas do workspace"
              onDragOver={(event) => event.preventDefault()}
              onDrop={dropFileReference}
              onPointerDown={startCanvasGesture}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLostPointerCapture={() => releasePointerCapture()}
              onContextMenu={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest(".v2-node, .v2-edges, .v2-context-menu") !== null) return;
                event.preventDefault();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  canvasPosition: canvasPoint(event.clientX, event.clientY),
                  ...(selectedNodeIds.length > 0 ? { selection: true } : {})
                });
              }}
              onWheel={(event) => {
                if (isTerminalElement(event.target)) return;
                // Text editors always own their wheel gesture, including at their first/last line.
                // Falling through at an edge was making a note zoom the entire canvas.
                if (
                  isEditorWheelTarget(event.target) ||
                  wheelBelongsToScrollable(event.target, event.currentTarget, event.deltaY)
                )
                  return;
                event.preventDefault();
                const pointer = canvasPointerPosition(event.clientX, event.clientY);
                if (event.shiftKey) {
                  applyViewport(panBy(workspace.settings.viewport, -event.deltaY, 0));
                  return;
                }
                applyViewport(
                  zoomAtPoint(
                    workspace.settings.viewport,
                    event.deltaY < 0 ? 1.12 : 1 / 1.12,
                    pointer
                  )
                );
              }}
            >
              <div className="v2-dock" role="toolbar" aria-label="Adicionar ao canvas">
                <button
                  data-testid="v2-add-terminal"
                  title="Novo terminal no centro — Ctrl+Shift+T"
                  onClick={() => addTerminal()}
                >
                  <ToolIcon name="terminal" />
                  <span className="v2-dock-label">Terminal</span>
                </button>
                <button
                  data-testid="v2-draw-terminal"
                  aria-label="Desenhar terminal"
                  title="Desenhar um terminal com tamanho personalizado"
                  aria-pressed={creationTool === "terminal"}
                  onClick={() => {
                    setCreationTool((current) => (current === "terminal" ? null : "terminal"));
                    setMessage("Arraste no canvas para definir o tamanho do terminal.");
                  }}
                >
                  <span aria-hidden="true">↘</span>
                </button>
                <button
                  data-testid="v2-add-note"
                  title="Nova nota — Ctrl+Shift+N"
                  onClick={() => addNote()}
                >
                  <ToolIcon name="note" />
                  <span className="v2-dock-label">Nota</span>
                </button>
                <button
                  data-testid="v2-import-files"
                  title="Trazer arquivos do computador — md, imagem, PDF ou mídia"
                  onClick={() => importFiles()}
                >
                  <ToolIcon name="upload" />
                  <span className="v2-dock-label">Arquivos</span>
                </button>
                <button
                  data-testid="v2-add-file-tree"
                  title="Árvore de arquivos do projeto — Ctrl+Shift+E"
                  aria-label="Árvore de arquivos do projeto"
                  onClick={() => addFileTree()}
                >
                  <ToolIcon name="files" />
                </button>
                <button
                  data-testid="v2-add-portal"
                  title="Novo Portal de navegação"
                  onClick={() => addPortal()}
                >
                  <ToolIcon name="portal" />
                  <span className="v2-dock-label">Portal</span>
                </button>
                <span className="v2-divider" aria-hidden="true" />
                <button
                  aria-label="Conectar nós"
                  aria-pressed={connectionSourceId !== null}
                  disabled={selectedNodeId === null}
                  title="Conectar o nó selecionado a outro"
                  onClick={() => {
                    setConnectionSourceId(selectedNodeId);
                    setMessage("Clique no cabeçalho de outro nó para criar a conexão visual.");
                  }}
                >
                  <ToolIcon name="link" />
                </button>
                <button
                  className={cutMode ? "v2-cut-tool active" : "v2-cut-tool"}
                  data-testid="v2-cut-tool"
                  aria-label="Cortar conexões"
                  aria-pressed={cutMode}
                  disabled={workspace.edges.length === 0 && !cutMode}
                  title="Cortar conexões — Ctrl+Shift+X. Clique numa linha para cortá-la; Esc sai."
                  onClick={() => {
                    setCutMode((current) => !current);
                    setConnectionSourceId(null);
                  }}
                >
                  <ToolIcon name="scissors" />
                </button>
                <button
                  aria-label="Agrupar seleção"
                  disabled={selectedNodeIds.length === 0}
                  title="Agrupar seleção — Ctrl+Shift+G"
                  onClick={createGroup}
                >
                  <ToolIcon name="group" />
                </button>
                <button
                  aria-label="Compor prompt"
                  disabled={selectedNode?.type !== "terminal"}
                  title="Compor prompt — Ctrl+Shift+P"
                  onClick={() =>
                    selectedNode?.type === "terminal" && setComposerTerminalId(selectedNode.id)
                  }
                >
                  <ToolIcon name="compose" />
                </button>
              </div>
              {workspace.nodes.length === 0 && (
                <div className="v2-canvas-empty-hint" role="status">
                  <strong>Seu canvas está pronto.</strong>
                  <span>
                    Comece por um terminal ou adicione uma nota para organizar o trabalho.
                  </span>
                  <div>
                    <button className="v2-primary" onClick={() => addTerminal()}>
                      Novo terminal
                    </button>
                    <button onClick={() => addNote()}>Nova nota</button>
                  </div>
                </div>
              )}
              <div
                className="v2-world"
                style={{
                  transform: `translate(${workspace.settings.viewport.x}px, ${workspace.settings.viewport.y}px) scale(${workspace.settings.viewport.zoom})`
                }}
              >
                {workspace.groups.map((group) => (
                  <CanvasGroupCard
                    key={group.id}
                    group={group}
                    onToggle={() =>
                      void window.compazioV2.groups
                        .update({
                          workspaceId: workspace.id,
                          groupId: group.id,
                          collapsed: !group.collapsed
                        })
                        .then(adoptWorkspace)
                        .catch(toMessage(setMessage))
                    }
                    onDelete={() =>
                      void window.compazioV2.groups
                        .delete({ workspaceId: workspace.id, groupId: group.id })
                        .then(adoptWorkspace)
                        .catch(toMessage(setMessage))
                    }
                  />
                ))}
                <svg className="v2-edges" aria-label="Conexões do canvas">
                  {workspace.edges.map((edge) => {
                    const source = workspace.nodes.find((node) => node.id === edge.sourceNodeId);
                    const target = workspace.nodes.find((node) => node.id === edge.targetNodeId);
                    if (source === undefined || target === undefined) return null;
                    const activity = [...(operations?.activities ?? [])]
                      .reverse()
                      .find((candidate) => candidate.edgeId === edge.id);
                    const geometry = connectionGeometry(source, target);
                    return (
                      <g key={edge.id}>
                        {/* The visible cable stays delicate, but its invisible hit area is wide enough
                            to reliably select, cut, or open the context menu near the line. */}
                        <path
                          className="v2-edge-hitbox"
                          role="button"
                          tabIndex={0}
                          aria-label={`Conexão de ${source.title} para ${target.title}. Estado: ${
                            activity?.status ?? "inativa"
                          }`}
                          d={geometry.path}
                          onClick={(event) => {
                            event.stopPropagation();
                            // With the scissors active a click cuts; otherwise it selects as before.
                            if (cutMode) {
                              cutEdge(edge.id);
                              return;
                            }
                            setSelectedEdgeId(edge.id);
                            setSelectedNodeId(null);
                            setSelectedNodeIds([]);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              if (cutMode) {
                                cutEdge(edge.id);
                                return;
                              }
                              setSelectedEdgeId(edge.id);
                              setSelectedNodeId(null);
                              setSelectedNodeIds([]);
                            }
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedEdgeId(edge.id);
                            setSelectedNodeId(null);
                            setSelectedNodeIds([]);
                            setContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              edgeId: edge.id
                            });
                          }}
                        />
                        <path
                          aria-hidden="true"
                          className={`v2-edge-line ${activity?.status ?? "inactive"} ${
                            selectedEdgeId === edge.id ? "selected" : ""
                          }`}
                          d={geometry.path}
                        />
                      </g>
                    );
                  })}
                  {linking !== null && (
                    <path
                      className="linking"
                      data-testid="v2-linking-preview"
                      d={cablePath(linking.from, linking.to)}
                    />
                  )}
                </svg>
                {workspace.nodes
                  .filter(
                    (node) =>
                      !workspace.groups.some(
                        (group) => group.collapsed && group.nodeIds.includes(node.id)
                      )
                  )
                  .map((node) => (
                    <CanvasNodeCard
                      key={node.id}
                      node={node}
                      workspace={workspace}
                      detail={detailLevel(workspace.settings.viewport.zoom)}
                      zoom={workspace.settings.viewport.zoom}
                      onStartLink={startLink}
                      onReleasePointerCapture={releasePointerCapture}
                      selected={selectedNodeIds.includes(node.id)}
                      session={sessions[node.id]}
                      operations={operations}
                      onDragStart={startDrag}
                      onWorkspace={adoptWorkspace}
                      onError={setMessage}
                      onConfigureTerminal={configureTerminal}
                      onRequestDelete={requestNodeDeletion}
                      onSelect={(event) => {
                        const toggle = event?.ctrlKey || event?.metaKey;
                        const next = toggle
                          ? selectedNodeIds.includes(node.id)
                            ? selectedNodeIds.filter((id) => id !== node.id)
                            : [...selectedNodeIds, node.id]
                          : [node.id];
                        setSelectedNodeId(next.at(-1) ?? null);
                        setSelectedNodeIds(next);
                        setSelectedEdgeId(null);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        // Once a set is selected, its actions are available anywhere in the canvas
                        // — including over a different card — without collapsing that set first.
                        if (selectedNodeIds.length > 1) {
                          setContextMenu({ x: event.clientX, y: event.clientY, selection: true });
                          return;
                        }
                        if (!selectedNodeIds.includes(node.id)) {
                          setSelectedNodeId(node.id);
                          setSelectedNodeIds([node.id]);
                        }
                        setSelectedEdgeId(null);
                        setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
                      }}
                    />
                  ))}
                {marquee !== null && (
                  <div
                    className="v2-marquee"
                    style={rectStyle(normalizeRect(marquee.origin, marquee.current))}
                  />
                )}
                {terminalDraft !== null && (
                  <div
                    className="v2-node-draft terminal"
                    aria-hidden="true"
                    style={rectStyle(normalizeRect(terminalDraft.origin, terminalDraft.current))}
                  />
                )}
              </div>
              <div className="v2-canvas-controls">
                {minimapOpen && (
                  <Minimap
                    workspace={workspace}
                    selectedNodeIds={selectedNodeIds}
                    size={canvasBox}
                    onJump={(target) =>
                      applyViewport(centerOn(workspace.settings.viewport, target, canvasSize()))
                    }
                  />
                )}
                <div className="v2-zoom" aria-label="Zoom e enquadramento">
                  <button
                    aria-label="Diminuir zoom"
                    title="Diminuir zoom — Ctrl+−"
                    onClick={() => zoomBy(1 / ZOOM_STEP)}
                  >
                    <ToolIcon name="minus" />
                  </button>
                  <output
                    title="Voltar a 100% — Ctrl+0"
                    onClick={() => applyViewport({ ...workspace.settings.viewport, zoom: 1 })}
                  >
                    {Math.round(workspace.settings.viewport.zoom * 100)}%
                  </output>
                  <button
                    aria-label="Aumentar zoom"
                    title="Aumentar zoom — Ctrl+="
                    onClick={() => zoomBy(ZOOM_STEP)}
                  >
                    <ToolIcon name="plus" />
                  </button>
                  <button
                    aria-label="Enquadrar tudo"
                    title="Enquadrar tudo — Ctrl+1"
                    onClick={fitAll}
                  >
                    <ToolIcon name="fit" />
                  </button>
                  <button
                    aria-label="Minimapa"
                    aria-pressed={minimapOpen}
                    title="Mostrar ou ocultar o minimapa"
                    onClick={() => setMinimapOpen((current) => !current)}
                  >
                    <ToolIcon name="map" />
                  </button>
                </div>
              </div>
            </div>
            {LEGACY_TEAM_RUNTIME_UI_ENABLED &&
              operations !== null &&
              teamSummaryOpen &&
              !timelineOpen &&
              activeRun !== undefined && (
                <TeamSummary
                  workspace={workspace}
                  state={operations}
                  sessions={sessions}
                  run={activeRun}
                  onClose={() => setTeamSummaryOpen(false)}
                  onOpenTimeline={() => setTimelineOpen(true)}
                  onRunAction={runAction}
                />
              )}
            {LEGACY_TEAM_RUNTIME_UI_ENABLED &&
              operations !== null &&
              inspectorOpen &&
              !teamSummaryOpen &&
              !timelineOpen &&
              (selectedNode !== undefined ||
                selectedEdge !== undefined ||
                operations.attention.some((request) => request.status === "open") ||
                operations.teamUserInputRequests.some(
                  (request) => request.status === "waiting-for-user-input"
                )) && (
                <OperationalInspector
                  workspace={workspace}
                  state={operations}
                  selectedNode={selectedNode}
                  selectedEdge={selectedEdge}
                  session={
                    selectedNode?.type === "terminal" ? sessions[selectedNode.id] : undefined
                  }
                  installation={
                    selectedNode?.type === "terminal"
                      ? installations[selectedNode.agentConfig.agentId]
                      : undefined
                  }
                  onClose={() => {
                    setInspectorOpen(false);
                    setSelectedNodeId(null);
                    setSelectedEdgeId(null);
                  }}
                  onWorkspace={(next) => void adoptWorkspace(next)}
                  onState={setOperations}
                  onMessage={setMessage}
                  onConfigureTerminal={configureTerminal}
                  onRequestNodeDeletion={requestNodeDeletion}
                  onFocusTerminal={(nodeId) => {
                    setSelectedNodeId(nodeId);
                    document
                      .querySelector<HTMLElement>(
                        `[data-node-id="${nodeId}"] .xterm-helper-textarea`
                      )
                      ?.focus();
                  }}
                  onOpenTimeline={() => setTimelineOpen(true)}
                  onFitTeam={fitTeam}
                />
              )}
            {LEGACY_TEAM_RUNTIME_UI_ENABLED && operations !== null && timelineOpen && (
              <Timeline
                workspace={workspace}
                state={operations}
                onClose={() => setTimelineOpen(false)}
                onUndo={undoWorkspace}
                onRedo={redoWorkspace}
              />
            )}
            {composerTarget !== undefined && (
              <PromptComposer
                workspace={workspace}
                target={composerTarget}
                session={sessions[composerTarget.id]}
                selection={selectedNode}
                onClose={() => setComposerTerminalId(null)}
                onQuickAction={(action) => {
                  setComposerTerminalId(null);
                  if (action === "terminal") addTerminal();
                  if (action === "note") addNote();
                  if (action === "tree") addFileTree();
                }}
                onSend={async (text) => {
                  const session = sessions[composerTarget.id];
                  if (session === undefined) throw new Error("Inicie o terminal antes de enviar.");
                  // The visible xterm owns Composer input too. Its paste path preserves bracketed
                  // paste for multiline missions before the same onData stream submits Enter.
                  if (!(await terminalInputBus.submit(composerTarget.id, text)))
                    throw new Error("O terminal ainda não está pronto para receber o texto.");
                }}
              />
            )}
          </>
        )}
        {message !== null && (
          <p className="v2-feedback" role="alert">
            {message}
          </p>
        )}
        {workspace !== null && terminalDialog !== null && (
          <AgentTerminalDialog
            state={terminalDialog}
            workspace={workspace}
            definitions={agentDefinitions}
            roles={roles}
            installations={installations}
            onRefreshInstallations={refreshAgentData}
            session={
              terminalDialog.mode === "edit" ? sessions[terminalDialog.terminal.id] : undefined
            }
            onCancel={() => setTerminalDialog(null)}
            onSubmit={(next) =>
              void run(async () => {
                const editedSession =
                  terminalDialog.mode === "edit" ? sessions[terminalDialog.terminal.id] : undefined;
                if (
                  editedSession !== undefined &&
                  !(await requestConfirmation({
                    title: "Reiniciar terminal",
                    message:
                      "Salvar estas configurações reiniciará o processo real deste terminal.",
                    confirmLabel: "Salvar e reiniciar"
                  }))
                )
                  return;
                const existingNodeIds = new Set(workspace.nodes.map((node) => node.id));
                const updated =
                  terminalDialog.mode === "create"
                    ? await window.compazioV2.nodes.addTerminal({
                        workspaceId: workspace.id,
                        ...(terminalDialog.position === undefined
                          ? {}
                          : { position: terminalDialog.position }),
                        ...(terminalDialog.size === undefined ? {} : { size: terminalDialog.size }),
                        ...next
                      })
                    : await window.compazioV2.nodes.update({
                        workspaceId: workspace.id,
                        nodeId: terminalDialog.terminal.id,
                        ...next
                      });
                const createdTerminal =
                  terminalDialog.mode === "create"
                    ? updated.nodes.find(
                        (node): node is TerminalNode =>
                          node.type === "terminal" && !existingNodeIds.has(node.id)
                      )
                    : undefined;
                await adoptWorkspace(updated);
                if (createdTerminal !== undefined) {
                  try {
                    await startTerminalSession(updated.id, createdTerminal.id);
                  } catch (error: unknown) {
                    // A failed preflight or spawn must not leave a persisted black node behind.
                    const rolledBack = await window.compazioV2.nodes.delete({
                      workspaceId: updated.id,
                      nodeId: createdTerminal.id
                    });
                    await adoptWorkspace(rolledBack);
                    throw error;
                  }
                }
                if (
                  terminalDialog.mode === "edit" &&
                  editedSession !== undefined &&
                  next.isCompazio === terminalDialog.terminal.isCompazio
                )
                  await window.compazioV2.terminal.restart({
                    workspaceId: workspace.id,
                    nodeId: terminalDialog.terminal.id,
                    sessionId: editedSession.id
                  });
                setTerminalDialog(null);
              })
            }
          />
        )}
        {workspace !== null && roleLibraryOpen && (
          <RoleLibrary
            workspace={workspace}
            roles={roles}
            onClose={() => setRoleLibraryOpen(false)}
            onChanged={() => void refreshAgentData().catch(toMessage(setMessage))}
            onError={setMessage}
          />
        )}
        {pendingNodeDeletion !== null && (
          <NodeDeletionDialog
            label={pendingNodeDeletion.label}
            onCancel={() => setPendingNodeDeletion(null)}
            onConfirm={confirmNodeDeletion}
          />
        )}
        {confirmation !== null && (
          <ConfirmationDialog
            title={confirmation.title}
            message={confirmation.message}
            confirmLabel={confirmation.confirmLabel}
            danger={confirmation.danger ?? false}
            onCancel={() => respondToConfirmation(false)}
            onConfirm={() => respondToConfirmation(true)}
          />
        )}
        {shortcutsOpen && <ShortcutGuide onClose={() => setShortcutsOpen(false)} />}
        {workspace !== null && contextMenu !== null && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={
              contextMenu.selection === true
                ? [
                    {
                      label: `Agrupar ${selectedNodeIds.length} canvases`,
                      disabled: selectedNodeIds.length < 2,
                      action: createGroup
                    },
                    {
                      label: "Organizar em grade",
                      disabled: selectedNodeIds.length < 2,
                      action: organizeSelected
                    },
                    {
                      label: "Desconectar conexões selecionadas",
                      action: disconnectSelection
                    },
                    {
                      label: `Excluir ${selectedNodeIds.length} canvases`,
                      danger: true,
                      action: deleteSelection
                    }
                  ]
                : contextMenu.nodeId !== undefined
                  ? selectedNodeIds.length > 1 && selectedNodeIds.includes(contextMenu.nodeId)
                    ? [
                        {
                          label: `Agrupar ${selectedNodeIds.length} canvases`,
                          action: createGroup
                        },
                        {
                          label: "Organizar em grade",
                          action: organizeSelected
                        },
                        {
                          label: "Desconectar conexões selecionadas",
                          action: disconnectSelection
                        },
                        {
                          label: `Excluir ${selectedNodeIds.length} canvases`,
                          danger: true,
                          action: deleteSelection
                        }
                      ]
                    : workspace.nodes.find((node) => node.id === contextMenu.nodeId)?.type ===
                        "terminal"
                      ? [
                          {
                            label: "Focar",
                            action: () => window.setTimeout(() => fitSelection(), 0)
                          },
                          {
                            label: "Editar",
                            action: () => {
                              const node = workspace.nodes.find(
                                (candidate) => candidate.id === contextMenu.nodeId
                              );
                              if (node?.type === "terminal") configureTerminal(node);
                            }
                          },
                          {
                            label: "Reiniciar",
                            disabled: sessions[contextMenu.nodeId] === undefined,
                            action: () => {
                              const node = workspace.nodes.find(
                                (candidate) => candidate.id === contextMenu.nodeId
                              );
                              const session = node === undefined ? undefined : sessions[node.id];
                              if (node?.type !== "terminal" || session === undefined) return;
                              void run(async () => {
                                await window.compazioV2.terminal.restart({
                                  workspaceId: workspace.id,
                                  nodeId: node.id,
                                  sessionId: session.id
                                });
                              });
                            }
                          },
                          {
                            label: "Trocar responsabilidade",
                            action: () => {
                              const node = workspace.nodes.find(
                                (candidate) => candidate.id === contextMenu.nodeId
                              );
                              if (node?.type === "terminal") configureTerminal(node);
                            }
                          },
                          {
                            label: "Compor prompt",
                            action: () => setComposerTerminalId(contextMenu.nodeId ?? null)
                          },
                          { label: "Excluir", danger: true, action: () => deleteSelection() }
                        ]
                      : workspace.nodes.find((node) => node.id === contextMenu.nodeId)?.type ===
                          "file-tree"
                        ? [
                            {
                              label: "Focar",
                              action: () => window.setTimeout(() => fitSelection(), 0)
                            },
                            {
                              label: "Abrir Diff",
                              action: () => {
                                if (contextMenu.nodeId === undefined) return;
                                void window.compazioV2.nodes
                                  .updateFileTree({
                                    workspaceId: workspace.id,
                                    nodeId: contextMenu.nodeId,
                                    viewMode: "diff"
                                  })
                                  .then(adoptWorkspace)
                                  .catch(toMessage(setMessage));
                              }
                            },
                            {
                              label: "Ver conexões",
                              action: () => setSelectedNodeId(contextMenu.nodeId ?? null)
                            },
                            { label: "Excluir", danger: true, action: () => deleteSelection() }
                          ]
                        : [
                            {
                              label: "Editar",
                              action: () => window.setTimeout(() => fitSelection(), 0)
                            },
                            {
                              label: "Ver conexões",
                              action: () => {
                                if (contextMenu.nodeId !== undefined)
                                  setSelectedNodeId(contextMenu.nodeId);
                              }
                            },
                            { label: "Excluir", danger: true, action: () => deleteSelection() }
                          ]
                  : contextMenu.edgeId !== undefined
                    ? [
                        {
                          label: "Desconectar",
                          danger: true,
                          action: () => cutEdge(contextMenu.edgeId ?? "")
                        }
                      ]
                    : [
                        {
                          label: "Novo Terminal",
                          action: () => addTerminal(contextMenu.canvasPosition)
                        },
                        {
                          label: "Nova Nota",
                          action: () => addNote(contextMenu.canvasPosition)
                        },
                        {
                          label: "Árvore de Arquivos",
                          action: () => addFileTree(contextMenu.canvasPosition)
                        },
                        {
                          label: "Enquadrar tudo",
                          action: () => {
                            if (workspace.nodes.length === 0) return;
                            const x = Math.min(...workspace.nodes.map((node) => node.position.x));
                            const y = Math.min(...workspace.nodes.map((node) => node.position.y));
                            const right = Math.max(
                              ...workspace.nodes.map((node) => node.position.x + node.size.width)
                            );
                            const bottom = Math.max(
                              ...workspace.nodes.map((node) => node.position.y + node.size.height)
                            );
                            fitBounds({ x, y, width: right - x, height: bottom - y });
                          }
                        }
                      ]
            }
          />
        )}
        {workspaceDialogOpen && (
          <WorkspaceCreateDialog
            onCancel={() => setWorkspaceDialogOpen(false)}
            onSelectDirectory={() => window.compazioV2.workspace.selectDirectory()}
            onSubmit={createWorkspaceFromDialog}
          />
        )}
        {licenseDialogOpen && (
          <LicenseDialog
            status={licenseStatus}
            onClose={() => setLicenseDialogOpen(false)}
            onActivated={(next) => {
              setLicenseStatus(next);
              setLicenseDialogOpen(false);
              setMessage("Licença ativada. Você já pode criar novos workspaces.");
            }}
          />
        )}
        {updateDialogOpen && (
          <UpdateDialog
            status={updateStatus}
            onClose={() => setUpdateDialogOpen(false)}
            onStatus={setUpdateStatus}
            onError={setMessage}
          />
        )}
        <PortalDownloadDialog onError={setMessage} />
        {workspace !== null && paletteOpen && (
          <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
        )}
      </section>
    </main>
  );
}

function ConfirmationDialog({
  title,
  message,
  confirmLabel,
  danger,
  onCancel,
  onConfirm
}: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly danger: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="v2-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="v2-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-confirmation-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="v2-eyebrow">Confirmação</p>
        <h2 id="v2-confirmation-title">{title}</h2>
        <p>{message}</p>
        <div className="v2-modal-actions">
          <button type="button" onClick={onCancel} autoFocus>
            Cancelar
          </button>
          <button type="button" className={danger ? "v2-danger" : "v2-primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function NodeDeletionDialog({
  label,
  onCancel,
  onConfirm
}: {
  readonly label: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="v2-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="v2-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-node-delete-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="v2-eyebrow">Excluir canvases</p>
        <h2 id="v2-node-delete-title">Confirmar exclusão</h2>
        <p>
          Excluir {label}? Esta ação também remove as conexões desses canvases. O diretório de
          trabalho não será apagado.
        </p>
        <div className="v2-modal-actions">
          <button type="button" onClick={onCancel} autoFocus>
            Cancelar
          </button>
          <button
            type="button"
            className="v2-danger"
            data-testid="v2-confirm-node-delete"
            onClick={onConfirm}
          >
            Excluir canvases
          </button>
        </div>
      </section>
    </div>
  );
}

function UpdateDialog({
  status,
  onClose,
  onStatus,
  onError
}: {
  readonly status: Awaited<ReturnType<typeof window.compazioV2.updates.status>> | null;
  readonly onClose: () => void;
  readonly onStatus: (status: Awaited<ReturnType<typeof window.compazioV2.updates.status>>) => void;
  readonly onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = status ?? {
    state: "idle" as const,
    version: null,
    progress: null,
    error: null,
    autoCheck: true
  };
  const run = async (
    operation: () => Promise<Awaited<ReturnType<typeof window.compazioV2.updates.status>>>
  ) => {
    setBusy(true);
    try {
      onStatus(await operation());
    } catch (error: unknown) {
      onError(userFacingIpcError(error, "A atualização não pôde ser concluída."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="v2-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="v2-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-update-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="v2-eyebrow">Atualizações</p>
        <h2 id="v2-update-title">Canal beta</h2>
        <p>
          As atualizações são verificadas pelo aplicativo e nunca são instaladas durante um trabalho
          ativo.
        </p>
        <label>
          <input
            type="checkbox"
            checked={current.autoCheck}
            onChange={(event) =>
              void run(() =>
                window.compazioV2.updates.setAutoCheck({ enabled: event.target.checked })
              )
            }
          />
          Verificar atualizações automaticamente
        </label>
        <p className="v2-muted">
          Estado: {current.state}
          {current.version === null ? "" : ` · versão ${current.version}`}
          {current.progress === null ? "" : ` · ${Math.round(current.progress)}%`}
        </p>
        {current.error !== null && (
          <p className="v2-error" role="alert">
            {current.error}
          </p>
        )}
        <div className="v2-modal-actions">
          <button type="button" onClick={onClose}>
            Fechar
          </button>
          <button
            type="button"
            disabled={busy || current.state === "checking" || current.state === "downloading"}
            onClick={() => void run(() => window.compazioV2.updates.check())}
          >
            Verificar agora
          </button>
          {current.state === "available" && (
            <button
              className="v2-primary"
              type="button"
              disabled={busy}
              onClick={() => void run(() => window.compazioV2.updates.download())}
            >
              Baixar atualização
            </button>
          )}
          {current.state === "downloaded" && (
            <button
              className="v2-primary"
              type="button"
              disabled={busy}
              onClick={() =>
                void window.compazioV2.updates
                  .install()
                  .catch((error: unknown) =>
                    onError(error instanceof Error ? error.message : "A instalação foi bloqueada.")
                  )
              }
            >
              Reiniciar e instalar
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function LicenseDialog({
  status,
  onClose,
  onActivated
}: {
  readonly status: Awaited<ReturnType<typeof window.compazioV2.license.status>> | null;
  readonly onClose: () => void;
  readonly onActivated: (
    status: Awaited<ReturnType<typeof window.compazioV2.license.status>>
  ) => void;
}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "validating" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="v2-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="v2-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-license-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          setState("validating");
          setError(null);
          void window.compazioV2.license
            .activate({ licenseCode: code })
            .then(onActivated)
            .catch((reason: unknown) => {
              setState("error");
              setError(userFacingIpcError(reason, "Não foi possível ativar a licença."));
            })
            .finally(() => setState((current) => (current === "validating" ? "idle" : current)));
        }}
      >
        <p className="v2-eyebrow">Licença</p>
        <h2 id="v2-license-title">Ative workspaces ilimitados</h2>
        <p>
          O beta gratuito permite um workspace por instalação. Seu workspace atual continuará
          disponível.
        </p>
        <label>
          Código de licença
          <input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="CMPZ-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
          />
        </label>
        {error !== null && (
          <p role="alert" className="v2-error">
            {error}
          </p>
        )}
        {status?.plan === "beta_unlimited" && (
          <p className="v2-muted">Plano beta ativo neste dispositivo.</p>
        )}
        <div className="v2-modal-actions">
          <button type="button" onClick={onClose}>
            Continuar no workspace atual
          </button>
          <button
            className="v2-primary"
            type="submit"
            disabled={state === "validating" || code.trim() === ""}
          >
            {state === "validating" ? "Validando…" : "Ativar licença"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EmptyState({
  onCreate,
  definitions,
  installations
}: {
  readonly onCreate: () => void;
  readonly definitions: readonly AgentDefinition[];
  readonly installations: InstallationByAgent;
}) {
  const supported = definitions.filter((definition) =>
    ["claude-code", "codex", "opencode"].includes(definition.id)
  );
  const installed = supported.filter(
    (definition) => installations[definition.id]?.status === "installed"
  );
  return (
    <div className="v2-empty">
      <div className="v2-empty-mark" aria-hidden="true">
        <CompazioMark size={38} />
      </div>
      <p className="v2-eyebrow">Seu espaço de trabalho local</p>
      <h1>Reúna seu rebanho de agentes</h1>
      <p>
        Abra um workspace, coloque seus agentes lado a lado e acompanhe o trabalho sem perder o
        contexto.
      </p>
      <div className="v2-agent-readiness" aria-live="polite">
        <span className="v2-agent-readiness-dot" aria-hidden="true" />
        <div>
          <strong>
            {supported.length === 0
              ? "Verificando seus agentes"
              : installed.length > 0
                ? `${installed.length} agente${installed.length === 1 ? "" : "s"} pronto${installed.length === 1 ? "" : "s"}`
                : "Agentes serão verificados ao criar um terminal"}
          </strong>
          <small>
            {installed.length > 0
              ? installed.map((definition) => definition.name).join(" · ")
              : "Claude Code, Codex e OpenCode podem ser adicionados depois."}
          </small>
        </div>
      </div>
      <button className="v2-primary v2-empty-cta" onClick={onCreate}>
        Criar workspace
      </button>
      <small className="v2-empty-hint">
        Você poderá escolher a pasta e o agente no próximo passo.
      </small>
    </div>
  );
}

function WorkspaceCreateDialog({
  onCancel,
  onSelectDirectory,
  onSubmit
}: {
  readonly onCancel: () => void;
  readonly onSelectDirectory: () => Promise<string | null>;
  readonly onSubmit: (input: { readonly name: string; readonly directory: string }) => void;
}) {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  useEffect(() => {
    const form = formRef.current;
    if (form === null) return;
    const focusTarget = returnFocus.current;
    form.querySelector<HTMLElement>("input, button")?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    form.addEventListener("keydown", onKeyDown);
    return () => {
      form.removeEventListener("keydown", onKeyDown);
      focusTarget?.focus();
    };
  }, [onCancel]);
  const chooseDirectory = (): void => {
    setSelecting(true);
    void onSelectDirectory()
      .then((selected) => {
        if (selected === null) return;
        setDirectory(selected);
        if (name.trim() === "")
          setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "Meu workspace");
      })
      .finally(() => setSelecting(false));
  };
  return (
    <div className="v2-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        ref={formRef}
        className="v2-modal v2-workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-workspace-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (directory === null || name.trim() === "") return;
          onSubmit({ name: name.trim(), directory });
        }}
      >
        <header>
          <div>
            <p className="v2-eyebrow">Começar</p>
            <h2 id="v2-workspace-dialog-title">Novo workspace</h2>
          </div>
          <button type="button" onClick={onCancel} aria-label="Fechar">
            ×
          </button>
        </header>
        <p className="v2-modal-intro">
          Um espaço local para reunir terminais, notas, arquivos e resultados.
        </p>
        <label>
          Nome
          <input
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Landing page"
          />
        </label>
        <div className="v2-directory-picker">
          <div>
            <span className="v2-field-label">Pasta do projeto</span>
            <strong>{directory ?? "Nenhuma pasta escolhida"}</strong>
            <small>A pasta não será movida nem apagada pelo Compazio.</small>
          </div>
          <button type="button" onClick={chooseDirectory} disabled={selecting}>
            {selecting ? "Abrindo…" : "Escolher pasta"}
          </button>
        </div>
        <footer>
          <button type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="v2-primary"
            type="submit"
            disabled={directory === null || name.trim() === ""}
          >
            Criar workspace
          </button>
        </footer>
      </form>
    </div>
  );
}

interface PaletteItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly keywords?: string;
  readonly action: () => void;
}

function CommandPalette({
  items,
  onClose
}: {
  readonly items: readonly PaletteItem[];
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const matching = items
    .filter((item) =>
      `${item.title} ${item.detail} ${item.keywords ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
    .slice(0, 40);
  return (
    <div className="v2-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="v2-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Busca global"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <label htmlFor="v2-command-palette-search">Buscar no Compazio</label>
          <button onClick={onClose} aria-label="Fechar busca">
            ×
          </button>
        </header>
        <input
          id="v2-command-palette-search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && matching[0] !== undefined) {
              event.preventDefault();
              matching[0].action();
              onClose();
            }
          }}
          placeholder="Ações, workspaces, terminais, notas e arquivos"
        />
        <div role="listbox" aria-label="Resultados da busca">
          {matching.length === 0 ? (
            <p>Nenhum item seguro encontrado.</p>
          ) : (
            matching.map((item) => (
              <button
                key={item.id}
                role="option"
                onClick={() => {
                  item.action();
                  onClose();
                }}
              >
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function CanvasGroupCard({
  group,
  onToggle,
  onDelete
}: {
  readonly group: CanvasGroup;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <section
      className={`v2-canvas-group ${group.color ?? "slate"}`}
      style={{
        left: group.position.x,
        top: group.position.y,
        width: group.size.width,
        height: group.size.height
      }}
      aria-label={`Grupo ${group.title}`}
    >
      <header>
        <strong>{group.title}</strong>
        <span>{group.nodeIds.length} nós</span>
        <button
          onClick={onToggle}
          aria-label={group.collapsed ? "Expandir grupo" : "Recolher grupo"}
        >
          {group.collapsed ? "+" : "−"}
        </button>
        <button onClick={onDelete} aria-label="Desagrupar nós">
          ×
        </button>
      </header>
    </section>
  );
}

interface NodeCardProps {
  readonly node: CanvasNode;
  readonly workspace: Workspace;
  readonly detail: "compact" | "full";
  readonly zoom: number;
  readonly selected: boolean;
  readonly onStartLink: (
    node: CanvasNode,
    side: "left" | "right" | "top" | "bottom",
    event: PointerEvent<HTMLElement>
  ) => void;
  readonly session: TerminalSession | undefined;
  readonly operations: WorkspaceOperationalState | null;
  readonly onDragStart: (event: PointerEvent<HTMLElement>, node: CanvasNode) => void;
  readonly onReleasePointerCapture: () => void;
  readonly onWorkspace: (workspace: Workspace) => Promise<void>;
  readonly onError: (message: string) => void;
  readonly onConfigureTerminal: (terminal: TerminalNode) => void;
  readonly onRequestDelete: (node: CanvasNode) => void;
  readonly onSelect: (event?: PointerEvent<HTMLElement>) => void;
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

function CanvasNodeCard({
  node,
  workspace,
  detail,
  zoom,
  selected,
  session,
  operations,
  onStartLink,
  onDragStart,
  onReleasePointerCapture,
  onWorkspace,
  onError,
  onConfigureTerminal,
  onRequestDelete,
  onSelect,
  onContextMenu
}: NodeCardProps) {
  const resizeTimer = useRef<number | null>(null);
  const element = useRef<HTMLElement | null>(null);
  const openAttention =
    LEGACY_TEAM_RUNTIME_UI_ENABLED &&
    operations?.attention.some(
      (request) => request.terminalId === node.id && request.status === "open"
    );
  const resizeStart = useRef<{
    readonly corner: "top-left" | "bottom-right";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly left: number;
    readonly top: number;
  } | null>(null);
  const resizePointer = useRef<PointerCaptureState | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const observer = new ResizeObserver(() => {
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => {
        void window.compazioV2.nodes
          .resize({
            workspaceId: workspace.id,
            nodeId: node.id,
            size: { width: target.offsetWidth, height: target.offsetHeight }
          })
          .then(onWorkspace)
          .catch(toMessage(onError));
      }, 250);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    };
  }, [node.id, workspace.id, onWorkspace, onError]);

  const remove = (): void => {
    onRequestDelete(node);
  };
  const rename = (title: string): void => {
    setEditingTitle(false);
    if (title.trim() === "" || title === node.title) return;
    void window.compazioV2.nodes
      .update({ workspaceId: workspace.id, nodeId: node.id, title: title.trim() })
      .then(onWorkspace)
      .catch(toMessage(onError));
  };
  // Redimensionar é um gesto explícito: o canto nativo fica escondido atrás do conteúdo do nó, e
  // o delta precisa do zoom para o card acompanhar o ponteiro em qualquer escala.
  const startResize = (
    corner: "top-left" | "bottom-right",
    event: PointerEvent<HTMLElement>
  ): void => {
    const target = element.current;
    if (target === null) return;
    event.stopPropagation();
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      resizePointer.current = { element: event.currentTarget, pointerId: event.pointerId };
    } catch {
      resizePointer.current = null;
    }
    resizeStart.current = {
      corner,
      x: event.clientX,
      y: event.clientY,
      width: node.size.width,
      height: node.size.height,
      left: node.position.x,
      top: node.position.y
    };
  };
  const moveResize = (event: PointerEvent<HTMLElement>): void => {
    const start = resizeStart.current;
    const target = element.current;
    if (start === null || target === null) return;
    const deltaX = (event.clientX - start.x) / zoom;
    const deltaY = (event.clientY - start.y) / zoom;
    if (start.corner === "bottom-right") {
      target.style.width = `${Math.max(MIN_NODE_WIDTH, start.width + deltaX)}px`;
      target.style.height = `${Math.max(MIN_NODE_HEIGHT, start.height + deltaY)}px`;
      return;
    }
    // Dragging the top-left corner grows the node towards the top and the left, so the opposite
    // edge has to stay put: the position moves by exactly what the size gains.
    const width = Math.max(MIN_NODE_WIDTH, start.width - deltaX);
    const height = Math.max(MIN_NODE_HEIGHT, start.height - deltaY);
    target.style.width = `${width}px`;
    target.style.height = `${height}px`;
    target.style.left = `${start.left + (start.width - width)}px`;
    target.style.top = `${start.top + (start.height - height)}px`;
  };
  const endResize = (): void => {
    const captured = resizePointer.current;
    resizePointer.current = null;
    if (captured !== null) {
      try {
        if (captured.element.hasPointerCapture(captured.pointerId))
          captured.element.releasePointerCapture(captured.pointerId);
      } catch {
        // The resize handle may have been removed while the pointer was leaving the window.
      }
    }
    const start = resizeStart.current;
    const target = element.current;
    resizeStart.current = null;
    // The ResizeObserver already persists the size; only the top-left corner also moved the node.
    if (start === null || target === null || start.corner !== "top-left") return;
    const left = start.left + (start.width - target.offsetWidth);
    const top = start.top + (start.height - target.offsetHeight);
    if (left === start.left && top === start.top) return;
    void window.compazioV2.nodes
      .move({ workspaceId: workspace.id, nodeId: node.id, position: { x: left, y: top } })
      .then(onWorkspace)
      .catch(toMessage(onError));
  };
  const displayedTerminalState = terminalStateLabel[session?.state ?? "idle"];
  return (
    <article
      ref={element}
      className={`v2-node ${node.type} ${selected ? "selected" : ""}`}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: node.size.width,
        height: node.size.height
      }}
      data-testid={`v2-node-${node.type}`}
      data-node-id={node.id}
      data-detail={detail}
      onPointerDownCapture={(event) => {
        // Terminals and editors may stop bubbling pointer events. Capture modifiers at the card
        // boundary so Ctrl/Cmd-click can select any canvas, not just its title bar.
        if (isTerminalElement(event.target)) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.stopPropagation();
          onSelect(event);
        }
      }}
      onPointerDown={(event) => {
        // Selection and dragging are left-button gestures. Right-click must preserve a multi-node
        // selection so its shared context actions are available over either cards or empty canvas.
        if (isTerminalElement(event.target)) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
        onSelect(event);
      }}
      onContextMenu={(event) => {
        if (!isTerminalElement(event.target)) onContextMenu(event);
      }}
    >
      <header
        className="v2-node-header"
        tabIndex={0}
        aria-label={`${nodeTypeLabel(node.type)} ${node.title}`}
        onPointerDown={(event) => onDragStart(event, node)}
        onLostPointerCapture={onReleasePointerCapture}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelect();
        }}
      >
        <span className="v2-node-kind" title={nodeTypeLabel(node.type)}>
          <NodeTypeIcon type={node.type} />
        </span>
        {editingTitle ? (
          <input
            className="v2-node-title-input"
            aria-label={`Renomear ${nodeTypeLabel(node.type)}`}
            defaultValue={node.title}
            autoFocus
            onPointerDown={(event) => event.stopPropagation()}
            onBlur={(event) => rename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") rename(event.currentTarget.value);
              if (event.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <span
            className="v2-node-title"
            title="Clique duas vezes para renomear"
            onDoubleClick={() => setEditingTitle(true)}
          >
            {node.title}
          </span>
        )}
        {node.type === "terminal" && (
          <span
            className={`v2-state ${session?.state ?? "idle"}`}
            aria-label={`Estado: ${displayedTerminalState}`}
          >
            {displayedTerminalState}
          </span>
        )}
        {openAttention && (
          <span
            className="v2-node-attention"
            aria-label="Precisa de atenção"
            title="Precisa de atenção"
          >
            !
          </span>
        )}
        <button
          onPointerDown={(event) => event.stopPropagation()}
          onClick={remove}
          aria-label="Excluir nó"
        >
          ×
        </button>
      </header>
      {/* Conectar é um gesto direto: puxa-se um fio de qualquer borda até outro nó. */}
      {(["left", "right", "top", "bottom"] as const).map((side) => (
        <span
          key={side}
          className={`v2-node-handle ${side}`}
          data-testid={`v2-node-handle-${side}`}
          role="button"
          tabIndex={-1}
          aria-label={`Puxar conexão a partir da borda ${handleSideLabel[side]}`}
          title="Arraste até outro nó para conectar"
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onStartLink(node, side, event);
          }}
        />
      ))}
      {detail === "compact" ? null : node.type === "terminal" ? (
        <TerminalCard
          terminal={node}
          workspace={workspace}
          session={session}
          onWorkspace={onWorkspace}
          onError={onError}
          onConfigure={() => onConfigureTerminal(node)}
        />
      ) : node.type === "note" ? (
        <NoteCard note={node} workspace={workspace} onWorkspace={onWorkspace} onError={onError} />
      ) : node.type === "file-tree" ? (
        <FileTreeCard
          node={node}
          workspace={workspace}
          onWorkspace={onWorkspace}
          onError={onError}
        />
      ) : node.type === "portal" ? (
        <PortalCard node={node} workspace={workspace} onError={onError} />
      ) : (
        <FilePreviewCard
          node={node}
          workspace={workspace}
          onWorkspace={onWorkspace}
          onError={onError}
        />
      )}
      {detail === "full" && (
        <>
          <span
            className="v2-node-resize start"
            data-testid="v2-node-resize-start"
            role="button"
            tabIndex={-1}
            aria-label="Redimensionar nó pelo canto superior esquerdo"
            title="Arraste para redimensionar"
            onPointerDown={(event) => startResize("top-left", event)}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onLostPointerCapture={endResize}
          />
          <span
            className="v2-node-resize"
            data-testid="v2-node-resize"
            role="button"
            tabIndex={-1}
            aria-label="Redimensionar nó"
            title="Arraste para redimensionar"
            onPointerDown={(event) => startResize("bottom-right", event)}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onLostPointerCapture={endResize}
          />
        </>
      )}
    </article>
  );
}

const handleSideLabel: Record<"left" | "right" | "top" | "bottom", string> = {
  left: "esquerda",
  right: "direita",
  top: "superior",
  bottom: "inferior"
};

/**
 * Walks from the wheel target up to the canvas looking for a scroll area that still has room to
 * move in this direction. The canvas keeps the gesture when there is none, so zoom still works
 * everywhere except inside a note that is actually scrolling.
 */
function wheelBelongsToScrollable(
  target: EventTarget | null,
  canvas: Element,
  deltaY: number
): boolean {
  let element = target instanceof Element ? target : null;
  while (element !== null && element !== canvas) {
    const style = window.getComputedStyle(element);
    if (
      consumesWheelScroll(
        {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflowY: style.overflowY
        },
        deltaY
      )
    )
      return true;
    element = element.parentElement;
  }
  return false;
}

function isEditorWheelTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      ".v2-note-body textarea, .v2-note-body .v2-markdown, .v2-light-editor textarea"
    ) !== null
  );
}

function handleAnchor(node: CanvasNode, side: "left" | "right" | "top" | "bottom"): Position {
  const centerX = node.position.x + node.size.width / 2;
  const centerY = node.position.y + node.size.height / 2;
  if (side === "left") return { x: node.position.x, y: centerY };
  if (side === "right") return { x: node.position.x + node.size.width, y: centerY };
  if (side === "top") return { x: centerX, y: node.position.y };
  return { x: centerX, y: node.position.y + node.size.height };
}

function PortalCard({
  node,
  workspace,
  onError
}: {
  readonly node: PortalNode;
  readonly workspace: Workspace;
  readonly onError: (message: string) => void;
}) {
  const [url, setUrl] = useState(node.url);
  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<PortalRuntimeSnapshot | null>(null);
  const [recovering, setRecovering] = useState(false);
  const surface = useRef<HTMLDivElement | null>(null);
  /**
   * A superfície nativa não é filha do canvas: ela não herda o transform nem é recortada pelo
   * `overflow`. Então medimos o espaço reservado dentro do card e cortamos na área do canvas — é o
   * que impede o Portal de aparecer por cima da barra, da sidebar ou fora do próprio nó.
   */
  const syncBounds = useCallback(() => {
    const frame = surface.current;
    const canvas = frame?.closest<HTMLElement>(".v2-canvas") ?? null;
    if (frame === null || canvas === null) return;
    const rect = frame.getBoundingClientRect();
    const clip = canvas.getBoundingClientRect();
    const left = Math.max(rect.left, clip.left);
    const top = Math.max(rect.top, clip.top);
    const width = Math.min(rect.right, clip.right) - left;
    const height = Math.min(rect.bottom, clip.bottom) - top;
    void window.compazioV2.portals.setBounds({
      workspaceId: workspace.id,
      portalId: node.id,
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      visible: width > 12 && height > 12,
      canvasZoom: workspace.settings.viewport.zoom
    });
  }, [node.id, workspace.id, workspace.settings.viewport.zoom]);

  // Cada pan, zoom, movimento ou redimensionamento reposiciona a superfície no mesmo quadro em que
  // o card se move. Antes disso só o resize da janela ressincronizava, e o Portal ficava para trás.
  useEffect(() => {
    syncBounds();
  }, [
    syncBounds,
    node.position.x,
    node.position.y,
    node.size.width,
    node.size.height,
    workspace.settings.viewport.x,
    workspace.settings.viewport.y,
    workspace.settings.viewport.zoom
  ]);

  useEffect(() => {
    const frame = surface.current;
    if (frame === null) return;
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [syncBounds]);
  const refresh = useCallback(() => {
    void window.compazioV2.portals
      .state({ workspaceId: workspace.id, portalId: node.id })
      .then((items) => setSnapshot(items[0] ?? null))
      .catch(() => undefined);
  }, [node.id, workspace.id]);
  useEffect(() => {
    void window.compazioV2.portals
      .ensure({ workspaceId: workspace.id, portalId: node.id })
      .then(() => {
        syncBounds();
        refresh();
      })
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : "Não foi possível abrir o Portal.")
      );
    window.addEventListener("resize", syncBounds);
    return () => {
      window.removeEventListener("resize", syncBounds);
      void window.compazioV2.portals.setBounds({
        workspaceId: workspace.id,
        portalId: node.id,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        visible: false
      });
    };
  }, [node.id, onError, refresh, syncBounds, workspace.id]);
  useEffect(
    () =>
      window.compazioV2.portals.onEvent((event) => {
        if (event.portalId !== node.id) return;
        refresh();
      }),
    [node.id, refresh]
  );
  const go = (): void => {
    setLoading(true);
    void window.compazioV2.portals
      .navigate({ workspaceId: workspace.id, portalId: node.id, url })
      .then(() => {
        syncBounds();
        refresh();
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : "URL bloqueada."))
      .finally(() => setLoading(false));
  };
  const command = (action: "back" | "forward" | "reload" | "stop"): void => {
    void window.compazioV2.portals
      .command({ workspaceId: workspace.id, portalId: node.id, action })
      .then(refresh)
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : "A ação do Portal falhou.")
      );
  };
  const recover = (mode: "reload" | "recreate"): void => {
    setRecovering(true);
    void window.compazioV2.portals
      .recover({ workspaceId: workspace.id, portalId: node.id, mode })
      .then((result) => setSnapshot(result))
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : "A recuperação do Portal falhou.")
      )
      .finally(() => {
        setRecovering(false);
        syncBounds();
      });
  };
  const failure = snapshot?.failure ?? null;
  return (
    <section className="v2-portal-card" aria-label={`Portal ${node.title}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <button type="button" onClick={() => command("back")} aria-label="Voltar">
          ←
        </button>
        <button type="button" onClick={() => command("forward")} aria-label="Avançar">
          →
        </button>
        <input
          aria-label="Endereço do Portal"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit">{loading ? "…" : "Abrir"}</button>
        <button type="button" onClick={() => command("reload")} aria-label="Atualizar">
          ↻
        </button>
      </form>
      {failure === null ? (
        <>
          {/* Espaço reservado para a superfície nativa: é ele que define os limites do Portal. */}
          <div className="v2-portal-surface" ref={surface} data-testid="v2-portal-surface" />
          <p>
            {snapshot?.loading || snapshot?.state === "loading"
              ? "Carregando página…"
              : (snapshot?.title ?? node.lastKnownState.lastTitle ?? "Página pronta")}
          </p>
        </>
      ) : (
        // A failed Portal keeps its node, position and connections: only the surface died, so the
        // canvas offers the ways back instead of silently showing a blank rectangle.
        <div className="v2-portal-failure" role="alert" data-testid="v2-portal-failure">
          <strong>Portal falhou</strong>
          <p>{failure.reason}</p>
          <p>{failure.lastUrl}</p>
          <div>
            <button type="button" onClick={() => recover("reload")} disabled={recovering}>
              Recarregar Portal
            </button>
            <button type="button" onClick={() => recover("recreate")} disabled={recovering}>
              Recriar Runtime
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    JSON.stringify(
                      {
                        portalId: node.id,
                        state: snapshot?.state ?? "desconhecido",
                        reason: failure.reason,
                        hint: failure.hint,
                        lastUrl: failure.lastUrl,
                        recovery: snapshot?.recovery ?? null
                      },
                      null,
                      2
                    )
                  )
                  .catch(() => onError("Não foi possível copiar o diagnóstico."));
              }}
            >
              Copiar diagnóstico
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The Compazio download dialog. A page can propose a file; only a person here turns that into bytes
 * on disk, and until they answer nothing is written.
 */
function PortalDownloadDialog({ onError }: { readonly onError: (message: string) => void }) {
  const [offer, setOffer] = useState<PortalDownloadOffer | null>(null);
  useEffect(() => window.compazioV2.portals.onDownloadRequest((next) => setOffer(next)), []);
  if (offer === null) return null;
  const settle = (accepted: boolean, overwrite = false): void => {
    const current = offer;
    setOffer(null);
    void window.compazioV2.portals
      .decideDownload({
        requestId: current.id,
        accepted,
        ...(accepted ? { destination: current.suggestedDestination, overwrite } : {})
      })
      .catch(() => onError("Não foi possível responder ao download."));
  };
  return (
    <div className="v2-modal-backdrop" role="presentation">
      <section className="v2-modal" role="dialog" aria-modal="true" aria-label="Download do Portal">
        <div className="v2-modal-content" data-testid="v2-portal-download">
          <h2>Baixar arquivo?</h2>
          <dl>
            <dt>Origem</dt>
            <dd>{offer.origin}</dd>
            <dt>Arquivo</dt>
            <dd>{offer.filename}</dd>
            <dt>Tipo</dt>
            <dd>{offer.extension === "" ? offer.mimeType : offer.extension}</dd>
            <dt>Tamanho</dt>
            <dd>{offer.totalBytes < 0 ? "desconhecido" : `${offer.totalBytes} bytes`}</dd>
            <dt>Destino</dt>
            <dd>{offer.suggestedDestination}</dd>
          </dl>
          {offer.destinationExists && <p>Já existe um arquivo com esse nome no destino.</p>}
          <div>
            <button type="button" onClick={() => settle(false)}>
              Cancelar
            </button>
            <button type="button" onClick={() => settle(true)}>
              Salvar
            </button>
            {offer.destinationExists && (
              <button type="button" onClick={() => settle(true, true)}>
                Substituir
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function nodeTypeLabel(type: CanvasNode["type"]): string {
  if (type === "terminal") return "Terminal";
  if (type === "note") return "Nota";
  if (type === "file-tree") return "Arquivos";
  if (type === "portal") return "Portal";
  return "Preview";
}

function NodeTypeIcon({ type }: { readonly type: CanvasNode["type"] }) {
  if (type === "terminal") return <ToolIcon name="terminal" />;
  if (type === "note") return <ToolIcon name="note" />;
  if (type === "portal") return <ToolIcon name="portal" />;
  return <ToolIcon name="files" />;
}

const MINIMAP_FRAME: Size = { width: 200, height: 128 };

function rectStyle(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/**
 * O minimapa existe para o canvas nunca "sumir": mesmo com a viewport longe de qualquer nó, ela e
 * os nós são projetados juntos, e um clique traz a pessoa de volta ao trabalho.
 */
function Minimap({
  workspace,
  selectedNodeIds,
  size,
  onJump
}: {
  readonly workspace: Workspace;
  readonly selectedNodeIds: readonly string[];
  readonly size: Size;
  readonly onJump: (target: Position) => void;
}) {
  const view = visibleRect(workspace.settings.viewport, size);
  const bounds = boundsOf(workspace.nodes) ?? view;
  const projection = minimapProjection(unionRect(bounds, view), MINIMAP_FRAME);
  const jumpTo = (clientX: number, clientY: number, element: HTMLElement): void => {
    const box = element.getBoundingClientRect();
    onJump({
      x: (clientX - box.left - projection.offsetX) / projection.scale,
      y: (clientY - box.top - projection.offsetY) / projection.scale
    });
  };
  return (
    <div
      className="v2-minimap"
      role="button"
      tabIndex={0}
      aria-label="Minimapa do canvas"
      data-testid="v2-minimap"
      onPointerDown={(event) => {
        event.stopPropagation();
        jumpTo(event.clientX, event.clientY, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onJump({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      }}
    >
      {workspace.nodes.map((node) => (
        <span
          key={node.id}
          className={`v2-minimap-node ${node.type} ${
            selectedNodeIds.includes(node.id) ? "selected" : ""
          }`}
          style={rectStyle(
            projection.project({
              x: node.position.x,
              y: node.position.y,
              width: node.size.width,
              height: node.size.height
            })
          )}
        />
      ))}
      <div className="v2-minimap-viewport" style={rectStyle(projection.project(view))} />
    </div>
  );
}

const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Mono", Consolas, monospace';

function TerminalCard({
  terminal,
  workspace,
  session,
  onWorkspace,
  onError,
  onConfigure
}: {
  readonly terminal: TerminalNode;
  readonly workspace: Workspace;
  readonly session: TerminalSession | undefined;
  readonly onWorkspace: (workspace: Workspace) => Promise<void>;
  readonly onError: (message: string) => void;
  readonly onConfigure: () => void;
}) {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const xterm = useRef<Terminal | null>(null);
  const [terminalMenu, setTerminalMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly hasSelection: boolean;
  } | null>(null);
  const [terminalHasSelection, setTerminalHasSelection] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const sessionId = session?.id;
  useEffect(() => {
    if (terminalMenu === null) return;
    const close = (): void => setTerminalMenu(null);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [terminalMenu]);
  useEffect(() => {
    const terminalHost = terminalElement.current;
    if (terminalHost === null || sessionId === undefined) return;
    const instance = new Terminal({
      // PTY output is already framed by the child process. Converting every LF to CRLF here
      // changes cursor-addressed TUIs (Claude Code in particular) and makes rows overwrite one
      // another. Keep the byte-for-byte control stream for xterm to interpret.
      convertEol: false,
      cursorBlink: true,
      // Use the mono font shipped inside the application. Depending on a machine font made cell
      // metrics differ between development, the unpacked app and the installed NSIS build.
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 10_000,
      // Keep the complete ANSI palette explicit. Claude emits true-colour sequences, but xterm's
      // DOM renderer needs an initialized ANSI palette before it can materialize those cells with
      // colour styles (a foreground/background-only theme leaves them visually monochrome).
      theme: {
        background: "#111318",
        foreground: "#e7edf6",
        cursor: "#e7edf6",
        black: "#111318",
        red: "#d77757",
        green: "#4eba65",
        yellow: "#e4b65e",
        blue: "#6aa8ff",
        magenta: "#d789e8",
        cyan: "#62d6e8",
        white: "#e7edf6",
        brightBlack: "#666b78",
        brightRed: "#f28b6b",
        brightGreen: "#68d98a",
        brightYellow: "#f5ce78",
        brightBlue: "#8abaff",
        brightMagenta: "#e7a6f4",
        brightCyan: "#85e8f7",
        brightWhite: "#ffffff"
      }
    });
    const addon = new FitAddon();
    instance.loadAddon(addon);
    instance.open(terminalHost);
    // Prefer the official WebGL renderer, but keep xterm's DOM renderer as a complete fallback.
    // The packaged CSP explicitly permits xterm's presentation-only inline cell styles, so a GPU
    // or context failure must never turn ANSI output monochrome or corrupt block/box glyphs.
    let webglAddon: WebglAddon | null = null;
    let webglContextLoss: { dispose(): void } | null = null;
    const forceDomRenderer =
      new URLSearchParams(window.location.search).get("terminalRenderer") === "dom";
    if (!forceDomRenderer) {
      try {
        webglAddon = new WebglAddon();
        webglContextLoss = webglAddon.onContextLoss(() => {
          webglContextLoss?.dispose();
          webglContextLoss = null;
          webglAddon?.dispose();
          webglAddon = null;
          terminalHost.dataset.terminalRenderer = "dom-fallback";
          instance.refresh(0, Math.max(0, instance.rows - 1));
        });
        instance.loadAddon(webglAddon);
        terminalHost.dataset.terminalRenderer = "webgl";
      } catch {
        webglContextLoss?.dispose();
        webglContextLoss = null;
        webglAddon?.dispose();
        webglAddon = null;
        terminalHost.dataset.terminalRenderer = "dom-fallback";
      }
    } else {
      terminalHost.dataset.terminalRenderer = "dom-fallback";
    }
    let fontLoadCancelled = false;
    let requestTerminalResize = (): void => undefined;
    void Promise.all([
      document.fonts.load('400 13px "JetBrains Mono Variable"'),
      document.fonts.load('600 13px "JetBrains Mono Variable"')
    ]).then(() => {
      if (fontLoadCancelled || !terminalHost.isConnected) return;
      terminalHost.dataset.terminalFontReady = String(
        document.fonts.check('400 13px "JetBrains Mono Variable"')
      );
      // Loading can finish after the WebGL texture atlas was created. Clear only the public atlas,
      // then use the synchronized resize path so ConPTY and xterm share the final font metrics.
      webglAddon?.clearTextureAtlas();
      requestTerminalResize();
      instance.refresh(0, Math.max(0, instance.rows - 1));
    });
    terminalHost.dataset.terminalFontFamily = instance.options.fontFamily ?? "";
    terminalHost.dataset.terminalDevicePixelRatio = String(window.devicePixelRatio);
    let inputTail = Promise.resolve();
    let lastTuiPageNavigationAt = Number.NEGATIVE_INFINITY;
    let codexTranscriptNavigationActive = false;
    const sendInput = (value: string, followingData?: readonly "\r"[]): void => {
      if (terminal.agentConfig.agentId === "codex") {
        if (value === "\u0014") codexTranscriptNavigationActive = !codexTranscriptNavigationActive;
        else if (value === "\u001b" || value === "q") codexTranscriptNavigationActive = false;
      }
      // xterm emits the exact bytes for printable keys and controls. The main process writes them
      // directly to the owned PTY; there is no React line buffer or keyboard reconstruction here.
      // Keep separate onData events ordered. A large bracketed paste and its following Enter are
      // separate IPC invocations; without this queue the Enter can reach the PTY first and leave
      // the mission sitting in the provider's composer instead of submitting it.
      const traceWindow = window as typeof window & {
        __compazioFinalTerminalInputFrames?: {
          length: number;
          bracketed: boolean;
          enter: boolean;
          written: boolean;
          data?: string;
        }[];
      };
      const observe = (data: string) => ({
        length: data.length,
        bracketed: data.startsWith("\u001b[200~") && data.endsWith("\u001b[201~"),
        enter: data === "\r",
        written: false,
        ...(data.length <= 100 ? { data } : {})
      });
      const observed = [
        observe(value),
        ...(followingData === undefined ? [] : followingData.map(observe))
      ];
      traceWindow.__compazioFinalTerminalInputFrames?.push(...observed);
      inputTail = inputTail
        .then(async () => {
          const write = (data: string) =>
            window.compazioV2.terminal.write({
              workspaceId: workspace.id,
              nodeId: terminal.id,
              sessionId,
              data,
              ...(followingData === undefined ? {} : { followingData })
            });
          await write(value);
          for (const frame of observed) frame.written = true;
        })
        .catch(toMessage(onError));
    };
    const data = instance.onData((value) => sendInput(value));
    const pasteIntoTerminal = (text: string): void => {
      if (text.length === 0) return;
      const forcedFrame = forcedAgentPasteFrame({
        text,
        agentId: terminal.agentConfig.agentId,
        windowsConpty: /Windows/i.test(navigator.userAgent),
        bracketedPasteMode: instance.modes.bracketedPasteMode
      });
      if (forcedFrame === null) instance.paste(text);
      else sendInput(forcedFrame);
    };
    const unregisterInput = terminalInputBus.register(terminal.id, async (text) => {
      const forcedFrame = forcedAgentPasteFrame({
        text,
        agentId: terminal.agentConfig.agentId,
        windowsConpty: /Windows/i.test(navigator.userAgent),
        // Prompt Composer owns submission as one transaction. Force its coding-agent payload
        // through the serialized main-process barrier even when xterm has observed DEC 2004;
        // otherwise the native paste branch can submit only one Enter and Codex/OpenCode merely
        // stage or expand the pasted block instead of starting the request.
        bracketedPasteMode: false
      });
      if (forcedFrame !== null) {
        sendInput(
          forcedFrame,
          terminal.agentConfig.agentId === "opencode"
            ? ["\r", "\r", "\r"]
            : terminal.agentConfig.agentId === "codex"
              ? ["\r", "\r"]
              : ["\r"]
        );
        await inputTail;
        return;
      }
      instance.paste(text);
      await inputTail;
      instance.input("\r", true);
      await inputTail;
    });
    // Clipboard stays on the serialized visible-PTY input path. Normally xterm owns framing; the
    // Windows coding-agent exception above restores a private mode that ConPTY hid from xterm.
    const onClipboardPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pasteIntoTerminal(text);
    };
    const remapScaledTerminalMouseEvent = (event: MouseEvent | WheelEvent): boolean => {
      const coordinateSurface = terminalHost.querySelector<HTMLElement>(".xterm-screen");
      if (coordinateSurface === null) return false;
      const rect = coordinateSurface.getBoundingClientRect();
      const layoutWidth = coordinateSurface.offsetWidth;
      const layoutHeight = coordinateSurface.offsetHeight;
      if (layoutWidth <= 0 || layoutHeight <= 0 || rect.width <= 0 || rect.height <= 0)
        return false;
      const scaleX = rect.width / layoutWidth;
      const scaleY = rect.height / layoutHeight;
      if (Math.abs(scaleX - 1) < 0.005 && Math.abs(scaleY - 1) < 0.005) return false;
      // Keep the original trusted Chromium event. Some TUIs deliberately reject synthetic mouse
      // events, so redispatching a corrected WheelEvent makes scrolling disappear entirely.
      // Shadowing the prototype accessors during capture lets xterm consume the native event with
      // coordinates expressed in its unscaled layout space.
      Object.defineProperties(event, {
        clientX: {
          configurable: true,
          value: rect.left + (event.clientX - rect.left) / scaleX
        },
        clientY: {
          configurable: true,
          value: rect.top + (event.clientY - rect.top) / scaleY
        }
      });
      return false;
    };
    const bridgeConptyMouseWheel = (event: WheelEvent, scrollbackMoved: boolean): boolean => {
      // Windows ConPTY consumes the DEC private mouse-mode switches before forwarding the
      // rendered stream to xterm. A real TUI can therefore be waiting for SGR mouse input while
      // xterm's public mode remains `none` (ConPTY also consumes the alternate-buffer switch).
      // Agent terminals are explicitly TUI terminals, independent of provider. Shell/custom
      // terminals keep normal local scrollback and only bridge once that scrollback cannot move.
      // Every report still uses the same serialized PTY input queue used by xterm.
      if (
        !/Windows/i.test(navigator.userAgent) ||
        instance.modes.mouseTrackingMode !== "none" ||
        event.deltaY === 0 ||
        (["shell", "custom"].includes(terminal.agentConfig.agentId) &&
          instance.buffer.active.type !== "alternate" &&
          scrollbackMoved)
      )
        return false;
      const coordinateSurface = terminalHost.querySelector<HTMLElement>(".xterm-screen");
      if (coordinateSurface === null) return false;
      const rect = coordinateSurface.getBoundingClientRect();
      const cellWidth = coordinateSurface.offsetWidth / instance.cols;
      const cellHeight = coordinateSurface.offsetHeight / instance.rows;
      if (cellWidth <= 0 || cellHeight <= 0) return false;
      const column = Math.max(
        1,
        Math.min(instance.cols, Math.floor((event.clientX - rect.left) / cellWidth) + 1)
      );
      const row = Math.max(
        1,
        Math.min(instance.rows, Math.floor((event.clientY - rect.top) / cellHeight) + 1)
      );
      sendInput(`\u001b[<${event.deltaY < 0 ? 64 : 65};${column};${row}M`);
      return true;
    };
    const onTerminalWheel = (event: WheelEvent): void => {
      // xterm calculates mouse cells from unscaled CSS dimensions. Canvas zoom transforms the
      // rendered rectangle but not those dimensions, so native TUI mouse reports land in the wrong
      // row/column unless the client coordinates are mapped back into the terminal's layout space.
      if (remapScaledTerminalMouseEvent(event)) return;
      // xterm 6 uses a virtual scrollbar instead of the browser's scrollTop. In an element that is
      // transformed with the canvas, Chromium can deliver the wheel without advancing that virtual
      // scrollbar. Drive xterm's public buffer API explicitly while preserving mouse-reporting TUIs.
      terminalHost.dataset.terminalWheelEvents = String(
        Number(terminalHost.dataset.terminalWheelEvents ?? "0") + 1
      );
      terminalHost.dataset.terminalWheelDelta = String(event.deltaY);
      terminalHost.dataset.terminalMouseTracking = instance.modes.mouseTrackingMode;
      if (event.deltaY === 0 || instance.modes.mouseTrackingMode !== "none") return;
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / 40));
      const buffer = instance.buffer.active;
      const isProviderOwnedViewport = ["claude-code", "codex", "opencode"].includes(
        terminal.agentConfig.agentId
      );
      if (isProviderOwnedViewport) {
        // ConPTY can consume the child's private mouse-mode announcement, so xterm reports `none`
        // even while the full-screen TUI owns the viewport. Choose only the provider's viewport
        // transport here; this never inspects output and cannot submit a prompt.
        const now = performance.now();
        if (now - lastTuiPageNavigationAt >= 60) {
          const plan = terminalTuiWheelPlan({
            agentId: terminal.agentConfig.agentId,
            deltaY: event.deltaY,
            codexTranscriptActive: codexTranscriptNavigationActive
          });
          if (plan.kind === "keys") sendInput(plan.data);
          if (plan.kind === "mouse") bridgeConptyMouseWheel(event, false);
          codexTranscriptNavigationActive = plan.codexTranscriptActive;
          lastTuiPageNavigationAt = now;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const targetLine = Math.max(
        0,
        Math.min(buffer.baseY, buffer.viewportY + (event.deltaY < 0 ? -lines : lines))
      );
      // Plain terminals keep xterm's durable scrollback and only forward a hidden ConPTY mouse
      // report after that local viewport cannot move any farther.
      const scrollbackMoved = targetLine !== buffer.viewportY;
      if (scrollbackMoved) instance.scrollToLine(targetLine);
      bridgeConptyMouseWheel(event, scrollbackMoved);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Keep the virtual scroll position observable from the DOM. Besides making the Electron
    // acceptance test independent from xterm's renderer, this is useful to accessibility and
    // diagnostics tooling that cannot reach the Terminal instance hidden inside this component.
    terminalHost.dataset.terminalScrollLine = String(instance.buffer.active.viewportY);
    const scrollPosition = instance.onScroll((line) => {
      terminalHost.dataset.terminalScrollLine = String(line);
    });
    const selectionPosition = instance.onSelectionChange(() => {
      setTerminalHasSelection(instance.hasSelection());
    });
    const discardKeyboardSelection = (): void => {
      if (instance.hasSelection()) instance.clearSelection();
    };
    const onTerminalPointerDown = (event: PointerEvent): void => {
      // Starting a new primary-button selection replaces the old selection. Right click must keep
      // it intact so the context menu can copy the text the person just selected.
      if (event.button === 0) discardKeyboardSelection();
    };
    const onTerminalKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      const pasteShortcut =
        (event.ctrlKey && !event.metaKey && !event.altKey && key === "v") ||
        (event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          event.key === "Insert");
      if (pasteShortcut) {
        // The narrow preload bridge uses Electron's native clipboard. Preventing the browser's
        // default avoids a second xterm paste when the subsequent native paste event arrives.
        event.preventDefault();
        event.stopImmediatePropagation();
        void window.compazioV2.clipboard
          .readText()
          .then(pasteIntoTerminal)
          .catch(toMessage(onError));
        discardKeyboardSelection();
        return;
      }
      if (!event.ctrlKey || event.metaKey || event.altKey) {
        discardKeyboardSelection();
        return;
      }
      if (key === "a" && event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        instance.selectAll();
        return;
      }
      if (key === "c" && instance.hasSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void window.compazioV2.clipboard
          .writeText(instance.getSelection())
          .catch(toMessage(onError));
        return;
      }
      // Ctrl+A, Ctrl+C without a selection and every readline/TUI key continue through xterm's
      // native keyboard path to the PTY. React never reconstructs or edits the command line.
      discardKeyboardSelection();
    };
    terminalHost.addEventListener("paste", onClipboardPaste, true);
    terminalHost.addEventListener("keydown", onTerminalKeyDown, true);
    terminalHost.addEventListener("pointerdown", onTerminalPointerDown, true);
    terminalHost.addEventListener("mousedown", remapScaledTerminalMouseEvent, true);
    terminalHost.addEventListener("mouseup", remapScaledTerminalMouseEvent, true);
    terminalHost.addEventListener("mousemove", remapScaledTerminalMouseEvent, true);
    terminalHost.addEventListener("wheel", onTerminalWheel, { capture: true, passive: false });
    // xterm 6 no longer exposes onFocus/onBlur. focusin/focusout bubble from its hidden textarea
    // and keep the canvas shortcuts out of the terminal without depending on xterm internals.
    const onFocus = (): void => {
      terminalHost
        ?.closest<HTMLElement>(".v2-terminal-body")
        ?.setAttribute("data-terminal-focused", "true");
    };
    const onBlur = (): void => {
      terminalHost
        ?.closest<HTMLElement>(".v2-terminal-body")
        ?.removeAttribute("data-terminal-focused");
    };
    terminalHost.addEventListener("focusin", onFocus);
    terminalHost.addEventListener("focusout", onBlur);
    xterm.current = instance;
    let resizeFrame: number | null = null;
    let followUpResizeFrame: number | null = null;
    let resizeRefreshFrame: number | null = null;
    let resizeSettleTimer: number | null = null;
    let geometryTransitionStartedAt = 0;
    let geometryGeneration = 0;
    let geometryTransition = false;
    const geometryOutputQueue: string[] = [];
    let flushResizeBufferedOutput: (generation: number) => void = () => undefined;
    let scheduleGeometryFinish = (): void => undefined;
    const resizeCoordinator = createTerminalResizeCoordinator({
      measure: () => {
        const element = terminalElement.current;
        if (
          element === null ||
          !element.isConnected ||
          element.clientWidth <= 0 ||
          element.clientHeight <= 0
        )
          return undefined;
        try {
          const proposed = addon.proposeDimensions();
          if (proposed === undefined || proposed.cols < 1 || proposed.rows < 1) return undefined;
          return { cols: proposed.cols, rows: proposed.rows };
        } catch {
          // Chromium briefly exposes a zero-sized canvas during minimize/restore. A later observer
          // frame will retry without ever sending a destructive 1x1 resize to the real process.
          return undefined;
        }
      },
      resizePty: async (size) => {
        await window.compazioV2.terminal.resize({
          workspaceId: workspace.id,
          nodeId: terminal.id,
          sessionId,
          cols: size.cols,
          rows: size.rows
        });
        terminalHost.dataset.terminalPtyCols = String(size.cols);
        terminalHost.dataset.terminalPtyRows = String(size.rows);
      },
      resizeRenderer: (size) => {
        instance.resize(size.cols, size.rows);
        terminalHost.dataset.terminalCols = String(instance.cols);
        terminalHost.dataset.terminalRows = String(instance.rows);
        terminalHost.dataset.terminalResizeCommits = String(
          Number(terminalHost.dataset.terminalResizeCommits ?? "0") + 1
        );
        // WebGL replaces its backing canvas on a geometry change. Refresh on the next presentation
        // frame, after the new viewport/canvas dimensions exist, so the preserved xterm buffer is
        // painted even when a quiet TUI emits no resize redraw of its own.
        if (resizeRefreshFrame !== null) window.cancelAnimationFrame(resizeRefreshFrame);
        resizeRefreshFrame = window.requestAnimationFrame(() => {
          resizeRefreshFrame = null;
          instance.refresh(0, Math.max(0, instance.rows - 1));
        });
      },
      onTransitionStart: () => {
        if (resizeSettleTimer !== null) window.clearTimeout(resizeSettleTimer);
        resizeSettleTimer = null;
        geometryTransitionStartedAt = performance.now();
        geometryGeneration += 1;
        geometryTransition = true;
        terminalHost.dataset.terminalResizeTransition = "true";
      },
      onTransitionEnd: () => {
        scheduleGeometryFinish();
      },
      onError
    });
    const scheduleResize = (): void => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        resizeCoordinator.request();
        // A restored Electron window can settle its grid dimensions one frame after the first
        // measurement. A second fit keeps the PTY in lockstep without a polling loop.
        if (followUpResizeFrame !== null) window.cancelAnimationFrame(followUpResizeFrame);
        followUpResizeFrame = window.requestAnimationFrame(() => {
          followUpResizeFrame = null;
          resizeCoordinator.request();
        });
      });
    };
    requestTerminalResize = scheduleResize;
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(terminalHost);
    window.addEventListener("resize", scheduleResize);
    window.addEventListener("focus", scheduleResize);
    window.addEventListener("pageshow", scheduleResize);
    document.addEventListener("visibilitychange", scheduleResize);
    scheduleResize();
    let refreshFrame: number | null = null;
    const scheduleOutputRefresh = (): void => {
      if (refreshFrame !== null) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        // xterm can populate its buffer before the DOM renderer has completed its first pass.
        // Refresh the visible rows once per frame so ANSI/true-colour attributes are painted
        // immediately, including the initial Claude Code TUI snapshot.
        instance.refresh(0, Math.max(0, instance.rows - 1));
      });
    };
    const writeOutputNow = (data: string, onWritten?: () => void): void => {
      // xterm parses writes asynchronously; refresh from its completion callback so the DOM
      // renderer sees the final cell attributes (including Claude's true-colour sequences).
      instance.write(data, () => {
        terminalHost.dataset.terminalMouseTracking = instance.modes.mouseTrackingMode;
        scheduleOutputRefresh();
        onWritten?.();
      });
    };
    const revealSettledTerminal = (generation: number): void => {
      if (generation !== geometryGeneration || geometryTransition) return;
      delete terminalHost.dataset.terminalResizeTransition;
      instance.refresh(0, Math.max(0, instance.rows - 1));
    };
    flushResizeBufferedOutput = (generation) => {
      if (geometryOutputQueue.length === 0) {
        revealSettledTerminal(generation);
        return;
      }
      const buffered = geometryOutputQueue.splice(0).join("");
      // Reveal only after xterm has parsed the complete resize redraw, never a differential frame.
      writeOutputNow(buffered, () => revealSettledTerminal(generation));
    };
    const finishGeometryTransition = (): void => {
      resizeSettleTimer = null;
      if (!geometryTransition) return;
      geometryTransition = false;
      flushResizeBufferedOutput(geometryGeneration);
    };
    scheduleGeometryFinish = () => {
      if (!geometryTransition) return;
      if (resizeSettleTimer !== null) window.clearTimeout(resizeSettleTimer);
      const elapsed = performance.now() - geometryTransitionStartedAt;
      // A full ConPTY redraw normally arrives in a few 16 ms batches. Wait for 100 ms of quiet,
      // but cap the hidden interval so continuous command output can never starve the terminal.
      const delay = elapsed >= 600 ? 0 : Math.min(100, 600 - elapsed);
      resizeSettleTimer = window.setTimeout(finishGeometryTransition, delay);
    };
    const writeOutput = (data: string): void => {
      terminalHost.dataset.terminalOutputChars = String(
        Number(terminalHost.dataset.terminalOutputChars ?? "0") + data.length
      );
      if (geometryTransition) {
        geometryOutputQueue.push(data);
        terminalHost.dataset.terminalResizeBufferedChars = String(
          Number(terminalHost.dataset.terminalResizeBufferedChars ?? "0") + data.length
        );
        scheduleGeometryFinish();
        return;
      }
      writeOutputNow(data);
    };
    // Keep the xterm instance alive while a session changes running/waiting state. Recreating it
    // replayed the buffer in the middle of PSReadLine input and left ghost/duplicated characters.
    writeOutput(terminalOutputBus.snapshot(sessionId));
    const unsubscribeOutput = terminalOutputBus.subscribe(sessionId, writeOutput);
    return () => {
      fontLoadCancelled = true;
      unsubscribeOutput();
      unregisterInput();
      observer.disconnect();
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener("focus", scheduleResize);
      window.removeEventListener("pageshow", scheduleResize);
      document.removeEventListener("visibilitychange", scheduleResize);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (followUpResizeFrame !== null) window.cancelAnimationFrame(followUpResizeFrame);
      if (resizeRefreshFrame !== null) window.cancelAnimationFrame(resizeRefreshFrame);
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      if (resizeSettleTimer !== null) window.clearTimeout(resizeSettleTimer);
      resizeCoordinator.dispose();
      geometryOutputQueue.length = 0;
      data.dispose();
      scrollPosition.dispose();
      selectionPosition.dispose();
      setTerminalHasSelection(false);
      delete terminalHost.dataset.terminalScrollLine;
      delete terminalHost.dataset.terminalWheelEvents;
      delete terminalHost.dataset.terminalWheelDelta;
      delete terminalHost.dataset.terminalMouseTracking;
      delete terminalHost.dataset.terminalRenderer;
      delete terminalHost.dataset.terminalFontReady;
      delete terminalHost.dataset.terminalFontFamily;
      delete terminalHost.dataset.terminalDevicePixelRatio;
      delete terminalHost.dataset.terminalCols;
      delete terminalHost.dataset.terminalRows;
      delete terminalHost.dataset.terminalPtyCols;
      delete terminalHost.dataset.terminalPtyRows;
      delete terminalHost.dataset.terminalResizeTransition;
      delete terminalHost.dataset.terminalResizeBufferedChars;
      delete terminalHost.dataset.terminalResizeCommits;
      delete terminalHost.dataset.terminalOutputChars;
      terminalHost.removeEventListener("paste", onClipboardPaste, true);
      terminalHost.removeEventListener("keydown", onTerminalKeyDown, true);
      terminalHost.removeEventListener("pointerdown", onTerminalPointerDown, true);
      terminalHost.removeEventListener("mousedown", remapScaledTerminalMouseEvent, true);
      terminalHost.removeEventListener("mouseup", remapScaledTerminalMouseEvent, true);
      terminalHost.removeEventListener("mousemove", remapScaledTerminalMouseEvent, true);
      terminalHost.removeEventListener("wheel", onTerminalWheel, true);
      terminalHost.removeEventListener("focusin", onFocus);
      terminalHost.removeEventListener("focusout", onBlur);
      webglContextLoss?.dispose();
      instance.dispose();
      xterm.current = null;
    };
  }, [onError, sessionId, terminal.agentConfig.agentId, terminal.id, workspace.id]);
  const start = (): void => {
    void window.compazioV2.terminal
      .start({ workspaceId: workspace.id, nodeId: terminal.id })
      .then(() => onWorkspace(workspace))
      .catch(toMessage(onError));
  };
  const stop = (): void => {
    if (session !== undefined)
      void window.compazioV2.terminal
        .stop({ workspaceId: workspace.id, nodeId: terminal.id, sessionId: session.id })
        .catch(toMessage(onError));
  };
  const restart = (): void => {
    if (session !== undefined)
      void window.compazioV2.terminal
        .restart({ workspaceId: workspace.id, nodeId: terminal.id, sessionId: session.id })
        .then(() => onWorkspace(workspace))
        .catch(toMessage(onError));
  };
  const running =
    session !== undefined &&
    ["starting", "running", "waiting-input", "stopping"].includes(session.state);
  const submitPrompt = async (): Promise<void> => {
    const text = promptDraft;
    if (!running || sendingPrompt || text.trim() === "") return;
    setSendingPrompt(true);
    try {
      if (!(await terminalInputBus.submit(terminal.id, text)))
        throw new Error("O terminal ainda não está pronto para receber o prompt.");
      setPromptDraft("");
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingPrompt(false);
    }
  };
  return (
    <div
      className="v2-terminal-body with-prompt"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.stopPropagation();
        if (!(event.target instanceof Element) || event.target.closest(".v2-xterm") === null)
          return;
        event.preventDefault();
        setTerminalMenu({
          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 210)),
          hasSelection: xterm.current?.hasSelection() ?? false
        });
      }}
    >
      <div className="v2-terminal-controls">
        <div className="v2-terminal-badges">
          <span className="v2-agent-badge">{terminal.agentConfig.agentId}</span>
          {terminal.isCompazio && (
            <span className="v2-role-badge" data-testid="v2-team-coordinator">
              Coordena o time
            </span>
          )}
          {terminal.agentConfig.agentId !== "shell" && session !== undefined && (
            <span
              className="v2-role-badge"
              data-testid="v2-compazio-connected"
              title="CLI de conexões disponível nesta sessão"
            >
              Conectado ao Compazio
            </span>
          )}
          {terminal.agentConfig.roleId !== undefined && (
            <span className="v2-role-badge">{terminal.agentConfig.roleId}</span>
          )}
        </div>
        {/* Os controles não rolam para o lado: cabem sempre, e o que sobra são as etiquetas que
            encolhem. Ligar e parar ficam à mão; o resto vive no menu do próprio terminal. */}
        <div className="v2-terminal-actions">
          <button
            disabled={!terminalHasSelection}
            onClick={() => {
              const selection = xterm.current?.getSelection() ?? "";
              if (selection !== "")
                void window.compazioV2.clipboard.writeText(selection).catch(toMessage(onError));
            }}
            aria-label="Copiar seleção do terminal"
            title="Copiar seleção — Ctrl+C"
          >
            <ToolIcon name="copy" />
          </button>
          {running ? (
            <button onClick={stop} aria-label="Parar terminal" title="Parar">
              <ToolIcon name="stop" />
            </button>
          ) : (
            <button onClick={start} aria-label="Iniciar terminal" title="Iniciar">
              <ToolIcon name="play" />
            </button>
          )}
          <button
            onClick={restart}
            disabled={session === undefined || ["starting", "stopping"].includes(session.state)}
            aria-label="Reiniciar terminal"
            title="Reiniciar"
          >
            <ToolIcon name="restart" />
          </button>
          <button onClick={onConfigure} aria-label="Configurar terminal" title="Configurar">
            <ToolIcon name="settings" />
          </button>
        </div>
      </div>
      {session === undefined ? (
        <div className="v2-terminal-placeholder" role="status">
          Pronto. Inicie para abrir um shell local.
        </div>
      ) : (
        <div className="v2-xterm">
          {/* O FitAddon mede este elemento sem padding. Medir o contêiner com espaçamento fazia
              o terminal criar a última linha fora da área visível do card. */}
          <div className="v2-xterm-screen" ref={terminalElement} />
        </div>
      )}
      <form
        className="v2-terminal-prompt"
        aria-label={`Prompt para ${terminal.title}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submitPrompt();
        }}
      >
        <textarea
          rows={1}
          value={promptDraft}
          disabled={!running || sendingPrompt}
          aria-label="Editar prompt"
          placeholder={
            running
              ? "Digite aqui — clique para editar; Enter envia; Shift+Enter quebra linha"
              : "Inicie o terminal para escrever"
          }
          onChange={(event) => setPromptDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submitPrompt();
          }}
        />
        <button
          type="submit"
          disabled={!running || sendingPrompt || promptDraft.trim() === ""}
          aria-label="Enviar prompt ao terminal"
          title="Enviar prompt"
        >
          {sendingPrompt ? "…" : "Enviar"}
        </button>
      </form>
      {terminalMenu !== null && (
        <div
          className="v2-context-menu v2-terminal-context-menu"
          role="menu"
          aria-label="Menu do terminal"
          style={{ left: terminalMenu.x, top: terminalMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!terminalMenu.hasSelection}
            onClick={() => {
              const selection = xterm.current?.getSelection() ?? "";
              if (selection !== "")
                void window.compazioV2.clipboard.writeText(selection).catch(toMessage(onError));
              setTerminalMenu(null);
            }}
          >
            Copiar
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void window.compazioV2.clipboard
                .readText()
                .then((text) => {
                  if (text !== "") xterm.current?.paste(text);
                })
                .catch(toMessage(onError));
              setTerminalMenu(null);
            }}
          >
            Colar
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              xterm.current?.selectAll();
              setTerminalMenu(null);
            }}
          >
            Selecionar tudo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!terminalMenu.hasSelection}
            onClick={() => {
              xterm.current?.clearSelection();
              setTerminalMenu(null);
            }}
          >
            Limpar seleção
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              xterm.current?.clear();
              setTerminalMenu(null);
            }}
          >
            Limpar terminal
          </button>
        </div>
      )}
    </div>
  );
}

function NoteCard({
  note,
  workspace,
  onWorkspace,
  onError
}: {
  readonly note: Extract<CanvasNode, { type: "note" }>;
  readonly workspace: Workspace;
  readonly onWorkspace: (workspace: Workspace) => Promise<void>;
  readonly onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"raw" | "formatted">("raw");
  const [draft, setDraft] = useState(note.content);
  useEffect(() => {
    const updateFromWorkspace = window.setTimeout(() => setDraft(note.content), 0);
    return () => window.clearTimeout(updateFromWorkspace);
  }, [note.content]);
  useEffect(() => {
    const notesDirectory = ".compazio/notes";
    void window.compazioV2.files
      .watch({ workspaceId: workspace.id, treeNodeId: note.id, path: notesDirectory })
      .catch(toMessage(onError));
    const unsubscribe = window.compazioV2.files.onEvent((event) => {
      if (event.workspaceId !== workspace.id || event.treeNodeId !== note.id) return;
      void window.compazioV2.workspace
        .open({ workspaceId: workspace.id })
        .then(onWorkspace)
        .catch(toMessage(onError));
    });
    return () => {
      unsubscribe();
      void window.compazioV2.files.unwatch({
        workspaceId: workspace.id,
        treeNodeId: note.id,
        path: notesDirectory
      });
    };
  }, [note.id, onError, onWorkspace, workspace.id]);
  const update = (patch: { readonly title?: string; readonly content?: string }): void => {
    void window.compazioV2.nodes
      .update({ workspaceId: workspace.id, nodeId: note.id, ...patch })
      .then(onWorkspace)
      .catch(toMessage(onError));
  };
  return (
    <div className="v2-note-body">
      <div className="v2-note-mode" role="group" aria-label="Modo da nota">
        <button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>
          Raw
        </button>
        <button aria-pressed={mode === "formatted"} onClick={() => setMode("formatted")}>
          Visual
        </button>
        <button
          title="Adicionar item que você ou um agente pode concluir"
          onClick={() => {
            const next = `${draft}${draft.trim() === "" || draft.endsWith("\n") ? "" : "\n"}- [ ] `;
            setDraft(next);
            setMode("raw");
          }}
        >
          + Tarefa
        </button>
      </div>
      <input
        aria-label="Título da nota"
        defaultValue={note.title}
        onBlur={(event) => update({ title: event.target.value })}
      />
      {mode === "raw" ? (
        <textarea
          aria-label="Conteúdo da nota"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => update({ content: draft })}
          placeholder="Escreva uma nota, tarefa ou entrega compartilhada…"
        />
      ) : (
        <MarkdownPreview source={note.content} />
      )}
    </div>
  );
}

function AgentTerminalDialog({
  state,
  workspace,
  definitions,
  roles,
  installations,
  onRefreshInstallations,
  session,
  onCancel,
  onSubmit
}: {
  readonly state: TerminalDialogState;
  readonly workspace: Workspace;
  readonly definitions: readonly AgentDefinition[];
  readonly roles: readonly AgentRole[];
  readonly installations: InstallationByAgent;
  readonly onRefreshInstallations: () => Promise<void>;
  readonly session: TerminalSession | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    readonly title: string;
    readonly workingDirectory: string;
    readonly agentConfig: TerminalNode["agentConfig"];
    readonly launchConfig: TerminalNode["launchConfig"];
    readonly isCompazio: boolean;
  }) => void;
}) {
  const existing = state.mode === "edit" ? state.terminal : undefined;
  const availableDefinitions = definitions.filter((definition) => definition.id !== "custom");
  const initialAgentId =
    (existing?.agentConfig.agentId !== "custom" ? existing?.agentConfig.agentId : undefined) ??
    (availableDefinitions.some((definition) => definition.id === "claude-code")
      ? "claude-code"
      : (availableDefinitions[0]?.id ?? "shell"));
  const [agentId, setAgentId] = useState(initialAgentId);
  const [roleId, setRoleId] = useState(existing?.agentConfig.roleId ?? "");
  const [isCompazio, setIsCompazio] = useState(existing?.isCompazio ?? false);
  const [titleOverride, setTitleOverride] = useState(existing?.title ?? "");
  const [directory, setDirectory] = useState(
    existing?.workingDirectory ?? workspace.workingDirectory
  );
  const [directoryMode, setDirectoryMode] = useState<"inherit" | "custom">(
    existing === undefined || existing.workingDirectory === workspace.workingDirectory
      ? "inherit"
      : "custom"
  );
  const [executable, setExecutable] = useState(existing?.launchConfig.command ?? "");
  const [argumentsText, setArgumentsText] = useState(existing?.launchConfig.args.join("\n") ?? "");
  const [processMode, setProcessMode] = useState(
    existing?.launchConfig.processMode === "pty" ? "pty" : "auto"
  );
  const formElement = useRef<HTMLFormElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const installation = installations[agentId];
  const selectedDefinition = availableDefinitions.find((definition) => definition.id === agentId);
  const supportsRoles = selectedDefinition?.supportsRoles ?? false;
  const canCoordinate = ["claude-code", "codex", "opencode"].includes(agentId);
  const unavailable =
    agentId === "custom"
      ? executable.trim() === ""
      : installation === undefined || installation.status !== "installed";
  const suggestedTitle =
    roles.find((role) => role.id === roleId)?.name ?? selectedDefinition?.name ?? "Terminal";
  const title = titleOverride.trim() === "" ? suggestedTitle : titleOverride;
  useEffect(() => {
    if (installation !== undefined) return;
    void onRefreshInstallations();
  }, [installation, onRefreshInstallations]);
  useEffect(() => {
    const form = formElement.current;
    if (form === null) return;
    const focusTarget = returnFocus.current;
    form.querySelector<HTMLElement>("select, input, button")?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        returnFocus.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...form.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary"
        )
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    form.addEventListener("keydown", onKeyDown);
    return () => {
      form.removeEventListener("keydown", onKeyDown);
      focusTarget?.focus();
    };
  }, [onCancel]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (unavailable) return;
    const args = argumentsText
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    onSubmit({
      title: title.trim() || "Terminal",
      workingDirectory:
        directoryMode === "inherit"
          ? workspace.workingDirectory
          : directory.trim() || workspace.workingDirectory,
      agentConfig: { agentId, ...(roleId === "" || !supportsRoles ? {} : { roleId }) },
      launchConfig: {
        ...(executable.trim() === "" ? {} : { command: executable.trim() }),
        args,
        env: {},
        processMode
      },
      isCompazio: canCoordinate && isCompazio
    });
  };
  return (
    <div className="v2-modal-backdrop" role="presentation">
      <form
        ref={formElement}
        className="v2-modal"
        onSubmit={submit}
        aria-label="Novo terminal de agente"
        aria-modal="true"
        role="dialog"
      >
        <header>
          <h2>{state.mode === "create" ? "Novo terminal" : "Configurar terminal"}</h2>
          <button type="button" onClick={onCancel} aria-label="Fechar">
            ×
          </button>
        </header>
        <label>
          Agente
          <select
            value={agentId}
            onChange={(event) => {
              const nextAgentId = event.target.value;
              setAgentId(nextAgentId);
              if (!["claude-code", "codex", "opencode"].includes(nextAgentId)) setIsCompazio(false);
            }}
            data-testid="v2-agent-select"
          >
            {availableDefinitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name}
              </option>
            ))}
          </select>
        </label>
        <p className={unavailable ? "v2-agent-status unavailable" : "v2-agent-status"}>
          {agentInstallationMessage(installation)}
        </p>
        <label>
          Responsabilidade <small>(opcional)</small>
          <select
            value={roleId}
            disabled={!supportsRoles}
            onChange={(event) => setRoleId(event.target.value)}
            data-testid="v2-role-select"
          >
            <option value="">Nenhuma</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label className="v2-orchestrator-toggle">
          <input
            type="checkbox"
            checked={isCompazio}
            disabled={!canCoordinate}
            onChange={(event) => setIsCompazio(event.target.checked)}
            data-testid="v2-terminal-coordinator"
          />
          <span>
            <strong>Este agente coordena o time</strong>
            <small>
              Pode criar agentes visíveis, conectá-los, distribuir trabalho e encerrar somente os
              terminais que ele criou.
            </small>
          </span>
        </label>
        <label>
          Diretório
          <select
            value={directoryMode}
            onChange={(event) => setDirectoryMode(event.target.value as "inherit" | "custom")}
          >
            <option value="inherit">Herdar do workspace</option>
            <option value="custom">Escolher outro diretório</option>
          </select>
        </label>
        <details>
          <summary>Configurações avançadas</summary>
          <label>
            Nome sugerido
            <input
              value={titleOverride}
              placeholder={suggestedTitle}
              onChange={(event) => setTitleOverride(event.target.value)}
            />
          </label>
          {directoryMode === "custom" && (
            <label>
              Diretório personalizado
              <input value={directory} onChange={(event) => setDirectory(event.target.value)} />
            </label>
          )}
          <label>
            Executável (necessário para comando personalizado)
            <input value={executable} onChange={(event) => setExecutable(event.target.value)} />
          </label>
          <label>
            Argumentos (um por linha)
            <textarea
              value={argumentsText}
              onChange={(event) => setArgumentsText(event.target.value)}
            />
          </label>
          <label>
            Transporte
            <select
              value={processMode}
              onChange={(event) => setProcessMode(event.target.value as "auto" | "pty")}
            >
              <option value="auto">Auto</option>
              <option value="pty">PTY</option>
            </select>
          </label>
        </details>
        {session !== undefined && (
          <p>Salvar uma mudança reinicia este terminal após sua confirmação.</p>
        )}
        <footer>
          <button type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="v2-primary" type="submit" disabled={unavailable}>
            {state.mode === "create" ? "Criar e iniciar" : "Salvar e reiniciar"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function RoleLibrary({
  workspace,
  roles,
  onClose,
  onChanged,
  onError
}: {
  readonly workspace: Workspace;
  readonly roles: readonly AgentRole[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{
    readonly role?: AgentRole;
    readonly name: string;
    readonly instructions: string;
  } | null>(null);
  const visible = roles.filter((role) =>
    `${role.name} ${role.description ?? ""}`.toLowerCase().includes(query.toLowerCase())
  );
  const run = (operation: () => Promise<void>): void => {
    void operation().then(onChanged).catch(toMessage(onError));
  };
  const create = (): void => {
    setDraft({ name: "", instructions: "Respeite o escopo solicitado." });
  };
  const discover = (): void => {
    run(async () => {
      const found = await window.compazioV2.roles.discover({ workspaceId: workspace.id });
      if (found.length === 0) {
        onError("Nenhuma responsabilidade portátil foi encontrada em .compazio/roles.");
        return;
      }
      await window.compazioV2.roles.import({
        workspaceId: workspace.id,
        roleIds: found.map((role) => role.id)
      });
    });
  };
  const saveDraft = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === null || draft.name.trim() === "" || draft.instructions.trim() === "") return;
    run(async () => {
      if (draft.role === undefined) {
        await window.compazioV2.roles.create({
          name: draft.name.trim(),
          instructions: draft.instructions.trim()
        });
      } else {
        await window.compazioV2.roles.update({
          ...draft.role,
          name: draft.name.trim(),
          instructions: draft.instructions.trim()
        });
      }
      setDraft(null);
    });
  };
  return (
    <div className="v2-modal-backdrop" role="presentation">
      <section className="v2-modal v2-role-library" aria-label="Biblioteca de responsabilidades">
        <header>
          <h2>Responsabilidades</h2>
          <button onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </header>
        <div className="v2-library-actions">
          <input
            placeholder="Buscar"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button onClick={create}>Criar</button>
          <button onClick={discover}>Descobrir no projeto</button>
        </div>
        {draft !== null && (
          <form className="v2-role-editor" onSubmit={saveDraft}>
            <label>
              Nome
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              Instruções
              <textarea
                value={draft.instructions}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              />
            </label>
            <div>
              <button type="button" onClick={() => setDraft(null)}>
                Cancelar
              </button>
              <button className="v2-primary" type="submit">
                Salvar
              </button>
            </div>
          </form>
        )}
        <div className="v2-role-list">
          {visible.map((role) => (
            <article key={role.id}>
              <strong>{role.name}</strong>
              <small>
                {role.source} · {role.scope}
              </small>
              <p>{role.description ?? role.instructions.slice(0, 140)}</p>
              <div>
                <button
                  onClick={() => run(() => window.compazioV2.roles.duplicate({ roleId: role.id }))}
                >
                  Duplicar
                </button>
                <button
                  disabled={role.source === "built-in"}
                  onClick={() =>
                    setDraft({
                      role,
                      name: role.name,
                      instructions: role.instructions
                    })
                  }
                >
                  Editar
                </button>
                <button
                  disabled={role.source === "built-in"}
                  onClick={() => run(() => window.compazioV2.roles.delete({ roleId: role.id }))}
                >
                  Excluir
                </button>
                <button
                  onClick={() =>
                    run(() =>
                      window.compazioV2.roles.export({
                        workspaceId: workspace.id,
                        roleIds: [role.id]
                      })
                    )
                  }
                >
                  Exportar
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ShortcutGuide({ onClose }: { readonly onClose: () => void }) {
  const rows: readonly [string, string][] = [
    ["Ctrl/Cmd + A", "Selecionar todos os canvases"],
    ["Ctrl/Cmd + clique ou arrasto", "Adicionar à seleção"],
    ["Delete", "Excluir seleção ou conexão"],
    ["Ctrl/Cmd + C / V", "Copiar e colar canvases entre workspaces"],
    ["Ctrl/Cmd + Z / Y", "Desfazer / refazer"],
    ["Ctrl/Cmd + 0 / 1", "Zoom padrão / enquadrar tudo"],
    ["Ctrl/Cmd + Shift + X", "Cortar conexões"],
    ["Ctrl/Cmd + Shift + T / N / E", "Terminal / nota / arquivos"],
    ["Espaço ou botão do meio", "Mover o canvas"],
    ["Ctrl/Cmd + A no terminal", "Entregue ao editor do agente"]
  ];
  return (
    <div className="v2-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="v2-modal v2-shortcut-guide"
        role="dialog"
        aria-modal="true"
        aria-label="Atalhos do Compazio"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Atalhos</h2>
          <button onClick={onClose} aria-label="Fechar atalhos">
            ×
          </button>
        </header>
        <p>Atalhos universais para navegar, organizar e reutilizar seu workflow.</p>
        <dl>
          {rows.map(([keys, description]) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function nextFileAccess(
  current: Workspace["permissions"]["fileAccess"]
): Workspace["permissions"]["fileAccess"] {
  const values: readonly Workspace["permissions"]["fileAccess"][] = [
    "ask",
    "workspace-read",
    "workspace-read-write"
  ];
  return values[(values.indexOf(current) + 1) % values.length] ?? "ask";
}

/** Electron does not implement window.prompt; this compact action cycles the three safe policies. */
function chooseFileAccess(
  _label: string,
  current: Workspace["permissions"]["fileAccess"]
): Workspace["permissions"]["fileAccess"] {
  return nextFileAccess(current);
}

function toMessage(onError: (message: string) => void) {
  return (error: unknown): void =>
    onError(error instanceof Error ? error.message : "A operação não pôde ser concluída.");
}

function agentInstallationMessage(installation: AgentInstallation | undefined): string {
  if (installation === undefined) return "Verificando instalação…";
  if (installation.status === "unknown") return "Informe um executável para este comando.";
  if (installation.status === "installed")
    return `Instalado${installation.version === undefined ? "" : ` — ${installation.version}`}`;
  if (installation.status === "not-authenticated") return "Instalado, autenticação necessária.";
  if (installation.status === "not-installed") return "Indisponível: executável não encontrado.";
  if (installation.status === "invalid") return "Executável inválido ou healthcheck falhou.";
  if (installation.status === "timed-out") return "Healthcheck excedeu o tempo limite.";
  if (installation.status === "permission-denied") return "Executável sem permissão.";
  return "Agente indisponível.";
}
