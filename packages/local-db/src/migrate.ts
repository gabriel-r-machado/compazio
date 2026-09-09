import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export interface RunLocalMigrationsOptions {
  readonly filename: string;
  readonly migrationsFolder?: string;
  /** Internal-only escape hatch for disposable test databases. Production migrations keep backups. */
  readonly backupBeforeMigration?: boolean;
  /** Must be derived by the main process; this option is never exposed through CLI or IPC. */
  readonly backupDirectory?: string;
}

export interface RestoreLocalDatabaseBackupOptions {
  readonly backupFilename: string;
  /** Recovery is only allowed to a new file, never over the active database. */
  readonly targetFilename: string;
}

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function runLocalMigrations(options: RunLocalMigrationsOptions): void {
  const sqlite = new Database(options.filename);
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder;

  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    if (options.backupBeforeMigration !== false) {
      const pendingTag = pendingMigrationTag(sqlite, migrationsFolder);
      if (pendingTag !== null) {
        createMigrationBackup({
          sqlite,
          sourceFilename: options.filename,
          backupDirectory:
            options.backupDirectory ?? localDatabaseBackupDirectory(options.filename),
          pendingTag
        });
      }
    }
    const database = drizzle(sqlite);
    migrate(database, {
      migrationsFolder
    });
  } finally {
    sqlite.close();
  }
}

/** The backup location is derived from the local database and is not a renderer/CLI surface. */
export function localDatabaseBackupDirectory(filename: string): string {
  return join(dirname(filename), "backups");
}

/**
 * Verifies a pre-migration snapshot and copies it only to a new explicit target. It deliberately
 * never replaces the active SQLite database or makes rollback automatic.
 */
export function restoreLocalDatabaseBackup(options: RestoreLocalDatabaseBackupOptions): void {
  if (!existsSync(options.backupFilename)) {
    throw new Error("Local database backup was not found");
  }
  if (existsSync(options.targetFilename)) {
    throw new Error("Local database recovery target already exists");
  }
  assertSqliteIntegrity(options.backupFilename, "Local database backup");
  copyFileSync(options.backupFilename, options.targetFilename, constants.COPYFILE_EXCL);
  assertSqliteIntegrity(options.targetFilename, "Recovered local database");
}

function pendingMigrationTag(sqlite: Database.Database, migrationsFolder: string): string | null {
  const migrationTable = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
    )
    .get() as { readonly name: string } | undefined;
  if (migrationTable === undefined) return null;
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")
  ) as {
    readonly entries: readonly { readonly tag: string; readonly when: number }[];
  };
  const latest = journal.entries.reduce<
    { readonly tag: string; readonly when: number } | undefined
  >(
    (current, entry) => (current === undefined || entry.when > current.when ? entry : current),
    undefined
  );
  if (latest === undefined) return null;
  const applied = sqlite
    .prepare("SELECT MAX(created_at) AS created_at FROM __drizzle_migrations")
    .get() as { readonly created_at: number | null };
  return (applied.created_at ?? 0) < latest.when ? latest.tag : null;
}

function createMigrationBackup(input: {
  readonly sqlite: Database.Database;
  readonly sourceFilename: string;
  readonly backupDirectory: string;
  readonly pendingTag: string;
}): void {
  mkdirSync(input.backupDirectory, { recursive: true });
  const snapshotFilename = join(
    input.backupDirectory,
    `${basename(input.sourceFilename)}.before-${safeFilenameToken(input.pendingTag)}-${Date.now()}-${randomUUID()}.sqlite`
  );
  input.sqlite.exec(`VACUUM INTO ${sqliteStringLiteral(snapshotFilename)}`);
  assertSqliteIntegrity(snapshotFilename, "Local database migration backup");
}

function assertSqliteIntegrity(filename: string, label: string): void {
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite.pragma("integrity_check", { simple: true });
    if (row !== "ok") throw new Error(`${label} failed integrity verification`);
  } finally {
    sqlite.close();
  }
}

function safeFilenameToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "migration";
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
