import { describe, expect, it } from "vitest";

import { readRuntimeLimits } from "./runtime-limits";

describe("readRuntimeLimits", () => {
  it("uses bounded host-only values and falls back on invalid settings", () => {
    expect(
      readRuntimeLimits({
        FORGEDECK_MAX_TERMINALS_PER_PROJECT: "3",
        FORGEDECK_MAX_CONCURRENT_DELIVERIES_PER_PROJECT: "2",
        FORGEDECK_MAX_QUEUED_MESSAGES: "25",
        FORGEDECK_MAX_QUEUED_BYTES: "8192",
        FORGEDECK_MAX_BUFFER_LINES: "400",
        FORGEDECK_RUNTIME_LEASE_TTL_MS: "45000"
      })
    ).toEqual({
      maxActiveSessionsPerProject: 3,
      maxConcurrentDeliveriesPerProject: 2,
      maxQueuedMessagesPerSession: 25,
      maxQueuedBytesPerSession: 8192,
      maxBufferLinesPerSession: 400,
      // Absent means the memory limit is off: killing a person's process is not something to start
      // doing unasked.
      maxProcessMemoryBytesPerSession: 0,
      projectLeaseStaleAfterMs: 45_000
    });
    expect(readRuntimeLimits({ FORGEDECK_MAX_TERMINALS_PER_PROJECT: "0" })).toMatchObject({
      maxActiveSessionsPerProject: 8
    });
  });

  it("reads the per-process memory limit in megabytes, and disables it when unusable", () => {
    expect(
      readRuntimeLimits({ FORGEDECK_MAX_PROCESS_MEMORY_MB: "1024" }).maxProcessMemoryBytesPerSession
    ).toBe(1024 * 1024 * 1024);
    // A limit below the floor would kill healthy agents, so it disables the check instead.
    expect(
      readRuntimeLimits({ FORGEDECK_MAX_PROCESS_MEMORY_MB: "8" }).maxProcessMemoryBytesPerSession
    ).toBe(0);
    expect(
      readRuntimeLimits({ FORGEDECK_MAX_PROCESS_MEMORY_MB: "nonsense" })
        .maxProcessMemoryBytesPerSession
    ).toBe(0);
  });
});
