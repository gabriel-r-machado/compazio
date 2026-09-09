import { describe, expect, it } from "vitest";

import { resolveExecutionLimits } from "./execution-limits";

describe("resolveExecutionLimits", () => {
  it("clamps Alta Performance to the global ceilings (§20.4.3)", () => {
    const limits = resolveExecutionLimits("maximum");
    // The preset's maxParallelism is 8, but the global ceiling is 3.
    expect(limits.maxConcurrentAgents).toBe(3);
    expect(limits.maxSpawnedAgents).toBe(6);
    expect(limits.maxRetriesPerTask).toBeLessThanOrEqual(2);
  });

  it("economy stays lean and sequential", () => {
    const limits = resolveExecutionLimits("economy");
    expect(limits.maxConcurrentAgents).toBe(2);
    expect(limits.maxRetriesPerTask).toBe(1);
  });

  it("balanced is the middle ground within limits", () => {
    const limits = resolveExecutionLimits("balanced");
    expect(limits.maxConcurrentAgents).toBe(3);
    expect(limits.maxRetriesPerTask).toBe(2);
  });

  it("never exceeds the global concurrent/spawned ceilings for any profile", () => {
    for (const profile of ["economy", "balanced", "maximum"] as const) {
      const limits = resolveExecutionLimits(profile);
      expect(limits.maxConcurrentAgents).toBeLessThanOrEqual(3);
      expect(limits.maxSpawnedAgents).toBeLessThanOrEqual(6);
    }
  });
});
