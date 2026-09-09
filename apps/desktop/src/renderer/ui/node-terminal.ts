import type { ForgeFlowNode } from "./canvas-store";

export function isTerminalBackedNode(
  type: ForgeFlowNode["type"] | undefined,
  adapterId: string | undefined
): boolean {
  return type === "terminal" || (type === "agent" && adapterId !== undefined);
}
