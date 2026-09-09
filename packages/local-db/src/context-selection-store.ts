import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { contextSelectionSnapshotSchema, contextSourceIndexSchema } from "@forgedeck/schemas";
import type {
  ArtifactMemory,
  ContextInclusion,
  ContextSelectionEntry,
  ContextSelectionMode,
  ContextSelectionSnapshot,
  ContextSourceIndex,
  WorkspaceAgentContext,
  WorkspaceContextSource
} from "@forgedeck/schemas";

const intelligentOptionalBudget = 12_000;
const economicalRelevantBudget = 4_000;
const chunkCharacterLimit = 1_600;

interface IndexRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source_node_id: string;
  readonly type: string;
  readonly origin: string;
  readonly version: number;
  readonly source_sha256: string;
  readonly byte_size: number;
  readonly inclusion: string;
}

interface ChunkRow {
  readonly ordinal: number;
  readonly sha256: string;
  readonly byte_size: number;
  readonly estimated_tokens: number;
}

interface CacheRow {
  readonly selection_json: string;
}

export interface ContextSelectionResult {
  readonly snapshot: ContextSelectionSnapshot;
  readonly includedSourceNodeIds: readonly string[];
  readonly cacheHit: boolean;
}

export interface SqliteContextSelectionStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/**
 * Builds a deterministic metadata index and selection for direct canvas context. It never stores
 * source bytes, filesystem paths, commands or credentials: the authoritative source stays in the
 * canvas or artifact registry and is re-resolved only after selection.
 */
export class SqliteContextSelectionStore {
  private readonly sqlite: Database.Database;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteContextSelectionStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public select(input: {
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly mode: ContextSelectionMode;
    readonly context: WorkspaceAgentContext;
    readonly artifactMemories: readonly ArtifactMemory[];
  }): ContextSelectionResult {
    return this.sqlite.transaction(() => {
      const indexed = input.context.sources
        .map((source) => this.indexSource(input.workspaceId, source, input.artifactMemories))
        .sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId));
      const sourceIndexSha256 = hash(stableStringify(indexed));
      const cacheKey = hash(
        stableStringify({
          workspaceId: input.workspaceId,
          agentNodeId: input.agentNodeId,
          mode: input.mode,
          sourceIndexSha256
        })
      );
      const cached = this.sqlite
        .prepare("SELECT selection_json FROM context_selection_caches WHERE cache_key = ?")
        .get(cacheKey) as CacheRow | undefined;
      const snapshot =
        cached === undefined
          ? this.createSnapshot({
              workspaceId: input.workspaceId,
              agentNodeId: input.agentNodeId,
              mode: input.mode,
              sourceIndexSha256,
              indexed
            })
          : contextSelectionSnapshotSchema.parse(
              parseJson(cached.selection_json, "Context selection")
            );
      if (cached === undefined) {
        this.sqlite
          .prepare(
            `INSERT INTO context_selection_caches
             (cache_key, workspace_id, agent_node_id, mode, source_index_sha256, selection_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            cacheKey,
            input.workspaceId,
            input.agentNodeId,
            input.mode,
            sourceIndexSha256,
            JSON.stringify(snapshot),
            this.now().getTime()
          );
      }
      return {
        snapshot,
        includedSourceNodeIds: snapshot.entries
          .filter((entry) => entry.included)
          .map((entry) => entry.sourceNodeId),
        cacheHit: cached !== undefined
      };
    })();
  }

  public close(): void {
    this.sqlite.close();
  }

  private indexSource(
    workspaceId: string,
    source: WorkspaceContextSource,
    artifactMemories: readonly ArtifactMemory[]
  ): ContextSourceIndex {
    const inclusion = sourceInclusion(source, artifactMemories);
    const content = indexableSourceText(source);
    const sourceSha256 = hash(stableStringify({ type: source.kind, content }));
    const existing = this.sqlite
      .prepare(
        `SELECT id, workspace_id, source_node_id, type, origin, version, source_sha256, byte_size, inclusion
         FROM context_source_indexes
         WHERE workspace_id = ? AND source_node_id = ? AND source_sha256 = ?`
      )
      .get(workspaceId, source.nodeId, sourceSha256) as IndexRow | undefined;
    if (existing !== undefined) {
      this.sqlite
        .prepare(
          `UPDATE context_source_indexes
           SET type = ?, origin = ?, byte_size = ?, inclusion = ? WHERE id = ?`
        )
        .run(
          source.kind,
          source.artifact === undefined ? "canvas_context" : "published_artifact",
          Buffer.byteLength(content, "utf8"),
          inclusion,
          existing.id
        );
      return this.toIndex({ ...existing, type: source.kind, inclusion }, this.chunks(existing.id));
    }
    const versionRow = this.sqlite
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS version FROM context_source_indexes
         WHERE workspace_id = ? AND source_node_id = ?`
      )
      .get(workspaceId, source.nodeId) as { readonly version: number };
    const id = this.createId();
    const chunks = chunkSource(content);
    this.sqlite
      .prepare(
        `INSERT INTO context_source_indexes
         (id, workspace_id, source_node_id, type, origin, version, source_sha256, byte_size, inclusion, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        source.nodeId,
        source.kind,
        source.artifact === undefined ? "canvas_context" : "published_artifact",
        versionRow.version + 1,
        sourceSha256,
        Buffer.byteLength(content, "utf8"),
        inclusion,
        this.now().getTime()
      );
    const insertChunk = this.sqlite.prepare(
      `INSERT INTO context_index_chunks (id, index_id, ordinal, sha256, byte_size, estimated_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const chunk of chunks) {
      insertChunk.run(
        this.createId(),
        id,
        chunk.ordinal,
        chunk.sha256,
        chunk.byteSize,
        chunk.estimatedTokens
      );
    }
    return contextSourceIndexSchema.parse({
      workspaceId,
      sourceNodeId: source.nodeId,
      type: source.kind,
      origin: source.artifact === undefined ? "canvas_context" : "published_artifact",
      version: versionRow.version + 1,
      sourceSha256,
      byteSize: Buffer.byteLength(content, "utf8"),
      inclusion,
      chunks
    });
  }

  private chunks(indexId: string) {
    const rows = this.sqlite
      .prepare(
        `SELECT ordinal, sha256, byte_size, estimated_tokens
         FROM context_index_chunks WHERE index_id = ? ORDER BY ordinal`
      )
      .all(indexId) as ChunkRow[];
    return rows.map((row) => ({
      ordinal: row.ordinal,
      sha256: row.sha256,
      byteSize: row.byte_size,
      estimatedTokens: row.estimated_tokens
    }));
  }

  private toIndex(row: IndexRow, chunks: ReturnType<SqliteContextSelectionStore["chunks"]>) {
    return contextSourceIndexSchema.parse({
      workspaceId: row.workspace_id,
      sourceNodeId: row.source_node_id,
      type: row.type,
      origin: row.origin,
      version: row.version,
      sourceSha256: row.source_sha256,
      byteSize: row.byte_size,
      inclusion: row.inclusion,
      chunks
    });
  }

  private createSnapshot(input: {
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly mode: ContextSelectionMode;
    readonly sourceIndexSha256: string;
    readonly indexed: readonly ContextSourceIndex[];
  }): ContextSelectionSnapshot {
    const entries = selectEntries(input.indexed, input.mode);
    const estimatedTokens = entries
      .filter((entry) => entry.included)
      .reduce((total, entry) => total + entry.estimatedTokens, 0);
    const metrics = {
      estimatedTokens,
      actualTokens: null,
      costStatus: "estimated" as const,
      estimatedCostMicros: null,
      actualCostMicros: null,
      currency: null
    };
    return contextSelectionSnapshotSchema.parse({
      schemaVersion: "1.0",
      workspaceId: input.workspaceId,
      agentNodeId: input.agentNodeId,
      mode: input.mode,
      sourceIndexSha256: input.sourceIndexSha256,
      selectionSha256: hash(stableStringify({ mode: input.mode, entries, metrics })),
      entries,
      metrics,
      createdAt: this.now().toISOString()
    });
  }
}

function sourceInclusion(
  source: WorkspaceContextSource,
  artifactMemories: readonly ArtifactMemory[]
): ContextInclusion {
  if (source.artifact === undefined) return source.inclusion;
  return (
    artifactMemories.find((memory) => memory.artifactId === source.artifact?.id)?.relevance ??
    source.inclusion
  );
}

function indexableSourceText(source: WorkspaceContextSource): string {
  if (source.content !== undefined) return source.content;
  if (source.artifact !== undefined) {
    return stableStringify({
      artifactId: source.artifact.id,
      kind: source.artifact.kind,
      sha256: source.artifact.sha256,
      mediaType: source.artifact.mediaType
    });
  }
  return stableStringify({
    kind: source.reference?.kind ?? source.kind,
    url: source.reference?.url ?? null,
    sha256: source.reference?.sha256 ?? null,
    mediaType: source.reference?.mediaType ?? null
  });
}

function chunkSource(value: string) {
  const chunks =
    value.length === 0
      ? [""]
      : Array.from({ length: Math.ceil(value.length / chunkCharacterLimit) }, (_, ordinal) =>
          value.slice(ordinal * chunkCharacterLimit, (ordinal + 1) * chunkCharacterLimit)
        );
  return chunks.map((chunk, ordinal) => {
    const byteSize = Buffer.byteLength(chunk, "utf8");
    return {
      ordinal,
      sha256: hash(chunk),
      byteSize,
      estimatedTokens: estimateTokens(byteSize)
    };
  });
}

function selectEntries(
  indexes: readonly ContextSourceIndex[],
  mode: ContextSelectionMode
): ContextSelectionEntry[] {
  let selectedTokens = 0;
  const selected = new Map<string, ContextSelectionEntry>();
  const selectionOrder = [...indexes].sort((left, right) => {
    const inclusionOrder: Record<ContextInclusion, number> = {
      required: 0,
      relevant: 1,
      optional: 2,
      never: 3
    };
    const rank = inclusionOrder[left.inclusion] - inclusionOrder[right.inclusion];
    return rank === 0 ? left.sourceNodeId.localeCompare(right.sourceNodeId) : rank;
  });
  for (const index of selectionOrder) {
    const estimatedTokens = index.chunks.reduce((total, chunk) => total + chunk.estimatedTokens, 0);
    const base = {
      sourceNodeId: index.sourceNodeId,
      sourceSha256: index.sourceSha256,
      inclusion: index.inclusion,
      estimatedTokens,
      actualTokens: null
    };
    if (index.inclusion === "never") {
      selected.set(index.sourceNodeId, {
        ...base,
        included: false,
        reason: "excluded_by_never_policy"
      });
      continue;
    }
    if (index.inclusion === "required") {
      selectedTokens += estimatedTokens;
      selected.set(index.sourceNodeId, {
        ...base,
        included: true,
        reason: "required_by_source_policy"
      });
      continue;
    }
    if (index.inclusion === "relevant") {
      if (mode !== "economical" || selectedTokens + estimatedTokens <= economicalRelevantBudget) {
        selectedTokens += estimatedTokens;
        selected.set(index.sourceNodeId, {
          ...base,
          included: true,
          reason: "relevant_by_source_policy"
        });
        continue;
      }
      selected.set(index.sourceNodeId, {
        ...base,
        included: false,
        reason: "excluded_by_economical_budget"
      });
      continue;
    }
    if (mode === "full") {
      selectedTokens += estimatedTokens;
      selected.set(index.sourceNodeId, {
        ...base,
        included: true,
        reason: "optional_in_full_mode"
      });
      continue;
    }
    if (mode === "intelligent") {
      if (selectedTokens + estimatedTokens <= intelligentOptionalBudget) {
        selectedTokens += estimatedTokens;
        selected.set(index.sourceNodeId, {
          ...base,
          included: true,
          reason: "optional_within_intelligent_budget"
        });
        continue;
      }
      selected.set(index.sourceNodeId, {
        ...base,
        included: false,
        reason: "excluded_by_intelligent_budget"
      });
      continue;
    }
    selected.set(index.sourceNodeId, {
      ...base,
      included: false,
      reason: "excluded_by_economical_mode"
    });
  }
  return indexes.map((index) => {
    const entry = selected.get(index.sourceNodeId);
    if (entry === undefined) throw new Error("Context selection entry is missing");
    return entry;
  });
}

function estimateTokens(byteSize: number): number {
  return Math.ceil(byteSize / 4);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
