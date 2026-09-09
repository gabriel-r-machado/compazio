import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";

const canvasInset = 96;
const columnGap = 180;
const rowGap = 112;
const disconnectedGap = 180;
const disconnectedColumns = 3;

interface NodeSize {
  readonly width: number;
  readonly height: number;
}

export function organizeCanvasNodes(
  nodes: readonly ForgeFlowNode[],
  edges: readonly ForgeFlowEdge[]
): readonly ForgeFlowNode[] {
  if (nodes.length === 0) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const connectedIds = new Set<string>();
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const depth = calculateDepths(nodes, connectedIds, incoming, outgoing);
  const columns = new Map<number, ForgeFlowNode[]>();
  for (const node of nodes) {
    const nodeDepth = depth.get(node.id);
    if (nodeDepth === undefined) continue;
    const column = columns.get(nodeDepth) ?? [];
    column.push(node);
    columns.set(nodeDepth, column);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let connectedBottom = canvasInset;
  let x = canvasInset;
  const orderedColumns = [...columns.entries()].sort(([left], [right]) => left - right);
  const columnHeights = orderedColumns.map(([, column]) => stackHeight(column));
  const graphHeight = Math.max(0, ...columnHeights);

  orderedColumns.forEach(([, column], index) => {
    let y = canvasInset + (graphHeight - (columnHeights[index] ?? 0)) / 2;
    let columnWidth = 0;
    for (const node of column) {
      const size = nodeSize(node);
      positions.set(node.id, { x, y });
      y += size.height + rowGap;
      columnWidth = Math.max(columnWidth, size.width);
      connectedBottom = Math.max(connectedBottom, y - rowGap);
    }
    x += columnWidth + columnGap;
  });

  const disconnected = nodes.filter((node) => !connectedIds.has(node.id));
  if (disconnected.length > 0) {
    const laneTop = connectedIds.size === 0 ? canvasInset : connectedBottom + disconnectedGap;
    const columnWidths = Array.from({ length: disconnectedColumns }, () => 0);
    disconnected.forEach((node, index) => {
      const column = index % disconnectedColumns;
      columnWidths[column] = Math.max(columnWidths[column] ?? 0, nodeSize(node).width);
    });
    const columnOffsets = columnWidths.map((_, index) =>
      columnWidths.slice(0, index).reduce((total, width) => total + width + columnGap, canvasInset)
    );
    const rowHeights: number[] = [];
    disconnected.forEach((node, index) => {
      const row = Math.floor(index / disconnectedColumns);
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, nodeSize(node).height);
    });
    const rowOffsets = rowHeights.map((_, index) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height + rowGap, laneTop)
    );
    disconnected.forEach((node, index) => {
      const column = index % disconnectedColumns;
      const row = Math.floor(index / disconnectedColumns);
      positions.set(node.id, {
        x: columnOffsets[column] ?? canvasInset,
        y: rowOffsets[row] ?? laneTop
      });
    });
  }

  return nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
}

function calculateDepths(
  nodes: readonly ForgeFlowNode[],
  connectedIds: ReadonlySet<string>,
  incoming: Map<string, number>,
  outgoing: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, number> {
  const depth = new Map<string, number>();
  const queue = nodes
    .filter((node) => connectedIds.has(node.id) && incoming.get(node.id) === 0)
    .map((node) => node.id);
  for (const nodeId of queue) depth.set(nodeId, 0);
  for (const nodeId of queue) {
    for (const target of outgoing.get(nodeId) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(nodeId) ?? 0) + 1));
      const remaining = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  return depth;
}

function stackHeight(nodes: readonly ForgeFlowNode[]): number {
  return nodes.reduce(
    (total, node, index) => total + nodeSize(node).height + (index === 0 ? 0 : rowGap),
    0
  );
}

function nodeSize(node: ForgeFlowNode): NodeSize {
  const measured = node.measured;
  if (measured?.width !== undefined && measured.height !== undefined) {
    return { width: measured.width, height: measured.height };
  }
  if (node.width !== undefined && node.height !== undefined) {
    return { width: node.width, height: node.height };
  }
  if (node.type === "terminal" || node.type === "agent") {
    return { width: 560, height: 380 };
  }
  if (node.type === "note") return { width: 280, height: 180 };
  return { width: 300, height: 200 };
}
