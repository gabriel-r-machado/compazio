import { defaultTerminalAgentConfig, defaultWorkspacePermissionPolicy } from "./agents";
import { LEGACY_COORDINATOR_FLAG } from "./legacy-coordinator-compat";
import { defaultWorkspaceSettings, type Workspace } from "./model";
import { assertWorkspace } from "./workspace";

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * V2 starts with a small, explicit v0-to-v1 migration so persisted data always has a versioned
 * path. The migration is deliberately narrow: it adds only the settings/version fields V0 lacked.
 *
 * v9 renamed the coordinating-terminal flag to `isCompazio`. v10 keeps those fields only for
 * backward-compatible, feature-gated history; the normal terminal and connection runtime ignores
 * ownership and gives every supported coding-agent terminal its own session-scoped protocol.
 * Because the terminal node
 * schema is strict, the legacy key has to be dropped, not just shadowed.
 */
export function migrateWorkspace(raw: unknown): Workspace {
  if (!isRecord(raw)) {
    throw new Error("Workspace file must contain an object");
  }
  const version = raw.schemaVersion;
  if (version === 10) {
    return assertWorkspace(stripOrphanEdges(raw));
  }
  if (
    version === undefined ||
    version === 0 ||
    version === 1 ||
    version === 2 ||
    version === 3 ||
    version === 4 ||
    version === 5 ||
    version === 6 ||
    version === 7 ||
    version === 8 ||
    version === 9
  ) {
    const migrated = {
      ...raw,
      schemaVersion: 10,
      settings: raw.settings ?? defaultWorkspaceSettings(),
      permissions: raw.permissions ?? defaultWorkspacePermissionPolicy(),
      nodes: Array.isArray(raw.nodes)
        ? raw.nodes.map((node) => {
            if (!isRecord(node) || node.type !== "terminal") return node;
            const coordinates =
              node.isCompazio === true ||
              node[LEGACY_COORDINATOR_FLAG] === true ||
              node.orchestrator === true;
            const rest = Object.fromEntries(
              Object.entries(node).filter(([key]) => key !== LEGACY_COORDINATOR_FLAG)
            );
            return {
              ...rest,
              agentConfig:
                node.agentConfig ??
                (isRecord(node.launchConfig) && typeof node.launchConfig.command === "string"
                  ? { agentId: "custom" }
                  : defaultTerminalAgentConfig()),
              isCompazio: coordinates,
              orchestrator: coordinates
            };
          })
        : raw.nodes,
      edges: Array.isArray(raw.edges)
        ? raw.edges.map((edge) =>
            isRecord(edge)
              ? { ...edge, capabilities: Array.isArray(edge.capabilities) ? edge.capabilities : [] }
              : edge
          )
        : raw.edges,
      groups: Array.isArray(raw.groups) ? raw.groups : []
    };
    return assertWorkspace(stripOrphanEdges(migrated));
  }
  throw new Error(`Unsupported workspace schema version: ${String(version)}`);
}

/** Remove only edges whose referenced node has disappeared; malformed edges remain a validation error. */
function stripOrphanEdges(value: UnknownRecord): UnknownRecord {
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return value;
  const nodeIds = new Set(
    value.nodes.flatMap((node) => (isRecord(node) && typeof node.id === "string" ? [node.id] : []))
  );
  return {
    ...value,
    edges: value.edges.filter((edge) => {
      if (!isRecord(edge)) return true;
      if (typeof edge.sourceNodeId !== "string" || typeof edge.targetNodeId !== "string") {
        return true;
      }
      return nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId);
    })
  };
}
