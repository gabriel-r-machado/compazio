import { NextResponse } from "next/server";

import type { BillingPlan } from "@forgedeck/schemas";

import {
  parseVerifiedBillingWebhook,
  secureEquals,
  verifyAbacatePayWebhookSignature,
  getAbacatePayConfiguration
} from "../../../../lib/billing/abacatepay";
import type { VerifiedBillingWebhook } from "../../../../lib/billing/abacatepay";
import { getSupabaseAdminClient } from "../../../../lib/supabase/server";

const maximumWebhookBytes = 256 * 1024;

interface BillingContext {
  readonly organizationId: string;
  readonly plan: BillingPlan;
  readonly checkoutSessionId: string | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const billing = getAbacatePayConfiguration();
  if (billing === null) {
    return NextResponse.json({ error: "billing_not_available" }, { status: 404 });
  }
  if (!secureEquals(billing.webhookSecret, requestUrlSecret(request))) {
    return NextResponse.json({ error: "webhook_unauthorized" }, { status: 401 });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maximumWebhookBytes) {
    return NextResponse.json({ error: "webhook_too_large" }, { status: 413 });
  }
  if (
    !verifyAbacatePayWebhookSignature(
      rawBody,
      request.headers.get("x-webhook-signature"),
      billing.webhookPublicKey
    )
  ) {
    return NextResponse.json({ error: "webhook_signature_invalid" }, { status: 401 });
  }

  const webhook = parseVerifiedBillingWebhook(rawBody, billing.gracePeriodDays);
  if (webhook === null) {
    return NextResponse.json({ error: "webhook_payload_invalid" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (admin === null) {
    return NextResponse.json({ error: "cloud_not_configured" }, { status: 503 });
  }

  try {
    const context = await resolveBillingContext(admin, webhook);
    if (context === null) {
      const { error } = await admin.from("billing_events").insert({
        provider: "abacatepay",
        provider_event_id: webhook.eventId,
        event_hash: webhook.eventHash,
        event_type: webhook.eventType,
        status: "ignored",
        sanitized_payload: webhook.sanitizedPayload
      });
      if (error !== null && error.code !== "23505") {
        return NextResponse.json({ error: "webhook_record_failed" }, { status: 500 });
      }
      return NextResponse.json({ status: "ignored_unmatched" }, { status: 202 });
    }

    const { data, error } = await admin.rpc("process_billing_webhook", {
      p_provider: "abacatepay",
      p_provider_event_id: webhook.eventId,
      p_event_hash: webhook.eventHash,
      p_event_type: webhook.eventType,
      p_organization_id: context.organizationId,
      p_provider_subscription_id: webhook.providerSubscriptionId,
      p_provider_customer_id: webhook.providerCustomerId,
      p_plan_key: context.plan,
      p_status: webhook.status,
      p_current_period_start: webhook.currentPeriodStart,
      p_current_period_end: webhook.currentPeriodEnd,
      p_grace_until: webhook.graceUntil,
      p_sanitized_payload: webhook.sanitizedPayload
    });
    if (error !== null || !isRecord(data) || typeof data.duplicate !== "boolean") {
      return NextResponse.json({ error: "webhook_process_failed" }, { status: 500 });
    }

    if (!data.duplicate && context.checkoutSessionId !== null) {
      const { error: updateError } = await admin
        .from("billing_checkout_sessions")
        .update({ state: checkoutState(webhook) })
        .eq("id", context.checkoutSessionId);
      if (updateError !== null) {
        return NextResponse.json({ error: "checkout_session_update_failed" }, { status: 500 });
      }
    }

    return NextResponse.json(
      { status: data.duplicate ? "duplicate" : "processed" },
      { status: 200 }
    );
  } catch {
    return NextResponse.json({ error: "webhook_process_failed" }, { status: 500 });
  }
}

async function resolveBillingContext(
  admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  webhook: VerifiedBillingWebhook
): Promise<BillingContext | null> {
  if (webhook.providerCheckoutId !== null) {
    const session = await findCheckoutSession(
      admin,
      "provider_checkout_id",
      webhook.providerCheckoutId
    );
    if (session !== null) {
      return session;
    }
  }
  if (webhook.externalCheckoutId !== null) {
    const session = await findCheckoutSession(admin, "external_id", webhook.externalCheckoutId);
    if (session !== null) {
      return session;
    }
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select("organization_id, plan_key")
    .eq("provider", "abacatepay")
    .eq("provider_subscription_id", webhook.providerSubscriptionId)
    .maybeSingle();
  if (error !== null) {
    throw new Error("subscription_lookup_failed");
  }
  if (
    !isRecord(data) ||
    typeof data.organization_id !== "string" ||
    !isBillingPlan(data.plan_key)
  ) {
    return null;
  }
  return { organizationId: data.organization_id, plan: data.plan_key, checkoutSessionId: null };
}

async function findCheckoutSession(
  admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  column: "provider_checkout_id" | "external_id",
  value: string
): Promise<BillingContext | null> {
  const { data, error } = await admin
    .from("billing_checkout_sessions")
    .select("id, organization_id, plan_key")
    .eq(column, value)
    .maybeSingle();
  if (error !== null) {
    throw new Error("checkout_session_lookup_failed");
  }
  if (
    !isRecord(data) ||
    typeof data.id !== "string" ||
    typeof data.organization_id !== "string" ||
    !isBillingPlan(data.plan_key)
  ) {
    return null;
  }
  return { organizationId: data.organization_id, plan: data.plan_key, checkoutSessionId: data.id };
}

function checkoutState(webhook: VerifiedBillingWebhook): "created" | "completed" | "cancelled" {
  if (webhook.eventType === "subscription.cancelled") {
    return "cancelled";
  }
  if (
    webhook.eventType === "subscription.completed" ||
    webhook.eventType === "subscription.renewed"
  ) {
    return "completed";
  }
  return "created";
}

function isBillingPlan(value: unknown): value is BillingPlan {
  return value === "pro" || value === "team";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestUrlSecret(request: Request): string | null {
  return new URL(request.url).searchParams.get("webhookSecret");
}
