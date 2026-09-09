import Database from "better-sqlite3";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { RuntimeSessionRecord, RuntimeSessionStore } from "@forgedeck/terminal";

import { runtimeSessions } from "./schema";

const activeStates: RuntimeSessionRecord["state"][] = [
  "starting",
  "running",
  "waiting",
  "stopping"
];

export class SqliteRuntimeSessionStore implements RuntimeSessionStore {
  private readonly sqlite: Database.Database;
  private readonly database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.database = drizzle(this.sqlite);
  }

  public async save(record: RuntimeSessionRecord): Promise<void> {
    const values = {
      id: record.id,
      adapterId: record.adapterId,
      state: record.state,
      cwd: record.cwd,
      processId: record.processId,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      interruptionReason: record.interruptionReason
    };
    this.database
      .insert(runtimeSessions)
      .values(values)
      .onConflictDoUpdate({ target: runtimeSessions.id, set: values })
      .run();
  }

  public async markActiveSessionsInterrupted(at: Date, reason: string): Promise<number> {
    const result = this.database
      .update(runtimeSessions)
      .set({
        state: "interrupted",
        updatedAt: at,
        endedAt: at,
        interruptionReason: reason,
        processId: null
      })
      .where(and(inArray(runtimeSessions.state, activeStates), isNull(runtimeSessions.endedAt)))
      .run();
    return result.changes;
  }

  public get(id: string): RuntimeSessionRecord | null {
    const row = this.database
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.id, id))
      .get();
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      adapterId: row.adapterId,
      state: parseState(row.state),
      cwd: row.cwd,
      processId: row.processId,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      endedAt: row.endedAt,
      exitCode: row.exitCode,
      exitSignal: row.exitSignal,
      interruptionReason: row.interruptionReason
    };
  }

  public close(): void {
    this.sqlite.close();
  }
}

function parseState(value: string): RuntimeSessionRecord["state"] {
  const states: readonly RuntimeSessionRecord["state"][] = [
    "idle",
    "starting",
    "running",
    "waiting",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted"
  ];
  const state = states.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new Error(`Invalid persisted runtime state: ${value}`);
  }
  return state;
}
