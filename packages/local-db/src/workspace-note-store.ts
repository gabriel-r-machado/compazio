import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  appendWorkspaceNoteSchema,
  createWorkspaceNoteSchema,
  writeWorkspaceNoteSchema,
  workspaceNoteCanvasEventSchema,
  workspaceNoteContentSchema,
  workspaceNoteEventTypeSchema,
  workspaceNoteSchema,
  canvasNodeDataSchema,
  canvasNodeSchema
} from "@forgedeck/schemas";
import type {
  AppendWorkspaceNote,
  CreateWorkspaceNote,
  WriteWorkspaceNote,
  WorkspaceNote,
  WorkspaceNoteCanvasEvent,
  WorkspaceNoteEventType,
  CanvasNode
} from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";
import { appendNoteFile, readNoteFile, writeNoteFile } from "./workspace-note-files";

interface NoteRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canvas_id: string;
  readonly project_id: string;
  readonly node_id: string;
  readonly title: string;
  readonly content: string;
  readonly revision: number;
  readonly created_by_node_id: string | null;
  readonly create_idempotency_key: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface NoteEventRow {
  readonly id: string;
  readonly note_id: string;
  readonly type: string;
}

interface WorkspaceRow {
  readonly canvas_id: string;
  readonly project_id: string;
}

interface NodeRow {
  readonly id: string;
  readonly type: string;
  readonly position_x: number;
  readonly position_y: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly data_json: string;
}

export interface WorkspaceNoteEvent {
  readonly sequence: number;
  readonly type: WorkspaceNoteEventType;
  readonly createdAt: string;
}

export interface SqliteWorkspaceNoteStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
  /**
   * Enables notes as real markdown files. When on, every note is mirrored to
   * `<project>/.compazio/notes/` and disk becomes the authority for its content, so an agent can read
   * and edit it with the tools it already has. Off in tests that only exercise the SQLite side.
   */
  readonly notesOnDisk?: boolean;
}

export class SqliteWorkspaceNoteStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly notesOnDisk: boolean;

  public constructor(filename: string, options: SqliteWorkspaceNoteStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.notesOnDisk = options.notesOnDisk ?? false;
  }

  /**
   * The note's content as it stands right now: from disk when this project keeps notes as files,
   * because an agent may have edited the file directly since the row was written. The SQLite column
   * remains the fallback, and is what a reader without a project root sees.
   */
  public readContent(note: WorkspaceNote): string {
    if (!this.notesOnDisk) return note.content;
    const projectRoot = this.projectRoot(note.projectId);
    if (projectRoot === null) return note.content;
    return readNoteFile({ projectRoot, noteId: note.id, title: note.title }) ?? note.content;
  }

  /**
   * Rewrites the stored mirror and the canvas node from what is on disk. Used when an edit arrives
   * from outside the product; it is a projection of the file, never a second source of truth.
   */
  public syncFromDisk(noteId: string): WorkspaceNote | null {
    if (!this.notesOnDisk) return null;
    const note = this.get(noteId);
    if (note === null) return null;
    const projectRoot = this.projectRoot(note.projectId);
    if (projectRoot === null) return null;
    const content = readNoteFile({ projectRoot, noteId: note.id, title: note.title });
    if (content === null || content === note.content) return null;
    const timestamp = this.now().getTime();
    return this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "UPDATE workspace_notes SET content = ?, revision = revision + 1, updated_at = ? WHERE id = ?"
        )
        .run(content, timestamp, note.id);
      this.updateCanvasNode(note.canvasId, note.nodeId, note.title, content);
      this.bumpCanvasRevision(note.canvasId, timestamp);
      return this.requireNote(note.id);
    })();
  }

  private projectRoot(projectId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT canonical_root_path FROM projects WHERE id = ?")
      .get(projectId) as { readonly canonical_root_path: string } | undefined;
    return row?.canonical_root_path ?? null;
  }

  private mirrorToDisk(note: WorkspaceNote, mode: "write" | "append", content: string): void {
    if (!this.notesOnDisk) return;
    const projectRoot = this.projectRoot(note.projectId);
    if (projectRoot === null) return;
    const input = { projectRoot, noteId: note.id, title: note.title, content };
    if (mode === "write") writeNoteFile(input);
    else appendNoteFile(input);
  }

  public create(input: CreateWorkspaceNote): WorkspaceNote {
    const note = this.createRecord(input);
    // Mirrored after the row commits, so a rolled-back create never leaves a file behind. Replaying
    // an idempotent create rewrites the same bytes, which also heals a file someone deleted.
    return this.withDiskMirror(note, "write", note.content);
  }

  private createRecord(input: CreateWorkspaceNote): WorkspaceNote {
    const parsed = createWorkspaceNoteSchema.parse(input);
    this.policy.assertAllowed({
      workspaceId: parsed.workspaceId,
      actorNodeId: parsed.createdByNodeId,
      permission: "create_notes"
    });
    return this.sqlite.transaction(() => {
      const existing = this.findByCreateIdempotency(parsed.workspaceId, parsed.idempotencyKey);
      if (existing !== null) {
        if (
          existing.title !== parsed.title ||
          existing.content !== parsed.content ||
          existing.createdByNodeId !== parsed.createdByNodeId
        ) {
          throw new Error("Workspace note idempotency key conflicts with another create request");
        }
        return existing;
      }

      const workspace = this.requireWorkspace(parsed.workspaceId);
      const id = this.createId();
      const nodeId = `note-${this.createId()}`;
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `INSERT INTO workspace_notes
           (id, workspace_id, canvas_id, project_id, node_id, title, content, revision,
            created_by_node_id, create_idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(
          id,
          parsed.workspaceId,
          workspace.canvas_id,
          workspace.project_id,
          nodeId,
          parsed.title,
          parsed.content,
          parsed.createdByNodeId,
          parsed.idempotencyKey,
          timestamp,
          timestamp
        );
      const count = (
        this.sqlite
          .prepare("SELECT COUNT(*) AS count FROM canvas_nodes WHERE canvas_id = ?")
          .get(workspace.canvas_id) as { readonly count: number }
      ).count;
      const position = notePosition(count);
      this.sqlite
        .prepare(
          `INSERT INTO canvas_nodes
           (canvas_id, id, type, position_x, position_y, width, height, data_json)
           VALUES (?, ?, 'note', ?, ?, 360, 220, ?)`
        )
        .run(
          workspace.canvas_id,
          nodeId,
          position.x,
          position.y,
          JSON.stringify(noteNodeData(parsed.title, parsed.content))
        );
      this.bumpCanvasRevision(workspace.canvas_id, timestamp);
      this.insertEvent(
        id,
        1,
        "note_created",
        parsed.idempotencyKey,
        hash(parsed.content),
        timestamp
      );
      return this.requireNote(id);
    })();
  }

  /** Wraps a committed change with its disk mirror, so a rolled-back write never leaves a file. */
  private withDiskMirror(
    note: WorkspaceNote,
    mode: "write" | "append",
    content: string
  ): WorkspaceNote {
    this.mirrorToDisk(note, mode, content);
    return note;
  }

  /**
   * Replaces the note's whole content. Separate from `append` because rewriting a document and
   * adding an entry to a log are different intentions, and collapsing them would make one of the two
   * lie about what happened.
   */
  public write(input: WriteWorkspaceNote): WorkspaceNote {
    const parsed = writeWorkspaceNoteSchema.parse(input);
    this.policy.assertAllowed({
      workspaceId: parsed.workspaceId,
      actorNodeId: parsed.writtenByNodeId,
      permission: "create_notes"
    });
    const note = this.sqlite.transaction(() => {
      const current = this.requireNote(parsed.noteId);
      if (current.workspaceId !== parsed.workspaceId) {
        throw new Error("Workspace note does not belong to this workspace");
      }
      const contentHash = hash(parsed.content);
      const duplicate = this.findEventByIdempotency(current.id, parsed.idempotencyKey);
      if (duplicate !== null) {
        if (duplicate.content_hash !== contentHash) {
          throw new Error("Workspace note idempotency key conflicts with another write request");
        }
        return current;
      }
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `UPDATE workspace_notes SET content = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(parsed.content, timestamp, current.id);
      this.updateCanvasNode(current.canvasId, current.nodeId, current.title, parsed.content);
      this.bumpCanvasRevision(current.canvasId, timestamp);
      this.insertEvent(
        current.id,
        this.nextEventSequence(current.id),
        "note_written",
        parsed.idempotencyKey,
        contentHash,
        timestamp
      );
      return this.requireNote(current.id);
    })();
    return this.withDiskMirror(note, "write", note.content);
  }

  public append(input: AppendWorkspaceNote): WorkspaceNote {
    // An agent may have edited the file since the row was written, so the stored text is refreshed
    // from disk first: appending to a stale mirror would silently drop that edit.
    if (this.notesOnDisk) this.syncFromDisk(input.noteId);
    const note = this.appendRecord(input);
    // The whole content is written rather than appended to the file: it is idempotent under replay
    // and leaves the file exactly matching what the row now says.
    return this.withDiskMirror(note, "write", note.content);
  }

  private appendRecord(input: AppendWorkspaceNote): WorkspaceNote {
    const parsed = appendWorkspaceNoteSchema.parse(input);
    this.policy.assertAllowed({
      workspaceId: parsed.workspaceId,
      actorNodeId: parsed.appendedByNodeId,
      permission: "create_notes"
    });
    return this.sqlite.transaction(() => {
      const note = this.requireNote(parsed.noteId);
      if (note.workspaceId !== parsed.workspaceId) {
        throw new Error("Workspace note does not belong to this workspace");
      }
      const contentHash = hash(parsed.content);
      const duplicate = this.findEventByIdempotency(note.id, parsed.idempotencyKey);
      if (duplicate !== null) {
        if (duplicate.content_hash !== contentHash) {
          throw new Error("Workspace note idempotency key conflicts with another append request");
        }
        return note;
      }
      const content =
        note.content.length === 0 ? parsed.content : `${note.content}\n${parsed.content}`;
      workspaceNoteContentSchema.parse(content);
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `UPDATE workspace_notes SET content = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(content, timestamp, note.id);
      this.updateCanvasNode(note.canvasId, note.nodeId, note.title, content);
      this.bumpCanvasRevision(note.canvasId, timestamp);
      this.insertEvent(
        note.id,
        this.nextEventSequence(note.id),
        "note_appended",
        parsed.idempotencyKey,
        contentHash,
        timestamp
      );
      return this.requireNote(note.id);
    })();
  }

  public resolve(workspaceId: string, reference: string): WorkspaceNote {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare("SELECT * FROM workspace_notes WHERE workspace_id = ? ORDER BY created_at, id")
        .all(workspaceId) as NoteRow[];
      const matches = rows.filter(
        (row) =>
          row.id === reference || row.node_id === reference || equalsFold(row.title, reference)
      );
      if (matches.length === 1) return toNote(requireFirst(matches));
      if (matches.length > 1) throw new Error(`Workspace note target is ambiguous: ${reference}`);
      return this.adoptLegacyCanvasNote(workspaceId, reference);
    })();
  }

  public list(workspaceId: string, limit = 50): readonly WorkspaceNote[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Workspace note list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workspace_notes
         WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as NoteRow[];
    return rows.map(toNote);
  }

  public get(noteId: string): WorkspaceNote | null {
    const row = this.sqlite.prepare("SELECT * FROM workspace_notes WHERE id = ?").get(noteId) as
      NoteRow | undefined;
    return row === undefined ? null : toNote(row);
  }

  public claimNextCanvasEvent(): WorkspaceNoteCanvasEvent | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id, note_id, type FROM workspace_note_events
           WHERE projection_state = 'queued' ORDER BY created_at, id LIMIT 1`
        )
        .get() as NoteEventRow | undefined;
      if (row === undefined) return null;
      const result = this.sqlite
        .prepare(
          `UPDATE workspace_note_events SET projection_state = 'delivering'
           WHERE id = ? AND projection_state = 'queued'`
        )
        .run(row.id);
      if (result.changes !== 1) return null;
      return this.toCanvasEvent(row);
    })();
  }

  public markCanvasEventPublished(eventId: string): void {
    const result = this.sqlite
      .prepare(
        `UPDATE workspace_note_events SET projection_state = 'published'
         WHERE id = ? AND projection_state = 'delivering'`
      )
      .run(eventId);
    if (result.changes !== 1) throw new Error("Workspace note event is not being delivered");
  }

  public recoverProjectionDeliveries(): number {
    return this.sqlite
      .prepare(
        `UPDATE workspace_note_events SET projection_state = 'queued'
         WHERE projection_state = 'delivering'`
      )
      .run().changes;
  }

  public listEvents(noteId: string): readonly WorkspaceNoteEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT sequence, type, created_at FROM workspace_note_events
         WHERE note_id = ? ORDER BY sequence`
      )
      .all(noteId) as {
      readonly sequence: number;
      readonly type: string;
      readonly created_at: number;
    }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      type: workspaceNoteEventTypeSchema.parse(row.type),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.sqlite
      .prepare("SELECT canvas_id, project_id FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new Error("Workspace note workspace was not found");
    return row;
  }

  private adoptLegacyCanvasNote(workspaceId: string, reference: string): WorkspaceNote {
    const workspace = this.requireWorkspace(workspaceId);
    const nodes = this.sqlite
      .prepare(
        `SELECT id, type, position_x, position_y, width, height, data_json
         FROM canvas_nodes WHERE canvas_id = ? AND type = 'note' ORDER BY rowid`
      )
      .all(workspace.canvas_id) as NodeRow[];
    const matches = nodes.filter((node) => {
      const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
      return node.id === reference || equalsFold(data.title, reference);
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Workspace note not found: ${reference}`
          : `Workspace note target is ambiguous: ${reference}`
      );
    }
    const node = requireFirst(matches);
    const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
    const id = this.createId();
    const timestamp = this.now().getTime();
    this.sqlite
      .prepare(
        `INSERT INTO workspace_notes
         (id, workspace_id, canvas_id, project_id, node_id, title, content, revision,
          created_by_node_id, create_idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        workspace.canvas_id,
        workspace.project_id,
        node.id,
        data.title,
        data.content ?? "",
        `legacy:${node.id}`,
        timestamp,
        timestamp
      );
    return this.requireNote(id);
  }

  private findByCreateIdempotency(workspaceId: string, key: string): WorkspaceNote | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM workspace_notes
         WHERE workspace_id = ? AND create_idempotency_key = ?`
      )
      .get(workspaceId, key) as NoteRow | undefined;
    return row === undefined ? null : toNote(row);
  }

  private findEventByIdempotency(
    noteId: string,
    idempotencyKey: string
  ): { readonly content_hash: string } | null {
    const row = this.sqlite
      .prepare(
        `SELECT content_hash FROM workspace_note_events
         WHERE note_id = ? AND idempotency_key = ?`
      )
      .get(noteId, idempotencyKey) as { readonly content_hash: string } | undefined;
    return row ?? null;
  }

  private requireNote(noteId: string): WorkspaceNote {
    const note = this.get(noteId);
    if (note === null) throw new Error("Workspace note was not found");
    return note;
  }

  private findNode(canvasId: string, nodeId: string): NodeRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, type, position_x, position_y, width, height, data_json
         FROM canvas_nodes WHERE canvas_id = ? AND id = ?`
      )
      .get(canvasId, nodeId) as NodeRow | undefined;
    return row ?? null;
  }

  private updateCanvasNode(canvasId: string, nodeId: string, title: string, content: string): void {
    const node = this.findNode(canvasId, nodeId);
    if (node === null || node.type !== "note") {
      throw new Error("Workspace note canvas node was not found");
    }
    const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
    this.sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
      .run(
        JSON.stringify({ ...data, title, content, summary: noteSummary(content) }),
        canvasId,
        nodeId
      );
  }

  private bumpCanvasRevision(canvasId: string, timestamp: number): void {
    const result = this.sqlite
      .prepare("UPDATE canvases SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, canvasId);
    if (result.changes !== 1) throw new Error("Workspace note canvas was not found");
  }

  private nextEventSequence(noteId: string): number {
    return (
      this.sqlite
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM workspace_note_events WHERE note_id = ?`
        )
        .get(noteId) as { readonly sequence: number }
    ).sequence;
  }

  private insertEvent(
    noteId: string,
    sequence: number,
    type: WorkspaceNoteEventType,
    idempotencyKey: string,
    contentHash: string,
    timestamp: number
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO workspace_note_events
         (id, note_id, sequence, type, idempotency_key, content_hash, projection_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(this.createId(), noteId, sequence, type, idempotencyKey, contentHash, timestamp);
  }

  private toCanvasEvent(event: NoteEventRow): WorkspaceNoteCanvasEvent {
    const note = this.requireNote(event.note_id);
    const node = this.findNode(note.canvasId, note.nodeId);
    if (node === null) throw new Error("Workspace note canvas node was not found");
    const canvas = this.sqlite
      .prepare("SELECT revision FROM canvases WHERE id = ?")
      .get(note.canvasId) as { readonly revision: number } | undefined;
    if (canvas === undefined) throw new Error("Workspace note canvas was not found");
    return workspaceNoteCanvasEventSchema.parse({
      id: event.id,
      type: event.type,
      note,
      node: toCanvasNode(node),
      canvasRevision: canvas.revision
    });
  }
}

function noteNodeData(
  title: string,
  content: string
): ReturnType<typeof canvasNodeDataSchema.parse> {
  return canvasNodeDataSchema.parse({
    title,
    state: "idle",
    summary: noteSummary(content),
    content,
    retryMaxAttempts: 1,
    permissions: []
  });
}

function noteSummary(content: string): string {
  if (content.length === 0) return "Nota criada pela CLI do Compasso.";
  const firstLine = content.split("\n")[0] ?? content;
  return firstLine.slice(0, 160);
}

function notePosition(count: number): { readonly x: number; readonly y: number } {
  return { x: 160 + (count % 4) * 400, y: 140 + Math.floor(count / 4) * 280 };
}

function toCanvasNode(row: NodeRow): CanvasNode {
  return canvasNodeSchema.parse({
    id: row.id,
    type: row.type,
    position: { x: row.position_x, y: row.position_y },
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    data: JSON.parse(row.data_json) as unknown
  });
}

function toNote(row: NoteRow): WorkspaceNote {
  return workspaceNoteSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    canvasId: row.canvas_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    title: row.title,
    content: row.content,
    revision: row.revision,
    createdByNodeId: row.created_by_node_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalsFold(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected one workspace note");
  return value;
}
