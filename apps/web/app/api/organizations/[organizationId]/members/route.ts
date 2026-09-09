import { organizationMembershipChangeSchema } from "@forgedeck/schemas";
import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "../../../../../lib/supabase/server";

interface RouteContext {
  readonly params: Promise<{ readonly organizationId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId } = await context.params;
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

  const parsed = organizationMembershipChangeSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(organizationId)) {
    return NextResponse.json({ error: "invalid_membership" }, { status: 400 });
  }

  const { data, error } = await client
    .from("organization_members")
    .upsert(
      {
        organization_id: organizationId,
        user_id: parsed.data.userId,
        role: parsed.data.role,
        revoked_at: null
      },
      { onConflict: "organization_id,user_id" }
    )
    .select("organization_id, user_id, role, revoked_at")
    .single();
  if (error !== null) {
    return NextResponse.json({ error: "membership_change_forbidden" }, { status: 403 });
  }

  return NextResponse.json({ membership: data });
}
