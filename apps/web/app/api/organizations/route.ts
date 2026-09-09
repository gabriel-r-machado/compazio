import { organizationCreateSchema } from "@forgedeck/schemas";
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

  const parsed = organizationCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  }

  const { data, error } = await client
    .from("organizations")
    .insert({ name: parsed.data.name, slug: parsed.data.slug, owner_id: user.id })
    .select("id, name, slug")
    .single();
  if (error !== null) {
    return NextResponse.json({ error: "organization_create_failed" }, { status: 409 });
  }

  return NextResponse.json({ organization: data }, { status: 201 });
}
