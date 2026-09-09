import { describe, expect, it } from "vitest";

import { handleSystemPing } from "./system-ipc";

describe("system ping handler", () => {
  it("validates the request and returns the matching request id", () => {
    const requestId = "ac51b02e-f0a2-4495-a72d-ab098f3db34d";
    const response = handleSystemPing({ requestId });

    expect(response.requestId).toBe(requestId);
    expect(response.ok).toBe(true);
    expect(Number.isNaN(Date.parse(response.mainProcessTime))).toBe(false);
  });

  it("does not accept arbitrary payloads", () => {
    expect(() => handleSystemPing({ requestId: "invalid", command: "rm -rf" })).toThrow();
  });
});
