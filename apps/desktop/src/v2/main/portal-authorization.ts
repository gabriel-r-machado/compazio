import type { EdgeCapability, PortalNode, Workspace } from "@forgedeck/compazio-v2-domain";

export type PortalAuthorizationCode = "PORTAL_NOT_FOUND" | "PORTAL_NOT_CONNECTED";

export type PortalAuthorization =
  | { readonly ok: true; readonly portal: PortalNode }
  | { readonly ok: false; readonly code: PortalAuthorizationCode; readonly message: string };

export interface PortalControlGrant {
  readonly terminalNodeId: string;
  readonly portalId: string;
}

export type PortalAccessCapability =
  "portal-read" | "portal-control" | "portal-screenshot" | "portal-close";

/**
 * Portal control is granted by an explicit canvas connection, never by a terminal's rank. An
 * orchestrator is still a terminal: without a directed edge carrying `portal-control` it sees the
 * same refusal a recruit sees, so the canvas stays the only place where browser access is handed out.
 */
export function authorizePortalControl(
  workspace: Workspace,
  input: PortalControlGrant
): PortalAuthorization {
  const portal = workspace.nodes.find(
    (node): node is PortalNode => node.id === input.portalId && node.type === "portal"
  );
  if (portal === undefined)
    return { ok: false, code: "PORTAL_NOT_FOUND", message: "Portal não encontrado." };
  if (!hasPortalControl(workspace, input))
    return {
      ok: false,
      code: "PORTAL_NOT_CONNECTED",
      message: "Conecte este terminal ao Portal com a capacidade portal-control."
    };
  return { ok: true, portal };
}

export function hasPortalControl(workspace: Workspace, input: PortalControlGrant): boolean {
  return hasPortalCapability(workspace, input, "portal-control");
}

/**
 * Capability checks are per edge and per Portal. `portal-control` is a stronger grant than
 * `portal-read`, preserving existing canvases while never making a terminal a browser admin.
 */
export function hasPortalCapability(
  workspace: Workspace,
  input: PortalControlGrant,
  capability: PortalAccessCapability
): boolean {
  return workspace.edges.some((edge) => {
    if (edge.sourceNodeId !== input.terminalNodeId || edge.targetNodeId !== input.portalId)
      return false;
    if (capability === "portal-read")
      return (
        edge.capabilities.includes("portal-read") || edge.capabilities.includes("portal-control")
      );
    return edge.capabilities.includes(capability as EdgeCapability);
  });
}

export function listPortalCapabilities(
  workspace: Workspace,
  terminalNodeId: string
): readonly PortalAccessCapability[] {
  const capabilities = new Set<PortalAccessCapability>();
  for (const edge of workspace.edges) {
    if (edge.sourceNodeId !== terminalNodeId) continue;
    if (edge.capabilities.includes("portal-read") || edge.capabilities.includes("portal-control"))
      capabilities.add("portal-read");
    if (edge.capabilities.includes("portal-control")) capabilities.add("portal-control");
    if (edge.capabilities.includes("portal-screenshot")) capabilities.add("portal-screenshot");
    if (edge.capabilities.includes("portal-close")) capabilities.add("portal-close");
  }
  return [...capabilities];
}

export function listPortalControlGrants(workspace: Workspace): readonly PortalControlGrant[] {
  const portalIds = new Set(
    workspace.nodes.filter((node) => node.type === "portal").map((node) => node.id)
  );
  return workspace.edges
    .filter(
      (edge) => edge.capabilities.includes("portal-control") && portalIds.has(edge.targetNodeId)
    )
    .map((edge) => ({ terminalNodeId: edge.sourceNodeId, portalId: edge.targetNodeId }));
}

/**
 * Grants that existed before and no longer do. Deleting the edge, the terminal or the Portal all
 * collapse into the same answer, which is what the runtime needs to cancel operations already in
 * flight instead of only refusing the next one.
 */
export function diffRevokedPortalControl(
  previous: Workspace,
  next: Workspace
): readonly PortalControlGrant[] {
  const current = new Set(
    listPortalControlGrants(next).map((grant) => `${grant.terminalNodeId}:${grant.portalId}`)
  );
  return listPortalControlGrants(previous).filter(
    (grant) => !current.has(`${grant.terminalNodeId}:${grant.portalId}`)
  );
}
