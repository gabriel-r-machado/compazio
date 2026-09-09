import { createContext, useContext } from "react";

import type { CanvasEdgeRunOverlay, CanvasRunOverlay } from "./workflow-run-overlay";
import type { CanvasEdgeRuntimeState, ProjectedCanvasNode } from "./workflow-run-projection";

/**
 * Read-only projection of the active official workflow run onto the canvas. Both maps are provided by
 * `app.tsx` from the runtime's own snapshot/graph/events and consumed by the node and edge views, so a
 * real node or edge reflects the run's truth without the store ever persisting a runtime state. When no
 * run is active the maps are empty and elements render their own canvas state.
 */
export const WorkflowRunNodeContext = createContext<CanvasRunOverlay>(new Map());

export const WorkflowRunEdgeContext = createContext<CanvasEdgeRunOverlay>(new Map());

export function useNodeRunOverlay(nodeId: string): ProjectedCanvasNode | undefined {
  return useContext(WorkflowRunNodeContext).get(nodeId);
}

export function useEdgeRunState(edgeId: string): CanvasEdgeRuntimeState | undefined {
  return useContext(WorkflowRunEdgeContext).get(edgeId);
}
