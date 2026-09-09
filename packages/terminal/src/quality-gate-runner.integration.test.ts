import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessQualityGateRunner } from "./quality-gate-runner";

const temporaryDirectories: string[] = [];

// Removal is deliberately retry-free: the runner reaps its process tree before reporting a result, so an
// EBUSY here would mean a real leak (a process outliving its run) and must fail instead of being waited out.
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("quality gate runner", () => {
  it("captures a real exit code, duration and redacted output in a path with spaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ForgeDeck gate path with spaces "));
    temporaryDirectories.push(cwd);
    const result = await new ProcessQualityGateRunner().run({
      sessionId: "gate-real-exit",
      executable: { path: process.execPath, kind: "native" },
      args: ["-e", "process.stdout.write('FORGEDECK_TEST_SECRET_gate-output\\n'); process.exit(3)"],
      cwd,
      allowedCwdRoot: cwd,
      timeoutMs: 5_000
    });

    expect(result.exitCode).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputSummary).toContain("[REDACTED]");
    expect(result.outputSummary).not.toContain("FORGEDECK_TEST_SECRET_gate-output");
  });

  it("times out and cancels the process tree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ForgeDeck gate timeout "));
    temporaryDirectories.push(cwd);
    const result = await new ProcessQualityGateRunner().run({
      sessionId: "gate-timeout",
      executable: { path: process.execPath, kind: "native" },
      args: [
        "-e",
        "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>process.stdout.write('waiting\\n'),25)"
      ],
      cwd,
      allowedCwdRoot: cwd,
      timeoutMs: 100
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });

  it.runIf(process.platform === "win32")(
    "runs a Windows command shim with paths and arguments containing spaces",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "ForgeDeck cmd shim path with spaces "));
      temporaryDirectories.push(cwd);
      const shim = join(cwd, "quality gate shim.cmd");
      await writeFile(
        shim,
        '@echo off\r\nif "%~1"=="value with spaces" (exit /b 0) else (exit /b 9)\r\n',
        "utf8"
      );
      const result = await new ProcessQualityGateRunner().run({
        sessionId: "gate-windows-shim",
        executable: { path: shim, kind: "command-shim" },
        args: ["value with spaces"],
        cwd,
        allowedCwdRoot: cwd,
        timeoutMs: 5_000
      });
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    }
  );
});
