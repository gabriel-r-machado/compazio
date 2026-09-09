import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { LaunchSpec, RuntimePlatform } from "@forgedeck/agent-sdk";

import { PipeProcessFactory } from "./pipe-process-factory";
import { PtyProcessFactory } from "./node-pty-factory";
import { TransportProcessFactory } from "./transport-process-factory";
import { createAllowedEnvironment } from "./security";
import { ProcessSupervisor } from "./supervisor";

let workspace = "";
const supervisors: ProcessSupervisor[] = [];

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "forgedeck-pipe-"));
});
// Every supervisor is fully closed before the workspace is removed: close() reaps the process tree of
// terminal sessions too, so no child can outlive its test and keep holding the cwd.
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.close();
    expect(supervisor.listSessions()).toHaveLength(0);
  }
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** One supervisor drives both transports; these tests exercise only the pipe path. */
function createSupervisor(): ProcessSupervisor {
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(platform()),
      pipe: new PipeProcessFactory()
    }),
    { platform: platform(), batchIntervalMs: 8, maxBufferLines: 1_000 }
  );
  supervisors.push(supervisor);
  return supervisor;
}

/** A native Node child (shell:false) with an inline script, run over the pipe transport. */
function nodePipeLaunch(
  script: string,
  initialInput?: { data: string; closeAfterWrite: boolean }
): LaunchSpec {
  return {
    executable: { path: process.execPath, kind: "native" },
    args: ["-e", script],
    cwd: workspace,
    environment: createAllowedEnvironment(process.env),
    cols: 120,
    rows: 30,
    transport: "pipe",
    ...(initialInput === undefined ? {} : { initialInput })
  };
}

describe("pipe transport through the shared ProcessSupervisor", () => {
  it("delivers the prompt to the child's process.stdin and the child observes end-of-input", async () => {
    const supervisor = createSupervisor();
    const prompt = 'line one\nquote "q" & pipe | 100% café ✅ done!\nlast';
    const script = [
      "let b='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',d=>{b+=d;});",
      "process.stdin.on('end',()=>{",
      "  process.stdout.write('RECV:'+JSON.stringify(b)+'\\n');",
      "  process.stdout.write('CHILD_END\\n');",
      "  process.exit(0);",
      "});"
    ].join("");
    await supervisor.start({
      sessionId: "stdin",
      adapterId: "pipe",
      launch: nodePipeLaunch(script, { data: prompt, closeAfterWrite: true }),
      allowedCwdRoots: [workspace]
    });
    await expect(supervisor.waitForTerminal("stdin", 10_000)).resolves.toMatchObject({
      state: "succeeded"
    });
    const buffer = supervisor.getBuffer("stdin");
    // The child received the exact bytes on its own stdin (newlines, quotes, metacharacters, Unicode).
    expect(buffer).toContain(`RECV:${JSON.stringify(prompt)}`);
    // ...and it observed the stdin 'end' event (input was closed after writing).
    expect(buffer).toContain("CHILD_END");
  }, 15_000);

  it("captures both stdout and stderr and reports a non-zero exit as failed", async () => {
    const supervisor = createSupervisor();
    const script =
      "process.stdout.write('OUT_MARKER\\n');process.stderr.write('ERR_MARKER\\n');process.exit(3);";
    await supervisor.start({
      sessionId: "streams",
      adapterId: "pipe",
      launch: nodePipeLaunch(script, { data: "", closeAfterWrite: true }),
      allowedCwdRoots: [workspace]
    });
    const snapshot = await supervisor.waitForTerminal("streams", 10_000);
    expect(snapshot.state).toBe("failed");
    expect(snapshot.exitCode).toBe(3);
    const buffer = supervisor.getBuffer("streams");
    expect(buffer).toContain("OUT_MARKER");
    expect(buffer).toContain("ERR_MARKER");
  }, 15_000);

  it("cancels a pipe session and terminates the whole process tree", async () => {
    const supervisor = createSupervisor();
    const script = [
      "const cp=require('node:child_process');",
      "const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "process.stdout.write('GPID:'+(g.pid??0)+'\\n');",
      "setInterval(()=>{},1000);"
    ].join("");
    await supervisor.start({
      sessionId: "cancel",
      adapterId: "pipe",
      launch: nodePipeLaunch(script),
      allowedCwdRoots: [workspace]
    });
    await waitUntil(() => supervisor.getBuffer("cancel").includes("GPID:"));
    const grandchildPid = pidFrom(supervisor.getBuffer("cancel"), "GPID");
    const cancelled = await supervisor.cancel("cancel", 100);
    expect(cancelled.state).toBe("cancelled");
    await waitUntil(() => !isRunning(grandchildPid));
    expect(isRunning(grandchildPid)).toBe(false);
  }, 15_000);
});

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

function pidFrom(output: string, label: string): number {
  const match = new RegExp(`${label}:(\\d+)`).exec(output);
  if (match?.[1] === undefined) throw new Error(`missing ${label} in child output`);
  return Number.parseInt(match[1], 10);
}

function isRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a pipe condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
