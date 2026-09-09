import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner, DetectedExecutable } from "@forgedeck/agent-sdk";
import { workflowNodeSchema } from "@forgedeck/workflow";

import { AgentAdapterUnavailableError } from "./agent-adapter-registry";
import { OPENCODE_ADAPTER_ID, OpenCodeAgentAdapter } from "./opencode-agent-adapter";
import type { AgentNodeLaunchInput } from "./process-agent-node-executor";

/**
 * The OpenCode adapter owns exactly one decision: how to launch the locally installed CLI safely.
 * These tests pin what makes a run trustworthy — the prompt never reaches argv, managed paths stay
 * inside the workspace, the permission bypass is never used, and credentials never leak.
 */

const SEP = process.platform === "win32" ? "\\" : "/";
const WORKSPACE = process.platform === "win32" ? "C:\\work\\project" : "/work/project";
const OUTPUT = `${WORKSPACE}${SEP}.forgedeck${SEP}out`;

function commandRunner(result: Partial<CommandResult> = {}): CommandRunner {
  return {
    run: async () => ({
      exitCode: 0,
      stdout: "1.17.7\n",
      stderr: "",
      timedOut: false,
      ...result
    })
  };
}

function makeAdapter(
  options: {
    readonly found?: DetectedExecutable | null;
    readonly runner?: CommandRunner;
    readonly environment?: Record<string, string | undefined>;
    readonly existing?: readonly string[];
    readonly model?: string;
  } = {}
) {
  const existing = options.existing ?? [];
  const found =
    "found" in options
      ? options.found
      : ({ path: "/usr/local/bin/opencode", kind: "native" } as const);
  return new OpenCodeAgentAdapter({
    detector: { find: async () => found },
    commandRunner: options.runner ?? commandRunner(),
    platform: "linux",
    environment: options.environment ?? { PATH: "/usr/local/bin" },
    fileExists: async (path) => existing.includes(path),
    ...(options.model === undefined ? {} : { config: { model: options.model } })
  });
}

function launchInput(overrides: Partial<AgentNodeLaunchInput> = {}): AgentNodeLaunchInput {
  return {
    node: workflowNodeSchema.parse({
      id: "backend",
      type: "agent",
      adapter: OPENCODE_ADAPTER_ID,
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
  it("is registered under the opencode id", () => {
    expect(makeAdapter().id).toBe("opencode");
  });

  it("reports available with the detected version when the CLI answers", async () => {
    const availability = await makeAdapter().detect();
    expect(availability.available).toBe(true);
    expect(availability.version).toBe("1.17.7");
    expect(availability.issue).toBeNull();
  });

  it("reports unavailable with actionable remediation when the CLI is absent", async () => {
    const availability = await makeAdapter({ found: null }).detect();
    expect(availability.available).toBe(false);
    expect(availability.version).toBeNull();
    expect(availability.issue?.code).toBe("adapter_executable_not_found");
    expect(availability.issue?.remediation).toContain("opencode-ai");
  });

  it("reports unavailable when the CLI is present but cannot report a version", async () => {
    const availability = await makeAdapter({
      runner: commandRunner({ exitCode: 1, stdout: "", stderr: "" })
    }).detect();
    expect(availability.available).toBe(false);
    expect(availability.issue?.code).toBe("adapter_detection_failed");
  });

  it("resolves the native binary the npm shim invokes", async () => {
    const native = join("/usr/local/bin", "node_modules", "opencode-ai", "bin", "opencode");
    const adapter = new OpenCodeAgentAdapter({
      detector: { find: async () => ({ path: "/usr/local/bin/opencode", kind: "command-shim" }) },
      commandRunner: commandRunner(),
      platform: "linux",
      environment: { PATH: "/usr/local/bin" },
      fileExists: async (path) => path === native
    });
    const plan = await adapter.planLaunch(launchInput());
    expect(plan.executable).toEqual({ path: native, kind: "native" });
  });

  it("refuses a command shim whose native binary cannot be resolved", async () => {
    const adapter = new OpenCodeAgentAdapter({
      detector: { find: async () => ({ path: "/usr/local/bin/opencode", kind: "command-shim" }) },
      commandRunner: commandRunner(),
      platform: "linux",
      environment: {},
      fileExists: async () => false
    });
    // No shell fallback, no assembled command string: the node fails before any process starts.
    await expect(adapter.planLaunch(launchInput())).rejects.toThrow(AgentAdapterUnavailableError);
  });
});

describe("launch plan", () => {
  it("runs the official non-interactive subcommand over the pipe transport", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.args[0]).toBe("run");
    expect(plan.transport).toBe("pipe");
  });

  it("never places the prompt on the command line, and passes no positional message", async () => {
    const task = 'Fix the ünicode\nbug; rm -rf / && echo "pwned" $(whoami) `id`';
    const plan = await makeAdapter().planLaunch(launchInput({ task }));
    expect(plan.args.some((argument) => argument.includes("ünicode"))).toBe(false);
    expect(plan.args.some((argument) => argument.includes("rm -rf"))).toBe(false);
    // Every argument is a flag or a flag's value; a positional would become the message instead.
    const positional = plan.args
      .slice(1)
      .filter(
        (entry, index, all) => !entry.startsWith("-") && !(all[index - 1] ?? "").startsWith("-")
      );
    expect(positional).toEqual([]);
    expect(plan.stdin).toContain(task);
  });

  it("preserves Unicode and newlines exactly on stdin", async () => {
    const task = "Primeira linha\nSegunda linha — ação 日本語 🎯\n\tTabulado";
    const plan = await makeAdapter().planLaunch(launchInput({ task }));
    expect(plan.stdin).toContain(task);
  });

  it("names the managed staging path as the result destination", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.environment?.["COMPAZIO_RESULT_PATH"]).toBe(OUTPUT);
    expect(plan.stdin).toContain(OUTPUT);
    expect(plan.producesArtifact).toBe(true);
    expect(plan.artifactFilename).toBe("result.txt");
  });

  it("passes the approved workspace as the working directory", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.args[plan.args.indexOf("--dir") + 1]).toBe(WORKSPACE);
  });

  it("never uses OpenCode's dangerous permission bypass", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.args).not.toContain("--dangerously-skip-permissions");
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

  it("clamps the timeout to a safe range", async () => {
    const build = async (timeoutMs: number) =>
      (
        await new OpenCodeAgentAdapter({
          detector: { find: async () => ({ path: "/usr/local/bin/opencode", kind: "native" }) },
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

describe("provider and model", () => {
  it("passes no model at all when none is configured, deferring to the user's own default", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.args).not.toContain("-m");
  });

  it("passes a validated provider/model reference as a plain argument", async () => {
    const plan = await makeAdapter({ model: "opencode/big-pickle" }).planLaunch(launchInput());
    expect(plan.args[plan.args.indexOf("-m") + 1]).toBe("opencode/big-pickle");
  });

  it("refuses a model reference that is not a provider/model pair", async () => {
    for (const invalid of ["big-pickle", "a/b/c", "--flag", "opencode/", "; rm -rf /"]) {
      await expect(makeAdapter({ model: invalid }).planLaunch(launchInput())).rejects.toThrow(
        /not a valid provider\/model/
      );
    }
  });
});

describe("context handed to the agent", () => {
  it("carries the objective, role, attempt and acceptance criteria", async () => {
    const plan = await makeAdapter().planLaunch(
      launchInput({
        attempt: 3,
        node: workflowNodeSchema.parse({
          id: "backend",
          type: "agent",
          adapter: OPENCODE_ADAPTER_ID,
          permissions: {},
          output: { acceptanceCriteria: ["The endpoint returns 200", "Tests pass"] }
        })
      })
    );
    expect(plan.stdin).toContain("Role: implementer");
    expect(plan.stdin).toContain("Attempt: 3");
    expect(plan.stdin).toContain("The endpoint returns 200");
  });

  it("describes upstream work by artifact path and hash, never by content", async () => {
    const path = `${WORKSPACE}${SEP}planner.json`;
    const plan = await makeAdapter().planLaunch(
      launchInput({
        inputs: [
          {
            nodeId: "planner",
            artifactId: "artifact-1",
            path,
            sha256: "c".repeat(64),
            mediaType: "application/json"
          }
        ]
      })
    );
    expect(plan.stdin).toContain(path);
    expect(plan.stdin).toContain("c".repeat(64));
    expect(plan.stdin).not.toMatch(/transcript|conversation history/i);
  });
});

describe("credentials", () => {
  it("forwards only path-valued config variables, never inline credential content", async () => {
    const plan = await makeAdapter().planLaunch(launchInput());
    expect(plan.additionalAllowedEnvKeys).toEqual([
      "COMPAZIO_RESULT_PATH",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR"
    ]);
    // These two carry inline credentials/config and must never be forwarded.
    expect(plan.additionalAllowedEnvKeys).not.toContain("OPENCODE_AUTH_CONTENT");
    expect(plan.additionalAllowedEnvKeys).not.toContain("OPENCODE_CONFIG_CONTENT");
  });

  it("redacts local secret values from diagnostic text", () => {
    const adapter = makeAdapter({
      environment: { OPENCODE_AUTH_CONTENT: "sk-secretvalue123", PATH: "/usr/local/bin" }
    });
    const sanitized = adapter.sanitize("failed with sk-secretvalue123");
    expect(sanitized).not.toContain("sk-secretvalue123");
    expect(sanitized).toContain("[redacted]");
  });

  it("never leaks a secret through an unavailability message", async () => {
    const availability = await makeAdapter({
      found: null,
      environment: { OPENCODE_AUTH_CONTENT: "supersecrettoken", PATH: "/usr/local/bin" }
    }).detect();
    expect(JSON.stringify(availability)).not.toContain("supersecrettoken");
  });

  it("never reports authentication, because no safe unpaid local check exists", async () => {
    const availability = await makeAdapter().detect();
    expect(Object.keys(availability)).toEqual(["id", "available", "version", "issue"]);
  });
});
