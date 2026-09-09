import { describe, expect, it, vi } from "vitest";

import { terminalInputBus } from "./terminal-input-bus";

describe("terminalInputBus", () => {
  it("routes and awaits a complete composer submission only on its registered xterm", async () => {
    let release!: () => void;
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = vi.fn(() => written);
    const unregister = terminalInputBus.register("terminal-composer", submit);

    const routed = terminalInputBus.submit("terminal-composer", "linha 1\nlinha 2 ok");
    expect(submit).toHaveBeenCalledWith("linha 1\nlinha 2 ok");
    let settled = false;
    void routed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(routed).resolves.toBe(true);

    unregister();
    await expect(terminalInputBus.submit("terminal-composer", "ignored")).resolves.toBe(false);
  });
});
