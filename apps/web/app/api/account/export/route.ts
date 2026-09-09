import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "../../../../lib/supabase/server";

export async function GET(): Promise<NextResponse> {
  const client = await getSupabaseServerClient();
  if (client === null) {
    return NextResponse.json({ error: "cloud_not_configured" }, { status: 503 });
  }

  const {
    data: { user }
  } = await client.auth.getUser();
  if (user === null) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  const [profile, organizations, memberships, devices, runs, entitlements, subscriptions] =
    await Promise.all([
      client
        .from("profiles")
        .select("id, display_name, avatar_url, created_at, updated_at")
        .eq("id", user.id)
        .maybeSingle(),
      client.from("organizations").select("id, name, slug, created_at, updated_at"),
      client
        .from("organization_members")
        .select("organization_id, user_id, role, revoked_at, created_at")
        .eq("user_id", user.id),
      client
        .from("devices")
        .select("id, organization_id, display_name, platform, app_version, revoked_at, created_at"),
      client
        .from("cloud_runs")
        .select(
          "id, organization_id, status, workflow_id, adapter_id, started_at, completed_at, duration_ms, summary, created_at, updated_at"
        ),
      client
        .from("entitlements")
        .select(
          "organization_id, cloud_sync, mobile_monitor, private_templates, team_members, cloud_history_days, source, version, updated_at"
        ),
      client
        .from("subscriptions")
        .select(
          "organization_id, provider, plan_key, status, current_period_start, current_period_end, grace_until, cancel_at_period_end, created_at, updated_at"
        )
    ]);

  const document = {
    schemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email ?? null,
      profile: profile.data
    },
    organizations: organizations.data ?? [],
    memberships: memberships.data ?? [],
    devices: devices.data ?? [],
    runSummaries: runs.data ?? [],
    entitlements: entitlements.data ?? [],
    subscriptions: subscriptions.data ?? []
  };

  return new NextResponse(JSON.stringify(document), {
    headers: {
      "content-disposition": 'attachment; filename="forgedeck-cloud-export.json"',
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
