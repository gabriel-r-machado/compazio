import { describe, expect, it, vi } from "vitest";

import { MessageQueue } from "./message-queue";
import { LineRingBuffer, OutputBatcher } from "./output";
import { createAllowedEnvironment } from "./security";
import { InMemoryRuntimeSessionStore } from "./session-store";

describe("terminal buffering", () => {
  it("keeps only the configured number of recent lines", () => {
    const buffer = new LineRingBuffer(3);
    buffer.append("one\ntwo\nthree\nfour\n");
    expect(buffer.snapshot()).toBe("two\nthree\nfour\n");
    expect(buffer.lineCount).toBe(3);
  });

  it("preserves terminal cursor controls and carriage returns in history", () => {
    const buffer = new LineRingBuffer(3);
    const terminalData = "\u001b[?25l\u001b[93mc\bco\u001b[6;58Hcod\r\n";

    buffer.append(terminalData);

    expect(buffer.snapshot()).toBe(terminalData);
  });

  it("clears buffered output without changing future writes", () => {
    const buffer = new LineRingBuffer(10);
    buffer.append("before\r\n");
    buffer.clear();
    buffer.append("after");

    expect(buffer.snapshot()).toBe("after");
    expect(buffer.lineCount).toBe(1);
  });

  it("ingests 10 MB in thousands of chunks without rescanning the retained history", () => {
    const buffer = new LineRingBuffer(10_000);
    const chunk = "x".repeat(1_024);
    const startedAt = performance.now();

    for (let index = 0; index < 10_240; index += 1) buffer.append(chunk);

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(10 * 1_024 * 1_024);
    expect(snapshot.startsWith(chunk)).toBe(true);
    expect(snapshot.endsWith(chunk)).toBe(true);
    expect(buffer.lineCount).toBe(1);
    // The former implementation rescanned the complete accumulated string on every append and
    // took longer than a minute on the acceptance machine. Keep this deliberately loose so the
    // assertion catches quadratic behaviour without turning ordinary CI variance into a failure.
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it("batches output by time and maximum size", () => {
    vi.useFakeTimers();
    const batches: string[] = [];
    const batcher = new OutputBatcher((data) => batches.push(data), 16, 4);
    batcher.push("abcdef");
    expect(batches).toEqual(["abcd"]);
    vi.advanceTimersByTime(16);
    expect(batches).toEqual(["abcd", "ef"]);
    vi.useRealTimers();
  });

  it("preserves order across 10 MB of mixed ANSI output and thousands of chunks", () => {
    vi.useFakeTimers();
    const batches: string[] = [];
    const batcher = new OutputBatcher((data) => batches.push(data), 16, 64 * 1_024);
    const chunk = `\u001b[38;2;20;160;240m${"界🚀".repeat(250)}\u001b[0m\r`;
    const chunks = Array.from(
      { length: Math.ceil((10 * 1_024 * 1_024) / chunk.length) },
      () => chunk
    );

    for (const value of chunks) batcher.push(value);
    vi.advanceTimersByTime(16);

    expect(batches.join("")).toBe(chunks.join(""));
    expect(batches.every((batch) => batch.length <= 64 * 1_024)).toBe(true);
    vi.useRealTimers();
  });
});

describe("message queue", () => {
  it("delivers queued messages in order", async () => {
    const queue = new MessageQueue(3, 20);
    const written: string[] = [];
    const first = queue.enqueue("one");
    const second = queue.enqueue("two");
    queue.attach((data) => written.push(data));
    await Promise.all([first, second]);
    expect(written).toEqual(["one", "two"]);
  });

  it("rejects messages beyond its byte limit", async () => {
    const queue = new MessageQueue(1, 3);
    await expect(queue.enqueue("four")).rejects.toThrow("limit exceeded");
  });
});

describe("runtime safety", () => {
  it("allows operational environment keys and drops secrets", () => {
    const result = createAllowedEnvironment({
      PATH: "safe-path",
      API_KEY: "FORGEDECK_TEST_SECRET_runtime-diagnostic",
      CLAUDE_CODE_OAUTH_TOKEN: "secret"
    });
    expect(result).toEqual({ PATH: "safe-path" });
  });

  it("recovers active sessions as interrupted", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const now = new Date();
    await store.save({
      id: "session-1",
      adapterId: "fake-agent",
      state: "running",
      cwd: process.cwd(),
      processId: 123,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      interruptionReason: null
    });
    expect(await store.markActiveSessionsInterrupted(new Date(), "application_restart")).toBe(1);
    expect(store.records.get("session-1")?.state).toBe("interrupted");
  });
});
