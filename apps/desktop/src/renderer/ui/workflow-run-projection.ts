import type {
  WorkflowRunEvent,
  WorkflowRunGraphDto,
  WorkflowRunSnapshotDto
} from "@forgedeck/schemas";

/**
 * Pure projection of an official workflow-run snapshot onto the canvas. It never infers state from
 * terminal text, timers or optimistic UI: every field is derived from the runtime's own snapshot,
 * dependency graph and structured events. The renderer renders this and nothing else — there is no
 * parallel state machine here.
 */

/** Minimal visual states derived from documented official data (not new domain states). */
export type CanvasNodeRuntimeState =
  "idle" | "queued" | "blocked" | "running" | "retrying" | "succeeded" | "failed" | "cancelled";

export type CanvasEdgeRuntimeState =
  | "pending"
  | "waiting-upstream"
  | "context-available"
  | "context-consumed"
  | "blocked-by-failure"
  | "blocked-by-cancellation";

export interface ProjectedArtifactRef {
  readonly artifactId: string;
  readonly sha256: string | null;
  readonly fromNodeId?: string;
}

export interface ProjectedCanvasNode {
  readonly nodeId: string;
  readonly title: string;
  readonly type: string | null;
  readonly runtimeState: CanvasNodeRuntimeState;
  /** Official node state, kept verbatim for the inspector. */
  readonly officialState: WorkflowRunSnapshotDto["nodeRuns"][number]["state"];
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly shortError: string | null;
  readonly blockingDependencies: readonly string[];
  readonly producedArtifacts: readonly ProjectedArtifactRef[];
  readonly consumedArtifacts: readonly ProjectedArtifactRef[];
  readonly isRetrying: boolean;
  /** Interrupted by an application restart and recovered on reload; needs a human decision. */
  readonly isRecovered: boolean;
}

export interface ProjectedCanvasEdge {
  readonly from: string;
  readonly to: string;
  readonly state: CanvasEdgeRuntimeState;
}

export interface ProjectedWorkflowRun {
  readonly runId: string | null;
  readonly runState: WorkflowRunSnapshotDto["state"] | "idle";
  readonly hasReport: boolean;
  readonly nodes: readonly ProjectedCanvasNode[];
  readonly edges: readonly ProjectedCanvasEdge[];
}

type OfficialNodeState = WorkflowRunSnapshotDto["nodeRuns"][number]["state"];

interface EvidenceLike {
  readonly id: string;
  readonly type: string | undefined;
  readonly artifact_id: string | undefined;
  readonly metadata: Record<string, unknown> | undefined;
}

/**
 * Projects an official run snapshot (plus its dependency graph and events, when available) to the
 * canvas. When there is no run for a workflow, every declared node projects as `idle`. The function
 * is total and side-effect free.
 */
export function projectWorkflowRunToCanvas(
  snapshot: WorkflowRunSnapshotDto | null,
  graph: WorkflowRunGraphDto | null,
  events: readonly WorkflowRunEvent[] = []
): ProjectedWorkflowRun {
  if (snapshot === null) {
    const nodes = (graph?.nodes ?? []).map<ProjectedCanvasNode>((node) => ({
      nodeId: node.id,
      title: node.title ?? node.id,
      type: node.type,
      runtimeState: "idle",
      officialState: "pending",
      attempt: 0,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      shortError: null,
      blockingDependencies: [],
      producedArtifacts: [],
      consumedArtifacts: [],
      isRetrying: false,
      isRecovered: false
    }));
    return { runId: null, runState: "idle", hasReport: false, nodes, edges: [] };
  }

  const dependsOn = new Map<string, readonly string[]>(
    (graph?.nodes ?? []).map((node) => [node.id, node.dependsOn])
  );
  const titles = new Map<string, { title: string; type: string | null }>(
    (graph?.nodes ?? []).map((node) => [node.id, { title: node.title ?? node.id, type: node.type }])
  );
  const stateByNodeId = new Map<string, OfficialNodeState>(
    snapshot.nodeRuns.map((node) => [node.nodeId, node.state])
  );
  const timing = deriveNodeTiming(snapshot, events);
  const retriedNodeIds = deriveRetriedNodeIds(snapshot, events);

  const nodes = snapshot.nodeRuns.map<ProjectedCanvasNode>((node) => {
    const deps = dependsOn.get(node.nodeId) ?? [];
    const blockingDependencies = deps.filter(
      (dependency) => (stateByNodeId.get(dependency) ?? "pending") !== "succeeded"
    );
    const runtimeState = deriveRuntimeState(node.state, {
      hasUnsatisfiedDependencies: blockingDependencies.length > 0,
      attempt: node.attempt,
      retried: retriedNodeIds.has(node.nodeId)
    });
    const times = timing.get(node.nodeId) ?? { startedAt: null, endedAt: null };
    const meta = titles.get(node.nodeId);
    const evidence = normalizeEvidence(node.evidence);
    return {
      nodeId: node.nodeId,
      title: meta?.title ?? node.nodeId,
      type: meta?.type ?? null,
      runtimeState,
      officialState: node.state,
      attempt: node.attempt,
      startedAt: times.startedAt,
      endedAt: times.endedAt,
      durationMs: durationBetween(times.startedAt, times.endedAt),
      shortError: node.failureReason,
      blockingDependencies,
      producedArtifacts: producedArtifacts(evidence),
      consumedArtifacts: consumedArtifacts(evidence),
      isRetrying: runtimeState === "retrying",
      isRecovered: node.state === "interrupted"
    };
  });

  const edges = projectEdges(dependsOn, stateByNodeId, nodes);
  return {
    runId: snapshot.id,
    runState: snapshot.state,
    hasReport: snapshot.reportArtifact !== null && snapshot.reportArtifact !== undefined,
    nodes,
    edges
  };
}

/** Documented mapping from the official node state to a minimal visual state. */
function deriveRuntimeState(
  state: OfficialNodeState,
  context: {
    readonly hasUnsatisfiedDependencies: boolean;
    readonly attempt: number;
    readonly retried: boolean;
  }
): CanvasNodeRuntimeState {
  switch (state) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      // An application-restart interruption is a stopped, not-failed state needing a human decision.
      return "cancelled";
    case "running":
    case "starting":
      return context.retried || context.attempt > 1 ? "retrying" : "running";
    case "blocked":
    case "waiting":
    case "skipped":
      return "blocked";
    case "pending":
    case "ready":
    default:
      return context.hasUnsatisfiedDependencies ? "blocked" : "queued";
  }
}

function projectEdges(
  dependsOn: ReadonlyMap<string, readonly string[]>,
  stateByNodeId: ReadonlyMap<string, OfficialNodeState>,
  nodes: readonly ProjectedCanvasNode[]
): ProjectedCanvasEdge[] {
  const consumedByNode = new Map<string, Set<string>>(
    nodes.map((node) => [
      node.nodeId,
      new Set(
        node.consumedArtifacts
          .map((artifact) => artifact.fromNodeId)
          .filter((value): value is string => value !== undefined)
      )
    ])
  );
  const edges: ProjectedCanvasEdge[] = [];
  for (const [nodeId, deps] of dependsOn) {
    for (const dependency of deps) {
      edges.push({
        from: dependency,
        to: nodeId,
        state: deriveEdgeState(
          stateByNodeId.get(dependency) ?? "pending",
          consumedByNode.get(nodeId)?.has(dependency) ?? false
        )
      });
    }
  }
  return edges;
}

function deriveEdgeState(
  dependencyState: OfficialNodeState,
  consumed: boolean
): CanvasEdgeRuntimeState {
  switch (dependencyState) {
    case "failed":
      return "blocked-by-failure";
    case "cancelled":
    case "interrupted":
      return "blocked-by-cancellation";
    case "succeeded":
      return consumed ? "context-consumed" : "context-available";
    case "running":
    case "starting":
    case "waiting":
    case "blocked":
      return "waiting-upstream";
    default:
      return "pending";
  }
}

function deriveNodeTiming(
  snapshot: WorkflowRunSnapshotDto,
  events: readonly WorkflowRunEvent[]
): Map<string, { startedAt: string | null; endedAt: string | null }> {
  const nodeIdByRunId = new Map(snapshot.nodeRuns.map((node) => [node.id, node.nodeId]));
  const timing = new Map<string, { startedAt: string | null; endedAt: string | null }>();
  for (const event of events) {
    if (event.nodeRunId === null) continue;
    const nodeId = nodeIdByRunId.get(event.nodeRunId);
    if (nodeId === undefined) continue;
    const current = timing.get(nodeId) ?? { startedAt: null, endedAt: null };
    if (event.type === "node.started" && current.startedAt === null) {
      current.startedAt = event.timestamp;
    }
    if (
      event.type === "node.succeeded" ||
      event.type === "node.failed" ||
      event.type === "node.cancelled"
    ) {
      current.endedAt = event.timestamp;
    }
    timing.set(nodeId, current);
  }
  return timing;
}

function deriveRetriedNodeIds(
  snapshot: WorkflowRunSnapshotDto,
  events: readonly WorkflowRunEvent[]
): Set<string> {
  const nodeIdByRunId = new Map(snapshot.nodeRuns.map((node) => [node.id, node.nodeId]));
  const retried = new Set<string>();
  for (const event of events) {
    if (event.type !== "node.retry_scheduled" || event.nodeRunId === null) continue;
    const nodeId = nodeIdByRunId.get(event.nodeRunId);
    if (nodeId !== undefined) retried.add(nodeId);
  }
  return retried;
}

function durationBetween(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function normalizeEvidence(evidence: readonly unknown[]): EvidenceLike[] {
  const result: EvidenceLike[] = [];
  for (const entry of evidence) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] !== "string") continue;
    result.push({
      id: record["id"],
      type: typeof record["type"] === "string" ? record["type"] : undefined,
      artifact_id: typeof record["artifact_id"] === "string" ? record["artifact_id"] : undefined,
      metadata:
        typeof record["metadata"] === "object" && record["metadata"] !== null
          ? (record["metadata"] as Record<string, unknown>)
          : undefined
    });
  }
  return result;
}

function producedArtifacts(evidence: readonly EvidenceLike[]): ProjectedArtifactRef[] {
  const produced: ProjectedArtifactRef[] = [];
  for (const entry of evidence) {
    if (!entry.id.startsWith("published-")) continue;
    const artifactId = stringField(entry.metadata, "artifactId") ?? entry.artifact_id;
    if (artifactId === undefined) continue;
    produced.push({ artifactId, sha256: stringField(entry.metadata, "sha256") ?? null });
  }
  return produced;
}

function consumedArtifacts(evidence: readonly EvidenceLike[]): ProjectedArtifactRef[] {
  const consumed: ProjectedArtifactRef[] = [];
  for (const entry of evidence) {
    if (!entry.id.startsWith("consumed-")) continue;
    const artifactId = stringField(entry.metadata, "consumedArtifactId") ?? entry.artifact_id;
    if (artifactId === undefined) continue;
    consumed.push({
      artifactId,
      sha256: stringField(entry.metadata, "sha256") ?? null,
      fromNodeId: entry.id.slice("consumed-".length)
    });
  }
  return consumed;
}

function stringField(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (metadata === undefined) return undefined;
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}
