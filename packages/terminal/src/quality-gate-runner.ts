import { spawn } from "node:child_process";
import { extname } from "node:path";

import { redactText } from "@forgedeck/logger";
import type {
  GateCommandResult,
  GateCommandRunner,
  GateCommandRunnerInput
} from "@forgedeck/orchestration";

import { PlatformProcessTreeKiller } from "./process-tree-killer";
import { createAllowedEnvironment, validateLaunchSpec } from "./security";
import type { ProcessTreeKiller } from "./types";

const maximumSummaryCharacters = 64 * 1024;

export class ProcessQualityGateRunner implements GateCommandRunner {
  public constructor(
    private readonly treeKiller: ProcessTreeKiller = new PlatformProcessTreeKiller(),
    private readonly now: () => number = () => Date.now()
  ) {}

  public async run(input: GateCommandRunnerInput): Promise<GateCommandResult> {
    if (input.timeoutMs < 1 || input.timeoutMs > 3_600_000) {
      throw new Error("Quality gate timeout is outside the allowed range");
    }
    const environment = createAllowedEnvironment(process.env, {
      CI: "true",
      NO_COLOR: "1",
      FORCE_COLOR: "0"
    });
    await validateLaunchSpec(
      {
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        environment,
        cols: 120,
        rows: 30
      },
      [input.allowedCwdRoot],
      normalizePlatform(process.platform)
    );
    const command = prepareCommand(input);
    const startedAt = this.now();
    let output = "";
    let timedOut = false;
    const child = spawn(command.executable, command.args, {
      cwd: input.cwd,
      env: { ...environment },
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > maximumSummaryCharacters * 2) {
        output = output.slice(-maximumSummaryCharacters);
      }
    };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);

    const completion = new Promise<{ readonly exitCode: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ exitCode }));
    });
    const processId = child.pid;
    if (processId === undefined) {
      await completion;
      throw new Error("Quality gate process did not provide a process id");
    }
    // Retained so the run never resolves while the tree it killed is still dying: a grandchild that
    // outlives the reported result would keep holding the cwd, and the caller's cleanup would fail.
    let treeReap: Promise<unknown> | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      treeReap = this.treeKiller.kill(processId).catch(() => child.kill());
    }, input.timeoutMs);
    try {
      await input.onSpawn?.(processId);
    } catch (error: unknown) {
      await this.treeKiller.kill(processId).catch(() => child.kill());
      clearTimeout(timeout);
      throw new Error("Could not persist the quality gate process identity", { cause: error });
    }

    try {
      const result = await completion;
      // The direct child closing does not mean its tree is gone; await the reap before reporting.
      await treeReap;
      const redacted = redactText(output);
      return {
        exitCode: result.exitCode,
        durationMs: Math.max(0, this.now() - startedAt),
        outputSummary:
          redacted.length <= maximumSummaryCharacters
            ? redacted
            : `[output truncated]\n${redacted.slice(-maximumSummaryCharacters)}`,
        timedOut
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function prepareCommand(input: GateCommandRunnerInput): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
} {
  if (process.platform !== "win32" || input.executable.kind !== "command-shim") {
    return {
      executable: input.executable.path,
      args: input.args,
      windowsVerbatimArguments: false
    };
  }
  const extension = extname(input.executable.path).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return {
      executable: input.executable.path,
      args: input.args,
      windowsVerbatimArguments: false
    };
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

function normalizePlatform(platform: NodeJS.Platform): "win32" | "darwin" | "linux" {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`Unsupported runtime platform: ${platform}`);
}
