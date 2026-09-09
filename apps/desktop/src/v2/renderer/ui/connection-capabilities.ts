import type { CanvasNode, EdgeCapability } from "@forgedeck/compazio-v2-domain";

export interface CanvasConnectionGrant {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly capabilities: readonly EdgeCapability[];
}

/**
 * Converts one explicit canvas gesture into the smallest useful capability grant.
 * Terminal-to-terminal messaging is bidirectional at the broker; resource capabilities remain
 * directed from the terminal to the connected resource.
 */
export function connectionFor(first: CanvasNode, second: CanvasNode): CanvasConnectionGrant {
  if (first.type === "terminal" && second.type === "terminal") {
    return {
      sourceNodeId: first.id,
      targetNodeId: second.id,
      capabilities: ["send-message", "share-context"]
    };
  }
  const terminal = first.type === "terminal" ? first : second.type === "terminal" ? second : null;
  const resource = terminal?.id === first.id ? second : first;
  if (terminal !== null && resource.type === "portal") {
    return {
      sourceNodeId: terminal.id,
      targetNodeId: resource.id,
      capabilities: ["portal-read", "portal-control", "portal-screenshot", "share-context"]
    };
  }
  if (terminal !== null && resource.type === "note") {
    return {
      sourceNodeId: terminal.id,
      targetNodeId: resource.id,
      capabilities: ["read-note", "write-note", "share-context"]
    };
  }
  if (terminal !== null && (resource.type === "file-tree" || resource.type === "file-preview")) {
    return {
      sourceNodeId: terminal.id,
      targetNodeId: resource.id,
      capabilities: ["share-context"]
    };
  }
  return {
    sourceNodeId: first.id,
    targetNodeId: second.id,
    capabilities: ["share-context"]
  };
}
