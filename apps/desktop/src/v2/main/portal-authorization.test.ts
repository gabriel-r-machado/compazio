import {
  addPortalNode,
  addTerminalNode,
  addVisualEdge,
  createWorkspace,
  removeEdge,
  removeNode,
  type Workspace
} from "@forgedeck/compazio-v2-domain";
import { describe, expect, it } from "vitest";

import {
  authorizePortalControl,
  diffRevokedPortalControl,
  hasPortalControl,
  listPortalControlGrants
} from "./portal-authorization";

let counter = 0;
const dependencies = {
  createId: () => `id-${++counter}`,
  now: () => new Date(1_700_000_000_000 + counter).toISOString()
};

interface Scene {
  readonly workspace: Workspace;
  readonly orchestratorId: string;
  readonly recruitId: string;
  readonly portalId: string;
}

function scene(options: { connect?: "orchestrator" | "recruit"; capability?: string } = {}): Scene {
  let workspace = createWorkspace(
    { name: "Portais", workingDirectory: "C:/tmp/portais" },
    dependencies
  );
  workspace = addTerminalNode(workspace, { title: "Líder", orchestrator: true }, dependencies);
  workspace = addTerminalNode(workspace, { title: "Recruta" }, dependencies);
  workspace = addPortalNode(workspace, { url: "http://127.0.0.1:4100/" }, dependencies);
  const terminals = workspace.nodes.filter((node) => node.type === "terminal");
  const orchestratorId = terminals[0]?.id ?? "";
  const recruitId = terminals[1]?.id ?? "";
  const portalId = workspace.nodes.find((node) => node.type === "portal")?.id ?? "";
  if (options.connect !== undefined)
    workspace = addVisualEdge(
      workspace,
      options.connect === "orchestrator" ? orchestratorId : recruitId,
      portalId,
      dependencies,
      [(options.capability ?? "portal-control") as "portal-control"]
    );
  return { workspace, orchestratorId, recruitId, portalId };
}

describe("portal control authorization", () => {
  it("refuses control when no connection carries portal-control", () => {
    const { workspace, recruitId, portalId } = scene();
    expect(
      authorizePortalControl(workspace, { terminalNodeId: recruitId, portalId })
    ).toMatchObject({ ok: false, code: "PORTAL_NOT_CONNECTED" });
  });

  it("grants control to the connected terminal only", () => {
    const { workspace, orchestratorId, recruitId, portalId } = scene({ connect: "recruit" });
    expect(
      authorizePortalControl(workspace, { terminalNodeId: recruitId, portalId })
    ).toMatchObject({ ok: true });
    expect(
      authorizePortalControl(workspace, { terminalNodeId: orchestratorId, portalId })
    ).toMatchObject({ ok: false, code: "PORTAL_NOT_CONNECTED" });
  });

  it("does not treat the orchestrator rank as an implicit grant", () => {
    const { workspace, orchestratorId, portalId } = scene({ connect: "recruit" });
    const orchestrator = workspace.nodes.find((node) => node.id === orchestratorId);
    expect(orchestrator?.type === "terminal" && orchestrator.orchestrator).toBe(true);
    expect(hasPortalControl(workspace, { terminalNodeId: orchestratorId, portalId })).toBe(false);
  });

  it("grants control to a connected orchestrator like any other terminal", () => {
    const { workspace, orchestratorId, portalId } = scene({ connect: "orchestrator" });
    expect(
      authorizePortalControl(workspace, { terminalNodeId: orchestratorId, portalId })
    ).toMatchObject({ ok: true });
  });

  it("ignores a connection that lacks the portal-control capability", () => {
    const { workspace, recruitId, portalId } = scene({
      connect: "recruit",
      capability: "share-context"
    });
    expect(
      authorizePortalControl(workspace, { terminalNodeId: recruitId, portalId })
    ).toMatchObject({ ok: false, code: "PORTAL_NOT_CONNECTED" });
  });

  it("ignores the reversed direction of a connection", () => {
    const { workspace, recruitId, portalId } = scene();
    const reversed = addVisualEdge(workspace, portalId, recruitId, dependencies, [
      "portal-control"
    ]);
    expect(authorizePortalControl(reversed, { terminalNodeId: recruitId, portalId })).toMatchObject(
      { ok: false, code: "PORTAL_NOT_CONNECTED" }
    );
  });

  it("reports an unknown portal apart from a missing connection", () => {
    const { workspace, recruitId } = scene();
    expect(
      authorizePortalControl(workspace, { terminalNodeId: recruitId, portalId: "ausente" })
    ).toMatchObject({ ok: false, code: "PORTAL_NOT_FOUND" });
  });

  it("refuses control over a node that is not a Portal", () => {
    const { workspace, recruitId, orchestratorId } = scene();
    const connected = addVisualEdge(workspace, recruitId, orchestratorId, dependencies, [
      "portal-control"
    ]);
    expect(
      authorizePortalControl(connected, { terminalNodeId: recruitId, portalId: orchestratorId })
    ).toMatchObject({ ok: false, code: "PORTAL_NOT_FOUND" });
    expect(listPortalControlGrants(connected)).toHaveLength(0);
  });

  it("revokes control when the connection is removed", () => {
    const { workspace, recruitId, portalId } = scene({ connect: "recruit" });
    const edgeId = workspace.edges[0]?.id ?? "";
    const revoked = removeEdge(workspace, edgeId, dependencies);
    expect(authorizePortalControl(revoked, { terminalNodeId: recruitId, portalId })).toMatchObject({
      ok: false,
      code: "PORTAL_NOT_CONNECTED"
    });
    expect(diffRevokedPortalControl(workspace, revoked)).toEqual([
      { terminalNodeId: recruitId, portalId }
    ]);
  });

  it("revokes control when the terminal or the Portal is deleted", () => {
    const { workspace, recruitId, portalId } = scene({ connect: "recruit" });
    const withoutTerminal = removeNode(workspace, recruitId, dependencies);
    const withoutPortal = removeNode(workspace, portalId, dependencies);
    expect(diffRevokedPortalControl(workspace, withoutTerminal)).toEqual([
      { terminalNodeId: recruitId, portalId }
    ]);
    expect(diffRevokedPortalControl(workspace, withoutPortal)).toEqual([
      { terminalNodeId: recruitId, portalId }
    ]);
    expect(
      authorizePortalControl(withoutPortal, { terminalNodeId: recruitId, portalId })
    ).toMatchObject({ ok: false, code: "PORTAL_NOT_FOUND" });
  });

  it("reports no revocation while the grant stands", () => {
    const { workspace, portalId, recruitId } = scene({ connect: "recruit" });
    expect(diffRevokedPortalControl(workspace, workspace)).toEqual([]);
    expect(listPortalControlGrants(workspace)).toEqual([{ terminalNodeId: recruitId, portalId }]);
  });
});
