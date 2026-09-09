import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";

import { UpdateService } from "./update-service";

describe("UpdateService", () => {
  it("não inicializa o updater em desenvolvimento", async () => {
    const service = new UpdateService({ packaged: false, shutdown: vi.fn(async () => undefined) });
    service.initialize();
    expect(service.status()).toEqual({
      state: "idle",
      version: null,
      progress: null,
      error: null,
      autoCheck: true
    });
    expect(await service.check()).toEqual(service.status());
  });

  it("mantém a preferência de verificação automática tipada", () => {
    const service = new UpdateService({ packaged: false, shutdown: vi.fn(async () => undefined) });
    expect(service.setAutoCheck(false).autoCheck).toBe(false);
    expect(service.status().state).toBe("idle");
  });

  it("executa o ciclo local A→B com confirmação e bloqueia instalação durante trabalho ativo", async () => {
    const updater = new FakeUpdater();
    const shutdown = vi.fn(async () => undefined);
    let hasActiveWork = true;
    const service = new UpdateService({
      packaged: true,
      channel: "beta",
      shutdown,
      canInstall: () => !hasActiveWork,
      updaterLoader: async () => ({ autoUpdater: updater as unknown as AppUpdater })
    });

    service.initialize();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledTimes(1));
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.channel).toBe("beta");
    expect(updater.allowPrerelease).toBeUndefined();
    expect(updater.allowDowngrade).toBeUndefined();

    updater.emit("update-available", { version: "0.1.0-beta.3" });
    expect(service.status()).toMatchObject({ state: "available", version: "0.1.0-beta.3" });
    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    updater.emit("update-downloaded", { version: "0.1.0-beta.3" });
    await expect(service.install()).rejects.toThrow("trabalho ativo");
    expect(shutdown).not.toHaveBeenCalled();

    hasActiveWork = false;
    await service.install();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("mantém a instalação atual quando não há update ou a rede falha", async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService({
      packaged: true,
      shutdown: vi.fn(async () => undefined),
      updaterLoader: async () => ({ autoUpdater: updater as unknown as AppUpdater })
    });
    service.initialize();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledTimes(1));

    updater.emit("update-not-available", { version: "0.1.0-beta.6" });
    expect(service.status()).toMatchObject({ state: "not-available", version: "0.1.0-beta.6" });

    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await service.check();
    expect(service.status()).toMatchObject({
      state: "error",
      error: "Não foi possível verificar atualizações."
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

class FakeUpdater {
  public autoDownload: boolean | undefined;
  public autoInstallOnAppQuit: boolean | undefined;
  public allowPrerelease: boolean | undefined;
  public allowDowngrade: boolean | undefined;
  public channel: string | undefined;
  public readonly checkForUpdates = vi.fn(async () => undefined);
  public readonly downloadUpdate = vi.fn(async () => undefined);
  public readonly quitAndInstall = vi.fn();
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  public on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  public removeAllListeners(event: string): this {
    this.listeners.delete(event);
    return this;
  }

  public emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload as never);
  }
}
