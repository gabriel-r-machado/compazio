/**
 * Canvas viewport math for the V2 workspace.
 *
 * The canvas is the product environment, so panning, zooming and selecting have to behave the same
 * way every time and stay verifiable without a browser. Every rule that decides *where* something
 * lands lives here as a pure function; the React layer only feeds it pointer coordinates.
 */

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Point, Size {}

export interface PlacedNode {
  readonly id: string;
  readonly position: Point;
  readonly size: Size;
}

// At 25% the cards used to collapse into blank rectangles. 40% still lets a large workspace fit
// while preserving a useful identity, title and connection surface for every node.
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.5;
/** Below this zoom a node cannot show readable content, so it collapses to its header. */
export const ZOOM_COMPACT = ZOOM_MIN;
export const ZOOM_STEP = 1.2;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Screen point (relative to the canvas box) into canvas coordinates. */
export function toCanvasPoint(viewport: Viewport, point: Point): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom
  };
}

/** Canvas coordinates back into a screen point relative to the canvas box. */
export function toScreenPoint(viewport: Viewport, point: Point): Point {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y
  };
}

export function panBy(viewport: Viewport, deltaX: number, deltaY: number): Viewport {
  return { ...viewport, x: viewport.x + deltaX, y: viewport.y + deltaY };
}

/**
 * Zoom keeping the canvas point under the pointer anchored to the pointer. Zooming around the
 * origin makes the canvas feel like it is running away from the person driving it.
 */
export function zoomAtPoint(viewport: Viewport, factor: number, anchor: Point): Viewport {
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const canvasAnchor = toCanvasPoint(viewport, anchor);
  return {
    zoom,
    x: anchor.x - canvasAnchor.x * zoom,
    y: anchor.y - canvasAnchor.y * zoom
  };
}

/** Zoom around the centre of the visible area, for the +/− controls and keyboard shortcuts. */
export function zoomAtCenter(viewport: Viewport, factor: number, size: Size): Viewport {
  return zoomAtPoint(viewport, factor, { x: size.width / 2, y: size.height / 2 });
}

export function fitViewport(bounds: Rect, size: Size, padding = 72): Viewport {
  const width = Math.max(120, size.width - padding * 2);
  const height = Math.max(120, size.height - padding * 2);
  const safeBounds = {
    ...bounds,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height)
  };
  const zoom = clampZoom(Math.min(width / safeBounds.width, height / safeBounds.height));
  return {
    zoom,
    x: padding - safeBounds.x * zoom + (width - safeBounds.width * zoom) / 2,
    y: padding - safeBounds.y * zoom + (height - safeBounds.height * zoom) / 2
  };
}

/** Viewport that centres a canvas point without changing the zoom. */
export function centerOn(viewport: Viewport, target: Point, size: Size): Viewport {
  return {
    ...viewport,
    x: size.width / 2 - target.x * viewport.zoom,
    y: size.height / 2 - target.y * viewport.zoom
  };
}

export function boundsOf(nodes: readonly PlacedNode[]): Rect | null {
  if (nodes.length === 0) return null;
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + node.size.width));
  const bottom = Math.max(...nodes.map((node) => node.position.y + node.size.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The rectangle the canvas is showing right now, in canvas coordinates. */
export function visibleRect(viewport: Viewport, size: Size): Rect {
  const origin = toCanvasPoint(viewport, { x: 0, y: 0 });
  return {
    x: origin.x,
    y: origin.y,
    width: size.width / viewport.zoom,
    height: size.height / viewport.zoom
  };
}

/**
 * A safe default location for something created from the toolbar or a keyboard shortcut.
 *
 * Domain operations intentionally retain stable fallback coordinates for API callers. The UI,
 * however, must use the part of the canvas the person is actually looking at. This keeps a new
 * card in view after any pan or zoom and chooses a nearby free slot so consecutive creations do
 * not land exactly on top of each other.
 */
export function viewportInsertionPoint(
  viewport: Viewport,
  size: Size,
  nodes: readonly PlacedNode[],
  itemSize: Size = { width: 320, height: 220 }
): Point {
  const visible = visibleRect(viewport, size);
  const margin = 24;
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));
  const base = {
    x: clamp(
      visible.x + (visible.width - itemSize.width) / 2,
      visible.x + margin,
      visible.x + Math.max(margin, visible.width - itemSize.width - margin)
    ),
    y: clamp(
      visible.y + (visible.height - itemSize.height) / 2,
      visible.y + margin,
      visible.y + Math.max(margin, visible.height - itemSize.height - margin)
    )
  };
  const offsets = [
    [0, 0],
    [360, 0],
    [-360, 0],
    [0, 264],
    [0, -264],
    [360, 264],
    [-360, 264],
    [360, -264],
    [-360, -264]
  ] as const;

  const candidates = offsets.map(([x, y]) =>
    snapToGrid({
      x: clamp(
        base.x + x,
        visible.x + margin,
        visible.x + Math.max(margin, visible.width - itemSize.width - margin)
      ),
      y: clamp(
        base.y + y,
        visible.y + margin,
        visible.y + Math.max(margin, visible.height - itemSize.height - margin)
      )
    })
  );
  return (
    candidates.find(
      (candidate) =>
        !nodes.some((node) =>
          rectsIntersect({ ...candidate, ...itemSize }, { ...node.position, ...node.size })
        )
    ) ??
    candidates[0] ??
    snapToGrid(base)
  );
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Nodes touched by a marquee, in canvas coordinates. Touching is enough — Figma behaviour. */
export function nodesInRect(nodes: readonly PlacedNode[], rect: Rect): readonly string[] {
  return nodes
    .filter((node) =>
      rectsIntersect({ x: node.position.x, y: node.position.y, ...node.size }, rect)
    )
    .map((node) => node.id);
}

/**
 * How much of a node can be drawn at this zoom. Far out, a node that keeps painting a terminal is
 * unreadable noise, so the canvas answers with the level of detail instead of every card guessing.
 */
export function detailLevel(zoom: number): "compact" | "full" {
  return zoom < ZOOM_COMPACT ? "compact" : "full";
}

export interface MinimapProjection {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Projects a canvas rect into minimap coordinates. */
  readonly project: (rect: Rect) => Rect;
}

/**
 * Fits the whole workspace — nodes plus what the canvas is currently showing — inside the minimap
 * frame, so the viewport rectangle is always visible even when it sits far from every node.
 */
export function minimapProjection(content: Rect, frame: Size, padding = 6): MinimapProjection {
  const width = Math.max(1, content.width);
  const height = Math.max(1, content.height);
  const usableWidth = Math.max(1, frame.width - padding * 2);
  const usableHeight = Math.max(1, frame.height - padding * 2);
  const scale = Math.min(usableWidth / width, usableHeight / height);
  const offsetX = padding + (usableWidth - width * scale) / 2 - content.x * scale;
  const offsetY = padding + (usableHeight - height * scale) / 2 - content.y * scale;
  return {
    scale,
    offsetX,
    offsetY,
    project: (rect) => ({
      x: rect.x * scale + offsetX,
      y: rect.y * scale + offsetY,
      width: rect.width * scale,
      height: rect.height * scale
    })
  };
}

/** Union of two rects, used to keep nodes and viewport together inside the minimap. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Grid-aligned drop position, so nodes created from a menu never overlap pixel for pixel. */
export function snapToGrid(point: Point, grid = 24): Point {
  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid
  };
}

export interface ConnectionGeometry {
  readonly from: Point;
  readonly to: Point;
  readonly path: string;
}

/**
 * Connects the nearest walls instead of the centres. The path has a small gravity-like sag, so it
 * reads as a cable and changes naturally as cards move without running through their content.
 */
export function connectionGeometry(source: PlacedNode, target: PlacedNode): ConnectionGeometry {
  const sourceCenter = {
    x: source.position.x + source.size.width / 2,
    y: source.position.y + source.size.height / 2
  };
  const targetCenter = {
    x: target.position.x + target.size.width / 2,
    y: target.position.y + target.size.height / 2
  };
  const horizontal =
    Math.abs(targetCenter.x - sourceCenter.x) >= Math.abs(targetCenter.y - sourceCenter.y);
  const from = horizontal
    ? {
        x:
          targetCenter.x >= sourceCenter.x
            ? source.position.x + source.size.width
            : source.position.x,
        y: sourceCenter.y
      }
    : {
        x: sourceCenter.x,
        y:
          targetCenter.y >= sourceCenter.y
            ? source.position.y + source.size.height
            : source.position.y
      };
  const to = horizontal
    ? {
        x:
          targetCenter.x >= sourceCenter.x
            ? target.position.x
            : target.position.x + target.size.width,
        y: targetCenter.y
      }
    : {
        x: targetCenter.x,
        y:
          targetCenter.y >= sourceCenter.y
            ? target.position.y
            : target.position.y + target.size.height
      };
  return { from, to, path: cablePath(from, to, horizontal ? "horizontal" : "vertical") };
}

export function cablePath(
  from: Point,
  to: Point,
  direction: "horizontal" | "vertical" = "horizontal"
): string {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const sag = Math.min(96, Math.max(18, distance * 0.12));
  if (direction === "vertical") {
    const controlY = (from.y + to.y) / 2;
    const drift = to.x >= from.x ? sag * 0.35 : -sag * 0.35;
    return `M ${from.x} ${from.y} C ${from.x + drift} ${controlY}, ${to.x + drift} ${controlY}, ${to.x} ${to.y}`;
  }
  const controlX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${controlX} ${from.y + sag}, ${controlX} ${to.y + sag}, ${to.x} ${to.y}`;
}

/** Minimal shape of a scrollable element, so the rule can be tested without a DOM. */
export interface ScrollableLike {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly overflowY: string;
}

/**
 * Whether a wheel event should scroll this element instead of zooming the canvas.
 *
 * A long note has its own scroll area. Without this the wheel bubbles to the canvas and zooms,
 * which is the reported conflict. Zooming resumes at the ends of the note, so the canvas is never
 * unreachable: scrolling past the top or bottom hands the gesture back.
 */
export function consumesWheelScroll(element: ScrollableLike, deltaY: number): boolean {
  if (!["auto", "scroll", "overlay"].includes(element.overflowY)) return false;
  const overflow = element.scrollHeight - element.clientHeight;
  // A one-pixel difference is rounding, not a scroll area.
  if (overflow <= 1) return false;
  if (deltaY < 0) return element.scrollTop > 0;
  if (deltaY > 0) return element.scrollTop < overflow - 1;
  return false;
}
