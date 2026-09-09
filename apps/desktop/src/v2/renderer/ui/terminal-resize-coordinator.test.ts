import { describe, expect, it, vi } from "vitest";

import { createTerminalResizeCoordinator } from "./terminal-resize-coordinator";

describe("createTerminalResizeCoordinator", () => {
  it("commits only the stable grid and resizes the PTY before the renderer", async () => {
    vi.useFakeTimers();
    let measured = { cols: 80, rows: 24 };
    const events: string[] = [];
    const coordinator = createTerminalResizeCoordinator({
      measure: () => measured,
      resizePty: async (size) => {
        events.push(`pty:${size.cols}x${size.rows}`);
      },
      resizeRenderer: (size) => events.push(`renderer:${size.cols}x${size.rows}`),
      onTransitionStart: () => events.push("start"),
      onTransitionEnd: () => events.push("end"),
      onError: vi.fn()
    });

    coordinator.request();
    measured = { cols: 100, rows: 30 };
    coordinator.request();
    measured = { cols: 120, rows: 40 };
    coordinator.request();
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(80);
    expect(events).toEqual(["start", "pty:120x40", "renderer:120x40", "end"]);
    coordinator.dispose();
    vi.useRealTimers();
  });

  it("buffers a newer measurement while a resize is in flight", async () => {
    vi.useFakeTimers();
    let measured = { cols: 80, rows: 24 };
    let releasePty: (() => void) | undefined;
    const events: string[] = [];
    const coordinator = createTerminalResizeCoordinator({
      measure: () => measured,
      resizePty: (size) =>
        new Promise<void>((resolve) => {
          events.push(`pty:${size.cols}x${size.rows}`);
          releasePty = resolve;
        }),
      resizeRenderer: (size) => events.push(`renderer:${size.cols}x${size.rows}`),
      onError: vi.fn()
    });

    coordinator.request();
    await vi.advanceTimersByTimeAsync(80);
    measured = { cols: 132, rows: 46 };
    coordinator.request();
    await vi.advanceTimersByTimeAsync(80);
    expect(events).toEqual(["pty:80x24"]);

    releasePty?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["pty:80x24", "renderer:80x24", "pty:132x46"]);
    coordinator.dispose();
    vi.useRealTimers();
  });

  it("ignores zero and invalid geometry", async () => {
    vi.useFakeTimers();
    const resizePty = vi.fn(async () => undefined);
    const coordinator = createTerminalResizeCoordinator({
      measure: () => ({ cols: 0, rows: 0 }),
      resizePty,
      resizeRenderer: vi.fn(),
      onError: vi.fn()
    });
    coordinator.request();
    await vi.runAllTimersAsync();
    expect(resizePty).not.toHaveBeenCalled();
    coordinator.dispose();
    vi.useRealTimers();
  });

  it("coalesces a storm of 100 measurements into the final PTY and renderer grid", async () => {
    vi.useFakeTimers();
    let measured = { cols: 80, rows: 24 };
    const ptySizes: { cols: number; rows: number }[] = [];
    const rendererSizes: { cols: number; rows: number }[] = [];
    const coordinator = createTerminalResizeCoordinator({
      measure: () => measured,
      resizePty: async (size) => void ptySizes.push(size),
      resizeRenderer: (size) => void rendererSizes.push(size),
      onError: vi.fn()
    });

    for (let index = 0; index < 100; index += 1) {
      measured = { cols: 80 + index, rows: 24 + (index % 40) };
      coordinator.request();
    }
    await vi.runAllTimersAsync();

    expect(ptySizes).toEqual([{ cols: 179, rows: 43 }]);
    expect(rendererSizes).toEqual(ptySizes);
    coordinator.dispose();
    vi.useRealTimers();
  });
});
