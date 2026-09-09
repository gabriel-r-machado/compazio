import Database from "better-sqlite3";

import { workspaceActivityEventSchema } from "@forgedeck/schemas";
import type { WorkspaceActivityEvent } from "@forgedeck/schemas";

interface ActivityRow {
  readonly source: "message" | "handoff";
  readonly row_id: number;
  readonly event_id: string;
  readonly workspace_id: string;
  readonly canvas_id: string;
  readonly subject_id: string;
  readonly agent_node_id: string | null;
  readonly event_type: string;
  readonly occurred_at: number;
}

/**
 * Read-only cursor over durable event rows. Cursors are process-local because a renderer reload
 * always rehydrates its persisted view instead of depending on missed transient notifications.
 */
export class SqliteWorkspaceActivityStore {
  private readonly sqlite: Database.Database;
  private messageRowId = 0;
  private handoffRowId = 0;

  public constructor(filename: string) {
    this.sqlite = new Database(filename, { readonly: true });
    this.sqlite.pragma("busy_timeout = 5000");
  }

  /** Establishes a watermark without replaying historical activity into newly opened renderers. */
  public prime(): void {
    this.messageRowId = this.maxRowId("agent_message_events");
    this.handoffRowId = this.maxRowId("canvas_handoff_events");
  }

  public pull(): readonly WorkspaceActivityEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT 'message' AS source, e.rowid AS row_id, e.id AS event_id,
                  m.workspace_id, w.canvas_id, m.id AS subject_id,
                  m.recipient_node_id AS agent_node_id, e.type AS event_type,
                  e.created_at AS occurred_at
           FROM agent_message_events e
           JOIN agent_messages m ON m.id = e.message_id
           JOIN workspaces w ON w.id = m.workspace_id
           WHERE e.rowid > ?
           UNION ALL
           SELECT 'handoff' AS source, e.rowid AS row_id, e.id AS event_id,
                  w.id AS workspace_id, w.canvas_id, h.id AS subject_id,
                  json_extract(h.target_json, '$.nodeId') AS agent_node_id,
                  e.type AS event_type, e.created_at AS occurred_at
           FROM canvas_handoff_events e
           JOIN canvas_handoffs h ON h.id = e.handoff_id
           JOIN workspaces w ON w.canvas_id = h.canvas_id
           WHERE e.rowid > ?
         ) ORDER BY occurred_at, source, row_id`
      )
      .all(this.messageRowId, this.handoffRowId) as ActivityRow[];

    for (const row of rows) {
      if (row.source === "message") this.messageRowId = Math.max(this.messageRowId, row.row_id);
      else this.handoffRowId = Math.max(this.handoffRowId, row.row_id);
    }
    return rows.map(toActivityEvent);
  }

  public close(): void {
    this.sqlite.close();
  }

  private maxRowId(table: "agent_message_events" | "canvas_handoff_events"): number {
    return (
      this.sqlite.prepare(`SELECT COALESCE(MAX(rowid), 0) AS row_id FROM ${table}`).get() as {
        readonly row_id: number;
      }
    ).row_id;
  }
}

function toActivityEvent(row: ActivityRow): WorkspaceActivityEvent {
  return workspaceActivityEventSchema.parse({
    id: `${row.source}:${row.event_id}`,
    workspaceId: row.workspace_id,
    canvasId: row.canvas_id,
    subject: row.source,
    subjectId: row.subject_id,
    agentNodeId: row.agent_node_id,
    eventType: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString()
  });
}
