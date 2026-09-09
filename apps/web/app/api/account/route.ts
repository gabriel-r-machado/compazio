import { accountDeletionRequestSchema } from "@forgedeck/schemas";
import { NextResponse } from "next/server";

import { getSupabaseAdminClient, getSupabaseServerClient } from "../../../lib/supabase/server";

export async function DELETE(request: Request): Promise<NextResponse> {
  const client = await getSupabaseServerClient();
  const adminClient = getSupabaseAdminClient();
  if (client === null || adminClient === null) {
    return NextResponse.json({ error: "cloud_not_configured" }, { status: 503 });
  }

  const {
    data: { user }
  } = await client.auth.getUser();
  if (user === null) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  const parsed = accountDeletionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "explicit_confirmation_required" }, { status: 400 });
  }

  const { error: signOutError } = await client.auth.signOut({ scope: "global" });
  if (signOutError !== null) {
    return NextResponse.json({ error: "session_revocation_failed" }, { status: 409 });
  }

  const { error } = await adminClient.rpc("delete_cloud_account", { p_user_id: user.id });
  if (error !== null) {
    return NextResponse.json(
      {
        error: "account_delete_blocked",
        remediation: "Transfer ownership of shared organizations first."
      },
      { status: 409 }
    );
  }

  return new NextResponse(null, { status: 204 });
}
