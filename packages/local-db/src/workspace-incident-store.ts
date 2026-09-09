import Database from "better-sqlite3";

import { workspaceIncidentSchema } from "@forgedeck/schemas";
import type { WorkspaceIncident } from "@forgedeck/schemas";

interface IncidentRow {
  readonly id: string;
  readonly kind: string;
  readonly node_id: string | null;
  readonly actor_node_id: string | null;
  readonly detail: string;
  readonly context: string | null;
  readonly occurred_at: number;
}

/**
 * Read-only query over the failures the runtime already records.
 *
 * A *query*, not a cursor — and that is the whole point. `SqliteWorkspaceActivityStore` primes a
 * watermark so a reopened renderer is not flooded with history it already saw; that is right for a
 * live canvas projection and exactly wrong for failures. A denial you missed because the app was
 * closed is the one you most need to find later, so this reads from the top every time and owes
 * nothing to what a previous renderer happened to observe.
 *
 * Nothing here invents a table. Every row already existed and was simply unreachable from the UI.
 */
export class SqliteWorkspaceIncidentStore {
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename, { readonly: true });
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public list(input: { readonly workspaceId: string; readonly limit: number }): {
    readonly incidents: readonly WorkspaceIncident[];
  } {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT 'policy:' || id AS id, 'policy_denied' AS kind,
                  actor_node_id AS node_id, actor_node_id, permission AS detail,
                  reason AS context, created_at AS occurred_at
           FROM policy_decisions
           WHERE workspace_id = ? AND outcome <> 'allowed'
           UNION ALL
           SELECT 'lifecycle:' || id AS id, 'lifecycle_failed' AS kind,
                  target_node_id AS node_id, requested_by_node_id AS actor_node_id,
                  COALESCE(error_code, status) AS detail, action AS context,
                  updated_at AS occurred_at
           FROM agent_lifecycle_commands
           WHERE workspace_id = ? AND status IN ('failed', 'interrupted')
           UNION ALL
           SELECT 'message:' || id AS id, 'message_failed' AS kind,
                  recipient_node_id AS node_id, sender_node_id AS actor_node_id,
                  COALESCE(error_code, status) AS detail, status AS context,
                  updated_at AS occurred_at
           FROM agent_messages
           WHERE workspace_id = ? AND status IN ('failed', 'cancelled')
           UNION ALL
           SELECT 'spawn:' || id AS id, 'spawn_failed' AS kind,
                  node_id, requested_by_node_id AS actor_node_id,
                  COALESCE(error_code, status) AS detail, adapter_id AS context,
                  created_at AS occurred_at
           FROM agent_spawns
           WHERE workspace_id = ? AND status = 'failed'
         )
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`
      )
      .all(
        input.workspaceId,
        input.workspaceId,
        input.workspaceId,
        input.workspaceId,
        input.limit
      ) as IncidentRow[];

    return {
      incidents: rows.map((row) =>
        workspaceIncidentSchema.parse({
          id: row.id,
          workspaceId: input.workspaceId,
          kind: row.kind,
          // Every source in the union is a failure; `warning` is reserved for kinds that describe a
          // recoverable state, and none of the current four do.
          severity: "error",
          nodeId: row.node_id,
          actorNodeId: row.actor_node_id,
          detail: bounded(row.detail),
          context: row.context === null ? null : bounded(row.context),
          occurredAt: new Date(row.occurred_at).toISOString()
        })
      )
    };
  }

  public close(): void {
    this.sqlite.close();
  }
}

/**
 * These columns hold identifiers the runtime produces from closed sets, but the panel must not be
 * the place where that assumption is first tested. Truncating keeps one unexpected row from
 * becoming an unbounded string in the renderer.
 */
function bounded(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}
