import { extname } from "node:path";

import type { LaunchSpec, RuntimePlatform } from "@forgedeck/agent-sdk";
import type { IPty } from "node-pty";

import type { Disposable, ManagedProcess, ManagedProcessFactory } from "./types";

/** EOF control sequence sent to a pty to close a foreground reader's input, per platform. */
const PTY_EOF = { win32: "\r", posix: "" } as const;
/** Ctrl-C: interrupt sent to a pty's foreground process for a graceful cancel. */
const PTY_INTERRUPT = "";

/** Runs a child under a pseudo-terminal (node-pty), for interactive terminals. */
export class PtyProcessFactory implements ManagedProcessFactory {
  public constructor(private readonly platform: RuntimePlatform = normalizePlatform()) {}

  public async spawn(spec: LaunchSpec): Promise<ManagedProcess> {
    const nodePty = await import("node-pty");
    const command = prepareCommand(spec);
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(spec.environment).filter(([key]) => key.toUpperCase() !== "NO_COLOR")
    );
    const pty = nodePty.spawn(command.executable, command.args, {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      // The visible PTY is an xterm-compatible terminal. Keep ANSI and true-colour support
      // enabled for interactive TUIs (notably Claude Code) even when the parent desktop process
      // was started without a TERM or with a global NO_COLOR setting.
      env: {
        ...inheritedEnvironment,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1"
      },
      handleFlowControl: true
    });
    return new NodePtyProcess(pty, this.platform);
  }
}

/** @deprecated Kept for back-compat; use {@link PtyProcessFactory}. */
export const NodePtyFactory = PtyProcessFactory;

class NodePtyProcess implements ManagedProcess {
  public constructor(
    private readonly pty: IPty,
    private readonly platform: RuntimePlatform
  ) {}

  public get pid(): number {
    return this.pty.pid;
  }

  public write(data: string): void {
    this.pty.write(data);
  }

  public endInput(): void {
    // A pty has no separate stdin to close; the closest signal is the platform EOF control byte,
    // matching the prior supervisor closeAfterWrite path.
    this.pty.write(this.platform === "win32" ? PTY_EOF.win32 : PTY_EOF.posix);
  }

  public requestCancel(): void {
    // Ctrl-C to the terminal's foreground process, matching the interactive cancel semantics.
    this.pty.write(PTY_INTERRUPT);
  }

  public resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  public kill(signal?: string): void {
    this.pty.kill(signal);
  }

  public onData(listener: (data: string) => void): Disposable {
    return this.pty.onData(listener);
  }

  public onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable {
    return this.pty.onExit(listener);
  }

  public dispose(): void {
    // node-pty releases its own handles on exit; nothing extra to release here.
  }
}

function normalizePlatform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported runtime platform: ${process.platform}`);
}

function prepareCommand(spec: LaunchSpec): { executable: string; args: string[] | string } {
  if (process.platform !== "win32" || spec.executable.kind !== "command-shim") {
    return { executable: spec.executable.path, args: [...spec.args] };
  }

  const extension = extname(spec.executable.path).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { executable: spec.executable.path, args: [...spec.args] };
  }

  const commandProcessor = process.env.ComSpec;
  if (commandProcessor === undefined) {
    throw new Error("COMSPEC is required to launch a Windows command shim");
  }
  const command = [spec.executable.path, ...spec.args].map(quoteWindowsArgument).join(" ");
  return {
    executable: commandProcessor,
    // node-pty passes a raw Windows command line to ConPTY. Keeping the cmd.exe invocation as one
    // operand preserves its final quoted command instead of exposing the batch arguments to a
    // second argv reparse.
    args: `/d /s /c "${command}"`
  };
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
