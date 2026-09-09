import { describe, expect, it } from "vitest";

import type { CloudSyncEvent } from "@forgedeck/schemas";

import { CloudSyncService, CloudSyncTransportError } from "./cloud-sync";
import type {
  CloudSyncCredentialStore,
  CloudSyncStorePort,
  CloudSyncTransport
} from "./cloud-sync";

const event: CloudSyncEvent = {
  eventKey: "a".repeat(64),
  type: "run.completed",
  occurredAt: "2026-07-15T15:00:00.000Z",
  project: { localRef: "b".repeat(64), displayName: "Selected project" },
  run: {
    localRef: "c".repeat(64),
    workflowId: "bug-fix",
    adapterId: "shell",
    status: "completed",
    startedAt: "2026-07-15T14:59:00.000Z",
    completedAt: "2026-07-15T15:00:00.000Z",
    durationMs: 60000,
    summary: "All checks passed."
  },
  payload: { nodeRef: null, nodeStatus: null, retryCount: 0 }
};

describe("CloudSyncService", () => {
  it("keeps events queued and exposes a sanitized error when offline", async () => {
    const store = new MemoryCloudSyncStore();
    const credentials = new MemoryCredentialStore();
    const service = new CloudSyncService({
      cloudFeatureEnabled: true,
      store,
      credentials,
      transport: {
        async send() {
          throw new CloudSyncTransportError("network_unavailable");
        }
      }
    });

    service.configure({
      enabled: true,
      organizationId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Test desktop",
      accessToken: "x".repeat(20)
    });
    expect(service.queueRunSummary(event)).toBe(true);

    const status = await service.syncNow();
    expect(status).toMatchObject({ queued: 1, lastErrorCode: "network_unavailable" });
    expect(store.listPending()).toHaveLength(1);
  });

  it("delivers only after an explicit sync and clears the retry diagnostic", async () => {
    const store = new MemoryCloudSyncStore();
    const credentials = new MemoryCredentialStore();
    let receivedEvents = 0;
    const transport: CloudSyncTransport = {
      async send(_token, batch) {
        receivedEvents = batch.events.length;
        return successfulDelivery();
      }
    };
    const service = new CloudSyncService({
      cloudFeatureEnabled: true,
      store,
      credentials,
      transport,
      now: () => new Date("2026-07-15T15:01:00.000Z")
    });

    service.configure({
      enabled: true,
      organizationId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Test desktop",
      accessToken: "x".repeat(20)
    });
    service.queueRunSummary(event);

    const status = await service.syncNow();
    expect(receivedEvents).toBe(1);
    expect(status).toMatchObject({
      queued: 0,
      lastErrorCode: null,
      configured: true,
      entitlement: { cloudSync: true, source: "subscription" }
    });
  });

  it("does not queue or call cloud transport while the local-first feature flag is off", async () => {
    const store = new MemoryCloudSyncStore();
    const credentials = new MemoryCredentialStore();
    let calls = 0;
    const service = new CloudSyncService({
      cloudFeatureEnabled: false,
      store,
      credentials,
      transport: {
        async send() {
          calls += 1;
          return successfulDelivery();
        }
      }
    });

    expect(service.queueRunSummary(event)).toBe(false);
    await service.syncNow();
    expect(calls).toBe(0);
    expect(service.status().entitlement.cloudSync).toBe(false);
  });
});

class MemoryCloudSyncStore implements CloudSyncStorePort {
  private enabled = false;
  private organizationId: string | null = null;
  private readonly events = new Map<string, CloudSyncEvent>();
  private lastSyncedAt: string | null = null;
  private lastErrorCode: string | null = null;

  public configure(input: {
    readonly enabled: boolean;
    readonly organizationId: string | null;
    readonly deviceName: string;
  }): void {
    this.enabled = input.enabled;
    this.organizationId = input.organizationId;
  }

  public enqueue(input: CloudSyncEvent): boolean {
    if (this.events.has(input.eventKey)) {
      return false;
    }
    this.events.set(input.eventKey, input);
    return true;
  }

  public listPending(): readonly CloudSyncEvent[] {
    return [...this.events.values()];
  }

  public markDelivered(eventKeys: readonly string[], at: Date): void {
    for (const eventKey of eventKeys) {
      this.events.delete(eventKey);
    }
    this.lastSyncedAt = at.toISOString();
    this.lastErrorCode = null;
  }

  public markFailed(_eventKeys: readonly string[], errorCode: string): void {
    this.lastErrorCode = errorCode;
  }

  public setLastErrorCode(errorCode: string | null): void {
    this.lastErrorCode = errorCode;
  }

  public getState() {
    return {
      enabled: this.enabled,
      organizationId: this.organizationId,
      queued: this.events.size,
      lastSyncedAt: this.lastSyncedAt,
      lastErrorCode: this.lastErrorCode
    };
  }
}

function successfulDelivery() {
  return {
    accepted: 1,
    entitlement: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      cloudSync: true,
      mobileMonitor: true,
      privateTemplates: true,
      teamMembers: 1,
      cloudHistoryDays: 90,
      source: "subscription" as const,
      version: 1,
      updatedAt: "2026-07-15T15:01:00.000Z"
    }
  };
}

class MemoryCredentialStore implements CloudSyncCredentialStore {
  private value: string | null = null;

  public isAvailable(): boolean {
    return true;
  }

  public hasValue(): boolean {
    return this.value !== null;
  }

  public load(): string | null {
    return this.value;
  }

  public save(value: string): void {
    this.value = value;
  }

  public clear(): void {
    this.value = null;
  }
}
