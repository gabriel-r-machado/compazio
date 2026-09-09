import Database from "better-sqlite3";

import {
  canvasNodeDataSchema,
  edgeContractSchema,
  workspaceAgentContextSchema
} from "@forgedeck/schemas";
import type { WorkspaceAgentContext, WorkspaceContextSource } from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";

interface WorkspaceRow {
  readonly canvas_id: string;
  readonly mission: string;
}

interface NodeRow {
  readonly id: string;
  readonly type: string;
  readonly data_json: string;
}

/** Canvas node types that can carry material into an agent's context. */
const MATERIAL_NODE_TYPES =
  "('note', 'artifact', 'text', 'link', 'file', 'folder', 'image', 'drawing', 'page')" as const;

/**
 * How far a chain of connected materials is followed. Deep enough for the mind-map shapes people
 * actually draw, finite so a malformed canvas cannot make resolving context unbounded work.
 */
const MAX_CONTEXT_CHAIN_DEPTH = 8;

interface ContextSourceRow {
  readonly node_id: string;
  readonly type: string;
  readonly data_json: string;
  readonly edge_id: string;
  readonly contract_json: string;
}

export interface ResolveWorkspaceAgentContextInput {
  readonly workspaceId: string;
  readonly agentNodeId: string;
  readonly requesterNodeId: string | null;
  /** Internal context selection retains excluded sources for its immutable audit snapshot. */
  readonly includeNever?: boolean;
}

/**
 * Resolves the context a canvas explicitly exposes to one agent: materials wired into it, plus
 * materials wired into those, so a chain of notes reaches the agent through the one connection that
 * anchors it. Only edges drawn on the canvas grant anything — this store never invokes an adapter,
 * never follows agent-to-agent edges, and never treats terminal output as context.
 */
export class SqliteWorkspaceContextStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
  }

  public resolve(input: ResolveWorkspaceAgentContextInput): WorkspaceAgentContext {
    this.policy.assertAllowed({
      workspaceId: input.workspaceId,
      actorNodeId: input.requesterNodeId,
      permission: "read_context"
    });
    const workspace = this.requireWorkspace(input.workspaceId);
    const agent = this.requireAgentNode(workspace.canvas_id, input.agentNodeId, "target");
    if (input.requesterNodeId !== null) {
      if (input.requesterNodeId !== input.agentNodeId) {
        throw new Error("An agent can only read context connected to itself");
      }
    }

    // Materials chain: a note wired into another note reaches the agent through it. That is what
    // makes one connection enough to hand over a whole tree of context, instead of forcing the person
    // to wire every leaf to every agent. The walk is bounded and de-duplicated, so a cycle drawn on
    // the canvas terminates rather than looping — a cycle merely re-reaches nodes at greater depths,
    // and each material is then kept once, via its shortest path. Edges whose kind carries its own meaning — a
    // reviewed `handoff`, an `approval` gate — are not traversed and never admitted.
    //
    // A material marked `never` prunes the branch behind it rather than only removing itself.
    // Excluding a note and still handing over everything it anchors would defeat the exclusion the
    // person asked for. The audit path (`includeNever`) walks everything, because its job is to
    // record what was considered as well as what was used.
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE reachable(node_id, edge_id, contract_json, depth) AS (
           SELECT n.id, e.id, e.contract_json, 0
           FROM canvas_edges e
           JOIN canvas_nodes n ON n.canvas_id = e.canvas_id AND n.id = e.source_node_id
           WHERE e.canvas_id = :canvas AND e.target_node_id = :agent
             AND n.type IN ${MATERIAL_NODE_TYPES}
             AND json_extract(e.contract_json, '$.kind') NOT IN ('handoff', 'approval')
             AND (:includeNever = 1 OR json_extract(n.data_json, '$.contextInclusion') IS NOT 'never')
           UNION
           SELECT n.id, e.id, e.contract_json, r.depth + 1
           FROM reachable r
           JOIN canvas_edges e ON e.canvas_id = :canvas AND e.target_node_id = r.node_id
           JOIN canvas_nodes n ON n.canvas_id = e.canvas_id AND n.id = e.source_node_id
           WHERE n.type IN ${MATERIAL_NODE_TYPES}
             AND json_extract(e.contract_json, '$.kind') NOT IN ('handoff', 'approval')
             AND (:includeNever = 1 OR json_extract(n.data_json, '$.contextInclusion') IS NOT 'never')
             AND r.depth < ${String(MAX_CONTEXT_CHAIN_DEPTH)}
         )
         SELECT r.node_id, n.type, n.data_json, r.edge_id, r.contract_json
         FROM (
           SELECT node_id, edge_id, contract_json, MIN(depth) AS depth
           FROM reachable GROUP BY node_id
         ) r
         JOIN canvas_nodes n ON n.canvas_id = :canvas AND n.id = r.node_id
         ORDER BY r.depth, r.edge_id`
      )
      .all({
        canvas: workspace.canvas_id,
        agent: input.agentNodeId,
        includeNever: input.includeNever === true ? 1 : 0
      }) as ContextSourceRow[];

    const sources: WorkspaceContextSource[] = [];
    for (const row of rows) {
      const contract = edgeContractSchema.parse(JSON.parse(row.contract_json) as unknown);
      // A material (note/artifact/context-source) connected into an agent-capable node is
      // treated as context regardless of edge kind, except when the kind carries its own distinct
      // meaning: a "handoff" is a reviewed delivery to another agent, an "approval" is a gate —
      // neither implicitly grants context. "dependency" is included because the canvas UI drew
      // plain "depends on" edges from materials before this default existed; existing canvases
      // must not silently stop working once this ships.
      if (contract.kind === "handoff" || contract.kind === "approval") continue;
      const data = canvasNodeDataSchema.parse(JSON.parse(row.data_json) as unknown);
      if (data.contextInclusion === "never" && input.includeNever !== true) continue;
      const base = {
        nodeId: row.node_id,
        title: data.title,
        inclusion: data.contextInclusion ?? "relevant",
        edgeId: row.edge_id,
        contract
      };
      if (row.type === "note") {
        sources.push({ ...base, kind: "note", content: data.content ?? data.summary });
        continue;
      }
      if (row.type === "artifact") {
        if (data.artifact === undefined) {
          throw new Error("Workspace artifact context source is incomplete");
        }
        sources.push({
          ...base,
          kind: "artifact",
          artifact: this.requirePublishedArtifact(input.workspaceId, data.artifact)
        });
        continue;
      }
      if (data.contextSource === undefined || data.contextSource.kind !== row.type) {
        throw new Error("Workspace context source metadata is incomplete");
      }
      sources.push({
        ...base,
        kind: data.contextSource.kind,
        ...(data.contextSource.content === undefined
          ? {}
          : { content: data.contextSource.content }),
        reference: {
          kind: data.contextSource.kind,
          ...(data.contextSource.url === undefined ? {} : { url: data.contextSource.url }),
          ...(data.contextSource.filename === undefined
            ? {}
            : { filename: data.contextSource.filename }),
          ...(data.contextSource.sha256 === undefined ? {} : { sha256: data.contextSource.sha256 }),
          ...(data.contextSource.mediaType === undefined
            ? {}
            : { mediaType: data.contextSource.mediaType }),
          ...(data.contextSource.previewDataUri === undefined
            ? {}
            : { previewDataUri: data.contextSource.previewDataUri })
        }
      });
    }

    return workspaceAgentContextSchema.parse({
      workspaceId: input.workspaceId,
      agentNodeId: input.agentNodeId,
      mission: workspace.mission,
      // The role is stored on the agent's own node, so it travels with the context the agent reads
      // rather than being a canvas label the running process never learns about. Permissions travel
      // for the same reason: they decide what the session is told it can do.
      ...(agent.role === undefined ? {} : { role: agent.role }),
      permissions: agent.permissions,
      sources
    });
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const workspace = this.sqlite
      .prepare(
        `SELECT w.canvas_id, c.mission
         FROM workspaces w JOIN canvases c ON c.id = w.canvas_id WHERE w.id = ?`
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    if (workspace === undefined) throw new Error("Workspace context workspace was not found");
    return workspace;
  }

  private requirePublishedArtifact(
    workspaceId: string,
    artifact: NonNullable<ReturnType<typeof canvasNodeDataSchema.parse>["artifact"]>
  ): {
    readonly id: string;
    readonly kind: string;
    readonly relativePath: string;
    readonly filename: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly mediaType: string;
  } {
    const row = this.sqlite
      .prepare(
        `SELECT id, kind, relative_path, filename, sha256, byte_size, media_type
         FROM workspace_artifacts WHERE workspace_id = ? AND id = ?`
      )
      .get(workspaceId, artifact.artifactId) as
      | {
          readonly id: string;
          readonly kind: string;
          readonly relative_path: string;
          readonly filename: string;
          readonly sha256: string;
          readonly byte_size: number;
          readonly media_type: string;
        }
      | undefined;
    if (
      row === undefined ||
      row.kind !== artifact.kind ||
      row.relative_path !== artifact.relativePath ||
      row.filename !== artifact.filename ||
      row.sha256 !== artifact.sha256 ||
      row.byte_size !== artifact.byteSize ||
      row.media_type !== artifact.mediaType
    ) {
      throw new Error("Workspace artifact context source is not a published immutable artifact");
    }
    return {
      id: row.id,
      kind: row.kind,
      relativePath: row.relative_path,
      filename: row.filename,
      sha256: row.sha256,
      byteSize: row.byte_size,
      mediaType: row.media_type
    };
  }

  private requireAgentNode(
    canvasId: string,
    nodeId: string,
    role: "target" | "requester"
  ): ReturnType<typeof canvasNodeDataSchema.parse> {
    const node = this.sqlite
      .prepare("SELECT id, type, data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
      .get(canvasId, nodeId) as NodeRow | undefined;
    if (node === undefined) throw new Error("Workspace context agent was not found");
    if (node.type !== "agent" && node.type !== "terminal") {
      throw new Error(`Workspace context ${role} must be an agent node`);
    }
    const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
    if (data.adapterId === undefined || data.adapterId === "shell") {
      throw new Error(`Workspace context ${role} is not an agent-capable terminal`);
    }
    return data;
  }
}
