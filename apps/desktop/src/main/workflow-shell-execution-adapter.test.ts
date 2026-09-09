import { describe, expect, it, vi } from "vitest";

import type { ShellExecutionRequest } from "@forgedeck/orchestration";
import { ShellExecutionAdapterError } from "@forgedeck/orchestration";
import { ProcessTerminalWaitTimeoutError } from "@forgedeck/terminal";

import { ProcessSupervisorShellExecutionAdapter } from "./workflow-shell-execution-adapter";

describe("ProcessSupervisorShellExecutionAdapter", () => {
  it("resolves an approved root and executable internally before running a shell node", async () => {
    const terminal = {
      start: vi.fn().mockResolvedValue(session("running")),
      waitForTerminal: vi.fn().mockResolvedValue(session("succeeded", 0)),
      cancel: vi.fn().mockResolvedValue(session("cancelled"))
    };
    const detector = {
      find: vi.fn().mockResolvedValue({ path: "C:\\tools\\pnpm.cmd", kind: "command-shim" })
    };
    const adapter = new ProcessSupervisorShellExecutionAdapter(
      terminal,
      { resolveRunRoot: () => "C:\\approved-project" },
      detector,
      { PATH: "C:\\tools", PATHEXT: ".CMD", SECRET: "not-forwarded" },
      "win32",
      () => "run-node-1"
    );

    const result = await adapter.execute(request());

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(detector.find).toHaveBeenCalledWith(["pnpm"], {
      platform: "win32",
      environment: { PATH: "C:\\tools", PATHEXT: ".CMD", SECRET: "not-forwarded" }
    });
    expect(terminal.start).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "workflow-shell",
        allowedCwdRoots: ["C:\\approved-project"],
        launch: expect.objectContaining({
          executable: { path: "C:\\tools\\pnpm.cmd", kind: "command-shim" },
          args: ["run", "lint"],
          cwd: "C:\\approved-project"
        })
      })
    );
    expect(terminal.start.mock.calls[0]?.[0].launch.environment).not.toHaveProperty("SECRET");
  });

  it("refuses external executable paths and unavailable targets without leaking details", async () => {
    const terminal = {
      start: vi.fn(),
      waitForTerminal: vi.fn(),
      cancel: vi.fn()
    };
    const adapter = new ProcessSupervisorShellExecutionAdapter(
      terminal,
      { resolveRunRoot: () => null },
      { find: vi.fn() },
      {},
      "win32"
    );

    await expect(adapter.execute(request({ executable: "C:\\unsafe\\tool.exe" }))).rejects.toEqual(
      expect.objectContaining({ code: "adapter_unavailable" })
    );
    await expect(adapter.execute(request())).rejects.toBeInstanceOf(ShellExecutionAdapterError);
    expect(terminal.start).not.toHaveBeenCalled();
  });

  it("cancels a timed-out process and returns a typed timeout without output", async () => {
    const terminal = {
      start: vi.fn().mockResolvedValue(session("running")),
      waitForTerminal: vi.fn().mockRejectedValue(new ProcessTerminalWaitTimeoutError()),
      cancel: vi.fn().mockResolvedValue(session("cancelled"))
    };
    const adapter = new ProcessSupervisorShellExecutionAdapter(
      terminal,
      { resolveRunRoot: () => "C:\\approved-project" },
      { find: vi.fn().mockResolvedValue({ path: "C:\\tools\\pnpm.cmd", kind: "command-shim" }) },
      { PATH: "C:\\tools" },
      "win32",
      () => "run-node-2"
    );

    const result = await adapter.execute(request());

    expect(result.timedOut).toBe(true);
    expect(terminal.cancel).toHaveBeenCalledWith("workflow-shell-run-node-2");
    expect(JSON.stringify(result)).not.toContain("output");
  });
});

function request(
  command: { readonly executable: string; readonly args?: readonly string[] } = {
    executable: "pnpm"
  }
): ShellExecutionRequest {
  return {
    command: { executable: command.executable, args: [...(command.args ?? ["run", "lint"])] },
    runId: "workflow-run-1",
    nodeRunId: "workflow-node-run-1",
    nodeId: "lint",
    attempt: 1,
    timeoutMs: 500,
    abortSignal: new AbortController().signal
  };
}

function session(state: "running" | "succeeded" | "cancelled", exitCode: number | null = null) {
  return {
    id: "workflow-shell-run-node-1",
    adapterId: "workflow-shell",
    state,
    processId: null,
    startedAt: "2026-07-20T12:00:00.000Z",
    endedAt: state === "running" ? null : "2026-07-20T12:00:01.000Z",
    exitCode,
    exitSignal: null
  };
}
