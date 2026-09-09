import { existsSync } from "node:fs";
import { join } from "node:path";

import { WebContentsView, nativeImage, session } from "electron";
import type { BrowserWindow, DownloadItem, Session, WebContents } from "electron";
import type { PortalNode, Workspace } from "@forgedeck/compazio-v2-domain";

import {
  NativeSurfaceCoordinator,
  type NativeSurfaceDecision,
  type NativeSurfaceWindowState
} from "./native-surface-coordinator";
import {
  PortalConsoleBuffer,
  type PortalConsoleQuery,
  type PortalConsoleQueryResult
} from "./portal-console-buffer";
import {
  downloadExtension,
  resolveDownloadDestination,
  sanitizeDownloadFilename,
  sanitizeDownloadOrigin,
  sanitizeDownloadUrl,
  suggestDownloadDestination,
  type PortalDownloadDecision,
  type PortalDownloadOffer
} from "./portal-downloads";
import {
  PortalError,
  PortalOperationRegistry,
  type PortalCancelReason,
  type PortalOperationContext,
  type PortalOperationSnapshot
} from "./portal-operations";
import {
  buildPortalPageScript,
  resolvePortalPageLimits,
  type PortalPageAction,
  type PortalPageLimits,
  type PortalPageRequest,
  type PortalPageResponse
} from "./portal-page-script";
import {
  PortalRecoveryPolicy,
  describePortalFailure,
  type PortalFailureKind
} from "./portal-recovery";
import { PortalScreenshotStore, type PortalScreenshotReference } from "./portal-screenshots";
import { diffRevokedPortalControl } from "./portal-authorization";

export type PortalRuntimeState =
  "creating" | "loading" | "ready" | "failed" | "crashed" | "destroying" | "destroyed";

export interface PortalBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  /** Escala do canvas no momento da medição; 1 quando o canvas está em 100%. */
  readonly canvasZoom?: number;
}

export interface PortalRuntimeSnapshot {
  readonly workspaceId: string;
  readonly portalId: string;
  readonly title: string;
  readonly url: string;
  readonly state: PortalRuntimeState;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly focused: boolean;
  readonly sessionMode: PortalNode["sessionMode"];
  readonly partition: string;
  readonly failure: {
    readonly reason: string;
    readonly hint: string;
    readonly lastUrl: string;
  } | null;
  readonly recovery: { readonly attempts: number; readonly exhausted: boolean };
  readonly visible: boolean;
  /** What the surface coordinator decided: the canvas can prove a Portal is really covered. */
  readonly surface: {
    readonly attached: boolean;
    readonly visible: boolean;
    readonly reason: string;
  };
}

export interface PortalOperationOptions {
  readonly terminalNodeId?: string;
  readonly timeoutMs?: number;
  readonly correlationId?: string;
}

export interface PortalAutomationInput {
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly text?: string;
  readonly selector?: string;
  readonly coordinates?: { readonly x: number; readonly y: number };
  readonly exact?: boolean;
  readonly index?: number;
  readonly clear?: boolean;
  readonly key?: string;
  readonly modifiers?: readonly ("shift" | "control" | "alt" | "meta")[];
  readonly direction?: "up" | "down" | "left" | "right";
  readonly amount?: number;
  readonly query?: string;
  readonly filter?: { readonly role?: string; readonly name?: string };
  readonly includeBounds?: boolean;
  readonly limits?: Partial<PortalPageLimits>;
}

export interface PortalRuntimeManagerOptions {
  readonly getWindow: () => BrowserWindow | null;
  readonly tempDirectory: string;
  readonly downloadDirectory: string;
  readonly persist: (
    workspaceId: string,
    portalId: string,
    patch: {
      readonly url?: string;
      readonly lastKnownState?: PortalNode["lastKnownState"];
      readonly zoomFactor?: number;
    }
  ) => Promise<void>;
  readonly onEvent?: (type: string, metadata: Readonly<Record<string, unknown>>) => void;
  /**
   * Asks a person what to do with a download. Without an answer the bytes are never written, which
   * is the difference between a browser inside the canvas and a silent file drop.
   */
  readonly requestDownloadDecision?: (
    offer: PortalDownloadOffer
  ) => Promise<PortalDownloadDecision>;
  /** Publishes the offer to the renderer, which answers through `settleDownload`. */
  readonly askDownload?: (offer: PortalDownloadOffer) => void;
  readonly downloadDecisionTimeoutMs?: number;
  readonly operations?: PortalOperationRegistry;
  readonly surfaces?: NativeSurfaceCoordinator;
  readonly recovery?: PortalRecoveryPolicy;
  readonly screenshots?: PortalScreenshotStore;
  /** Enables deterministic failure injection; only the local test harness turns it on. */
  readonly testHooks?: boolean;
}

interface PortalRuntime {
  readonly workspaceId: string;
  readonly portalId: string;
  node: PortalNode;
  view: WebContentsView;
  webContents: WebContents;
  readonly session: Session;
  readonly partition: string;
  listeners: (() => void)[];
  readonly console: PortalConsoleBuffer;
  bounds: PortalBounds;
  state: PortalRuntimeState;
  failure: { reason: string; hint: string; lastUrl: string } | null;
  focused: boolean;
  lastBoundsAt: number;
  emulatedViewport?: { readonly width: number; readonly height: number };
  destroyed: boolean;
}

const automationActions = [
  "click",
  "type",
  "press",
  "scroll",
  "dom",
  "accessibility",
  "get",
  "focus",
  "viewport"
] as const;

export type PortalAutomationAction = (typeof automationActions)[number];

/**
 * The sole owner of remote WebContents. The renderer receives no Session, WebContents or generic
 * automation capability; it can only request validated operations through typed IPC, and every one
 * of them is cancellable, bounded in time and answered with plain data.
 */
export class PortalRuntimeManager {
  private readonly portals = new Map<string, PortalRuntime>();
  private readonly configuredPartitions = new Set<string>();
  private readonly pendingDownloads = new Map<string, { destination: string; portalKey: string }>();
  private readonly downloadDecisions = new Map<
    string,
    (decision: PortalDownloadDecision) => void
  >();
  private readonly operations: PortalOperationRegistry;
  private readonly surfaces: NativeSurfaceCoordinator;
  private readonly recovery: PortalRecoveryPolicy;
  private readonly screenshots: PortalScreenshotStore;
  private readonly releaseSurfaces: () => void;
  private listenerCount = 0;
  private shuttingDown = false;

  public constructor(private readonly options: PortalRuntimeManagerOptions) {
    this.operations =
      options.operations ??
      new PortalOperationRegistry({
        onEvent: (type, metadata) => this.emit(type, metadata)
      });
    this.surfaces = options.surfaces ?? new NativeSurfaceCoordinator();
    this.recovery = options.recovery ?? new PortalRecoveryPolicy();
    this.screenshots =
      options.screenshots ?? new PortalScreenshotStore({ directory: options.tempDirectory });
    this.releaseSurfaces = this.surfaces.subscribe((decisions) => this.applyDecisions(decisions));
  }

  // ---------------------------------------------------------------- lifecycle

  public async ensure(workspaceId: string, node: PortalNode): Promise<PortalRuntimeSnapshot> {
    const key = this.key(workspaceId, node.id);
    const existing = this.portals.get(key);
    if (existing !== undefined && !existing.destroyed) {
      // A renderer reload replays every node: refreshing the description must not build a second View.
      existing.node = node;
      return this.snapshot(existing);
    }
    const partition = this.partition(workspaceId, node);
    const portalSession = session.fromPartition(partition);
    this.configureSession(portalSession, partition);
    const view = this.createView(partition);
    const runtime: PortalRuntime = {
      workspaceId,
      portalId: node.id,
      node,
      view,
      webContents: view.webContents,
      session: portalSession,
      partition,
      listeners: [],
      console: new PortalConsoleBuffer(),
      bounds: {
        x: node.position.x,
        y: node.position.y,
        width: node.size.width,
        height: node.size.height,
        visible: false
      },
      state: "creating",
      failure: null,
      focused: false,
      lastBoundsAt: Date.now(),
      destroyed: false
    };
    this.portals.set(key, runtime);
    this.attachListeners(runtime);
    this.surfaces.track({
      surfaceId: key,
      workspaceId,
      nodeVisible: false,
      bounds: runtime.bounds
    });
    this.applyNodePreferences(runtime);
    this.emit("portal.created", { workspaceId, portalId: node.id, partition });
    if (node.url !== "about:blank")
      await this.navigate(workspaceId, node.id, node.url).catch(() => undefined);
    else runtime.state = "ready";
    return this.snapshot(runtime);
  }

  public async destroy(workspaceId: string, portalId: string): Promise<void> {
    const key = this.key(workspaceId, portalId);
    const runtime = this.portals.get(key);
    // Deleting twice is a normal race between the canvas and an agent, not an error.
    if (runtime === undefined) return;
    runtime.state = "destroying";
    this.operations.cancelPortal(workspaceId, portalId, "portal-deleted");
    this.teardown(runtime);
    this.portals.delete(key);
    this.surfaces.untrack(key);
    this.recovery.forget(key);
    runtime.console.clear();
    await this.screenshots.removePortal(workspaceId, portalId);
    runtime.state = "destroyed";
    runtime.destroyed = true;
    this.emit("portal.destroyed", { workspaceId, portalId });
  }

  public async destroyWorkspace(workspaceId: string): Promise<void> {
    this.operations.cancelWorkspace(workspaceId, "workspace-closed");
    for (const runtime of [...this.portals.values()].filter(
      (item) => item.workspaceId === workspaceId
    ))
      await this.destroy(workspaceId, runtime.portalId);
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.operations.cancelAll("application-closing");
    for (const runtime of [...this.portals.values()])
      await this.destroy(runtime.workspaceId, runtime.portalId);
    this.releaseSurfaces();
    await this.screenshots.clear();
  }

  // ------------------------------------------------------------- native layer

  public setWindowState(patch: Partial<NativeSurfaceWindowState>): void {
    const previous = this.surfaces.windowState().activeWorkspaceId;
    this.surfaces.setWindowState(patch);
    const next = this.surfaces.windowState().activeWorkspaceId;
    if (patch.activeWorkspaceId !== undefined && previous !== null && previous !== next) {
      this.operations.cancelWorkspace(previous, "workspace-switched");
      for (const runtime of this.portals.values())
        if (runtime.workspaceId === previous) runtime.focused = false;
    }
  }

  public setBounds(workspaceId: string, portalId: string, bounds: PortalBounds): void {
    const runtime = this.portals.get(this.key(workspaceId, portalId));
    if (runtime === undefined) return;
    runtime.bounds = bounds;
    runtime.lastBoundsAt = Date.now();
    // A página acompanha a escala do canvas: sem isso um Portal em 50% mostra conteúdo em tamanho
    // real dentro de um card pela metade, e a superfície nativa parece escapar do nó.
    const canvasZoom = bounds.canvasZoom ?? 1;
    const desiredZoom = runtime.node.zoomFactor * canvasZoom;
    if (
      !runtime.webContents.isDestroyed() &&
      Math.abs(runtime.webContents.getZoomFactor() - desiredZoom) > 0.01
    ) {
      runtime.webContents.setZoomFactor(desiredZoom);
    }
    this.surfaces.track({
      surfaceId: this.key(workspaceId, portalId),
      workspaceId,
      nodeVisible: bounds.visible,
      bounds
    });
  }

  public surfaceCoordinator(): NativeSurfaceCoordinator {
    return this.surfaces;
  }

  // ------------------------------------------------------------------ control

  public async navigate(
    workspaceId: string,
    portalId: string,
    url: string,
    options: PortalOperationOptions = {}
  ): Promise<PortalRuntimeSnapshot> {
    if (!isAllowedPortalUrl(url))
      throw new PortalError("PORTAL_PROTOCOL_BLOCKED", "A URL do Portal não é permitida.", { url });
    return this.run(workspaceId, portalId, "navigate", options, async (runtime, context) => {
      runtime.state = "loading";
      runtime.failure = null;
      const load = runtime.webContents.loadURL(url);
      await abortable(load, context.signal);
      runtime.state = "ready";
      this.recovery.recordSuccess(this.key(workspaceId, portalId));
      await this.persistState(runtime);
      return this.snapshot(runtime);
    });
  }

  public async command(
    workspaceId: string,
    portalId: string,
    action: "back" | "forward" | "reload" | "stop" | "focus" | "blur",
    options: PortalOperationOptions = {}
  ): Promise<PortalRuntimeSnapshot> {
    return this.run(workspaceId, portalId, action, options, async (runtime) => {
      const history = runtime.webContents.navigationHistory;
      if (action === "back" && history.canGoBack()) history.goBack();
      if (action === "forward" && history.canGoForward()) history.goForward();
      if (action === "reload") runtime.webContents.reload();
      if (action === "stop") runtime.webContents.stop();
      if (action === "focus") this.focusRuntime(runtime);
      if (action === "blur") this.blurRuntime(runtime);
      if (action === "back" || action === "forward" || action === "reload")
        await waitForIdle(runtime.webContents);
      await this.persistState(runtime);
      return this.snapshot(runtime);
    });
  }

  public async automation(
    workspaceId: string,
    portalId: string,
    action: PortalAutomationAction,
    input: PortalAutomationInput = {},
    options: PortalOperationOptions = {}
  ): Promise<unknown> {
    if (!automationActions.includes(action))
      throw new PortalError("PORTAL_EVALUATE_DENIED", "Ação de automação não suportada.", {
        action
      });
    return this.run(workspaceId, portalId, action, options, async (runtime, context) => {
      const request: PortalPageRequest = {
        action: action as PortalPageAction,
        limits: resolvePortalPageLimits(input.limits),
        ...(input.clear === undefined ? {} : { clear: input.clear }),
        ...(input.text === undefined || action === "click" ? {} : { text: input.text }),
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.filter === undefined ? {} : { filter: input.filter }),
        ...(input.includeBounds === undefined ? {} : { includeBounds: input.includeBounds }),
        ...(hasLocator(input) ? { locator: locatorOf(input) } : {})
      };
      const raw = await abortable(
        runtime.webContents.executeJavaScript(buildPortalPageScript(request), true),
        context.signal
      );
      const response = raw as PortalPageResponse;
      if (response === null || typeof response !== "object" || !("ok" in response))
        throw new PortalError("PORTAL_OPERATION_FAILED", "A página respondeu de forma inesperada.");
      if (!response.ok)
        throw new PortalError(
          asPortalErrorCode(response.code),
          response.message,
          response.details ?? {}
        );
      return response.data;
    });
  }

  /**
   * Applies a browser-level viewport instead of resizing the canvas card. This keeps the visual
   * layout stable while allowing an authorized reviewer to verify deterministic desktop/mobile
   * breakpoints. The override also gives Page.captureScreenshot a compositor-independent surface.
   */
  public async setViewport(
    workspaceId: string,
    portalId: string,
    viewport: { readonly width: number; readonly height: number },
    options: PortalOperationOptions = {}
  ): Promise<unknown> {
    return this.run(workspaceId, portalId, "viewport", options, async (runtime, context) => {
      await applyEmulatedViewport(runtime.webContents, viewport, context.signal);
      runtime.emulatedViewport = viewport;
      return this.readViewport(runtime, context.signal);
    });
  }

  public async screenshot(
    workspaceId: string,
    portalId: string,
    options: PortalOperationOptions = {}
  ): Promise<PortalScreenshotReference> {
    return this.run(workspaceId, portalId, "screenshot", options, async (runtime, context) => {
      const image =
        runtime.emulatedViewport === undefined
          ? await capturePageWithRetry(
              runtime.webContents,
              context.signal,
              context.remainingMs,
              (attempt, error) =>
                this.emit("portal.screenshot.retry", {
                  workspaceId,
                  portalId,
                  correlationId: context.correlationId,
                  attempt,
                  error: describeScreenshotError(error),
                  ...this.captureDiagnostics(runtime)
                })
            )
          : nativeImage.createFromBuffer(
              await captureEmulatedViewport(
                runtime.webContents,
                runtime.emulatedViewport,
                context.signal
              )
            );
      if (image.isEmpty())
        throw new PortalError("PORTAL_OPERATION_FAILED", "A captura do Portal ficou vazia.");
      const reference = await this.screenshots.save(workspaceId, portalId, image);
      this.emit("portal.screenshot.created", {
        workspaceId,
        portalId,
        screenshotId: reference.id,
        bytes: reference.bytes
      });
      return reference;
    });
  }

  public consoleMessages(
    workspaceId: string,
    portalId: string,
    query: PortalConsoleQuery = {}
  ): PortalConsoleQueryResult {
    return this.require(workspaceId, portalId).console.query(query);
  }

  public cancel(correlationId: string): boolean {
    return this.operations.cancel(correlationId, "user-cancelled");
  }

  public cancelPortal(workspaceId: string, portalId: string, reason: PortalCancelReason): number {
    return this.operations.cancelPortal(workspaceId, portalId, reason);
  }

  public pendingOperations(): readonly PortalOperationSnapshot[] {
    return this.operations.pending();
  }

  // -------------------------------------------------------------------- focus

  public focus(workspaceId: string, portalId: string): void {
    this.focusRuntime(this.require(workspaceId, portalId));
  }

  public blur(workspaceId: string, portalId: string): void {
    const runtime = this.portals.get(this.key(workspaceId, portalId));
    if (runtime !== undefined) this.blurRuntime(runtime);
  }

  /** "Resetar Foco" must reach native surfaces too, otherwise the canvas keeps losing the keyboard. */
  public resetFocus(workspaceId?: string): number {
    let released = 0;
    for (const runtime of this.portals.values()) {
      if (workspaceId !== undefined && runtime.workspaceId !== workspaceId) continue;
      if (!runtime.focused) continue;
      this.blurRuntime(runtime);
      released += 1;
    }
    const window = this.options.getWindow();
    if (window !== null && !window.isDestroyed()) window.webContents.focus();
    return released;
  }

  public focusedPortals(): readonly string[] {
    return [...this.portals.values()]
      .filter((runtime) => runtime.focused)
      .map((runtime) => runtime.portalId);
  }

  // ----------------------------------------------------------------- recovery

  public async recover(
    workspaceId: string,
    portalId: string,
    mode: "reload" | "recreate"
  ): Promise<PortalRuntimeSnapshot> {
    const key = this.key(workspaceId, portalId);
    const runtime = this.portals.get(key);
    if (runtime === undefined)
      throw new PortalError("PORTAL_NOT_FOUND", "Portal não está carregado.", { portalId });
    this.recovery.reset(key);
    return mode === "reload"
      ? this.reloadRuntime(runtime, "manual")
      : this.recreateRuntime(runtime, "manual");
  }

  /** Deterministic failure injection for the local harness; never reachable in a normal session. */
  public simulateFailure(workspaceId: string, portalId: string, kind: PortalFailureKind): void {
    if (this.options.testHooks !== true)
      throw new PortalError("PORTAL_EVALUATE_DENIED", "Simulação indisponível.");
    const runtime = this.require(workspaceId, portalId);
    this.handleFailure(runtime, kind, {});
  }

  // ------------------------------------------------------------- canvas state

  /**
   * Called whenever a workspace changes. Removing a connection, a terminal or the Portal itself all
   * revoke control, and anything already in flight for that pair is cancelled instead of finishing.
   */
  public onWorkspaceChanged(previous: Workspace | null, next: Workspace): void {
    if (previous !== null)
      for (const grant of diffRevokedPortalControl(previous, next))
        this.operations.cancelGrant(
          next.id,
          grant.terminalNodeId,
          grant.portalId,
          "connection-revoked"
        );
    const portalIds = new Set(
      next.nodes.filter((node) => node.type === "portal").map((node) => node.id)
    );
    for (const runtime of [...this.portals.values()])
      if (runtime.workspaceId === next.id && !portalIds.has(runtime.portalId))
        void this.destroy(next.id, runtime.portalId);
  }

  public list(workspaceId?: string): readonly PortalRuntimeSnapshot[] {
    return [...this.portals.values()]
      .filter((runtime) => workspaceId === undefined || runtime.workspaceId === workspaceId)
      .map((runtime) => this.snapshot(runtime));
  }

  public get(workspaceId: string, portalId: string): PortalRuntimeSnapshot {
    return this.snapshot(this.require(workspaceId, portalId));
  }

  public diagnostics(): {
    readonly views: number;
    readonly webContents: number;
    readonly listeners: number;
    readonly pendingOperations: number;
    readonly screenshots: number;
    readonly consoleEntries: number;
    readonly sessions: number;
    readonly attachedViews: number;
    readonly focusedPortals: number;
  } {
    const window = this.options.getWindow();
    const attached =
      window === null || window.isDestroyed()
        ? 0
        : window.contentView.children.filter((child) =>
            [...this.portals.values()].some((runtime) => runtime.view === child)
          ).length;
    return {
      views: this.portals.size,
      webContents: [...this.portals.values()].filter(
        (runtime) => !runtime.webContents.isDestroyed()
      ).length,
      listeners: this.listenerCount,
      pendingOperations: this.operations.pendingCount(),
      screenshots: this.screenshots.count(),
      consoleEntries: [...this.portals.values()].reduce(
        (total, runtime) => total + runtime.console.size(),
        0
      ),
      sessions: this.configuredPartitions.size,
      attachedViews: attached,
      focusedPortals: this.focusedPortals().length
    };
  }

  public async screenshotOrphans(): Promise<readonly string[]> {
    return this.screenshots.orphans();
  }

  // ------------------------------------------------------------------ private

  private createView(partition: string): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        nodeIntegrationInSubFrames: false,
        spellcheck: false
      }
    });
  }

  private attachListeners(runtime: PortalRuntime): void {
    const webContents = runtime.webContents;
    const listeners: (() => void)[] = [];
    const bind = (event: string, listener: (...args: never[]) => void): void => {
      const typed = webContents as unknown as {
        on(name: string, handler: (...args: never[]) => void): void;
        removeListener(name: string, handler: (...args: never[]) => void): void;
      };
      typed.on(event, listener);
      this.listenerCount += 1;
      listeners.push(() => {
        typed.removeListener(event, listener);
        this.listenerCount -= 1;
      });
    };
    bind("will-navigate", ((event: Electron.Event, url: string) => {
      if (isAllowedPortalUrl(url)) return;
      event.preventDefault();
      this.emit("portal.navigation.blocked", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        url: sanitizeDownloadUrl(url)
      });
    }) as (...args: never[]) => void);
    bind("did-start-loading", (() => {
      runtime.state = "loading";
      this.emit("portal.navigation.started", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId
      });
    }) as (...args: never[]) => void);
    bind("did-stop-loading", (() => {
      if (runtime.state === "loading") runtime.state = "ready";
      void this.persistState(runtime);
      this.emit("portal.navigation.completed", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId
      });
    }) as (...args: never[]) => void);
    bind("did-fail-load", ((
      _event: Electron.Event,
      errorCode: number,
      description: string,
      _url: string,
      isMainFrame: boolean
    ) => {
      // Aborted subframe loads are noise; only a failed main frame is a Portal failure.
      if (!isMainFrame || errorCode === -3) return;
      this.handleFailure(runtime, "did-fail-load", { description, errorCode });
    }) as (...args: never[]) => void);
    bind("render-process-gone", (() => {
      this.handleFailure(runtime, "render-process-gone", {});
    }) as (...args: never[]) => void);
    bind("unresponsive", (() => {
      this.handleFailure(runtime, "unresponsive", {});
    }) as (...args: never[]) => void);
    bind("destroyed", (() => {
      if (runtime.state === "destroying" || runtime.destroyed) return;
      this.handleFailure(runtime, "destroyed", {});
    }) as (...args: never[]) => void);
    bind(
      "page-title-updated",
      (() => void this.persistState(runtime)) as (...args: never[]) => void
    );
    bind("console-message", ((details: {
      readonly message?: string;
      readonly level?: unknown;
      readonly lineNumber?: number;
      readonly sourceId?: string;
    }) => {
      runtime.console.record({
        level: details.level,
        message: String(details.message ?? ""),
        source: details.sourceId ?? "",
        line: details.lineNumber ?? 0
      });
    }) as (...args: never[]) => void);
    bind("focus", (() => {
      runtime.focused = true;
    }) as (...args: never[]) => void);
    bind("blur", (() => {
      runtime.focused = false;
    }) as (...args: never[]) => void);
    webContents.setWindowOpenHandler((details) => {
      this.emit("portal.popup.blocked", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        url: sanitizeDownloadUrl(details.url)
      });
      return { action: "deny" };
    });
    runtime.listeners = listeners;
  }

  private teardown(runtime: PortalRuntime): void {
    this.detach(runtime);
    for (const dispose of runtime.listeners) dispose();
    runtime.listeners = [];
    if (!runtime.webContents.isDestroyed() && runtime.webContents.debugger.isAttached())
      runtime.webContents.debugger.detach();
    if (!runtime.webContents.isDestroyed()) runtime.webContents.close();
  }

  private applyNodePreferences(runtime: PortalRuntime): void {
    if (runtime.node.userAgentOverride !== undefined)
      runtime.webContents.setUserAgent(runtime.node.userAgentOverride);
    runtime.webContents.setZoomFactor(runtime.node.zoomFactor);
    runtime.webContents.setAudioMuted(false);
  }

  private applyDecisions(decisions: readonly NativeSurfaceDecision[]): void {
    for (const decision of decisions) {
      const runtime = this.portals.get(decision.surfaceId);
      if (runtime === undefined || runtime.destroyed) continue;
      if (!decision.attached) {
        this.detach(runtime);
        if (runtime.focused) this.blurRuntime(runtime);
        continue;
      }
      this.attach(runtime);
      if (!decision.visible) {
        runtime.view.setVisible(false);
        if (runtime.focused) this.blurRuntime(runtime);
        continue;
      }
      runtime.view.setBounds(decision.bounds);
      runtime.view.setVisible(true);
    }
  }

  private attach(runtime: PortalRuntime): void {
    const host = this.options.getWindow();
    if (host === null || host.isDestroyed()) return;
    if (host.contentView.children.includes(runtime.view)) return;
    host.contentView.addChildView(runtime.view);
  }

  private detach(runtime: PortalRuntime): void {
    const host = this.options.getWindow();
    if (host === null || host.isDestroyed()) return;
    if (!host.contentView.children.includes(runtime.view)) return;
    host.contentView.removeChildView(runtime.view);
  }

  private focusRuntime(runtime: PortalRuntime): void {
    if (runtime.webContents.isDestroyed()) return;
    runtime.webContents.focus();
    runtime.focused = true;
    this.emit("portal.focus.gained", {
      workspaceId: runtime.workspaceId,
      portalId: runtime.portalId
    });
  }

  private blurRuntime(runtime: PortalRuntime): void {
    runtime.focused = false;
    const window = this.options.getWindow();
    if (window !== null && !window.isDestroyed()) window.webContents.focus();
    this.emit("portal.focus.released", {
      workspaceId: runtime.workspaceId,
      portalId: runtime.portalId
    });
  }

  private handleFailure(
    runtime: PortalRuntime,
    kind: PortalFailureKind,
    details: { readonly description?: string; readonly errorCode?: number }
  ): void {
    const key = this.key(runtime.workspaceId, runtime.portalId);
    const description = describePortalFailure(kind, details);
    runtime.state = kind === "did-fail-load" ? "failed" : "crashed";
    runtime.failure = {
      reason: description.reason,
      hint: description.hint,
      lastUrl: sanitizeDownloadUrl(runtime.node.url)
    };
    this.recovery.recordFailure(key, kind);
    this.operations.cancelPortal(runtime.workspaceId, runtime.portalId, "portal-crashed");
    this.emit("portal.crashed", {
      workspaceId: runtime.workspaceId,
      portalId: runtime.portalId,
      kind,
      reason: description.reason,
      lastUrl: runtime.failure.lastUrl
    });
    void this.persistState(runtime);
    if (kind === "did-fail-load") return;
    const evaluation = this.recovery.evaluate(key);
    if (!evaluation.allowed) {
      this.emit("portal.recovery.failed", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        reason: evaluation.reason,
        attempts: evaluation.attempt
      });
      return;
    }
    void this.recreateRuntime(runtime, "automatic").catch(() => undefined);
  }

  private async reloadRuntime(
    runtime: PortalRuntime,
    trigger: "manual" | "automatic"
  ): Promise<PortalRuntimeSnapshot> {
    const key = this.key(runtime.workspaceId, runtime.portalId);
    this.recovery.recordAttempt(key);
    this.emit("portal.recovery.started", {
      workspaceId: runtime.workspaceId,
      portalId: runtime.portalId,
      trigger,
      mode: "reload"
    });
    try {
      runtime.webContents.reload();
      await waitForIdle(runtime.webContents);
      runtime.state = "ready";
      runtime.failure = null;
      this.recovery.recordSuccess(key);
      this.emit("portal.recovery.completed", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        mode: "reload"
      });
      return this.snapshot(runtime);
    } catch (error) {
      this.emit("portal.recovery.failed", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        mode: "reload",
        reason: error instanceof Error ? error.message : "desconhecido"
      });
      throw new PortalError("PORTAL_RECOVERY_FAILED", "Não foi possível recarregar o Portal.");
    }
  }

  /**
   * Rebuilds the native surface while the canvas node stays exactly where it was: same id, position,
   * size, connections and settings. Old listeners and the old View are disposed first, so recovery
   * cannot leave a second WebContents alive behind the visible one.
   */
  private async recreateRuntime(
    runtime: PortalRuntime,
    trigger: "manual" | "automatic"
  ): Promise<PortalRuntimeSnapshot> {
    const key = this.key(runtime.workspaceId, runtime.portalId);
    this.recovery.recordAttempt(key);
    this.operations.cancelPortal(runtime.workspaceId, runtime.portalId, "runtime-recreated");
    this.emit("portal.recovery.started", {
      workspaceId: runtime.workspaceId,
      portalId: runtime.portalId,
      trigger,
      mode: "recreate"
    });
    this.teardown(runtime);
    const view = this.createView(runtime.partition);
    runtime.view = view;
    runtime.webContents = view.webContents;
    runtime.focused = false;
    runtime.state = "creating";
    this.attachListeners(runtime);
    this.applyNodePreferences(runtime);
    this.surfaces.track({
      surfaceId: key,
      workspaceId: runtime.workspaceId,
      nodeVisible: runtime.bounds.visible,
      bounds: runtime.bounds
    });
    const target = runtime.failure?.lastUrl ?? runtime.node.url;
    try {
      if (isAllowedPortalUrl(runtime.node.url)) await runtime.webContents.loadURL(runtime.node.url);
      if (runtime.emulatedViewport !== undefined)
        await applyEmulatedViewport(
          runtime.webContents,
          runtime.emulatedViewport,
          new AbortController().signal
        );
      runtime.state = "ready";
      runtime.failure = null;
      this.recovery.recordSuccess(key);
      await this.persistState(runtime);
      this.emit("portal.recovery.completed", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        mode: "recreate",
        url: sanitizeDownloadUrl(target)
      });
      return this.snapshot(runtime);
    } catch (error) {
      runtime.state = "failed";
      this.emit("portal.recovery.failed", {
        workspaceId: runtime.workspaceId,
        portalId: runtime.portalId,
        mode: "recreate",
        reason: error instanceof Error ? error.message : "desconhecido"
      });
      throw new PortalError(
        "PORTAL_RECOVERY_FAILED",
        "Não foi possível recriar o runtime do Portal."
      );
    }
  }

  private async readViewport(runtime: PortalRuntime, signal: AbortSignal): Promise<unknown> {
    const request: PortalPageRequest = {
      action: "viewport",
      limits: resolvePortalPageLimits(undefined)
    };
    const raw = await abortable(
      runtime.webContents.executeJavaScript(buildPortalPageScript(request), true),
      signal
    );
    const response = raw as PortalPageResponse;
    if (response === null || typeof response !== "object" || !("ok" in response) || !response.ok)
      throw new PortalError(
        "PORTAL_OPERATION_FAILED",
        response !== null && typeof response === "object" && "message" in response
          ? String(response.message)
          : "A pÃ¡gina respondeu de forma inesperada."
      );
    return response.data;
  }

  private configureSession(portalSession: Session, partition: string): void {
    if (this.configuredPartitions.has(partition)) return;
    this.configuredPartitions.add(partition);
    portalSession.setPermissionRequestHandler((_contents, permission, callback) => {
      this.emit("portal.permission.blocked", { permission, partition });
      callback(false);
    });
    portalSession.setPermissionCheckHandler(() => false);
    portalSession.setDisplayMediaRequestHandler(() => undefined, { useSystemPicker: false });
    portalSession.on("will-download", (event, item, webContents) => {
      void this.handleDownload(event, item, webContents);
    });
  }

  private async handleDownload(
    event: Electron.Event,
    item: DownloadItem,
    webContents: WebContents
  ): Promise<void> {
    const url = item.getURL();
    const approved = this.pendingDownloads.get(url);
    if (approved !== undefined) {
      // Second pass: the person already chose a destination, so the bytes may finally be written.
      this.pendingDownloads.delete(url);
      item.setSavePath(approved.destination);
      item.once("done", (_doneEvent, state) => {
        this.emit(state === "completed" ? "portal.download.completed" : "portal.download.failed", {
          state,
          destination: approved.destination,
          bytes: item.getReceivedBytes()
        });
      });
      return;
    }
    event.preventDefault();
    const runtime = [...this.portals.values()].find(
      (candidate) => candidate.webContents === webContents
    );
    const filename = sanitizeDownloadFilename(item.getFilename());
    const suggested = suggestDownloadDestination(this.options.downloadDirectory, filename);
    const offer: PortalDownloadOffer = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: runtime?.workspaceId ?? "desconhecido",
      portalId: runtime?.portalId ?? "desconhecido",
      filename,
      extension: downloadExtension(filename),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      origin: sanitizeDownloadOrigin(url),
      url: sanitizeDownloadUrl(url),
      suggestedDestination: suggested,
      destinationExists: existsSync(suggested)
    };
    this.emit("portal.download.requested", {
      workspaceId: offer.workspaceId,
      portalId: offer.portalId,
      filename: offer.filename,
      extension: offer.extension,
      origin: offer.origin,
      totalBytes: offer.totalBytes
    });
    const decision = await this.askForDownloadDecision(offer);
    const resolved = resolveDownloadDestination({
      decision,
      offer,
      allowedRoot: this.options.downloadDirectory,
      exists: (candidate) => existsSync(candidate)
    });
    if (!resolved.accepted) {
      this.emit("portal.download.cancelled", {
        workspaceId: offer.workspaceId,
        portalId: offer.portalId,
        filename: offer.filename,
        reason: resolved.reason
      });
      return;
    }
    this.pendingDownloads.set(url, {
      destination: resolved.destination,
      portalKey: this.key(offer.workspaceId, offer.portalId)
    });
    this.emit("portal.download.accepted", {
      workspaceId: offer.workspaceId,
      portalId: offer.portalId,
      filename: offer.filename,
      destination: resolved.destination
    });
    if (runtime !== undefined && !runtime.webContents.isDestroyed())
      runtime.session.downloadURL(url);
  }

  /**
   * Waits for a person. A dialog nobody answers ends as a refusal, never as a silent write, and the
   * timer is always cleared so the offer cannot keep a promise alive after the window is gone.
   */
  private async askForDownloadDecision(
    offer: PortalDownloadOffer
  ): Promise<PortalDownloadDecision> {
    if (this.options.requestDownloadDecision !== undefined)
      return this.options
        .requestDownloadDecision(offer)
        .catch(() => ({ accepted: false, reason: "O diálogo de download falhou." }));
    if (this.options.askDownload === undefined)
      return { accepted: false, reason: "Nenhum diálogo de download disponível." };
    return new Promise<PortalDownloadDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.downloadDecisions.delete(offer.id);
        resolve({ accepted: false, reason: "O diálogo de download expirou." });
      }, this.options.downloadDecisionTimeoutMs ?? 120_000);
      this.downloadDecisions.set(offer.id, (decision) => {
        clearTimeout(timer);
        this.downloadDecisions.delete(offer.id);
        resolve(decision);
      });
      this.options.askDownload?.(offer);
    });
  }

  /** Answer from the Compazio dialog. Repeating it is harmless: the first answer already settled. */
  public settleDownload(input: {
    readonly requestId: string;
    readonly accepted: boolean;
    readonly destination?: string;
    readonly overwrite?: boolean;
  }): boolean {
    const settle = this.downloadDecisions.get(input.requestId);
    if (settle === undefined) return false;
    settle(
      input.accepted
        ? {
            accepted: true,
            ...(input.destination === undefined ? {} : { destination: input.destination }),
            ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite })
          }
        : { accepted: false, reason: "Download cancelado pelo usuário." }
    );
    return true;
  }

  private async run<T>(
    workspaceId: string,
    portalId: string,
    action: string,
    options: PortalOperationOptions,
    work: (runtime: PortalRuntime, context: PortalOperationContext) => Promise<T>
  ): Promise<T> {
    const runtime = this.require(workspaceId, portalId);
    return this.operations.run(
      {
        workspaceId,
        portalId,
        action,
        ...(options.terminalNodeId === undefined ? {} : { terminalNodeId: options.terminalNodeId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId })
      },
      async (context) => {
        if (runtime.destroyed || runtime.webContents.isDestroyed())
          throw new PortalError("PORTAL_DESTROYED", "O Portal foi destruído.", { portalId });
        return work(runtime, context);
      }
    );
  }

  private require(workspaceId: string, portalId: string): PortalRuntime {
    const runtime = this.portals.get(this.key(workspaceId, portalId));
    if (runtime === undefined || runtime.destroyed)
      throw new PortalError("PORTAL_NOT_FOUND", "Portal não está carregado.", { portalId });
    if (runtime.state === "crashed")
      throw new PortalError("PORTAL_CRASHED", "O processo do Portal falhou.", {
        portalId,
        reason: runtime.failure?.reason ?? ""
      });
    return runtime;
  }

  private snapshot(runtime: PortalRuntime): PortalRuntimeSnapshot {
    const alive = !runtime.webContents.isDestroyed();
    const decision = this.surfaces.decisionFor(this.key(runtime.workspaceId, runtime.portalId));
    const history = alive ? runtime.webContents.navigationHistory : null;
    return {
      workspaceId: runtime.workspaceId,
      portalId: runtime.portalId,
      title: alive ? runtime.webContents.getTitle().slice(0, 512) : runtime.node.title,
      url: alive ? runtime.webContents.getURL() || runtime.node.url : runtime.node.url,
      state: runtime.state,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
      loading: alive ? runtime.webContents.isLoading() : false,
      focused: runtime.focused,
      sessionMode: runtime.node.sessionMode,
      partition: runtime.partition,
      failure: runtime.failure,
      recovery: {
        attempts: this.recovery.state(this.key(runtime.workspaceId, runtime.portalId)).attempts,
        exhausted: this.recovery.state(this.key(runtime.workspaceId, runtime.portalId)).exhausted
      },
      visible: runtime.bounds.visible,
      surface: {
        attached: decision?.attached ?? false,
        visible: decision?.visible ?? false,
        reason: decision?.reason ?? "node-hidden"
      }
    };
  }

  private captureDiagnostics(runtime: PortalRuntime): Readonly<Record<string, unknown>> {
    const window = this.options.getWindow();
    const decision = this.surfaces.decisionFor(this.key(runtime.workspaceId, runtime.portalId));
    return {
      state: runtime.state,
      bounds: { ...runtime.bounds },
      millisecondsSinceBoundsUpdate: Math.max(0, Date.now() - runtime.lastBoundsAt),
      surface: decision === null ? null : { ...decision },
      window:
        window === null || window.isDestroyed()
          ? null
          : {
              visible: window.isVisible(),
              focused: window.isFocused(),
              minimized: window.isMinimized()
            },
      webContents: {
        destroyed: runtime.webContents.isDestroyed(),
        loading: runtime.webContents.isLoading()
      }
    };
  }

  private async persistState(runtime: PortalRuntime): Promise<void> {
    if (runtime.webContents.isDestroyed()) return;
    const url = runtime.webContents.getURL();
    await this.options
      .persist(runtime.workspaceId, runtime.portalId, {
        ...(url === "" ? {} : { url }),
        lastKnownState: {
          lastUrl: url,
          lastTitle: runtime.webContents.getTitle().slice(0, 512),
          canGoBack: runtime.webContents.navigationHistory.canGoBack(),
          canGoForward: runtime.webContents.navigationHistory.canGoForward(),
          crashed: runtime.state === "crashed"
        }
      })
      .catch(() => undefined);
  }

  private emit(type: string, metadata: Readonly<Record<string, unknown>>): void {
    this.options.onEvent?.(type, metadata);
  }

  private partition(workspaceId: string, node: PortalNode): string {
    const scope = node.sessionMode === "workspace-shared" ? node.sessionKey : node.id;
    return `persist:compazio-portal-${workspaceId}-${scope}`;
  }

  private key(workspaceId: string, portalId: string): string {
    return `${workspaceId}:${portalId}`;
  }
}

function hasLocator(input: PortalAutomationInput): boolean {
  return (
    input.role !== undefined ||
    input.name !== undefined ||
    input.label !== undefined ||
    input.text !== undefined ||
    input.selector !== undefined ||
    input.coordinates !== undefined
  );
}

function locatorOf(input: PortalAutomationInput): NonNullable<PortalPageRequest["locator"]> {
  return {
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.selector === undefined ? {} : { selector: input.selector }),
    ...(input.coordinates === undefined ? {} : { coordinates: input.coordinates }),
    ...(input.exact === undefined ? {} : { exact: input.exact }),
    ...(input.index === undefined ? {} : { index: input.index })
  };
}

const knownCodes = new Set([
  "PORTAL_ELEMENT_NOT_FOUND",
  "PORTAL_ELEMENT_NOT_EDITABLE",
  "PORTAL_INVALID_KEY",
  "PORTAL_DOM_LIMIT_EXCEEDED",
  "PORTAL_EVALUATE_DENIED"
]);

function asPortalErrorCode(code: string): ConstructorParameters<typeof PortalError>[0] {
  return knownCodes.has(code)
    ? (code as ConstructorParameters<typeof PortalError>[0])
    : "PORTAL_OPERATION_FAILED";
}

/** Ties a native promise to the operation's signal so a cancelled call stops waiting immediately. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

type PortalDebugger = Pick<WebContents["debugger"], "attach" | "isAttached" | "sendCommand">;

async function applyEmulatedViewport(
  webContents: Pick<WebContents, "debugger">,
  viewport: { readonly width: number; readonly height: number },
  signal: AbortSignal
): Promise<void> {
  const portalDebugger: PortalDebugger = webContents.debugger;
  if (!portalDebugger.isAttached()) portalDebugger.attach("1.3");
  await abortable(
    portalDebugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width <= 480,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false
    }),
    signal
  );
}

export async function captureEmulatedViewport(
  webContents: Pick<WebContents, "debugger">,
  viewport: { readonly width: number; readonly height: number },
  signal: AbortSignal
): Promise<Buffer> {
  await applyEmulatedViewport(webContents, viewport, signal);
  const result = (await abortable(
    webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 }
    }),
    signal
  )) as { readonly data?: unknown };
  if (typeof result.data !== "string" || result.data.length === 0)
    throw new PortalError("PORTAL_OPERATION_FAILED", "O navegador devolveu uma captura vazia.");
  return Buffer.from(result.data, "base64");
}

const screenshotRetryDelayMs = 75;
const screenshotCaptureAttempts = 3;

/**
 * Windows' compositor may reject a capture while a WebContentsView is being attached or repainted.
 * The retry is intentionally narrow and bounded by the caller's existing operation timeout: it
 * covers only known compositor/display-surface failures and an empty NativeImage.
 */
export async function capturePageWithRetry(
  webContents: Pick<WebContents, "capturePage">,
  signal: AbortSignal,
  remainingMs: () => number,
  onRetry?: (attempt: number, error: unknown) => void
): ReturnType<WebContents["capturePage"]> {
  for (let attempt = 1; attempt <= screenshotCaptureAttempts; attempt += 1) {
    try {
      const image = await abortable(webContents.capturePage(), signal);
      if (image.isEmpty()) throw new Error("PORTAL_SCREENSHOT_EMPTY");
      return image;
    } catch (error) {
      if (
        !isTransientScreenshotError(error) ||
        attempt === screenshotCaptureAttempts ||
        signal.aborted ||
        remainingMs() <= screenshotRetryDelayMs
      )
        throw error;
      onRetry?.(attempt, error);
      await abortable(
        new Promise<void>((resolve) => setTimeout(resolve, screenshotRetryDelayMs)),
        signal
      );
    }
  }
  throw new Error("PORTAL_SCREENSHOT_RETRY_EXHAUSTED");
}

function isTransientScreenshotError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === "UnknownVizError" ||
    message === "PORTAL_SCREENSHOT_EMPTY" ||
    message.includes("Current display surface not available for capture")
  );
}

function describeScreenshotError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
}

function waitForIdle(webContents: WebContents): Promise<void> {
  if (!webContents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      webContents.removeListener("did-stop-loading", done);
      resolve();
    };
    webContents.on("did-stop-loading", done);
  });
}

export function isAllowedPortalUrl(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export { join as joinPortalPath };
