import { NextResponse } from "next/server";

import {
  createAbacatePayGateway,
  getAbacatePayConfiguration,
  secureEquals
} from "../../../../lib/billing/abacatepay";
import { getSupabaseAdminClient } from "../../../../lib/supabase/server";

const statesToReconcile = ["pending", "created"] as const;

export async function POST(request: Request): Promise<NextResponse> {
  const billing = getAbacatePayConfiguration();
  const reconciliationSecret = process.env.BILLING_RECONCILIATION_SECRET?.trim();
  if (billing === null || reconciliationSecret === undefined || reconciliationSecret.length === 0) {
    return NextResponse.json({ error: "billing_not_available" }, { status: 404 });
  }
  if (!secureEquals(`Bearer ${reconciliationSecret}`, request.headers.get("authorization"))) {
    return NextResponse.json({ error: "reconciliation_unauthorized" }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();
  if (admin === null) {
    return NextResponse.json({ error: "cloud_not_configured" }, { status: 503 });
  }
  const { data, error } = await admin
    .from("billing_checkout_sessions")
    .select("id, external_id")
    .in("state", statesToReconcile)
    .limit(100);
  if (error !== null || data === null) {
    return NextResponse.json({ error: "reconciliation_query_failed" }, { status: 500 });
  }

  try {
    const gateway = createAbacatePayGateway(billing);
    let updatedSessions = 0;
    for (const row of data) {
      if (!isCheckoutSession(row)) {
        return NextResponse.json({ error: "reconciliation_data_invalid" }, { status: 500 });
      }
      const checkout = await gateway.findCheckoutByExternalId(row.external_id);
      if (checkout === null) {
        continue;
      }
      const nextState = mapProviderCheckoutState(checkout.status);
      const { error: updateError } = await admin
        .from("billing_checkout_sessions")
        .update({ provider_checkout_id: checkout.id, state: nextState })
        .eq("id", row.id);
      if (updateError !== null) {
        return NextResponse.json({ error: "reconciliation_update_failed" }, { status: 500 });
      }
      updatedSessions += 1;
    }

    const { data: entitlementsReconciled, error: reconciliationError } = await admin.rpc(
      "reconcile_billing_entitlements"
    );
    if (reconciliationError !== null || typeof entitlementsReconciled !== "number") {
      return NextResponse.json({ error: "entitlement_reconciliation_failed" }, { status: 500 });
    }

    return NextResponse.json({ updatedSessions, entitlementsReconciled }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "reconciliation_provider_unavailable" }, { status: 503 });
  }
}

function isCheckoutSession(value: unknown): value is Readonly<{ id: string; external_id: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    "external_id" in value &&
    typeof value.external_id === "string"
  );
}

function mapProviderCheckoutState(
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED" | "REFUNDED"
): "pending" | "completed" | "expired" | "cancelled" {
  switch (status) {
    case "PAID":
      return "completed";
    case "EXPIRED":
      return "expired";
    case "CANCELLED":
    case "REFUNDED":
      return "cancelled";
    case "PENDING":
      return "pending";
  }
}
