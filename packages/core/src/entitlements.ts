export type SubscriptionStatus =
  "inactive" | "trialing" | "active" | "past_due" | "cancelled" | "expired";

export type PlanKey = "community" | "pro" | "team";

export interface CapabilityEntitlements {
  readonly cloudSync: boolean;
  readonly mobileMonitor: boolean;
  readonly privateTemplates: boolean;
  readonly teamMembers: number;
  readonly cloudHistoryDays: number;
  readonly source: "community" | "subscription" | "grace";
}

export interface SubscriptionEntitlementInput {
  readonly planKey: PlanKey;
  readonly status: SubscriptionStatus;
  readonly graceUntil: Date | null;
  readonly now: Date;
}

const communityEntitlements: CapabilityEntitlements = {
  cloudSync: false,
  mobileMonitor: false,
  privateTemplates: false,
  teamMembers: 1,
  cloudHistoryDays: 0,
  source: "community"
};

const proEntitlements: Omit<CapabilityEntitlements, "source"> = {
  cloudSync: true,
  mobileMonitor: true,
  privateTemplates: true,
  teamMembers: 1,
  cloudHistoryDays: 90
};

const teamEntitlements: Omit<CapabilityEntitlements, "source"> = {
  cloudSync: true,
  mobileMonitor: true,
  privateTemplates: true,
  teamMembers: 10,
  cloudHistoryDays: 365
};

export function resolveEntitlements(input: SubscriptionEntitlementInput): CapabilityEntitlements {
  const inGrace =
    input.status === "past_due" && input.graceUntil !== null && input.graceUntil > input.now;
  const active = input.status === "active" || input.status === "trialing" || inGrace;

  if (!active || input.planKey === "community") {
    return communityEntitlements;
  }

  return {
    ...(input.planKey === "team" ? teamEntitlements : proEntitlements),
    source: inGrace ? "grace" : "subscription"
  };
}

export function communityFallbackEntitlements(): CapabilityEntitlements {
  return communityEntitlements;
}
