export interface DraftPoint {
  readonly x: number;
  readonly y: number;
}

export interface TerminalDraftGeometry {
  readonly position: DraftPoint;
  readonly width: number;
  readonly height: number;
}

const minimumWidth = 480;
const minimumHeight = 300;
const maximumSize = 1_200;

export function hasTerminalDraftIntent(start: DraftPoint, end: DraftPoint): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= 24;
}

export function terminalDraftRectangle(start: DraftPoint, end: DraftPoint) {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

export function terminalGeometryFromDrag(
  start: DraftPoint,
  end: DraftPoint
): TerminalDraftGeometry {
  const rectangle = terminalDraftRectangle(start, end);
  return {
    position: { x: rectangle.left, y: rectangle.top },
    width: Math.min(maximumSize, Math.max(minimumWidth, rectangle.width)),
    height: Math.min(maximumSize, Math.max(minimumHeight, rectangle.height))
  };
}
