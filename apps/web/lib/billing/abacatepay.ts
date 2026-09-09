import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { BillingPlan, SubscriptionStatus } from "@forgedeck/schemas";

type Environment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = typeof fetch;

const providerEventSchema = z.enum([
  "subscription.trial_started",
  "subscription.completed",
  "subscription.renewed",
  "subscription.payment_failed",
  "subscription.cancelled"
]);

const subscriptionPayloadSchema = z
  .object({
    id: z.string().min(1).max(160),
    status: z.string().min(1).max(40),
    trialEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
    updatedAt: z.string().datetime({ offset: true }).optional()
  })
  .passthrough();

const webhookEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(160),
    event: providerEventSchema,
    apiVersion: z.literal(2),
    devMode: z.boolean().optional(),
    data: z
      .object({
        subscription: subscriptionPayloadSchema,
        customer: z
          .object({ id: z.string().min(1).max(160) })
          .passthrough()
          .optional(),
        checkout: z
          .object({
            id: z.string().min(1).max(160),
            externalId: z.string().min(1).max(160).nullable().optional()
          })
          .passthrough()
          .optional(),
        payment: z
          .object({ externalId: z.string().min(1).max(160).nullable().optional() })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

const checkoutResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        id: z.string().min(1).max(160),
        url: z.string().url().max(2048)
      })
      .passthrough()
  })
  .passthrough();

const checkoutLookupResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(
      z
        .object({
          id: z.string().min(1).max(160),
          externalId: z.string().min(1).max(160).nullable().optional(),
          status: z.enum(["PENDING", "PAID", "EXPIRED", "CANCELLED", "REFUNDED"])
        })
        .passthrough()
    )
  })
  .passthrough();

const cancellationResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ id: z.string().min(1).max(160) }).passthrough()
  })
  .passthrough();

export interface AbacatePayConfiguration {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly webhookPublicKey: string;
  readonly apiBaseUrl: string;
  readonly productIds: Readonly<Record<BillingPlan, string>>;
  readonly applicationUrl: string;
  readonly gracePeriodDays: number;
}

export interface ProviderCheckout {
  readonly id: string;
  readonly url: string;
}

export interface ProviderCheckoutStatus {
  readonly id: string;
  readonly status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED" | "REFUNDED";
}

export interface AbacatePayGateway {
  createSubscriptionCheckout(input: {
    readonly externalId: string;
    readonly plan: BillingPlan;
  }): Promise<ProviderCheckout>;
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
  findCheckoutByExternalId(externalId: string): Promise<ProviderCheckoutStatus | null>;
}

export interface VerifiedBillingWebhook {
  readonly eventId: string;
  readonly eventType: z.infer<typeof providerEventSchema>;
  readonly providerSubscriptionId: string;
  readonly providerCustomerId: string | null;
  readonly providerCheckoutId: string | null;
  readonly externalCheckoutId: string | null;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly graceUntil: string | null;
  readonly eventHash: string;
  readonly sanitizedPayload: Readonly<Record<string, string | null>>;
}

export class AbacatePayError extends Error {
  public constructor(public readonly code: "provider_unavailable" | "provider_response_invalid") {
    super(code);
    this.name = "AbacatePayError";
  }
}

export function getAbacatePayConfiguration(
  environment: Environment = process.env
): AbacatePayConfiguration | null {
  if (environment.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
    return null;
  }

  const apiKey = environment.ABACATEPAY_API_KEY?.trim();
  const webhookSecret = environment.ABACATEPAY_WEBHOOK_SECRET?.trim();
  const webhookPublicKey = environment.ABACATEPAY_WEBHOOK_PUBLIC_KEY?.trim();
  const proProductId = environment.ABACATEPAY_PRODUCT_PRO_ID?.trim();
  const teamProductId = environment.ABACATEPAY_PRODUCT_TEAM_ID?.trim();
  const apiBaseUrl = environment.ABACATEPAY_API_BASE_URL?.trim() ?? "https://api.abacatepay.com/v2";
  const applicationUrl = environment.NEXT_PUBLIC_APP_URL?.trim();
  const gracePeriodDays = Number.parseInt(environment.BILLING_GRACE_PERIOD_DAYS ?? "3", 10);

  if (
    apiKey === undefined ||
    apiKey.length === 0 ||
    webhookSecret === undefined ||
    webhookSecret.length === 0 ||
    webhookPublicKey === undefined ||
    webhookPublicKey.length === 0 ||
    proProductId === undefined ||
    proProductId.length === 0 ||
    teamProductId === undefined ||
    teamProductId.length === 0 ||
    applicationUrl === undefined ||
    applicationUrl.length === 0 ||
    !Number.isInteger(gracePeriodDays) ||
    gracePeriodDays < 0 ||
    gracePeriodDays > 31 ||
    !isSecureServiceUrl(apiBaseUrl) ||
    !isApplicationUrl(applicationUrl)
  ) {
    return null;
  }

  return {
    apiKey,
    webhookSecret,
    webhookPublicKey,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    productIds: { pro: proProductId, team: teamProductId },
    applicationUrl: applicationUrl.replace(/\/+$/, ""),
    gracePeriodDays
  };
}

export function createAbacatePayGateway(
  configuration: AbacatePayConfiguration,
  fetchImplementation: FetchImplementation = fetch
): AbacatePayGateway {
  return {
    async createSubscriptionCheckout(input) {
      const response = await fetchProvider(
        fetchImplementation,
        configuration,
        "/subscriptions/create",
        {
          method: "POST",
          body: JSON.stringify({
            items: [{ id: configuration.productIds[input.plan], quantity: 1 }],
            externalId: input.externalId,
            methods: ["CARD"],
            returnUrl: `${configuration.applicationUrl}/account?checkout=returned`,
            completionUrl: `${configuration.applicationUrl}/billing/complete`
          })
        }
      );
      const parsed = checkoutResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || !isAbacatePayCheckoutUrl(parsed.data.data.url)) {
        throw new AbacatePayError("provider_response_invalid");
      }
      return { id: parsed.data.data.id, url: parsed.data.data.url };
    },
    async cancelSubscription(providerSubscriptionId) {
      const response = await fetchProvider(
        fetchImplementation,
        configuration,
        "/subscriptions/cancel",
        { method: "POST", body: JSON.stringify({ id: providerSubscriptionId }) }
      );
      const parsed = cancellationResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new AbacatePayError("provider_response_invalid");
      }
    },
    async findCheckoutByExternalId(externalId) {
      const url = new URL(`${configuration.apiBaseUrl}/subscriptions/list`);
      url.searchParams.set("externalId", externalId);
      url.searchParams.set("limit", "1");
      const response = await fetchProvider(
        fetchImplementation,
        configuration,
        url.pathname + url.search,
        {
          method: "GET"
        }
      );
      const parsed = checkoutLookupResponseSchema.safeParse(
        await response.json().catch(() => null)
      );
      if (!parsed.success) {
        throw new AbacatePayError("provider_response_invalid");
      }
      const match = parsed.data.data[0];
      return match === undefined ? null : { id: match.id, status: match.status };
    }
  };
}

export function verifyAbacatePayWebhookSignature(
  rawBody: string,
  signature: string | null,
  publicKey: string
): boolean {
  if (signature === null) {
    return false;
  }
  const expected = createHmac("sha256", publicKey)
    .update(Buffer.from(rawBody, "utf8"))
    .digest("base64");
  return secureEquals(expected, signature);
}

export function secureEquals(expected: string, actual: string | null): boolean {
  if (actual === null) {
    return false;
  }
  const expectedValue = Buffer.from(expected, "utf8");
  const actualValue = Buffer.from(actual, "utf8");
  return expectedValue.length === actualValue.length && timingSafeEqual(expectedValue, actualValue);
}

export function parseVerifiedBillingWebhook(
  rawBody: string,
  gracePeriodDays: number,
  now: Date = new Date()
): VerifiedBillingWebhook | null {
  const parsed = webhookEnvelopeSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    return null;
  }

  const { event, data } = parsed.data;
  const status = resolveSubscriptionStatus(event);
  const trialEnd = data.subscription.trialEndsAt ?? null;
  const graceUntil =
    event === "subscription.payment_failed"
      ? new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const externalCheckoutId = data.checkout?.externalId ?? data.payment?.externalId ?? null;
  const providerCheckoutId = data.checkout?.id ?? null;
  const eventHash = createHash("sha256").update(rawBody, "utf8").digest("hex");

  return {
    eventId: parsed.data.id,
    eventType: event,
    providerSubscriptionId: data.subscription.id,
    providerCustomerId: data.customer?.id ?? null,
    providerCheckoutId,
    externalCheckoutId,
    status,
    currentPeriodStart: null,
    currentPeriodEnd: event === "subscription.trial_started" ? trialEnd : null,
    graceUntil,
    eventHash,
    sanitizedPayload: {
      eventType: event,
      providerEventId: parsed.data.id,
      providerSubscriptionId: data.subscription.id,
      providerCustomerId: data.customer?.id ?? null,
      providerCheckoutId,
      externalCheckoutId,
      providerUpdatedAt: data.subscription.updatedAt ?? null
    }
  };
}

function resolveSubscriptionStatus(event: z.infer<typeof providerEventSchema>): SubscriptionStatus {
  switch (event) {
    case "subscription.trial_started":
      return "trialing";
    case "subscription.completed":
    case "subscription.renewed":
      return "active";
    case "subscription.payment_failed":
      return "past_due";
    case "subscription.cancelled":
      return "cancelled";
    default:
      throw new Error("Unsupported verified subscription event");
  }
}

async function fetchProvider(
  fetchImplementation: FetchImplementation,
  configuration: AbacatePayConfiguration,
  path: string,
  init: RequestInit
): Promise<Response> {
  const response = await fetchImplementation(`${configuration.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${configuration.apiKey}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" })
    },
    cache: "no-store"
  });
  if (!response.ok) {
    throw new AbacatePayError("provider_unavailable");
  }
  return response;
}

function isSecureServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.replace(/\/$/, "") === "/v2";
  } catch {
    return false;
  }
}

function isApplicationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isAbacatePayCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "app.abacatepay.com";
  } catch {
    return false;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
