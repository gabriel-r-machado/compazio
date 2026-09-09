import { describe, expect, it } from "vitest";

import { communityFallbackEntitlements, resolveEntitlements } from "./entitlements";

describe("resolveEntitlements", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("enables capabilities only for an active subscription", () => {
    expect(
      resolveEntitlements({ planKey: "pro", status: "active", graceUntil: null, now })
    ).toEqual({
      cloudSync: true,
      mobileMonitor: true,
      privateTemplates: true,
      teamMembers: 1,
      cloudHistoryDays: 90,
      source: "subscription"
    });
  });

  it("keeps cloud capabilities through the bounded grace period", () => {
    const entitlements = resolveEntitlements({
      planKey: "team",
      status: "past_due",
      graceUntil: new Date("2026-07-16T12:00:00.000Z"),
      now
    });

    expect(entitlements.source).toBe("grace");
    expect(entitlements.teamMembers).toBe(10);
  });

  it("never blocks the community local core after payment failure or cancellation", () => {
    expect(
      resolveEntitlements({
        planKey: "pro",
        status: "cancelled",
        graceUntil: null,
        now
      })
    ).toEqual(communityFallbackEntitlements());
  });
});
