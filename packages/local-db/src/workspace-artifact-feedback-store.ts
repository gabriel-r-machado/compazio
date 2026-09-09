import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { artifactFeedbackSchema, createArtifactFeedbackSchema } from "@forgedeck/schemas";
import type { ArtifactFeedback, CreateArtifactFeedback } from "@forgedeck/schemas";

interface ArtifactFeedbackRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly artifact_version: number;
  readonly content: string;
  readonly created_by: string;
  readonly created_at: number;
}

export interface SqliteWorkspaceArtifactFeedbackStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/** Local human feedback is always tied to an immutable artifact-memory revision. */
export class SqliteWorkspaceArtifactFeedbackStore {
  private readonly sqlite: Database.Database;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteWorkspaceArtifactFeedbackStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public create(input: CreateArtifactFeedback): ArtifactFeedback {
    const parsed = createArtifactFeedbackSchema.parse(input);
    return this.sqlite.transaction(() => {
      this.requireArtifactRevision(parsed.workspaceId, parsed.artifactId, parsed.artifactVersion);
      const feedback = artifactFeedbackSchema.parse({
        id: this.createId(),
        workspaceId: parsed.workspaceId,
        artifactId: parsed.artifactId,
        artifactVersion: parsed.artifactVersion,
        content: parsed.content,
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
      this.sqlite
        .prepare(
          `INSERT INTO artifact_feedback
           (id, workspace_id, artifact_id, artifact_version, content, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          feedback.id,
          feedback.workspaceId,
          feedback.artifactId,
          feedback.artifactVersion,
          feedback.content,
          feedback.createdBy,
          Date.parse(feedback.createdAt)
        );
      return feedback;
    })();
  }

  public list(
    workspaceId: string,
    artifactId: string,
    artifactVersion: number | null = null,
    limit = 50
  ): readonly ArtifactFeedback[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Artifact feedback list limit must be between 1 and 500");
    }
    this.requireArtifact(workspaceId, artifactId);
    if (artifactVersion !== null && (!Number.isInteger(artifactVersion) || artifactVersion < 1)) {
      throw new Error("Artifact feedback version must be a positive integer");
    }
    const rows =
      artifactVersion === null
        ? (this.sqlite
            .prepare(
              `SELECT * FROM artifact_feedback
               WHERE workspace_id = ? AND artifact_id = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(workspaceId, artifactId, limit) as ArtifactFeedbackRow[])
        : (this.sqlite
            .prepare(
              `SELECT * FROM artifact_feedback
               WHERE workspace_id = ? AND artifact_id = ? AND artifact_version = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(workspaceId, artifactId, artifactVersion, limit) as ArtifactFeedbackRow[]);
    return rows.map(toArtifactFeedback);
  }

  public close(): void {
    this.sqlite.close();
  }

  private requireArtifactRevision(
    workspaceId: string,
    artifactId: string,
    artifactVersion: number
  ): void {
    const row = this.sqlite
      .prepare(
        `SELECT 1
         FROM artifact_memories
         WHERE workspace_id = ? AND artifact_id = ? AND version = ?`
      )
      .get(workspaceId, artifactId, artifactVersion);
    if (row === undefined) throw new Error("Artifact feedback version was not found");
  }

  private requireArtifact(workspaceId: string, artifactId: string): void {
    const row = this.sqlite
      .prepare("SELECT 1 FROM workspace_artifacts WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, artifactId);
    if (row === undefined) throw new Error("Artifact feedback artifact was not found");
  }
}

function toArtifactFeedback(row: ArtifactFeedbackRow): ArtifactFeedback {
  return artifactFeedbackSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    content: row.content,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  });
}
