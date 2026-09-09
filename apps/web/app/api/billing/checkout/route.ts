import { randomUUID } from "node:crypto";

import { billingCheckoutRequestSchema } from "@forgedeck/schemas";
import { NextResponse } from "next/server";

import {
  AbacatePayError,
  createAbacatePayGateway,
  getAbacatePayConfiguration
} from "../../../../lib/billing/abacatepay";
import { getSupabaseAdminClient, getSupabaseServerClient } from "../../../../lib/supabase/server";

export async function POST(request: Request): Promise<NextResponse> {
  const billing = getAbacatePayConfiguration();
  if (billing === null) {
    return NextResponse.json({ error: "billing_not_available" }, { status: 404 });
  }

  const client = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  if (client === null || admin === null) {
    return NextResponse.json({ error: "cloud_not_configured" }, { status: 503 });
  }

  const {
    data: { user }
  } = await client.auth.getUser();
  if (user === null) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  const parsed = billingCheckoutRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_checkout_request" }, { status: 400 });
  }
  if (!(await canManageBilling(client, user.id, parsed.data.organizationId))) {
    return NextResponse.json({ error: "billing_admin_required" }, { status: 403 });
  }

  const externalId = `fd_checkout_${randomUUID()}`;
  const { error: sessionError } = await admin.from("billing_checkout_sessions").insert({
    organization_id: parsed.data.organizationId,
    initiated_by: user.id,
    external_id: externalId,
    plan_key: parsed.data.plan,
    state: "pending"
  });
  if (sessionError !== null) {
    return NextResponse.json({ error: "checkout_session_create_failed" }, { status: 500 });
  }

  try {
    const checkout = await createAbacatePayGateway(billing).createSubscriptionCheckout({
      externalId,
      plan: parsed.data.plan
    });
    const { error: updateError } = await admin
      .from("billing_checkout_sessions")
      .update({ provider_checkout_id: checkout.id, state: "created" })
      .eq("external_id", externalId);
    if (updateError !== null) {
      return NextResponse.json({ error: "checkout_session_update_failed" }, { status: 500 });
    }
    return NextResponse.json({ checkoutUrl: checkout.url }, { status: 201 });
  } catch (error: unknown) {
    await admin
      .from("billing_checkout_sessions")
      .update({ state: "failed" })
      .eq("external_id", externalId);
    const status = error instanceof AbacatePayError ? 503 : 500;
    return NextResponse.json({ error: "checkout_provider_unavailable" }, { status });
  }
}

async function canManageBilling(
  client: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await client
    .from("organization_members")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .in("role", ["owner", "admin"])
    .is("revoked_at", null)
    .maybeSingle();
  return error === null && data !== null;
}
