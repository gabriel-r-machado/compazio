import { safeStorage } from "electron";

import type { SqliteCloudSyncStore } from "@forgedeck/local-db";

import type { CloudSyncCredentialStore } from "./cloud-sync";

export class ElectronCloudCredentialStore implements CloudSyncCredentialStore {
  public constructor(
    private readonly store: Pick<
      SqliteCloudSyncStore,
      "clearEncryptedCredential" | "getEncryptedCredential" | "setEncryptedCredential"
    >
  ) {}

  public isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  public hasValue(): boolean {
    return this.store.getEncryptedCredential() !== null;
  }

  public load(): string | null {
    const ciphertext = this.store.getEncryptedCredential();
    if (ciphertext === null) {
      return null;
    }
    if (!this.isAvailable()) {
      throw new Error("OS secure credential storage is unavailable");
    }
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  }

  public save(value: string): void {
    if (!this.isAvailable()) {
      throw new Error("OS secure credential storage is unavailable");
    }
    this.store.setEncryptedCredential(safeStorage.encryptString(value).toString("base64"));
  }

  public clear(): void {
    this.store.clearEncryptedCredential();
  }
}
