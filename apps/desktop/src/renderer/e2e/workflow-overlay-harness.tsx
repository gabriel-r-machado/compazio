/* eslint-disable react-refresh/only-export-components -- e2e entry module, not an HMR component file */
import { useEffect, useState } from "react";

import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AgentNode, GateNode, TaskNode } from "../ui/canvas-nodes";
import { ContractEdge } from "../ui/contract-edge";
import type { ForgeFlowEdge, ForgeFlowNode } from "../ui/canvas-store";
import { I18nProvider } from "../ui/i18n";
import { projectWorkflowRunToCanvas } from "../ui/workflow-run-projection";
import { buildCanvasEdgeRunOverlay, buildCanvasRunOverlay } from "../ui/workflow-run-overlay";
import type { CanvasEdgeRunOverlay, CanvasRunOverlay } from "../ui/workflow-run-overlay";
import { WorkflowRunEdgeContext, WorkflowRunNodeContext } from "../ui/workflow-run-node-context";
import { WorkflowNodeInspector } from "../ui/workflow-node-inspector";

/**
 * Renderer harness for the workflow overlay Electron smoke. It mounts the SAME production components
 * (canvas node card, ContractEdge, WorkflowNodeInspector) and the SAME pure projection/overlay code,
 * fed exclusively by the official snapshot/graph/events fetched through the real preload IPC. It never
 * fabricates state, never reads terminal output, and lets the driver assert the real DOM attributes
 * (`data-runtime-state`, `data-edge-runtime-state`) and the selection → inspector path.
 */

declare global {
  interface Window {
    __mountWorkflowOverlay?: (runId: string) => Promise<{
      readonly nodeCount: number;
      readonly edgeCount: number;
    }>;
    __selectCard?: (workflowNodeId: string) => void;
  }
}

interface OverlayModel {
  readonly nodes: ForgeFlowNode[];
  readonly edges: ForgeFlowEdge[];
  readonly nodeOverlay: CanvasRunOverlay;
  readonly edgeOverlay: CanvasEdgeRunOverlay;
}

const nodeTypes = { agent: AgentNode, task: TaskNode, gate: GateNode };
const edgeTypes = { contract: ContractEdge };

let selectCard: ((workflowNodeId: string) => void) | null = null;

function Harness({ model }: { readonly model: OverlayModel }) {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    selectCard = (workflowNodeId) => setSelected(`card-${workflowNodeId}`);
    return () => {
      selectCard = null;
    };
  }, []);
  const selectedNode = selected === null ? null : (model.nodeOverlay.get(selected) ?? null);
  return (
    <I18nProvider locale="en" onLocaleChange={async () => undefined}>
      <WorkflowRunNodeContext.Provider value={model.nodeOverlay}>
        <WorkflowRunEdgeContext.Provider value={model.edgeOverlay}>
          <div className="flow-surface" style={{ width: 1024, height: 640 }}>
            <ReactFlowProvider>
              <ReactFlow<ForgeFlowNode, ForgeFlowEdge>
                nodes={model.nodes}
                edges={model.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                fitView
                onNodeClick={(_event, node) => setSelected(node.id)}
              />
            </ReactFlowProvider>
          </div>
          <div data-testid="harness-inspector">
            {selectedNode === null ? null : <WorkflowNodeInspector node={selectedNode} />}
          </div>
        </WorkflowRunEdgeContext.Provider>
      </WorkflowRunNodeContext.Provider>
    </I18nProvider>
  );
}

function buildModel(
  snapshot: Parameters<typeof projectWorkflowRunToCanvas>[0],
  graph: NonNullable<Parameters<typeof projectWorkflowRunToCanvas>[1]>,
  events: Parameters<typeof projectWorkflowRunToCanvas>[2]
): OverlayModel {
  const projection = projectWorkflowRunToCanvas(snapshot, graph, events);
  const nodes: ForgeFlowNode[] = graph.nodes.map((node, index) => ({
    id: `card-${node.id}`,
    type: "agent",
    position: { x: 40 + index * 320, y: 80 },
    width: 240,
    height: 140,
    data: {
      title: node.title ?? node.id,
      state: "idle",
      summary: "",
      retryMaxAttempts: 1,
      permissions: [],
      workflowNodeId: node.id
    }
  }));
  const edges: ForgeFlowEdge[] = [];
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      edges.push({
        id: `edge-${dependency}-${node.id}`,
        type: "contract",
        source: `card-${dependency}`,
        target: `card-${node.id}`,
        data: { schemaVersion: "1.0", kind: "dependency", label: "", requiredEvidenceTypes: [] }
      });
    }
  }
  return {
    nodes,
    edges,
    nodeOverlay: buildCanvasRunOverlay(projection, nodes),
    edgeOverlay: buildCanvasEdgeRunOverlay(projection, nodes, edges)
  };
}

const container = document.getElementById("root");
if (container === null) {
  throw new Error("workflow overlay harness requires a #root element");
}
const root = createRoot(container);

window.__selectCard = (workflowNodeId) => selectCard?.(workflowNodeId);
window.__mountWorkflowOverlay = async (runId) => {
  const [snapshot, graph] = await Promise.all([
    window.forgedeck.workflows.show({ runId }),
    window.forgedeck.workflows.graph({ runId })
  ]);
  // Events only refine timing/retry; the overlay is complete from snapshot+graph, so a fetch failure
  // must never break the canvas (this mirrors the app's own resilient events fetch).
  const events = await window.forgedeck.workflows.events({ runId }).catch(() => []);
  const model = buildModel(snapshot, graph, events);
  root.render(<Harness model={model} />);
  return { nodeCount: model.nodes.length, edgeCount: model.edges.length };
};
