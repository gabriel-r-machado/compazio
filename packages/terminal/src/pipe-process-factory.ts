import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { LaunchSpec } from "@forgedeck/agent-sdk";

import type { Disposable, ManagedProcess, ManagedProcessFactory, PtyExitEvent } from "./types";

/** Ceiling on observability bytes forwarded from a child, so a chatty process cannot exhaust memory. */
const DEFAULT_MAX_OBSERVED_BYTES = 8 * 1024 * 1024;

/**
 * Runs a child with piped stdio for non-interactive single-shot agents. Unlike a pty, a real pipe
 * delivers written input to the child's own `process.stdin` (a Windows ConPTY does not), which is how
 * `claude -p` and other CLIs read their prompt. It never uses a shell and only accepts a native
 * executable — command shims must be resolved to their native target before they reach this factory.
 */
export class PipeProcessFactory implements ManagedProcessFactory {
  public constructor(private readonly maxObservedBytes: number = DEFAULT_MAX_OBSERVED_BYTES) {}

  public async spawn(spec: LaunchSpec): Promise<ManagedProcess> {
    if (spec.executable.kind !== "native") {
      // A command shim (.cmd/.bat) cannot be launched without a shell on current Node; the adapter
      // must resolve its native binary first. We never fall back to shell:true.
      throw new Error(
        "The pipe transport requires a native executable; resolve command shims to their native target first."
      );
    }
    const child = spawn(spec.executable.path, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.environment },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: spec.windowsVerbatimArguments ?? false,
      windowsHide: true
    });
    return new PipeProcess(child, this.maxObservedBytes);
  }
}

class PipeProcess implements ManagedProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private observedBytes = 0;
  private exitCode: number | null = null;
  private stdinEnded = false;
  private closed = false;

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxObservedBytes: number
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // stdout and stderr are read from separate file descriptors and both drained until close, so a
    // full pipe never blocks the child; both are forwarded to observability (bounded).
    child.stdout.on("data", (chunk: string) => this.observe(chunk));
    child.stderr.on("data", (chunk: string) => this.observe(chunk));
    child.stdin.on("error", () => {
      // Ignore EPIPE if the child exits before its input is fully written.
    });
    child.once("exit", (code) => {
      this.exitCode = typeof code === "number" ? code : 1;
    });
    child.once("error", () => {
      // A spawn/runtime error (e.g. ENOENT) surfaces as a non-zero termination via `close`.
      if (this.exitCode === null) this.exitCode = 1;
    });
    // `close` fires only after stdout and stderr are fully drained, so no output is lost before the
    // session is reported terminal.
    child.once("close", () => this.finish());
  }

  public get pid(): number {
    return this.child.pid ?? -1;
  }

  public write(data: string): void {
    if (this.stdinEnded) return;
    if (this.child.stdin.writable) {
      // stdin.write buffers when it returns false (backpressure); endInput's stdin.end() flushes it,
      // so a bounded prompt is delivered in full regardless of the writable high-water mark.
      this.child.stdin.write(data);
    }
  }

  public endInput(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    if (this.child.stdin.writable) this.child.stdin.end();
  }

  public requestCancel(): void {
    // A single-shot child reading stdin finishes once its input reaches EOF; closing stdin is the
    // graceful stop. The supervisor tree-kills the process if it does not exit within the grace.
    this.endInput();
  }

  public resize(): void {
    // No terminal to resize under the pipe transport.
  }

  public kill(signal?: string): void {
    this.child.kill((signal as NodeJS.Signals | undefined) ?? undefined);
  }

  public onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  public onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    if (this.closed) listener({ exitCode: this.exitCode ?? 1 });
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  public dispose(): void {
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.child.stdout.removeAllListeners();
    this.child.stderr.removeAllListeners();
    this.child.stdin.removeAllListeners();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private observe(chunk: string): void {
    if (this.observedBytes >= this.maxObservedBytes) return; // keep draining, but stop forwarding
    this.observedBytes += Buffer.byteLength(chunk, "utf8");
    for (const listener of this.dataListeners) listener(chunk);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const event: PtyExitEvent = { exitCode: this.exitCode ?? 1 };
    for (const listener of this.exitListeners) listener(event);
  }
}
