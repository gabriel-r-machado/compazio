import { describe, expect, it } from "vitest";

import {
  billingCheckoutRequestSchema,
  cloudSyncBatchSchema,
  cloudSyncEventSchema,
  sanitizeCloudSummary
} from "./cloud";

const reference = "a".repeat(64);
const otherReference = "b".repeat(64);

describe("cloud sync contracts", () => {
  it("accepts an allowlisted high-level run summary", () => {
    const parsed = cloudSyncBatchSchema.parse({
      organizationId: "991e6d84-1322-482f-9c0d-cd0c31b5fc60",
      deviceId: "5269bc9b-c89c-4e3b-9238-f13e2f1d4a20",
      events: [
        {
          eventKey: reference,
          type: "run.completed",
          occurredAt: "2026-07-15T15:00:00.000Z",
          project: { localRef: otherReference, displayName: "ForgeDeck" },
          run: {
            localRef: reference,
            workflowId: "bug-fix",
            adapterId: "shell",
            status: "completed",
            startedAt: "2026-07-15T14:59:00.000Z",
            completedAt: "2026-07-15T15:00:00.000Z",
            durationMs: 60000,
            summary: "Quality gate passed."
          },
          payload: { nodeRef: null, nodeStatus: null, retryCount: 0 }
        }
      ]
    });

    expect(parsed.events).toHaveLength(1);
  });

  it("rejects paths, code, diffs, terminal output, prompts and environment data", () => {
    const validEvent = {
      eventKey: reference,
      type: "run.started" as const,
      occurredAt: "2026-07-15T15:00:00.000Z",
      project: { localRef: otherReference, displayName: "ForgeDeck" },
      run: {
        localRef: reference,
        workflowId: "bug-fix",
        adapterId: "shell",
        status: "running" as const,
        startedAt: "2026-07-15T15:00:00.000Z",
        completedAt: null,
        durationMs: null,
        summary: null
      },
      payload: { nodeRef: null, nodeStatus: null, retryCount: null }
    };

    for (const forbiddenKey of ["path", "code", "diff", "terminalOutput", "prompt", "env"]) {
      expect(() =>
        cloudSyncEventSchema.parse({ ...validEvent, [forbiddenKey]: "forbidden" })
      ).toThrow();
    }

    expect(() =>
      cloudSyncEventSchema.parse({
        ...validEvent,
        project: { ...validEvent.project, displayName: "C:\\Users\\person\\project" }
      })
    ).toThrow();
    expect(() =>
      cloudSyncEventSchema.parse({
        ...validEvent,
        run: { ...validEvent.run, summary: "diff --git a/file.ts b/file.ts" }
      })
    ).toThrow();
  });

  it("redacts marked secrets before a summary can cross the cloud boundary", () => {
    const summary = sanitizeCloudSummary(
      "\u001b[31mFORGEDECK_SECRET_DEPLOY=top-secret Bearer abcdefghijklmnopqrstuvwxyz"
    );

    expect(summary).not.toContain("top-secret");
    expect(summary).not.toContain("abcdefghijklmnopqrst");
    expect(summary).toContain("[REDACTED]");
  });

  it("does not accept browser-controlled checkout values", () => {
    expect(
      billingCheckoutRequestSchema.safeParse({
        organizationId: "9fa0ad3b-1adb-4433-8b44-587a80f2296f",
        plan: "pro"
      }).success
    ).toBe(true);
    expect(
      billingCheckoutRequestSchema.safeParse({
        organizationId: "9fa0ad3b-1adb-4433-8b44-587a80f2296f",
        plan: "pro",
        amount: 1
      }).success
    ).toBe(false);
  });
});
