import { describe, expect, it } from "vitest";

import { readFeatureFlags } from "./feature-flags";

describe("feature flags", () => {
  it("keeps remote features disabled while enabling visible terminal coordination", () => {
    expect(readFeatureFlags({})).toEqual({
      cloud: false,
      billing: false,
      remoteControl: false,
      telemetry: false,
      orchestratorMode: true
    });
  });

  it("keeps an explicit rollback kill switch for terminal coordination", () => {
    expect(readFeatureFlags({ COMPAZIO_ORCHESTRATOR_MODE: "false" }).orchestratorMode).toBe(false);
  });

  it("rejects ambiguous truthy values", () => {
    expect(() => readFeatureFlags({ NEXT_PUBLIC_CLOUD_ENABLED: "1" })).toThrow();
  });
});
