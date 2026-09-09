import { describe, expect, it } from "vitest";

import { systemPingRequestSchema, systemPingResponseSchema } from "./system";

const requestId = "7f5ec3e6-f54d-4e4f-a7ea-a1fcc8cb9687";

describe("system ping IPC schemas", () => {
  it("accepts a valid request and response", () => {
    expect(systemPingRequestSchema.parse({ requestId })).toEqual({ requestId });
    expect(
      systemPingResponseSchema.parse({
        requestId,
        ok: true,
        mainProcessTime: "2026-07-15T23:00:00.000Z"
      })
    ).toEqual({
      requestId,
      ok: true,
      mainProcessTime: "2026-07-15T23:00:00.000Z"
    });
  });

  it("rejects invalid identifiers and additional properties", () => {
    expect(systemPingRequestSchema.safeParse({ requestId: "not-a-uuid" }).success).toBe(false);
    expect(systemPingRequestSchema.safeParse({ requestId, channel: "arbitrary" }).success).toBe(
      false
    );
  });

  it("rejects malformed responses", () => {
    expect(
      systemPingResponseSchema.safeParse({
        requestId,
        ok: false,
        mainProcessTime: "today"
      }).success
    ).toBe(false);
  });
});
