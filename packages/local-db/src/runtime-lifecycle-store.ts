import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export const runtimeLifecycleActions = [
  "start",
  "pause",
  "resume",
  "drain",
  "cancel",
  "shutdown"
] as const;
export type RuntimeLifecycleAction = (typeof runtimeLifecycleActions)[number];

export const runtimeLifecycleStates = [
  "stopped",
  "running",
  "paused",
  "draining",
  "cancelled",
  "shutdown"
] as const;
export type RuntimeLifecycleState = (typeof runtimeLifecycleStates)[number];

export interface RuntimeLifecycleStatus {
  readonly state: RuntimeLifecycleState;
  readonly revision: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface RuntimeLifecycleCommand {
  readonly id: string;
  readonly action: RuntimeLifecycleAction;
  readonly requestedBy: string;
  readonly createdAt: string;
}

interface StateRow {
  readonly state: string;
  readonly revision: number;
  readonly updated_by: string;
  readonly updated_at: number;
}

interface CommandRow {
  readonly id: string;
  readonly action: string;
  readonly requested_by: string;
  readonly created_at: number;
}

/** Durable, redacted manual control plane for the local Compasso Runtime. */
export class SqliteRuntimeLifecycleStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
  }

  public getStatus(): RuntimeLifecycleStatus {
    const row = this.sqlite
      .prepare(
        "SELECT state, revision, updated_by, updated_at FROM runtime_lifecycle_state WHERE id = 'compasso'"
      )
      .get() as StateRow | undefined;
    return row === undefined
      ? {
          state: "stopped",
          revision: 0,
          updatedBy: "system",
          updatedAt: new Date(0).toISOString()
        }
      : toStatus(row);
  }

  public request(
    action: RuntimeLifecycleAction,
    requestedBy = "compasso-cli"
  ): RuntimeLifecycleCommand {
    const command: RuntimeLifecycleCommand = {
      id: randomUUID(),
      action,
      requestedBy,
      createdAt: this.now().toISOString()
    };
    const transaction = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO runtime_lifecycle_commands
           (id, action, status, requested_by, created_at, applied_at, error_code)
           VALUES (?, ?, 'queued', ?, ?, NULL, NULL)`
        )
        .run(command.id, command.action, command.requestedBy, Date.parse(command.createdAt));
      this.insertEvent(
        command.action,
        this.getStatus().state,
        "requested",
        command.requestedBy,
        command.id,
        null
      );
    });
    transaction();
    return command;
  }

  public claimNext(): RuntimeLifecycleCommand | null {
    const transaction = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id, action, requested_by, created_at
           FROM runtime_lifecycle_commands WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`
        )
        .get() as CommandRow | undefined;
      if (row === undefined) return null;
      const result = this.sqlite
        .prepare(
          "UPDATE runtime_lifecycle_commands SET status = 'applying' WHERE id = ? AND status = 'queued'"
        )
        .run(row.id);
      if (result.changes !== 1) return null;
      return toCommand(row);
    });
    return transaction();
  }

  public markApplied(
    command: RuntimeLifecycleCommand,
    state: RuntimeLifecycleState
  ): RuntimeLifecycleStatus {
    const transaction = this.sqlite.transaction(() => {
      const status = this.setState(command.action, state, command.requestedBy, command.id);
      const result = this.sqlite
        .prepare(
          `UPDATE runtime_lifecycle_commands
           SET status = 'applied', applied_at = ?, error_code = NULL WHERE id = ? AND status = 'applying'`
        )
        .run(this.now().getTime(), command.id);
      if (result.changes !== 1) throw new Error("Runtime lifecycle command is no longer applying");
      return status;
    });
    return transaction();
  }

  public markFailed(command: RuntimeLifecycleCommand, errorCode: string): void {
    const transaction = this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE runtime_lifecycle_commands
           SET status = 'failed', applied_at = ?, error_code = ? WHERE id = ? AND status = 'applying'`
        )
        .run(this.now().getTime(), errorCode, command.id);
      if (result.changes !== 1) return;
      this.insertEvent(
        command.action,
        this.getStatus().state,
        "failed",
        command.requestedBy,
        command.id,
        errorCode
      );
    });
    transaction();
  }

  /** Never replays an uncertain control action after a crash; the user must request it again. */
  public recoverInterrupted(): number {
    const transaction = this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          "SELECT id, action, requested_by, created_at FROM runtime_lifecycle_commands WHERE status = 'applying'"
        )
        .all() as CommandRow[];
      for (const row of rows) {
        const command = toCommand(row);
        this.sqlite
          .prepare(
            `UPDATE runtime_lifecycle_commands
             SET status = 'failed', applied_at = ?, error_code = 'application_restart'
             WHERE id = ? AND status = 'applying'`
          )
          .run(this.now().getTime(), command.id);
        this.insertEvent(
          command.action,
          this.getStatus().state,
          "failed",
          command.requestedBy,
          command.id,
          "application_restart"
        );
      }
      return rows.length;
    });
    return transaction();
  }

  public recordSystemState(
    action: RuntimeLifecycleAction,
    state: RuntimeLifecycleState,
    actor = "desktop-runtime"
  ): RuntimeLifecycleStatus {
    return this.setState(action, state, actor, null);
  }

  public close(): void {
    this.sqlite.close();
  }

  private setState(
    action: RuntimeLifecycleAction,
    state: RuntimeLifecycleState,
    actor: string,
    commandId: string | null
  ): RuntimeLifecycleStatus {
    const current = this.getStatus();
    const timestamp = this.now();
    const status: RuntimeLifecycleStatus = {
      state,
      revision: current.revision + 1,
      updatedBy: actor,
      updatedAt: timestamp.toISOString()
    };
    this.sqlite
      .prepare(
        `INSERT INTO runtime_lifecycle_state (id, state, revision, updated_by, updated_at)
         VALUES ('compasso', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, revision = excluded.revision,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(status.state, status.revision, status.updatedBy, timestamp.getTime());
    this.insertEvent(action, state, "applied", actor, commandId, null);
    return status;
  }

  private insertEvent(
    action: RuntimeLifecycleAction,
    state: RuntimeLifecycleState,
    outcome: "requested" | "applied" | "failed",
    actor: string,
    commandId: string | null,
    errorCode: string | null
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO runtime_lifecycle_events
         (id, command_id, action, state, outcome, actor, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), commandId, action, state, outcome, actor, errorCode, this.now().getTime());
  }
}

function toStatus(row: StateRow): RuntimeLifecycleStatus {
  return {
    state: parseState(row.state),
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toCommand(row: CommandRow): RuntimeLifecycleCommand {
  return {
    id: row.id,
    action: parseAction(row.action),
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function parseAction(value: string): RuntimeLifecycleAction {
  const action = runtimeLifecycleActions.find((candidate) => candidate === value);
  if (action === undefined) throw new Error("Invalid persisted runtime lifecycle action");
  return action;
}

function parseState(value: string): RuntimeLifecycleState {
  const state = runtimeLifecycleStates.find((candidate) => candidate === value);
  if (state === undefined) throw new Error("Invalid persisted runtime lifecycle state");
  return state;
}
