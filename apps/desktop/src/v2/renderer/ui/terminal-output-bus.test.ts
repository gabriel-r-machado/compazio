import { describe, expect, it, vi } from "vitest";

import { terminalOutputBus } from "./terminal-output-bus";

describe("terminal output bus", () => {
  it("delivers output without requiring React state and releases listeners", () => {
    terminalOutputBus.clear();
    const listener = vi.fn();
    const unsubscribe = terminalOutputBus.subscribe("session_1", listener);
    terminalOutputBus.publish("session_1", "hello");
    unsubscribe();
    terminalOutputBus.publish("session_1", " world");

    expect(listener).toHaveBeenCalledOnce();
    expect(terminalOutputBus.snapshot("session_1")).toBe("hello world");
    expect(terminalOutputBus.diagnostics().listenerCount).toBe(0);
  });

  it("bounds retained terminal output independently from operational history", () => {
    terminalOutputBus.clear();
    terminalOutputBus.publish("session_1", "x".repeat(250_000));
    expect(terminalOutputBus.snapshot("session_1")).toHaveLength(200_000);
  });

  it("streams 10 MB in thousands of ordered chunks without React state or byte loss", () => {
    terminalOutputBus.clear();
    let expectedIndex = 0;
    let receivedBytes = 0;
    const unsubscribe = terminalOutputBus.subscribe("stress_session", (data) => {
      expect(data.startsWith(`${expectedIndex.toString().padStart(5, "0")}|`)).toBe(true);
      expectedIndex += 1;
      receivedBytes += Buffer.byteLength(data, "utf8");
    });
    const startedAt = performance.now();

    for (let index = 0; index < 10_240; index += 1) {
      const prefix = `${index.toString().padStart(5, "0")}|`;
      terminalOutputBus.publish("stress_session", `${prefix}${"x".repeat(1_024 - prefix.length)}`);
    }
    unsubscribe();

    expect(expectedIndex).toBe(10_240);
    expect(receivedBytes).toBe(10 * 1_024 * 1_024);
    expect(terminalOutputBus.snapshot("stress_session")).toHaveLength(200_000);
    expect(terminalOutputBus.snapshot("stress_session")).toContain("10239|");
    expect(terminalOutputBus.diagnostics().listenerCount).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });
});
