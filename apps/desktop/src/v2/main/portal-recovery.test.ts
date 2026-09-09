import { describe, expect, it } from "vitest";

import { PortalRecoveryPolicy, describePortalFailure } from "./portal-recovery";

describe("portal recovery policy", () => {
  it("allows recovery until the attempt budget runs out", () => {
    let clock = 0;
    const policy = new PortalRecoveryPolicy({ maxAttempts: 3, cooldownMs: 0, now: () => clock });
    for (const attempt of [1, 2, 3]) {
      policy.recordFailure("w1:p1", "render-process-gone");
      const evaluation = policy.evaluate("w1:p1");
      expect(evaluation).toMatchObject({ allowed: true, attempt, maxAttempts: 3 });
      policy.recordAttempt("w1:p1");
      clock += 10;
    }
    expect(policy.evaluate("w1:p1")).toMatchObject({
      allowed: false,
      reason: "attempts-exhausted"
    });
    expect(policy.state("w1:p1")).toMatchObject({ attempts: 3, exhausted: true });
  });

  it("does not recreate in a tight loop", () => {
    let clock = 1_000;
    const policy = new PortalRecoveryPolicy({ cooldownMs: 500, now: () => clock });
    policy.recordAttempt("w1:p1");
    expect(policy.evaluate("w1:p1")).toMatchObject({ allowed: false, reason: "cooling-down" });
    expect(policy.evaluate("w1:p1").retryInMs).toBe(500);
    clock += 600;
    expect(policy.evaluate("w1:p1").allowed).toBe(true);
  });

  it("forgives attempts only after the window has passed", () => {
    let clock = 0;
    const policy = new PortalRecoveryPolicy({
      maxAttempts: 2,
      cooldownMs: 0,
      windowMs: 10_000,
      now: () => clock
    });
    policy.recordAttempt("w1:p1");
    policy.recordAttempt("w1:p1");
    expect(policy.evaluate("w1:p1").allowed).toBe(false);
    clock += 11_000;
    expect(policy.evaluate("w1:p1").allowed).toBe(true);
  });

  it("does not refund the budget when a recovered page loads and crashes again", () => {
    let clock = 0;
    const policy = new PortalRecoveryPolicy({
      maxAttempts: 2,
      cooldownMs: 0,
      windowMs: 60_000,
      now: () => clock
    });
    for (let cycle = 0; cycle < 2; cycle += 1) {
      policy.recordFailure("w1:p1", "render-process-gone");
      expect(policy.evaluate("w1:p1").allowed).toBe(true);
      policy.recordAttempt("w1:p1");
      // The page loads, then dies again: a crash loop must not look like two isolated incidents.
      policy.recordSuccess("w1:p1");
      clock += 200;
    }
    policy.recordFailure("w1:p1", "render-process-gone");
    expect(policy.evaluate("w1:p1")).toMatchObject({
      allowed: false,
      reason: "attempts-exhausted"
    });
    expect(policy.state("w1:p1")).toMatchObject({ attempts: 2, exhausted: true });
  });

  it("reports a healthy Portal after a successful load", () => {
    const policy = new PortalRecoveryPolicy({ cooldownMs: 0 });
    policy.recordFailure("w1:p1", "render-process-gone");
    policy.recordAttempt("w1:p1");
    expect(policy.recordSuccess("w1:p1")).toMatchObject({ lastFailure: null, lastAttemptAt: null });
  });

  it("lets a manual recreation clear an exhausted budget", () => {
    const policy = new PortalRecoveryPolicy({ maxAttempts: 1, cooldownMs: 0 });
    policy.recordAttempt("w1:p1");
    expect(policy.evaluate("w1:p1").allowed).toBe(false);
    policy.reset("w1:p1");
    expect(policy.evaluate("w1:p1").allowed).toBe(true);
  });

  it("tracks each Portal separately and forgets a deleted one", () => {
    const policy = new PortalRecoveryPolicy({ maxAttempts: 1, cooldownMs: 0 });
    policy.recordAttempt("w1:p1");
    expect(policy.evaluate("w1:p1").allowed).toBe(false);
    expect(policy.evaluate("w1:p2").allowed).toBe(true);
    policy.forget("w1:p1");
    expect(policy.evaluate("w1:p1").allowed).toBe(true);
  });

  it("remembers the last failure kind for the diagnostic", () => {
    const policy = new PortalRecoveryPolicy();
    policy.recordFailure("w1:p1", "unresponsive");
    expect(policy.state("w1:p1").lastFailure).toBe("unresponsive");
  });

  it("describes each failure in language the canvas can show", () => {
    expect(describePortalFailure("render-process-gone").reason).toContain("processo");
    expect(describePortalFailure("unresponsive").reason).toContain("responder");
    expect(
      describePortalFailure("did-fail-load", { description: "ERR_CONNECTION_REFUSED" }).reason
    ).toContain("ERR_CONNECTION_REFUSED");
    expect(describePortalFailure("did-fail-load").reason).not.toContain("(");
    expect(describePortalFailure("destroyed").title).toBe("Portal falhou");
  });
});
