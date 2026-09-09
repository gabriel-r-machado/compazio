import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import {
  canvasNodeDataSchema,
  canvasNodeSchema,
  publishWorkspaceArtifactSchema,
  workspaceArtifactCanvasEventSchema,
  workspaceArtifactEventTypeSchema,
  workspaceArtifactNodeId,
  workspaceArtifactSchema
} from "@forgedeck/schemas";
import type {
  CanvasNode,
  PublishWorkspaceArtifact,
  WorkspaceArtifact,
  WorkspaceArtifactCanvasEvent,
  WorkspaceArtifactEventType
} from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";

interface WorkspaceRow {
  readonly canvas_id: string;
  readonly project_id: string;
  readonly canonical_root_path: string;
}

interface NodeRow {
  readonly type: string;
  readonly data_json: string;
}

interface CanvasNodeRow extends NodeRow {
  readonly id: string;
  readonly position_x: number;
  readonly position_y: number;
  readonly width: number | null;
  readonly height: number | null;
}

interface ArtifactRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly source_relative_path: string;
  readonly relative_path: string;
  readonly filename: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly media_type: string;
  readonly published_by_node_id: string | null;
  readonly idempotency_key: string;
  readonly created_at: number;
}

interface ArtifactEventRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly type: string;
}

export interface WorkspaceArtifactEvent {
  readonly sequence: number;
  readonly type: WorkspaceArtifactEventType;
  readonly createdAt: string;
}

export interface SqliteWorkspaceArtifactStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly maxByteSize?: number;
}

export class SqliteWorkspaceArtifactStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly maxByteSize: number;

  public constructor(filename: string, options: SqliteWorkspaceArtifactStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.maxByteSize = options.maxByteSize ?? 20 * 1024 * 1024;
    if (
      !Number.isInteger(this.maxByteSize) ||
      this.maxByteSize < 1 ||
      this.maxByteSize > 20 * 1024 * 1024
    ) {
      throw new Error("Workspace artifact maximum size must be between 1 byte and 20 MiB");
    }
  }

  public publish(input: PublishWorkspaceArtifact): WorkspaceArtifact {
    const parsed = publishWorkspaceArtifactSchema.parse(input);
    this.policy.assertAllowed({
      workspaceId: parsed.workspaceId,
      actorNodeId: parsed.publishedByNodeId,
      permission: "publish_artifacts"
    });
    const workspace = this.requireWorkspace(parsed.workspaceId);
    const source = this.readSource(workspace.canonical_root_path, parsed.sourcePath);
    const existing = this.findByIdempotency(parsed.workspaceId, parsed.idempotencyKey);
    if (existing !== null) {
      assertMatchingArtifact(existing, parsed, source);
      return existing;
    }

    const id = this.createId();
    const projectRoot = realpathSync(workspace.canonical_root_path);
    const managedRoot = join(projectRoot, ".forgedeck", "artifacts");
    mkdirSync(managedRoot, { recursive: true });
    const canonicalManagedRoot = realpathSync(managedRoot);
    const targetDirectory = join(canonicalManagedRoot, id);
    mkdirSync(targetDirectory, { recursive: true });
    const canonicalTargetDirectory = realpathSync(targetDirectory);
    if (!isPathInside(canonicalManagedRoot, canonicalTargetDirectory)) {
      throw new Error("Workspace artifact target escapes the managed artifacts directory");
    }
    const target = join(canonicalTargetDirectory, source.filename);
    const temporary = join(canonicalTargetDirectory, `.${source.filename}.${this.createId()}.tmp`);
    const relativePath = toPortableRelativePath(projectRoot, target);
    try {
      writeFileSync(temporary, source.contents, { flag: "wx" });
      renameSync(temporary, target);
      const artifact = this.sqlite.transaction(() => {
        const duplicate = this.findByIdempotency(parsed.workspaceId, parsed.idempotencyKey);
        if (duplicate !== null) {
          assertMatchingArtifact(duplicate, parsed, source);
          return duplicate;
        }
        const timestamp = this.now().getTime();
        this.sqlite
          .prepare(
            `INSERT INTO workspace_artifacts
             (id, workspace_id, project_id, kind, source_relative_path, relative_path, filename,
              sha256, byte_size, media_type, published_by_node_id, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            parsed.workspaceId,
            workspace.project_id,
            parsed.kind,
            source.sourceRelativePath,
            relativePath,
            source.filename,
            source.sha256,
            source.byteSize,
            source.mediaType,
            parsed.publishedByNodeId,
            parsed.idempotencyKey,
            timestamp
          );
        const artifact = this.requireArtifact(id);
        this.insertArtifactMemory(artifact, timestamp);
        this.insertCanvasNode(workspace, artifact);
        this.bumpCanvasRevision(workspace.canvas_id, timestamp);
        this.insertEvent(artifact.id, timestamp);
        return artifact;
      })();
      if (artifact.id !== id) {
        rmSync(canonicalTargetDirectory, { force: true, recursive: true });
      }
      return artifact;
    } catch (error: unknown) {
      rmSync(canonicalTargetDirectory, { force: true, recursive: true });
      throw error;
    }
  }

  public list(workspaceId: string, limit = 50): readonly WorkspaceArtifact[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Workspace artifact list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workspace_artifacts
         WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  public get(artifactId: string): WorkspaceArtifact | null {
    const row = this.sqlite
      .prepare("SELECT * FROM workspace_artifacts WHERE id = ?")
      .get(artifactId) as ArtifactRow | undefined;
    return row === undefined ? null : toArtifact(row);
  }

  public claimNextCanvasEvent(): WorkspaceArtifactCanvasEvent | null {
    return this.sqlite.transaction(() => {
      const event = this.sqlite
        .prepare(
          `SELECT id, artifact_id, type FROM workspace_artifact_events
           WHERE projection_state = 'queued' ORDER BY created_at, id LIMIT 1`
        )
        .get() as ArtifactEventRow | undefined;
      if (event === undefined) return null;
      const result = this.sqlite
        .prepare(
          `UPDATE workspace_artifact_events SET projection_state = 'delivering'
           WHERE id = ? AND projection_state = 'queued'`
        )
        .run(event.id);
      return result.changes === 1 ? this.toCanvasEvent(event) : null;
    })();
  }

  public markCanvasEventPublished(eventId: string): void {
    const result = this.sqlite
      .prepare(
        `UPDATE workspace_artifact_events SET projection_state = 'published'
         WHERE id = ? AND projection_state = 'delivering'`
      )
      .run(eventId);
    if (result.changes !== 1) throw new Error("Workspace artifact event is not being delivered");
  }

  public recoverProjectionDeliveries(): number {
    return this.sqlite
      .prepare(
        `UPDATE workspace_artifact_events SET projection_state = 'queued'
         WHERE projection_state = 'delivering'`
      )
      .run().changes;
  }

  public resolve(workspaceId: string, reference: string): WorkspaceArtifact {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workspace_artifacts WHERE workspace_id = ? ORDER BY created_at DESC, id DESC`
      )
      .all(workspaceId) as ArtifactRow[];
    const matches = rows.filter(
      (row) =>
        row.id === reference ||
        equalsFold(row.filename, reference) ||
        equalsFold(row.source_relative_path, reference)
    );
    if (matches.length === 1) return toArtifact(requireFirst(matches));
    throw new Error(
      matches.length === 0
        ? `Workspace artifact not found: ${reference}`
        : `Workspace artifact target is ambiguous: ${reference}`
    );
  }

  public listEvents(artifactId: string): readonly WorkspaceArtifactEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT sequence, type, created_at FROM workspace_artifact_events
         WHERE artifact_id = ? ORDER BY sequence`
      )
      .all(artifactId) as {
      readonly sequence: number;
      readonly type: string;
      readonly created_at: number;
    }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      type: workspaceArtifactEventTypeSchema.parse(row.type),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.sqlite
      .prepare(
        `SELECT w.canvas_id, w.project_id, p.canonical_root_path
         FROM workspaces w JOIN projects p ON p.id = w.project_id WHERE w.id = ?`
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new Error("Workspace artifact workspace was not found");
    return row;
  }

  private readSource(
    projectRoot: string,
    sourcePath: string
  ): {
    readonly sourceRelativePath: string;
    readonly filename: string;
    readonly contents: Buffer;
    readonly sha256: string;
    readonly byteSize: number;
    readonly mediaType: string;
  } {
    const canonicalProjectRoot = realpathSync(projectRoot);
    const candidate = isAbsolute(sourcePath)
      ? resolve(sourcePath)
      : resolve(canonicalProjectRoot, sourcePath);
    const canonicalSource = realpathSync(candidate);
    if (!isPathInside(canonicalProjectRoot, canonicalSource)) {
      throw new Error("Workspace artifact source must stay inside the project root");
    }
    const stats = statSync(canonicalSource);
    if (!stats.isFile()) throw new Error("Workspace artifact source must be a regular file");
    if (stats.size > this.maxByteSize) {
      throw new Error(`Workspace artifact source exceeds the ${this.maxByteSize} byte limit`);
    }
    const contents = readFileSync(canonicalSource);
    if (contents.byteLength > this.maxByteSize) {
      throw new Error(`Workspace artifact source exceeds the ${this.maxByteSize} byte limit`);
    }
    const filename = basename(canonicalSource);
    if (filename.length === 0 || filename.length > 255) {
      throw new Error("Workspace artifact source filename is invalid");
    }
    return {
      sourceRelativePath: toPortableRelativePath(canonicalProjectRoot, canonicalSource),
      filename,
      contents,
      sha256: createHash("sha256").update(contents).digest("hex"),
      byteSize: contents.byteLength,
      mediaType: mediaTypeForFilename(filename)
    };
  }

  private findByIdempotency(workspaceId: string, idempotencyKey: string): WorkspaceArtifact | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM workspace_artifacts WHERE workspace_id = ? AND idempotency_key = ?`)
      .get(workspaceId, idempotencyKey) as ArtifactRow | undefined;
    return row === undefined ? null : toArtifact(row);
  }

  private requireArtifact(artifactId: string): WorkspaceArtifact {
    const artifact = this.get(artifactId);
    if (artifact === null) throw new Error("Workspace artifact was not found");
    return artifact;
  }

  private insertCanvasNode(workspace: WorkspaceRow, artifact: WorkspaceArtifact): void {
    const nodeId = workspaceArtifactNodeId(artifact.id);
    const count = (
      this.sqlite
        .prepare("SELECT COUNT(*) AS count FROM canvas_nodes WHERE canvas_id = ?")
        .get(workspace.canvas_id) as { readonly count: number }
    ).count;
    const position = artifactPosition(count);
    this.sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, ?, 'artifact', ?, ?, 360, 180, ?)`
      )
      .run(
        workspace.canvas_id,
        nodeId,
        position.x,
        position.y,
        JSON.stringify(artifactNodeData(artifact))
      );
  }

  private insertEvent(artifactId: string, timestamp: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO workspace_artifact_events
         (id, artifact_id, sequence, type, projection_state, created_at)
         VALUES (?, ?, 1, 'artifact_published', 'queued', ?)`
      )
      .run(this.createId(), artifactId, timestamp);
  }

  /** Every newly published immutable artifact starts with an explicit metadata version. */
  private insertArtifactMemory(artifact: WorkspaceArtifact, timestamp: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO artifact_memories
         (id, workspace_id, artifact_id, version, origin, sha256, relationships_json, relevance,
          status, created_by, created_at)
         VALUES (?, ?, ?, 1, ?, ?, '[]', 'relevant', 'active', ?, ?)`
      )
      .run(
        this.createId(),
        artifact.workspaceId,
        artifact.id,
        artifact.sourceRelativePath,
        artifact.sha256,
        artifact.publishedByNodeId ?? "local-user",
        timestamp
      );
  }

  private findCanvasNode(canvasId: string, nodeId: string): CanvasNodeRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, type, position_x, position_y, width, height, data_json
         FROM canvas_nodes WHERE canvas_id = ? AND id = ?`
      )
      .get(canvasId, nodeId) as CanvasNodeRow | undefined;
    return row ?? null;
  }

  private bumpCanvasRevision(canvasId: string, timestamp: number): void {
    const result = this.sqlite
      .prepare("UPDATE canvases SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, canvasId);
    if (result.changes !== 1) throw new Error("Workspace artifact canvas was not found");
  }

  private toCanvasEvent(event: ArtifactEventRow): WorkspaceArtifactCanvasEvent {
    const artifact = this.requireArtifact(event.artifact_id);
    const workspace = this.requireWorkspace(artifact.workspaceId);
    const node = this.findCanvasNode(workspace.canvas_id, workspaceArtifactNodeId(artifact.id));
    if (node === null || node.type !== "artifact") {
      throw new Error("Workspace artifact canvas node was not found");
    }
    const canvas = this.sqlite
      .prepare("SELECT revision FROM canvases WHERE id = ?")
      .get(workspace.canvas_id) as { readonly revision: number } | undefined;
    if (canvas === undefined || canvas.revision < 1) {
      throw new Error("Workspace artifact canvas was not found");
    }
    return workspaceArtifactCanvasEventSchema.parse({
      id: event.id,
      type: workspaceArtifactEventTypeSchema.parse(event.type),
      workspaceId: artifact.workspaceId,
      canvasId: workspace.canvas_id,
      artifact,
      node: toCanvasNode(node),
      canvasRevision: canvas.revision
    });
  }
}

function assertMatchingArtifact(
  artifact: WorkspaceArtifact,
  input: PublishWorkspaceArtifact,
  source: {
    readonly sourceRelativePath: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly mediaType: string;
  }
): void {
  if (
    artifact.kind !== input.kind ||
    artifact.sourceRelativePath !== source.sourceRelativePath ||
    artifact.sha256 !== source.sha256 ||
    artifact.byteSize !== source.byteSize ||
    artifact.mediaType !== source.mediaType ||
    artifact.publishedByNodeId !== input.publishedByNodeId
  ) {
    throw new Error("Workspace artifact idempotency key conflicts with another publish request");
  }
}

function toArtifact(row: ArtifactRow): WorkspaceArtifact {
  return workspaceArtifactSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    kind: row.kind,
    sourceRelativePath: row.source_relative_path,
    relativePath: row.relative_path,
    filename: row.filename,
    sha256: row.sha256,
    byteSize: row.byte_size,
    mediaType: row.media_type,
    publishedByNodeId: row.published_by_node_id,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function artifactNodeData(
  artifact: WorkspaceArtifact
): ReturnType<typeof canvasNodeDataSchema.parse> {
  return canvasNodeDataSchema.parse({
    title: artifact.filename,
    state: "idle",
    summary: `Artefato publicado: ${artifact.kind} (${artifact.byteSize} B)`,
    artifact: {
      artifactId: artifact.id,
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      filename: artifact.filename,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      mediaType: artifact.mediaType
    },
    retryMaxAttempts: 1,
    permissions: []
  });
}

function artifactPosition(count: number): { readonly x: number; readonly y: number } {
  return { x: 160 + (count % 4) * 400, y: 140 + Math.floor(count / 4) * 260 };
}

function toCanvasNode(row: CanvasNodeRow): CanvasNode {
  return canvasNodeSchema.parse({
    id: row.id,
    type: row.type,
    position: { x: row.position_x, y: row.position_y },
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    data: JSON.parse(row.data_json) as unknown
  });
}

function mediaTypeForFilename(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".html":
      return "text/html";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function toPortableRelativePath(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (path.length === 0 || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path)) {
    throw new Error("Workspace artifact path escapes the project root");
  }
  return path.split(sep).join("/");
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function equalsFold(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected one workspace artifact");
  return value;
}
