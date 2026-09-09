import Database from "better-sqlite3";

export interface RuntimeProjectLease {
  readonly projectId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

interface RuntimeProjectLeaseRow {
  readonly project_id: string;
  readonly owner_id: string;
  readonly acquired_at: number;
  readonly heartbeat_at: number;
}

/** Coordinates the runtime process independently from short-lived Git operation locks. */
export class SqliteRuntimeProjectLeaseStore {
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
  }

  public tryAcquire(lease: RuntimeProjectLease): boolean {
    const result = this.sqlite
      .prepare(
        `INSERT INTO runtime_project_leases (project_id, owner_id, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING`
      )
      .run(
        lease.projectId,
        lease.ownerId,
        Date.parse(lease.acquiredAt),
        Date.parse(lease.heartbeatAt)
      );
    return result.changes === 1;
  }

  public get(projectId: string): RuntimeProjectLease | null {
    const row = this.sqlite
      .prepare(
        `SELECT project_id, owner_id, acquired_at, heartbeat_at
         FROM runtime_project_leases WHERE project_id = ?`
      )
      .get(projectId) as RuntimeProjectLeaseRow | undefined;
    return row === undefined ? null : toLease(row);
  }

  public release(projectId: string, ownerId: string): boolean {
    const result = this.sqlite
      .prepare("DELETE FROM runtime_project_leases WHERE project_id = ? AND owner_id = ?")
      .run(projectId, ownerId);
    return result.changes === 1;
  }

  public releaseAll(ownerId: string): number {
    return this.sqlite.prepare("DELETE FROM runtime_project_leases WHERE owner_id = ?").run(ownerId)
      .changes;
  }

  public heartbeat(ownerId: string, at: string): number {
    return this.sqlite
      .prepare("UPDATE runtime_project_leases SET heartbeat_at = ? WHERE owner_id = ?")
      .run(Date.parse(at), ownerId).changes;
  }

  /**
   * Releases only leases whose owner has missed the host-defined heartbeat deadline.
   * A fresh lease is never stolen: a competing runtime must wait for this explicit recovery
   * path and the deadline is deliberately longer than the regular heartbeat interval.
   */
  public recoverStale(before: string): number {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) throw new Error("Runtime lease recovery cutoff is invalid");
    return this.sqlite
      .prepare("DELETE FROM runtime_project_leases WHERE heartbeat_at < ?")
      .run(cutoff).changes;
  }

  public close(): void {
    this.sqlite.close();
  }
}

function toLease(row: RuntimeProjectLeaseRow): RuntimeProjectLease {
  return {
    projectId: row.project_id,
    ownerId: row.owner_id,
    acquiredAt: new Date(row.acquired_at).toISOString(),
    heartbeatAt: new Date(row.heartbeat_at).toISOString()
  };
}
