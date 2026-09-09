import { communityFallbackEntitlements } from "@forgedeck/core";
import {
  cloudSyncBatchSchema,
  cloudSyncConfigureRequestSchema,
  cloudSyncDeliveryResponseSchema,
  cloudSyncEventSchema,
  cloudSyncStatusSchema
} from "@forgedeck/schemas";
import type {
  CapabilityEntitlements,
  CloudSyncBatch,
  CloudSyncConfigureRequest,
  CloudSyncDeliveryResponse,
  CloudSyncEvent,
  CloudSyncStatus
} from "@forgedeck/schemas";

export interface CloudSyncStorePort {
  configure(input: {
    readonly enabled: boolean;
    readonly organizationId: string | null;
    readonly deviceName: string;
  }): void;
  enqueue(event: CloudSyncEvent): boolean;
  listPending(limit?: number): readonly CloudSyncEvent[];
  markDelivered(eventKeys: readonly string[], at: Date): void;
  markFailed(eventKeys: readonly string[], errorCode: string): void;
  setLastErrorCode(errorCode: string | null): void;
  getState(): {
    readonly enabled: boolean;
    readonly organizationId: string | null;
    readonly queued: number;
    readonly lastSyncedAt: string | null;
    readonly lastErrorCode: string | null;
  };
}

export interface CloudSyncCredentialStore {
  isAvailable(): boolean;
  hasValue(): boolean;
  load(): string | null;
  save(value: string): void;
  clear(): void;
}

export interface CloudSyncTransport {
  send(accessToken: string, batch: CloudSyncBatch): Promise<CloudSyncDeliveryResponse>;
}

export interface CloudSyncServiceOptions {
  readonly cloudFeatureEnabled: boolean;
  readonly store: CloudSyncStorePort;
  readonly credentials: CloudSyncCredentialStore;
  readonly transport: CloudSyncTransport | null;
  readonly now?: () => Date;
}

export class CloudSyncTransportError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "CloudSyncTransportError";
  }
}

export class CloudSyncService {
  private readonly now: () => Date;
  private entitlement: CapabilityEntitlements = communityFallbackEntitlements();

  public constructor(private readonly options: CloudSyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public configure(input: CloudSyncConfigureRequest): CloudSyncStatus {
    const request = cloudSyncConfigureRequestSchema.parse(input);
    if (!request.enabled) {
      this.options.store.configure({
        enabled: false,
        organizationId: null,
        deviceName: request.deviceName
      });
      this.options.credentials.clear();
      this.entitlement = communityFallbackEntitlements();
      return this.status();
    }

    if (!this.options.cloudFeatureEnabled) {
      throw new Error("Cloud sync is disabled by feature flag");
    }
    if (this.options.transport === null) {
      throw new Error("Cloud sync endpoint is not configured");
    }
    if (!this.options.credentials.isAvailable()) {
      throw new Error("OS secure credential storage is unavailable");
    }
    if (request.organizationId === null || request.accessToken === null) {
      throw new Error("Cloud sync requires an organization and access token");
    }

    this.options.credentials.save(request.accessToken);
    this.options.store.configure({
      enabled: true,
      organizationId: request.organizationId,
      deviceName: request.deviceName
    });
    this.entitlement = communityFallbackEntitlements();
    return this.status();
  }

  public queueRunSummary(event: CloudSyncEvent): boolean {
    const parsed = cloudSyncEventSchema.parse(event);
    const state = this.options.store.getState();
    if (!this.options.cloudFeatureEnabled || !state.enabled) {
      return false;
    }
    return this.options.store.enqueue(parsed);
  }

  public async syncNow(): Promise<CloudSyncStatus> {
    const state = this.options.store.getState();
    if (!this.options.cloudFeatureEnabled || !state.enabled) {
      return this.status();
    }
    if (this.options.transport === null || state.organizationId === null) {
      this.options.store.setLastErrorCode("configuration_unavailable");
      return this.status();
    }

    let accessToken: string | null;
    try {
      accessToken = this.options.credentials.load();
    } catch {
      this.options.store.setLastErrorCode("credential_unavailable");
      return this.status();
    }
    if (accessToken === null) {
      this.options.store.setLastErrorCode("credential_unavailable");
      return this.status();
    }

    const events = this.options.store.listPending();
    if (events.length === 0) {
      return this.status();
    }

    const batch = cloudSyncBatchSchema.parse({
      organizationId: state.organizationId,
      deviceId: null,
      events
    });
    const eventKeys = events.map((event) => event.eventKey);
    try {
      const delivery = await this.options.transport.send(accessToken, batch);
      if (delivery.accepted !== events.length) {
        throw new CloudSyncTransportError("cloud_response_invalid");
      }
      this.entitlement = toCapabilityEntitlements(delivery.entitlement);
      this.options.store.markDelivered(eventKeys, this.now());
    } catch (error: unknown) {
      this.options.store.markFailed(eventKeys, toErrorCode(error));
    }
    return this.status();
  }

  public disconnect(): CloudSyncStatus {
    const state = this.options.store.getState();
    this.options.store.configure({
      enabled: false,
      organizationId: null,
      deviceName: "ForgeDeck device"
    });
    this.options.credentials.clear();
    this.entitlement = communityFallbackEntitlements();
    if (state.queued > 0) {
      this.options.store.setLastErrorCode("sync_disconnected");
    }
    return this.status();
  }

  public status(): CloudSyncStatus {
    const state = this.options.store.getState();
    return cloudSyncStatusSchema.parse({
      available: this.options.cloudFeatureEnabled && this.options.transport !== null,
      enabled: state.enabled,
      configured:
        state.enabled &&
        state.organizationId !== null &&
        this.options.credentials.isAvailable() &&
        this.options.credentials.hasValue(),
      organizationId: state.organizationId,
      queued: state.queued,
      lastSyncedAt: state.lastSyncedAt,
      lastErrorCode: state.lastErrorCode,
      entitlement: this.entitlement
    });
  }
}

export function createFetchCloudSyncTransport(endpoint: string): CloudSyncTransport {
  const url = new URL(endpoint);
  const isLocalDevelopment =
    url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("Cloud sync endpoint must use HTTPS outside local development");
  }

  return {
    async send(accessToken: string, batch: CloudSyncBatch): Promise<CloudSyncDeliveryResponse> {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(batch)
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new CloudSyncTransportError("authentication_rejected");
        }
        if (response.status === 403) {
          throw new CloudSyncTransportError("entitlement_required");
        }
        throw new CloudSyncTransportError("cloud_service_unavailable");
      }
      const parsed = cloudSyncDeliveryResponseSchema.safeParse(
        await response.json().catch(() => null)
      );
      if (!parsed.success) {
        throw new CloudSyncTransportError("cloud_response_invalid");
      }
      return parsed.data;
    }
  };
}

function toErrorCode(error: unknown): string {
  if (error instanceof CloudSyncTransportError) {
    return error.code;
  }
  return "network_unavailable";
}

function toCapabilityEntitlements(
  delivery: CloudSyncDeliveryResponse["entitlement"]
): CapabilityEntitlements {
  return {
    cloudSync: delivery.cloudSync,
    mobileMonitor: delivery.mobileMonitor,
    privateTemplates: delivery.privateTemplates,
    teamMembers: delivery.teamMembers,
    cloudHistoryDays: delivery.cloudHistoryDays,
    source: delivery.source
  };
}
