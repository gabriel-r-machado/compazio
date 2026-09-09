export interface ContextMenuActionTarget {
  readonly kind: "node" | "edge" | "selection";
  readonly id?: string;
}

/**
 * Context-menu actions must follow the element that raised the event, not the
 * canvas selection, which may already contain that element.
 */
export function contextMenuNodeId(target: ContextMenuActionTarget | null): string | null {
  return target?.kind === "node" && typeof target.id === "string" ? target.id : null;
}
