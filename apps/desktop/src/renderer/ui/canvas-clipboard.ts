import type { CanvasNodeData, CanvasNodeType, EdgeContract } from "@forgedeck/schemas";

import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";

export interface CanvasClipboard {
  readonly nodes: readonly ClipboardNode[];
  readonly edges: readonly ClipboardEdge[];
}

interface ClipboardNode {
  readonly sourceId: string;
  readonly type: CanvasNodeType;
  readonly offset: { readonly x: number; readonly y: number };
  readonly width?: number;
  readonly height?: number;
  readonly zIndex?: number;
  readonly data: CanvasNodeData;
}

interface ClipboardEdge {
  readonly source: string;
  readonly target: string;
  readonly data?: EdgeContract;
}

export function copyCanvasSelection(
  nodes: readonly ForgeFlowNode[],
  edges: readonly ForgeFlowEdge[]
): CanvasClipboard | null {
  const selected = nodes.filter((node) => node.selected);
  if (selected.length === 0) return null;
  const left = Math.min(...selected.map((node) => node.position.x));
  const top = Math.min(...selected.map((node) => node.position.y));
  const selectedIds = new Set(selected.map((node) => node.id));
  return {
    nodes: selected.map((node) => ({
      sourceId: node.id,
      type: node.type ?? "task",
      offset: { x: node.position.x - left, y: node.position.y - top },
      ...(node.width === undefined ? {} : { width: node.width }),
      ...(node.height === undefined ? {} : { height: node.height }),
      ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
      data: structuredClone(node.data)
    })),
    edges: edges
      .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        ...(edge.data === undefined ? {} : { data: structuredClone(edge.data) })
      }))
  };
}

export function pasteCanvasSelection(
  clipboard: CanvasClipboard,
  origin: { readonly x: number; readonly y: number },
  createId: () => string = () => crypto.randomUUID()
): { readonly nodes: ForgeFlowNode[]; readonly edges: ForgeFlowEdge[] } {
  const ids = new Map<string, string>();
  for (const node of clipboard.nodes) {
    ids.set(node.sourceId, `${node.type}-${createId()}`);
  }
  const nodes = clipboard.nodes.map((node): ForgeFlowNode => {
    const id = ids.get(node.sourceId);
    if (id === undefined) throw new Error("Canvas clipboard node id was not allocated");
    const data = structuredClone(node.data);
    return {
      id,
      type: node.type,
      position: { x: origin.x + node.offset.x, y: origin.y + node.offset.y },
      ...(node.width === undefined ? {} : { width: node.width }),
      ...(node.height === undefined ? {} : { height: node.height }),
      ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
      selected: true,
      data:
        data.frame === undefined
          ? data
          : {
              ...data,
              frame: {
                memberNodeIds: data.frame.memberNodeIds.flatMap((memberNodeId) => {
                  const memberId = ids.get(memberNodeId);
                  return memberId === undefined ? [] : [memberId];
                })
              }
            }
    };
  });
  const edges = clipboard.edges.flatMap((edge): ForgeFlowEdge[] => {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source === undefined || target === undefined) return [];
    return [
      {
        id: `edge-${createId()}`,
        type: "contract",
        source,
        target,
        ...(edge.data === undefined ? {} : { data: structuredClone(edge.data) })
      }
    ];
  });
  return { nodes, edges };
}
