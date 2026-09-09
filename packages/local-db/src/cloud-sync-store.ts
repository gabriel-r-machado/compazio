import Database from "better-sqlite3";

import { cloudSyncEventSchema } from "@forgedeck/schemas";
import type { CloudSyncEvent } from "@forgedeck/schemas";

const settingKeys = {
  enabled: "cloud.sync.enabled",
  organizationId: "cloud.sync.organization_id",
  deviceName: "cloud.sync.device_name",
  lastSyncedAt: "cloud.sync.last_synced_at",
  lastErrorCode: "cloud.sync.last_error_code",
  encryptedCredential: "cloud.sync.encrypted_credential"
} as const;

export interface CloudSyncConfiguration {
  readonly enabled: boolean;
  readonly organizationId: string | null;
  readonly deviceName: string;
}

export interface CloudSyncLocalState extends CloudSyncConfiguration {
  readonly queued: number;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode: string | null;
}

interface SettingRow {
  readonly value: string;
}

interface OutboxRow {
  readonly event_key: string;
  readonly event_json: string;
}

export class SqliteCloudSyncStore {
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public configure(configuration: CloudSyncConfiguration): void {
    this.sqlite.transaction(() => {
      this.setSetting(settingKeys.enabled, configuration.enabled ? "true" : "false");
      this.setSetting(settingKeys.organizationId, configuration.organizationId ?? "");
      this.setSetting(settingKeys.deviceName, configuration.deviceName);
      if (!configuration.enabled) {
        this.setSetting(settingKeys.lastErrorCode, "");
      }
    })();
  }

  public enqueue(event: CloudSyncEvent): boolean {
    const parsed = cloudSyncEventSchema.parse(event);
    const result = this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO cloud_sync_outbox
          (event_key, event_json, state, attempts, created_at)
         VALUES (?, ?, 'pending', 0, ?)`
      )
      .run(parsed.eventKey, JSON.stringify(parsed), Date.now());
    return result.changes === 1;
  }

  public listPending(limit = 50): readonly CloudSyncEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Cloud sync pending event limit must be between 1 and 50");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT event_key, event_json FROM cloud_sync_outbox
         WHERE state = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit) as OutboxRow[];
    return rows.map((row) => {
      const parsed: unknown = JSON.parse(row.event_json);
      const event = cloudSyncEventSchema.parse(parsed);
      if (event.eventKey !== row.event_key) {
        throw new Error("Cloud sync outbox event key does not match its payload");
      }
      return event;
    });
  }

  public markDelivered(eventKeys: readonly string[], at: Date): void {
    if (eventKeys.length === 0) {
      return;
    }
    const placeholders = eventKeys.map(() => "?").join(", ");
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE cloud_sync_outbox
           SET state = 'delivered', delivered_at = ?, last_error_code = NULL
           WHERE event_key IN (${placeholders})`
        )
        .run(at.getTime(), ...eventKeys);
      this.setSetting(settingKeys.lastSyncedAt, at.toISOString());
      this.setSetting(settingKeys.lastErrorCode, "");
    })();
  }

  public markFailed(eventKeys: readonly string[], errorCode: string): void {
    if (eventKeys.length === 0) {
      return;
    }
    const sanitizedCode = errorCode.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
    const placeholders = eventKeys.map(() => "?").join(", ");
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE cloud_sync_outbox
           SET attempts = attempts + 1, last_error_code = ?
           WHERE event_key IN (${placeholders}) AND state = 'pending'`
        )
        .run(sanitizedCode, ...eventKeys);
      this.setSetting(settingKeys.lastErrorCode, sanitizedCode);
    })();
  }

  public getState(): CloudSyncLocalState {
    const enabled = this.getSetting(settingKeys.enabled) === "true";
    const organizationId = nullIfEmpty(this.getSetting(settingKeys.organizationId));
    const deviceName = this.getSetting(settingKeys.deviceName) ?? "ForgeDeck device";
    const queuedRow = this.sqlite
      .prepare("SELECT count(*) AS count FROM cloud_sync_outbox WHERE state = 'pending'")
      .get() as { readonly count: number };
    return {
      enabled,
      organizationId,
      deviceName,
      queued: queuedRow.count,
      lastSyncedAt: nullIfEmpty(this.getSetting(settingKeys.lastSyncedAt)),
      lastErrorCode: nullIfEmpty(this.getSetting(settingKeys.lastErrorCode))
    };
  }

  public setLastErrorCode(errorCode: string | null): void {
    this.setSetting(settingKeys.lastErrorCode, errorCode ?? "");
  }

  public getEncryptedCredential(): string | null {
    return nullIfEmpty(this.getSetting(settingKeys.encryptedCredential));
  }

  public setEncryptedCredential(ciphertext: string): void {
    if (ciphertext.length === 0) {
      throw new Error("Cloud credential ciphertext must not be empty");
    }
    this.setSetting(settingKeys.encryptedCredential, ciphertext);
  }

  public clearEncryptedCredential(): void {
    this.setSetting(settingKeys.encryptedCredential, "");
  }

  public close(): void {
    this.sqlite.close();
  }

  private getSetting(key: string): string | null {
    const row = this.sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      SettingRow | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, Date.now());
  }
}

function nullIfEmpty(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}
