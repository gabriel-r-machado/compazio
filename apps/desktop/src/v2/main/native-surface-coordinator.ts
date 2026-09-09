export type NativeSurfaceOverlay =
  | "modal"
  | "menu"
  | "command-palette"
  | "prompt-composer"
  | "popover"
  | "dialog"
  | "settings"
  | "destructive-confirmation"
  | "inspector";

export interface SurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeSurfaceWindowState {
  readonly minimized: boolean;
  readonly activeWorkspaceId: string | null;
  readonly overlays: readonly NativeSurfaceOverlay[];
  /** Canvas area, in window coordinates. Native views are clipped to it, never painted outside. */
  readonly canvasViewport: SurfaceRect | null;
}

export interface NativeSurfaceRequest {
  readonly surfaceId: string;
  readonly workspaceId: string;
  readonly nodeVisible: boolean;
  readonly bounds: SurfaceRect;
}

export type NativeSurfaceReason =
  | "visible"
  | "overlay"
  | "workspace-inactive"
  | "window-minimized"
  | "node-hidden"
  | "outside-viewport";

export interface NativeSurfaceDecision {
  readonly surfaceId: string;
  readonly workspaceId: string;
  /** Attached surfaces keep their runtime; only an inactive workspace detaches them from the window. */
  readonly attached: boolean;
  readonly visible: boolean;
  readonly bounds: SurfaceRect;
  readonly reason: NativeSurfaceReason;
}

const hiddenBounds: SurfaceRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * A WebContentsView is an OS-level surface: it paints over React no matter what the stylesheet says.
 * Every rule about who may cover a Portal lives here instead of being re-invented by each modal, so
 * opening a menu hides the Portal without destroying it and closing the menu brings it back.
 */
export class NativeSurfaceCoordinator {
  private window: NativeSurfaceWindowState = {
    minimized: false,
    activeWorkspaceId: null,
    overlays: [],
    canvasViewport: null
  };
  private readonly surfaces = new Map<string, NativeSurfaceRequest>();
  private readonly listeners = new Set<(decisions: readonly NativeSurfaceDecision[]) => void>();

  public setWindowState(
    patch: Partial<NativeSurfaceWindowState>
  ): readonly NativeSurfaceDecision[] {
    this.window = {
      minimized: patch.minimized ?? this.window.minimized,
      activeWorkspaceId:
        patch.activeWorkspaceId === undefined
          ? this.window.activeWorkspaceId
          : patch.activeWorkspaceId,
      overlays: patch.overlays === undefined ? this.window.overlays : [...patch.overlays],
      canvasViewport:
        patch.canvasViewport === undefined ? this.window.canvasViewport : patch.canvasViewport
    };
    return this.publish();
  }

  public windowState(): NativeSurfaceWindowState {
    return this.window;
  }

  public openOverlay(overlay: NativeSurfaceOverlay): readonly NativeSurfaceDecision[] {
    if (this.window.overlays.includes(overlay)) return this.decisions();
    return this.setWindowState({ overlays: [...this.window.overlays, overlay] });
  }

  public closeOverlay(overlay: NativeSurfaceOverlay): readonly NativeSurfaceDecision[] {
    if (!this.window.overlays.includes(overlay)) return this.decisions();
    return this.setWindowState({
      overlays: this.window.overlays.filter((item) => item !== overlay)
    });
  }

  public closeAllOverlays(): readonly NativeSurfaceDecision[] {
    return this.setWindowState({ overlays: [] });
  }

  public track(request: NativeSurfaceRequest): readonly NativeSurfaceDecision[] {
    this.surfaces.set(request.surfaceId, request);
    return this.publish();
  }

  public untrack(surfaceId: string): readonly NativeSurfaceDecision[] {
    if (!this.surfaces.delete(surfaceId)) return this.decisions();
    return this.publish();
  }

  public untrackWorkspace(workspaceId: string): readonly NativeSurfaceDecision[] {
    for (const [surfaceId, request] of [...this.surfaces])
      if (request.workspaceId === workspaceId) this.surfaces.delete(surfaceId);
    return this.publish();
  }

  public subscribe(listener: (decisions: readonly NativeSurfaceDecision[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public decisions(): readonly NativeSurfaceDecision[] {
    return [...this.surfaces.values()].map((request) => this.decide(request));
  }

  public decisionFor(surfaceId: string): NativeSurfaceDecision | null {
    const request = this.surfaces.get(surfaceId);
    return request === undefined ? null : this.decide(request);
  }

  public size(): number {
    return this.surfaces.size;
  }

  private decide(request: NativeSurfaceRequest): NativeSurfaceDecision {
    const base = { surfaceId: request.surfaceId, workspaceId: request.workspaceId };
    if (this.window.activeWorkspaceId !== request.workspaceId)
      return {
        ...base,
        attached: false,
        visible: false,
        bounds: hiddenBounds,
        reason: "workspace-inactive"
      };
    if (this.window.minimized)
      return {
        ...base,
        attached: true,
        visible: false,
        bounds: hiddenBounds,
        reason: "window-minimized"
      };
    if (!request.nodeVisible)
      return {
        ...base,
        attached: true,
        visible: false,
        bounds: hiddenBounds,
        reason: "node-hidden"
      };
    if (this.window.overlays.length > 0)
      return { ...base, attached: true, visible: false, bounds: hiddenBounds, reason: "overlay" };
    const clipped = clip(request.bounds, this.window.canvasViewport);
    if (clipped === null)
      return {
        ...base,
        attached: true,
        visible: false,
        bounds: hiddenBounds,
        reason: "outside-viewport"
      };
    return { ...base, attached: true, visible: true, bounds: clipped, reason: "visible" };
  }

  private publish(): readonly NativeSurfaceDecision[] {
    const decisions = this.decisions();
    for (const listener of this.listeners) listener(decisions);
    return decisions;
  }
}

export function clip(bounds: SurfaceRect, viewport: SurfaceRect | null): SurfaceRect | null {
  const rounded = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
  if (rounded.width <= 0 || rounded.height <= 0) return null;
  if (viewport === null) return rounded;
  const left = Math.max(rounded.x, Math.round(viewport.x));
  const top = Math.max(rounded.y, Math.round(viewport.y));
  const right = Math.min(rounded.x + rounded.width, Math.round(viewport.x + viewport.width));
  const bottom = Math.min(rounded.y + rounded.height, Math.round(viewport.y + viewport.height));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
