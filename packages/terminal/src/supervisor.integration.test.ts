import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { LaunchSpec, RuntimePlatform } from "@forgedeck/agent-sdk";

import { NodePtyFactory } from "./node-pty-factory";
import { createAllowedEnvironment } from "./security";
import { InMemoryRuntimeSessionStore } from "./session-store";
import { ProcessSupervisor } from "./supervisor";

let workspaceWithSpaces = "";
const fakeAgentPath = resolve("packages/fake-agent/bin/fake-agent.mjs");
const supervisors: ProcessSupervisor[] = [];

beforeAll(async () => {
  workspaceWithSpaces = await mkdtemp(join(tmpdir(), "ForgeDeck workspace with spaces "));
});

// Every supervisor is fully closed before the workspace is removed: close() reaps the process tree of
// terminal sessions too, so no fake-agent child can outlive its test and keep holding the cwd.
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.close();
    expect(supervisor.listSessions()).toHaveLength(0);
  }
});

afterAll(async () => {
  await rm(workspaceWithSpaces, { recursive: true, force: true });
});

describe("node-pty process supervisor", () => {
  it("runs the platform shell from a cwd containing spaces without assuming Bash", async () => {
    const supervisor = createSupervisor();
    await supervisor.start({
      sessionId: "platform-shell",
      adapterId: "shell",
      launch: shellLaunch(),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    await expect(supervisor.waitForTerminal("platform-shell", 5_000)).resolves.toMatchObject({
      state: "succeeded"
    });
    expect(supervisor.getSession("platform-shell").state).toBe("succeeded");
    expect(supervisor.getBuffer("platform-shell")).toContain("SHELL_OK");
  }, 10_000);

  it.runIf(process.platform === "win32")(
    "runs a Windows command shim through node-pty",
    async () => {
      const commandShim = join(workspaceWithSpaces, "agent shim.cmd");
      await writeFile(
        commandShim,
        '@echo off\r\nif "%~1"=="argument with spaces" (echo PTY_SHIM_OK) else (exit /b 9)\r\n'
      );
      const supervisor = createSupervisor();

      await supervisor.start({
        sessionId: "windows-command-shim",
        adapterId: "codex",
        launch: {
          executable: { path: commandShim, kind: "command-shim" },
          args: ["argument with spaces"],
          cwd: workspaceWithSpaces,
          environment: createAllowedEnvironment(process.env, { TERM: "xterm-256color" }),
          cols: 120,
          rows: 30
        },
        allowedCwdRoots: [workspaceWithSpaces]
      });

      await waitForTerminal(supervisor, "windows-command-shim");
      expect(supervisor.getSession("windows-command-shim").state).toBe("succeeded");
      expect(supervisor.getBuffer("windows-command-shim")).toContain("PTY_SHIM_OK");
    },
    10_000
  );

  it("runs four fake agents in parallel without losing lifecycle isolation", async () => {
    const supervisor = createSupervisor(300);
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        supervisor.start({
          sessionId: `parallel-${index}`,
          adapterId: "fake-agent",
          launch: fakeLaunch("burst", ["--lines", "200"]),
          allowedCwdRoots: [workspaceWithSpaces]
        })
      )
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => waitForTerminal(supervisor, `parallel-${index}`))
    );
    for (let index = 0; index < 4; index += 1) {
      expect(supervisor.getSession(`parallel-${index}`).state).toBe("succeeded");
      expect(supervisor.getBuffer(`parallel-${index}`)).toContain("fake-line-199");
    }
  }, 15_000);

  it("persists the expected process lifecycle", async () => {
    const store = new InMemoryRuntimeSessionStore();
    const supervisor = createSupervisor(1_000, store);
    const lifecycle: string[] = [];
    const subscription = supervisor.subscribe((event) => {
      if (event.type === "session.state" && event.session.id === "lifecycle") {
        lifecycle.push(event.session.state);
      }
    });

    await supervisor.start({
      sessionId: "lifecycle",
      adapterId: "fake-agent",
      launch: fakeLaunch("slow", ["--delay-ms", "25"]),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    await waitForTerminal(supervisor, "lifecycle");
    subscription.dispose();

    expect(lifecycle).toEqual(["starting", "running", "succeeded"]);
    expect(store.records.get("lifecycle")?.state).toBe("succeeded");
    expect(store.records.get("lifecycle")?.endedAt).toBeInstanceOf(Date);
  }, 10_000);

  it("supports input, output, and resize", async () => {
    const supervisor = createSupervisor();
    await supervisor.start({
      sessionId: "echo",
      adapterId: "fake-agent",
      launch: fakeLaunch("echo"),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    supervisor.resize("echo", 132, 42);
    await supervisor.write("echo", "hello\r");
    await waitForOutput(supervisor, "echo", "ECHO:hello");
    await supervisor.write("echo", "exit\r");
    await waitForTerminal(supervisor, "echo");
    expect(supervisor.getSession("echo").state).toBe("succeeded");
  }, 10_000);

  it("cancels idempotently and leaves no uncooperative child process orphaned", async () => {
    const supervisor = createSupervisor();
    await supervisor.start({
      sessionId: "cancel",
      adapterId: "fake-agent",
      launch: fakeLaunch("hang", ["--ignore-stop", "--spawn-child"]),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    await waitForOutput(supervisor, "cancel", "CHILD_PID:");
    const childPid = childPidFrom(supervisor.getBuffer("cancel"));
    const [firstCancel, secondCancel] = await Promise.all([
      supervisor.cancel("cancel", 100),
      supervisor.cancel("cancel", 100)
    ]);

    expect(firstCancel.state).toBe("cancelled");
    expect(secondCancel.state).toBe("cancelled");
    await waitUntil(() => !isProcessRunning(childPid));
    expect(supervisor.getSession("cancel").state).toBe("cancelled");
    await expect(supervisor.cancel("cancel", 100)).resolves.toMatchObject({ state: "cancelled" });
  }, 10_000);

  it("shuts down every active session without leaving its child process behind", async () => {
    const supervisor = createSupervisor();
    await supervisor.start({
      sessionId: "shutdown",
      adapterId: "fake-agent",
      launch: fakeLaunch("hang", ["--ignore-stop", "--spawn-child"]),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    await waitForOutput(supervisor, "shutdown", "CHILD_PID:");
    const childPid = childPidFrom(supervisor.getBuffer("shutdown"));

    await supervisor.shutdown(100);

    expect(supervisor.getSession("shutdown").state).toBe("cancelled");
    await waitUntil(() => !isProcessRunning(childPid));
  }, 10_000);

  it("contains a crash and starts a later session successfully", async () => {
    const supervisor = createSupervisor();
    await supervisor.start({
      sessionId: "crash",
      adapterId: "fake-agent",
      launch: fakeLaunch("crash"),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    await waitForTerminal(supervisor, "crash");
    expect(supervisor.getSession("crash").state).toBe("failed");

    await supervisor.start({
      sessionId: "after-crash",
      adapterId: "fake-agent",
      launch: fakeLaunch("slow", ["--delay-ms", "25"]),
      allowedCwdRoots: [workspaceWithSpaces]
    });
    await waitForTerminal(supervisor, "after-crash");
    expect(supervisor.getSession("after-crash").state).toBe("succeeded");
  }, 10_000);
});

function createSupervisor(
  maxBufferLines = 1_000,
  sessionStore?: InMemoryRuntimeSessionStore
): ProcessSupervisor {
  const supervisor = new ProcessSupervisor(new NodePtyFactory(), {
    platform: platform(),
    batchIntervalMs: 8,
    maxBufferLines,
    sessionStore
  });
  supervisors.push(supervisor);
  return supervisor;
}

function fakeLaunch(mode: string, extraArgs: readonly string[] = []): LaunchSpec {
  return {
    executable: { path: process.execPath, kind: "native" },
    args: [fakeAgentPath, "--mode", mode, ...extraArgs],
    cwd: workspaceWithSpaces,
    environment: createAllowedEnvironment(process.env, { TERM: "xterm-256color" }),
    cols: 120,
    rows: 30
  };
}

function shellLaunch(): LaunchSpec {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return {
    executable: {
      path:
        process.platform === "win32" ? join(windowsDirectory, "System32", "cmd.exe") : "/bin/sh",
      kind: "native"
    },
    args:
      process.platform === "win32"
        ? ["/d", "/s", "/c", "echo SHELL_OK"]
        : ["-c", "printf SHELL_OK"],
    cwd: workspaceWithSpaces,
    environment: createAllowedEnvironment(process.env, { TERM: "xterm-256color" }),
    cols: 120,
    rows: 30
  };
}

async function waitForTerminal(supervisor: ProcessSupervisor, sessionId: string): Promise<void> {
  await waitUntil(() =>
    ["succeeded", "failed", "cancelled", "interrupted"].includes(
      supervisor.getSession(sessionId).state
    )
  );
}

async function waitForOutput(
  supervisor: ProcessSupervisor,
  sessionId: string,
  value: string
): Promise<void> {
  await waitUntil(() => supervisor.getBuffer(sessionId).includes(value));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 7_500;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for fake agent");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function platform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported test platform");
}

function childPidFrom(output: string): number {
  const match = /CHILD_PID:(\d+)/.exec(output);
  if (match?.[1] === undefined) {
    throw new Error("Fake agent did not report a child PID");
  }
  return Number.parseInt(match[1], 10);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
