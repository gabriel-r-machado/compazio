import Database from "better-sqlite3";

import {
  artifactImpactNodeSchema,
  artifactImpactSchema,
  artifactMemoryRelationSchema
} from "@forgedeck/schemas";
import type { ArtifactImpact, ArtifactImpactEdge, ArtifactImpactNode } from "@forgedeck/schemas";

interface ArtifactImpactRow {
  readonly artifact_id: string;
  readonly kind: string;
  readonly filename: string;
  readonly sha256: string;
  readonly memory_version: number;
  readonly relevance: string;
  readonly status: string;
  readonly relationships_json: string;
}

interface CurrentArtifactMemory {
  readonly node: ArtifactImpactNode;
  readonly relationships: readonly {
    readonly artifactId: string;
    readonly kind: ArtifactImpactEdge["kind"];
  }[];
}

/**
 * Reads the latest immutable artifact-memory revision to expose a safe impact
 * graph. This store deliberately never returns source paths or memory origins.
 */
export class SqliteWorkspaceImpactStore {
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public getArtifactImpact(workspaceId: string, rootArtifactId: string): ArtifactImpact {
    const memories = this.currentMemories(workspaceId);
    if (!memories.has(rootArtifactId)) {
      throw new Error("Artifact impact artifact was not found");
    }

    const edges = this.collectEdges(memories);
    const componentArtifactIds = connectedArtifactIds(rootArtifactId, edges);
    const componentEdges = edges.filter(
      (edge) =>
        componentArtifactIds.has(edge.sourceArtifactId) &&
        componentArtifactIds.has(edge.targetArtifactId)
    );
    const nodes = [...componentArtifactIds]
      .map((artifactId) => memories.get(artifactId)?.node)
      .filter((node): node is ArtifactImpactNode => node !== undefined)
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const affectedArtifactIds = affectedArtifacts(rootArtifactId, componentEdges);

    return artifactImpactSchema.parse({
      workspaceId,
      rootArtifactId,
      nodes,
      edges: componentEdges,
      affectedArtifactIds
    });
  }

  public close(): void {
    this.sqlite.close();
  }

  private currentMemories(workspaceId: string): ReadonlyMap<string, CurrentArtifactMemory> {
    const rows = this.sqlite
      .prepare(
        `SELECT artifacts.id AS artifact_id, artifacts.kind, artifacts.filename, artifacts.sha256,
                memories.version AS memory_version, memories.relevance, memories.status,
                memories.relationships_json
         FROM workspace_artifacts AS artifacts
         INNER JOIN (
           SELECT artifact_id, MAX(version) AS version
           FROM artifact_memories
           WHERE workspace_id = ?
           GROUP BY artifact_id
         ) AS current ON current.artifact_id = artifacts.id
         INNER JOIN artifact_memories AS memories
           ON memories.artifact_id = current.artifact_id
          AND memories.version = current.version
          AND memories.workspace_id = ?
         WHERE artifacts.workspace_id = ?
         ORDER BY artifacts.id`
      )
      .all(workspaceId, workspaceId, workspaceId) as ArtifactImpactRow[];
    if (rows.length > 1_000) {
      throw new Error("Artifact impact graph supports at most 1000 versioned artifacts");
    }

    return new Map(
      rows.map((row) => [
        row.artifact_id,
        {
          node: artifactImpactNodeSchema.parse({
            artifactId: row.artifact_id,
            kind: row.kind,
            filename: row.filename,
            sha256: row.sha256,
            memoryVersion: row.memory_version,
            relevance: row.relevance,
            status: row.status
          }),
          relationships: parseRelationships(row.relationships_json)
        }
      ])
    );
  }

  private collectEdges(
    memories: ReadonlyMap<string, CurrentArtifactMemory>
  ): readonly ArtifactImpactEdge[] {
    const edges: ArtifactImpactEdge[] = [];
    for (const [artifactId, memory] of memories) {
      for (const relationship of memory.relationships) {
        if (!memories.has(relationship.artifactId)) continue;
        edges.push({
          sourceArtifactId: artifactId,
          targetArtifactId: relationship.artifactId,
          kind: relationship.kind
        });
      }
    }
    return edges.sort(
      (left, right) =>
        left.sourceArtifactId.localeCompare(right.sourceArtifactId) ||
        left.kind.localeCompare(right.kind) ||
        left.targetArtifactId.localeCompare(right.targetArtifactId)
    );
  }
}

function parseRelationships(value: string): CurrentArtifactMemory["relationships"] {
  try {
    return artifactMemoryRelationSchema
      .array()
      .max(64)
      .parse(JSON.parse(value) as unknown);
  } catch {
    throw new Error("Artifact impact relationships are invalid");
  }
}

function connectedArtifactIds(
  rootArtifactId: string,
  edges: readonly ArtifactImpactEdge[]
): ReadonlySet<string> {
  const neighbors = new Map<string, Set<string>>([[rootArtifactId, new Set()]]);
  for (const edge of edges) {
    addNeighbor(neighbors, edge.sourceArtifactId, edge.targetArtifactId);
    addNeighbor(neighbors, edge.targetArtifactId, edge.sourceArtifactId);
  }
  const visited = new Set<string>([rootArtifactId]);
  const pending = [rootArtifactId];
  while (pending.length > 0) {
    const artifactId = pending.shift();
    if (artifactId === undefined) break;
    for (const neighbor of neighbors.get(artifactId) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      pending.push(neighbor);
    }
  }
  return visited;
}

function affectedArtifacts(
  rootArtifactId: string,
  edges: readonly ArtifactImpactEdge[]
): readonly string[] {
  const dependents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "derived_from") continue;
    addNeighbor(dependents, edge.targetArtifactId, edge.sourceArtifactId);
  }
  const visited = new Set<string>([rootArtifactId]);
  const pending = [rootArtifactId];
  while (pending.length > 0) {
    const artifactId = pending.shift();
    if (artifactId === undefined) break;
    for (const dependent of dependents.get(artifactId) ?? []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      pending.push(dependent);
    }
  }
  visited.delete(rootArtifactId);
  return [...visited].sort((left, right) => left.localeCompare(right));
}

function addNeighbor(map: Map<string, Set<string>>, source: string, target: string): void {
  const neighbors = map.get(source) ?? new Set<string>();
  neighbors.add(target);
  map.set(source, neighbors);
}
