import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalError, PortalOperationRegistry } from "./portal-operations";

afterEach(() => {
  vi.useRealTimers();
});

function registry(events?: { type: string; metadata: Record<string, unknown> }[]) {
  return new PortalOperationRegistry({
    onEvent: (type, metadata) => events?.push({ type, metadata: { ...metadata } })
  });
}

describe("portal operation registry", () => {
  it("returns the result and leaves nothing pending", async () => {
    const events: { type: string; metadata: Record<string, unknown> }[] = [];
    const operations = registry(events);
    const value = await operations.run(
      { workspaceId: "w1", portalId: "p1", action: "click", terminalNodeId: "t1" },
      async () => ({ ok: true })
    );
    expect(value).toEqual({ ok: true });
    expect(operations.pendingCount()).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "portal.operation.started",
      "portal.operation.completed"
    ]);
    expect(events[0]?.metadata.correlationId).toEqual(expect.any(String));
  });

  it("clears the timer when the operation settles", async () => {
    vi.useFakeTimers();
    const operations = registry();
    await operations.run({ workspaceId: "w1", portalId: "p1", action: "dom" }, async () => 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with PORTAL_TIMEOUT and aborts the signal", async () => {
    vi.useFakeTimers();
    const events: { type: string; metadata: Record<string, unknown> }[] = [];
    const operations = registry(events);
    let observed: AbortSignal | undefined;
    const pending = operations.run(
      { workspaceId: "w1", portalId: "p1", action: "navigate", timeoutMs: 1_000 },
      async (context) => {
        observed = context.signal;
        return new Promise<never>(() => undefined);
      }
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "PORTAL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toBeInstanceOf(PortalError);
    expect(operations.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.some((event) => event.type === "portal.operation.timeout")).toBe(true);
  });

  it("cancels a running operation and repeats the cancellation without a second failure", async () => {
    const operations = registry();
    const pending = operations.run(
      { workspaceId: "w1", portalId: "p1", action: "type" },
      async () => new Promise<never>(() => undefined)
    );
    const [running] = operations.pending();
    if (running === undefined) throw new Error("operation fixture missing");
    expect(operations.cancel(running.correlationId)).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "PORTAL_OPERATION_CANCELLED" });
    expect(operations.cancel(running.correlationId)).toBe(false);
    expect(operations.cancel("desconhecida")).toBe(false);
    expect(operations.pendingCount()).toBe(0);
  });

  it("maps each cancellation cause to its own error code", async () => {
    const operations = registry();
    const cases = [
      { reason: "connection-revoked", code: "PORTAL_NOT_CONNECTED" },
      { reason: "portal-deleted", code: "PORTAL_DESTROYED" },
      { reason: "portal-crashed", code: "PORTAL_CRASHED" },
      { reason: "workspace-switched", code: "PORTAL_OPERATION_CANCELLED" },
      { reason: "workspace-closed", code: "PORTAL_OPERATION_CANCELLED" },
      { reason: "application-closing", code: "PORTAL_OPERATION_CANCELLED" },
      { reason: "terminal-deleted", code: "PORTAL_OPERATION_CANCELLED" },
      { reason: "runtime-recreated", code: "PORTAL_DESTROYED" }
    ] as const;
    for (const item of cases) {
      const pending = operations.run(
        { workspaceId: "w1", portalId: "p1", action: "scroll" },
        async () => new Promise<never>(() => undefined)
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: item.code,
        details: { reason: item.reason }
      });
      expect(operations.cancelPortal("w1", "p1", item.reason)).toBe(1);
      await rejection;
    }
    expect(operations.pendingCount()).toBe(0);
  });

  it("cancels by portal, terminal, grant, workspace and application scope", async () => {
    const operations = registry();
    const start = (workspaceId: string, portalId: string, terminalNodeId: string) => {
      const pending = operations.run(
        { workspaceId, portalId, terminalNodeId, action: "press" },
        async () => new Promise<never>(() => undefined)
      );
      pending.catch(() => undefined);
      return pending;
    };
    const first = start("w1", "p1", "t1");
    const second = start("w1", "p2", "t1");
    const third = start("w2", "p3", "t2");
    expect(operations.pendingCount()).toBe(3);
    expect(operations.cancelGrant("w1", "t1", "p1", "connection-revoked")).toBe(1);
    await expect(first).rejects.toMatchObject({ code: "PORTAL_NOT_CONNECTED" });
    expect(operations.cancelTerminal("w1", "t1", "terminal-deleted")).toBe(1);
    await expect(second).rejects.toMatchObject({ code: "PORTAL_OPERATION_CANCELLED" });
    expect(operations.cancelWorkspace("w9", "workspace-closed")).toBe(0);
    expect(operations.cancelAll("application-closing")).toBe(1);
    await expect(third).rejects.toMatchObject({ code: "PORTAL_OPERATION_CANCELLED" });
    expect(operations.pendingCount()).toBe(0);
  });

  it("keeps the requested timeout inside a safe range", () => {
    const operations = new PortalOperationRegistry();
    expect(operations.resolveTimeout(undefined)).toBe(PortalOperationRegistry.defaultTimeoutMs);
    expect(operations.resolveTimeout(Number.NaN)).toBe(PortalOperationRegistry.defaultTimeoutMs);
    expect(operations.resolveTimeout(5)).toBe(PortalOperationRegistry.minimumTimeoutMs);
    expect(operations.resolveTimeout(10_000_000)).toBe(PortalOperationRegistry.maximumTimeoutMs);
    expect(operations.resolveTimeout(4_000)).toBe(4_000);
  });

  it("reports the remaining budget so page work inherits the deadline", async () => {
    const operations = registry();
    const remaining = await operations.run(
      { workspaceId: "w1", portalId: "p1", action: "dom", timeoutMs: 2_000 },
      async (context) => context.remainingMs()
    );
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(2_000);
  });

  it("wraps an unexpected failure as a structured portal error", async () => {
    const operations = registry();
    await expect(
      operations.run({ workspaceId: "w1", portalId: "p1", action: "click" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toMatchObject({ code: "PORTAL_OPERATION_FAILED", message: "boom" });
    await expect(
      operations.run({ workspaceId: "w1", portalId: "p1", action: "click" }, async () => {
        throw new PortalError("PORTAL_ELEMENT_NOT_FOUND", "sem elemento");
      })
    ).rejects.toMatchObject({ code: "PORTAL_ELEMENT_NOT_FOUND" });
    expect(operations.pendingCount()).toBe(0);
  });

  it("serializes a portal error as data instead of a stack", () => {
    const error = new PortalError("PORTAL_DOM_LIMIT_EXCEEDED", "limite", { nodes: 5_000 });
    expect(error.toResult()).toEqual({
      ok: false,
      code: "PORTAL_DOM_LIMIT_EXCEEDED",
      message: "limite",
      details: { nodes: 5_000 }
    });
    expect(JSON.parse(JSON.stringify(error.toResult()))).toMatchObject({ ok: false });
  });
});
