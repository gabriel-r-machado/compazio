import { describe, expect, it, vi } from "vitest";

import { MemoryLimitMonitor } from "./memory-limit-monitor";
import type { MemoryLimitBreach } from "./memory-limit-monitor";
import { descendantsOf, parsePosixProcessTable, parseWindowsProcessCsv } from "./process-memory";
import type { ProcessMemoryUsage } from "./process-memory";

const MB = 1024 * 1024;

function usage(processId: number, parentProcessId: number, megabytes: number): ProcessMemoryUsage {
  return { processId, parentProcessId, residentBytes: megabytes * MB };
}

function harness(
  processes: readonly ProcessMemoryUsage[],
  limitMegabytes = 500,
  killer = { kill: vi.fn(async () => undefined) }
) {
  const breaches: MemoryLimitBreach[] = [];
  const monitor = new MemoryLimitMonitor({
    sessions: () => [{ sessionId: "session-1", processId: 100 }],
    reader: { read: async () => processes },
    killer,
    onBreach: (breach) => breaches.push(breach),
    limitBytes: limitMegabytes * MB
  });
  return { monitor, breaches, killer };
}

describe("MemoryLimitMonitor", () => {
  it("kills the runaway process and leaves the terminal running", async () => {
    const { monitor, breaches, killer } = harness([
      usage(100, 1, 40), // the shell itself
      usage(200, 100, 900), // a leaking agent under it
      usage(300, 100, 120) // a well-behaved sibling
    ]);

    expect(await monitor.sweep()).toBe(1);

    expect(killer.kill).toHaveBeenCalledTimes(1);
    expect(killer.kill).toHaveBeenCalledWith(200);
    expect(breaches).toEqual([
      { sessionId: "session-1", processId: 200, residentBytes: 900 * MB, limitBytes: 500 * MB }
    ]);
  });

  it("never kills the session's own process, however large it grows", async () => {
    // Killing the shell would take the terminal with it — the exact outcome the limit prevents.
    const { monitor, killer, breaches } = harness([usage(100, 1, 4_000)]);

    expect(await monitor.sweep()).toBe(0);
    expect(killer.kill).not.toHaveBeenCalled();
    expect(breaches).toEqual([]);
  });

  it("reaches a process nested deeper than a direct child", async () => {
    const { monitor, killer } = harness([
      usage(100, 1, 40),
      usage(200, 100, 60),
      usage(300, 200, 900)
    ]);

    await monitor.sweep();

    expect(killer.kill).toHaveBeenCalledWith(300);
  });

  it("leaves everything alone when a reading fails", async () => {
    const killer = { kill: vi.fn(async () => undefined) };
    const monitor = new MemoryLimitMonitor({
      sessions: () => [{ sessionId: "session-1", processId: 100 }],
      reader: {
        read: async () => {
          throw new Error("ps is unavailable");
        }
      },
      killer,
      onBreach: () => undefined,
      limitBytes: 100 * MB
    });

    expect(await monitor.sweep()).toBe(0);
    expect(killer.kill).not.toHaveBeenCalled();
  });

  it("does not announce a kill that did not happen", async () => {
    const { monitor, breaches } = harness([usage(100, 1, 40), usage(200, 100, 900)], 500, {
      kill: vi.fn(async () => {
        throw new Error("process is already gone");
      })
    });

    expect(await monitor.sweep()).toBe(0);
    expect(breaches).toEqual([]);
  });

  it("refuses a limit that would kill everything", () => {
    expect(
      () =>
        new MemoryLimitMonitor({
          sessions: () => [],
          reader: { read: async () => [] },
          killer: { kill: async () => undefined },
          onBreach: () => undefined,
          limitBytes: 0
        })
    ).toThrow("positive number of bytes");
  });
});

describe("descendantsOf", () => {
  it("terminates when recycled pids make the parent links look circular", () => {
    const descendants = descendantsOf(
      [usage(200, 100, 10), usage(100, 200, 10), usage(300, 200, 10)],
      100
    );

    expect(descendants.map((entry) => entry.processId)).toEqual([200, 300]);
  });
});

describe("process listing parsers", () => {
  it("reads Windows CSV, where the working set is already in bytes", () => {
    const rows = parseWindowsProcessCsv(
      ['"ProcessId","ParentProcessId","WorkingSetSize"', '"4242","100","943718400"', ""].join(
        "\r\n"
      )
    );

    expect(rows).toEqual([{ processId: 4242, parentProcessId: 100, residentBytes: 943_718_400 }]);
  });

  it("reads the POSIX table, where rss is in kilobytes", () => {
    expect(parsePosixProcessTable(" 4242   100  921600\n")).toEqual([
      { processId: 4242, parentProcessId: 100, residentBytes: 921_600 * 1024 }
    ]);
  });

  it("skips a line it cannot read rather than inventing a process", () => {
    expect(parsePosixProcessTable("garbage\n 1 0 10\n")).toEqual([
      { processId: 1, parentProcessId: 0, residentBytes: 10 * 1024 }
    ]);
  });
});
