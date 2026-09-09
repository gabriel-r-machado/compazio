import Database from "better-sqlite3";

export const workspaceHistoryKinds = [
  "message",
  "response",
  "note",
  "artifact",
  "connection",
  "handoff",
  "approval",
  "failure",
  "retry",
  "runtime"
] as const;

export type WorkspaceHistoryKind = (typeof workspaceHistoryKinds)[number];

export interface WorkspaceHistoryFilter {
  readonly workspaceId: string;
  readonly agentNodeId?: string | null;
  readonly kind?: WorkspaceHistoryKind | null;
  readonly state?: string | null;
  readonly since?: string | null;
  readonly until?: string | null;
  readonly limit?: number;
}

export interface WorkspaceHistoryEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentNodeId: string | null;
  readonly kind: WorkspaceHistoryKind;
  readonly eventType: string;
  readonly state: string | null;
  readonly subjectId: string;
  readonly occurredAt: string;
}

interface HistoryRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly agent_node_id: string | null;
  readonly kind: WorkspaceHistoryKind;
  readonly event_type: string;
  readonly state: string | null;
  readonly subject_id: string;
  readonly occurred_at: number;
}

/** Read-only unified timeline over the authoritative local event tables. */
export class SqliteWorkspaceHistoryStore {
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename, { readonly: true });
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public list(input: WorkspaceHistoryFilter): readonly WorkspaceHistoryEntry[] {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Workspace history limit must be between 1 and 500");
    }
    if (
      input.kind !== undefined &&
      input.kind !== null &&
      !workspaceHistoryKinds.includes(input.kind)
    ) {
      throw new Error("Workspace history type is invalid");
    }
    const clauses = ["workspace_id = ?"];
    const values: (string | number)[] = [input.workspaceId];
    if (input.agentNodeId !== undefined && input.agentNodeId !== null) {
      clauses.push("agent_node_id = ?");
      values.push(input.agentNodeId);
    }
    if (input.kind !== undefined && input.kind !== null) {
      clauses.push("kind = ?");
      values.push(input.kind);
    }
    if (input.state !== undefined && input.state !== null) {
      clauses.push("state = ?");
      values.push(input.state);
    }
    if (input.since !== undefined && input.since !== null) {
      clauses.push("occurred_at >= ?");
      values.push(parseHistoryDate(input.since, "since"));
    }
    if (input.until !== undefined && input.until !== null) {
      clauses.push("occurred_at <= ?");
      values.push(parseHistoryDate(input.until, "until"));
    }
    values.push(limit);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM (${historyQuery})
         WHERE ${clauses.join(" AND ")}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`
      )
      .all(...values) as HistoryRow[];
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      agentNodeId: row.agent_node_id,
      kind: row.kind,
      eventType: row.event_type,
      state: row.state,
      subjectId: row.subject_id,
      occurredAt: new Date(row.occurred_at).toISOString()
    }));
  }

  public close(): void {
    this.sqlite.close();
  }
}

const historyQuery = `
  SELECT e.id, m.workspace_id, m.recipient_node_id AS agent_node_id,
         CASE
           WHEN e.type IN ('delivery_failed', 'delivery_interrupted') THEN 'failure'
           WHEN e.type = 'retry_requested' THEN 'retry'
           ELSE 'message'
         END AS kind,
         e.type AS event_type, m.status AS state, m.id AS subject_id, e.created_at AS occurred_at
  FROM agent_message_events e
  JOIN agent_messages m ON m.id = e.message_id
  WHERE e.type <> 'response_recorded'
  UNION ALL
  SELECT r.id, r.workspace_id, r.responder_node_id, 'response', 'response_recorded', r.status,
         r.request_message_id, r.created_at
  FROM agent_message_responses r
  UNION ALL
  SELECT e.id, n.workspace_id, n.created_by_node_id, 'note', e.type, CAST(n.revision AS TEXT),
         n.id, e.created_at
  FROM workspace_note_events e
  JOIN workspace_notes n ON n.id = e.note_id
  UNION ALL
  SELECT e.id, a.workspace_id, a.published_by_node_id, 'artifact', e.type, a.kind, a.id, e.created_at
  FROM workspace_artifact_events e
  JOIN workspace_artifacts a ON a.id = e.artifact_id
  UNION ALL
  SELECT e.id, e.workspace_id, e.actor_node_id, 'connection', e.event_type,
         json_extract(e.contract_json, '$.kind'), e.edge_id, e.created_at
  FROM workspace_connection_events e
  UNION ALL
  SELECT e.id, w.id, json_extract(h.target_json, '$.nodeId'),
         CASE
           WHEN e.type IN ('handoff_ready', 'handoff_rejected') THEN 'approval'
           WHEN e.type IN ('delivery_failed', 'delivery_unknown') THEN 'failure'
           WHEN e.type = 'retry_requested' THEN 'retry'
           ELSE 'handoff'
         END,
         e.type, e.to_status, h.id, e.created_at
  FROM canvas_handoff_events e
  JOIN canvas_handoffs h ON h.id = e.handoff_id
  JOIN workspaces w ON w.canvas_id = h.canvas_id
  UNION ALL
  SELECT e.id, s.workspace_id, s.node_id,
         CASE
           WHEN e.type IN ('spawn_failed', 'spawn_interrupted') THEN 'failure'
           WHEN e.type = 'spawn_retry_requested' THEN 'retry'
           ELSE 'runtime'
         END,
         e.type, s.status, s.id, e.created_at
  FROM agent_spawn_events e
  JOIN agent_spawns s ON s.id = e.spawn_id
  UNION ALL
  SELECT 'runtime:' || rs.id, ae.workspace_id, ae.node_id, 'runtime', 'session_state', rs.state,
         rs.id, rs.updated_at
  FROM runtime_sessions rs
  JOIN agent_endpoints ae ON ae.session_id = rs.id`;

function parseHistoryDate(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`Workspace history ${label} must be an ISO date`);
  return timestamp;
}
