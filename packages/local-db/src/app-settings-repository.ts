import Database from "better-sqlite3";

export type AppLocale = "pt-BR" | "en";
export type AppTheme = "dark" | "light";

const localeKey = "ui.locale";
const themeKey = "ui.theme";
const activeWorkspaceKey = "ui.active-workspace-id";

export class SqliteAppSettingsRepository {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public getLocale(): AppLocale {
    const stored = this.read(localeKey);
    return stored === "en" || stored === "pt-BR" ? stored : "pt-BR";
  }

  public setLocale(locale: AppLocale): void {
    this.write(localeKey, locale);
  }

  public getTheme(): AppTheme {
    return this.read(themeKey) === "light" ? "light" : "dark";
  }

  public setTheme(theme: AppTheme): void {
    this.write(themeKey, theme);
  }

  public getActiveWorkspaceId(): string | null {
    const value = this.read(activeWorkspaceKey);
    return value === null || value.length === 0 ? null : value;
  }

  public setActiveWorkspaceId(workspaceId: string | null): void {
    if (workspaceId === null) {
      this.sqlite.prepare("DELETE FROM app_settings WHERE key = ?").run(activeWorkspaceKey);
      return;
    }
    if (workspaceId.length < 1 || workspaceId.length > 160) {
      throw new Error("Active workspace id is invalid");
    }
    this.write(activeWorkspaceKey, workspaceId);
  }

  public close(): void {
    this.sqlite.close();
  }

  private read(key: string): string | null {
    const row = this.sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      { readonly value: string } | undefined;
    return row?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, this.now().getTime());
  }
}
