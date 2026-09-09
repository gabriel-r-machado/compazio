import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner, DetectedExecutable } from "@forgedeck/agent-sdk";
import { workflowNodeSchema } from "@forgedeck/workflow";

import { AgentAdapterUnavailableError } from "./agent-adapter-registry";
import { CODEX_ADAPTER_ID, CodexAgentAdapter } from "./codex-agent-adapter";
import type { AgentNodeLaunchInput } from "./process-agent-node-executor";

/**
 * The Codex adapter owns exactly one decision: how to launch the locally installed CLI safely. These
 * tests pin the parts that decide whether a run is trustworthy — the prompt never reaches argv, the
 * cwd is validated, credentials never leak, and nothing that merely looks successful is accepted.
 */

const WORKSPACE = process.platform === "win32" ? "C:\\work\\project" : "/work/project";
const OUTPUT = `${WORKSPACE}${process.platform === "win32" ? "\\" : "/"}.forgedeck${
  process.platform === "win32" ? "\\" : "/"
}out`;

function commandRunner(result: Partial<CommandResult> = {}): CommandRunner & {
  readonly calls: { executable: DetectedExecutable; args: readonly string[] }[];
} {
  const calls: { executable: DetectedExecutable; args: readonly string[] }[] = [];
  return {
    calls,
    run: async (input) => {
      calls.push({ executable: input.executable, args: input.args });
      return {
        exitCode: 0,
        stdout: "codex-cli 0.144.6\n",
        stderr: "",
        timedOut: false,
        ...result
      };
    }
  };
}

function makeAdapter(
  options: {
    readonly found?: DetectedExecutable | null;
    readonly runner?: CommandRunner;
    readonly environment?: Record<string, string | undefined>;
    readonly executablePath?: string;
    readonly existing?: readonly string[];
  } = {}
) {
  const existing = options.existing ?? [];
  // `found` distinguishes "not provided" from an explicit null, so the missing-CLI case is real.
  const found =
    "found" in options
      ? options.found
      : ({ path: "/usr/local/bin/codex", kind: "native" } as const);
  return new CodexAgentAdapter({
    detector: { find: async () => found },
    commandRunner: options.runner ?? commandRunner(),
    platform: "linux",
    environment: options.environment ?? { PATH: "/usr/local/bin" },
    fileExists: async (path) => existing.includes(path),
    ...(options.executablePath === undefined
      ? {}
      : { config: { executablePath: options.executablePath } })
  });
}

function launchInput(overrides: Partial<AgentNodeLaunchInput> = {}): AgentNodeLaunchInput {
  return {
    node: workflowNodeSchema.parse({
      id: "backend",
      type: "agent",
      adapter: CODEX_ADAPTER_ID,
      permissions: {}
    }),
    role: "implementer",
    task: "Implement the endpoint",
    cwd: WORKSPACE,
    runId: "run-1",
    attempt: 1,
    statePath: `${OUTPUT}.state`,
    outputPath: OUTPUT,
    inputs: [],
    ...overrides
  };
}

describe("identity and detection", () => {
  it("is registered under the codex id", () => {
    expect(makeAdapter().id).toBe("codex");
  });

  it("reports available with the detected version when the CLI answers", async () => {
    const availability = await makeAdapter().detect();
    expect(availability.available).toBe(true);
    expect(availability.version).toBe("codex-cli 0.144.6");
    expect(availability.issue).toBeNull();
  });

  it("reports unavailable with actionable remediation when the CLI is absent", async () => {
    const availability = await makeAdapter({ found: null }).detect();
    expect(availability.available).toBe(false);
    expect(availability.version).toBeNull();
    expect(availability.issue?.code).toBe("adapter_executable_not_found");
    expect(availability.issue?.remediation).toContain("@openai/codex");
  });

  it("reports unavailable when the CLI is present but cannot report a version", async () => {
    const availability = await makeAdapter({
      runner: commandRunner({ exitCode: 1, stdout: "", stderr: "" })
    }).detect();
    expect(availability.available).toBe(false);
    expect(availability.issue?.code).toBe("adapter_detection_failed");
  });

  it("never determines authentication, and never reads a credential file", async () => {
    // Codex has no safe unpaid local auth check, so the adapter reports availability only.
    const availability = await makeAdapter().detect();
    expect(Object.keys(availability)).toEqual(["id", "available", "version", "issue"]);
  });

  it("resolves the vendored native binary instead of the npm launcher shim", async () => {
    const vendored = join(
      "/usr/local/bin",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-linux-x64",
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
      "codex"
    );
    const adapter = new CodexAgentAdapter({
      detector: { find: async () => ({ path: "/usr/local/bin/codex", kind: "command-shim" }) },
      commandRunner: commandRunner(),
      platform: "linux",
      environment: { PATH: "/usr/local/bin" },
      config: { architecture: "x64" },
      fileExists: async (path) => path === vendored
    });
    const plan = await adapter.planLaunch(launchInput());
    expect(plan.executable).toEqual({ path: vendored, kind: "native" });
  });

  it("refuses a command shim whose native binary cannot be resolved", async () => {
    const adapter = new CodexAgentAdapter({
      detector: { find: async () => ({ path: "/usr/local/bin/codex", kind: "command-shim" }) },
      commandRunner: commandRunner(),
      platform: "linux",
      environment: {},
      config: { architecture: "x64" },
      fileExists: async () => false
    });
    await expect(adapter.planLaunch(launchInput())).rejects.toThrow(AgentAdapterUnavailableError);
  });
});

describe("launch plan", () => {
  it("runs the official non-interactive subcommand over the pipe transport", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.args[0]).toBe("exec");
    expect(plan.transport).toBe("pipe");
  });

  it("never places the prompt on the command line", async () => {
    const task = 'Fix the ünicode\nbug; rm -rf / && echo "pwned" $(whoami) `id`';
    const plan = await makeAdapter().planLaunch(launchInput({ task }));
    // Every argument is a flag or a managed path; no fragment of the prompt is present.
    expect(plan.args.some((argument) => argument.includes("ünicode"))).toBe(false);
    expect(plan.args.some((argument) => argument.includes("rm -rf"))).toBe(false);
    expect(plan.stdin).toContain(task);
  });

  it("preserves Unicode and newlines exactly on stdin", async () => {
    const task = "Primeira linha\nSegunda linha — ação 日本語 🎯\n\tTabulado";
    const plan = await makeAdapter().planLaunch(launchInput({ task }));
    expect(plan.stdin).toContain(task);
  });

  it("points the result at the managed staging path so stdout is never the result", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    const index = plan.args.indexOf("--output-last-message");
    expect(index).toBeGreaterThan(-1);
    expect(plan.args[index + 1]).toBe(OUTPUT);
    expect(plan.producesArtifact).toBe(true);
    expect(plan.artifactFilename).toBe("result.txt");
  });

  it("passes the approved workspace as the working root", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.args[plan.args.indexOf("--cd") + 1]).toBe(WORKSPACE);
  });

  it("rejects a managed path that escapes the approved workspace", async () => {
    const escaping = process.platform === "win32" ? "C:\\elsewhere\\out" : "/elsewhere/out";
    await expect(makeAdapter().planLaunch(launchInput({ outputPath: escaping }))).rejects.toThrow(
      /outside the approved workspace/
    );
  });

  it("rejects an upstream artifact that lies outside the approved workspace", async () => {
    const escaping = process.platform === "win32" ? "C:\\elsewhere\\a.json" : "/elsewhere/a.json";
    await expect(
      makeAdapter().planLaunch(
        launchInput({
          inputs: [
            {
              nodeId: "planner",
              artifactId: "a",
              path: escaping,
              sha256: "a".repeat(64),
              mediaType: "application/json"
            }
          ]
        })
      )
    ).rejects.toThrow(/outside the approved workspace/);
  });

  it("rejects an empty objective before any process is started", async () => {
    await expect(makeAdapter().planLaunch(launchInput({ task: "   " }))).rejects.toThrow(
      /objective is empty/
    );
  });

  it("chooses the sandbox from the node's own declared permissions", async () => {
    const readOnly = await makeAdapter().planLaunch(launchInput());
    expect(readOnly.args[readOnly.args.indexOf("--sandbox") + 1]).toBe("read-only");

    const writable = await makeAdapter().planLaunch(
      launchInput({
        node: workflowNodeSchema.parse({
          id: "backend",
          type: "agent",
          adapter: CODEX_ADAPTER_ID,
          permissions: { workspace_write: true }
        })
      })
    );
    expect(writable.args[writable.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    // The dangerous bypass modes are unreachable from the adapter by construction.
    expect(writable.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("clamps the timeout to a safe range", async () => {
    const build = async (timeoutMs: number) =>
      (
        await new CodexAgentAdapter({
          detector: { find: async () => ({ path: "/usr/local/bin/codex", kind: "native" }) },
          commandRunner: commandRunner(),
          platform: "linux",
          environment: {},
          config: { timeoutMs },
          fileExists: async () => false
        }).planLaunch(launchInput())
      ).timeoutMs;
    expect(await build(1)).toBe(1_000);
    expect(await build(999_999_999)).toBe(3_600_000);
    expect(await build(60_000)).toBe(60_000);
  });
});

describe("context handed to the agent", () => {
  it("carries the objective, role, attempt and acceptance criteria", async () => {
    const plan = await makeAdapter().planLaunch(
      launchInput({
        attempt: 2,
        node: workflowNodeSchema.parse({
          id: "backend",
          type: "agent",
          adapter: CODEX_ADAPTER_ID,
          permissions: {},
          output: { acceptanceCriteria: ["The endpoint returns 200", "Tests pass"] }
        })
      })
    );
    expect(plan.stdin).toContain("Role: implementer");
    expect(plan.stdin).toContain("Attempt: 2");
    expect(plan.stdin).toContain("The endpoint returns 200");
  });

  it("describes upstream work by artifact path and hash, never by content", async () => {
    const path = `${WORKSPACE}${process.platform === "win32" ? "\\" : "/"}planner.json`;
    const plan = await makeAdapter().planLaunch(
      launchInput({
        inputs: [
          {
            nodeId: "planner",
            artifactId: "artifact-1",
            path,
            sha256: "b".repeat(64),
            mediaType: "application/json"
          }
        ]
      })
    );
    expect(plan.stdin).toContain(path);
    expect(plan.stdin).toContain("b".repeat(64));
    // The handoff travels through Compazio's own artifacts, not a transcript of the other agent.
    expect(plan.stdin).not.toMatch(/transcript|conversation history/i);
  });
});

describe("credentials", () => {
  it("passes through only Codex's own profile directory, by value", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.additionalAllowedEnvKeys).toEqual(["CODEX_HOME"]);
    // No API key is requested, injected or forwarded by the adapter.
    expect(JSON.stringify(plan.environment ?? {})).not.toMatch(/api[_-]?key|token/i);
  });

  it("redacts local secret values from diagnostic text", () => {
    const adapter = makeAdapter({
      environment: { OPENAI_API_KEY: "sk-abcdef123456", PATH: "/usr/local/bin" }
    });
    const sanitized = adapter.sanitize("failed with sk-abcdef123456 and Bearer abcdef123456");
    expect(sanitized).not.toContain("sk-abcdef123456");
    expect(sanitized).toContain("[redacted]");
  });

  it("never leaks a secret through an unavailability message", async () => {
    const availability = await makeAdapter({
      found: null,
      environment: { CODEX_AUTH_TOKEN: "supersecrettoken", PATH: "/usr/local/bin" }
    }).detect();
    expect(JSON.stringify(availability)).not.toContain("supersecrettoken");
  });
});
