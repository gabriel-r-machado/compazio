import type { ManagedProcess, ManagedProcessFactory, ProcessTreeKiller } from "@forgedeck/terminal";
import { describe, expect, it, vi } from "vitest";

import { V2ProcessSupervisor } from "./index";

class FakeProcess implements ManagedProcess {
  public readonly pid = 321;
  public readonly write = vi.fn();
  public readonly endInput = vi.fn();
  public readonly requestCancel = vi.fn();
  public readonly resize = vi.fn();
  public readonly kill = vi.fn();
  public readonly dispose = vi.fn();
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (result: { exitCode: number; signal?: number }) => void
  >();

  public onData(listener: (data: string) => void) {
    this.outputListeners.add(listener);
    return { dispose: () => this.outputListeners.delete(listener) };
  }

  public onExit(listener: (result: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  public output(data: string): void {
    for (const listener of this.outputListeners) listener(data);
  }

  public exit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }

  public get listenerCount(): number {
    return this.outputListeners.size + this.exitListeners.size;
  }
}

const launch = {
  executable: { path: process.execPath, kind: "native" as const },
  args: [],
  cwd: process.cwd(),
  environment: {},
  cols: 80,
  rows: 24,
  transport: "pipe" as const
};

describe("V2ProcessSupervisor", () => {
  it("owns start, output, input, lifecycle and listener cleanup", async () => {
    const process = new FakeProcess();
    const factory: ManagedProcessFactory = { spawn: vi.fn(async () => process) };
    const killer: ProcessTreeKiller = { kill: vi.fn(async () => undefined) };
    const supervisor = new V2ProcessSupervisor(factory, { treeKiller: killer });
    const events: string[] = [];
    supervisor.subscribe((event) => events.push(event.type));

    await supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });
    await supervisor.write("session_1", "hello");
    supervisor.resize("session_1", 100, 40);
    process.output("world");
    process.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(process.write).toHaveBeenCalledWith("hello");
    expect(process.resize).toHaveBeenCalledWith(100, 40);
    expect(supervisor.get("session_1").state).toBe("completed");
    supervisor.release("session_1");
    expect(process.dispose).toHaveBeenCalled();
    expect(events).toContain("terminal.output");
  });

  it("keeps a renderer resize requested during spawn and applies it to the real PTY", async () => {
    const process = new FakeProcess();
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const factory: ManagedProcessFactory = {
      spawn: vi.fn(async () => {
        await spawnGate;
        return process;
      })
    };
    const supervisor = new V2ProcessSupervisor(factory, {
      treeKiller: { kill: vi.fn(async () => undefined) }
    });
    const starting = supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });

    await Promise.resolve();
    supervisor.resize("session_1", 132, 38);
    expect(process.resize).not.toHaveBeenCalled();

    releaseSpawn();
    await starting;
    expect(process.resize).toHaveBeenCalledWith(132, 38);
  });

  it("serializes concurrent renderer and connection writes byte-for-byte", async () => {
    const process = new FakeProcess();
    const supervisor = new V2ProcessSupervisor(
      { spawn: vi.fn(async () => process) },
      { treeKiller: { kill: vi.fn(async () => undefined) } }
    );
    await supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });

    const writes = [
      supervisor.write("session_1", "\u001b[200~linha 1\n"),
      supervisor.write("session_1", "linha 2\u001b[201~"),
      supervisor.write("session_1", "\r")
    ];
    await Promise.all(writes);

    expect(process.write.mock.calls.map(([data]) => data)).toEqual([
      "\u001b[200~linha 1\n",
      "linha 2\u001b[201~",
      "\r"
    ]);
  });

  it("waits for PTY output between a connection paste and its submit byte", async () => {
    const process = new FakeProcess();
    process.write.mockImplementationOnce(() => process.output("redraw after paste"));
    const supervisor = new V2ProcessSupervisor(
      { spawn: vi.fn(async () => process) },
      { treeKiller: { kill: vi.fn(async () => undefined) } }
    );
    await supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });

    const delivery = supervisor.writeWithOutputBarrier(
      "session_1",
      "\u001b[200~connected task\u001b[201~",
      "\r"
    );
    const rendererInput = supervisor.write("session_1", "typed later");
    await Promise.all([delivery, rendererInput]);

    expect(process.write.mock.calls.map(([data]) => data)).toEqual([
      "\u001b[200~connected task\u001b[201~",
      "\r",
      "typed later"
    ]);
  });

  it("uses a bounded fallback when a terminal does not redraw pasted input", async () => {
    const process = new FakeProcess();
    const supervisor = new V2ProcessSupervisor(
      { spawn: vi.fn(async () => process) },
      { treeKiller: { kill: vi.fn(async () => undefined) } }
    );
    await supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });

    await supervisor.writeWithOutputBarrier("session_1", "paste", "\r", 1);

    expect(process.write.mock.calls.map(([data]) => data)).toEqual(["paste", "\r"]);
  });

  it("supports a second submit stroke separated by another output barrier", async () => {
    const process = new FakeProcess();
    process.write.mockImplementation(() => process.output("redraw"));
    const supervisor = new V2ProcessSupervisor(
      { spawn: vi.fn(async () => process) },
      { treeKiller: { kill: vi.fn(async () => undefined) } }
    );
    await supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });

    await supervisor.writeSequenceWithOutputBarrier("session_1", ["paste", "\r", "\r"]);

    expect(process.write.mock.calls.map(([data]) => data)).toEqual(["paste", "\r", "\r"]);
  });

  it.each([1, 2, 3, 4])(
    "preserves every byte and frame in a %i-frame submission",
    async (count) => {
      const process = new FakeProcess();
      process.write.mockImplementation(() => process.output("redraw"));
      const supervisor = new V2ProcessSupervisor(
        { spawn: vi.fn(async () => process) },
        { treeKiller: { kill: vi.fn(async () => undefined) } }
      );
      await supervisor.start({
        sessionId: "session_1",
        workspaceId: "workspace_1",
        terminalNodeId: "node_1",
        launch
      });
      const frames = Array.from(
        { length: count },
        (_, index) => `frame-${index}-α🚀-${"x".repeat(4_096)}`
      );

      if (frames.length === 1) await supervisor.write("session_1", frames[0] ?? "");
      else await supervisor.writeSequenceWithOutputBarrier("session_1", frames);

      expect(process.write.mock.calls.map(([data]) => data)).toEqual(frames);
    }
  );

  it("forces an uncooperative process after the grace period and deletion is idempotent", async () => {
    const process = new FakeProcess();
    const factory: ManagedProcessFactory = { spawn: vi.fn(async () => process) };
    const killer: ProcessTreeKiller = { kill: vi.fn(async () => undefined) };
    const supervisor = new V2ProcessSupervisor(factory, { treeKiller: killer, gracePeriodMs: 1 });
    await supervisor.start({
      sessionId: "session_1",
      workspaceId: "workspace_1",
      terminalNodeId: "node_1",
      launch
    });

    await supervisor.releaseNode("workspace_1", "node_1");
    await supervisor.releaseNode("workspace_1", "node_1");

    expect(process.requestCancel).toHaveBeenCalledOnce();
    expect(killer.kill).toHaveBeenCalledWith(321);
    expect(supervisor.list()).toEqual([]);
  });

  it("owns five simultaneous sessions and releases every listener during global shutdown", async () => {
    const allProcesses = Array.from({ length: 5 }, () => new FakeProcess());
    const processes = [...allProcesses];
    const factory: ManagedProcessFactory = {
      spawn: vi.fn(async () => {
        const next = processes.shift();
        if (next === undefined) throw new Error("missing process fixture");
        return next;
      })
    };
    const killer: ProcessTreeKiller = { kill: vi.fn(async () => undefined) };
    const supervisor = new V2ProcessSupervisor(factory, { treeKiller: killer, gracePeriodMs: 1 });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        supervisor.start({
          sessionId: `session_${index}`,
          workspaceId: "workspace_1",
          terminalNodeId: `node_${index}`,
          launch
        })
      )
    );
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        supervisor.write(`session_${index}`, `input-${index}`)
      )
    );

    expect(allProcesses.map((process) => process.write.mock.calls[0]?.[0])).toEqual(
      Array.from({ length: 5 }, (_, index) => `input-${index}`)
    );

    await supervisor.shutdown();

    expect(killer.kill).toHaveBeenCalledTimes(5);
    expect(allProcesses.every((process) => process.dispose.mock.calls.length === 1)).toBe(true);
    expect(allProcesses.every((process) => process.listenerCount === 0)).toBe(true);
    expect(supervisor.list()).toEqual([]);
  });

  it("opens and closes 100 sessions without retaining process or subscriber listeners", async () => {
    const processes: FakeProcess[] = [];
    const supervisor = new V2ProcessSupervisor(
      {
        spawn: vi.fn(async () => {
          const process = new FakeProcess();
          processes.push(process);
          return process;
        })
      },
      { treeKiller: { kill: vi.fn(async () => undefined) } }
    );
    const unsubscribe = supervisor.subscribe(() => undefined);

    for (let index = 0; index < 100; index += 1) {
      const sessionId = `cycle_${index}`;
      await supervisor.start({
        sessionId,
        workspaceId: "workspace_1",
        terminalNodeId: "reused_node",
        launch
      });
      processes[index]?.exit(0);
      await Promise.resolve();
      supervisor.release(sessionId);
    }
    unsubscribe();

    expect(supervisor.diagnostics()).toEqual({
      sessionCount: 0,
      activeSessionCount: 0,
      listenerCount: 0
    });
    expect(processes).toHaveLength(100);
    expect(processes.every((process) => process.listenerCount === 0)).toBe(true);
    expect(processes.every((process) => process.dispose.mock.calls.length === 1)).toBe(true);
  });
});
