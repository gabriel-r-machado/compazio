import { memo } from "react";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, MarkerType } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

import { useEdgeConversation } from "./agent-conversation-context";
import type { ForgeFlowEdge } from "./canvas-store";
import { useEdgeRunState } from "./workflow-run-node-context";

function ContractEdgeView(props: EdgeProps<ForgeFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const label = props.data?.label || props.data?.kind || "dependency";
  // Official run state for this edge, projected from the runtime's dependency graph. It is a stable
  // structural attribute matched by the source/target workflowNodeIds — never inferred from PTY,
  // node position or visual text. Undefined for unbound or ghost edges, which stay unstyled.
  const runtimeState = useEdgeRunState(props.id);
  // Where the latest exchange between these two agents stands, from the durable message store. A
  // separate axis from the run overlay above: this is the free canvas talking to itself.
  const conversation = useEdgeConversation(props.id);
  return (
    <>
      <BaseEdge
        id={props.id}
        className={
          [
            runtimeState === undefined ? "" : `edge-runtime edge-runtime-${runtimeState}`,
            conversation === undefined
              ? ""
              : `edge-conversation edge-conversation-${conversation.state}`
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        interactionWidth={72}
        path={path}
        markerEnd={props.markerEnd ?? MarkerType.ArrowClosed}
      />
      <EdgeLabelRenderer>
        <span
          className={`edge-contract-label nodrag nopan${
            runtimeState === undefined
              ? ""
              : ` edge-contract-label-run edge-contract-label-run-${runtimeState}`
          }`}
          data-edge-id={props.id}
          {...(runtimeState === undefined ? {} : { "data-edge-runtime-state": runtimeState })}
          {...(conversation === undefined
            ? {}
            : {
                "data-edge-conversation-state": conversation.state,
                "data-edge-conversation-attempt": String(conversation.attempt)
              })}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

export const ContractEdge = memo(ContractEdgeView);
