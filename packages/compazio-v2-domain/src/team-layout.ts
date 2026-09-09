import type { Position, Size } from "./model";

export interface LayoutNode {
  readonly id: string;
  readonly kind: "orchestrator" | "agent" | "note" | "other";
  readonly position: Position;
  readonly size: Size;
  readonly manual: boolean;
}

export interface TeamLayoutInput {
  readonly orchestratorId: string;
  readonly teamNodeIds: readonly string[];
  readonly nodes: readonly LayoutNode[];
  readonly force?: boolean;
  readonly columns?: number;
  readonly horizontalGap?: number;
  readonly verticalGap?: number;
}

export interface TeamLayoutResult {
  readonly positions: Readonly<Record<string, Position>>;
  readonly preservedNodeIds: readonly string[];
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * Places only a single team around its orchestrator. Existing/manual nodes are obstacles, so adding
 * one recruit never triggers a global canvas rearrangement.
 */
export function organizeTeam(input: TeamLayoutInput): TeamLayoutResult {
  const orchestrator = input.nodes.find((node) => node.id === input.orchestratorId);
  if (orchestrator === undefined) throw new Error("LAYOUT_CONFLICT: orchestrator is missing");

  const columns = Math.max(1, Math.min(4, input.columns ?? 3));
  const horizontalGap = input.horizontalGap ?? 48;
  const verticalGap = input.verticalGap ?? 72;
  const teamIds = new Set(input.teamNodeIds);
  const candidates = input.nodes
    .filter((node) => teamIds.has(node.id) && node.id !== orchestrator.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const preserved = candidates.filter((node) => node.manual && input.force !== true);
  const movable = candidates.filter((node) => !node.manual || input.force === true);
  const agents = movable.filter((node) => node.kind !== "note");
  const notes = movable.filter((node) => node.kind === "note");
  const obstacles = input.nodes
    .filter(
      (node) =>
        !teamIds.has(node.id) ||
        node.id === orchestrator.id ||
        (node.manual && input.force !== true)
    )
    .map(toRectangle);
  const positions: Record<string, Position> = { [orchestrator.id]: orchestrator.position };
  const maxAgentWidth = Math.max(280, ...agents.map((node) => node.size.width));
  const maxAgentHeight = Math.max(180, ...agents.map((node) => node.size.height));
  const rowWidth = Math.max(
    orchestrator.size.width,
    Math.min(columns, Math.max(1, agents.length)) * maxAgentWidth +
      Math.max(0, Math.min(columns, agents.length) - 1) * horizontalGap
  );
  const rowStartX = orchestrator.position.x + orchestrator.size.width / 2 - rowWidth / 2;

  agents.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const desired = {
      x: rowStartX + column * (maxAgentWidth + horizontalGap),
      y:
        orchestrator.position.y +
        orchestrator.size.height +
        verticalGap +
        row * (maxAgentHeight + verticalGap)
    };
    const position = findFreePosition(desired, node.size, obstacles, horizontalGap, verticalGap);
    positions[node.id] = position;
    obstacles.push({ ...position, ...node.size });
  });

  const agentRows = Math.max(1, Math.ceil(agents.length / columns));
  notes.forEach((node, index) => {
    const desired = {
      x: orchestrator.position.x + orchestrator.size.width + horizontalGap,
      y:
        orchestrator.position.y +
        orchestrator.size.height +
        verticalGap +
        (agentRows - 1) * (maxAgentHeight + verticalGap) +
        index * (node.size.height + verticalGap)
    };
    const position = findFreePosition(desired, node.size, obstacles, horizontalGap, verticalGap);
    positions[node.id] = position;
    obstacles.push({ ...position, ...node.size });
  });

  for (const node of preserved) positions[node.id] = node.position;
  return {
    positions,
    preservedNodeIds: preserved.map((node) => node.id),
    bounds: boundsFor(
      input.nodes
        .filter((node) => node.id in positions)
        .map((node) => ({ ...node, position: positions[node.id] ?? node.position }))
    )
  };
}

function findFreePosition(
  desired: Position,
  size: Size,
  obstacles: readonly Rectangle[],
  horizontalGap: number,
  verticalGap: number
): Position {
  for (let step = 0; step < 200; step += 1) {
    const ring = Math.floor(step / 8);
    const direction = step % 8;
    const offsets = [
      [0, 0],
      [ring + 1, 0],
      [-(ring + 1), 0],
      [0, ring + 1],
      [0, -(ring + 1)],
      [ring + 1, ring + 1],
      [-(ring + 1), ring + 1],
      [ring + 1, -(ring + 1)]
    ] as const;
    const [dx, dy] = offsets[direction] ?? [0, 0];
    const candidate = {
      x: desired.x + dx * (size.width + horizontalGap),
      y: desired.y + dy * (size.height + verticalGap)
    };
    const rectangle = { ...candidate, ...size };
    if (!obstacles.some((obstacle) => intersects(rectangle, obstacle, 16))) return candidate;
  }
  throw new Error("LAYOUT_CONFLICT: no free position was found");
}

interface Rectangle extends Position, Size {}

function toRectangle(node: LayoutNode): Rectangle {
  return { ...node.position, ...node.size };
}

function intersects(left: Rectangle, right: Rectangle, padding: number): boolean {
  return !(
    left.x + left.width + padding <= right.x ||
    right.x + right.width + padding <= left.x ||
    left.y + left.height + padding <= right.y ||
    right.y + right.height + padding <= left.y
  );
}

function boundsFor(nodes: readonly LayoutNode[]): TeamLayoutResult["bounds"] {
  const minimumX = Math.min(...nodes.map((node) => node.position.x));
  const minimumY = Math.min(...nodes.map((node) => node.position.y));
  const maximumX = Math.max(...nodes.map((node) => node.position.x + node.size.width));
  const maximumY = Math.max(...nodes.map((node) => node.position.y + node.size.height));
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY
  };
}
