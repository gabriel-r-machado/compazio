import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdapterContext,
  DetectedExecutable,
  ReviewedHandoffSubmissionControl,
  RuntimePlatform
} from "@forgedeck/agent-sdk";

import { ClaudeCodeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { OpenCodeAdapter } from "./opencode-adapter";
import { ExecFileCommandRunner } from "./command-runner";
import { PathExecutableDetector } from "./executable-detector";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("executable detection", () => {
  it("finds an executable in a PATH containing spaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ForgeDeck path with spaces "));
    temporaryDirectories.push(directory);
    const filename = process.platform === "win32" ? "space-tool.cmd" : "space-tool";
    const path = join(directory, filename);
    await writeFile(path, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") {
      await chmod(path, 0o755);
    }

    const result = await new PathExecutableDetector().find(["space-tool"], {
      platform: platform(),
      environment: { PATH: [directory, tmpdir()].join(delimiter), PATHEXT: ".EXE;.CMD" }
    });
    expect(result?.path).toBe(path);
    expect(result?.kind).toBe(process.platform === "win32" ? "command-shim" : "native");
  });

  it("returns null for an absent adapter", async () => {
    const result = await new PathExecutableDetector().find(["forgedeck-definitely-missing"], {
      platform: platform(),
      environment: { PATH: tmpdir() }
    });
    expect(result).toBeNull();
  });

  it("ignores extensionless npm wrappers when resolving a Windows command shim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ForgeDeck Windows shim "));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "codex"), "#!/bin/sh\n");
    const commandShim = join(directory, "codex.cmd");
    await writeFile(commandShim, "@exit /b 0\r\n");

    const result = await new PathExecutableDetector().find(["codex"], {
      platform: "win32",
      environment: { PATH: directory, PATHEXT: ".EXE;.CMD" }
    });

    expect(result).toEqual({ path: commandShim, kind: "command-shim" });
  });
});

describe("provider adapters", () => {
  const executable: DetectedExecutable = { path: process.execPath, kind: "native" };
  const launchInput = {
    executable,
    cwd: process.cwd(),
    environment: {},
    mode: "non-interactive" as const,
    workspaceAccess: "read-only" as const,
    initialMessage: { id: "message-1", content: "hello from stdin" }
  };

  it("builds a sandboxed Codex launch with prompt on stdin", async () => {
    const launch = await new CodexAdapter().buildLaunch(launchInput);
    expect(launch.args).toContain("--sandbox");
    expect(launch.args).toContain("read-only");
    expect(launch.args.join(" ")).not.toContain("dangerously-bypass");
    expect(launch.args.join(" ")).not.toContain("hello from stdin");
    expect(launch.initialInput?.data).toBe("hello from stdin");
  });

  it("starts the interactive Codex TUI without the recurring update prompt", async () => {
    const launch = await new CodexAdapter().buildLaunch({
      executable,
      cwd: process.cwd(),
      environment: {},
      mode: "interactive",
      workspaceAccess: "read-only"
    });

    expect(launch.args).toEqual(["-c", "check_for_update_on_startup=false"]);
    expect(launch.initialInput).toBeUndefined();
  });

  it("builds Claude stream-json without permission bypass", async () => {
    const launch = await new ClaudeCodeAdapter().buildLaunch(launchInput);
    expect(launch.args).toContain("--disable-slash-commands");
    expect(launch.args).toContain("stream-json");
    expect(launch.args.join(" ")).not.toContain("bypassPermissions");
    expect(launch.initialInput?.data).toContain("hello from stdin");
  });

  it("starts interactive Claude with host-global skills disabled", async () => {
    const launch = await new ClaudeCodeAdapter().buildLaunch({
      executable,
      cwd: process.cwd(),
      environment: {},
      mode: "interactive",
      workspaceAccess: "read-only"
    });

    expect(launch.args).toEqual(["--disable-slash-commands"]);
    expect(launch.initialInput).toBeUndefined();
  });

  it("starts the interactive OpenCode TUI without replaying another workspace", async () => {
    const launch = await new OpenCodeAdapter().buildLaunch({
      executable,
      cwd: process.cwd(),
      environment: {},
      mode: "interactive",
      workspaceAccess: "read-only"
    });

    expect(launch.args).toEqual(["--no-replay"]);
    expect(launch.initialInput).toBeUndefined();
  });

  it("rejects a non-interactive OpenCode launch it cannot support", async () => {
    await expect(new OpenCodeAdapter().buildLaunch(launchInput)).rejects.toThrow(
      "only supports interactive sessions"
    );
  });

  it("reports an actionable issue when the OpenCode binary is missing", async () => {
    const context: AdapterContext = {
      platform: platform(),
      environment: {},
      cwd: process.cwd(),
      detector: { find: async () => null },
      commandRunner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) }
    };
    const result = await new OpenCodeAdapter().detect(context);
    expect(result.available).toBe(false);
    expect(result.issue?.code).toBe("adapter_executable_not_found");
    expect(result.issue?.remediation).toContain("Install");
  });

  it("recognizes the interactive OpenCode prompt before accepting a handoff", () => {
    expect(
      new OpenCodeAdapter().isReadyForReviewedHandoff({ data: "[32m❯[0m ", sequence: 1 })
    ).toBe(true);
  });

  it("returns an actionable issue when an adapter is absent", async () => {
    const context: AdapterContext = {
      platform: platform(),
      environment: {},
      cwd: process.cwd(),
      detector: { find: async () => null },
      commandRunner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) }
    };
    const result = await new CodexAdapter().detect(context);
    expect(result.available).toBe(false);
    expect(result.issue?.code).toBe("adapter_executable_not_found");
    expect(result.issue?.remediation).toContain("Install");
  });

  it("finds the VS Code Claude binary when an invalid npm command shim is on PATH", async () => {
    const userProfile = await mkdtemp(join(tmpdir(), "ForgeDeck Claude profile "));
    temporaryDirectories.push(userProfile);
    const executablePath = join(
      userProfile,
      ".vscode",
      "extensions",
      "anthropic.claude-code-2.1.214-win32-x64",
      "resources",
      "native-binary",
      "claude.exe"
    );
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(executablePath, "native Claude placeholder");

    const result = await new ClaudeCodeAdapter().detect({
      platform: "win32",
      environment: {
        PATH: userProfile,
        PATHEXT: ".EXE;.CMD",
        USERPROFILE: userProfile
      },
      cwd: userProfile,
      detector: new PathExecutableDetector(),
      commandRunner: {
        run: async (input) =>
          input.executable.path === executablePath
            ? { exitCode: 0, stdout: "2.1.214 (Claude Code)\n", stderr: "", timedOut: false }
            : { exitCode: 1, stdout: "", stderr: "broken npm shim", timedOut: false }
      }
    });

    expect(result).toMatchObject({
      available: true,
      executable: { path: executablePath, kind: "native" },
      version: "2.1.214 (Claude Code)",
      issue: null
    });
  });

  it("submits a reviewed handoff to Claude Code in a separate confirmation action", async () => {
    const control = handoffControl("\u276f");

    const result = await new ClaudeCodeAdapter().submitReviewedHandoff(
      control,
      "review this change"
    );

    expect(result.confirmation).toBe("response_detected");
    expect(control.write).toHaveBeenNthCalledWith(1, "\u001b[200~review this change\u001b[201~");
    expect(control.write).toHaveBeenNthCalledWith(2, "\r");
    expect(control.reportPhase).toHaveBeenCalledWith("written_to_terminal");
    expect(control.reportPhase).toHaveBeenCalledWith("submitted_to_agent");
  });

  it("recognizes the interactive Claude Code prompt before accepting a handoff", () => {
    expect(
      new ClaudeCodeAdapter().isReadyForReviewedHandoff({
        data: "\u001b[32m\u276f\u001b[0m ",
        sequence: 1
      })
    ).toBe(true);
  });

  it("submits a reviewed handoff to Codex in a separate confirmation action", async () => {
    const control = handoffControl("\u203a");

    const result = await new CodexAdapter().submitReviewedHandoff(
      control,
      "implement the next task"
    );

    expect(result.confirmation).toBe("response_detected");
    expect(control.write).toHaveBeenNthCalledWith(
      1,
      "\u001b[200~implement the next task\u001b[201~"
    );
    expect(control.write).toHaveBeenNthCalledWith(2, "\r");
    expect(control.reportPhase).toHaveBeenCalledWith("written_to_terminal");
    expect(control.reportPhase).toHaveBeenCalledWith("submitted_to_agent");
  });

  it("does not submit a Codex handoff before the paste is acknowledged", async () => {
    const control: ReviewedHandoffSubmissionControl & { readonly write: ReturnType<typeof vi.fn> } =
      {
        write: vi.fn(async () => undefined),
        getOutputSnapshot: () => ({ data: "\u203a", sequence: 1 }),
        waitForOutputAfter: vi.fn(async () => null),
        reportPhase: vi.fn(async () => undefined)
      };

    await expect(
      new CodexAdapter().submitReviewedHandoff(control, "implement the next task")
    ).rejects.toThrow("did not acknowledge");
    expect(control.write).toHaveBeenCalledTimes(1);
  });

  it("recognizes the interactive Codex prompt before accepting a handoff", () => {
    expect(new CodexAdapter().isReadyForReviewedHandoff({ data: "\u203a ", sequence: 1 })).toBe(
      true
    );
  });

  it("recognizes the native Codex model and workspace prompt on Windows", () => {
    expect(
      new CodexAdapter().isReadyForReviewedHandoff({
        data: "\u001b[33mgpt-5.6-terra high · ~\\Documents\\Compasso\u001b[0m",
        sequence: 1
      })
    ).toBe(true);
  });
});

describe("command runner", () => {
  it.runIf(process.platform === "win32")(
    "executes a Windows command shim from a path containing spaces",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "ForgeDeck runner path with spaces "));
      temporaryDirectories.push(directory);
      const commandShim = join(directory, "version tool.cmd");
      await writeFile(commandShim, "@echo shim-version 1.0\r\n");

      const result = await new ExecFileCommandRunner().run({
        executable: { path: commandShim, kind: "command-shim" },
        args: [],
        cwd: directory,
        environment: { ...process.env } as Readonly<Record<string, string>>,
        timeoutMs: 5_000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("shim-version 1.0");
    }
  );
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

function handoffControl(prompt: string): ReviewedHandoffSubmissionControl & {
  readonly write: ReturnType<typeof vi.fn>;
  readonly reportPhase: ReturnType<typeof vi.fn>;
} {
  let snapshot = { data: prompt, sequence: 1 };
  let writes = 0;
  return {
    write: vi.fn(async () => {
      writes += 1;
      if (writes === 1) {
        snapshot = { data: `${snapshot.data}\ninput echoed`, sequence: snapshot.sequence + 1 };
      }
    }),
    getOutputSnapshot: () => snapshot,
    waitForOutputAfter: vi.fn(async (sequence: number) => {
      if (sequence >= snapshot.sequence) {
        snapshot = { data: `${snapshot.data}\nagent response`, sequence: sequence + 1 };
      }
      return snapshot;
    }),
    reportPhase: vi.fn(async () => undefined)
  };
}
