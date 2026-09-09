import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "../../../lib/supabase/server";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const destination = new URL("/account", url.origin);

  if (code === null) {
    destination.searchParams.set("error", "missing_auth_code");
    return NextResponse.redirect(destination);
  }

  const client = await getSupabaseServerClient();
  if (client === null) {
    destination.searchParams.set("error", "cloud_not_configured");
    return NextResponse.redirect(destination);
  }

  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error !== null) {
    destination.searchParams.set("error", "auth_exchange_failed");
  }

  return NextResponse.redirect(destination);
}
