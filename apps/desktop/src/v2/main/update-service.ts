import type { AppUpdater } from "electron-updater";

type ElectronUpdater = AppUpdater;
interface UpdaterModule {
  readonly default?: { readonly autoUpdater: ElectronUpdater };
  readonly autoUpdater?: ElectronUpdater;
}
type UpdaterLoader = () => Promise<UpdaterModule>;

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface UpdateStatus {
  readonly state: UpdateState;
  readonly version: string | null;
  readonly progress: number | null;
  readonly error: string | null;
  readonly autoCheck: boolean;
}

export interface UpdateServiceOptions {
  readonly packaged: boolean;
  readonly channel?: string;
  readonly shutdown: () => Promise<void>;
  readonly canInstall?: () => boolean;
  readonly onStatus?: (status: UpdateStatus) => void;
  /** Test-only seam. Production loads electron-updater lazily in the main process. */
  readonly updaterLoader?: UpdaterLoader;
}

/** Main-process-only update coordinator. It never exposes electron-updater to the renderer. */
export class UpdateService {
  private current: UpdateStatus = {
    state: "idle",
    version: null,
    progress: null,
    error: null,
    autoCheck: true
  };
  private initialized = false;
  private checkInFlight: Promise<UpdateStatus> | null = null;
  private updater: ElectronUpdater | null = null;

  public constructor(private readonly options: UpdateServiceOptions) {}

  public initialize(): void {
    if (!this.options.packaged || this.initialized) return;
    this.initialized = true;
    void this.initializeUpdater();
  }

  public status(): UpdateStatus {
    return { ...this.current };
  }

  public async check(): Promise<UpdateStatus> {
    if (!this.options.packaged || this.updater === null) return this.status();
    if (this.checkInFlight !== null) return this.checkInFlight;
    this.checkInFlight = this.updater
      .checkForUpdates()
      .then(() => this.status())
      .catch(() => {
        this.publish({ state: "error", error: "Não foi possível verificar atualizações." });
        return this.status();
      })
      .finally(() => {
        this.checkInFlight = null;
      });
    return this.checkInFlight;
  }

  public async download(): Promise<UpdateStatus> {
    if (!this.options.packaged || this.updater === null || this.current.state !== "available")
      return this.status();
    try {
      await this.updater.downloadUpdate();
      return this.status();
    } catch {
      this.publish({ state: "error", error: "Não foi possível baixar a atualização." });
      return this.status();
    }
  }

  public async install(): Promise<void> {
    if (!this.options.packaged || this.updater === null || this.current.state !== "downloaded")
      return;
    if (this.options.canInstall !== undefined && !this.options.canInstall())
      throw new Error("A atualização só pode ser instalada após encerrar o trabalho ativo.");
    this.publish({ state: "installing", error: null });
    await this.options.shutdown();
    // NSIS must run silently when invoked by the in-app updater; the second argument keeps the
    // updated application relaunch behavior unchanged after installation.
    this.updater.quitAndInstall(true, true);
  }

  public setAutoCheck(enabled: boolean): UpdateStatus {
    this.publish({ autoCheck: enabled });
    return this.status();
  }

  public shutdown(): void {
    if (!this.initialized) return;
    this.initialized = false;
    if (this.updater === null) return;
    for (const event of [
      "checking-for-update",
      "update-available",
      "update-not-available",
      "download-progress",
      "update-downloaded",
      "error"
    ] as const)
      this.updater.removeAllListeners(event);
    this.updater = null;
  }

  private async initializeUpdater(): Promise<void> {
    try {
      const module = await (this.options.updaterLoader ?? loadElectronUpdater)();
      if (!this.initialized) return;
      const electronUpdater = module.default ?? module;
      if (electronUpdater.autoUpdater === undefined) throw new Error("Updater unavailable");
      this.updater = electronUpdater.autoUpdater;
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      // electron-updater enables GitHub pre-releases by default for the beta semver already
      // packaged by this app. Do not force it here: setting it also permits downgrade behavior.
      if (this.options.channel !== undefined) this.updater.channel = this.options.channel;
      this.updater.on("checking-for-update", () =>
        this.publish({ state: "checking", error: null })
      );
      this.updater.on("update-available", (info) =>
        this.publish({ state: "available", version: info.version, progress: 0, error: null })
      );
      this.updater.on("update-not-available", (info) =>
        this.publish({ state: "not-available", version: info.version, progress: null, error: null })
      );
      this.updater.on("download-progress", (progress) =>
        this.publish({
          state: "downloading",
          progress: Math.max(0, Math.min(100, progress.percent)),
          error: null
        })
      );
      this.updater.on("update-downloaded", (info) =>
        this.publish({ state: "downloaded", version: info.version, progress: 100, error: null })
      );
      this.updater.on("error", () =>
        this.publish({ state: "error", error: "Não foi possível verificar atualizações." })
      );
      if (this.current.autoCheck) void this.check();
    } catch {
      this.publish({ state: "error", error: "Não foi possível preparar o atualizador." });
    }
  }

  private publish(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch };
    this.options.onStatus?.(this.status());
  }
}

async function loadElectronUpdater(): Promise<UpdaterModule> {
  return import("electron-updater");
}
