import { createContext, useContext } from "react";

import type { TerminalSession } from "@forgedeck/schemas";

export interface TerminalNodeContextValue {
  readonly sessionsByNode: Readonly<Record<string, TerminalSession>>;
  readonly errorsByNode: Readonly<Record<string, string>>;
  readonly startingNodeIds: ReadonlySet<string>;
  readonly activeNodeIds: ReadonlySet<string>;
  readonly clearEpochsByNode: Readonly<Record<string, number>>;
  connectNode(nodeId: string, adapterId: string | undefined): void;
  interruptSession(nodeId: string, sessionId: string): void;
  reportNodeError(nodeId: string, message: string): void;
}

export const TerminalNodeContext = createContext<TerminalNodeContextValue | null>(null);

export function useTerminalNodeContext(): TerminalNodeContextValue {
  const context = useContext(TerminalNodeContext);
  if (context === null) {
    throw new Error("Terminal nodes must be rendered inside a terminal context");
  }
  return context;
}
