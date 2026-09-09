import { billingCancelRequestSchema } from "@forgedeck/schemas";
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

  const parsed = billingCancelRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_cancellation_request" }, { status: 400 });
  }
  if (!(await canManageBilling(client, user.id, parsed.data.organizationId))) {
    return NextResponse.json({ error: "billing_admin_required" }, { status: 403 });
  }

  const { data: subscription, error: subscriptionError } = await client
    .from("subscriptions")
    .select("provider_subscription_id")
    .eq("organization_id", parsed.data.organizationId)
    .eq("provider", "abacatepay")
    .maybeSingle();
  if (
    subscriptionError !== null ||
    subscription === null ||
    subscription.provider_subscription_id === null
  ) {
    return NextResponse.json({ error: "active_subscription_not_found" }, { status: 409 });
  }

  try {
    await createAbacatePayGateway(billing).cancelSubscription(
      subscription.provider_subscription_id
    );
    await admin.from("audit_logs").insert({
      organization_id: parsed.data.organizationId,
      actor_user_id: user.id,
      action: "billing.cancellation_requested",
      target_type: "subscription",
      target_id: subscription.provider_subscription_id,
      metadata: { provider: "abacatepay" }
    });
    return NextResponse.json({ status: "awaiting_verified_webhook" }, { status: 202 });
  } catch (error: unknown) {
    const status = error instanceof AbacatePayError ? 503 : 500;
    return NextResponse.json({ error: "cancellation_provider_unavailable" }, { status });
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
