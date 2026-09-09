import { deviceRegistrationSchema } from "@forgedeck/schemas";
import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "../../../lib/supabase/server";

export async function POST(request: Request): Promise<NextResponse> {
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

  const parsed = deviceRegistrationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_device" }, { status: 400 });
  }

  const { data, error } = await client
    .from("devices")
    .insert({
      user_id: user.id,
      organization_id: parsed.data.organizationId,
      display_name: parsed.data.displayName,
      platform: parsed.data.platform,
      app_version: parsed.data.appVersion,
      public_key: parsed.data.publicKey,
      last_seen_at: new Date().toISOString()
    })
    .select("id, display_name, platform, app_version, revoked_at")
    .single();
  if (error !== null) {
    return NextResponse.json({ error: "device_register_forbidden" }, { status: 403 });
  }

  return NextResponse.json({ device: data }, { status: 201 });
}
