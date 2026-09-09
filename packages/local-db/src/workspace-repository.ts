import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export interface WorkspaceRecord {
  readonly id: string;
  readonly projectId: string;
  readonly canvasId: string;
  readonly title: string;
  readonly position: number;
  readonly isOpen: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkspaceInput {
  readonly projectId: string;
  readonly title?: string;
  readonly legacyCanvasId?: "default";
}

interface WorkspaceRow {
  readonly id: string;
  readonly project_id: string;
  readonly canvas_id: string;
  readonly title: string;
  readonly position: number;
  readonly is_open: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
}

const emptyViewport = JSON.stringify({ x: 0, y: 0, zoom: 1 });

export class SqliteWorkspaceRepository {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public list(): readonly WorkspaceRecord[] {
    return (
      this.sqlite
        .prepare(
          `SELECT id, project_id, canvas_id, title, position, is_open, created_at, updated_at
           FROM workspaces ORDER BY position, created_at`
        )
        .all() as WorkspaceRow[]
    ).map(toWorkspaceRecord);
  }

  public get(workspaceId: string): WorkspaceRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, project_id, canvas_id, title, position, is_open, created_at, updated_at
         FROM workspaces WHERE id = ?`
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    return row === undefined ? null : toWorkspaceRecord(row);
  }

  public create(input: CreateWorkspaceInput): WorkspaceRecord {
    const project = this.sqlite
      .prepare("SELECT id, name FROM projects WHERE id = ?")
      .get(input.projectId) as ProjectRow | undefined;
    if (project === undefined) {
      throw new Error("Workspace project does not exist");
    }
    const workspaceId = this.id();
    const canvasId = input.legacyCanvasId ?? `workspace-${workspaceId}`;
    const title = normalizeTitle(input.title ?? project.name);
    const timestamp = this.now().getTime();

    const create = this.sqlite.transaction(() => {
      if (input.legacyCanvasId === undefined) {
        this.sqlite
          .prepare(
            `INSERT INTO canvases (id, title, revision, viewport_json, created_at, updated_at)
             VALUES (?, ?, 0, ?, ?, ?)`
          )
          .run(canvasId, title, emptyViewport, timestamp, timestamp);
      } else {
        const legacyCanvas = this.sqlite
          .prepare("SELECT id FROM canvases WHERE id = ?")
          .get(canvasId) as { readonly id: string } | undefined;
        if (legacyCanvas === undefined) {
          throw new Error("Legacy canvas does not exist");
        }
        const adopted = this.sqlite
          .prepare("SELECT id FROM workspaces WHERE canvas_id = ?")
          .get(canvasId) as { readonly id: string } | undefined;
        if (adopted !== undefined) {
          return adopted.id;
        }
      }
      const positionRow = this.sqlite
        .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM workspaces")
        .get() as { readonly position: number };
      this.sqlite
        .prepare(
          `INSERT INTO workspaces
            (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          workspaceId,
          input.projectId,
          canvasId,
          title,
          positionRow.position,
          timestamp,
          timestamp
        );
      return workspaceId;
    });

    const created = this.get(create());
    if (created === null) {
      throw new Error("Workspace could not be loaded after creation");
    }
    return created;
  }

  public rename(workspaceId: string, title: string): WorkspaceRecord {
    const normalized = normalizeTitle(title);
    const result = this.sqlite
      .prepare("UPDATE workspaces SET title = ?, updated_at = ? WHERE id = ?")
      .run(normalized, this.now().getTime(), workspaceId);
    if (result.changes !== 1) {
      throw new Error("Workspace does not exist");
    }
    return this.require(workspaceId);
  }

  public setOpen(workspaceId: string, isOpen: boolean): WorkspaceRecord {
    const result = this.sqlite
      .prepare("UPDATE workspaces SET is_open = ?, updated_at = ? WHERE id = ?")
      .run(isOpen ? 1 : 0, this.now().getTime(), workspaceId);
    if (result.changes !== 1) {
      throw new Error("Workspace does not exist");
    }
    return this.require(workspaceId);
  }

  public reorder(workspaceIds: readonly string[]): readonly WorkspaceRecord[] {
    const existing = this.list();
    if (
      workspaceIds.length !== existing.length ||
      new Set(workspaceIds).size !== workspaceIds.length ||
      workspaceIds.some((workspaceId) => !existing.some((entry) => entry.id === workspaceId))
    ) {
      throw new Error("Workspace order must contain every workspace exactly once");
    }
    const timestamp = this.now().getTime();
    const reorder = this.sqlite.transaction(() => {
      const update = this.sqlite.prepare(
        "UPDATE workspaces SET position = ?, updated_at = ? WHERE id = ?"
      );
      workspaceIds.forEach((workspaceId, position) => update.run(position, timestamp, workspaceId));
    });
    reorder();
    return this.list();
  }

  public close(): void {
    this.sqlite.close();
  }

  private require(workspaceId: string): WorkspaceRecord {
    const workspace = this.get(workspaceId);
    if (workspace === null) {
      throw new Error("Workspace does not exist");
    }
    return workspace;
  }
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length < 1 || normalized.length > 160) {
    throw new Error("Workspace title must contain between 1 and 160 characters");
  }
  return normalized;
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    title: row.title,
    position: row.position,
    isOpen: row.is_open === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
