import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  getAbacatePayConfiguration,
  parseVerifiedBillingWebhook,
  verifyAbacatePayWebhookSignature
} from "./abacatepay";

const rawWebhook = JSON.stringify({
  id: "log_abc123",
  event: "subscription.payment_failed",
  apiVersion: 2,
  devMode: false,
  data: {
    subscription: {
      id: "subs_abc123",
      status: "ACTIVE",
      updatedAt: "2026-07-16T03:00:00.000Z"
    },
    customer: { id: "cust_abc123", email: "never-store@example.test" },
    payment: { externalId: "fd_checkout_9fa0ad3b-1adb-4433-8b44-587a80f2296f" }
  }
});

describe("AbacatePay billing boundary", () => {
  it("is unavailable until the billing feature and all server configuration are enabled", () => {
    expect(getAbacatePayConfiguration({ NEXT_PUBLIC_BILLING_ENABLED: "false" })).toBeNull();
    expect(
      getAbacatePayConfiguration({
        NEXT_PUBLIC_BILLING_ENABLED: "true",
        ABACATEPAY_API_KEY: "api-key",
        ABACATEPAY_WEBHOOK_SECRET: "webhook-secret",
        ABACATEPAY_WEBHOOK_PUBLIC_KEY: "public-key",
        ABACATEPAY_PRODUCT_PRO_ID: "prod-pro",
        ABACATEPAY_PRODUCT_TEAM_ID: "prod-team",
        NEXT_PUBLIC_APP_URL: "https://forgedeck.test"
      })
    ).not.toBeNull();
  });

  it("requires a valid HMAC over the raw webhook body", () => {
    const signature = createHmac("sha256", "public-key")
      .update(Buffer.from(rawWebhook, "utf8"))
      .digest("base64");
    expect(verifyAbacatePayWebhookSignature(rawWebhook, signature, "public-key")).toBe(true);
    expect(verifyAbacatePayWebhookSignature(`${rawWebhook} `, signature, "public-key")).toBe(false);
  });

  it("uses the webhook event, not redirect state, for grace entitlement changes", () => {
    const normalized = parseVerifiedBillingWebhook(
      rawWebhook,
      3,
      new Date("2026-07-16T00:00:00.000Z")
    );

    expect(normalized).toMatchObject({
      eventType: "subscription.payment_failed",
      providerSubscriptionId: "subs_abc123",
      status: "past_due",
      graceUntil: "2026-07-19T00:00:00.000Z"
    });
    expect(JSON.stringify(normalized?.sanitizedPayload)).not.toContain("never-store@example.test");
  });
});
