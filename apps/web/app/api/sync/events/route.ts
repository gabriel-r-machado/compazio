import { cloudSyncBatchSchema, entitlementSnapshotSchema } from "@forgedeck/schemas";
import { NextResponse } from "next/server";

import { CloudSyncIngestError, ingestCloudSyncBatch } from "../../../../lib/cloud/sync-ingest";
import type { CloudSyncIngestRepository } from "../../../../lib/cloud/sync-ingest";
import { getSupabaseAccessTokenClient } from "../../../../lib/supabase/server";

const maximumRequestBytes = 256 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const accessToken = readBearerToken(request.headers.get("authorization"));
  if (accessToken === null) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumRequestBytes) {
    return NextResponse.json({ error: "sync_payload_too_large" }, { status: 413 });
  }

  const parsed = cloudSyncBatchSchema.safeParse(parseJson(body));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_sync_summary" }, { status: 400 });
  }

  const client = getSupabaseAccessTokenClient(accessToken);
  if (client === null) {
    return NextResponse.json({ error: "cloud_not_configured" }, { status: 503 });
  }

  const {
    data: { user },
    error: userError
  } = await client.auth.getUser(accessToken);
  if (userError !== null || user === null) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  const { data: entitlement, error: entitlementError } = await client
    .from("entitlements")
    .select(
      "organization_id, cloud_sync, mobile_monitor, private_templates, team_members, cloud_history_days, source, version, updated_at"
    )
    .eq("organization_id", parsed.data.organizationId)
    .maybeSingle();
  const entitlementSnapshot = entitlementSnapshotSchema.safeParse(
    entitlement === null
      ? null
      : {
          organizationId: entitlement.organization_id,
          cloudSync: entitlement.cloud_sync,
          mobileMonitor: entitlement.mobile_monitor,
          privateTemplates: entitlement.private_templates,
          teamMembers: entitlement.team_members,
          cloudHistoryDays: entitlement.cloud_history_days,
          source: entitlement.source,
          version: entitlement.version,
          updatedAt: entitlement.updated_at
        }
  );
  if (entitlementError !== null || !entitlementSnapshot.success) {
    return NextResponse.json({ error: "entitlement_required" }, { status: 403 });
  }
  if (!entitlementSnapshot.data.cloudSync) {
    return NextResponse.json({ error: "entitlement_required" }, { status: 403 });
  }

  try {
    const result = await ingestCloudSyncBatch(createRepository(client), parsed.data);
    return NextResponse.json({ ...result, entitlement: entitlementSnapshot.data }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof CloudSyncIngestError && error.code === "device_not_available") {
      return NextResponse.json({ error: error.code }, { status: 403 });
    }
    return NextResponse.json({ error: "sync_write_failed" }, { status: 403 });
  }
}

function createRepository(
  client: NonNullable<ReturnType<typeof getSupabaseAccessTokenClient>>
): CloudSyncIngestRepository {
  return {
    async hasActiveDevice(deviceId, organizationId) {
      const { data, error } = await client
        .from("devices")
        .select("id")
        .eq("id", deviceId)
        .eq("organization_id", organizationId)
        .is("revoked_at", null)
        .maybeSingle();
      return error === null && data !== null;
    },
    async upsertProject(input) {
      const { data, error } = await client
        .from("cloud_projects")
        .upsert(
          {
            organization_id: input.organizationId,
            device_id: input.deviceId,
            local_ref: input.localRef,
            display_name: input.displayName,
            sync_enabled: true
          },
          { onConflict: "organization_id,local_ref" }
        )
        .select("id")
        .single();
      return requireRecordId(data, error);
    },
    async upsertRun(input) {
      const { data, error } = await client
        .from("cloud_runs")
        .upsert(
          {
            organization_id: input.organizationId,
            project_id: input.projectId,
            local_run_ref: input.event.run.localRef,
            workflow_id: input.event.run.workflowId,
            adapter_id: input.event.run.adapterId,
            status: input.event.run.status,
            started_at: input.event.run.startedAt,
            completed_at: input.event.run.completedAt,
            duration_ms: input.event.run.durationMs,
            summary: input.event.run.summary,
            sanitized_metadata: {
              eventType: input.event.type,
              retryCount: input.event.payload.retryCount
            }
          },
          { onConflict: "project_id,local_run_ref" }
        )
        .select("id")
        .single();
      return requireRecordId(data, error);
    },
    async insertEvent(input) {
      const { error } = await client.from("cloud_run_events").upsert(
        {
          organization_id: input.organizationId,
          run_id: input.runId,
          event_key: input.event.eventKey,
          event_type: input.event.type,
          occurred_at: input.event.occurredAt,
          payload: input.event.payload
        },
        { onConflict: "run_id,event_key", ignoreDuplicates: true }
      );
      if (error !== null) {
        throw new CloudSyncIngestError("sync_write_failed");
      }
    }
  };
}

function requireRecordId(data: unknown, error: unknown): string {
  if (error !== null || !isRecord(data) || typeof data.id !== "string") {
    throw new CloudSyncIngestError("sync_write_failed");
  }
  return data.id;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readBearerToken(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{20,8192})$/.exec(value);
  return match?.[1] ?? null;
}
