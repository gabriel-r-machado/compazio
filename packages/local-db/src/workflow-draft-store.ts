import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { workflowDraftEventSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type {
  WorkflowDraft,
  WorkflowDraftEvent,
  WorkflowDraftEventType,
  WorkflowDraftRejectionReason
} from "@forgedeck/schemas";

interface DraftRow {
  readonly draft_json: string;
}

interface DraftEventRow {
  readonly id: string;
  readonly draft_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly actor: string;
  readonly summary: string;
  readonly rejection_reason: string | null;
  readonly created_at: number;
}

/** An event the reducer produced; the store finalizes it with an id, per-draft sequence and time. */
export interface WorkflowDraftEventInput {
  readonly type: WorkflowDraftEventType;
  readonly actor: "orchestrator" | "local-user" | "system";
  readonly summary: string;
  readonly rejectionReason: WorkflowDraftRejectionReason | null;
}

/**
 * Local persistence for the Automatic Workflow Composer. The full draft is stored as authoritative
 * JSON so a reload restores it exactly, while an append-only event log keeps an auditable, replayable
 * history. The draft snapshot — not event replay — is the source of truth, so duplicate or replayed
 * events can never duplicate nodes. This store persists only what the domain reducer decided; it
 * never mutates a draft itself and never starts a process.
 */
export class SqliteWorkflowDraftStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  /**
   * Upserts the draft snapshot and appends the reducer's events atomically. Returns the persisted
   * draft and the last appended event (or null when the command produced none).
   */
  public persist(
    draft: WorkflowDraft,
    events: readonly WorkflowDraftEventInput[]
  ): { readonly draft: WorkflowDraft; readonly lastEvent: WorkflowDraftEvent | null } {
    this.requireWorkspace(draft.workspaceId);
    const parsed = workflowDraftSchema.parse(draft);
    return this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO workflow_drafts
             (id, workspace_id, source_terminal_id, state, creation_mode, execution_profile, version, draft_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state,
             creation_mode = excluded.creation_mode,
             execution_profile = excluded.execution_profile,
             version = excluded.version,
             draft_json = excluded.draft_json,
             updated_at = excluded.updated_at`
        )
        .run(
          parsed.id,
          parsed.workspaceId,
          parsed.sourceTerminalId,
          parsed.state,
          parsed.creationMode,
          parsed.executionProfile,
          parsed.version,
          JSON.stringify(parsed),
          Date.parse(parsed.createdAt),
          Date.parse(parsed.updatedAt)
        );
      let lastEvent: WorkflowDraftEvent | null = null;
      for (const input of events) {
        lastEvent = this.appendEvent(parsed.id, input);
      }
      return { draft: parsed, lastEvent };
    })();
  }

  public getById(draftId: string): WorkflowDraft | null {
    const row = this.sqlite
      .prepare("SELECT draft_json FROM workflow_drafts WHERE id = ?")
      .get(draftId) as DraftRow | undefined;
    return row === undefined ? null : parseDraft(row);
  }

  public getLatestForTerminal(workspaceId: string, sourceTerminalId: string): WorkflowDraft | null {
    const row = this.sqlite
      .prepare(
        `SELECT draft_json FROM workflow_drafts
         WHERE workspace_id = ? AND source_terminal_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(workspaceId, sourceTerminalId) as DraftRow | undefined;
    return row === undefined ? null : parseDraft(row);
  }

  public getLatestForWorkspace(workspaceId: string): WorkflowDraft | null {
    const row = this.sqlite
      .prepare(
        `SELECT draft_json FROM workflow_drafts WHERE workspace_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(workspaceId) as DraftRow | undefined;
    return row === undefined ? null : parseDraft(row);
  }

  public listEvents(draftId: string): readonly WorkflowDraftEvent[] {
    return (
      this.sqlite
        .prepare(
          `SELECT id, draft_id, sequence, type, actor, summary, rejection_reason, created_at
           FROM workflow_draft_events WHERE draft_id = ? ORDER BY sequence`
        )
        .all(draftId) as DraftEventRow[]
    ).map(parseEvent);
  }

  public close(): void {
    this.sqlite.close();
  }

  private appendEvent(draftId: string, input: WorkflowDraftEventInput): WorkflowDraftEvent {
    const sequence =
      (
        this.sqlite
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workflow_draft_events WHERE draft_id = ?"
          )
          .get(draftId) as { readonly sequence: number }
      ).sequence + 1;
    const timestamp = this.now().toISOString();
    const event = workflowDraftEventSchema.parse({
      id: this.createId(),
      draftId,
      sequence,
      type: input.type,
      actor: input.actor,
      summary: input.summary,
      rejectionReason: input.rejectionReason,
      createdAt: timestamp
    });
    this.sqlite
      .prepare(
        `INSERT INTO workflow_draft_events
           (id, draft_id, sequence, type, actor, summary, rejection_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.draftId,
        event.sequence,
        event.type,
        event.actor,
        event.summary,
        event.rejectionReason,
        Date.parse(event.createdAt)
      );
    return event;
  }

  private requireWorkspace(workspaceId: string): void {
    const row = this.sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (row === undefined) throw new Error("Workflow draft workspace was not found");
  }
}

function parseDraft(row: DraftRow): WorkflowDraft {
  return workflowDraftSchema.parse(JSON.parse(row.draft_json));
}

function parseEvent(row: DraftEventRow): WorkflowDraftEvent {
  return workflowDraftEventSchema.parse({
    id: row.id,
    draftId: row.draft_id,
    sequence: row.sequence,
    type: row.type,
    actor: row.actor,
    summary: row.summary,
    rejectionReason: row.rejection_reason,
    createdAt: new Date(row.created_at).toISOString()
  });
}
