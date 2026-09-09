import { execFile } from "node:child_process";

import type { CommandResult, CommandRunInput, CommandRunner } from "@forgedeck/agent-sdk";

export class ExecFileCommandRunner implements CommandRunner {
  public run(input: CommandRunInput): Promise<CommandResult> {
    const prepared = prepareCommand(input);
    return new Promise((resolve) => {
      execFile(
        prepared.executable,
        prepared.args,
        {
          cwd: input.cwd,
          env: { ...input.environment },
          timeout: input.timeoutMs,
          windowsVerbatimArguments: prepared.windowsVerbatimArguments,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        },
        (error, stdout, stderr) => {
          const exitCode =
            error !== null && typeof error.code === "number"
              ? error.code
              : error === null
                ? 0
                : null;
          resolve({
            exitCode,
            stdout,
            stderr,
            timedOut: error !== null && (error.killed ?? false)
          });
        }
      );
    });
  }
}

function prepareCommand(input: CommandRunInput): {
  executable: string;
  args: readonly string[];
  windowsVerbatimArguments: boolean;
} {
  if (process.platform !== "win32" || input.executable.kind !== "command-shim") {
    return { executable: input.executable.path, args: input.args, windowsVerbatimArguments: false };
  }
  if (input.args.some((argument) => /[&|<>^()%!]/.test(argument))) {
    throw new Error("Windows command shim arguments contain shell metacharacters");
  }
  const commandProcessor = process.env.ComSpec;
  if (commandProcessor === undefined) {
    throw new Error("COMSPEC is required to run a Windows command shim");
  }
  const command = [input.executable.path, ...input.args].map(quoteWindowsArgument).join(" ");
  return {
    executable: commandProcessor,
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true
  };
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
