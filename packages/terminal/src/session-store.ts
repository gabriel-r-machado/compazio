import type { RuntimeSessionRecord, RuntimeSessionStore } from "./types";

export class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  public readonly records = new Map<string, RuntimeSessionRecord>();

  public async save(record: RuntimeSessionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  public async markActiveSessionsInterrupted(at: Date, reason: string): Promise<number> {
    let updated = 0;
    for (const [id, record] of this.records) {
      if (["starting", "running", "waiting", "stopping"].includes(record.state)) {
        this.records.set(id, {
          ...record,
          state: "interrupted",
          updatedAt: at,
          endedAt: at,
          interruptionReason: reason
        });
        updated += 1;
      }
    }
    return updated;
  }
}
